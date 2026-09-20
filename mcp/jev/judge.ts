// judge: moment judgments over a delegation run's own artifacts. This is the only file of the module that knows
// the run structure; client/chunk/questions/log stay generic. judge is read-only — it never writes the registry,
// a lane report, or an assignment — and its output is advisory: the orchestrator judges.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ask, assertBudget, BudgetExceeded, estimateTokens, REQUEST_TOKENS, SAFETY_MARGIN, STATE_PLUS_LONGEST_TOKENS, type AskOptions, type Question } from "./client.js";
import { jevConfig } from "./config.js";
import { chunk } from "./chunk.js";
import { append, requestId, type DecisionRow } from "./log.js";
import { AUTHORING_SCORES, ESCALATION_RUNGS, QUESTION_VERSION, SETTLEMENT_ACTIONS, authoringQuestions, escalateQuestions, intakeQuestions, planQuestions, settlementQuestions } from "./questions.js";
import { DelegationStore } from "../registry";
import type { AssignmentArtifact, AssignmentRecord } from "../contracts";
import { classifyOwnershipDeclarations, loadDelegatorConfig } from "../../io.github.edgar-min.herdr-delegator/extensions/lib/config";

export const ADVISORY = "Advisory only: the ORCH judges.";
/** The `evidence` field is a second, separately asked question — never a rationalization of the first one. */
export const EVIDENCE_NOTE = "evidence is a paragraph the model selected in a separate question, not its reasoning about the condition.";

const STATE_BUDGET = Math.floor(STATE_PLUS_LONGEST_TOKENS * (1 - SAFETY_MARGIN)) - 200;
const TOTAL_BUDGET = Math.floor(REQUEST_TOKENS * (1 - SAFETY_MARGIN));
/** A Choice over paragraph indices is one key per paragraph; keep the key set bounded by merging adjacent ones. */
const MAX_PARAGRAPHS = 254;
const MAX_EXCERPT_LINES = 3;

export type Unevaluated = { path: string; range?: { start: number; end: number }; reason: string };

/**
 * The two knobs the moments need. `hint_min_p` comes from the `jev` configuration block through the one config
 * module; `score_min` is a property of the four-level Score scale itself, not a deployment setting, so it stays
 * in code. Both only pick the one-line next action — neither ever truncates a result.
 */
export type Thresholds = { hint_min_p: number; score_min: number };
const SCORE_MIN = 2;

export function thresholds(cwd: string = process.cwd()): Thresholds {
  return { hint_min_p: jevConfig(cwd).hint_min_p, score_min: SCORE_MIN };
}

/**
 * A moment whose state is one bounded document pair either fits the documented request or it does not; there is
 * no partial judgment to fall back on, because dropping half a plan would silently change what was judged. The
 * budget is therefore checked before the request and reported as its own error naming the moment.
 */
function assertMomentBudget(moment: string, state: unknown, questions: Record<string, Question>): void {
  try {
    assertBudget(state, questions);
  } catch (error: unknown) {
    if (error instanceof BudgetExceeded) throw new Error(`judge ${moment}: the state does not fit the request budget (${error.message}). Nothing was truncated; shorten the input document instead.`);
    throw error;
  }
}

const BUILTIN_PROFILES: Record<string, string> = {
  default: "General-purpose lane for scoped execution and document work.",
  task: "Implementation lane for code, refactors, and integration against a mature specification.",
  slow: "Deep-reasoning lane for review, audits, and design forks rather than artifact implementation.",
};

/** Configured worker profiles as {name: intent}; the built-in three when the configuration names none. */
export async function workerProfiles(runPath: string | undefined, cwd: string): Promise<Record<string, string>> {
  let configured: Record<string, { intent?: string }> = {};
  try {
    configured = (await loadDelegatorConfig(runPath, cwd)).config.worker_profiles;
  } catch {
    return { ...BUILTIN_PROFILES };
  }
  const names = Object.keys(configured);
  if (names.length === 0) return { ...BUILTIN_PROFILES };
  const profiles: Record<string, string> = {};
  for (const name of names) profiles[name] = configured[name].intent ?? BUILTIN_PROFILES[name] ?? `Worker profile ${name}; the configuration states no intent for it.`;
  return profiles;
}

// ---------------------------------------------------------------- authoring

export type AuthoringCoordinates = { track_id: string; run_id: string; assignment_id: string };
export type AuthoringInput = AuthoringCoordinates | { file: string };

