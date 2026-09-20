// Append-only calibration log. One `decision` row per question per call; `outcome` rows are appended later by
// whoever observes what happened next. Never contains document text or credentials.
import { appendFileSync, mkdirSync } from "node:fs";
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
