import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { judgeRouting, routingRequest, type RoutingInput, type RoutingResult } from "../mcp/jev/routing";
import type { AskOptions, ChoiceQuestion } from "../mcp/jev/client";
import { DelegationStore } from "../mcp/registry";
import { CompositeTools } from "../mcp/tools";
import type { HerdrAdapter } from "../mcp/herdr-adapter";

const rules = await readFile(new URL("../skills/herdr-orch/references/delegation.md", import.meta.url), "utf8");
const envKeys = ["TYPESAFE_API_KEY", "JEV_API_KEY", "PI_CODING_AGENT_DIR"] as const;
let savedEnv: (string | undefined)[];
let root: string;
let input: RoutingInput;
let restoreStore: (() => void) | undefined;
let restoreFetch: (() => void) | undefined;

beforeEach(async () => {
  savedEnv = envKeys.map((key) => process.env[key]);
  root = await mkdtemp(path.join(tmpdir(), "herdr-routing-"));
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.TYPESAFE_API_KEY = "offline-fixture";
  delete process.env.JEV_API_KEY;
  await mkdir(path.join(root, "skills/herdr-orch/references"), { recursive: true });
  await writeFile(path.join(root, "skills/herdr-orch/references/delegation.md"), rules);
  input = {
    cwd: root,
    assignment: {
      assignment_id: "A-001", responsibility_key: "routing", profile: "task", label: "judge-routing",
      goal: "Implement the assignment routing module under a mature specification.",
      completion_conditions: ["Preflight returns an advisory judgment."],
      write_ownership: ["mcp/jev/routing.ts"], dependencies: ["Existing Jev client"], user_boundaries: ["Do not commit."],
    },
    lanes: [],
    resolved_lane: { responsibility_key: "routing", lane_reuse: false },
  };
});

afterEach(async () => {
  restoreStore?.(); restoreStore = undefined;
  restoreFetch?.(); restoreFetch = undefined;
  envKeys.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; });
  await rm(root, { recursive: true, force: true });
});

function fakeFetch(choices: Partial<Record<"route" | "reuse" | "profile", string>> = {}, confidence = 0.9, observe?: (state: unknown) => void): NonNullable<AskOptions["fetchImpl"]> {
  return (async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { state: unknown; questions: Record<string, ChoiceQuestion> };
    observe?.(request.state);
    const selected: Record<string, string> = { route: "responsibility-lane", reuse: "new-lane", profile: "task", ...choices };
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const keys = Object.keys(question.criteria);
      const probabilities = Object.fromEntries(keys.map((key) => [key, keys.length === 1 ? 1 : key === selected[id] ? 0.9 : 0.1 / (keys.length - 1)]));
      return [id, { type: "choice", choice: selected[id], confidence, probabilities }];
    }));
    return Response.json({ model: "offline-jev", answers });
  }) as NonNullable<AskOptions["fetchImpl"]>;
}

/** Exercise both preflight branches without a runtime adapter or registry writes. */
function preflight(registered: boolean) {
  const registry = { revision: 7, responsibilities: {}, lanes: {}, assignments: registered ? { "A-001": { worker_id: "w1", responsibility_key: "routing", instructions_sha256: "a".repeat(64), state: "completed" } } : {} };
  const store = {
    cwd: root, runPath: root,
    read: async () => registry,
    assignmentFile: async () => ({ assignment: input.assignment }),
    preflight: async () => ({ assignment: input.assignment, path: path.join(root, "A-001.md"), instructionsHash: "a".repeat(64) }),
    predictLane: async () => ({ worker_id: "w1", report_path: path.join(root, "w1-report.md"), lane_reuse: false }),
  } as unknown as DelegationStore;
  const storeSpy = spyOn(DelegationStore, "resolve").mockResolvedValue(store);
  restoreStore = () => storeSpy.mockRestore();
  const tools = new CompositeTools({} as HerdrAdapter);
  return tools.assignment({ action: "preflight", track_id: "routing-test", run_id: "r1", assignment_id: "A-001", responsibility_key: "routing" });
}

function verdict(result: RoutingResult) {
  if ("skipped" in result) throw new Error(`Unexpected skip: ${result.skipped}`);
  return result;
}

