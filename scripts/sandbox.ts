// A reproducible dogfooding sandbox: one command each to create, inspect and destroy
// an isolated environment whose base commit is known.
//
//   bun scripts/sandbox.ts create <name> [--base <ref>]   # default base: main
//   bun scripts/sandbox.ts status  <name>
//   bun scripts/sandbox.ts destroy <name> [--yes]         # without --yes: plan only, exit 2
//
// A sandbox is three things that must agree:
//   1. a git worktree  <parent-of-main-worktree>/herdr-delegator-sb-<name> on branch sb/<name>,
//      created at a chosen base ref so the dogfooded code is a known commit;
//   2. project-level OMP isolation, so an OMP session opened with that worktree as cwd loads
//      this plugin FROM the worktree instead of the user-scoped install:
//        <wt>/.omp/config.yml            extensions: [<wt>]  — load the worktree explicitly
//        <wt>/.omp/plugin-overrides.json {"disabled":["herdr-delegator"]} — drop the user one
//      Both files are cwd-keyed, so Herdr-spawned ORCH and worker sessions in the worktree
//      pick them up with no CLI flags and no profile.
//   3. a separate storage root ~/.local/share/herdr-delegator-sb-<name>/runs, so runs
//      opened there never land in the shared root.
// `status` verifies (2) from live observation rather than assuming it, and exits 1 when the
// user-scoped plugin is not disabled for that cwd or the worktree is not in the extension set.
//
// The sandbox is the only place where opening a track is allowed; a test open from outside
// one already leaked an orphan ORCH pane into the user's Herdr.
//
// Why not `omp plugin link`: measured on omp 18.2.8 (2026-09-22), `omp plugin link
// --scope=project <path>` prints nothing, exits 0, writes nothing into the project, and
// repoints the USER-scoped symlink ~/.omp/plugins/node_modules/herdr-delegator at <path> —
// a global change, not a project-scoped one. This script therefore never links, installs,
// uninstalls, enables or disables anything through the plugin CLI.
//
// Boundaries this script enforces mechanically: it leaves the user plugin scope
// (~/.omp/plugins) exactly as it found it, never touches the main worktree or any worktree it
// did not create, and never deletes anything outside ~/.local/share/herdr-delegator-sb-<name>.
// It never calls the MCP server, never opens a track, and never births a pane — creating panes
// stays a human action, and so does closing them.
//
// Every external command is echoed before it runs; a failing command stops the run and
// prints that command's stderr.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PLUGIN_NAME = "herdr-delegator";
const SANDBOX_PREFIX = "herdr-delegator-sb-";
const USER_PLUGIN_ROOT = path.join(os.homedir(), ".omp", "plugins");
const SHARED_STORAGE_HOME = path.join(os.homedir(), ".local", "share", "herdr-delegator");

function fail(message: string): never {
  console.error(`sandbox: ${message}`);
  process.exit(1);
}

type RunResult = { stdout: string; stderr: string; status: number };

/** Echo a command, run it, and return its captured output. Non-zero status stops the run. */
function run(command: string, args: string[], options: { cwd: string; allowFailure?: boolean }): RunResult {
  console.log(`$ (cd ${options.cwd} && ${[command, ...args].join(" ")})`);
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
  if (result.error) {
    if (options.allowFailure) return { stdout: "", stderr: String(result.error.message), status: 127 };
    fail(`cannot run ${command}: ${result.error.message}`);
  }
  const out = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 0 };
  if (out.status !== 0 && !options.allowFailure) {
    if (out.stdout.trim()) console.log(out.stdout.trimEnd());
    console.error(out.stderr.trimEnd() || `(no stderr; exit ${out.status})`);
    fail(`${command} ${args.join(" ")} exited ${out.status}`);
  }
  return out;
}

