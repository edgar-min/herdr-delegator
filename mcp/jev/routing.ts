import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssignmentArtifact, WorkerLaneRecord } from "../contracts";
import { apiKey, ask, assertBudget, BudgetExceeded, type AskOptions, type ChoiceAnswer, type ChoiceQuestion } from "./client";

const QUESTION_VERSION = "2026-09-23.6";
const UNDECIDED_CONFIDENCE = 0.35;

export type RoutingLane = Pick<WorkerLaneRecord, "worker_id" | "responsibility_key" | "state"> & {
  profile: string | null;
  last_completed_assignment_id: string | null;
  last_completed_label: string | null;
};
export type RoutingInput = {
  cwd: string;
  assignment: AssignmentArtifact;
  lanes: RoutingLane[];
  resolved_lane: { responsibility_key: string; lane_reuse: boolean };
  subject?: "assignment" | "host-subagent-call" | "goal";
  /** Test seam only: the rules document to judge against instead of the bundled one. */
  rules_path?: string;
};
type RoutingAnswer = Pick<ChoiceAnswer, "choice" | "confidence" | "probabilities">;
type Agreement = "agrees" | "disagrees" | "undecided";
export type RoutingVerdict = {
  model: string;
  question_version: string;
  route: RoutingAnswer;
  reuse: RoutingAnswer;
  profile: RoutingAnswer;
  agreement: { profile: Agreement; reuse: Agreement };
};
export type RoutingResult = RoutingVerdict | { skipped: string };

function section(text: string, heading: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trimEnd();
}

/** The bundled rules document, resolved from this package: the judge must work in any project, not only in this repository's own tree (4.0.0 read it from the project cwd, so preflight routing was skipped everywhere but this repository). */
export const DELEGATION_RULES_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills/herdr-orch/references/delegation.md");

/**
 * Read the single source of delegation rules anew for each preflight: the whole
 * file, unedited, so the judge sees exactly what the ORCH would. The route
 * criteria are the Signal cells of the Three routes table, verbatim, grouped
 * by the route each row names; the profile criteria are the intent cells of
 * the Profile selection table. Measured on this run's own assignments plus
 * three synthetic goals (tests/fixtures/routing): 7/7 with this wording, 0/4
 * with the earlier "first matching row" lookup.
 */
