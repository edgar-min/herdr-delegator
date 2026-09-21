// Jev adapter for the scan judgment. The state is the mandate as-is; every question names a state path.
// The domain gets back a ScanVerdict; the raw answers are returned beside it so a human can compare.
import { ask, type AskOptions, type JevResponse, type Question } from "../../../mcp/jev/client.js";
import type { Candidate, ScanVerdict } from "../domain/judgments.js";

export const SCAN_QUESTION_VERSION = "2026-09-21.1";

/** v2 shape (flat) or v3 shape (`mandate` subtree plus context keys). Passages are the string leaves of the mandate. */
export type ScanState = Record<string, unknown>;

/** Ordered levels of the per-passage score: how much execution of the passage depends on context the mandate does not supply. */
export const DEPENDENCE_LEVELS = ["self_contained", "lookup_named", "facts_unnamed", "decision_missing"] as const;

const DEPENDENCE_CRITERIA = [
  "The passage alone fixes what to do: an orchestrator can act on it without reading anything else or deciding anything the mandate leaves open.",
  "Acting on the passage requires reading material the mandate names by path, section, or identifier, and that material is expected to settle it.",
  "Acting on the passage requires facts the mandate neither states nor names a source for; the orchestrator would have to search or observe to find them.",
  "Acting on the passage requires a decision the mandate does not make; no lookup or observation settles it without someone choosing.",
];

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

export type Strategy = "score" | "nouls" | "score-verb" | "score-next" | "choice" | "choice4" | "choice4t";
export const STRATEGY_VERSION: Record<Strategy, string> = { score: "2026-09-21.1", nouls: "2026-09-21.2a", "score-verb": "2026-09-21.2b", "score-next": "2026-09-21.2c", choice: "2026-09-21.3", choice4: "2026-09-21.4", choice4t: "2026-09-21.4t" };
/** v4 additions: judge the passage's own requirement only, and break ties toward the higher option. 4t = tie-break only. */
const TIE_BREAK = " If more than one option applies, choose the option listed last.";
const CHOICE4_TAIL = " Judge what this passage itself requires; a matter another passage opens is counted there, not here." + TIE_BREAK;

/** The verb each domain takes: an intent item is carried out, a constraint is complied with, an outcome is judged met. */
function frame(domain: string, path: string): string {
  const verb = domain === "constraints" ? "comply with this constraint" : domain === "shape_of_success" ? "judge this outcome as met" : "carry out this item";
  return `Consider \`${path}\` in the context of the whole mandate. To ${verb},`;
}

/** C: the levels restated as the next thing the orchestrator must actually do, each exclusive of the ones below it. */
const NEXT_ACTION_CRITERIA = [
  "Nothing beyond following the passage as written: no reading, searching, observing, or deciding is required.",
  "Read a source the mandate names by path, section, or identifier; after that reading nothing remains open, and no search or decision is needed.",
  "Investigate or observe something the mandate names no source for; a search or observation closes it, and no decision by anyone is needed.",
  "Obtain a decision the mandate does not make; no reading, search, or observation closes it without someone choosing.",
];

/** The approved form: the four levels as named choice options, their definitions living here rather than in the state. */
const CHOICE_CRITERIA: Record<(typeof DEPENDENCE_LEVELS)[number], string> = {
  self_contained: "The ORCH can act on or comply with the passage using only the mandate text; nothing has to be read, searched, observed, or decided.",
  lookup_named: "The ORCH must read material the mandate names by path, section, or identifier before acting, and that material settles the matter.",
  facts_unnamed: "The ORCH must search or observe for facts the mandate neither states nor names a source for; no decision by anyone is needed.",
  decision_missing: "Nothing the ORCH can read or observe settles the passage; someone must choose.",
};

/** A: the score decomposed into three independent yes/no judgments; code folds them into a level. */
const NOUL_ASPECTS = {
  lookup: { text: "must the orchestrator read a source the mandate names by path, section, or identifier?", yes: "The passage points at named material and acting on it requires reading that material.", no: "No named material has to be read; the passage stands on its own or on facts already in the mandate." },
  fact: { text: "must the orchestrator establish a fact the mandate neither states nor names a source for?", yes: "Something has to be searched for or observed before the passage can be acted on, and the mandate gives no source for it.", no: "Every fact the passage rests on is stated in the mandate or in a source it names." },
  decision: { text: "must someone make a decision the mandate does not make?", yes: "The passage explicitly or implicitly awaits a choice (the user's or the orchestrator's) that the mandate leaves open.", no: "No choice is left open; the mandate already fixes what the passage asks for." },
} as const;

/** Passages whose top-level domain is in `domains` (all when undefined). */
export function targeted(state: ScanState, domains?: string[]): Candidate[] {
  return passages(state).filter((p) => !domains || domains.includes(p.domain));
}