/** The main worktree is the first entry of `git worktree list --porcelain`. */
function mainWorktree(cwd: string): string {
  const listed = run("git", ["worktree", "list", "--porcelain"], { cwd }).stdout;
  const first = listed.split("\n").find((line) => line.startsWith("worktree "));
  if (!first) fail("git worktree list returned no main worktree");
  return path.resolve(first.slice("worktree ".length).trim());
}

function repoRoot(): string {
  const cwd = process.cwd();
  const top = run("git", ["rev-parse", "--show-toplevel"], { cwd }).stdout.trim();
  if (!top) fail("not inside a git worktree");
  return path.resolve(top);
}

type Sandbox = {
  name: string;
  repo: string;
  main: string;
  worktree: string;
  branch: string;
  storageHome: string;
  storageRoot: string;
  configPath: string;
  ompConfigPath: string;
  overridesPath: string;
};

function resolveSandbox(name: string): Sandbox {
  if (!NAME_RE.test(name)) fail(`invalid sandbox name ${JSON.stringify(name)}; expected ${NAME_RE.source}`);
  const repo = repoRoot();
  const main = mainWorktree(repo);
  const worktree = path.join(path.dirname(main), `${SANDBOX_PREFIX}${name}`);
  const storageHome = path.join(os.homedir(), ".local", "share", `${SANDBOX_PREFIX}${name}`);
  return {
    name,
    repo,
    main,
    worktree,
    branch: `sb/${name}`,
    storageHome,
    storageRoot: path.join(storageHome, "runs"),
    configPath: path.join(worktree, ".omp", `${PLUGIN_NAME}.json`),
    ompConfigPath: path.join(worktree, ".omp", "config.yml"),
    overridesPath: path.join(worktree, ".omp", "plugin-overrides.json"),
  };
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Refuse to delete anything that is not this sandbox's own worktree / storage home. */
function assertDestroyable(sb: Sandbox): void {
  const wtName = path.basename(sb.worktree);
  if (wtName !== `${SANDBOX_PREFIX}${sb.name}`) fail(`refusing to remove ${sb.worktree}: not a sandbox worktree name`);
  if (sb.worktree === sb.main || sb.worktree === sb.repo) fail(`refusing to remove ${sb.worktree}: that is a live worktree`);
  if (path.basename(sb.storageHome) !== `${SANDBOX_PREFIX}${sb.name}`) fail(`refusing to remove ${sb.storageHome}`);
  if (isInside(SHARED_STORAGE_HOME, sb.storageHome)) fail(`refusing to touch the shared storage root ${SHARED_STORAGE_HOME}`);
  if (isInside(USER_PLUGIN_ROOT, sb.worktree) || isInside(USER_PLUGIN_ROOT, sb.storageHome)) {
    fail(`refusing to touch the user plugin scope ${USER_PLUGIN_ROOT}`);
  }
}

type PluginEntry = { name: string; path: string };

/** `omp plugin list --json` groups entries by source; collect every {name, path} it reports. */
function pluginEntries(cwd: string): PluginEntry[] {
  const raw = run("omp", ["plugin", "list", "--json"], { cwd }).stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`omp plugin list --json did not return JSON:\n${raw.trim()}`);
  }
  const entries: PluginEntry[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string" && typeof record.path === "string") {
      entries.push({ name: record.name, path: path.resolve(record.path) });
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(parsed);
  return entries;
}

function readStorageRoot(sb: Sandbox): string | undefined {
  if (!fs.existsSync(sb.configPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(sb.configPath, "utf8")) as { storage?: { root?: unknown } };
    return typeof parsed.storage?.root === "string" ? parsed.storage.root : undefined;
  } catch (error) {
    fail(`cannot read ${sb.configPath}: ${(error as Error).message}`);
  }
}

/** Run directories are `<storage root>/<track_id>/<run_id>`. */
function listRuns(storageRoot: string): Array<{ track: string; run: string }> {
  if (!fs.existsSync(storageRoot)) return [];
  const runs: Array<{ track: string; run: string }> = [];
  for (const track of fs.readdirSync(storageRoot, { withFileTypes: true })) {
    if (!track.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(storageRoot, track.name), { withFileTypes: true })) {
      if (entry.isDirectory()) runs.push({ track: track.name, run: entry.name });
    }
  }
  return runs;
}

