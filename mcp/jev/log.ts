// Append-only calibration log. One `decision` row per question per call; `outcome` rows are appended later by
// whoever observes what happened next. Never contains document text or credentials.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./client.js";

export type DecisionRow = {
  ts: string;
  event: "decision";
  request_id: string;
  tool: string;
  stage: string;
  question_id: string;
  question_version: string;
  model: string;
  probability?: number;
  score?: number;
  chosen?: string;
  /** Identifier of the judged object (path, line range, condition index) — never its content. */
  target: string;
  threshold?: number;
  pass?: boolean;
};
export type OutcomeRow = {
  ts: string;
  event: "outcome";
  request_id: string;
  /** What the agent did next, e.g. "opened:path:40-58", "opened_full", "ignored", "accepted", "rejected". */
  action: string;
  note?: string;
};

export function logPath(): string {
  return process.env.JEV_CALIBRATION_LOG ?? join(agentDir(), "herdr-delegator", "jev", "calibration.jsonl");
}

export function append(rows: Array<DecisionRow | OutcomeRow>): void {
  if (rows.length === 0) return;
  const path = logPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export const requestId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Everything this log accepts from a caller is an identifier: a request id and a short outcome token. The bound
 * is what keeps a calibration row from becoming a place to write prose, a document body, or a credential.
 */
export const LOG_IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

/** Record what actually happened after a judgment. One row, identifiers only: no note, no body. */
export function appendOutcome(request_id: string, outcome: string): OutcomeRow {
  if (!LOG_IDENTIFIER_RE.test(request_id)) throw new Error(`log outcome: request_id must match ${LOG_IDENTIFIER_RE.source}`);
  if (!LOG_IDENTIFIER_RE.test(outcome)) throw new Error(`log outcome: outcome must match ${LOG_IDENTIFIER_RE.source}`);
  const row: OutcomeRow = { ts: new Date().toISOString(), event: "outcome", request_id, action: outcome };
  append([row]);
  return row;
}

export type RequestSummary = {
  request_id: string;
  /** False when the log holds no decision row for this request id: the identifier was never judged, or the log was rotated. */
  has_decision: boolean;
  decisions: number;
  stages: Record<string, number>;
  questions: Record<string, number>;
  /** The `action` identifiers of this request's outcome rows, in file order. Never a note or a body. */
  outcomes: string[];
};
export type LogSummary = { path: string; rows_scanned: number; malformed_rows: number; requests: RequestSummary[] };

/**
 * Count what the log already holds for the given request ids. This reads the file and nothing else: no model
 * call, no inferred accuracy, no outcome invented for a request that has none, and no row body returned.
 */
export function summarize(requestIds: string[]): LogSummary {
  const path = logPath();
  const wanted = [...new Set(requestIds)];
  const summaries = new Map<string, RequestSummary>(
    wanted.map((request_id) => [request_id, { request_id, has_decision: false, decisions: 0, stages: {}, questions: {}, outcomes: [] }]),
  );
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { path, rows_scanned: 0, malformed_rows: 0, requests: [...summaries.values()] };
  }
  let rows_scanned = 0;
  let malformed_rows = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    rows_scanned += 1;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      malformed_rows += 1;
      continue;
    }
    if (typeof row !== "object" || row === null) {
      malformed_rows += 1;
      continue;
    }
    const { event, request_id } = row as { event?: unknown; request_id?: unknown };
    if (typeof request_id !== "string" || (event !== "decision" && event !== "outcome")) {
      malformed_rows += 1;
      continue;
    }
    const summary = summaries.get(request_id);
    if (!summary) continue;
    if (event === "outcome") {
      const { action } = row as { action?: unknown };
      if (typeof action !== "string") {
        malformed_rows += 1;
        continue;
      }
      summary.outcomes.push(action);
      continue;
    }
    const { stage, question_id } = row as { stage?: unknown; question_id?: unknown };
    if (typeof stage !== "string" || typeof question_id !== "string") {
      malformed_rows += 1;
      continue;
    }
    summary.has_decision = true;
    summary.decisions += 1;
    summary.stages[stage] = (summary.stages[stage] ?? 0) + 1;
    summary.questions[question_id] = (summary.questions[question_id] ?? 0) + 1;
  }
  return { path, rows_scanned, malformed_rows, requests: [...summaries.values()] };
}
