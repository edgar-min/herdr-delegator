// The command-line track subcommands as a user runs them: `bun run mcp/cli.ts`
// from a Herdr shell pane, with a fake `herdr` binary standing in for the
// daemon so `open` lays out a real run under a temp storage root and records a
// real birth without touching the user's Herdr session.
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
const CLI = path.join(REPO, "mcp", "cli.ts");
const CALLER_PANE = "wC:p1";

/**
 * A stateful stand-in for the Herdr 0.8.2 CLI: JSON on stdout for a success,
 * `{"error":{code,message}}` on stderr with exit 1 for a failure, and the
 * caller as a plain shell pane — `agent get` on it answers `agent_not_found`,
 * exactly as the real daemon does for a pane that runs no agent.
 */
const FAKE_HERDR = String.raw`#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const statePath = process.env.FAKE_HERDR_STATE;
const args = process.argv.slice(2);
appendFileSync(statePath + ".log", JSON.stringify(args) + "\n");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => { writeFileSync(statePath + ".tmp", JSON.stringify(state)); renameSync(statePath + ".tmp", statePath); };
const ok = (result) => { process.stdout.write(JSON.stringify({ id: "fake", result })); process.exit(0); };
const fail = (code, message) => { process.stderr.write(JSON.stringify({ error: { code, message }, id: "fake" })); process.exit(1); };
const option = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const pane = (id) => state.panes.find((candidate) => candidate.pane_id === id);
const agentView = (agent) => ({ ...pane(agent.pane_id), name: agent.name, agent_status: agent.status, state_change_seq: agent.seq, interactive_ready: true });
const command = args.slice(0, 2).join(" ");

switch (command) {
  case "api schema": ok({ protocol: 20, schema_version: 1, capabilities: ["agent.prompt", "agent.wait", "agent.start", "pane.wait_for_output", "pane.report_metadata"] });
  case "api snapshot": ok({ snapshot: { focused_workspace_id: "wC", focused_tab_id: "wC:t1", focused_pane_id: ${JSON.stringify(CALLER_PANE)}, workspaces: state.workspaces, tabs: state.tabs, panes: state.panes, agents: state.agents.map(agentView) } });
  case "workspace list": ok({ workspaces: state.workspaces });
  case "workspace get": { const found = state.workspaces.find((w) => w.workspace_id === args[2]); found ? ok({ workspace: found }) : fail("workspace_not_found", "workspace not found"); }
  case "workspace create": {
    const n = state.workspaces.length + 1;
    const workspace = { workspace_id: "w" + n, label: option("--label") };
    const tab = { tab_id: "w" + n + ":t1", workspace_id: workspace.workspace_id, label: "1" };
    const root = { pane_id: "w" + n + ":p1", workspace_id: workspace.workspace_id, tab_id: tab.tab_id, cwd: option("--cwd") };
    state.workspaces.push(workspace); state.tabs.push(tab); state.panes.push(root); save();
    ok({ workspace, tab, root_pane: root });
  }
  case "tab rename": { const tab = state.tabs.find((t) => t.tab_id === args[2]); if (!tab) fail("tab_not_found", "tab not found"); tab.label = args[3]; save(); ok({ tab }); }
  case "tab get": { const tab = state.tabs.find((t) => t.tab_id === args[2]); tab ? ok({ tab }) : fail("tab_not_found", "tab not found"); }
  case "pane get": { const found = pane(args[2]); found ? ok({ pane: found }) : fail("pane_not_found", "pane not found"); }
  case "pane list": ok({ panes: state.panes.filter((p) => !option("--workspace") || p.workspace_id === option("--workspace")) });
  case "pane process-info": ok({ process_info: { pane_id: option("--pane"), shell_pid: 4242, foreground_processes: [{ pid: 4242, name: "zsh", argv0: "zsh" }] } });
  case "pane rename": { const found = pane(args[2]); if (!found) fail("pane_not_found", "pane not found"); found.label = args[3]; save(); ok({ pane: found }); }
  case "pane report-metadata": process.exit(0);
  case "workspace focus": case "tab focus": case "agent focus": ok({});
  case "agent get": {
    const agent = state.agents.find((a) => a.name === args[2] || a.pane_id === args[2]);
    agent ? ok({ agent: agentView(agent) }) : fail("agent_not_found", "agent target " + args[2] + " not found");
  }
  case "agent start": {
    const target = pane(option("--pane"));
    if (!target) fail("pane_not_found", "pane not found");
    const sessionId = "0000fake-" + args[2];
    const sessionPath = path.join(state.sessions_dir, "2026-09-28T00-00-00-000Z_" + sessionId + ".jsonl");
    mkdirSync(state.sessions_dir, { recursive: true });
    writeFileSync(sessionPath, [{ type: "session", id: sessionId }, { type: "model_change", provider: "fake", model: "fake-model", resolvedModelIsFallback: false }].map((line) => JSON.stringify(line)).join("\n") + "\n");
    target.agent = "omp";
    target.agent_session = { source: "herdr:omp", agent: "omp", kind: "path", value: sessionPath };
    target.tokens = { "herdr-delegator-session": sessionId, "herdr-delegator-attestation": Date.now() + ".0123456789abcdef" };
    const agent = { name: args[2], pane_id: target.pane_id, status: "idle", seq: 1 };
    state.agents.push(agent); save();
    ok({ agent: agentView(agent) });
  }
  case "agent prompt": {
    const agent = state.agents.find((a) => a.name === args[2]);
    if (!agent) fail("agent_not_found", "agent not found");
    agent.status = "working"; agent.seq += 1; state.prompts += 1; save();
    ok({ agent: agentView(agent) });
  }
  default: process.stderr.write(JSON.stringify({ error: { code: "fake_unsupported", message: args.join(" ") } })); process.exit(2);
}
`;