type Observation = {
  head: string;
  branch: string;
  dirty: number;
  storageRoot: string | undefined;
  /**
   * `.omp/plugin-overrides.json` disables the user-scoped plugin for this cwd. This is a file
   * check by necessity: `omp plugin list --json` enumerates ~/.omp/plugins with no cwd
   * (PluginManager.list()), while the session-time set comes from getEnabledPlugins(cwd), which
   * is the only place project overrides are applied — no CLI surface exposes that resolution.
   */
  userPluginDisabled: boolean;
  /** Path the user-scope enumeration still prints for the plugin; not a cwd-resolved verdict. */
  listedPluginPath: string | undefined;
  /** Extension paths a CLI surface reports for this cwd, or undefined when no surface reports them. */
  extensionPaths: string[] | undefined;
  /** Name of the CLI surface that produced `extensionPaths`. */
  extensionSurface: string | undefined;
  /** The worktree is in the reported extension set. */
  extensionLoaded: boolean;
  /** `.omp/config.yml` lists the worktree under `extensions`. */
  extensionFileOk: boolean;
  fileNotes: string[];
  runs: Array<{ track: string; run: string }>;
};

function realpath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/** `omp config get extensions --json` is the only surface on omp 18.2.8 that reports a cwd's extension paths. */
function reportedExtensions(cwd: string): string[] | undefined {
  const result = run("omp", ["config", "get", "extensions", "--json"], { cwd, allowFailure: true });
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { value?: unknown };
    if (!Array.isArray(parsed.value)) return undefined;
    return parsed.value.filter((item): item is string => typeof item === "string").map((item) => path.resolve(cwd, item));
  } catch {
    return undefined;
  }
}

function checkIsolationFiles(sb: Sandbox): { extensionFileOk: boolean; overridesOk: boolean; notes: string[] } {
  const notes: string[] = [];
  const yaml = fs.existsSync(sb.ompConfigPath) ? fs.readFileSync(sb.ompConfigPath, "utf8") : undefined;
  const extensionFileOk = yaml !== undefined && yaml.split("\n").some((line) => line.trim() === `- ${sb.worktree}`);
  notes.push(
    yaml === undefined
      ? `${sb.ompConfigPath} missing`
      : extensionFileOk
        ? `${sb.ompConfigPath} lists the worktree under extensions`
        : `${sb.ompConfigPath} does not list ${sb.worktree} under extensions`,
  );
  let overridesOk = false;
  if (fs.existsSync(sb.overridesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sb.overridesPath, "utf8")) as { disabled?: unknown };
      overridesOk = Array.isArray(parsed.disabled) && parsed.disabled.includes(PLUGIN_NAME);
      notes.push(
        overridesOk
          ? `${sb.overridesPath} disables ${PLUGIN_NAME}`
          : `${sb.overridesPath} does not disable ${PLUGIN_NAME}`,
      );
    } catch (error) {
      notes.push(`${sb.overridesPath} is not valid JSON: ${(error as Error).message}`);
    }
  } else notes.push(`${sb.overridesPath} missing`);
  return { extensionFileOk, overridesOk, notes };
}

