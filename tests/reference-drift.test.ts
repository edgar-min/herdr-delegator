// A `# References` pin is verified at preflight and add; after dispatch a moved
// document is a `reference_drift` warning. The run's own plan.md is the
// exception: it is a living document the ORCH keeps editing, so its later
// change is never drift, while any other pinned document still is.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeRun } from "../io.github.edgar-min.herdr-delegator/extensions/lib/track";
import { sha256 } from "../mcp/contracts";
import type { HerdrAdapter } from "../mcp/herdr-adapter";
import { DelegationStore } from "../mcp/registry";
import { CompositeTools } from "../mcp/tools";

const TRACK = "drift-track";
const RUN = "r1";
const ORCH_PANE = "p-orch";
const ORCH_SESSION = "orch-session";
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "HERDR_PANE_ID", "TYPESAFE_API_KEY", "JEV_API_KEY"] as const;
let savedEnv: (string | undefined)[];
let root: string;
let store: DelegationStore;
let adapter: HerdrAdapter;
let restoreResolve: () => void;

/** The ORCH's own pane as Herdr and the OMP fact bridge describe it, so `wait` attests it. */
async function attestOrch(agentDir: string, sessionPath: string): Promise<HerdrAdapter> {
  const issuedAt = Date.now();
  const nonce = `${issuedAt}.0123456789abcdef`;
  const facts = path.join(agentDir, "herdr-delegator", "runtime", "omp-facts");
  await mkdir(facts, { recursive: true });
  await chmod(facts, 0o700);
  const factPath = path.join(facts, `${ORCH_SESSION}.json`);
  await writeFile(factPath, JSON.stringify({ version: 1, session_id: ORCH_SESSION, reported_session_path: sessionPath, pane_id: ORCH_PANE, issued_at: new Date(issuedAt).toISOString(), nonce }));
  await chmod(factPath, 0o600);
  const ref = { source: "herdr:omp", agent: "omp", kind: "path", value: sessionPath };
  return {
    getAgent: async () => ({ data: { agent: { pane_id: ORCH_PANE, session: ref } }, stdout: "" }),
    getPane: async () => ({ data: { pane: { pane_id: ORCH_PANE, session: ref, tokens: { "herdr-delegator-session": ORCH_SESSION, "herdr-delegator-attestation": nonce } } }, stdout: "" }),
  } as unknown as HerdrAdapter;
}

beforeEach(async () => {
  savedEnv = ENV_KEYS.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(path.join(tmpdir(), "reference-drift-")));
  const cwd = path.join(root, "project");
  const storageRoot = path.join(root, "store");
  const agentDir = path.join(root, "agent");
  await Promise.all([mkdir(path.join(cwd, ".omp"), { recursive: true }), mkdir(storageRoot), mkdir(agentDir)]);
  await writeFile(path.join(cwd, ".omp", "herdr-delegator.json"), `${JSON.stringify({ version: 1, storage: { root: storageRoot } })}\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HERDR_PANE_ID = ORCH_PANE;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_API_KEY;
  await initializeRun({ operation: "init_run", track_id: TRACK, run_id: RUN, cwd });
  store = await DelegationStore.resolve(TRACK, RUN, cwd);
  adapter = await attestOrch(agentDir, path.join(root, `2026-09-28T00-00-00-000Z_${ORCH_SESSION}.jsonl`));
  const resolve = DelegationStore.resolve.bind(DelegationStore);
  const spy = spyOn(DelegationStore, "resolve").mockImplementation((trackId, runId) => resolve(trackId, runId, cwd));
  restoreResolve = () => spy.mockRestore();
});

afterEach(async () => {
  restoreResolve();
  ENV_KEYS.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; });
  await rm(root, { recursive: true, force: true });
});

/** A settled assignment that pinned `pinned` at their current bytes, commanded by the attested ORCH. */
async function settledAssignmentPinning(pinned: Record<string, string>): Promise<void> {
  const references: { path: string; sha256: string }[] = [];
  for (const [name, body] of Object.entries(pinned)) {
    await writeFile(path.join(store.runPath, name), body);
    references.push({ path: name, sha256: sha256(body) });
  }
  const now = new Date().toISOString();
  await store.mutate(5_000, (next) => {
    next.orch_births = [{ generation: 1, official_session_id: ORCH_SESSION, pane_id: ORCH_PANE, origin: "spawn", born_at: now }];
    next.responsibilities.drift = { key: "drift", worker_ids: ["w1"] };
    next.lanes.w1 = { worker_id: "w1", responsibility_key: "drift", lane_generation: 1, queued_assignment_ids: [], last_completed_assignment_id: "A-001", state: "idle", created_at: now, updated_at: now };
    next.assignments["A-001"] = { assignment_id: "A-001", responsibility_key: "drift", worker_id: "w1", state: "completed", instructions_sha256: "a".repeat(64), references, completed_at: now, created_at: now, updated_at: now };
  });
}

async function waitOnA001(): Promise<string> {
  const result = await new CompositeTools(adapter).assignment({ action: "wait", track_id: TRACK, run_id: RUN, assignment_id: "A-001" });
  expect(result.ok).toBe(true);
  expect(result.assignment?.state).toBe("completed");
  return JSON.stringify(result);
}

describe("reference drift after dispatch", () => {
  test("a changed plan.md pin is not drift", async () => {
    await settledAssignmentPinning({ "plan.md": "# plan\n\nD-01 first decision.\n" });
    await writeFile(path.join(store.runPath, "plan.md"), "# plan\n\nD-01 first decision.\nD-02 a later decision.\n");
    expect(await waitOnA001()).not.toContain("reference_drift");
  });

  test("a changed pin of any other document still warns, naming only that document", async () => {
    await settledAssignmentPinning({ "plan.md": "# plan\n", "spec.md": "# spec v1\n" });
    await writeFile(path.join(store.runPath, "plan.md"), "# plan\n\nD-02 edited.\n");
    await writeFile(path.join(store.runPath, "spec.md"), "# spec v2\n");
    const observed = await waitOnA001();
    expect(observed).toContain("reference_drift: 1 of 1 document(s)");
    expect(observed).toContain("spec.md now hashes");
    expect(observed).not.toContain("plan.md now hashes");
  });
});