const temps: string[] = [];
afterAll(async () => { await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))); });

async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

type Fixture = { cwd: string; storageRoot: string; statePath: string; env: Record<string, string> };

/** A project whose storage root is a temp dir, a fake herdr on PATH, and a Herdr shell-pane caller. */
async function fixture(): Promise<Fixture> {
  const cwd = await temp("cli-open-cwd-");
  const storageRoot = await temp("cli-open-store-");
  const agentDir = await temp("cli-open-agent-");
  const bin = await temp("cli-open-bin-");
  await mkdir(path.join(cwd, ".omp"));
  await writeFile(path.join(cwd, ".omp", "herdr-delegator.json"), `${JSON.stringify({ version: 1, storage: { root: storageRoot } }, null, 2)}\n`);
  await mkdir(path.join(cwd, "notes"));
  await writeFile(path.join(cwd, "notes", "decisions.md"), "# Decisions\n");
  const statePath = path.join(bin, "state.json");
  await writeFile(statePath, JSON.stringify({
    prompts: 0,
    sessions_dir: path.join(agentDir, "sessions"),
    workspaces: [{ workspace_id: "wC", label: "caller" }],
    tabs: [{ tab_id: "wC:t1", workspace_id: "wC", label: "1" }],
    panes: [{ pane_id: CALLER_PANE, workspace_id: "wC", tab_id: "wC:t1", cwd }],
    agents: [],
  }));
  const herdr = path.join(bin, "herdr");
  await writeFile(herdr, FAKE_HERDR);
  await chmod(herdr, 0o755);
  // PATH holds only the fake and system directories: the real herdr must be unreachable.
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    HERDR_ENV: "1",
    HERDR_PANE_ID: CALLER_PANE,
    HERDR_BIN_PATH: herdr,
    FAKE_HERDR_STATE: statePath,
  };
  return { cwd, storageRoot, statePath, env };
}

/** A mandate whose deterministic check passes against the fixture project. */
function mandate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mandate_version: 2,
    purpose: "Settle where the opening contract's rules live.",
    language: "en",
    entry: {
      protocol: "sketch",
      utterance: "Make variants of the opening contract for the bound open item.",
      reason: "A form must be made that the user would recognize on sight.",
    },
    settled: [{ decision: "The creator never becomes the ORCH.", source: "user, creator conversation 2026-09-23", reason: "unstated" }],
    substrate: ["notes/decisions.md records the currently operative decisions."],
    open: [{ item: "Where should the first-turn rules live?", candidates: ["In a run document", "In the role skill"] }],
    done_when: ["plan.md records the user's recognized version as a D-numbered entry."],
    forbidden: ["Do not modify the main branch in this track."],
    budget: { tokens: 500000, minutes: 60, doorbell_policy: "notify" },
    ...overrides,
  };
}