function observe(sb: Sandbox): Observation {
  if (!fs.existsSync(sb.worktree)) fail(`sandbox worktree ${sb.worktree} does not exist`);
  const head = run("git", ["rev-parse", "HEAD"], { cwd: sb.worktree }).stdout.trim();
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: sb.worktree }).stdout.trim();
  const dirty = run("git", ["status", "--short"], { cwd: sb.worktree }).stdout.split("\n").filter((l) => l.trim()).length;
  const storageRoot = readStorageRoot(sb);
  const entry = pluginEntries(sb.worktree).find((candidate) => candidate.name === PLUGIN_NAME);
  const extensionPaths = reportedExtensions(sb.worktree);
  const files = checkIsolationFiles(sb);
  return {
    head,
    branch,
    dirty,
    storageRoot,
    userPluginDisabled: files.overridesOk,
    listedPluginPath: entry?.path,
    extensionPaths,
    extensionSurface: extensionPaths ? "omp config get extensions --json" : undefined,
    extensionLoaded: extensionPaths !== undefined && extensionPaths.some((candidate) => realpath(candidate) === realpath(sb.worktree)),
    extensionFileOk: files.extensionFileOk,
    fileNotes: files.notes,
    runs: storageRoot ? listRuns(storageRoot) : [],
  };
}

function printSummary(sb: Sandbox, observation: Observation, base?: string): void {
  console.log("");
  console.log(`sandbox        ${sb.name}`);
  console.log(`worktree       ${sb.worktree}`);
  console.log(`branch         ${observation.branch}`);
  console.log(`HEAD           ${observation.head}`);
  if (base) console.log(`base ref       ${base}`);
  console.log(`uncommitted    ${observation.dirty} file(s)`);
  console.log(`storage root   ${observation.storageRoot ?? "(no project config)"}`);
  console.log(
    observation.userPluginDisabled
      ? `user plugin    DISABLED for this cwd [file-check only] - ${PLUGIN_NAME} is in .omp/plugin-overrides.json disabled`
      : `user plugin    NOT DISABLED for this cwd - .omp/plugin-overrides.json does not disable ${PLUGIN_NAME}`,
  );
  console.log(
    `               no omp CLI surface reports cwd-resolved plugin state: omp plugin list --json enumerates`,
  );
  console.log(
    `               ~/.omp/plugins regardless of cwd${observation.listedPluginPath ? ` (it still prints ${observation.listedPluginPath})` : ""}`,
  );
  if (observation.extensionPaths === undefined) {
    console.log(`extensions     no omp CLI surface reports resolved extension paths for a cwd [file-check only]`);
  } else {
    console.log(`extensions     ${observation.extensionSurface} -> ${observation.extensionPaths.join(", ") || "(empty)"}`);
    console.log(
      observation.extensionLoaded
        ? `               the sandbox worktree IS in that set (CLI-verified)`
        : `               the sandbox worktree is NOT in that set`,
    );
  }
  for (const note of observation.fileNotes) console.log(`file check     ${note}`);
  console.log(
    isolated(observation)
      ? `isolation      YES - extension path ${observation.extensionPaths === undefined ? "[file-check only]" : "CLI-verified"}, user plugin disabled [file-check only]`
      : `isolation      NO`,
  );
  console.log(`runs           ${observation.runs.length === 0 ? "(none)" : ""}`);
  for (const { track, run: runId } of observation.runs) console.log(`               ${track}/${runId}`);
}

/** The verdict `status` exits on and `create` gates the summary with. */
function isolated(observation: Observation): boolean {
  if (!observation.userPluginDisabled) return false;
  if (observation.extensionPaths !== undefined) return observation.extensionLoaded;
  return observation.extensionFileOk;
}

function ensureGitignored(worktree: string): void {
  const gitignore = path.join(worktree, ".gitignore");
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
  if (existing.split("\n").some((line) => line.trim() === ".omp/")) return;
  fs.writeFileSync(gitignore, existing.endsWith("\n") || existing === "" ? `${existing}.omp/\n` : `${existing}\n.omp/\n`);
  console.log(`wrote ${gitignore} (+ .omp/)`);
}

