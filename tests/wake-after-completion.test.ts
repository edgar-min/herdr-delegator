// `wake_worker` on an assignment whose lane report already carries a settling
// completion block is a bell at a completion boundary: the directive belongs in
// a NEW assignment. The bell is still sent; the result and the message journal
// say `after_completion`, and a warning says why.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeRun } from "../io.github.edgar-min.herdr-delegator/extensions/lib/track";
import type { HerdrAdapter } from "../mcp/herdr-adapter";
import { DelegationStore } from "../mcp/registry";
import { CompositeTools } from "../mcp/tools";

const TRACK = "wake-track";
const RUN = "r1";
const ORCH_PANE = "p-orch";
const ORCH_SESSION = "orch-session";
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "HERDR_PANE_ID"] as const;
let savedEnv: (string | undefined)[];
let root: string;
let store: DelegationStore;
let adapter: HerdrAdapter;
let bells: string[];
let restoreResolve: () => void;

beforeEach(async () => {
  savedEnv = ENV_KEYS.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(path.join(tmpdir(), "wake-after-completion-")));
  const cwd = path.join(root, "project");
  const storageRoot = path.join(root, "store");
  const facts = path.join(root, "agent", "herdr-delegator", "runtime", "omp-facts");
  await Promise.all([mkdir(path.join(cwd, ".omp"), { recursive: true }), mkdir(storageRoot), mkdir(facts, { recursive: true })]);
  await writeFile(path.join(cwd, ".omp", "herdr-delegator.json"), `${JSON.stringify({ version: 1, storage: { root: storageRoot } })}\n`);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.HERDR_PANE_ID = ORCH_PANE;
  await initializeRun({ operation: "init_run", track_id: TRACK, run_id: RUN, cwd });
  store = await DelegationStore.resolve(TRACK, RUN, cwd);

  // The sender is the run's born ORCH, attested through its pane and fact bridge.
  const issuedAt = Date.now();
  const nonce = `${issuedAt}.0123456789abcdef`;
  const sessionPath = path.join(root, `2026-09-28T00-00-00-000Z_${ORCH_SESSION}.jsonl`);
  await chmod(facts, 0o700);
  const factPath = path.join(facts, `${ORCH_SESSION}.json`);
  await writeFile(factPath, JSON.stringify({ version: 1, session_id: ORCH_SESSION, reported_session_path: sessionPath, pane_id: ORCH_PANE, issued_at: new Date(issuedAt).toISOString(), nonce }));
  await chmod(factPath, 0o600);
  const ref = { source: "herdr:omp", agent: "omp", kind: "path", value: sessionPath };
  bells = [];
  adapter = {
    getAgent: async () => ({ data: { agent: { pane_id: ORCH_PANE, session: ref } }, stdout: "" }),
    getPane: async () => ({ data: { pane: { pane_id: ORCH_PANE, session: ref, tokens: { "herdr-delegator-session": ORCH_SESSION, "herdr-delegator-attestation": nonce } } }, stdout: "" }),
    notify: async (_target: string, text: string) => { bells.push(text); return { delivery: "delivered" }; },
  } as unknown as HerdrAdapter;

  const now = new Date().toISOString();
  await store.mutate(5_000, (next) => {
    next.orch_births = [{ generation: 1, official_session_id: ORCH_SESSION, pane_id: ORCH_PANE, origin: "spawn", born_at: now }];
    next.responsibilities.wake = { key: "wake", worker_ids: ["w1"] };
    next.lanes.w1 = { worker_id: "w1", responsibility_key: "wake", lane_generation: 1, active_assignment_id: "A-001", queued_assignment_ids: [], state: "working", created_at: now, updated_at: now };
    next.assignments["A-001"] = { assignment_id: "A-001", responsibility_key: "wake", worker_id: "w1", state: "working", instructions_sha256: "a".repeat(64), created_at: now, updated_at: now };
  });
  const resolve = DelegationStore.resolve.bind(DelegationStore);
  const spy = spyOn(DelegationStore, "resolve").mockImplementation((trackId, runId) => resolve(trackId, runId, cwd));
  restoreResolve = () => spy.mockRestore();
});

afterEach(async () => {
  restoreResolve();
  ENV_KEYS.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; });
  await rm(root, { recursive: true, force: true });
});

async function wakeW1(report: string) {
  await writeFile(path.join(store.runPath, "a2a", "w1-report.md"), report);
  const result = await new CompositeTools(adapter).message({ action: "wake_worker", track_id: TRACK, run_id: RUN, to_worker_id: "w1", assignment_id: "A-001" });
  const journal = (await readFile(path.join(store.runPath, "a2a", "messages.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { delivery: string; warnings?: string[] });
  return { result, data: result.data as { delivery: string; warnings?: string[] }, logged: journal[journal.length - 1] };
}

describe("wake_worker at a completion boundary", () => {
  for (const status of ["completed", "failed"] as const) {
    test(`a report whose last A-001 block is ${status} reports after_completion and still rings`, async () => {
      const { result, data, logged } = await wakeW1(`## A-001\n\n[Assignment Completion: A-001]\nstatus: blocked\n\n[Assignment Completion: A-001]\nstatus: ${status}\n\n[ORCH Response]\nOne more thing.\n`);
      expect(result.ok).toBe(true);
      expect(result.effect).toBe("confirmed");
      expect(data.delivery).toBe("after_completion");
      expect(data.warnings?.some((warning) => warning.startsWith("after_completion:") && warning.includes("NEW assignment"))).toBe(true);
      expect(bells).toHaveLength(1);
      expect(logged.delivery).toBe("after_completion");
    });
  }

  test("a report without a settling block for the assignment is delivered as before", async () => {
    const { data, logged } = await wakeW1("## A-001\n\n[Assignment Completion: A-001]\nstatus: blocked\n\n[ORCH Decision Request]\nWhich option?\n\n[ORCH Response]\nOption B.\n");
    expect(data.delivery).toBe("delivered");
    expect(data.warnings ?? []).toEqual([]);
    expect(bells).toHaveLength(1);
    expect(logged.delivery).toBe("delivered");
  });
});
