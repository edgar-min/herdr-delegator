import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideRoutingGate, registerRoutingGate } from "../io.github.edgar-min.herdr-delegator/extensions/lib/routing-gate";
import type { AskOptions, ChoiceQuestion } from "../mcp/jev/client";
import { judgeRouting, routingRequest, type RoutingInput, type RoutingVerdict } from "../mcp/jev/routing";

type Handler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;
const envKeys = ["TYPESAFE_API_KEY", "JEV_API_KEY", "PI_CODING_AGENT_DIR"] as const;
let savedEnv: (string | undefined)[];
let root: string;
let cwd: string;
let storage: string;
let runPath: string;
let runs: Record<string, object>;
let fetchCalls: number;
let debugMessages: string[];

beforeEach(async () => {
  savedEnv = envKeys.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(path.join(tmpdir(), "herdr-routing-gate-")));
  cwd = path.join(root, "project");
  storage = path.join(root, "storage");
  await mkdir(cwd);
  await mkdir(storage);
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.TYPESAFE_API_KEY = "offline-fixture";
  delete process.env.JEV_API_KEY;
  await writeFile(path.join(root, "herdr-delegator.json"), JSON.stringify({ version: 1, storage: { root: storage } }));
  runs = {};
  fetchCalls = 0;
  debugMessages = [];
  runPath = await addRun("r1");
});

afterEach(async () => {
  envKeys.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; });
  await rm(root, { recursive: true, force: true });
});

async function addRun(id: string, projectCwd = cwd) {
  const dir = path.join(storage, id);
  await mkdir(path.join(dir, "a2a"), { recursive: true });
  await writeFile(path.join(dir, "a2a", "delegation.json"), JSON.stringify({
    orch_births: [{ official_session_id: "old-S" }, { official_session_id: "S" }],
    lanes: { w1: { worker_id: "w1", responsibility_key: "routing", state: "idle", last_completed_assignment_id: "A-001" } },
  }));
  await writeFile(path.join(dir, "a2a", "herdr-workers.json"), JSON.stringify({ workers: { w1: { worker_id: "w1", selected_profile: "task" } } }));
  runs[`routing-test/${id}`] = { track_id: "routing-test", run_id: id, run_path: dir, cwd: projectCwd, state: "initialized", created_at: "now", updated_at: "now" };
  await writeFile(path.join(storage, "index.json"), JSON.stringify({ version: 1, runs }));
  return dir;
}

function fakeFetch(route = "responsibility-lane", confidence = 0.9, observe?: (state: Record<string, unknown>) => void): NonNullable<AskOptions["fetchImpl"]> {
  return (async (_url: unknown, init: RequestInit) => {
    fetchCalls++;
    const request = JSON.parse(String(init.body)) as { state: Record<string, unknown>; questions: Record<string, ChoiceQuestion> };
    observe?.(request.state);
    const selected: Record<string, string> = { route, reuse: "new-lane", profile: "task" };
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const keys = Object.keys(question.criteria);
      const probabilities = Object.fromEntries(keys.map((key) => [key, keys.length === 1 ? 1 : key === selected[id] ? 0.9 : 0.1 / (keys.length - 1)]));
      return [id, { type: "choice", choice: selected[id], confidence, probabilities }];
    }));
    return Response.json({ model: "offline-jev", answers });
  }) as NonNullable<AskOptions["fetchImpl"]>;
}

function captureHandler(fetchImpl = fakeFetch(), judge_timeout_ms?: number): Handler {
  let handler: Handler | undefined;
  const pi = {
    on: (name: string, callback: Handler) => { if (name === "tool_call") handler = callback; },
    logger: { debug: (message: string) => { debugMessages.push(message); } },
  } as unknown as ExtensionAPI;
  registerRoutingGate(pi, { fetchImpl, judge_timeout_ms });
  if (!handler) throw new Error("tool_call handler not registered");
  return handler;
}

