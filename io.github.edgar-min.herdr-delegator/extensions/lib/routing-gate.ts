import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { MAX_ASSIGNMENT_GOAL } from "../../../mcp/contracts";
import { apiKey, type AskOptions } from "../../../mcp/jev/client";
import { judgeRouting, type RoutingInput, type RoutingLane, type RoutingResult } from "../../../mcp/jev/routing";
import { loadDelegatorConfig, readRunIndex, storageRootFromConfig } from "./config";
import { isObject } from "./contracts";

export type RoutingGateOptions = AskOptions & { judge_timeout_ms?: number };

type GateDecision = { block: false; why: string } | { block: true; reason: string };

export function decideRoutingGate(verdict: RoutingResult, override: string | undefined): GateDecision {
  if (override && override.trim().length >= 20) return { block: false, why: "override" };
  if ("skipped" in verdict) return { block: false, why: verdict.skipped };
  const { choice, confidence, probabilities } = verdict.route;
  if (choice === "host-subagent" || choice === "undecided") return { block: false, why: `route:${choice} confidence:${confidence}` };
  if (choice !== "orch-self" && choice !== "responsibility-lane") return { block: false, why: "unknown route" };
  const alternative = choice === "responsibility-lane"
    ? "write a canonical assignment for a responsibility lane (herdr_assignment preflight, then add)"
    : "do this in your own session; a subagent cannot hold the judgment this needs";
  return {
    block: true,
    reason: `The routing judge routed this work to ${choice} with confidence ${confidence} and route probabilities ${JSON.stringify(probabilities)}. Instead, ${alternative}. If you judge the verdict wrong, resubmit the identical call with a line \`routing-override: <one-sentence ground>\` (at least 20 characters) at the top of the task's \`context\`; the override and its ground are recorded in the run's routing-gate log.`,
  };
}

async function readObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return isObject(value) ? value : undefined;
  } catch { return undefined; }
}

async function resolveOrch(cwd: string, sessionId: string) {
  const { config } = await loadDelegatorConfig(undefined, cwd);
  const storageRoot = await storageRootFromConfig(config, false);
  const index = await readRunIndex(path.join(storageRoot, "index.json"));
  let match: { runPath: string; registry: Record<string, unknown> } | undefined;
  for (const row of Object.values(index.runs)) {
    if (row.cwd !== cwd) continue;
    const registry = await readObject(path.join(row.run_path, "a2a", "delegation.json"));
    if (!registry || !Array.isArray(registry.orch_births)) continue;
    const latest = registry.orch_births.at(-1);
    if (!isObject(latest) || latest.official_session_id !== sessionId) continue;
    if (match) return undefined;
    match = { runPath: row.run_path, registry };
  }
  return match;
}

async function routingLanes(runPath: string, registry: Record<string, unknown>): Promise<RoutingLane[]> {
  const lifecycle = await readObject(path.join(runPath, "a2a", "herdr-workers.json"));
  const profiles = new Map<string, string>();
  for (const worker of Object.values(isObject(lifecycle?.workers) ? lifecycle.workers : {})) {
    if (isObject(worker) && typeof worker.worker_id === "string" && typeof worker.selected_profile === "string") {
      profiles.set(worker.worker_id, worker.selected_profile);
    }
  }
  const lanes: RoutingLane[] = [];
  for (const lane of Object.values(isObject(registry.lanes) ? registry.lanes : {})) {
    if (!isObject(lane) || typeof lane.worker_id !== "string" || typeof lane.responsibility_key !== "string" || typeof lane.state !== "string") continue;
    lanes.push({
      worker_id: lane.worker_id,
      responsibility_key: lane.responsibility_key,
      profile: profiles.get(lane.worker_id) ?? null,
      state: lane.state as RoutingLane["state"],
      last_completed_assignment_id: typeof lane.last_completed_assignment_id === "string" ? lane.last_completed_assignment_id : null,
      last_completed_label: null,
    });
  }
  return lanes;
}

async function boundedJudge(input: RoutingInput, options: AskOptions, timeoutMs: number): Promise<RoutingResult | "timed_out"> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      judgeRouting(input, { ...options, signal }),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => { resolve("timed_out"); controller.abort(); }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function registerRoutingGate(pi: ExtensionAPI, { judge_timeout_ms = 20_000, ...options }: RoutingGateOptions = {}): void {
  // Never copy credential-bearing exceptions or transport response bodies to logs.
  const debug = (message: string) => { try { pi.logger.debug(message); } catch { /* Logging must also fail open. */ } };
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task") return undefined;
    try {
      const cwd = await realpath(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) return undefined;
      const run = await resolveOrch(cwd, sessionId);
      if (!run) return undefined;
      try { apiKey(); } catch { return undefined; }
      const input = event.input as Record<string, unknown>;
      const context = typeof input.context === "string" ? input.context : "";
      const parts = [context];
      for (const task of Array.isArray(input.tasks) ? input.tasks : []) {
        if (isObject(task) && typeof task.task === "string") {
          parts.push(typeof task.name === "string" ? `${task.name}: ${task.task}` : task.task);
        }
      }
      const goal = parts.filter(Boolean).join("\n\n").slice(0, MAX_ASSIGNMENT_GOAL);
      const grounds = Array.from(context.matchAll(/^\s*routing-override:[ \t]*(.*)$/gm), (match) => match[1].trim());
      const override = grounds.find((ground) => ground.length >= 20) ?? grounds[0];
      const verdict = await boundedJudge({
        cwd,
        subject: "host-subagent-call",
        assignment: {
          assignment_id: "A-999", responsibility_key: "host-subagent", profile: "task", goal,
          completion_conditions: [], write_ownership: [], dependencies: [], user_boundaries: [],
        },
        lanes: await routingLanes(run.runPath, run.registry),
        resolved_lane: { responsibility_key: "host-subagent", lane_reuse: false },
      }, options, judge_timeout_ms);
      const decision = decideRoutingGate(verdict === "timed_out" ? { skipped: "timed_out" } : verdict, override);
      try {
        await appendFile(path.join(run.runPath, "a2a", "routing-gate.jsonl"), `${JSON.stringify({
          at: new Date().toISOString(), session_id: sessionId, tool: "task",
          goal_sha256: createHash("sha256").update(goal).digest("hex"),
          goal_head: goal.slice(0, 200).replace(/\s+/g, " "),
          verdict,
          decision: decision.block ? "block" : decision.why === "override" ? "override" : "allow",
          why_or_reason: decision.block ? decision.reason : decision.why,
          ...(override !== undefined ? { override_ground: override } : {}),
        })}\n`, { flag: "a" });
      } catch { debug("herdr-delegator routing gate could not append its observation log"); }
      return decision.block ? { block: true, reason: decision.reason } : undefined;
    } catch {
      debug("herdr-delegator routing gate failed open after an internal error");
      return undefined;
    }
  });
}
