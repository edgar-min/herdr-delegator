// `herdr_track open` records the ORCH birth once the spawned pane's session
// identity is verified and before the first-prompt delivery wait. Herdr's
// `agent prompt --wait` has a fixed 5000 ms stall window that `--timeout` does
// not extend, so a slow fresh session returns `agent_prompt_stalled` after the
// prompt was submitted; that must not leave a live, verified ORCH pane without
// an `orch_births` record. A stateful fake `herdr` binary drives the real open.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { herdrTrackSchema, type Mandate, type McpResult } from "../mcp/contracts";
import { HerdrAdapter } from "../mcp/herdr-adapter";
import { CompositeTools } from "../mcp/tools";

const TRACK = "birth-track";
const RUN = "r1";
const ANCHOR_PANE = "p-anchor";
const CREATOR_PANE = "p-creator";

/**
 * Herdr 0.8.2 as the open path observes it: one caller pane, one track space
 * created on demand, and an ORCH agent whose first prompt either lands or
 * stalls. Every call is logged; state lives in the file named by
 * FAKE_HERDR_STATE so consecutive invocations see each other's effects.
 */
const FAKE_HERDR = String.raw`
const fs = require("node:fs");
const statePath = process.env.FAKE_HERDR_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(state.log, JSON.stringify(args) + "\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const ok = (data) => { process.stdout.write(JSON.stringify(data)); process.exit(0); };
const fail = (code, message) => { process.stderr.write(JSON.stringify({ code, message })); process.exit(1); };
const ref = (value) => ({ source: "herdr:omp", agent: "omp", kind: "path", value });
const tokens = (s) => ({ "herdr-delegator-session": s.sid, "herdr-delegator-attestation": s.nonce });
const flag = (name) => args[args.indexOf(name) + 1];
const { target: T, creator: C, orch: O } = state;
const workspace = () => ({ workspace_id: T.workspace, label: state.workspace_label });
const anchorPane = () => ({ pane_id: T.pane, workspace_id: T.workspace, tab_id: T.tab, cwd: state.cwd, ...(state.agent ? { agent: "omp", session: ref(O.path), tokens: tokens(O) } : {}) });
const orchAgent = () => ({ name: state.agent, pane_id: T.pane, workspace_id: T.workspace, tab_id: T.tab, agent_status: state.agent_status, session: ref(O.path) });
const [noun, verb, subject] = args;
switch (noun + " " + verb) {
  case "api schema": ok({ protocol: 20, schema_version: 1, capabilities: ["agent.prompt", "agent.wait", "agent.start", "pane.wait_for_output", "pane.report_metadata"] });
  case "api snapshot": ok({
    focused_workspace_id: C.workspace, focused_tab_id: C.tab, focused_pane_id: C.pane,
    workspaces: state.workspace_label ? [workspace()] : [],
    tabs: state.workspace_label ? [{ tab_id: T.tab, workspace_id: T.workspace, label: state.anchor_label }] : [],
    panes: [{ pane_id: C.pane, tab_id: C.tab, workspace_id: C.workspace }, ...(state.workspace_label ? [{ pane_id: T.pane, tab_id: T.tab, workspace_id: T.workspace }] : [])],
  });
  case "agent get":
    if (subject === C.pane) ok({ agent: { name: "creator", pane_id: C.pane, workspace_id: C.workspace, tab_id: C.tab, agent_status: "working", session: ref(C.path) } });
    if (state.agent && subject === state.agent) ok({ agent: orchAgent() });
    fail("agent_not_found", "agent " + subject + " not found");
  case "agent list": ok({ agents: state.agent ? [orchAgent()] : [] });
  case "agent start":
    state.agent = subject;
    state.agent_status = "idle";
    O.nonce = Date.now() + ".0123456789abcdef";
    fs.writeFileSync(O.path, JSON.stringify({ type: "session", id: O.sid }) + "\n" + JSON.stringify({ type: "model_change", provider: "fake", model: "orch-model", resolvedModelIsFallback: false }) + "\n");
    save();
    ok({ agent: orchAgent(), interactive_ready: true });
  case "agent prompt":
    state.prompts.push(args[3]);
    if (state.prompt_mode === "stall") { save(); fail("agent_prompt_stalled", "no observed state change within 5000 ms after the prompt was submitted"); }
    state.agent_status = "working";
    save();
    ok({ agent: orchAgent() });
  case "pane get":
    if (subject === C.pane) ok({ pane: { pane_id: C.pane, workspace_id: C.workspace, tab_id: C.tab, cwd: state.cwd, agent: "omp", session: ref(C.path), tokens: tokens(C) } });
    if (state.workspace_label && subject === T.pane) ok({ pane: anchorPane() });
    fail("pane_not_found", "pane " + subject + " not found");
  case "pane list": ok({ panes: state.workspace_label ? [anchorPane()] : [] });
  case "pane process-info": ok({ pane_id: T.pane, shell_pid: 4242, foreground_processes: [{ pid: 4242, name: "zsh" }] });
  case "pane rename": ok({});
  case "workspace list": ok({ workspaces: state.workspace_label ? [workspace()] : [] });
  case "workspace create":
    state.workspace_label = flag("--label");
    save();
    ok({ workspace: workspace(), tab: { tab_id: T.tab, workspace_id: T.workspace }, root_pane: { pane_id: T.pane, tab_id: T.tab, workspace_id: T.workspace } });
  case "workspace get": ok({ workspace: workspace() });
  case "tab rename": state.anchor_label = args[3]; save(); ok({});
  case "tab get": ok({ tab: { tab_id: T.tab, workspace_id: T.workspace, label: state.anchor_label } });
  case "workspace focus": case "tab focus": case "agent focus": ok({});
}
process.stderr.write(JSON.stringify({ code: "fake_unsupported", message: args.join(" ") }));
process.exit(2);
`;