function create(name: string, base: string): void {
  const sb = resolveSandbox(name);
  if (fs.existsSync(sb.worktree)) fail(`${sb.worktree} already exists; destroy it first`);
  if (fs.existsSync(sb.storageHome)) fail(`${sb.storageHome} already exists; destroy it first`);
  const branchProbe = run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${sb.branch}`], {
    cwd: sb.repo,
    allowFailure: true,
  });
  if (branchProbe.status === 0) fail(`branch ${sb.branch} already exists; destroy it first`);

  run("git", ["worktree", "add", sb.worktree, "-b", sb.branch, base], { cwd: sb.repo });
  run("bun", ["install", "--frozen-lockfile"], { cwd: sb.worktree });

  fs.mkdirSync(path.dirname(sb.configPath), { recursive: true });
  fs.writeFileSync(sb.configPath, `${JSON.stringify({ version: 1, storage: { root: sb.storageRoot } }, null, 2)}\n`);
  console.log(`wrote ${sb.configPath}`);
  fs.mkdirSync(sb.storageRoot, { recursive: true });
  console.log(`created ${sb.storageRoot}`);
  ensureGitignored(sb.worktree);

  writeIsolationFiles(sb);

  // Invariant kept from the linking era: this script leaves the user plugin scope untouched.
  const userLink = realpath(path.join(USER_PLUGIN_ROOT, "node_modules", PLUGIN_NAME));
  if (isInside(sb.worktree, userLink)) {
    fail(`the user-scoped ${PLUGIN_NAME} install points into ${sb.worktree}; relink it before using this sandbox`);
  }

  const observation = observe(sb);
  printSummary(sb, observation, base);
  console.log("");
  console.log(`next step      open an OMP session in a Herdr pane with cwd ${sb.worktree}`);
  console.log(`               (this script never opens a track and never births a pane)`);
  if (!isolated(observation)) {
    fail(`the sandbox is not isolated: a session in ${sb.worktree} would not load the worktree's plugin`);
  }
}

/**
 * Project-level isolation, both files cwd-keyed and inside the sandbox:
 *   .omp/config.yml            extensions: [<wt>]
 *   .omp/plugin-overrides.json {"disabled":["herdr-delegator"]}
 * Existing files are merged, never replaced: other config keys survive and `disabled` is unioned.
 */
function writeIsolationFiles(sb: Sandbox): void {
  const block = `extensions:\n  - ${sb.worktree}\n`;
  let yaml = block;
  if (fs.existsSync(sb.ompConfigPath)) {
    const lines = fs.readFileSync(sb.ompConfigPath, "utf8").split("\n");
    const kept: string[] = [];
    let inExtensions = false;
    for (const line of lines) {
      if (/^extensions\s*:/.test(line)) {
        inExtensions = true;
        continue;
      }
      if (inExtensions && (line.trim() === "" || /^\s/.test(line))) continue;
      inExtensions = false;
      kept.push(line);
    }
    const rest = kept.join("\n").replace(/\n+$/, "");
    yaml = rest === "" ? block : `${rest}\n${block}`;
  }
  fs.writeFileSync(sb.ompConfigPath, yaml);
  console.log(`wrote ${sb.ompConfigPath} (extensions: ${sb.worktree})`);

  let disabled: string[] = [PLUGIN_NAME];
  let extra: Record<string, unknown> = {};
  if (fs.existsSync(sb.overridesPath)) {
    try {
      const { disabled: existing, ...others } = JSON.parse(fs.readFileSync(sb.overridesPath, "utf8")) as Record<string, unknown>;
      extra = others;
      if (Array.isArray(existing)) {
        disabled = [...new Set([...existing.filter((item): item is string => typeof item === "string"), PLUGIN_NAME])];
      }
    } catch (error) {
      fail(`cannot merge ${sb.overridesPath}: ${(error as Error).message}`);
    }
  }
  fs.writeFileSync(sb.overridesPath, `${JSON.stringify({ ...extra, disabled }, null, 2)}\n`);
  console.log(`wrote ${sb.overridesPath} (disabled: ${disabled.join(", ")})`);
}

