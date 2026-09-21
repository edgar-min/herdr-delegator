// Jev adapter for the scan judgment. The state is the mandate as-is; every question names a state path.
// The domain gets back a ScanVerdict; the raw answers are returned beside it so a human can compare.
// Only the approved `choice` strategy survives here; the experiment's score/noul variants stayed in the dev worktree.
import type { Candidate, ScanVerdict } from "../domain/judgments.js";
import { ask, type AskOptions, type JevResponse, type Question } from "./jev-client.js";

export const SCAN_QUESTION_VERSION = "2026-09-21.3";

/** The structured mandate as authored: a `mandate` subtree plus context keys. Passages are the string leaves of the mandate. */
export type ScanState = Record<string, unknown>;

/** Ordered levels of the per-passage score: how much execution of the passage depends on context the mandate does not supply. */
export const DEPENDENCE_LEVELS = ["self_contained", "lookup_named", "facts_unnamed", "decision_missing"] as const;

/** Every passage the mandate carries, as (path, domain, text). Paths are JSON paths into the fixed state; only the
 * mandate subtree (or, for a flat state, the whole state) is walked. Context keys (definitions, lineage, environment,
 * handoff) and any `definition` string are state the questions may read but never targets. */
const CONTEXT_KEYS: Record<string, true> = { definition: true, definitions: true, lineage: true, environment: true, handoff: true };
export function passages(state: ScanState): Candidate[] {
  const root = "mandate" in state ? (state.mandate as Record<string, unknown>) : state;
  const prefix = "mandate" in state ? "mandate." : "";
  const out: Candidate[] = [];
  const walk = (value: unknown, path: string, domain: string): void => {
    if (typeof value === "string") out.push({ id: path, domain, description: value });
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, domain));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (!CONTEXT_KEYS[k]) walk(v, k === "text" ? path : `${path}.${k}`, domain);
  };
  for (const [k, v] of Object.entries(root)) if (!CONTEXT_KEYS[k]) walk(v, `${prefix}${k}`, k);
  return out;
}

/** The verb each domain takes: an intent item is carried out, a constraint is complied with, an outcome is judged met. */
function frame(domain: string, path: string): string {
  const verb = domain === "constraints" ? "comply with this constraint" : domain === "shape_of_success" ? "judge this outcome as met" : "carry out this item";
  return `Consider \`${path}\` in the context of the whole mandate. To ${verb},`;
}

/** The approved form: the four levels as named choice options, their definitions living here rather than in the state. */
export const CHOICE_CRITERIA: Record<(typeof DEPENDENCE_LEVELS)[number], string> = {
  self_contained: "The ORCH can act on or comply with the passage using only the mandate text; nothing has to be read, searched, observed, or decided.",
  lookup_named: "The ORCH must read material the mandate names by path, section, or identifier before acting, and that material settles the matter.",
  facts_unnamed: "The ORCH must search or observe for facts the mandate neither states nor names a source for; no decision by anyone is needed.",
  decision_missing: "Nothing the ORCH can read or observe settles the passage; someone must choose.",
};

/** Passages whose top-level domain is in `domains` (all when undefined). */
export function targeted(state: ScanState, domains?: string[]): Candidate[] {
  return passages(state).filter((p) => !domains || domains.includes(p.domain));
}

/** One sufficiency noul over the whole mandate plus one choice per passage. */
export function scanQuestions(state: ScanState, domains?: string[]): Record<string, Question> {
  const q: Record<string, Question> = {
    sufficient: {
      type: "noul",
      instructions: "An orchestrator with no prior context receives this mandate (`mandate.intent`, `mandate.constraints`, `mandate.shape_of_success`) and must write an execution plan and start delegating. Is the mandate alone sufficient context for that?",
      criteria: {
        true: "Everything the plan depends on is stated in the mandate or pinned to a source the mandate names; nothing requires a fact or a decision the mandate leaves open.",
        false: "At least one thing the plan depends on is a fact the mandate does not state or name a source for, or a decision the mandate does not make.",
      },
    },
  };
  for (const p of targeted(state, domains)) {
    q[`dep:${p.id}`] = { type: "choice", instructions: `${frame(p.domain, p.id)} what is the next thing the ORCH must do because of this passage?`, criteria: CHOICE_CRITERIA };
  }
  return q;
}

export type ScanRun = {
  version: string;
  model: string;
  usage?: JevResponse["usage"];
  sufficient: number;
  passages: { id: string; domain: string; score: number; level: (typeof DEPENDENCE_LEVELS)[number]; probabilities: Record<string, number>; confidence: number }[];
  verdict: ScanVerdict;
};

/** Ask Jev and translate the chosen option of each passage into its level; `keepFrom` is the lowest level kept. */
export async function jevScan(state: ScanState, keepFrom = 1, options: AskOptions & { domains?: string[] } = {}): Promise<ScanRun> {
  const questions = scanQuestions(state, options.domains);
  const res = await ask(state, questions, options);
  const suff = res.answers.sufficient;
  if (suff.type !== "noul") throw new Error("sufficient answer type mismatch");
  const rows: ScanRun["passages"] = [];
  for (const p of targeted(state, options.domains)) {
    const a = res.answers[`dep:${p.id}`];
    if (a.type !== "choice") throw new Error(`choice answer missing for ${p.id}`);
    const level = a.choice as (typeof DEPENDENCE_LEVELS)[number];
    const probabilities = Object.fromEntries(DEPENDENCE_LEVELS.map((l, i) => [String(i), a.probabilities[l] ?? 0]));
    rows.push({ id: p.id, domain: p.domain, score: DEPENDENCE_LEVELS.indexOf(level), level, probabilities, confidence: a.confidence });
  }
  const kept = rows.filter((r) => DEPENDENCE_LEVELS.indexOf(r.level) >= keepFrom).map((r) => ({ id: r.id, score: r.score }));
  const verdict: ScanVerdict = kept.length > 0
    ? { kept }
    : { kept, sufficiency_reasoning: `Jev: P(sufficient)=${suff.noul.toFixed(2)}; no passage reached level ${DEPENDENCE_LEVELS[keepFrom]}` };
  return { version: SCAN_QUESTION_VERSION, model: res.model, usage: res.usage, sufficient: suff.noul, passages: rows, verdict };
}
