// A lane report is append-only. Every settle observation (the path wait, the
// settlement sweep and worker inspect share) records the report's byte length
// on the lane, and a smaller length at a later observation is a
// `report_clobbered` warning — once, never a refusal.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeRun } from "../io.github.edgar-min.herdr-delegator/extensions/lib/track";
import { DelegationStore } from "../mcp/registry";
import { settleIfReported } from "../mcp/tools";

const TRACK = "clobber-track";
const RUN = "r1";
let savedAgentDir: string | undefined;
let root: string;
let store: DelegationStore;
let reportPath: string;

beforeEach(async () => {
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  root = await realpath(await mkdtemp(path.join(tmpdir(), "report-clobber-")));
  const cwd = path.join(root, "project");
  const storageRoot = path.join(root, "store");
  await Promise.all([mkdir(path.join(cwd, ".omp"), { recursive: true }), mkdir(storageRoot), mkdir(path.join(root, "agent"))]);
  await writeFile(path.join(cwd, ".omp", "herdr-delegator.json"), `${JSON.stringify({ version: 1, storage: { root: storageRoot } })}\n`);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  await initializeRun({ operation: "init_run", track_id: TRACK, run_id: RUN, cwd });
  store = await DelegationStore.resolve(TRACK, RUN, cwd);
  reportPath = path.join(store.runPath, "a2a", "w1-report.md");
  const now = new Date().toISOString();
  await store.mutate(5_000, (next) => {
    next.responsibilities.clobber = { key: "clobber", worker_ids: ["w1"] };
    next.lanes.w1 = { worker_id: "w1", responsibility_key: "clobber", lane_generation: 1, active_assignment_id: "A-001", queued_assignment_ids: [], state: "working", state_change_seq: 1, created_at: now, updated_at: now };
    next.assignments["A-001"] = { assignment_id: "A-001", responsibility_key: "clobber", worker_id: "w1", state: "working", instructions_sha256: "a".repeat(64), created_at: now, updated_at: now };
  });
});

afterEach(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await rm(root, { recursive: true, force: true });
});

async function observe(): Promise<string[]> {
  const warnings: string[] = [];
  const registry = await store.read();
  await settleIfReported(store, registry, registry.lanes.w1, registry.assignments["A-001"], warnings);
  return warnings.filter((warning) => warning.startsWith("report_clobbered"));
}

describe("lane report clobber detection", () => {
  test("a grown report warns nothing and its length is recorded", async () => {
    await writeFile(reportPath, "## A-001\n\n[ORCH Response]\nUse option B.\n");
    expect(await observe()).toEqual([]);
    await appendFile(reportPath, "\nEvidence: the test passes.\n");
    expect(await observe()).toEqual([]);
    expect((await store.read()).lanes.w1.report_bytes).toBe(Buffer.byteLength("## A-001\n\n[ORCH Response]\nUse option B.\n\nEvidence: the test passes.\n"));
  });

  test("a shrunk report warns once with both lengths, then records the smaller length", async () => {
    await writeFile(reportPath, "## A-001\n\n[ORCH Response]\nUse option B.\n");
    expect(await observe()).toEqual([]);
    await writeFile(reportPath, "## A-001\n");
    const warned = await observe();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("is 9 bytes, smaller than the 40 bytes");
    expect(await observe()).toEqual([]);
  });
});
