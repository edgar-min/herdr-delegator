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
/** Conservative token estimate: bytes / 3 (JSON with English prose and paths averages ~3.5–4 bytes per token). */
export const estimateTokens = (value: unknown): number => Math.ceil(JSON.stringify(value).length / 3);

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

/** Key resolution order: TYPESAFE_API_KEY, JEV_API_KEY, <agentDir>/herdr-delegator/jev/auth.json {"api_key"}. Never logged. */
export function apiKey(): string {
  const env = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
  if (env) return env;
  const path = join(agentDir(), "herdr-delegator", "jev", "auth.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && "api_key" in parsed && typeof parsed.api_key === "string" && parsed.api_key) return parsed.api_key;
  } catch {
    // fall through to the explicit error below
  }
  throw new Error(`Jev API key not found: set TYPESAFE_API_KEY or JEV_API_KEY, or write {"api_key": "..."} to ${path}`);
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
    if (Math.abs(sum - 1) > 0.01 || probs.some((p) => !(p >= 0 && p <= 1))) return `probabilities of ${id} invalid (sum ${sum.toFixed(3)})`;
    if (a.type === "choice" && q.type === "choice") {
      const keys = Object.keys(q.criteria).sort().join("\u0000");
      if (Object.keys(a.probabilities).sort().join("\u0000") !== keys) return `choice ${id} key set mismatch`;
      const max = Math.max(...probs);
      if (a.probabilities[a.choice] < max - 1e-6) return `choice ${id} not argmax`;
    } else if (a.type === "score" && q.type === "score") {
      const expected = q.criteria.map((_, i) => String(i)).join("\u0000");
      if (Object.keys(a.probabilities).sort((x, y) => Number(x) - Number(y)).join("\u0000") !== expected) return `score ${id} level set mismatch`;
      const mean = Object.entries(a.probabilities).reduce((acc, [k, p]) => acc + Number(k) * p, 0);
      if (Math.abs(mean - a.score) > 0.02) return `score ${id} != weighted mean (${mean.toFixed(3)} vs ${a.score})`;
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
