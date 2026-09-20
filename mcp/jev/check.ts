// check: does a reference document actually say this? Each sentence is judged for support against the chunks of
// the reference documents, and the supporting chunk is chosen in a separate question with a `none` sentinel.
// Generic: no repository knowledge, portable with the rest of the module.
import { readFileSync } from "node:fs";

import { ask, estimateTokens, REQUEST_TOKENS, SAFETY_MARGIN, STATE_PLUS_LONGEST_TOKENS, type AskOptions } from "./client.js";
import { chunk } from "./chunk.js";
import { append, requestId, type DecisionRow } from "./log.js";
import { QUESTION_VERSION, checkQuestions } from "./questions.js";

const STATE_BUDGET = Math.floor(STATE_PLUS_LONGEST_TOKENS * (1 - SAFETY_MARGIN)) - 200;
const TOTAL_BUDGET = Math.floor(REQUEST_TOKENS * (1 - SAFETY_MARGIN));

export type CheckChunk = { path: string; range: { start: number; end: number }; title: string };
export type CheckResult = { index: number; sentence: string; p_supported: number; chunk: CheckChunk | null; p_chunk?: number };
export type CheckOutput = {
  sentences: CheckResult[];
  chunks: number;
  unevaluated: { path: string; range?: { start: number; end: number }; reason: string }[];
  requests: number;
  input_tokens: number;
  model: string;
};

export async function check(sentences: string[], referencePaths: string[], options: AskOptions = {}): Promise<CheckOutput> {
  if (sentences.length === 0) throw new Error("check needs at least one sentence");
  if (referencePaths.length === 0) throw new Error("check needs at least one reference path");

  const unevaluated: CheckOutput["unevaluated"] = [];
  const candidates: (CheckChunk & { text: string })[] = [];
  for (const path of referencePaths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      unevaluated.push({ path, reason: `unreadable: ${(error as Error).message}` });
      continue;
    }
    for (const piece of chunk(text, path)) candidates.push({ path, range: { start: piece.start, end: piece.end }, title: piece.title, text: piece.text });
  }
  if (candidates.length === 0) throw new Error("no readable reference chunks");

  // One request: pack chunks under both documented budgets and report what did not fit rather than dropping it.
  // Each extra chunk adds one key to every sentence's Choice question, so the question cost is linear in the
  // chunk count: measure the constant once, pack against it, then confirm the assembled request exactly.
  const sentenceState = sentences.map((text, index) => ({ index, text }));
  const cost = (chunkCount: number): { longest: number; total: number } => {
    const per = Object.values(checkQuestions(sentences.length, chunkCount)).map(estimateTokens);
    return { longest: Math.max(...per), total: per.reduce((a, b) => a + b, 0) };
  };
  const empty = cost(0);
  const single = cost(1);
  const perChunk = { longest: single.longest - empty.longest, total: single.total - empty.total };
  const kept: typeof candidates = [];
  let stateTokens = estimateTokens({ sentences: sentenceState, chunks: [] });
  for (const candidate of candidates) {
    const chunkTokens = estimateTokens(candidate);
    const next = kept.length + 1;
    if (stateTokens + chunkTokens + empty.longest + next * perChunk.longest > STATE_BUDGET || stateTokens + chunkTokens + empty.total + next * perChunk.total > TOTAL_BUDGET) {
      unevaluated.push({ path: candidate.path, range: candidate.range, reason: "reference chunk over the request budget" });
      continue;
    }
    kept.push(candidate);
    stateTokens += chunkTokens;
  }
  // The estimate above is linear in the key count; this is the exact request, so shrink it if it disagrees.
  while (kept.length > 1) {
    const exact = cost(kept.length);
    if (stateTokens + exact.longest <= STATE_BUDGET && stateTokens + exact.total <= TOTAL_BUDGET) break;
    const dropped = kept.pop();
    if (!dropped) break;
    stateTokens -= estimateTokens(dropped);
    unevaluated.push({ path: dropped.path, range: dropped.range, reason: "reference chunk over the request budget" });
  }
  if (kept.length === 0) throw new Error("every reference chunk exceeds the request budget");

  const state = { sentences: sentenceState, chunks: kept.map((c, index) => ({ index, path: c.path, range: c.range, title: c.title, text: c.text })) };
  const questions = checkQuestions(sentences.length, kept.length);
  const response = await ask(state, questions, options);

  const rid = requestId();
  const ts = new Date().toISOString();
  const rows: DecisionRow[] = [];
  const results: CheckResult[] = sentences.map((sentence, index) => {
    const supported = response.answers[`sup_${index}`];
    const source = response.answers[`src_${index}`];
    const p_supported = supported.type === "noul" ? supported.noul : 0;
    const chosen = source.type === "choice" ? source.choice : "none";
    const picked = chosen === "none" ? undefined : kept[Number(chosen)];
    rows.push({ ts, event: "decision", request_id: rid, tool: "check", stage: "check", question_id: "sup", question_version: QUESTION_VERSION, model: response.model, probability: p_supported, target: `sentences[${index}]` });
    rows.push({ ts, event: "decision", request_id: rid, tool: "check", stage: "check", question_id: "src", question_version: QUESTION_VERSION, model: response.model, chosen, probability: source.type === "choice" ? source.probabilities[chosen] : undefined, target: `sentences[${index}]` });
    return {
      index,
      sentence,
      p_supported,
      chunk: picked ? { path: picked.path, range: picked.range, title: picked.title } : null,
      ...(source.type === "choice" ? { p_chunk: source.probabilities[chosen] } : {}),
    };
  });
  append(rows);

  return { sentences: results, chunks: kept.length, unevaluated, requests: 1, input_tokens: response.usage?.input_tokens ?? 0, model: response.model };
}
