// Command-line entry for opening a track from a plain Herdr shell pane, where no
// OMP session exists to carry the MCP server. `bin/herdr-delegator-mcp` forwards
// here only when its first argument names a subcommand; with no arguments it
// still starts the MCP server. Both subcommands reuse the server's own code:
// `check` is the `checkMandate` that `herdr_track check` runs, and `open` is
// `CompositeTools.track` with the same validated input `herdr_track open` takes.
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { COORDINATE_RE, herdrTrackSchema, McpContractError, type McpResult } from "./contracts";
import { HerdrAdapter } from "./herdr-adapter";
import { checkMandate } from "./mandate-gate";
import { mountedBuild } from "./registry";
import { CompositeTools } from "./tools";

const USAGE = [
  "usage: herdr-delegator-mcp check --mandate <file.json> [--cwd <project-dir>]",
  "       herdr-delegator-mcp open --mandate <file.json> --track <track_id> [--cwd <project-dir>] [--run <run_id>]",
  "       herdr-delegator-mcp            (no arguments: start the MCP stdio server)",
].join("\n");

const OPTIONS = {
  check: ["mandate", "cwd"],
  open: ["mandate", "cwd", "track", "run"],
} as const;

type Subcommand = keyof typeof OPTIONS;

/** A refusal of the invocation itself: one stderr line, exit 2, nothing done. */
class UsageError extends Error {}

function parseOptions(subcommand: Subcommand, args: readonly string[]): Map<string, string> {
  const allowed: readonly string[] = OPTIONS[subcommand];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--") || arg === "--") throw new UsageError(`unexpected argument ${JSON.stringify(arg)}; ${subcommand} takes long options only`);
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    if (!allowed.includes(name)) throw new UsageError(`unknown option --${name} for ${subcommand}`);
    if (options.has(name)) throw new UsageError(`option --${name} given more than once`);
    let value: string | undefined;
    if (equals !== -1) value = arg.slice(equals + 1);
    else {
      value = args[index + 1];
      index += 1;
    }
    if (value === undefined || value === "" || (equals === -1 && value.startsWith("--"))) throw new UsageError(`option --${name} needs a value`);
    options.set(name, value);
  }
  return options;
}

function coordinateOption(options: Map<string, string>, name: string, fallback?: string): string {
  const value = options.get(name) ?? fallback;
  if (value === undefined) throw new UsageError(`missing required option --${name}`);
  if (!COORDINATE_RE.test(value)) throw new UsageError(`--${name} must match ${COORDINATE_RE.source}`);
  return value;
}

/** Same gate `startOrchestrator` applies: the caller is a Herdr-managed pane. */
function requireHerdrPane(): void {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    throw new UsageError("not inside a Herdr pane: HERDR_ENV=1 and HERDR_PANE_ID are required; run this from a shell pane inside Herdr");
  }
}

async function canonicalCwd(value: string | undefined): Promise<string> {
  const requested = path.resolve(value ?? process.cwd());
  try { return await realpath(requested); }
  catch { throw new UsageError(`--cwd ${JSON.stringify(requested)} does not resolve to an existing directory`); }
}

/**
 * Reads and parses the mandate. Neither refusal quotes the file: a JSON parse
 * message carries a fragment of its input, and the mandate is never echoed.
 */
async function readMandate(value: string | undefined): Promise<unknown> {
  if (value === undefined) throw new UsageError("missing required option --mandate");
  const file = path.resolve(value);
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { throw new UsageError(`cannot read mandate file ${JSON.stringify(file)}`); }
  try { return JSON.parse(text); }
  catch { throw new UsageError(`mandate file ${JSON.stringify(file)} is not valid JSON`); }
}

/** A failure outside `CompositeTools.track`, shaped as the McpResult the server returns. */
function openFailure(run: McpResult["run"], code: string, phase: NonNullable<McpResult["error"]>["phase"], message: string, recovery: string, retryable: boolean): McpResult {
  return { ok: false, tool: "herdr_track", action: "open", run, effect: "none", retryable, error: { code, phase, message, recovery, ambiguous_effect: false }, data: { build: mountedBuild() } };
}

async function check(args: readonly string[]): Promise<number> {
  const options = parseOptions("check", args);
  requireHerdrPane();
  const cwd = await canonicalCwd(options.get("cwd"));
  const mandate = await readMandate(options.get("mandate"));
  const result = await checkMandate(mandate, { cwd });
  for (const line of result.lines) process.stdout.write(`${line.ok ? "ok  " : "FAIL"} ${line.rule}: ${line.detail}\n`);
  process.stdout.write(`verdict: ${result.verdict}\n`);
  return result.verdict === "PASSED" ? 0 : 1;
}

async function open(args: readonly string[]): Promise<number> {
  const options = parseOptions("open", args);
  const run = { track_id: coordinateOption(options, "track"), run_id: coordinateOption(options, "run", "r1") };
  requireHerdrPane();
  const cwd = await canonicalCwd(options.get("cwd"));
  const mandate = await readMandate(options.get("mandate"));
  let result: McpResult;
  const parsed = herdrTrackSchema.safeParse({ action: "open", ...run, cwd, mandate });
  if (!parsed.success) {
    // Paths and issue codes only, as the server reports them: never a value.
    const issues = [...new Set(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} (${issue.code})`))].slice(0, 8);
    result = openFailure(run, "invalid_tool_input", "validate", `The mandate does not match the herdr_track open input at ${issues.join("; ")}.`, "Run `herdr-delegator-mcp check` on the same file and correct it until the verdict is PASSED; nothing was laid out.", false);
  } else {
    try {
      const adapter = await HerdrAdapter.create(process.env.HERDR_CONFIGURED_BIN_PATH);
      result = await new CompositeTools(adapter).track(parsed.data);
    } catch (error: unknown) {
      result = error instanceof McpContractError
        ? openFailure(run, error.code, error.phase, error.message, error.recovery, error.retryable)
        : openFailure(run, "internal_error", "validate", error instanceof Error ? error.message : String(error), "Inspect stderr; nothing was opened before the Herdr adapter was ready.", false);
    }
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (result.ok) {
    process.stdout.write(text);
    return 0;
  }
  process.stderr.write(text);
  return 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "check" && subcommand !== "open") throw new UsageError(`unknown subcommand ${JSON.stringify(subcommand ?? "")}; expected check or open`);
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  return subcommand === "check" ? check(rest) : open(rest);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error: unknown) {
  if (error instanceof UsageError) {
    process.stderr.write(`herdr-delegator-mcp: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`herdr-delegator-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
