// rank: let Jev read before the host does. Paths are judged by name only; files are chunked and each chunk judged.
// Returns every candidate ordered by probability — never truncated by a threshold; the caller decides.
import { readFileSync } from "node:fs";
import { ask, estimateTokens, REQUEST_TOKENS, SAFETY_MARGIN, STATE_PLUS_LONGEST_TOKENS, type AskOptions, type Question } from "./client.js";
import { blocksOfText, chunk, type Chunk } from "./chunk.js";
import { append, requestId, type DecisionRow } from "./log.js";
import { QUESTION_VERSION, rankQuestions } from "./questions.js";

export type RankResult = { path: string; range?: { start: number; end: number }; title?: string; p: number; a: number; b: number };
export type Unevaluated = { path: string; range?: { start: number; end: number }; reason: string };
export type RankOutput = { intent: string; results: RankResult[]; unevaluated: Unevaluated[]; requests: number; request_ids: string[]; input_tokens: number; model?: string };

const QUESTION_TOKENS_PER_ITEM = 2 * 70;
const STATE_BUDGET = Math.floor(STATE_PLUS_LONGEST_TOKENS * (1 - SAFETY_MARGIN)) - 200;
const TOTAL_BUDGET = Math.floor(REQUEST_TOKENS * (1 - SAFETY_MARGIN));

type Item = { index: number; path: string; range?: { start: number; end: number }; title?: string; text?: string };

/** Greedy packing under both budgets; an item that alone exceeds the state budget is reported, not silently dropped. */
function batches(intent: string, items: Item[]): { batch: Item[]; over: Item[] } {
  const over: Item[] = [];
  const fits: Item[] = [];
  const base = estimateTokens({ intent, items: [] });
  for (const it of items) {
    const t = estimateTokens(it);
    if (base + t > STATE_BUDGET) over.push(it);
    else fits.push(it);
  }
  return { batch: fits, over };
}

async function judge(intent: string, kind: "path" | "chunk", items: Item[], tool: string, options: AskOptions): Promise<{ results: RankResult[]; unevaluated: Unevaluated[]; requests: number; request_ids: string[]; input_tokens: number; model?: string }> {
  const { batch, over } = batches(intent, items);
  const unevaluated: Unevaluated[] = over.map((it) => ({ path: it.path, range: it.range, reason: "single item exceeds state budget" }));
  const results: RankResult[] = [];
  let requests = 0;
  const request_ids: string[] = [];
  let input_tokens = 0;
  let model: string | undefined;
  let cursor = 0;
  while (cursor < batch.length) {
    const group: Item[] = [];
    let stateTokens = estimateTokens({ intent, items: [] });
    while (cursor < batch.length) {
      const next = batch[cursor];
      const t = estimateTokens(next);
      const n = group.length + 1;
      if (group.length && (stateTokens + t > STATE_BUDGET || stateTokens + t + n * QUESTION_TOKENS_PER_ITEM > TOTAL_BUDGET)) break;
      group.push(next);
      stateTokens += t;
      cursor++;
    }
    const state = { intent, items: group.map((it, index) => (kind === "path" ? { index, path: it.path } : { index, title: it.title, text: it.text })) };
    const questions: Record<string, Question> = rankQuestions(group.length, kind);
    const response = await ask(state, questions, options);
    requests++;
    input_tokens += response.usage?.input_tokens ?? 0;
    model = response.model;
    const rid = requestId();
    request_ids.push(rid);
    const rows: DecisionRow[] = [];
    group.forEach((it, i) => {
      const a = response.answers[`a_${i}`], b = response.answers[`b_${i}`];
      if (a.type !== "noul" || b.type !== "noul") return;
      const target = it.range ? `${it.path}:${it.range.start}-${it.range.end}` : it.path;
      results.push({ path: it.path, range: it.range, title: it.title, p: Math.max(a.noul, b.noul), a: a.noul, b: b.noul });
      for (const [qid, ans] of [[`a_${i}`, a], [`b_${i}`, b]] as const) {
        rows.push({ ts: new Date().toISOString(), event: "decision", request_id: rid, tool, stage: kind, question_id: qid.replace(/_\d+$/, ""), question_version: QUESTION_VERSION, model: response.model, probability: ans.noul, target });
      }
    });
    append(rows);
  }
  results.sort((x, y) => y.p - x.p);
  return { results, unevaluated, requests, request_ids, input_tokens, model };
}

/** Rank candidate paths by name only (directory order in state; probability order in output). */
export async function rankPaths(intent: string, paths: string[], options: AskOptions = {}): Promise<RankOutput> {
  const items: Item[] = [...paths].sort().map((path, index) => ({ index, path }));
  const r = await judge(intent, "path", items, "rank", options);
  return { intent, ...r };
}

/** Rank the chunks of one or more files. `topK` limits how many of the given paths (in given order) are chunked. */
export async function rankChunks(intent: string, paths: string[], options: AskOptions & { topK?: number; maxChunkChars?: number } = {}): Promise<RankOutput> {
  const chosen = options.topK ? paths.slice(0, options.topK) : paths;
  const items: Item[] = [];
  const unevaluated: Unevaluated[] = [];
  for (const path of chosen) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      unevaluated.push({ path, reason: `unreadable: ${(error as Error).message}` });
      continue;
    }
    for (const c of chunk(text, path, options.maxChunkChars)) items.push({ index: items.length, path, range: { start: c.start, end: c.end }, title: c.title, text: c.text });
  }
  const r = await judge(intent, "chunk", items, "rank", options);
  return { intent, ...r, unevaluated: [...unevaluated, ...r.unevaluated] };
}

/** Rank blocks of an in-memory text (tool output, transcript) against an intent. `path` is only a label for logs. */
export async function rankText(intent: string, text: string, label: string, options: AskOptions = {}): Promise<RankOutput & { blocks: Chunk[] }> {
  const blocks = blocksOfText(text);
  const items: Item[] = blocks.map((c, index) => ({ index, path: label, range: { start: c.start, end: c.end }, title: c.title, text: c.text }));
  const r = await judge(intent, "chunk", items, "rank", options);
  return { intent, ...r, blocks };
}

/**
 * How well the intent separated the candidates — a property of the question, not of the documents.
 * sharp: a clear head; flat: everything similar (rewrite the intent more specifically); weak: nothing relevant
 * (the intent names something these candidates do not contain, or is too vague to match anything).
 */
export type Quality = { verdict: "sharp" | "flat" | "weak"; top: number; gap: number; hint?: string };
export function quality(results: RankResult[]): Quality {
  if (results.length === 0) return { verdict: "weak", top: 0, gap: 0 };
  const top = results[0].p;
  const median = results[Math.floor(results.length / 2)].p;
  const gap = top - median;
  if (top < 0.5) return { verdict: "weak", top, gap, hint: "nothing scored as relevant: state concretely what information you need (a name, a decision, a symbol, a section), not the task you are doing" };
  // Observed: a vague intent ("doing my task") gives top≈0.64 / median≈0.50; a specific one gives top≈0.98 / median≈0.11.
  if (results.length >= 4 && median > 0.35 && gap < 0.3) return { verdict: "flat", top, gap, hint: "everything scored alike: the intent does not distinguish these items; name what would make one of them the answer" };
  return { verdict: "sharp", top, gap };
}
