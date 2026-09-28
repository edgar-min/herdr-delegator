// `# Write ownership` is what the settlement audit compares a lane's changes
// against, and it can only compare file paths: a glob, a directory, or prose
// leaves that part of the lane unaudited. preflight refuses such a bullet with
// `ownership_unauditable` before the assignment ID is consumed.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeRun } from "../io.github.edgar-min.herdr-delegator/extensions/lib/track";
import type { HerdrAdapter } from "../mcp/herdr-adapter";
import { DelegationStore } from "../mcp/registry";
import { CompositeTools } from "../mcp/tools";

const TRACK = "ownership-track";
const RUN = "r1";
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "TYPESAFE_API_KEY", "JEV_API_KEY"] as const;
let savedEnv: (string | undefined)[];
let root: string;
let runPath: string;
let restoreResolve: () => void;

beforeEach(async () => {
  savedEnv = ENV_KEYS.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(path.join(tmpdir(), "assignment-ownership-")));
  const cwd = path.join(root, "project");
  const storageRoot = path.join(root, "store");
  await Promise.all([mkdir(path.join(cwd, ".omp"), { recursive: true }), mkdir(storageRoot), mkdir(path.join(root, "agent"))]);
  await writeFile(path.join(cwd, ".omp", "herdr-delegator.json"), `${JSON.stringify({ version: 1, storage: { root: storageRoot } })}\n`);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_API_KEY;
  await initializeRun({ operation: "init_run", track_id: TRACK, run_id: RUN, cwd });
  runPath = path.join(storageRoot, TRACK, RUN);
  const resolve = DelegationStore.resolve.bind(DelegationStore);
  const spy = spyOn(DelegationStore, "resolve").mockImplementation((trackId, runId) => resolve(trackId, runId, cwd));
  restoreResolve = () => spy.mockRestore();
});

afterEach(async () => {
  restoreResolve();
  ENV_KEYS.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; });
  await rm(root, { recursive: true, force: true });
});

async function preflight(ownership: string[]) {
  await mkdir(path.join(runPath, "a2a", "assignments"), { recursive: true });
  await writeFile(path.join(runPath, "a2a", "assignments", "A-001.md"), [
    "---", "assignment_id: A-001", "responsibility_key: ownership", "profile: task", "---", "",
    "# Goal", "", "Change the owned files.", "",
    "# Completion conditions", "", "- The owned files are changed.", "",
    "# Write ownership", "", ...ownership.map((bullet) => `- ${bullet}`), "",
    "# Dependencies", "", "- None.", "",
    "# User boundaries", "", "- Do not commit.", "",
  ].join("\n"));
  return new CompositeTools({} as HerdrAdapter).assignment({ action: "preflight", track_id: TRACK, run_id: RUN, assignment_id: "A-001", responsibility_key: "ownership" });
}

describe("herdr_assignment preflight write ownership", () => {
  for (const bullet of ["mcp/*.ts", "tests/", "the routing files"]) {
    test(`refuses ${JSON.stringify(bullet)} and quotes it`, async () => {
      const result = await preflight(["mcp/tools.ts", bullet]);
      expect(result.ok).toBe(false);
      expect(result.effect).toBe("none");
      expect(result.error?.code).toBe("ownership_unauditable");
      expect(result.error?.phase).toBe("validate");
      expect(result.error?.message).toContain(JSON.stringify(`- ${bullet}`));
      expect(result.error?.message).not.toContain("mcp/tools.ts");
      expect(result.error?.recovery).toContain("one file path per bullet");
    });
  }

  test("accepts file paths, bare or backticked", async () => {
    const result = await preflight(["mcp/tools.ts", "`tests/assignment-ownership.test.ts`"]);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ already_registered: false, write_ownership: 2 });
  });
});
