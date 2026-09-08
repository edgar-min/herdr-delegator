import { createReadStream } from "node:fs";
import { appendFile, lstat, readdir, readFile, writeFile } from "node:fs/promises";
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
  type BudgetAppliedState,
  type BudgetExtension,
  type BudgetJustification,
  type BudgetMetering,
  type BudgetParkReason,
  type BudgetRecord,
  type BudgetVerdict,
  type DelegationRegistry,
  type EmergencyClaim,
  type EmergencyVerdict,
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
export function emergencyAuditPath(runPath: string, ordinal: number): string { return path.join(runPath, `emergency-audit-${ordinal}.md`); }

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

/**
 * Same bounded-line discipline as the justification above, and for the same
 * reason: these two lines are rendered verbatim into a document a clean auditor
 * has to read, so the published 500-character single-line limit is enforced here
 * rather than left to the transport ceiling.
 */
export function normalizeEmergencyClaim(claim: EmergencyClaim): EmergencyClaim {
  return { failure: boundedLine(claim.failure, "emergency.failure"), why_now: boundedLine(claim.why_now, "emergency.why_now") };
}

/** The seed is a declared estimate; a run that declares none still gets a bounded default. */
export function seedBudget(mandate: Mandate | undefined, startedAt: string): BudgetRecord {
  const seed = mandate?.budget;
  const tokens = seed?.tokens && seed.tokens > 0 && seed.tokens <= MAX_BUDGET_TOKENS ? seed.tokens : DEFAULT_BUDGET_TOKENS;
  const minutes = seed?.minutes && seed.minutes > 0 && seed.minutes <= MAX_BUDGET_MINUTES ? seed.minutes : DEFAULT_BUDGET_MINUTES;
  return {
    seed_tokens: tokens,
    seed_minutes: minutes,
    // The `full`-policy minutes ceiling starts at the seed, exactly as the
    // token ceiling does: under `full` a verdict alone raises neither axis.
    minutes_floor: minutes,
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
 * What a verdict alone may not exceed, per axis. Under `notify` there is no such
 * bound — the audit is the authority and the granted figure IS the ceiling.
 * Under `full` the human approves every extension by raising the clamp, so the
 * granted figure is held at this floor until they do: `seed_tokens` on the token
 * axis, `minutes_floor` on the wall-clock axis. The two used to disagree — the
 * token axis held at the seed while the minutes axis simply followed
 * `granted_minutes` — which is why a `full` run could be parked on
 * `approval-required` for tokens while its minutes rose with no approval at all
 * (friction 09470253737e9da6).
 */
export function policyFloor(record: BudgetRecord): { tokens: number; minutes: number } {
  return { tokens: record.seed_tokens, minutes: record.minutes_floor ?? record.seed_minutes };
}

/**
 * Effective ceiling. A clamp bound, when present, is the human-set ABSOLUTE
 * ceiling: cap = clamp value, even above the granted figure — raising the clamp
 * releases a denied/approval-required/over-cap park on the next guarded op, and
 * 0 stays the kill switch. An absent bound falls back to the granted figure,
 * held at this policy's floor on both axes alike.
 */
export function effectiveCap(record: BudgetRecord, clamp: BudgetClamp | undefined): { cap_tokens: number; cap_minutes: number } {
  const floor = policyFloor(record);
  const full = record.doorbell_policy === "full";
  const tokensCeiling = clamp?.max_tokens ?? (full ? Math.min(record.granted_tokens, floor.tokens) : record.granted_tokens);
  const minutesCeiling = clamp?.max_minutes ?? (full ? Math.min(record.granted_minutes, floor.minutes) : record.granted_minutes);
  return { cap_tokens: Math.max(0, tokensCeiling), cap_minutes: Math.max(0, minutesCeiling) };
}

/** Covenant: one extension may raise the cap by at most half of what is already granted. */
export function stepCap(record: BudgetRecord): number {
  return Math.max(1, Math.floor(record.granted_tokens * BUDGET_STEP_FRACTION));
}

/** The same covenant on the wall-clock axis, so neither axis can outrun the other. */
export function minutesStepCap(record: BudgetRecord): number {
  return Math.max(1, Math.floor(record.granted_minutes * BUDGET_STEP_FRACTION));
}

/**
 * The request this extension actually carries, per axis. An omitted axis falls
 * back to ITS OWN step rather than to zero, because a grant moves both
 * dimensions (BUD-010): wall clock keeps accruing while a run is parked, so a
 * token-only grant would leave a minutes-parked run parked forever. An
 * over-ambitious ask is TRUNCATED to the step, never refused — the covenant is a
 * ceiling on what one extension may buy, not a grammar the caller must guess.
 */
export function requestedAxes(record: BudgetRecord, tokens: number | undefined, minutes: number | undefined): { tokens: number; minutes: number } {
  return {
    tokens: Math.min(tokens ?? stepCap(record), stepCap(record)),
    minutes: Math.min(minutes ?? minutesStepCap(record), minutesStepCap(record)),
  };
}

// ---------------------------------------------------------------------------
// Was the approval APPLIED? (friction 09470253737e9da6, 2c8f859d4875bbc0)
//
// The verdict and its application are different facts, and the machine used to
// record only the first: a settled `grant` of 600000 tokens sat beside an
// effective cap of 400000 and a standing `approval-required` park, with no field
// anywhere saying which of the two was in force. `applied` is that field, per
// axis, and its whole discriminator is observable: does the axis ceiling carry
// the granted figure? When it does not, the state NAMES THE CAUSE — the human
// has to raise the clamp, a human pin sits below the figure, or the server's own
// write did not land.
//
// `applied` is never a cap and never a park reason. `usable` below is the
// separate observation of the moment, so a grant can read `awaiting-clamp` while
// its axis is still perfectly usable because the human's ceiling was already
// high enough — which is exactly the case a single conflated field got wrong.
// ---------------------------------------------------------------------------

export type BudgetAxis = "tokens" | "minutes";
export type AppliedAxes = { tokens: BudgetAppliedState; minutes: BudgetAppliedState };

/**
 * Derives one axis from the live clamp and policy. The order is the contract:
 *
 * 1. Nothing granted on this axis, or no grant at all -> `none`.
 * 2. An unreadable clamp -> `awaiting-clamp`, BEFORE any cap comparison: a cap
 *    computed without the human's file is not a fact about their ceiling.
 * 3. A human pin below the granted figure -> `pinned`. A pin ABOVE it withholds
 *    nothing and falls through to the cap comparison.
 * 4. An owed server write -> `write-owed`, ALSO before the cap comparison. Under
 *    `notify` with no ceiling on disk the cap already equals the granted figure,
 *    so the comparison would read `applied` while the human-visible file still
 *    does not show the approval — the exact invisibility the write exists to fix.
 * 5. The axis ceiling carries the granted figure -> `applied`.
 * 6. Otherwise the ceiling is below it, so name what holds it down: under `full`
 *    the human has not applied the approval yet, and under `notify` a present
 *    `max_minutes` is theirs (the server never writes that axis).
 */
function deriveApplied(record: BudgetRecord, extension: BudgetExtension, reading: ClampReading, axis: BudgetAxis): BudgetAppliedState {
  if (extension.state !== "settled" || extension.verdict === undefined || extension.verdict === "deny") return "none";
  // An extension recorded before v5 carries no minutes figures even though it
  // did move `granted_minutes`, so `undefined` means "not recorded", never zero.
  const requested = axis === "tokens" ? extension.requested_tokens : extension.requested_minutes;
  const granted = axis === "tokens" ? extension.granted_tokens : extension.granted_minutes;
  if (requested === 0 || granted === 0) return "none";
  if (reading.unreadable) return "awaiting-clamp";
  const caps = effectiveCap(record, reading.clamp);
  const cap = axis === "tokens" ? caps.cap_tokens : caps.cap_minutes;
  const grantedTotal = axis === "tokens" ? record.granted_tokens : record.granted_minutes;
  if (axis === "tokens" && record.doorbell_policy === "notify") {
    if (cap < grantedTotal && clampTokensPinned(reading.clamp?.max_tokens, record)) return "pinned";
    const slots = record.server_clamp_tokens;
    if (slots?.intended !== undefined && slots.intended !== slots.confirmed) return "write-owed";
  }
  if (cap >= grantedTotal) return "applied";
  if (record.doorbell_policy === "full") return "awaiting-clamp";
  return axis === "minutes" && reading.clamp?.max_minutes !== undefined ? "pinned" : "awaiting-clamp";
}

/**
 * The recorded state where it is terminal, the derivation where it is not.
 * `applied` and `none` are settled history on a disposed extension: a human
 * lowering the clamp later does not retroactively un-apply a grant that was in
 * force. The three transient states are re-derived at every observation, and the
 * next guarded mutation writes the derivation back (`refreshApplied`).
 *
 * A `pending` extension is never terminal. It has bought nothing yet, so it
 * derives `none`, and honoring that as history would freeze the axis at `none`
 * for the grant that lands one call later.
 */
export function projectApplied(record: BudgetRecord, extension: BudgetExtension, reading: ClampReading): AppliedAxes {
  const axis = (name: BudgetAxis): BudgetAppliedState => {
    const stored = extension.applied?.[name];
    const terminal = extension.state !== "pending" && (stored === "applied" || stored === "none");
    return terminal && stored !== undefined ? stored : deriveApplied(record, extension, reading, name);
  };
  return { tokens: axis("tokens"), minutes: axis("minutes") };
}

/**
 * Writes every disposed extension's projection into the record, and reports
 * whether anything actually changed so a caller can skip a registry write that
 * would only bump the revision. It converges: the two terminal states are never
 * re-derived, so a settled run stops producing changes. A `pending` extension is
 * skipped entirely — recording an application for an undecided request would be
 * the same conflation of decision and effect this field exists to end.
 */
export function refreshApplied(record: BudgetRecord, reading: ClampReading): boolean {
  let changed = false;
  for (const extension of record.extensions) {
    if (extension.state === "pending") continue;
    const projected = projectApplied(record, extension, reading);
    if (extension.applied?.tokens === projected.tokens && extension.applied.minutes === projected.minutes) continue;
    extension.applied = projected;
    changed = true;
  }
  return changed;
}

/**
 * Usability at the observed moment, per axis, and deliberately independent of
 * `applied`: this is `usage < effective cap`, the same predicate the park
 * judgment uses, so a surface can never report a usable axis as unusable
 * because an approval has not been written down yet.
 */
export function usableAxes(metering: BudgetMetering): { tokens: boolean; minutes: boolean } {
  return { tokens: metering.judged_tokens < metering.cap_tokens, minutes: metering.elapsed_minutes < metering.cap_minutes };
}

export type RequiredClamp = { field: "max_tokens" | "max_minutes"; value: number };

/**
 * The exact clamp field and VALUE a human must write to release this park, for
 * every axis that is over its ceiling while an approved figure sits above it.
 * The missing half of the old recovery text: it named the file and the verb and
 * left the reader to derive the number (friction 09470253737e9da6). An axis
 * whose ceiling already carries the granted figure is omitted — there is nothing
 * to write, and the route is another extension.
 */
export function requiredClamp(record: BudgetRecord, metering: BudgetMetering): RequiredClamp[] {
  const required: RequiredClamp[] = [];
  if (metering.judged_tokens >= metering.cap_tokens && record.granted_tokens > metering.cap_tokens) {
    required.push({ field: "max_tokens", value: record.granted_tokens });
  }
  if (metering.elapsed_minutes >= metering.cap_minutes && record.granted_minutes > metering.cap_minutes) {
    required.push({ field: "max_minutes", value: record.granted_minutes });
  }
  return required;
}

/**
 * One line naming what releases the run and WHERE that happens. `inspect` is
 * read-only, so nothing an observation reports can itself unpark: the transition
 * belongs to the next guarded op that judges the budget (Q11).
 */
export function releaseCondition(runPath: string, record: BudgetRecord, required: readonly RequiredClamp[]): string {
  const nextOp = "the next guarded op that judges the budget (assignment add or wait, worker close, track close, or budget_extend, which re-judges before its own gates) — never from inspect, which only reads";
  if (record.state !== "parked") return `Nothing is pending: the run is active, and the ceiling is re-judged at ${nextOp}.`;
  if (required.length) {
    return `A human writes ${required.map((entry) => `${entry.field} ${entry.value}`).join(" and ")} into ${budgetClampPath(runPath)}, and the park lifts at ${nextOp}.`;
  }
  if (record.park_reason === "clamp-unreadable") return `A human repairs ${budgetClampPath(runPath)} so it parses, and the park lifts at ${nextOp}.`;
  if (record.park_reason === "audit-unavailable") return `A fresh budget_extend lands a verdict, or a human raises ${budgetClampPath(runPath)}; either way the park lifts at ${nextOp}.`;
  return `Spend falls back under the effective cap, or a granted extension raises it; the park lifts at ${nextOp}.`;
}

/**
 * What every surface reports about one moment of the approval machine. It is a
 * named shape rather than a loose object because two surfaces must agree field
 * for field: `budget_extend`'s response and the `inspect` that follows it.
 */
export type BudgetApprovalView = {
  state: BudgetRecord["state"];
  park_reason?: BudgetParkReason;
  /** The latest extension's audit disposition, or why there is none. */
  verdict: { ordinal: number; state: BudgetExtension["state"]; verdict?: BudgetVerdict } | string;
  granted: { tokens: number; minutes: number };
  effective_cap: { tokens: number; minutes: number };
  approval_floor: { tokens: number; minutes: number };
  usage: { tokens: number; minutes: number };
  applied: AppliedAxes;
  usable: { tokens: boolean; minutes: boolean };
  required_clamp?: RequiredClamp[];
  release_condition: string;
};

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
  runPath: string,
  record: BudgetRecord,
  justification: BudgetJustification,
  requested: { tokens: number; minutes: number },
  metering: BudgetMetering,
  machineFacts: readonly string[],
): string {
  const granted = record.extensions.filter((entry) => entry.verdict === "grant" || entry.verdict === "partial").length;
  // An auditor judging an extension under a human pin must know that the token
  // ceiling cannot rise no matter what it grants: the effective cap is the
  // human's number, and only a minutes raise buys the run anything.
  const pinned = clampTokensPinned(metering.clamp?.max_tokens, record);
  const floor = policyFloor(record);
  const capLine = pinned
    ? `- effective cap: ${metering.cap_tokens} tokens / ${metering.cap_minutes} min — the token ceiling is PINNED by the human in ${metering.clamp?.path ?? "the clamp file"}, so a token grant moves the registry figure above and CANNOT raise the effective token cap; only the wall-clock dimension a grant also moves can buy this run anything.\n`
    : record.doorbell_policy === "full"
      ? `- effective cap: ${metering.cap_tokens} tokens / ${metering.cap_minutes} min — the doorbell policy is \`full\`, so on BOTH axes your verdict alone raises nothing above this run's approval floor (${floor.tokens} tokens / ${floor.minutes} min): a grant records the figure and the human applies it by writing max_tokens / max_minutes into ${metering.clamp?.path ?? "the clamp file"}.\n`
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

- requested increase: ${requested.tokens} tokens (step cap ${stepCap(record)}) and ${requested.minutes} min (step cap ${minutesStepCap(record)})
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

Every document named here is a real file inside this run's directory,
\`${runPath}\`, and you read it with your ordinary file tools: read
\`orchestrator-instructions.md\` (the mandate), \`plan.md\`, \`budget-ledger.md\`,
and every \`a2a/w<N>-report.md\` under that path. A \`local://\` or session-scoped
URL is NOT how these are reached — you have no session history with this run, so
that form would resolve to nothing. Then decide:

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

Use \`grant\`, \`partial\`, or \`deny\` on that line.

A \`grant\` approves the whole request on BOTH axes; a \`deny\` approves nothing
on either. A \`partial\` is per axis, and it needs one line for every axis it
cuts: \`granted_tokens: <integer>\` and/or \`granted_minutes: <integer>\`, each
greater than zero and no greater than that axis's requested increase above. An
axis you leave out of a \`partial\` is approved in full — so cutting the spend
while leaving the wall clock alone means writing only \`granted_tokens\`, and a
\`partial\` needs at least \`granted_tokens\`. A figure above the request is
truncated to the request; zero or a negative figure is not a partial grant and
leaves this document unparsed, so use \`deny\` to approve nothing.

Write each figure as plain decimal digits — no sign, no padding, no separators,
no units. This block is read as an exact trailing match or not at all, and an
unparsed document grants nothing and leaves the run parked for another attempt:
a repeated axis line, a key other than these two, a figure that is not plain
digits, a \`partial\` without \`granted_tokens\`, a wrong audit number in the
header, or anything at all after the block all read as no verdict.

Both lines are ignored on \`grant\` and on \`deny\`, where the disposition
already fixes both axes.

Then ring the orchestrator once, and only after the block is written:
\`herdr_message {action: "wake_orch_audit", track_id: "${run.track_id}", run_id: "${run.run_id}"}\`.
That bell carries no content and no authority — THIS document stays the sole
authority for your verdict, and the server reads the verdict from this file and
never from the bell. It exists so the orchestrator learns the verdict landed
instead of polling for it; a bell rung before the block, or rung twice, tells it
something untrue. Make no other herdr_* call, do not otherwise contact the
orchestrator, and do not edit anything else in this run.
`;
}

// Both figures are optional trailing lines, in either order, at most once each.
// The whole block is still an exact trailing match or nothing: an auditor that
// invents a third key, repeats one, or writes a non-integer leaves this
// document unparsed and the run parked, which is the same fail-closed reading
// the token axis has always had.
const VERDICT_BLOCK = /\[Budget Audit Verdict:\s*(\d+)\]\s*\n\s*\nverdict:\s*(grant|partial|deny)[ \t]*((?:\n[ \t]*granted_(?:tokens|minutes):[ \t]*\d{1,15}[ \t]*)*)\s*$/;
const GRANTED_LINE = /^[ \t]*granted_(tokens|minutes):[ \t]*(\d{1,15})[ \t]*$/;

/**
 * Verdict parsing mirrors the assignment completion block: an exact trailing
 * block, or nothing. A malformed or absent verdict is never read generously —
 * the run stays parked and the audit is retried.
 *
 * A `partial` is per axis (friction 2c8f859d4875bbc0): it MUST carry
 * `granted_tokens`, MAY carry `granted_minutes`, and an axis it omits is
 * approved in full. `grant` and `deny` ignore both figures, because the
 * disposition already fixes both axes — which is also what keeps every audit
 * document written before this lever existed parsing exactly as it did.
 */
export function parseVerdict(document: string, ordinal: number): { verdict: BudgetVerdict; granted_tokens?: number; granted_minutes?: number } | undefined {
  const match = VERDICT_BLOCK.exec(document.replace(/```\s*$/, "").trimEnd());
  if (!match || Number(match[1]) !== ordinal) return undefined;
  const verdict = match[2];
  if (verdict !== "partial") return { verdict: verdict === "grant" ? "grant" : "deny" };
  let tokens: number | undefined;
  let minutes: number | undefined;
  for (const line of match[3].split("\n")) {
    if (!line.trim()) continue;
    const figure = GRANTED_LINE.exec(line);
    if (!figure) return undefined;
    const value = Number(figure[2]);
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    // A repeated key is two answers to one question, so it is no answer.
    if (figure[1] === "tokens") {
      if (tokens !== undefined) return undefined;
      tokens = value;
    } else {
      if (minutes !== undefined) return undefined;
      minutes = value;
    }
  }
  if (tokens === undefined) return undefined;
  return { verdict: "partial", granted_tokens: tokens, ...(minutes === undefined ? {} : { granted_minutes: minutes }) };
}

export async function readAuditDocument(auditPath: string): Promise<{ document: string; sha256: string } | undefined> {
  try {
    const bytes = await readFile(auditPath);
    return { document: bytes.toString("utf8"), sha256: sha256(bytes) };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The emergency carve-out (BUD-016, friction 8917760a9545c642). A run parked on
// the cadence reason `over-cap` still has to be able to register the repair of
// the failure that parked it; the alternative the machine offered was a human
// raising the clamp, or opening a whole second track (NG-013).
//
// The obligation this creates is persisted as a DOCUMENT, not as a registry
// field. That is the load-bearing choice: `emergency-audit-<n>.md` existing
// without a verdict block IS the open debt, so nothing widens the registry's key
// set, no schema version moves, and a server built before this feature reads the
// same registry unchanged and simply refuses the add as it always did. A derived
// predicate over existing keys was tried first and rejected: `parked_at` is
// re-stamped whenever the park reason changes, so one `over-cap` ->
// `audit-unavailable` -> `over-cap` round trip would have silently erased the
// debt.
//
// What the audit can and cannot do is fixed by what the machine can do at all.
// There is no cancel action, no forced close of a working lane, and no way to
// un-spend tokens, so an `unjustified` verdict recalls nothing. Its whole
// sanction is prospective: the carve-out closes for this run and the next budget
// decision belongs to the human. Every surface says so, because a safeguard that
// only reads like one is worse than none.
// ---------------------------------------------------------------------------

export type EmergencyAudit = { ordinal: number; path: string; verdict?: EmergencyVerdict };
export type EmergencyDebt = { ordinal: number; path: string };

// Bounded on both ends: the ordinal is server-allocated, and a run that somehow
// accumulated four digits of emergency audits has a problem no scan should try
// to enumerate.
const EMERGENCY_AUDIT_NAME = /^emergency-audit-([1-9][0-9]{0,3})\.md$/;
export const EMERGENCY_VERDICT_BLOCK = /\[Emergency Audit Verdict:\s*(\d+)\]\s*\n\s*\nverdict:\s*(justified|unjustified)[ \t]*\s*$/;

/**
 * Same grammar discipline as `parseVerdict`, and deliberately a different
 * vocabulary: a `grant` line in an emergency document parses as nothing, so the
 * two audits can never be read into each other's disposition.
 */
export function parseEmergencyVerdict(document: string, ordinal: number): EmergencyVerdict | undefined {
  const match = EMERGENCY_VERDICT_BLOCK.exec(document.replace(/```\s*$/, "").trimEnd());
  if (!match || Number(match[1]) !== ordinal) return undefined;
  return match[2] === "justified" ? "justified" : "unjustified";
}

/** Every emergency audit document in the run, ascending, each with its verdict if one landed. */
export async function scanEmergencyAudits(runPath: string): Promise<EmergencyAudit[]> {
  let entries: string[];
  try {
    entries = await readdir(runPath);
  } catch {
    return [];
  }
  const audits: EmergencyAudit[] = [];
  for (const name of entries) {
    const match = EMERGENCY_AUDIT_NAME.exec(name);
    if (!match) continue;
    const ordinal = Number(match[1]);
    const auditPath = path.join(runPath, name);
    const read = await readAuditDocument(auditPath);
    const verdict = read ? parseEmergencyVerdict(read.document, ordinal) : undefined;
    audits.push({ ordinal, path: auditPath, ...(verdict ? { verdict } : {}) });
  }
  return audits.sort((left, right) => left.ordinal - right.ordinal);
}

/**
 * The open obligation, or nothing. Both this and `carveOutClosed` accept an
 * already-taken scan so a single judgment does not re-read the same documents
 * three times; called with a path alone, each is self-contained.
 */
export async function scanEmergencyDebt(runPath: string, scanned?: readonly EmergencyAudit[]): Promise<EmergencyDebt | undefined> {
  const audits = scanned ?? await scanEmergencyAudits(runPath);
  const open = audits.find((audit) => audit.verdict === undefined);
  return open ? { ordinal: open.ordinal, path: open.path } : undefined;
}

/**
 * Whether the carve-out is permanently closed for this run. There is no persisted
 * flag: the `unjustified` verdict written in the document is itself the ground,
 * and returning that document lets every refusal name the judgment it obeys
 * instead of asserting a state the reader cannot check.
 */
export async function carveOutClosed(runPath: string, scanned?: readonly EmergencyAudit[]): Promise<EmergencyDebt | undefined> {
  const audits = scanned ?? await scanEmergencyAudits(runPath);
  const closing = audits.find((audit) => audit.verdict === "unjustified");
  return closing ? { ordinal: closing.ordinal, path: closing.path } : undefined;
}

/**
 * The whole admissibility judgment, pure so it can be read as one sentence: a
 * claim was made, no earlier claim is still unjudged, no earlier claim was
 * refused, and the park is the cadence park a machine ladder is allowed to judge.
 * Every other park reason is a human's decision or a broken machine, and passing
 * through one of those would route around the kill switch rather than around a
 * cadence.
 */
export function admitEmergencyAdd(
  parkReason: BudgetParkReason,
  claim: EmergencyClaim | undefined,
  debt: EmergencyDebt | undefined,
  closed: boolean,
): boolean {
  return claim !== undefined && debt === undefined && !closed && parkReason === "over-cap";
}

/**
 * Creates the audit document, create-exclusive. This is also the concurrency
 * arbiter: the registry lock covers `delegation.json` alone, so two adds can both
 * pass the scan, and the one whose `wx` write fails is the one that lost.
 */
export async function createEmergencyAudit(runPath: string, ordinal: number, body: string): Promise<boolean> {
  try {
    await writeFile(emergencyAuditPath(runPath, ordinal), body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The emergency auditor's input document. Same shape as the budget audit: the
 * server writes the request and the machine facts, the auditor appends its
 * reasoning and verdict to the same file, and the ORCH neither writes nor reads
 * it as authority.
 */
export function renderEmergencyAuditInput(
  run: RunRef,
  ordinal: number,
  runPath: string,
  assignmentId: string,
  claim: EmergencyClaim,
  record: BudgetRecord,
  metering: BudgetMetering,
  machineFacts: readonly string[],
): string {
  return `---
version: 1
track_id: ${run.track_id}
run_id: ${run.run_id}
emergency_audit: ${ordinal}
assignment_id: ${assignmentId}
---

# Emergency audit ${ordinal} — ${run.track_id}/${run.run_id}

You are a clean auditor session. You have no history with this run and you never
speak to its orchestrator except for the single bell named at the end of this
document.

This run was budget-parked when assignment ${assignmentId} was registered. The
orchestrator claimed an emergency carve-out, and the registration went through
BEFORE you judged it. You are judging it after the fact.

Your verdict recalls nothing. There is no cancel action, no forced close of a
working lane, and no way to un-spend what was spent. What your verdict decides is
prospective, and it is the entire sanction available:

- \`justified\` — the carve-out stays open, so a later emergency in this run can
  use it once more.
- \`unjustified\` — the carve-out closes permanently for this run: no further
  emergency registration is admissible, and this run's budget decisions belong to
  the human from here.

## The claim

- failure: ${claim.failure}
- why now: ${claim.why_now}

## Machine facts

- ${meteringLedgerLine(metering)}
- park at registration: ${record.state}${record.park_reason ? ` (${record.park_reason})` : ""}${record.park_detail ? ` — ${record.park_detail}` : ""}
- cap: ${record.granted_tokens} tokens / ${record.granted_minutes} min (seed ${record.seed_tokens} / ${record.seed_minutes}); extensions recorded: ${record.extensions.length}
${machineFacts.map((fact) => `- ${fact}`).join("\n")}

## What to judge

Every document named here is a real file inside this run's directory,
\`${runPath}\`, read with your ordinary file tools: this run's
\`orchestrator-instructions.md\` (the mandate), \`plan.md\`, \`budget-ledger.md\`,
and every \`a2a/w<N>-report.md\` under that path. A \`local://\` or session-scoped
URL resolves to nothing here, because you have no session history with this run.
Then decide:

1. Does \`failure\` name an operational failure that blocks the run itself —
   something broken — rather than work the run simply wants to continue? Wanting
   to keep going is what the extension ladder is for, and it is not an emergency.
2. Does \`why_now\` follow from that failure? Registering this assignment while
   parked has to have been the repair; if \`budget_extend\` or the human raising
   the clamp would have served, the claim was not admissible.
3. Do the run documents match the machine facts, or is the narrative stale?

## Your verdict

Append your bounded reasoning, then exactly this block as the last thing in this
file, with nothing after it:

[Emergency Audit Verdict: ${ordinal}]

verdict: justified

Use \`justified\` or \`unjustified\` on that line; there is no partial verdict,
because a registration either was that repair or was not.

Then ring the orchestrator once, and only after the block is written:
\`herdr_message {action: "wake_orch_audit", track_id: "${run.track_id}", run_id: "${run.run_id}"}\`.
That bell carries no content and no authority — THIS document stays the sole
authority for your verdict, and the server reads the verdict from this file and
never from the bell. Make no other herdr_* call, do not otherwise contact the
orchestrator, and do not edit anything else in this run.
`;
}

/** Pane status marker for the supervision surface (decision 4). */
export function orchPaneLabel(run: RunRef, record: BudgetRecord): string {
  const status = record.state === "parked"
    ? ` budget-parked${record.park_reason ? `:${record.park_reason}` : ""}`
    : record.approach_warned ? " budget-approaching" : "";
  return `ORCH ${run.track_id}/${run.run_id}${status}`;
}