function context(sessionId = "S", projectCwd = cwd): ExtensionContext {
  return { cwd: projectCwd, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
}

function taskEvent(contextText = "Implement the mature routing gate specification."): ToolCallEvent {
  return { type: "tool_call", toolCallId: "call-1", toolName: "task", input: { context: contextText, tasks: [{ name: "Hook", task: "Implement and verify the hook." }] } };
}

async function observations() {
  const text = await readFile(path.join(runPath, "a2a", "routing-gate.jsonl"), "utf8");
  return text.trimEnd().split("\n").map((line) => JSON.parse(line));
}

function verdict(choice: string): RoutingVerdict {
  const answer = { choice, confidence: 0.9, probabilities: { "orch-self": 0.05, "host-subagent": 0.05, "responsibility-lane": 0.9 } };
  return { model: "offline-jev", question_version: "2026-09-23.6", route: answer, reuse: answer, profile: answer, agreement: { profile: "agrees", reuse: "agrees" } };
}

describe("routing gate decision", () => {
  test("blocking routes explain the verdict, alternative and escape in order", () => {
    for (const [route, alternative] of [
      ["orch-self", "do this in your own session; a subagent cannot hold the judgment this needs"],
      ["responsibility-lane", "write a canonical assignment for a responsibility lane (herdr_assignment preflight, then add)"],
    ]) {
      const result = decideRoutingGate(verdict(route), undefined);
      expect(result.block).toBe(true);
      if (!result.block) throw new Error("Expected a refusal");
      expect(result.reason).toContain(`${route} with confidence 0.9`);
      expect(result.reason).toContain(JSON.stringify(verdict(route).route.probabilities));
      expect(result.reason).toContain(alternative);
      expect(result.reason.indexOf(alternative)).toBeGreaterThan(result.reason.indexOf("probabilities"));
      expect(result.reason.indexOf("routing-override:")).toBeGreaterThan(result.reason.indexOf(alternative));
      expect(result.reason).toContain("at least 20 characters");
      expect(result.reason.length).toBeLessThan(1200);
    }
  });

  test("permitted routes and skipped judgments allow, while override has a trimmed 20-character boundary", () => {
    for (const route of ["host-subagent", "undecided"]) {
      expect(decideRoutingGate(verdict(route), undefined)).toEqual({ block: false, why: `route:${route} confidence:0.9` });
    }
    expect(decideRoutingGate({ skipped: "no Jev key" }, undefined)).toEqual({ block: false, why: "no Jev key" });
    expect(decideRoutingGate(verdict("responsibility-lane"), "x".repeat(20))).toEqual({ block: false, why: "override" });
    expect(decideRoutingGate(verdict("responsibility-lane"), ` ${"x".repeat(19)} `).block).toBe(true);
    expect(decideRoutingGate({ skipped: "unavailable" }, "x".repeat(20))).toEqual({ block: false, why: "override" });
  });
});

describe("routing gate handler", () => {
  test("only the latest ORCH birth is gated, with canonical cwd resolution", async () => {
    const handler = captureHandler();
    for (const session of ["T", "old-S"]) expect(await handler(taskEvent(), context(session))).toBeUndefined();
    expect(fetchCalls).toBe(0);
    await expect(readFile(path.join(runPath, "a2a", "routing-gate.jsonl"))).rejects.toThrow();
    const alias = path.join(root, "project-alias");
    await symlink(cwd, alias);
    expect((await handler(taskEvent(), context("S", alias)))?.block).toBe(true);
    expect(fetchCalls).toBe(1);
    expect((await observations()).map((row) => row.session_id)).toEqual(["S"]);
  });

  test("ambiguous ORCH births across two runs allow without judgment", async () => {
    await addRun("r2");
    expect(await captureHandler()(taskEvent(), context())).toBeUndefined();
    expect(fetchCalls).toBe(0);
    await expect(readFile(path.join(runPath, "a2a", "routing-gate.jsonl"))).rejects.toThrow();
  });

  test("unreadable or shapeless registries and different project rows are skipped", async () => {
    const other = await addRun("r2");
    await writeFile(path.join(other, "a2a", "delegation.json"), "not JSON");
    const shapeless = await addRun("r3");
    await writeFile(path.join(shapeless, "a2a", "delegation.json"), "[]");
    await addRun("r4", root);
    expect((await captureHandler()(taskEvent(), context()))?.block).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  test("missing credentials and non-task tools perform no network request or log append", async () => {
    const handler = captureHandler();
    expect(await handler({ type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: "file" } }, context())).toBeUndefined();
    delete process.env.TYPESAFE_API_KEY;
    expect(await handler(taskEvent(), context())).toBeUndefined();
    expect(fetchCalls).toBe(0);
    await expect(readFile(path.join(runPath, "a2a", "routing-gate.jsonl"))).rejects.toThrow();
  });

  test("blocks lane and self routes, allows host and undecided routes, and appends exactly once per judgment", async () => {
    expect((await captureHandler()(taskEvent(), context()))?.block).toBe(true);
    expect((await captureHandler(fakeFetch("orch-self"))(taskEvent(), context()))?.reason).toContain("do this in your own session");
    expect(await captureHandler(fakeFetch("host-subagent"))(taskEvent(), context())).toBeUndefined();
    expect(await captureHandler(fakeFetch("responsibility-lane", 0.3))(taskEvent(), context())).toBeUndefined();
    const lines = await observations();
    expect(lines.map((line) => line.decision)).toEqual(["block", "block", "allow", "allow"]);
    expect(lines.map((line) => line.verdict.route.choice)).toEqual(["responsibility-lane", "orch-self", "host-subagent", "undecided"]);
    expect(lines.every((line) => line.verdict.question_version === "2026-09-23.6")).toBe(true);
    expect(fetchCalls).toBe(4);
  });

  test("a qualifying context override is judged, allowed and recorded; a short or task-body override is not", async () => {
    const handler = captureHandler();
    const ground = "This bounded lookup has no persistent responsibility.";
    expect(await handler(taskEvent(`routing-override: ${ground}\nDo the lookup.`), context())).toBeUndefined();
    expect((await handler(taskEvent(`routing-override: ${"x".repeat(19)}`), context()))?.block).toBe(true);
    const bodyOnly: ToolCallEvent = { type: "tool_call", toolCallId: "body-override", toolName: "task", input: { tasks: [{ task: `routing-override: ${ground}` }] } };
    expect((await handler(bodyOnly, context()))?.block).toBe(true);
    const lines = await observations();
    expect(lines.map((line) => line.decision)).toEqual(["override", "block", "block"]);
    expect(lines[0].override_ground).toBe(ground);
    expect(lines[0].why_or_reason).toBe("override");
    expect(lines[0].verdict.route.choice).toBe("responsibility-lane");
    expect(lines[2].override_ground).toBeUndefined();
    expect(fetchCalls).toBe(3);
  });

  test("the judged goal contains named tasks within the bound, with a matching log digest and lane projection", async () => {
    const event: ToolCallEvent = { type: "tool_call", toolCallId: "long-goal", toolName: "task", input: { context: "Context\nline", tasks: [{ name: "First", task: "one" }, { task: "two".repeat(2000) }] } };
    const goal = `Context\nline\n\nFirst: one\n\n${"two".repeat(2000)}`.slice(0, 4096);
    let judgedState: Record<string, unknown> | undefined;
    expect((await captureHandler(fakeFetch("responsibility-lane", 0.9, (state) => { judgedState = state; }))(event, context()))?.block).toBe(true);
    expect(judgedState?.assignment).toEqual({ goal, write_ownership: [], user_boundaries: [], dependencies: [] });
    expect(judgedState?.lanes).toEqual([{ worker_id: "w1", responsibility_key: "routing", profile: "task", state: "idle", last_completed_assignment_id: "A-001", last_completed_label: null }]);
    const [line] = await observations();
    expect(line.goal_sha256).toBe(createHash("sha256").update(goal).digest("hex"));
    expect(line.goal_head).toBe(goal.slice(0, 200).replace(/\s+/g, " "));
  });

  test("transport failures allow and log a skipped judgment without private error text", async () => {
    const fetchImpl = (async () => { throw new Error("private transport details"); }) as typeof fetch;
    expect(await captureHandler(fetchImpl)(taskEvent(), context())).toBeUndefined();
    const [line] = await observations();
    expect(line.verdict).toEqual({ skipped: "routing judge unavailable" });
    expect(line.decision).toBe("allow");
    expect(JSON.stringify(line)).not.toContain("private transport details");
  });

  test("an internal discovery error fails open and logs at debug level", async () => {
    await writeFile(path.join(storage, "index.json"), "invalid");
    expect(await captureHandler()(taskEvent(), context())).toBeUndefined();
    expect(fetchCalls).toBe(0);
    expect(debugMessages).toEqual(["herdr-delegator routing gate failed open after an internal error"]);
  });

  test("a log append failure preserves the blocking decision", async () => {
    await mkdir(path.join(runPath, "a2a", "routing-gate.jsonl"));
    expect((await captureHandler()(taskEvent(), context()))?.block).toBe(true);
    expect(debugMessages).toEqual(["herdr-delegator routing gate could not append its observation log"]);
  });

  test("a stalled judge times out, aborts its fetch and records one allowed call", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = ((_url: unknown, init: RequestInit) => { signal = init.signal; return new Promise<Response>(() => {}); }) as typeof fetch;
    expect(await captureHandler(fetchImpl, 100)(taskEvent(), context())).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    const lines = await observations();
    expect(lines.map((line) => [line.verdict, line.decision, line.why_or_reason])).toEqual([["timed_out", "allow", "timed_out"]]);
  });
});

test("host-subagent subject changes route framing only and uses the new judgment version", async () => {
  const input: RoutingInput = {
    cwd, assignment: { assignment_id: "A-999", responsibility_key: "host-subagent", profile: "task", goal: "Implement the hook.", completion_conditions: [], write_ownership: [], dependencies: [], user_boundaries: [] },
    lanes: [], resolved_lane: { responsibility_key: "host-subagent", lane_reuse: false },
  };
  const original = await routingRequest(input);
  const explicit = await routingRequest({ ...input, subject: "assignment" });
  const host = await routingRequest({ ...input, subject: "host-subagent-call" });
  expect(explicit).toEqual(original);
  expect(JSON.stringify(original.questions.route.instructions)).toContain("An assignment exists, so the ORCH already chose to delegate");
  expect(JSON.stringify(host.questions.route.instructions)).toContain("A host subagent call exists, so the ORCH already chose a one-shot subagent");
  expect(host.questions.reuse).toEqual(original.questions.reuse);
  expect(host.questions.profile).toEqual(original.questions.profile);
  const result = await judgeRouting({ ...input, subject: "host-subagent-call" }, { fetchImpl: fakeFetch() });
  if ("skipped" in result) throw new Error(result.skipped);
  expect(result.question_version).toBe("2026-09-23.6");
});
