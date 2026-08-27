import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { McpContractError, OBSERVATION_SOURCE, type AssignmentState } from "./contracts";

export type HerdrCommandResult = { data: unknown; stdout: string };
const MAX_OUTPUT_BYTES = 1024 * 1024;
const REQUIRED_CAPABILITIES = ["agent.prompt", "agent.wait", "agent.start", "pane.wait_for_output", "pane.report_metadata"] as const;

function bounded(value: string): string { return value.length <= 500 ? value : `${value.slice(0, 497)}...`; }
function valuesForKey(value: unknown, key: string, out: unknown[] = []): unknown[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) { for (const item of value) valuesForKey(item, key, out); return out; }
  for (const [candidate, child] of Object.entries(value as Record<string, unknown>)) {
    if (candidate === key) out.push(child);
    valuesForKey(child, key, out);
  }
  return out;
}

export class HerdrAdapter {
  private constructor(readonly binary: string) {}

  static async create(configuredBinary?: string): Promise<HerdrAdapter> {
    const candidates = [process.env.HERDR_BIN_PATH, configuredBinary, "herdr"].filter((v): v is string => !!v);
    let selected: string | undefined;
    for (const candidate of candidates) {
      if (candidate === "herdr") { selected = candidate; break; }
      try {
        const canonical = await realpath(candidate);
        await access(canonical, constants.X_OK);
        selected = canonical;
        break;
      } catch { /* try the next bounded source */ }
    }
    if (!selected) throw new McpContractError("herdr_not_found", "No executable Herdr binary was found.", "attest", "Set HERDR_BIN_PATH or the verified configured binary.");
    const adapter = new HerdrAdapter(selected);
    await adapter.verifySchema();
    return adapter;
  }

  private async execute(args: readonly string[], timeoutMs: number, mutating: boolean): Promise<HerdrCommandResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const proc = Bun.spawn([this.binary, ...args], { stdout: "pipe", stderr: "pipe", signal: controller.signal, env: process.env });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (stdout.length > MAX_OUTPUT_BYTES || stderr.length > MAX_OUTPUT_BYTES) throw new McpContractError("herdr_output_too_large", "Herdr returned output beyond the bounded adapter limit.", mutating ? "prompt" : "wait", "Inspect Herdr directly; do not retry a mutation.", mutating, !mutating);
      if (exitCode !== 0) {
        let code = "herdr_command_failed";
        try { const parsed = JSON.parse(stdout) as Record<string, unknown>; if (typeof parsed.code === "string") code = parsed.code; } catch { /* normalized below */ }
        throw new McpContractError(code, bounded(stderr || stdout || `Herdr exited ${exitCode}.`), mutating ? "prompt" : "wait", mutating ? "Inspect the exact target and registry journal before any replay." : "Retry the read-only observation.", false, !mutating);
      }
      let data: unknown;
      try { data = JSON.parse(stdout); } catch { throw new McpContractError("invalid_herdr_response", "Herdr stdout was not JSON.", mutating ? "prompt" : "wait", "Verify the installed Herdr 0.8.2 schema and binary selection.", mutating, false); }
      return { data, stdout };
    } catch (error: unknown) {
      if (controller.signal.aborted) throw new McpContractError(mutating ? "herdr_mutation_timeout" : "wait_timeout", `Herdr ${mutating ? "mutation" : "observation"} timed out.`, mutating ? "prompt" : "wait", mutating ? "Treat the effect as ambiguous and inspect before replay." : "The observation had no effect and may be retried.", mutating, !mutating);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async verifySchema(): Promise<void> {
    let result: HerdrCommandResult;
    try { result = await this.execute(["api", "schema", "--json"], 10_000, false); }
    catch (error) { throw new McpContractError("herdr_schema_incompatible", `Unable to read Herdr API schema: ${error instanceof Error ? error.message : String(error)}`, "attest", "Install Herdr 0.8.2 with protocol 20 and schema version 1."); }
    const protocol = valuesForKey(result.data, "protocol").find((v) => typeof v === "number");
    const version = valuesForKey(result.data, "schema_version").find((v) => typeof v === "number");
    const serialized = JSON.stringify(result.data);
    const missing = REQUIRED_CAPABILITIES.filter((capability) => !serialized.includes(capability));
    if (protocol !== 20 || version !== 1 || missing.length) throw new McpContractError("herdr_schema_incompatible", `Herdr schema mismatch${missing.length ? `; missing ${missing.join(", ")}` : ""}.`, "attest", "Install the supported Herdr 0.8.2 capability set.");
  }

  getAgent(target: string, timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["agent", "get", target], timeoutMs, false); }
  listAgents(timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["agent", "list"], timeoutMs, false); }
  prompt(target: string, text: string, until: string[], timeoutMs: number): Promise<HerdrCommandResult> {
    const args = ["agent", "prompt", target, text, "--wait", ...until.flatMap((state) => ["--until", state]), "--timeout", String(timeoutMs)];
    return this.execute(args, timeoutMs + 1_000, true);
  }
  wait(target: string, until: string[], timeoutMs: number): Promise<HerdrCommandResult> {
    return this.execute(["agent", "wait", target, ...until.flatMap((state) => ["--until", state]), "--timeout", String(timeoutMs)], timeoutMs + 1_000, false);
  }
  startAgent(name: string, paneId: string, args: readonly string[], timeoutMs: number): Promise<HerdrCommandResult> {
    return this.execute(["agent", "start", name, "--kind", "omp", "--pane", paneId, "--", ...args], timeoutMs, true);
  }
  sendText(paneId: string, text: string, timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["pane", "send-text", paneId, text], timeoutMs, true); }
  sendKeys(paneId: string, keys: readonly string[], timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["pane", "send-keys", paneId, ...keys], timeoutMs, true); }
  closeTab(tabId: string, timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["tab", "close", tabId], timeoutMs, true); }
  getPane(paneId: string, timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["pane", "get", paneId], timeoutMs, false); }
  reportObservation(paneId: string, responsibility: string, assignment: string, state: AssignmentState, sequence: number, timeoutMs: number): Promise<HerdrCommandResult> {
    const title = `${responsibility} · ${assignment}`.slice(0, 80);
    const visibleState = state === "completed" || state === "failed" || state === "blocked" || state === "queued" ? state : "working";
    return this.execute(["pane", "report-metadata", paneId, "--source", OBSERVATION_SOURCE, "--title", title, "--seq", String(sequence), "--token", `responsibility=${responsibility}`, "--token", `assignment=${assignment}`, "--token", `assignment-state=${visibleState}`], timeoutMs, true);
  }
}
