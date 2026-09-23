import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { judgeRouting, routingRequest, type RoutingInput, type RoutingResult } from "../mcp/jev/routing";
import type { AskOptions, ChoiceQuestion } from "../mcp/jev/client";
import { DelegationStore } from "../mcp/registry";
import { CompositeTools } from "../mcp/tools";
import type { HerdrAdapter } from "../mcp/herdr-adapter";
import { z } from "zod";
import { herdrAssignmentInputShape, herdrAssignmentSchema, sha256, type DelegationRegistry } from "../mcp/contracts";

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

async function routeFixture(fetchImpl: NonNullable<AskOptions["fetchImpl"]>) {
  await mkdir(path.join(root, "a2a"));
  const registryPath = path.join(root, "a2a", "delegation.json");
  const registryBytes = JSON.stringify({
    revision: 7, responsibilities: {},
    assignments: { "A-001": { worker_id: "w1", responsibility_key: "routing", instructions_sha256: "a".repeat(64), state: "completed" } },
    lanes: {
      w1: { worker_id: "w1", responsibility_key: "routing", state: "idle", last_completed_assignment_id: "A-001" },
      w2: { worker_id: "w2", responsibility_key: "new-work", state: "idle" },
    },
  });
  await writeFile(registryPath, registryBytes);
  const registryBefore = await stat(registryPath);
  const store = {
    cwd: root, runPath: root,
    read: async () => JSON.parse(await readFile(registryPath, "utf8")) as DelegationRegistry,
    assignmentFile: async () => ({ assignment: input.assignment }),
  } as unknown as DelegationStore;
  const storeSpy = spyOn(DelegationStore, "resolve").mockResolvedValue(store);
  restoreStore = () => storeSpy.mockRestore();
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
  restoreFetch = () => fetchSpy.mockRestore();
  return {
    tools: new CompositeTools({} as HerdrAdapter),
    request: { action: "route" as const, track_id: "routing-test", run_id: "r1", goal: "Decide the direction.\nKeep ownership of this judgment." },
    registryPath, registryBytes, registryBefore, fetchSpy,
  };
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
    expect(result.question_version).toBe("2026-09-23.6");
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

  test("rules are the bundled document, read at call time whole and unedited, in any project cwd; a missing profile table skips judgment", async () => {
    // `root` is an empty temp project with no skills/ tree: the rules must not be looked for there.
    const { state } = await routingRequest(input);
    expect(state.delegation_rules).toBe(rules);
    const edited = path.join(root, "delegation.md");
    await writeFile(edited, rules.replace("## Profile selection", "## Removed profiles"));
    expect(await judgeRouting({ ...input, rules_path: edited }, { fetchImpl: fakeFetch() })).toEqual({ skipped: "delegation rules not found" });
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

describe("goal routing action", () => {
  test("orch-self advises before an assignment, records one sample and leaves the registry untouched", async () => {
    const fixture = await routeFixture(fakeFetch({ route: "orch-self" }));
    const result = await fixture.tools.assignment(herdrAssignmentSchema.parse({
      ...fixture.request, write_ownership: ["src/router.ts"], dependencies: [], user_boundaries: ["Do not commit."],
    }));
    expect(result.ok).toBe(true);
    expect(result.effect).toBe("none");
    const data = result.data as { routing: RoutingResult; next_step: string };
    expect(verdict(data.routing).route.choice).toBe("orch-self");
    expect(data.next_step.toLowerCase()).toContain("do this in your own session");
    const lines = (await readFile(path.join(root, "a2a", "routing-gate.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([{
      at: expect.any(String), session_id: null, tool: "route",
      goal_sha256: sha256(fixture.request.goal), goal_head: fixture.request.goal.replace(/\s+/g, " "),
      verdict: data.routing, decision: "advise", why_or_reason: data.next_step,
    }]);
    expect(await readFile(fixture.registryPath, "utf8")).toBe(fixture.registryBytes);
    expect((await stat(fixture.registryPath)).mtimeMs).toBe(fixture.registryBefore.mtimeMs);
    expect((await readdir(path.join(root, "a2a"))).sort()).toEqual(["delegation.json", "routing-gate.jsonl"]);
  });

  test("no Jev key advises reading the rules and deciding with a recorded ground, without fetching or logging", async () => {
    const fixture = await routeFixture(fakeFetch());
    delete process.env.TYPESAFE_API_KEY;
    const result = await fixture.tools.assignment(fixture.request);
    expect(result.ok).toBe(true);
    expect(result.effect).toBe("none");
    const data = result.data as { routing: RoutingResult; next_step: string };
    expect(data.routing).toEqual({ skipped: "no Jev key" });
    expect(data.next_step).toContain("skill://herdr-orch/references/delegation.md §Three routes");
    expect(data.next_step).toContain("decide yourself");
    expect(data.next_step).toContain("recording the ground in plan.md");
    expect(fixture.fetchSpy).not.toHaveBeenCalled();
    expect(await readdir(path.join(root, "a2a"))).toEqual(["delegation.json"]);
    expect(await readFile(fixture.registryPath, "utf8")).toBe(fixture.registryBytes);
  });

  test("lane, host and undecided verdicts give their alternative and each appends rather than replacing samples", async () => {
    const fixture = await routeFixture(fakeFetch());
    for (const [route, confidence, expected] of [
      ["responsibility-lane", 0.9, "canonical assignment and preflight"],
      ["host-subagent", 0.9, "host subagent; the routing gate will pass it"],
      ["responsibility-lane", 0.3, "decide yourself"],
    ] as const) {
      fixture.fetchSpy.mockImplementation(fakeFetch({ route }, confidence));
      const result = await fixture.tools.assignment(fixture.request);
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ next_step: expect.stringContaining(expected) });
    }
    const lines = (await readFile(path.join(root, "a2a", "routing-gate.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.verdict.route.choice, line.decision])).toEqual([
      ["responsibility-lane", "advise"], ["host-subagent", "advise"], ["undecided", "advise"],
    ]);
  });

  test("observation append failures do not change the advice", async () => {
    const fixture = await routeFixture(fakeFetch({ route: "orch-self" }));
    await mkdir(path.join(root, "a2a", "routing-gate.jsonl"));
    const result = await fixture.tools.assignment(fixture.request);
    expect(result.ok).toBe(true);
    expect(result.effect).toBe("none");
    expect(result.data).toMatchObject({ routing: { route: { choice: "orch-self" } } });
  });

  test("preflight and goal routing see identical lanes with completed-artifact fallbacks", async () => {
    const states: Array<{ lanes: unknown }> = [];
    const fixture = await routeFixture(fakeFetch({}, 0.9, (state) => { states.push(state as { lanes: unknown }); }));
    const routed = await fixture.tools.assignment(fixture.request);
    const preflighted = await fixture.tools.assignment({ action: "preflight", track_id: "routing-test", run_id: "r1", assignment_id: "A-001", responsibility_key: "routing" });
    expect(routed.ok).toBe(true);
    expect(preflighted.ok).toBe(true);
    expect(states.map((state) => state.lanes)).toEqual([0, 1].map(() => [
      { worker_id: "w1", responsibility_key: "routing", profile: "task", state: "idle", last_completed_assignment_id: "A-001", last_completed_label: "judge-routing" },
      { worker_id: "w2", responsibility_key: "new-work", profile: null, state: "idle", last_completed_assignment_id: null, last_completed_label: null },
    ]));
  });

  test("route schema accepts the published goal-only call and rejects unknown or cross-action fields", () => {
    const request = { action: "route", track_id: "routing-test", run_id: "r1", goal: "Choose who should execute this." };
    expect(z.object(herdrAssignmentInputShape).parse(request)).toEqual(request);
    expect(herdrAssignmentSchema.parse(request)).toEqual(request);
    for (const field of ["unknown", "assignment_id", "responsibility_key", "profile", "wait"]) {
      expect(herdrAssignmentSchema.safeParse({ ...request, [field]: "unexpected" }).success).toBe(false);
    }
    expect(herdrAssignmentSchema.safeParse({ ...request, goal: "" }).success).toBe(false);
    expect(herdrAssignmentSchema.safeParse({ ...request, goal: "x".repeat(4096) }).success).toBe(true);
    expect(herdrAssignmentSchema.safeParse({ ...request, goal: "x".repeat(4097) }).success).toBe(false);
    for (const field of ["write_ownership", "dependencies", "user_boundaries"]) {
      expect(herdrAssignmentSchema.safeParse({ ...request, [field]: [] }).success).toBe(true);
      expect(herdrAssignmentSchema.safeParse({ ...request, [field]: Array(64).fill("x".repeat(1000)) }).success).toBe(true);
      expect(herdrAssignmentSchema.safeParse({ ...request, [field]: Array(65).fill("x") }).success).toBe(false);
      expect(herdrAssignmentSchema.safeParse({ ...request, [field]: ["x".repeat(1001)] }).success).toBe(false);
      expect(herdrAssignmentSchema.safeParse({ ...request, [field]: [""] }).success).toBe(false);
    }
    expect(herdrAssignmentSchema.safeParse({ action: "preflight", track_id: "routing-test", run_id: "r1" }).success).toBe(false);
  });

  test("goal subject frames unwritten work without changing existing subjects or the other questions", async () => {
    const assignment = await routingRequest(input);
    const host = await routingRequest({ ...input, subject: "host-subagent-call" });
    const goal = await routingRequest({ ...input, subject: "goal" });
    const instructions = goal.questions.route.instructions as { note: string };
    expect(instructions.note).toBe("No assignment exists yet: the ORCH is deciding who will do this work before anything is written. Judge the work the goal demands, not who is asking. Use delegation_rules.");
    expect(JSON.stringify(assignment.questions.route.instructions)).toContain("An assignment exists, so the ORCH already chose to delegate");
    expect(JSON.stringify(host.questions.route.instructions)).toContain("A host subagent call exists, so the ORCH already chose a one-shot subagent");
    expect(goal.questions.reuse).toEqual(assignment.questions.reuse);
    expect(goal.questions.profile).toEqual(assignment.questions.profile);
    expect(verdict(await judgeRouting({ ...input, subject: "goal" }, { fetchImpl: fakeFetch() })).question_version).toBe("2026-09-23.6");
  });
});