async function mandateFile(dir: string, body: unknown): Promise<string> {
  const file = path.join(dir, `mandate-${temps.length}.json`);
  await writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

async function cli(args: string[], env: Record<string, string>, cwd = REPO): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", CLI, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

describe("check", () => {
  test("prints the check lines and exits 0 on PASSED", async () => {
    const { cwd, env } = await fixture();
    const result = await cli(["check", "--mandate", await mandateFile(cwd, mandate()), "--cwd", cwd], env);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("verdict: PASSED");
    expect(lines).toContain("ok   semantic: skipped (no Jev key)");
    expect(lines.slice(0, -1).every((line) => line.startsWith("ok   "))).toBe(true);
  });

  test("names the failing rule and exits 1 on FAILED", async () => {
    const { cwd, env } = await fixture();
    const broken = mandate({ done_when: ["Settle where the opening contract's rules live."] });
    const result = await cli(["check", "--mandate", await mandateFile(cwd, broken), "--cwd", cwd], env);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("FAIL done-when-distinct: ");
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("verdict: FAILED");
  });
});

describe("open", () => {
  test("lays out the run, stamps an unverified creator, and records one birth on the spawned pane", async () => {
    const { cwd, storageRoot, statePath, env } = await fixture();
    const result = await cli(["open", "--mandate", await mandateFile(cwd, mandate()), "--cwd", cwd, "--track", "cli-track"], env);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const printed = JSON.parse(result.stdout) as { ok: boolean; action: string; effect: string; run: unknown; data: { creator_verified: boolean; orch_pane_id: string } };
    expect(printed).toMatchObject({ ok: true, tool: "herdr_track", action: "open", effect: "confirmed", run: { track_id: "cli-track", run_id: "r1" } });

    const runPath = path.join(storageRoot, "cli-track", "r1");
    const manifest = JSON.parse(await readFile(path.join(runPath, "run.json"), "utf8")) as { cwd: string };
    expect(manifest.cwd).toBe(cwd);
    expect(JSON.parse(await readFile(path.join(runPath, "mandate.json"), "utf8"))).toEqual(mandate());
    const registry = JSON.parse(await readFile(path.join(runPath, "a2a", "delegation.json"), "utf8")) as {
      orch_creator: { pane_id: string; verified: boolean; session_id?: string };
      orch_births: { pane_id: string; generation: number; origin: string }[];
    };
    expect(registry.orch_creator).toMatchObject({ pane_id: CALLER_PANE, verified: false });
    expect(registry.orch_creator.session_id).toBeUndefined();

    const fake = JSON.parse(await readFile(statePath, "utf8")) as { agents: { pane_id: string }[]; prompts: number };
    expect(fake.agents).toHaveLength(1);
    expect(fake.prompts).toBe(1);
    expect(registry.orch_births).toHaveLength(1);
    expect(registry.orch_births[0]).toMatchObject({ generation: 1, origin: "spawn", pane_id: fake.agents[0].pane_id });
    expect(fake.agents[0].pane_id).not.toBe(CALLER_PANE);
    expect(printed.data).toMatchObject({ creator_verified: false, orch_pane_id: fake.agents[0].pane_id });
  });

  test("a failed open prints the failure JSON to stderr and exits 1", async () => {
    const { cwd, storageRoot, env } = await fixture();
    const broken = mandate({ done_when: ["Settle where the opening contract's rules live."] });
    const result = await cli(["open", "--mandate", await mandateFile(cwd, broken), "--cwd", cwd, "--track", "cli-track"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, action: "open", effect: "none", error: { code: "mandate_check_failed" } });
    expect(await Bun.file(path.join(storageRoot, "cli-track", "r1", "run.json")).exists()).toBe(false);
  });
});

describe("refusals exit 2 with one stderr line and do nothing", () => {
  const refused = (result: { exitCode: number; stdout: string; stderr: string }) => {
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.endsWith("\n")).toBe(true);
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
  };

  test("an unknown option, a missing required option, and a malformed coordinate", async () => {
    const { cwd, env } = await fixture();
    const file = await mandateFile(cwd, mandate());
    for (const args of [
      ["check", "--mandate", file, "--track", "t1"],
      ["open", "--mandate", file, "--cwd", cwd],
      ["open", "--mandate", file, "--track", "Not_A_Coordinate"],
      ["open", "--mandate", file, "--track", "t1", "stray"],
      ["remove", "--track", "t1"],
    ]) refused(await cli(args, env));
  });

  test("outside a Herdr pane: HERDR_ENV unset, or HERDR_PANE_ID unset", async () => {
    const { cwd, storageRoot, env } = await fixture();
    const file = await mandateFile(cwd, mandate());
    const { HERDR_ENV: _env, ...noHerdrEnv } = env;
    const { HERDR_PANE_ID: _pane, ...noPane } = env;
    for (const without of [noHerdrEnv, noPane]) {
      refused(await cli(["open", "--mandate", file, "--cwd", cwd, "--track", "cli-track"], without));
      refused(await cli(["check", "--mandate", file, "--cwd", cwd], without));
    }
    expect(await Bun.file(path.join(storageRoot, "cli-track", "r1", "run.json")).exists()).toBe(false);
  });

  test("an unreadable mandate file, or one that is not JSON, without echoing its content", async () => {
    const { cwd, env } = await fixture();
    const secretish = "{ \"purpose\": \"do-not-echo-this\"";
    const notJson = await mandateFile(cwd, secretish);
    for (const subcommand of [["check"], ["open", "--track", "cli-track"]]) {
      refused(await cli([...subcommand, "--mandate", path.join(cwd, "missing.json"), "--cwd", cwd], env));
      const result = await cli([...subcommand, "--mandate", notJson, "--cwd", cwd], env);
      refused(result);
      expect(result.stderr).not.toContain("do-not-echo-this");
    }
  });
});

test("the launcher forwards check and open to the CLI without starting the server", async () => {
  const { env } = await fixture();
  const launcher = path.join(REPO, "bin", "herdr-delegator-mcp");
  for (const subcommand of ["check", "open"]) {
    const proc = Bun.spawn(["sh", launcher, subcommand, "--help"], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stdout).toStartWith("usage: herdr-delegator-mcp check --mandate");
  }
});