export async function routingRequest(input: RoutingInput) {
  const text = await readFile(input.rules_path ?? DELEGATION_RULES_PATH, "utf8");
  const profiles = section(text, "Profile selection");
  if (!profiles) throw new Error("delegation rules not found");
  const profileCriteria: Record<string, string> = {};
  for (const line of profiles.split("\n")) {
    const row = line.match(/^\|\s*`(default|task|slow)`\s*\|[^|]*\|\s*(.*?)\s*\|\s*$/);
    if (row) profileCriteria[row[1]] = row[2];
  }
  if (["default", "task", "slow"].some((profile) => !profileCriteria[profile])) throw new Error("delegation rules not found");
  const routeSignals: Record<"orch-self" | "host-subagent" | "responsibility-lane", string[]> = { "orch-self": [], "host-subagent": [], "responsibility-lane": [] };
  for (const line of text.split("\n")) {
    const row = line.match(/^\|\s*(.+?)\s*\|\s*\*\*(Yourself|Host subagent|Responsibility lane)\*\*.*?\|/);
    if (!row) continue;
    routeSignals[row[2] === "Yourself" ? "orch-self" : row[2] === "Host subagent" ? "host-subagent" : "responsibility-lane"].push(row[1]);
  }
  if (Object.values(routeSignals).some((signals) => signals.length === 0)) throw new Error("delegation rules not found");
  const reuseCriteria: Record<string, string> = {};
  for (const lane of input.lanes) {
    if (lane.state !== "closed" && lane.state !== "failed") {
      reuseCriteria[`lane:${lane.responsibility_key}`] = `An existing live lane for ${lane.responsibility_key} already holds the responsibility this assignment continues.`;
    }
  }
  reuseCriteria["new-lane"] = "No existing live lane holds this responsibility; a new lane would be needed.";
  const { goal, write_ownership, user_boundaries, dependencies } = input.assignment;
  const state = {
    delegation_rules: text,
    // The author's profile and responsibility answers never travel; the goal and
    // the three bounding sections are what the judge routes on.
    assignment: { goal, write_ownership, user_boundaries, dependencies },
    lanes: input.lanes.map(({ worker_id, responsibility_key, profile, state, last_completed_assignment_id, last_completed_label }) => ({ worker_id, responsibility_key, profile, state, last_completed_assignment_id, last_completed_label })),
  };
  const questions: Record<"route" | "reuse" | "profile", ChoiceQuestion> = {
    route: {
      type: "choice",
      instructions: {
        ask: "Which executor is the most suitable to achieve this assignment's goal: the ORCH itself, a one-shot host subagent, or a persistent responsibility lane?",
        note: input.subject === "goal"
          ? "No assignment exists yet: the ORCH is deciding who will do this work before anything is written. Judge the work the goal demands, not who is asking. Use delegation_rules."
          : input.subject === "host-subagent-call"
          ? "A host subagent call exists, so the ORCH already chose a one-shot subagent; answering responsibility-lane means an assignment should be written for a persistent lane instead, and orch-self means the ORCH should do this work in its own session. Judge the work the goal demands, not the author who wrote the goal. Use delegation_rules."
          : "An assignment exists, so the ORCH already chose to delegate; answering orch-self means this assignment should not have been written and the ORCH should do the work in its own session instead. Judge the work the goal demands, not the author who wrote the goal. Use delegation_rules.",
        answer_with: "the most suitable executor",
      },
      criteria: Object.fromEntries(Object.entries(routeSignals).map(([route, signals]) => [route, signals.join(" — or — ")])),
    },
    reuse: {
      type: "choice",
      instructions: "Which existing live lane already holds the responsibility this assignment continues, or none? Answer independently of route: if a responsibility lane were used, which should hold it?",
      criteria: reuseCriteria,
    },
    profile: {
      type: "choice",
      instructions: "Which profile fits the assignment under delegation_rules Profile selection? Judge specification maturity and cost of error independently of route.",
      criteria: profileCriteria,
    },
  };
  return { state, questions };
}

/** Advisory only: errors are explicit skips, never a preflight refusal. */
export async function judgeRouting(input: RoutingInput, options: AskOptions = {}): Promise<RoutingResult> {
  try { apiKey(); }
  catch { return { skipped: "no Jev key" }; }
  try {
    const { state, questions } = await routingRequest(input);
    assertBudget(state, questions);
    const response = await ask(state, questions, options);
    const answer = (id: "route" | "reuse" | "profile"): RoutingAnswer => {
      const value = response.answers[id];
      if (value.type !== "choice" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 || !(value.choice in questions[id].criteria)) throw new Error("invalid routing answer");
      return { choice: value.confidence <= UNDECIDED_CONFIDENCE ? "undecided" : value.choice, confidence: value.confidence, probabilities: value.probabilities };
    };
    const route = answer("route");
    const reuse = answer("reuse");
    const profile = answer("profile");
    const agreement = (value: RoutingAnswer, expected: string): Agreement => value.confidence <= UNDECIDED_CONFIDENCE ? "undecided" : value.choice === expected ? "agrees" : "disagrees";
    return {
      model: response.model,
      question_version: QUESTION_VERSION,
      route, reuse, profile,
      agreement: {
        profile: agreement(profile, input.assignment.profile),
        reuse: agreement(reuse, input.resolved_lane.lane_reuse ? `lane:${input.resolved_lane.responsibility_key}` : "new-lane"),
      },
    };
  } catch (error) {
    if (error instanceof BudgetExceeded) return { skipped: error.message };
    if (error instanceof Error && (error.message === "delegation rules not found" || ("code" in error && error.code === "ENOENT"))) return { skipped: "delegation rules not found" };
    // Do not copy transport response bodies or credential-bearing errors into a tool result.
    return { skipped: "routing judge unavailable" };
  }
}
