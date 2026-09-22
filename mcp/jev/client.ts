// Jev (TypeSafe System One) client: one POST, two token budgets, type-specific answer validation.
// Generic: no herdr knowledge. Portable by copying the mcp/jev/ folder.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";

// Documented limits (docs.typesafe.ai/models): state + longest question <= 32k, state + all questions <= 64k.
export const STATE_PLUS_LONGEST_TOKENS = 32_000;
export const REQUEST_TOKENS = 64_000;
export const SAFETY_MARGIN = 0.15;
/**
 * UTF-8 bytes per token, by script. A tokenizer splits Latin text into long pieces and CJK text into very short
 * ones, so one ratio over the whole string is wrong for any mixed document — and wrong in the dangerous
 * direction as soon as the document is mostly CJK.
 *
 * Measured against real `usage.input_tokens` (2026-09-22):
 *   Korean-dominant JSON state: 16,102 B -> 6,466 tok and 38,288 B -> 15,395 tok, both 2.49 B/tok
 *     (ASCII 9,729 / non-ASCII 6,373 and ASCII 23,336 / non-ASCII 14,952).
 *   English-dominant JSON state plus its questions: 53,786 B -> 14,860 tok, 3.62 B/tok
 *     (ASCII 48,595 / non-ASCII 5,191).
 * The divisors below sit under both measurements, so the estimate is an upper bound: it lands ~5% above the
 * Korean points and ~23% above the English one. The superseded single ratio (bytes / 3, and counted in UTF-16
 * code units rather than bytes) returned 0.88x of the real count on the Korean points, which is how a request
 * estimated at 27k was rejected with `max_tokens_exceeded`.
 */
export const TOKEN_BYTES_ASCII = 3.2;
export const TOKEN_BYTES_NON_ASCII = 1.7;

/** Conservative token estimate of any serializable value: UTF-8 bytes, weighted by script. */
export const estimateTokens = (value: unknown): number => {
  const text = JSON.stringify(value) ?? "";
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii++;
    else if (code < 0x800) other += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      other += 4; // surrogate pair: one code point, four UTF-8 bytes
      i++;
    } else other += 3;
  }
  return Math.ceil(ascii / TOKEN_BYTES_ASCII + other / TOKEN_BYTES_NON_ASCII);
};

export type NoulQuestion = { type: "noul"; instructions: string | object; criteria?: { true?: string; false?: string } };
export type ChoiceQuestion = { type: "choice"; instructions: string | object; criteria: Record<string, string | null> };
export type ScoreQuestion = { type: "score"; instructions: string | object; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type JevResponse = { model: string; answers: Record<string, Answer>; usage?: { input_tokens: number; output_tokens: number } };

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}

/**
 * Secret resolution shared by every credential this plugin may need: the process environment first, then
 * `<agentDir>/herdr-delegator/.env` (dotenv syntax, `NAME=value`, `#` comments). Values are never logged.
 */
export function secret(...names: string[]): string | undefined {
  for (const n of names) if (process.env[n]) return process.env[n];
  const path = join(agentDir(), "herdr-delegator", ".env");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]*))/);
    if (m && names.includes(m[1])) return m[2] ?? m[3] ?? m[4];
  }
  return undefined;
}

export function apiKey(): string {
  const key = secret("TYPESAFE_API_KEY", "JEV_API_KEY");
  if (key) return key;
  throw new Error(`Jev API key not found: set TYPESAFE_API_KEY (or JEV_API_KEY) in the environment or in ${join(agentDir(), "herdr-delegator", ".env")}`);
}

export class BudgetExceeded extends Error {
  constructor(readonly stateTokens: number, readonly questionTokens: number) {
    super(`Jev request over budget: state≈${stateTokens} tokens, questions≈${questionTokens} tokens`);
  }
}

/** Throws BudgetExceeded when the serialized request cannot fit the documented limits with the safety margin. */
export function assertBudget(state: unknown, questions: Record<string, Question>): void {
  const stateTokens = estimateTokens(state);
  const per = Object.values(questions).map(estimateTokens);
  const longest = per.length ? Math.max(...per) : 0;
  const total = per.reduce((a, b) => a + b, 0);
  if (stateTokens + longest > STATE_PLUS_LONGEST_TOKENS * (1 - SAFETY_MARGIN) || stateTokens + total > REQUEST_TOKENS * (1 - SAFETY_MARGIN)) {
    throw new BudgetExceeded(stateTokens, total);
  }
}

function validate(questions: Record<string, Question>, response: JevResponse): string | null {
  for (const [id, q] of Object.entries(questions)) {
    const a = response.answers[id];
    if (!a) return `missing answer ${id}`;
    if (a.type !== q.type) return `answer ${id} type ${a.type} != ${q.type}`;
    if (a.type === "noul") {
      if (!(Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1)) return `noul ${id} out of range`;
      continue;
    }
    const probs = Object.values(a.probabilities);
    const sum = probs.reduce((x, y) => x + y, 0);
    // The API rounds each probability; with many options the rounded sum drifts (observed 0.990 over ~50 paragraphs).
    const tolerance = 0.01 + 0.002 * probs.length;
    if (Math.abs(sum - 1) > tolerance || probs.some((p) => !(p >= 0 && p <= 1))) return `probabilities of ${id} invalid (sum ${sum.toFixed(3)}, ${probs.length} options)`;
    if (a.type === "choice" && q.type === "choice") {
      const keys = Object.keys(q.criteria).sort().join("\u0000");
      if (Object.keys(a.probabilities).sort().join("\u0000") !== keys) return `choice ${id} key set mismatch`;
      const max = Math.max(...probs);
      if (a.probabilities[a.choice] < max - 1e-6) return `choice ${id} not argmax`;
    } else if (a.type === "score" && q.type === "score") {
      const expected = q.criteria.map((_, i) => String(i)).join("\u0000");
      if (Object.keys(a.probabilities).sort((x, y) => Number(x) - Number(y)).join("\u0000") !== expected) return `score ${id} level set mismatch`;
      const mean = Object.entries(a.probabilities).reduce((acc, [k, p]) => acc + Number(k) * p, 0);
      // Preserve the inclusive tolerance at floating-point boundaries (e.g. 2.49 - 2.47).
      const roundoff = Number.EPSILON * Math.max(1, Math.abs(mean));
      if (Math.abs(mean - a.score) > 0.02 + roundoff) return `score ${id} != weighted mean (${mean.toFixed(3)} vs ${a.score})`;
    }
  }
  return null;
}

export type AskOptions = { model?: string; fetchImpl?: typeof fetch; signal?: AbortSignal };

/** One System One request. Retries 429/529 with backoff, re-asks once on a malformed answer set, then throws. */
export async function ask(state: unknown, questions: Record<string, Question>, options: AskOptions = {}): Promise<JevResponse> {
  assertBudget(state, questions);
  const key = apiKey();
  const body = JSON.stringify({ state, model: options.model ?? process.env.JEV_MODEL ?? DEFAULT_MODEL, questions });
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastValidation: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: options.signal,
    });
    if (res.status === 429 || res.status === 529) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, (retryAfter > 0 ? retryAfter * 1000 : 1000) * 2 ** attempt);
      await promise;
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 400)}`);
    const parsed = JSON.parse(text) as JevResponse;
    lastValidation = validate(questions, parsed);
    if (lastValidation === null) return parsed;
    if (attempt >= 1) break;
  }
  throw new Error(`Jev answer validation failed: ${lastValidation ?? "rate limited"}`);
}