export type ScoreRow = { id: string; label: string; score: number; probabilities: Record<string, number> };
export type AuthoringOutput = {
  moment: "authoring";
  /** The calibration request id of this judgment: what `herdr_jev log outcome` records the observed outcome against. */
  request_id: string;
  source: string;
  assignment: { assignment_id: string; responsibility_key: string; profile: string; label?: string };
  scores: ScoreRow[];
  conditions: { index: number; text: string; p_observable: number }[];
  maturity: number;
  profile: { choice: string; probabilities: Record<string, number>; declared: string; agrees: boolean };
  next_action: string;
  advisory: string;
  thresholds: Thresholds;
  requests: number;
  input_tokens: number;
  model: string;
};

/**
 * A draft assignment that no registry has accepted yet. Deliberately lenient: this reader exists to judge a file
 * BEFORE the canonical parser would accept it, so it reports what it can see instead of refusing. A registered
 * assignment is never read here — `DelegationStore.preflight` parses that one.
 */
function readDraftAssignment(file: string): AssignmentArtifact {
  const text = readFileSync(file, "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const field = (key: string): string | undefined => new RegExp(`^${key}: (.+)$`, "m").exec(front?.[1] ?? "")?.[1];
  const body = text.slice(front ? front[0].length : 0);
  const sections = new Map<string, string>();
  for (const section of body.split(/\n(?=# )/)) {
    const heading = /^# (.+)$/m.exec(section);
    if (heading) sections.set(heading[1].trim(), section.slice(heading[0].length).trim());
  }
  const bullets = (heading: string): string[] =>
    (sections.get(heading) ?? "").split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
  return {
    assignment_id: field("assignment_id") ?? path.basename(file, ".md"),
    responsibility_key: field("responsibility_key") ?? "(undeclared)",
    profile: field("profile") ?? "(undeclared)",
    ...(field("label") ? { label: field("label") } : {}),
    goal: sections.get("Goal") ?? "",
    completion_conditions: bullets("Completion conditions"),
    write_ownership: bullets("Write ownership"),
    dependencies: bullets("Dependencies"),
    user_boundaries: bullets("User boundaries"),
  };
}

/** The registered artifact at a coordinate, parsed by the canonical parser. `preflight` mutates nothing. */
async function registeredAssignment(store: DelegationStore, assignmentId: string): Promise<{ artifact: AssignmentArtifact; record: AssignmentRecord; source: string }> {
  const registry = await store.read();
  const record = registry.assignments[assignmentId];
  if (!record) throw new Error(`assignment ${assignmentId} is not in the run registry at ${store.runPath}`);
  const file = await store.preflight(assignmentId, record.responsibility_key);
  return { artifact: file.assignment, record, source: file.path };
}

export async function judgeAuthoring(input: AuthoringInput, options: AskOptions = {}): Promise<AuthoringOutput> {
  let artifact: AssignmentArtifact;
  let source: string;
  let runPath: string | undefined;
  let cwd = process.cwd();
  if ("file" in input) {
    source = path.resolve(input.file);
    artifact = readDraftAssignment(source);
  } else {
    const store = await DelegationStore.resolve(input.track_id, input.run_id);
    const registered = await registeredAssignment(store, input.assignment_id);
    artifact = registered.artifact;
    source = registered.source;
    runPath = store.runPath;
    cwd = store.cwd;
  }

  const conditions = artifact.completion_conditions.map((text, index) => ({ index, text }));
  const profiles = await workerProfiles(runPath, cwd);
  const state = {
    assignment: {
      assignment_id: artifact.assignment_id,
      responsibility_key: artifact.responsibility_key,
      profile: artifact.profile,
      ...(artifact.label ? { label: artifact.label } : {}),
      goal: artifact.goal,
      write_ownership: artifact.write_ownership,
      dependencies: artifact.dependencies,
      user_boundaries: artifact.user_boundaries,
    },
    conditions,
  };
  const questions = authoringQuestions(conditions.length, profiles);
  // Configured model for the working directory this judgment belongs to; an
  // explicit AskOptions.model still wins because `options` is spread last.
  const response = await ask(state, questions, { model: jevConfig(cwd).model, ...options });

  const scores: ScoreRow[] = [];
  const rows: DecisionRow[] = [];
  const rid = requestId();
  const ts = new Date().toISOString();
  const row = (question_id: string, target: string, extra: Partial<DecisionRow>): void => {
    rows.push({ ts, event: "decision", request_id: rid, tool: "judge", stage: "authoring", question_id, question_version: QUESTION_VERSION, model: response.model, target, ...extra });
  };
  for (const { id, label } of AUTHORING_SCORES) {
    const answer = response.answers[id];
    if (answer.type !== "score") continue;
    scores.push({ id, label, score: answer.score, probabilities: answer.probabilities });
    row(id, `${artifact.assignment_id}:assignment`, { score: answer.score });
  }
  const conditionRows = conditions.map(({ index, text }) => {
    const answer = response.answers[`cond_${index}`];
    const p = answer.type === "noul" ? answer.noul : 0;
    row("cond", `${artifact.assignment_id}:conditions[${index}]`, { probability: p });
    return { index, text, p_observable: p };
  });
  const maturityAnswer = response.answers.maturity;
  const maturity = maturityAnswer.type === "noul" ? maturityAnswer.noul : 0;
  row("maturity", `${artifact.assignment_id}:assignment`, { probability: maturity });
  const profileAnswer = response.answers.profile;
  const profile = profileAnswer.type === "choice"
    ? { choice: profileAnswer.choice, probabilities: profileAnswer.probabilities, declared: artifact.profile, agrees: profileAnswer.choice === artifact.profile }
    : { choice: artifact.profile, probabilities: {}, declared: artifact.profile, agrees: true };
  row("profile", `${artifact.assignment_id}:profile`, { chosen: profile.choice, probability: profile.probabilities[profile.choice] });
  append(rows);

  const limits = thresholds(cwd);
  const weakest = conditionRows.filter((c) => c.p_observable < limits.hint_min_p).map((c) => c.index);
  const lowScore = scores.filter((s) => s.score < limits.score_min).map((s) => s.id);
  const next_action = weakest.length
    ? `Rewrite completion condition(s) ${weakest.join(", ")} so they name something observable, then dispatch.`
    : maturity < limits.hint_min_p
      ? `Mature the specification before dispatch: the assignment still leaves a design decision open (p=${maturity.toFixed(2)}).`
      : lowScore.length
        ? `Tighten the assignment text: ${lowScore.join(", ")} scored below ${limits.score_min} of 3.`
        : profile.agrees
          ? "Dispatch as written."
          : `Reconsider the profile: the questions favor ${profile.choice} over the declared ${profile.declared}.`;

  return {
    moment: "authoring",
    request_id: rid,
    source,
    assignment: { assignment_id: artifact.assignment_id, responsibility_key: artifact.responsibility_key, profile: artifact.profile, ...(artifact.label ? { label: artifact.label } : {}) },
    scores,
    conditions: conditionRows,
    maturity,
    profile,
    next_action,
    advisory: ADVISORY,
    thresholds: limits,
    requests: 1,
    input_tokens: response.usage?.input_tokens ?? 0,
    model: response.model,
  };
}

// --------------------------------------------------------------- settlement

export type SettlementInput = { track_id: string; run_id: string; assignment_id: string; base?: string };
export type OwnershipLabel = "owned" | "unowned" | "unclassified";
export type SettlementOutput = {
  moment: "settlement";
  request_id: string;
  source: string;
  assignment: { assignment_id: string; responsibility_key: string; worker_id: string; profile: string; state: string };
  report: { path: string; paragraphs: number; segment_from: string };
  conditions: { index: number; text: string; p_met: number; evidence: { paragraph: number | null; excerpt: string } }[];
  p_claims_evidence_separated: number;
  p_out_of_scope_change: number;
  changed_paths: Record<OwnershipLabel, string[]>;
  /** `bullets` is how many "# Write ownership" lines there were; `classified` is how many yielded a path or prefix after the trailing annotation was stripped. */
  ownership: { bullets: number; classified_bullets: number; classified: number; unclassified: number };
  base: string;
  next_action: { score: number; label: string; probabilities: Record<string, number> };
  attribution: "ambiguous";
  evidence_note: string;
  advisory: string;
  unevaluated: Unevaluated[];
  requests: number;
  input_tokens: number;
  model: string;
};

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

/**
 * The segment of a lane report that belongs to one assignment: everything after the previous assignment's
 * completion block, or the whole file when this is the lane's first assignment. The block is the two literal
 * lines the settlement tool recognizes, so the split follows the same boundary the tool settled on.
 */
function reportSegment(text: string, previousAssignmentId: string | undefined): { segment: string; from: string } {
  if (!previousAssignmentId) return { segment: text, from: "start of file (first assignment on this lane)" };
  const all = text.split("\n");
  const header = `[Assignment Completion: ${previousAssignmentId}]`;
  let last = -1;
  for (let i = 0; i < all.length; i++) if (all[i].trimEnd() === header) last = i;
  if (last < 0) return { segment: text, from: `start of file (no completion block for ${previousAssignmentId} in the report)` };
  let cursor = last + 1;
  while (cursor < all.length && /^\s*status:/.test(all[cursor])) cursor++;
  return { segment: all.slice(cursor).join("\n"), from: `line ${cursor + 1}, after the completion block of ${previousAssignmentId}` };
}

/** Blank-line paragraphs, merged in adjacent runs until the Choice key set fits MAX_PARAGRAPHS. */
function paragraphsOf(segment: string): string[] {
  const split = segment.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (split.length <= MAX_PARAGRAPHS) return split;
  const per = Math.ceil(split.length / MAX_PARAGRAPHS);
  const merged: string[] = [];
  for (let i = 0; i < split.length; i += per) merged.push(split.slice(i, i + per).join("\n\n"));
  return merged;
}

/** owned when a classified declaration covers it; unclassified when only prose declarations could have. */
function labelPath(target: string, classified: { kind: "path" | "prefix"; value: string }[], hasUnclassified: boolean): OwnershipLabel {
  for (const declaration of classified) {
    if (target === declaration.value || target.startsWith(`${declaration.value}/`)) return "owned";
  }
  return hasUnclassified ? "unclassified" : "unowned";
}

export async function judgeSettlement(input: SettlementInput, options: AskOptions = {}): Promise<SettlementOutput> {
  const store = await DelegationStore.resolve(input.track_id, input.run_id);
  const registry = await store.read();
  const record = registry.assignments[input.assignment_id];
  if (!record) throw new Error(`assignment ${input.assignment_id} is not in the run registry at ${store.runPath}`);
  const artifactFile = await store.preflight(input.assignment_id, record.responsibility_key);
  const artifact = artifactFile.assignment;

  // The lane's own history decides where this assignment's segment starts: the assignment dispatched to the same
  // worker immediately before it. `prompted_at` is the dispatch instant the registry records; `created_at` is the
  // fallback for a record that was registered but never prompted.
  const dispatchedAt = (assignment: AssignmentRecord): string => assignment.prompted_at ?? assignment.created_at;
  const laneHistory = Object.values(registry.assignments)
    .filter((a) => a.worker_id === record.worker_id)
    .sort((a, b) => dispatchedAt(a).localeCompare(dispatchedAt(b)));
  const position = laneHistory.findIndex((a) => a.assignment_id === record.assignment_id);
  const previous = position > 0 ? laneHistory[position - 1].assignment_id : undefined;

  const reportPath = path.join(store.runPath, "a2a", `${record.worker_id}-report.md`);
  let reportText = "";
  try {
    reportText = readFileSync(reportPath, "utf8");
  } catch {
    reportText = "";
  }
  const { segment, from } = reportSegment(reportText, previous);
  const paragraphs = paragraphsOf(segment);

  const declarations = artifact.write_ownership;
  const classified: { kind: "path" | "prefix"; value: string }[] = [];
  let unclassifiedDeclarations = 0;
  let classifiedBullets = 0;
  for (const declaration of declarations) {
    const classes = classifyOwnershipDeclarations(declaration);
    if (classes.every((declared) => declared.kind !== "unclassified")) classifiedBullets += 1;
    for (const declared of classes) {
      if (declared.kind === "unclassified") unclassifiedDeclarations += 1;
      else classified.push({ kind: declared.kind, value: declared.value });
    }
  }

  const base = input.base ?? lines(git(store.cwd, "rev-list", "-1", `--before=${dispatchedAt(record)}`, "HEAD"))[0] ?? "HEAD";
  const untracked = new Set(lines(git(store.cwd, "ls-files", "--others", "--exclude-standard")));
  const changed = [...new Set([
    ...lines(git(store.cwd, "diff", "--name-only", `${base}..HEAD`)),
    ...lines(git(store.cwd, "diff", "--name-only", "--cached")),
    ...lines(git(store.cwd, "diff", "--name-only")),
    ...untracked,
  ])].sort();
  const changed_paths: Record<OwnershipLabel, string[]> = { owned: [], unowned: [], unclassified: [] };
  for (const target of changed) changed_paths[labelPath(target, classified, unclassifiedDeclarations > 0)].push(target);

  // Owned paths enter the state as diff text (their content when untracked, which has no base to diff against);
  // unowned and unclassified paths enter as path lists only.
  const unevaluated: Unevaluated[] = [];
  const diffItems: { index: number; path: string; range: { start: number; end: number }; text: string }[] = [];
  for (const target of changed_paths.owned) {
    let text = untracked.has(target) ? "" : git(store.cwd, "diff", base, "--", target);
    if (!text && untracked.has(target)) {
      try {
        text = readFileSync(path.join(store.cwd, target), "utf8");
      } catch (error) {
        unevaluated.push({ path: target, reason: `unreadable: ${(error as Error).message}` });
        continue;
      }
    }
    if (!text.trim()) continue;
    for (const piece of chunk(text, target)) diffItems.push({ index: diffItems.length, path: target, range: { start: piece.start, end: piece.end }, text: piece.text });
  }

  const conditions = artifact.completion_conditions.map((text, index) => ({ index, text }));
  const questions = settlementQuestions(conditions.length, paragraphs.length);
  const questionTokens = Object.values(questions).map(estimateTokens);
  const longest = questionTokens.length ? Math.max(...questionTokens) : 0;
  const totalQuestions = questionTokens.reduce((a, b) => a + b, 0);
  const baseState = {
    assignment: { assignment_id: artifact.assignment_id, profile: artifact.profile, goal: artifact.goal },
    conditions,
    ownership: { declarations, classified, unclassified: unclassifiedDeclarations },
    report: { paragraphs: paragraphs.map((text, index) => ({ index, text })) },
    changed_paths,
    owned_diff: [] as typeof diffItems,
  };
  // Greedy packing under both documented budgets; a hunk that does not fit is reported, never silently dropped.
  const fitting: typeof diffItems = [];
  let stateTokens = estimateTokens(baseState);
  for (const item of diffItems) {
    const cost = estimateTokens(item);
    if (stateTokens + cost + longest > STATE_BUDGET || stateTokens + cost + totalQuestions > TOTAL_BUDGET) {
      unevaluated.push({ path: item.path, range: item.range, reason: "owned diff over the request budget" });
      continue;
    }
    fitting.push(item);
    stateTokens += cost;
  }
  const state = { ...baseState, owned_diff: fitting.map((item, index) => ({ index, path: item.path, range: item.range, text: item.text })) };
  const response = await ask(state, questions, { model: jevConfig(store.cwd).model, ...options });

  const rid = requestId();
  const ts = new Date().toISOString();
  const rows: DecisionRow[] = [];
  const row = (question_id: string, target: string, extra: Partial<DecisionRow>): void => {
    rows.push({ ts, event: "decision", request_id: rid, tool: "judge", stage: "settlement", question_id, question_version: QUESTION_VERSION, model: response.model, target, ...extra });
  };
  const conditionRows = conditions.map(({ index, text }) => {
    const met = response.answers[`met_${index}`];
    const evid = response.answers[`evid_${index}`];
    const p_met = met.type === "noul" ? met.noul : 0;
    const chosen = evid.type === "choice" ? evid.choice : "none";
    const paragraph = chosen === "none" ? null : Number(chosen);
    row("met", `${artifact.assignment_id}:conditions[${index}]`, { probability: p_met });
    row("evid", `${artifact.assignment_id}:conditions[${index}]`, { chosen, probability: evid.type === "choice" ? evid.probabilities[chosen] : undefined });
    return {
      index,
      text,
      p_met,
      evidence: { paragraph, excerpt: paragraph === null || !paragraphs[paragraph] ? "" : paragraphs[paragraph].split("\n").slice(0, MAX_EXCERPT_LINES).join("\n") },
    };
  });
  const claims = response.answers.claims_evidence;
  const p_claims_evidence_separated = claims.type === "noul" ? claims.noul : 0;
  row("claims_evidence", `${artifact.assignment_id}:report`, { probability: p_claims_evidence_separated });
  const scope = response.answers.out_of_scope;
  const p_out_of_scope_change = scope.type === "noul" ? scope.noul : 0;
  row("out_of_scope", `${artifact.assignment_id}:changed_paths`, { probability: p_out_of_scope_change });
  const action = response.answers.next_action;
  const probabilities = action.type === "score" ? action.probabilities : {};
  const argmax = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "1";
  const next_action = { score: action.type === "score" ? action.score : 0, label: SETTLEMENT_ACTIONS[Number(argmax)] ?? "requery", probabilities };
  row("next_action", `${artifact.assignment_id}`, { score: next_action.score, chosen: next_action.label });
  append(rows);

  return {
    moment: "settlement",
    request_id: rid,
    source: artifactFile.path,
    assignment: { assignment_id: artifact.assignment_id, responsibility_key: artifact.responsibility_key, worker_id: record.worker_id, profile: artifact.profile, state: record.state },
    report: { path: reportPath, paragraphs: paragraphs.length, segment_from: from },
    conditions: conditionRows,
    p_claims_evidence_separated,
    p_out_of_scope_change,
    changed_paths,
    ownership: { bullets: declarations.length, classified_bullets: classifiedBullets, classified: classified.length, unclassified: unclassifiedDeclarations },
    base,
    next_action,
    // The working directory is shared by concurrent tracks, so a changed path is evidence about the tree, never
    // proof of who changed it.
    attribution: "ambiguous",
    evidence_note: EVIDENCE_NOTE,
    advisory: ADVISORY,
    unevaluated,
    requests: 1,
    input_tokens: response.usage?.input_tokens ?? 0,
    model: response.model,
  };
}

// ---------------------------------------------------------------- escalate

export type EscalateInput = { question: string; context?: string };
export type EscalateOutput = {
  moment: "escalate";
  request_id: string;
  line: "ASK HUMAN" | "decide" | "observe";
  rung: string;
  probabilities: Record<string, number>;
  blocking: number;
  reversible: number;
  advisory: string;
  requests: number;
  input_tokens: number;
  model: string;
};

/**
 * Should this question interrupt a human? The ladder answers where the decision belongs; `blocking` and
 * `reversible` are what make an otherwise autonomous call worth escalating anyway. The question text is state,
 * never a log row: calibration carries the request id as the target.
 */
export async function judgeEscalation(input: EscalateInput, options: AskOptions = {}): Promise<EscalateOutput> {
  const state = { question: input.question, known_context: input.context ?? "" };
  const questions = escalateQuestions();
  const response = await ask(state, questions, { model: jevConfig(process.cwd()).model, ...options });
  const rung = response.answers.rung;
  const blockingAnswer = response.answers.blocking;
  const reversibleAnswer = response.answers.reversible;
  if (rung.type !== "choice" || blockingAnswer.type !== "noul" || reversibleAnswer.type !== "noul") throw new Error("escalate: unexpected answer types");
  const blocking = blockingAnswer.noul;
  const reversible = reversibleAnswer.noul;
  const askHuman = rung.choice === "human" || (blocking >= 0.7 && reversible < 0.4);
  const line = askHuman ? "ASK HUMAN" : rung.choice === "machine_check" ? "observe" : "decide";
  const rid = requestId();
  const ts = new Date().toISOString();
  append([
    { ts, event: "decision", request_id: rid, tool: "judge", stage: "escalate", question_id: "rung", question_version: QUESTION_VERSION, model: response.model, chosen: rung.choice, probability: rung.probabilities[rung.choice], target: rid },
    { ts, event: "decision", request_id: rid, tool: "judge", stage: "escalate", question_id: "blocking", question_version: QUESTION_VERSION, model: response.model, probability: blocking, target: rid },
    { ts, event: "decision", request_id: rid, tool: "judge", stage: "escalate", question_id: "reversible", question_version: QUESTION_VERSION, model: response.model, probability: reversible, target: rid },
  ]);
  return {
    moment: "escalate",
    request_id: rid,
    line,
    rung: ESCALATION_RUNGS.includes(rung.choice as (typeof ESCALATION_RUNGS)[number]) ? rung.choice : "autonomous",
    probabilities: rung.probabilities,
    blocking,
    reversible,
    advisory: ADVISORY,
    requests: 1,
    input_tokens: response.usage?.input_tokens ?? 0,
    model: response.model,
  };
}

// ------------------------------------------------------------------- intake

export type IntakeInput = { track_id: string; run_id: string; assignment_id: string; restatement: string };
export type IntakeOutput = {
  moment: "intake";
  request_id: string;
  source: string;
  run: { track_id: string; run_id: string };
  assignment: { assignment_id: string; responsibility_key: string; worker_id?: string; profile: string };
  p_goal_aligned: number;
  p_conditions_covered: number;
  p_boundaries_respected: number;
  conditions: number;
  advisory: string;
  requests: number;
  input_tokens: number;
  model: string;
};

/**
 * Did the worker understand the assignment it was given? The comparison is between the worker's own restatement
 * and the canonical artifact at the coordinate — never the worker's report, and never a rewrite of the artifact.
 * Coverage is asked as its own question because a restatement can echo one condition faithfully and miss four.
 */
export async function judgeIntake(input: IntakeInput, options: AskOptions = {}): Promise<IntakeOutput> {
  const store = await DelegationStore.resolve(input.track_id, input.run_id);
  const registry = await store.read();
  const record = registry.assignments[input.assignment_id];
  if (!record) throw new Error(`assignment ${input.assignment_id} is not in the run registry at ${store.runPath}`);
  const artifactFile = await store.preflight(input.assignment_id, record.responsibility_key);
  const artifact = artifactFile.assignment;

  const state = {
    assignment: {
      assignment_id: artifact.assignment_id,
      responsibility_key: artifact.responsibility_key,
      profile: artifact.profile,
      ...(artifact.label ? { label: artifact.label } : {}),
      goal: artifact.goal,
      completion_conditions: artifact.completion_conditions,
      write_ownership: artifact.write_ownership,
      dependencies: artifact.dependencies,
      user_boundaries: artifact.user_boundaries,
    },
    restatement: input.restatement,
  };
  const questions = intakeQuestions();
  assertMomentBudget("intake", state, questions);
  const response = await ask(state, questions, { model: jevConfig(store.cwd).model, ...options });

  const noul = (id: string): number => {
    const answer = response.answers[id];
    if (answer.type !== "noul") throw new Error(`intake: answer ${id} is not a noul`);
    return answer.noul;
  };
  const p_goal_aligned = noul("goal_aligned");
  const p_conditions_covered = noul("conditions_covered");
  const p_boundaries_respected = noul("boundaries_respected");

  const rid = requestId();
  const ts = new Date().toISOString();
  const row = (question_id: string, target: string, probability: number): DecisionRow => ({
    ts, event: "decision", request_id: rid, tool: "judge", stage: "intake", question_id, question_version: QUESTION_VERSION, model: response.model, probability, target,
  });
  append([
    row("goal_aligned", `${artifact.assignment_id}:goal`, p_goal_aligned),
    row("conditions_covered", `${artifact.assignment_id}:conditions`, p_conditions_covered),
    row("boundaries_respected", `${artifact.assignment_id}:boundaries`, p_boundaries_respected),
  ]);

  return {
    moment: "intake",
    request_id: rid,
    source: artifactFile.path,
    run: { track_id: input.track_id, run_id: input.run_id },
    assignment: { assignment_id: artifact.assignment_id, responsibility_key: artifact.responsibility_key, ...(record.worker_id ? { worker_id: record.worker_id } : {}), profile: artifact.profile },
    p_goal_aligned,
    p_conditions_covered,
    p_boundaries_respected,
    conditions: artifact.completion_conditions.length,
    advisory: ADVISORY,
    requests: 1,
    input_tokens: response.usage?.input_tokens ?? 0,
    model: response.model,
  };
}

// --------------------------------------------------------------------- plan

export type PlanInput = { track_id: string; run_id: string };
export type PlanOutput = {
  moment: "plan";
  request_id: string;
  run: { track_id: string; run_id: string; run_path: string };
  sources: { mandate: string; plan: string };
  p_unresolved_inputs: number;
  p_mandate_covered: number;
  p_boundaries_explicit: number;
  advisory: string;
  requests: number;
  input_tokens: number;
  model: string;
};

const PLAN_DOCUMENTS = { mandate: "orchestrator-instructions.md", plan: "plan.md" } as const;

/**
 * The run's own two documents, judged against each other: what the mandate requires and what the plan proposes.
 * It produces no decomposition, approves nothing, and omits nothing at a threshold — it reports three
 * probabilities about documents the ORCH already owns.
 */
export async function judgePlan(input: PlanInput, options: AskOptions = {}): Promise<PlanOutput> {
  const store = await DelegationStore.resolve(input.track_id, input.run_id);
  const read = (name: keyof typeof PLAN_DOCUMENTS): { path: string; text: string } => {
    const target = path.join(store.runPath, PLAN_DOCUMENTS[name]);
    try {
      return { path: target, text: readFileSync(target, "utf8") };
    } catch (error) {
      throw new Error(`judge plan: cannot read ${PLAN_DOCUMENTS[name]} of this run (${(error as Error).message}).`);
    }
  };
  const mandate = read("mandate");
  const plan = read("plan");

  const state = { mandate: mandate.text, plan: plan.text };
  const questions = planQuestions();
  assertMomentBudget("plan", state, questions);
  const response = await ask(state, questions, { model: jevConfig(store.cwd).model, ...options });

  const noul = (id: string): number => {
    const answer = response.answers[id];
    if (answer.type !== "noul") throw new Error(`plan: answer ${id} is not a noul`);
    return answer.noul;
  };
  const p_unresolved_inputs = noul("unresolved_inputs");
  const p_mandate_covered = noul("mandate_covered");
  const p_boundaries_explicit = noul("boundaries_explicit");

  const rid = requestId();
  const ts = new Date().toISOString();
  const target = `${input.track_id}/${input.run_id}`;
  const row = (question_id: string, probability: number): DecisionRow => ({
    ts, event: "decision", request_id: rid, tool: "judge", stage: "plan", question_id, question_version: QUESTION_VERSION, model: response.model, probability, target,
  });
  append([
    row("unresolved_inputs", p_unresolved_inputs),
    row("mandate_covered", p_mandate_covered),
    row("boundaries_explicit", p_boundaries_explicit),
  ]);

  return {
    moment: "plan",
    request_id: rid,
    run: { track_id: input.track_id, run_id: input.run_id, run_path: store.runPath },
    sources: { mandate: mandate.path, plan: plan.path },
    p_unresolved_inputs,
    p_mandate_covered,
    p_boundaries_explicit,
    advisory: ADVISORY,
    requests: 1,
    input_tokens: response.usage?.input_tokens ?? 0,
    model: response.model,
  };
}

// ------------------------------------------------- compact server attachments

/** What a tool response may carry: rows and lists are bounded so a judgment never costs more context than it saves. */
const ATTACH_CONDITIONS = 12;
const ATTACH_PATHS = 10;
const ATTACH_EXCERPT_LINES = 2;

export function compactAuthoring(out: AuthoringOutput): object {
  return {
    moment: out.moment,
    request_id: out.request_id,
    scores: Object.fromEntries(out.scores.map((s) => [s.id, Number(s.score.toFixed(2))])),
    conditions: out.conditions.slice(0, ATTACH_CONDITIONS).map((c) => ({ index: c.index, p_observable: Number(c.p_observable.toFixed(2)) })),
    ...(out.conditions.length > ATTACH_CONDITIONS ? { conditions_omitted: out.conditions.length - ATTACH_CONDITIONS } : {}),
    maturity: Number(out.maturity.toFixed(2)),
    profile: { choice: out.profile.choice, declared: out.profile.declared, agrees: out.profile.agrees, probabilities: out.profile.probabilities },
    next_action: out.next_action,
    advisory: out.advisory,
    model: out.model,
  };
}

export function compactSettlement(out: SettlementOutput): object {
  const paths = (list: string[]): object => ({ count: list.length, ...(list.length ? { sample: list.slice(0, ATTACH_PATHS) } : {}), ...(list.length > ATTACH_PATHS ? { omitted: list.length - ATTACH_PATHS } : {}) });
  return {
    moment: out.moment,
    request_id: out.request_id,
    assignment_id: out.assignment.assignment_id,
    conditions: out.conditions.slice(0, ATTACH_CONDITIONS).map((c) => ({
      index: c.index,
      p_met: Number(c.p_met.toFixed(2)),
      evidence_paragraph: c.evidence.paragraph,
      ...(c.evidence.excerpt ? { excerpt: c.evidence.excerpt.split("\n").slice(0, ATTACH_EXCERPT_LINES).join(" / ").slice(0, 300) } : {}),
    })),
    ...(out.conditions.length > ATTACH_CONDITIONS ? { conditions_omitted: out.conditions.length - ATTACH_CONDITIONS } : {}),
    p_claims_evidence_separated: Number(out.p_claims_evidence_separated.toFixed(2)),
    p_out_of_scope_change: Number(out.p_out_of_scope_change.toFixed(2)),
    changed_paths: { owned: paths(out.changed_paths.owned), unowned: paths(out.changed_paths.unowned), unclassified: paths(out.changed_paths.unclassified) },
    ownership: out.ownership,
    base: out.base,
    next_action: { label: out.next_action.label, score: Number(out.next_action.score.toFixed(2)) },
    attribution: out.attribution,
    evidence_note: out.evidence_note,
    advisory: out.advisory,
    model: out.model,
  };
}