export function scanQuestions(state: ScanState, strategy: Strategy = "score", domains?: string[]): Record<string, Question> {
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
    switch (strategy) {
      case "score":
        q[`dep:${p.id}`] = { type: "score", instructions: `Consider \`${p.id}\` in the context of the whole mandate. To act on this passage, how much does the orchestrator depend on context the mandate does not supply?`, criteria: DEPENDENCE_CRITERIA };
        break;
      case "score-verb":
        q[`dep:${p.id}`] = { type: "score", instructions: `${frame(p.domain, p.id)} how much does the orchestrator depend on context the mandate does not supply?`, criteria: DEPENDENCE_CRITERIA };
        break;
      case "score-next":
        q[`dep:${p.id}`] = { type: "score", instructions: `${frame(p.domain, p.id)} what is the next thing the orchestrator must do because of this passage?`, criteria: NEXT_ACTION_CRITERIA };
        break;
      case "choice":
        q[`dep:${p.id}`] = { type: "choice", instructions: `${frame(p.domain, p.id)} what is the next thing the ORCH must do because of this passage?`, criteria: CHOICE_CRITERIA };
        break;
      case "choice4":
        q[`dep:${p.id}`] = { type: "choice", instructions: `${frame(p.domain, p.id)} what is the next thing the ORCH must do because of this passage?${CHOICE4_TAIL}`, criteria: CHOICE_CRITERIA };
        break;
      case "choice4t":
        q[`dep:${p.id}`] = { type: "choice", instructions: `${frame(p.domain, p.id)} what is the next thing the ORCH must do because of this passage?${TIE_BREAK}`, criteria: CHOICE_CRITERIA };
        break;
      case "nouls":
        for (const [aspect, a] of Object.entries(NOUL_ASPECTS)) {
          q[`${aspect}:${p.id}`] = { type: "noul", instructions: `${frame(p.domain, p.id)} ${a.text}`, criteria: { true: a.yes, false: a.no } };
        }
        break;
    }
  }
  return q;
}

export type ScanRun = {
  version: string;
  strategy: Strategy;
  model: string;
  usage?: JevResponse["usage"];
  sufficient: number;
  passages: { id: string; domain: string; score: number; level: (typeof DEPENDENCE_LEVELS)[number]; probabilities: Record<string, number>; confidence: number }[];
  verdict: ScanVerdict;
};

/** Ask Jev and translate to levels. Score strategies take the argmax level; the noul strategy folds three probabilities
 * (decision > fact > lookup, first at or above `theta`) into a level, with `probabilities` carrying the three raw values. */
export async function jevScan(state: ScanState, keepFrom = 1, options: AskOptions & { strategy?: Strategy; theta?: number; domains?: string[] } = {}): Promise<ScanRun> {
  const strategy = options.strategy ?? "score";
  const theta = options.theta ?? 0.5;
  const questions = scanQuestions(state, strategy, options.domains);
  const res = await ask(state, questions, options);
  const suff = res.answers.sufficient;
  if (suff.type !== "noul") throw new Error("sufficient answer type mismatch");
  const rows: ScanRun["passages"] = [];
  for (const p of targeted(state, options.domains)) {
    if (strategy === "nouls") {
      const pr = Object.fromEntries((Object.keys(NOUL_ASPECTS) as (keyof typeof NOUL_ASPECTS)[]).map((k) => {
        const a = res.answers[`${k}:${p.id}`];
        if (a.type !== "noul") throw new Error(`noul answer missing for ${k}:${p.id}`);
        return [k, a.noul];
      }));
      const level = pr.decision >= theta ? 3 : pr.fact >= theta ? 2 : pr.lookup >= theta ? 1 : 0;
      const margin = Math.min(...Object.values(pr).map((v) => Math.abs(v - theta))) * 2;
      rows.push({ id: p.id, domain: p.domain, score: level, level: DEPENDENCE_LEVELS[level], probabilities: pr, confidence: margin });
      continue;
    }
    const a = res.answers[`dep:${p.id}`];
    if (a.type === "choice") {
      const level = a.choice as (typeof DEPENDENCE_LEVELS)[number];
      const probabilities = Object.fromEntries(DEPENDENCE_LEVELS.map((l, i) => [String(i), a.probabilities[l] ?? 0]));
      rows.push({ id: p.id, domain: p.domain, score: DEPENDENCE_LEVELS.indexOf(level), level, probabilities, confidence: a.confidence });
      continue;
    }
    if (a.type !== "score") throw new Error(`score answer missing for ${p.id}`);
    const argmax = Number(Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0][0]);
    rows.push({ id: p.id, domain: p.domain, score: a.score, level: DEPENDENCE_LEVELS[argmax], probabilities: a.probabilities, confidence: a.confidence });
  }
  const kept = rows.filter((r) => DEPENDENCE_LEVELS.indexOf(r.level) >= keepFrom).map((r) => ({ id: r.id, score: r.score }));
  const verdict: ScanVerdict = kept.length > 0
    ? { kept }
    : { kept, sufficiency_reasoning: `Jev: P(sufficient)=${suff.noul.toFixed(2)}; no passage reached level ${DEPENDENCE_LEVELS[keepFrom]}` };
  return { version: STRATEGY_VERSION[strategy], strategy, model: res.model, usage: res.usage, sufficient: suff.noul, passages: rows, verdict };
}