describe("assignment routing", () => {
  test("judge agrees with frontmatter without seeing the author's answers", async () => {
    const result = verdict(await judgeRouting(input, { fetchImpl: fakeFetch({}, 0.9, (state) => {
      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain("profile:");
      expect(serialized).not.toContain("responsibility_key:");
      if (!state || typeof state !== "object" || !("assignment" in state) || !state.assignment || typeof state.assignment !== "object") throw new Error("Missing judged assignment");
      const assignment = state.assignment;
      expect(Object.keys(assignment).sort()).toEqual(["dependencies", "goal", "user_boundaries", "write_ownership"]);
      expect(serialized).not.toContain("Preflight returns an advisory judgment.");
      expect("delegation_rules" in state ? state.delegation_rules : undefined).toBe(rules);
      expect(serialized).not.toContain("judge-routing");
    }) }));
    expect(result.agreement).toEqual({ profile: "agrees", reuse: "agrees" });
    expect(result.route.choice).toBe("responsibility-lane");
  });

  test("profile disagreement is advisory and preserves the registered preflight", async () => {
    const fetchImpl = fakeFetch({ profile: "slow" });
    expect(verdict(await judgeRouting(input, { fetchImpl })).agreement.profile).toBe("disagrees");
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    restoreFetch = () => fetchSpy.mockRestore();
    const result = await preflight(true);
    const data = result.data as { routing: RoutingResult; warnings: string[]; worker_id: string };
    expect(result.ok).toBe(true);
    expect(result.effect).toBe("none");
    expect(result.assignment?.state).toBe("completed");
    expect(data.worker_id).toBe("w1");
    expect(verdict(data.routing).agreement.profile).toBe("disagrees");
    expect(data.warnings.some((warning) => warning.includes("profile") && warning.includes("slow"))).toBe(true);
  });

  test("confidence 0.3 and the inclusive 0.35 boundary are undecided", async () => {
    for (const confidence of [0.3, 0.35]) {
      const result = verdict(await judgeRouting(input, { fetchImpl: fakeFetch({ profile: "slow" }, confidence) }));
      expect(result.agreement).toEqual({ profile: "undecided", reuse: "undecided" });
      expect(result.route.choice).toBe("undecided");
      expect(result.profile.choice).toBe("undecided");
      expect(result.profile.confidence).toBe(confidence);
      expect(result.profile.probabilities.slow).toBe(0.9);
    }
  });

  test("no key sets data.routing.skipped without refusing preflight or fetching", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("must not fetch"); });
    restoreFetch = () => fetchSpy.mockRestore();
    const result = await preflight(false);
    expect(result.ok).toBe(true);
    expect(result.effect).toBe("none");
    expect(result.registry_revision).toBe(7);
    const data = result.data;
    if (!data || typeof data !== "object" || !("routing" in data)) throw new Error("Missing routing");
    expect(data.routing).toEqual({ skipped: "no Jev key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("reuse compares the resolved live responsibility and excludes closed lanes", async () => {
    input.lanes = [
      { worker_id: "w1", responsibility_key: "routing", profile: "task", state: "idle", last_completed_assignment_id: "A-002", last_completed_label: "previous-routing" },
      { worker_id: "w2", responsibility_key: "retired", profile: "slow", state: "closed", last_completed_assignment_id: null, last_completed_label: null },
    ];
    input.resolved_lane.lane_reuse = true;
    const request = await routingRequest(input);
    expect(Object.keys(request.questions.reuse.criteria).sort()).toEqual(["lane:routing", "new-lane"]);
    expect(request.state.lanes.map((lane) => lane.worker_id)).toEqual(["w1", "w2"]);
    const result = verdict(await judgeRouting(input, { fetchImpl: fakeFetch({ reuse: "lane:routing" }) }));
    expect(result.agreement.reuse).toBe("agrees");
    expect(verdict(await judgeRouting(input, { fetchImpl: fakeFetch() })).agreement.reuse).toBe("disagrees");
  });

  test("rules are read at call time, whole and unedited; a missing profile table skips judgment", async () => {
    await routingRequest(input);
    await writeFile(path.join(root, "skills/herdr-orch/references/delegation.md"), rules.replace("## Profile selection", "## Removed profiles"));
    expect(await judgeRouting(input, { fetchImpl: fakeFetch() })).toEqual({ skipped: "delegation rules not found" });
  });

  test("oversized state is reported without truncating or sending it", async () => {
    input.assignment.goal = "x".repeat(200_000);
    let calls = 0;
    const fetchImpl = (async () => { calls++; throw new Error("must not fetch"); }) as typeof fetch;
    const result = await judgeRouting(input, { fetchImpl });
    expect("skipped" in result && result.skipped).toContain("Jev request over budget");
    expect(calls).toBe(0);
  });

  test("transport errors skip advisory routing without exposing response text", async () => {
    const fetchImpl = (async () => Response.json({ error: "private transport body" }, { status: 500 })) as typeof fetch;
    expect(await judgeRouting(input, { fetchImpl })).toEqual({ skipped: "routing judge unavailable" });
  });
});