function status(name: string): void {
  const sb = resolveSandbox(name);
  const observation = observe(sb);
  printSummary(sb, observation);
  if (!isolated(observation)) {
    console.error("");
    if (!observation.userPluginDisabled) {
      console.error(`sandbox: the user-scoped ${PLUGIN_NAME} is still active for ${sb.worktree}`);
    } else {
      console.error(`sandbox: ${sb.worktree} is not in the extension set for that cwd`);
    }
    process.exit(1);
  }
}

function destroy(name: string, confirmed: boolean): void {
  const sb = resolveSandbox(name);
  assertDestroyable(sb);
  const storageRoot = readStorageRoot(sb) ?? sb.storageRoot;
  const runs = listRuns(storageRoot);
  const tracks = [...new Set(runs.map((entry) => entry.track))];

  const plan = [
    `git worktree remove --force ${sb.worktree}   (takes .omp/config.yml and .omp/plugin-overrides.json with it)`,
    `git branch -D ${sb.branch}`,
    `rm -rf ${sb.storageHome}`,
  ];
  if (!confirmed) {
    console.log(`destroy plan for sandbox ${sb.name} (re-run with --yes to apply):`);
    for (const step of plan) console.log(`  ${step}`);
    console.log(`  ${runs.length} run director(ies) under ${storageRoot} would be deleted`);
    process.exit(2);
  }

  // Removing the worktree while the user-scoped install points into it would leave every
  // session on this machine with a dangling plugin link; refuse instead of repairing blindly.
  const userLink = realpath(path.join(USER_PLUGIN_ROOT, "node_modules", PLUGIN_NAME));
  if (isInside(sb.worktree, userLink)) {
    fail(
      `the user-scoped ${PLUGIN_NAME} install points into ${sb.worktree}; ` +
        `relink it first (omp plugin link <your checkout>) and re-run destroy`,
    );
  }

  if (fs.existsSync(sb.worktree)) {
    // The isolation files live inside the worktree, so removing it removes them; there is no
    // project-scoped plugin install to undo, because this script never made one.
    run("git", ["worktree", "remove", "--force", sb.worktree], { cwd: sb.repo });
  } else {
    console.log(`skip: ${sb.worktree} does not exist`);
  }

  const branchProbe = run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${sb.branch}`], {
    cwd: sb.repo,
    allowFailure: true,
  });
  if (branchProbe.status === 0) run("git", ["branch", "-D", sb.branch], { cwd: sb.repo });
  else console.log(`skip: branch ${sb.branch} does not exist`);

  if (fs.existsSync(sb.storageHome)) {
    fs.rmSync(sb.storageHome, { recursive: true, force: true });
    console.log(`removed ${sb.storageHome}`);
  } else {
    console.log(`skip: ${sb.storageHome} does not exist`);
  }

  console.log("");
  if (tracks.length === 0) {
    console.log("no runs were recorded in this sandbox, so no Herdr workspace should remain from it.");
  } else {
    console.log("Herdr workspaces that may still exist for tracks opened in this sandbox:");
    for (const track of tracks) console.log(`  herdr/${track}`);
    console.log("Closing those panes and workspaces is your action; this script never touches Herdr.");
  }
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  bun scripts/sandbox.ts create <name> [--base <ref>]",
      "  bun scripts/sandbox.ts status <name>",
      "  bun scripts/sandbox.ts destroy <name> [--yes]",
    ].join("\n"),
  );
  process.exit(2);
}

function main(argv: string[]): void {
  const [command, name, ...rest] = argv;
  if (!command || !name) usage();
  let base = "main";
  let confirmed = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--yes") confirmed = true;
    else if (flag === "--base") {
      const value = rest[index + 1];
      if (!value) fail("--base needs a ref");
      base = value;
      index += 1;
    } else if (flag.startsWith("--base=")) base = flag.slice("--base=".length);
    else fail(`unknown flag ${flag}`);
  }
  if (command === "create") create(name, base);
  else if (command === "status") status(name);
  else if (command === "destroy") destroy(name, confirmed);
  else usage();
}

main(process.argv.slice(2));