type FakeState = {
  log: string;
  cwd: string;
  prompt_mode: "stall" | "land";
  prompts: string[];
  target: { workspace: string; tab: string; pane: string };
  creator: { workspace: string; tab: string; pane: string; sid: string; path: string; nonce: string };
  orch: { sid: string; path: string; nonce?: string };
};

type Birth = { generation: number; official_session_id: string; official_session_path?: string; pane_id: string; origin: string };

const ENV_KEYS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_BIN_PATH", "PATH", "PI_CODING_AGENT_DIR", "FAKE_HERDR_STATE", "TYPESAFE_API_KEY", "JEV_API_KEY"] as const;
let savedEnv: (string | undefined)[];
let root: string;
let cwd: string;
let storageRoot: string;
let statePath: string;

function mandate(): Mandate {
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
    substrate: ["notes.md records the prior opening decisions."],
    open: [{ item: "Where should the first-turn rules live?", candidates: ["In a run document", "In the role skill"] }],
    done_when: ["plan.md records the user's recognized version as a D-numbered entry."],
    forbidden: ["Do not modify the main branch in this track."],
    budget: { tokens: 500000, minutes: 60, doorbell_policy: "notify" },
  } as Mandate;
}

async function readState(): Promise<FakeState> {
  return JSON.parse(await readFile(statePath, "utf8")) as FakeState;
}

async function births(): Promise<Birth[]> {
  const registry = JSON.parse(await readFile(path.join(storageRoot, TRACK, RUN, "a2a", "delegation.json"), "utf8")) as { orch_births?: Birth[] };
  return registry.orch_births ?? [];
}

async function open(): Promise<McpResult> {
  const tools = new CompositeTools(await HerdrAdapter.create());
  return tools.track(herdrTrackSchema.parse({ action: "open", track_id: TRACK, run_id: RUN, cwd, mandate: mandate() }));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("expected an object");
  return value as Record<string, unknown>;
}

async function setPromptMode(mode: FakeState["prompt_mode"]): Promise<void> {
  await writeFile(statePath, JSON.stringify({ ...(await readState()), prompt_mode: mode }));
}

