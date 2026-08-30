import { createReadStream } from "node:fs";
import { appendFile, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { isObject } from "../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";
import {
  ASSUMED_SESSION_TOKENS,
  BUDGET_STEP_FRACTION,
  DEFAULT_BUDGET_MINUTES,
  DEFAULT_BUDGET_TOKENS,
  MAX_BUDGET_MINUTES,
  MAX_BUDGET_TOKENS,
  MAX_JUSTIFICATION_ITEM,
  McpContractError,
  nowIso,
  sha256,
  type BudgetJustification,
  type BudgetMetering,
  type BudgetRecord,
  type BudgetVerdict,
  type DelegationRegistry,
  type Mandate,
  type RunRef,
} from "./contracts";

// ---------------------------------------------------------------------------
// Budget = justification cadence, not a wall (identity/comms redesign,
// decisions 7-8). Three artifacts carry the machine:
//   budget-ledger.md   append-only narrative, server-written, never hand-edited
//   budget-clamp.json  human-owned ceiling; clamping to 0 is the kill switch
//   budget-audit-N.md  server-seeded request plus the clean auditor's verdict
// The registry (a2a/delegation.json) holds the machine truth; the ledger is the
// legible trail a human is handed on a deny. Both are written from the same
// guarded call, so they cannot drift.
// ---------------------------------------------------------------------------

export type BudgetClamp = { path: string; max_tokens?: number; max_minutes?: number; note?: string };
export type ClampReading = { clamp?: BudgetClamp; unreadable?: string };

export function budgetLedgerPath(runPath: string): string { return path.join(runPath, "budget-ledger.md"); }
export function budgetClampPath(runPath: string): string { return path.join(runPath, "budget-clamp.json"); }
export function budgetAuditPath(runPath: string, ordinal: number): string { return path.join(runPath, `budget-audit-${ordinal}.md`); }

const CLAMP_SCAFFOLD_NOTE = "Human-owned. Set max_tokens and/or max_minutes to set the ceiling; raising releases a parked run; 0 is the kill switch. No agent may edit this file.";
const CLAMP_SCHEMA = "{version:1, max_tokens?, max_minutes?, note?}";

export function clampSchemaGuidance(runPath: string): string {
  return `The human-owned clamp file already exists at ${budgetClampPath(runPath)} and accepts the exact schema ${CLAMP_SCHEMA}.`;
}

export async function scaffoldClamp(runPath: string): Promise<{ created: boolean; warning?: string }> {
  const body = `${JSON.stringify({ version: 1, note: CLAMP_SCAFFOLD_NOTE }, null, 2)}\n`;
  try {
    await writeFile(budgetClampPath(runPath), body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { created: true };
  } catch (error) {
    if (isObject(error) && error.code === "EEXIST") return { created: false };
    return { created: false, warning: "The inert human-owned budget clamp could not be scaffolded; no existing clamp was changed." };
  }
}

function boundedLine(value: string, field: string): string {
  const line = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s{2,}/g, " ").trim();
  if (!line) throw new McpContractError("invalid_justification", `${field} is empty after single-line normalization.`, "validate", "State one concrete line; a justification the auditor cannot read is not a justification.");
  if (line.length > MAX_JUSTIFICATION_ITEM) {
    throw new McpContractError("invalid_justification", `${field} is ${line.length} characters; the limit is ${MAX_JUSTIFICATION_ITEM}.`, "validate", `Shorten ${field} to at most ${MAX_JUSTIFICATION_ITEM} characters; detail belongs in plan.md and the reports the auditor reads.`);
  }
  return line;
}

/** Normalizes and fingerprints the justification so a retry is provably the same request. */
export function normalizeJustification(justification: BudgetJustification): { normalized: BudgetJustification; sha256: string } {
  const normalized: BudgetJustification = {
    done: boundedLine(justification.done, "done"),
    remaining: boundedLine(justification.remaining, "remaining"),
    why_more: boundedLine(justification.why_more, "why_more"),
  };
  return { normalized, sha256: sha256(`${normalized.done}\n${normalized.remaining}\n${normalized.why_more}`) };
}

/** The seed is a declared estimate; a run that declares none still gets a bounded default. */
export function seedBudget(mandate: Mandate | undefined, startedAt: string): BudgetRecord {
  const seed = mandate?.budget;
  const tokens = seed?.tokens && seed.tokens > 0 && seed.tokens <= MAX_BUDGET_TOKENS ? seed.tokens : DEFAULT_BUDGET_TOKENS;
  const minutes = seed?.minutes && seed.minutes > 0 && seed.minutes <= MAX_BUDGET_MINUTES ? seed.minutes : DEFAULT_BUDGET_MINUTES;
  return {
    seed_tokens: tokens,
    seed_minutes: minutes,
    doorbell_policy: seed?.doorbell_policy ?? "notify",
    granted_tokens: tokens,
    granted_minutes: minutes,
    extensions: [],
    state: "active",
    started_at: startedAt,
  };
}

// The clamp is a human-edited config file, so it is parsed once at the boundary
// with a strict schema: a typo must produce a named reason, never a silently
// ignored ceiling.
const clampFileSchema = z.object({
  version: z.literal(1),
  max_tokens: z.number().int().nonnegative().optional(),
  max_minutes: z.number().int().nonnegative().optional(),
  note: z.string().max(500).optional(),
}).strict();

/**
 * The human-owned ceiling. An unreadable or malformed clamp never degrades to
 * "no clamp": that would let a tool op raise what the human lowered, so it parks
 * the run instead and the human fixes the file.
 */
export async function readClamp(runPath: string): Promise<ClampReading> {
  const clampPath = budgetClampPath(runPath);
  let raw: string;
  try {
    const file = await lstat(clampPath);
    if (!file.isFile() || file.isSymbolicLink()) return { unreadable: "the clamp path is not a regular file" };
    if (file.size > 8_192) return { unreadable: `the clamp file is ${file.size} bytes` };
    raw = await readFile(clampPath, "utf8");
  } catch (error: unknown) {
    if (isObject(error) && error.code === "ENOENT") return {};
    return { unreadable: "the clamp file cannot be read" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { unreadable: "the clamp file is not valid JSON" }; }
  const result = clampFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { unreadable: `${issue.path.join(".") || "clamp"}: ${issue.message}` };
  }
  const clamp = result.data;
  return {
    clamp: {
      path: clampPath,
      ...(clamp.max_tokens !== undefined ? { max_tokens: clamp.max_tokens } : {}),
      ...(clamp.max_minutes !== undefined ? { max_minutes: clamp.max_minutes } : {}),
      ...(clamp.note !== undefined ? { note: clamp.note } : {}),
    },
  };
}

/**
 * Fingerprint of the human-owned clamp file, or `absent` when there is none. It
 * is recorded at a deny so the machine can tell whether a human has since
 * touched the file: the escalation ladder ends at the human, and a denied run
 * must not be able to re-audit its way out on its own.
 */
export async function clampFingerprint(runPath: string): Promise<string> {
  try {
    return sha256(await readFile(budgetClampPath(runPath)));
  } catch {
    return "absent";
  }
}

/**
 * Effective ceiling. A clamp bound, when present, is the human-set ABSOLUTE
 * ceiling: cap = clamp value, even above the granted figure — raising the clamp
 * releases a denied/approval-required/over-cap park on the next guarded op, and
 * 0 stays the kill switch. An absent bound falls back to the granted figure;
 * under `full` the human approves every extension by raising the clamp, so
 * budget granted above the seed simply does not exist until the clamp says so.
 */
export function effectiveCap(record: BudgetRecord, clamp: BudgetClamp | undefined): { cap_tokens: number; cap_minutes: number } {
  const tokensCeiling = clamp?.max_tokens !== undefined
    ? clamp.max_tokens
    : record.doorbell_policy === "full" && record.granted_tokens > record.seed_tokens
      ? record.seed_tokens
      : record.granted_tokens;
  const minutesCeiling = clamp?.max_minutes !== undefined ? clamp.max_minutes : record.granted_minutes;
  return { cap_tokens: Math.max(0, tokensCeiling), cap_minutes: Math.max(0, minutesCeiling) };
}

/** Covenant: one extension may raise the cap by at most half of what is already granted. */
export function stepCap(record: BudgetRecord): number {
  return Math.max(1, Math.floor(record.granted_tokens * BUDGET_STEP_FRACTION));
}

// JSONL token snapshots are append-only, so a size+mtime signature is a sound
// cache key. Metering runs at every guarded op; re-streaming an ORCH session's
// whole transcript each time would make the gate itself the expensive part.
const tokenCache = new Map<string, number>();

async function sessionTokens(sessionPath: string): Promise<number | undefined> {
  try {
    const file = await lstat(sessionPath);
    if (!file.isFile() || file.isSymbolicLink()) return undefined;
    const key = `${sessionPath}\0${file.size}\0${file.mtimeMs}`;
    const cached = tokenCache.get(key);
    if (cached !== undefined) return cached;
    let highWater = 0;
    const lines = createInterface({ input: createReadStream(sessionPath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (Buffer.byteLength(line) > 1024 * 1024) return undefined;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!isObject(parsed) || !isObject(parsed.message)) continue;
      const message = parsed.message;
      if (message.role !== "assistant" || !isObject(message.usage)) continue;
      const usage = message.usage;
      // Context-size basis: a session is judged by its HIGH-WATER context size
      // — the max over assistant turns of input + cacheRead + cacheWrite +
      // output + reasoningTokens — so each token counts once, at its first
      // appearance in the transcript (the four context fields are disjoint:
      // their sum equals OMP's own `totalTokens`). Charging cacheRead per turn
      // re-bills the whole retained context every turn (friction
      // d5dc8d0ebf17472a, audit 1 of herdr-redesign/r1 denied on that
      // arithmetic); summing cacheWrite cumulatively re-bills long-lived lanes
      // for re-caching the same context (friction 7786fb331e176bcf) and cliffs
      // when settlement sweeps re-meter (friction 3cb0593e3a9bccd7). Compaction
      // shrinks the live context but cannot lower the high-water mark already
      // observed.
      let turn = 0;
      for (const name of ["input", "cacheRead", "cacheWrite", "output", "reasoningTokens"]) {
        const value = usage[name];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) turn += value;
      }
      if (!Number.isSafeInteger(turn)) return undefined;
      if (turn > highWater) highWater = turn;
    }
    if (tokenCache.size > 256) tokenCache.clear();
    tokenCache.set(key, highWater);
    return highWater;
  } catch {
    return undefined;
  }
}

/**
 * Run-level aggregate: the ORCH's own session plus every lane session, from the
 * official OMP JSONL, judged with a conservative margin. Precise accounting is a
 * non-goal — but an unmeasurable session is charged `ASSUMED_SESSION_TOKENS`
 * rather than nothing, so a broken snapshot can never make a run look cheap.
 */
export async function meterRun(registry: DelegationRegistry, record: BudgetRecord, clamp: BudgetClamp | undefined): Promise<BudgetMetering> {
  const observedAt = nowIso();
  const sessions = new Map<string, string>();
  for (const birth of registry.orch_births ?? []) sessions.set(birth.official_session_id, birth.official_session_path ?? "");
  for (const lane of Object.values(registry.lanes)) {
    if (lane.official_session_id) sessions.set(lane.official_session_id, lane.official_session_path ?? "");
  }
  let measuredTokens = 0;
  let measuredSessions = 0;
  let unmeasuredSessions = 0;
  for (const sessionPath of sessions.values()) {
    const tokens = sessionPath ? await sessionTokens(sessionPath) : undefined;
    if (tokens === undefined) { unmeasuredSessions += 1; continue; }
    measuredSessions += 1;
    const next = measuredTokens + tokens;
    measuredTokens = Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
  }
  const assumedTokens = unmeasuredSessions * ASSUMED_SESSION_TOKENS;
  const judgedNext = measuredTokens + assumedTokens;
  const judgedTokens = Number.isSafeInteger(judgedNext) ? judgedNext : Number.MAX_SAFE_INTEGER;
  const started = Date.parse(record.started_at);
  const elapsedMinutes = Number.isFinite(started) ? Math.max(0, Math.floor((Date.parse(observedAt) - started) / 60_000)) : 0;
  const { cap_tokens, cap_minutes } = effectiveCap(record, clamp);
  return {
    observed_at: observedAt,
    measured_tokens: measuredTokens,
    measured_sessions: measuredSessions,
    unmeasured_sessions: unmeasuredSessions,
    assumed_tokens: assumedTokens,
    judged_tokens: judgedTokens,
    elapsed_minutes: elapsedMinutes,
    cap_tokens,
    cap_minutes,
    over_cap: judgedTokens >= cap_tokens || elapsedMinutes >= cap_minutes,
    ...(clamp ? { clamp: { path: clamp.path, ...(clamp.max_tokens !== undefined ? { max_tokens: clamp.max_tokens } : {}), ...(clamp.max_minutes !== undefined ? { max_minutes: clamp.max_minutes } : {}) } } : {}),
  };
}

/** Append-only: the ledger is the trail a human is handed on a deny, so it is never rewritten. */
export async function appendLedger(runPath: string, heading: string, lines: readonly string[]): Promise<void> {
  await appendFile(budgetLedgerPath(runPath), `## ${nowIso()} ${heading}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n\n`, { mode: 0o600 });
}

export function meteringLedgerLine(metering: BudgetMetering): string {
  return `metered: ${metering.judged_tokens} tokens judged (${metering.measured_tokens} measured over ${metering.measured_sessions} sessions, ${metering.assumed_tokens} assumed for ${metering.unmeasured_sessions} unmeasurable), ${metering.elapsed_minutes} min elapsed; cap ${metering.cap_tokens} tokens / ${metering.cap_minutes} min`;
}

/**
 * The auditor's input document. The server writes the request and the machine
 * facts; the auditor appends its reasoning and verdict block to the same file,
 * exactly as a worker appends to its report. The ORCH never writes here and
 * never speaks to the auditor.
 */
export function renderAuditInput(
  run: RunRef,
  ordinal: number,
  record: BudgetRecord,
  justification: BudgetJustification,
  requestedTokens: number,
  metering: BudgetMetering,
  machineFacts: readonly string[],
): string {
  const granted = record.extensions.filter((entry) => entry.verdict === "grant" || entry.verdict === "partial").length;
  return `---
version: 1
track_id: ${run.track_id}
run_id: ${run.run_id}
audit: ${ordinal}
---

# Budget audit ${ordinal} — ${run.track_id}/${run.run_id}

You are a clean auditor session. You have no history with this run and you never
speak to its orchestrator. Judge the orchestrator's narrative against the machine
facts below, then append your verdict to this file.

## Request

- requested increase: ${requestedTokens} tokens (step cap ${stepCap(record)})
- current cap: ${record.granted_tokens} tokens / ${record.granted_minutes} min (seed ${record.seed_tokens} / ${record.seed_minutes})
- extensions already granted: ${granted}
- doorbell policy: ${record.doorbell_policy}

## The orchestrator's justification

- done: ${justification.done}
- remaining: ${justification.remaining}
- why more: ${justification.why_more}

## Machine facts

- ${meteringLedgerLine(metering)}
${machineFacts.map((fact) => `- ${fact}`).join("\n")}

## What to judge

Read this run's \`orchestrator-instructions.md\` (the mandate), \`plan.md\`,
\`budget-ledger.md\`, and every \`a2a/w<N>-report.md\`. Then decide:

1. Do the run documents match the machine facts, or is the narrative stale? An
   orchestrator that does not keep its run documents current cannot be granted
   budget — documentation freshness is enforced here, not by rules.
2. Does the recorded, verified work account for the spend so far?
3. Does \`remaining\` name concrete work, and does \`why_more\` follow from it?

## Your verdict

Append your bounded reasoning, then exactly this block as the last thing in this
file, with nothing after it:

[Budget Audit Verdict: ${ordinal}]

verdict: grant

Use \`grant\`, \`partial\`, or \`deny\` on that line. For \`partial\`, add one
more line \`granted_tokens: <integer>\` no greater than the requested increase.
Do not call any herdr_* tool, do not contact the orchestrator, and do not edit
anything else in this run.
`;
}

const VERDICT_BLOCK = /\[Budget Audit Verdict:\s*(\d+)\]\s*\n\s*\nverdict:\s*(grant|partial|deny)[ \t]*(?:\n[ \t]*granted_tokens:[ \t]*(\d{1,15})[ \t]*)?\s*$/;

/**
 * Verdict parsing mirrors the assignment completion block: an exact trailing
 * block, or nothing. A malformed or absent verdict is never read generously —
 * the run stays parked and the audit is retried.
 */
export function parseVerdict(document: string, ordinal: number): { verdict: BudgetVerdict; granted_tokens?: number } | undefined {
  const match = VERDICT_BLOCK.exec(document.replace(/```\s*$/, "").trimEnd());
  if (!match || Number(match[1]) !== ordinal) return undefined;
  const verdict = match[2];
  if (verdict !== "partial") return { verdict: verdict === "grant" ? "grant" : "deny" };
  const granted = match[3] === undefined ? undefined : Number(match[3]);
  if (granted === undefined || !Number.isSafeInteger(granted) || granted <= 0) return undefined;
  return { verdict: "partial", granted_tokens: granted };
}

export async function readAuditDocument(auditPath: string): Promise<{ document: string; sha256: string } | undefined> {
  try {
    const bytes = await readFile(auditPath);
    return { document: bytes.toString("utf8"), sha256: sha256(bytes) };
  } catch {
    return undefined;
  }
}

/** Pane status marker for the supervision surface (decision 4). */
export function orchPaneLabel(run: RunRef, record: BudgetRecord): string {
  const status = record.state === "parked"
    ? ` budget-parked${record.park_reason ? `:${record.park_reason}` : ""}`
    : record.approach_warned ? " budget-approaching" : "";
  return `ORCH ${run.track_id}/${run.run_id}${status}`;
}
