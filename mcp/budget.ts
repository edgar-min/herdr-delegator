import { createReadStream } from "node:fs";
import { appendFile, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { writeAtomic } from "../io.github.edgar-min.herdr-delegator/extensions/lib/config";
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

// Both notes carry the real contract, including the retype exception: a human
// who cannot read the pin rule off the file they own has no way to know that
// re-typing a number the machine recorded hands the ceiling back to it.
const CLAMP_PIN_CONTRACT = "human edits to max_tokens pin the ceiling — except values equal to the machine's recorded ceilings, which are treated as machine-written; delete max_tokens to hand it back — the next approved grant resumes automatic raises (a ceiling already approved whose write crashed, and that no pin has since touched, may be restored at the next tool call)";
// The note must stay inside the clamp schema's own 500-character bound: a note
// the server cannot read back would park the run it was written to protect.
const CLAMP_SCAFFOLD_NOTE = `Human-owned; no agent may edit this file. Set max_tokens and/or max_minutes; 0 kills the run. Raising max_tokens above judged spend releases a park. ${CLAMP_PIN_CONTRACT}.`;
const CLAMP_SCHEMA = "{version:1, max_tokens?, max_minutes?, note?}";

/** Deterministic (no timestamp) server note: the same audit rewrites the same bytes. */
function clampServerNote(auditOrdinal: number): string {
  return `Server-written after budget audit ${auditOrdinal}: max_tokens is the approved ceiling. Human-owned; ${CLAMP_PIN_CONTRACT}.`;
}

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

// ---------------------------------------------------------------------------
// The clamp's token axis: who wrote `max_tokens`, and may the server write it?
//
// A grant that never reaches the human-visible clamp file is invisible, and
// because a present `max_tokens` is an ABSOLUTE override of `granted_tokens`
// (`effectiveCap`), a clamp that never moves silently caps every future
// approval. So the server keeps the file in step with the grants it made — but
// it rewrites `max_tokens` only where the value on disk is absent or is one of
// the token values it recorded. The judgment is by VALUE, never by a byte
// fingerprint of the file: a human edit to `max_minutes` or `note` expresses no
// opinion about the token ceiling and must not pin it.
//
// `server_clamp_tokens` holds the two values identity is judged against:
// `confirmed` (the last value a write is known to have landed) and `intended`
// (the value a settled, write-permitted grant owes the file). INVARIANT, both
// directions: whenever the server wrote the disk's `max_tokens`, that value is a
// member of {confirmed, intended}; and every member is a value the server wrote
// to disk or is currently owed by a permitted, settled grant. "Owed by a settled
// but REFUSED grant" is not a state this machine can hold: the grant path
// records `intended` only when a pre-settle classification permits a write, and
// the clear-on-skip plus the clear-heal below drain the read race.
//
// A present `max_tokens` equal to neither member is the human's own opinion
// about the ceiling: a permanent pin, `0` included. Accepted edge, disclosed in
// both clamp notes: a human who types a value equal to a recorded ceiling has
// restored a number the machine itself wrote or owes, and it reads as
// machine-written. A human ceiling must be a different number than both; the
// kill switch `0` is always below them and can never be misread. Authorship is
// never claimed to be proved (SPEC NG-014) — the classification is "not
// provably server-authored", not a proof of who typed what.
// ---------------------------------------------------------------------------

export type ClampTokenClass = "unreadable" | "open" | "server-authored" | "pinned";

/** Presence, never truthiness: `0` is present and is the kill switch. */
export function clampTokensPinned(maxTokens: number | undefined, record: BudgetRecord): boolean {
  if (maxTokens === undefined) return false;
  const slots = record.server_clamp_tokens;
  return maxTokens !== slots?.confirmed && maxTokens !== slots?.intended;
}

/** Classification over ONE clamp reading. An unreadable reading is skipped, never classified. */
export function classifyClampTokens(reading: ClampReading, record: BudgetRecord): ClampTokenClass {
  if (reading.unreadable) return "unreadable";
  const disk = reading.clamp?.max_tokens;
  if (disk === undefined) return "open";
  return clampTokensPinned(disk, record) ? "pinned" : "server-authored";
}

/**
 * Drains an owed ceiling the disk will not hold: `intended := confirmed`, which
 * DELETES `intended` when `confirmed` is absent. A clear guarded on `confirmed`
 * being present would latch the owed state forever after a first-write failure.
 */
export function clearOwedClampTokens(record: BudgetRecord): void {
  const slots = record.server_clamp_tokens;
  if (!slots) return;
  if (slots.confirmed === undefined) {
    delete record.server_clamp_tokens;
    return;
  }
  slots.intended = slots.confirmed;
}

/**
 * The two classification-time repairs. They live in the judgment every guarded
 * op makes, and that — not any within-call ordering — is what guarantees they
 * fire before a later grant can interleave:
 *   self-heal  — the disk holds `intended`, which proves the write landed and
 *                only the promotion of `confirmed` was lost.
 *   clear-heal — the disk is pinned while a write is still owed, so the owed
 *                value can never be honored and is drained instead. Symmetric
 *                with the self-heal and at the same site; the only state that
 *                matches it is the refused-grant read race, and after it fires
 *                nothing is owed, so no resurrection is possible.
 * Mutates `record` and returns the repair applied.
 */
export function healClampTokens(reading: ClampReading, record: BudgetRecord): "self-heal" | "clear-heal" | undefined {
  if (reading.unreadable) return undefined;
  const slots = record.server_clamp_tokens;
  if (slots?.intended === undefined || slots.intended === slots.confirmed) return undefined;
  const disk = reading.clamp?.max_tokens;
  if (disk !== undefined && disk === slots.intended) {
    slots.confirmed = slots.intended;
    return "self-heal";
  }
  if (clampTokensPinned(disk, record)) {
    clearOwedClampTokens(record);
    return "clear-heal";
  }
  return undefined;
}

/**
 * Whether a write is OWED right now — the write TRIGGER, a separate question
 * from whether a write is permitted. It fires only for a settled, permitted
 * grant whose write did not land: either the disk still shows the previously
 * confirmed value (the second-or-later crash window) or it shows nothing at all
 * with nothing ever confirmed (the first-ever failed write). A handback after a
 * successful write is excluded by `intended === confirmed`; a handback after a
 * FAILED write keeps `confirmed`, so a deleted `max_tokens` is respected until
 * the next grant. A pinned value never reconciles.
 */
export function clampReconcileValue(reading: ClampReading, record: BudgetRecord): number | undefined {
  if (reading.unreadable) return undefined;
  const slots = record.server_clamp_tokens;
  if (slots?.intended === undefined || slots.intended === slots.confirmed) return undefined;
  const disk = reading.clamp?.max_tokens;
  const secondOrLaterCrash = disk !== undefined && disk === slots.confirmed;
  const firstEverFailure = slots.confirmed === undefined && disk === undefined;
  return secondOrLaterCrash || firstEverFailure ? slots.intended : undefined;
}

export type ClampWriteOutcome =
  | { outcome: "written"; value: number }
  | { outcome: "skipped"; reason: "pinned" | "unreadable"; detail: string }
  | { outcome: "failed"; warning: string };

/**
 * Writes an approved token ceiling into the human-owned clamp.
 *
 * The helper OWNS the classifying read, so the read-then-rename window is one
 * syscall pair, and THAT reading — not any earlier prediction by a caller — is
 * authoritative for permission: a pin landing in between is caught here and
 * returns `skipped("pinned")`, fail-closed. The residual TOCTOU is named and
 * accepted; file locking is out of scope. `writeAtomic` is temp+rename, so a
 * failed write leaves the previous bytes intact and observable. This never
 * throws to its callers: a clamp write is a visibility repair, not a budget
 * transition, and must not turn a settled grant into an exception.
 */
export async function writeClampMaxTokens(runPath: string, value: number, record: BudgetRecord, auditOrdinal: number): Promise<ClampWriteOutcome> {
  const reading = await readClamp(runPath);
  const classification = classifyClampTokens(reading, record);
  if (classification === "unreadable") {
    return { outcome: "skipped", reason: "unreadable", detail: reading.unreadable ?? "the clamp file cannot be read" };
  }
  if (classification === "pinned") {
    return { outcome: "skipped", reason: "pinned", detail: `max_tokens ${reading.clamp?.max_tokens} is a human ceiling` };
  }
  const body = {
    version: 1,
    max_tokens: value,
    ...(reading.clamp?.max_minutes !== undefined ? { max_minutes: reading.clamp.max_minutes } : {}),
    note: clampServerNote(auditOrdinal),
  };
  try {
    await writeAtomic(budgetClampPath(runPath), `${JSON.stringify(body, null, 2)}\n`, 0o600);
    return { outcome: "written", value };
  } catch (error) {
    return {
      outcome: "failed",
      warning: `The approved ceiling ${value} could not be written to ${budgetClampPath(runPath)} (${error instanceof Error ? error.message : String(error)}). The previous bytes are intact and the write is retried at the next guarded op.`,
    };
  }
}

/**
 * Names the outcome on every grant-path invocation, and carries the retype
 * caution on a successful write: re-typing EITHER recorded ceiling — the number
 * just announced or the one before it — reads as machine-written, so a human
 * ceiling must be a different number than both.
 */
export function clampWriteLedgerLine(runPath: string, outcome: ClampWriteOutcome, previousCeiling: number | undefined): string {
  const clampPath = budgetClampPath(runPath);
  if (outcome.outcome === "written") {
    const recorded = previousCeiling === undefined || previousCeiling === outcome.value
      ? `${outcome.value}`
      : `${outcome.value} or ${previousCeiling}`;
    return `clamp write: max_tokens ${outcome.value} written to ${clampPath}; to pin the ceiling yourself use a number that is NOT ${recorded} — re-typing a ceiling the machine recorded reads as machine-written and the next approved grant may overwrite it`;
  }
  if (outcome.outcome === "skipped") {
    return `clamp write: skipped (${outcome.reason}) — ${outcome.detail}; ${clampPath} is unchanged and the token ceiling stays with the human`;
  }
  return `clamp write: failed — ${outcome.warning}`;
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
  // An auditor judging an extension under a human pin must know that the token
  // ceiling cannot rise no matter what it grants: the effective cap is the
  // human's number, and only a minutes raise buys the run anything.
  const pinned = clampTokensPinned(metering.clamp?.max_tokens, record);
  const capLine = pinned
    ? `- effective cap: ${metering.cap_tokens} tokens / ${metering.cap_minutes} min — the token ceiling is PINNED by the human in ${metering.clamp?.path ?? "the clamp file"}, so a token grant moves the registry figure above and CANNOT raise the effective token cap; only the wall-clock dimension a grant also moves can buy this run anything.\n`
    : `- effective cap: ${metering.cap_tokens} tokens / ${metering.cap_minutes} min — a grant raises the registry figure above, and the effective cap follows it unless the human's clamp file holds a lower ceiling.\n`;
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
${capLine}\
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