beforeEach(async () => {
  savedEnv = ENV_KEYS.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(path.join(tmpdir(), "track-open-birth-")));
  cwd = path.join(root, "project");
  storageRoot = path.join(root, "store");
  const agentDir = path.join(root, "agent");
  const sessions = path.join(root, "sessions");
  const bin = path.join(root, "bin");
  await Promise.all([mkdir(path.join(cwd, ".omp"), { recursive: true }), mkdir(storageRoot), mkdir(sessions), mkdir(bin)]);
  await writeFile(path.join(cwd, ".omp", "herdr-delegator.json"), `${JSON.stringify({ version: 1, storage: { root: storageRoot } }, null, 2)}\n`);
  await writeFile(path.join(cwd, "notes.md"), "# Prior opening decisions\n");

  // The opening session: a Herdr pane whose OMP bridge published fresh facts.
  const issuedAt = Date.now();
  const creator = { workspace: "w-creator", tab: "t-creator", pane: CREATOR_PANE, sid: "creator-session", path: path.join(sessions, "2026-09-28T00-00-00-000Z_creator-session.jsonl"), nonce: `${issuedAt}.fedcba9876543210` };
  await writeFile(creator.path, `${JSON.stringify({ type: "session", id: creator.sid })}\n`);
  const facts = path.join(agentDir, "herdr-delegator", "runtime", "omp-facts");
  await mkdir(facts, { recursive: true });
  await chmod(facts, 0o700);
  const factPath = path.join(facts, `${creator.sid}.json`);
  await writeFile(factPath, JSON.stringify({ version: 1, session_id: creator.sid, reported_session_path: creator.path, pane_id: creator.pane, issued_at: new Date(issuedAt).toISOString(), nonce: creator.nonce }));
  await chmod(factPath, 0o600);

  statePath = path.join(root, "herdr-state.json");
  const state: FakeState = {
    log: path.join(root, "herdr-calls.jsonl"),
    cwd,
    prompt_mode: "land",
    prompts: [],
    target: { workspace: "w-track", tab: "t-anchor", pane: ANCHOR_PANE },
    creator,
    orch: { sid: "orch-session", path: path.join(sessions, "2026-09-28T00-00-01-000Z_orch-session.jsonl") },
  };
  await writeFile(statePath, JSON.stringify(state));
  const herdr = path.join(bin, "herdr");
  await writeFile(herdr, `#!${process.execPath}\n${FAKE_HERDR}`);
  await chmod(herdr, 0o755);

  process.env.HERDR_ENV = "1";
  // Only the fake is reachable: a real Herdr must never see this fixture.
  process.env.PATH = [bin, "/usr/bin", "/bin"].join(path.delimiter);
  process.env.HERDR_PANE_ID = CREATOR_PANE;
  process.env.HERDR_BIN_PATH = herdr;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.FAKE_HERDR_STATE = statePath;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_API_KEY;
});

afterEach(async () => {
  ENV_KEYS.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; });
  await rm(root, { recursive: true, force: true });
});

describe("herdr_track open birth ordering", () => {
  test("a first-prompt stall after bootstrap verification still records generation 1 and reports it", async () => {
    await setPromptMode("stall");
    const result = await open();

    expect(result.ok).toBe(false);
    expect(result.effect).toBe("ambiguous");
    expect(result.retryable).toBe(true);
    expect(result.error?.code).toBe("agent_prompt_stalled");
    expect(result.error?.ambiguous_effect).toBe(true);
    expect(result.error?.recovery).toContain(`pane ${ANCHOR_PANE}`);
    expect(result.error?.recovery).toContain("identical herdr_track open");
    expect(result.error?.recovery).toContain("without replaying the prompt");

    const state = await readState();
    const expected = { generation: 1, official_session_id: state.orch.sid, official_session_path: state.orch.path, pane_id: ANCHOR_PANE, origin: "spawn" };
    const data = record(result.data);
    expect(data.orch_pane_id).toBe(ANCHOR_PANE);
    expect(data.orch_birth).toMatchObject(expected);
    const recorded = await births();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject(expected);
    // The stall came from the one submitted prompt, after the pane's identity
    // was verified — not from a spawn or verification failure.
    expect(state.prompts).toHaveLength(1);
    const registry = JSON.parse(await readFile(path.join(storageRoot, TRACK, RUN, "a2a", "herdr-workers.json"), "utf8")) as { run?: { target_orchestrator?: Record<string, unknown> } };
    expect(registry.run?.target_orchestrator).toMatchObject({ session_id: state.orch.sid, prompt_state: "prompting" });
    expect(typeof registry.run?.target_orchestrator?.bootstrap_verified_at).toBe("string");
  }, 30_000);

  test("the identical open after a stalled one reconciles to already_open without a second generation or prompt", async () => {
    await setPromptMode("stall");
    const first = await open();
    expect(first.effect).toBe("ambiguous");
    const firstBirth = record(first.data).orch_birth;

    await setPromptMode("land");
    const second = await open();

    expect(second.ok).toBe(true);
    expect(second.effect).toBe("none");
    const data = record(second.data);
    expect(data.already_open).toBe(true);
    expect(data.orch_birth).toEqual(firstBirth);
    expect(data.orch_pane_id).toBe(ANCHOR_PANE);
    const recorded = await births();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.generation).toBe(1);
    expect((await readState()).prompts).toHaveLength(1);
  }, 30_000);

  test("a landed first prompt records exactly one birth and confirms the open", async () => {
    const result = await open();

    expect(result.ok).toBe(true);
    expect(result.effect).toBe("confirmed");
    const state = await readState();
    const expected = { generation: 1, official_session_id: state.orch.sid, official_session_path: state.orch.path, pane_id: ANCHOR_PANE, origin: "spawn" };
    const data = record(result.data);
    expect(data.orch_birth).toMatchObject(expected);
    expect(data.orch_pane_id).toBe(ANCHOR_PANE);
    const recorded = await births();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject(expected);
    expect(state.prompts).toHaveLength(1);
  }, 30_000);
});
