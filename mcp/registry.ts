import { chmod, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, readRegistry, releaseLock } from "../io.github.edgar-min.herdr-delegator/extensions/lib/runtime";
import { resolveRunCoordinate, writeAtomic } from "../io.github.edgar-min.herdr-delegator/extensions/lib/config";
import { ASSIGNMENT_LABEL_RE, ASSIGNMENT_RE, ASSIGNMENT_REFERENCES_SECTION, ASSIGNMENT_SECTIONS, BOUNDED_TOKEN_RE, BUDGET_APPLIED_STATES, BUDGET_PARK_REASONS, BUDGET_VERDICTS, DELEGATION_VERSION, MAX_ASSIGNMENT_ARTIFACT_BYTES, MAX_ASSIGNMENT_BULLET, MAX_ASSIGNMENT_GOAL, MAX_ASSIGNMENT_LABEL, MAX_ASSIGNMENT_REFERENCE_BYTES, MAX_ASSIGNMENT_REFERENCE_PATH_BYTES, MAX_ASSIGNMENT_REFERENCES, MAX_ASSIGNMENT_SECTION_LINES, McpContractError, ORCH_BIRTH_ORIGINS, RESPONSIBILITY_RE, ROLE_RE, SHA256_RE, SUPPORTED_DELEGATION_VERSIONS, THINKING_LEVELS, WORKER_RE, nowIso, sha256, type AssignmentArtifact, type AssignmentRecord, type AssignmentState, type BudgetAppliedState, type BudgetExtension, type BudgetParkReason, type BudgetRecord, type BudgetVerdict, type DelegationRegistry, type OrchBirthOrigin, type OrchBirthRecord, type OrchCreatorRecord, type PinnedRolesRecord, type ResponsibilityRecord, type Separation, type WorkerLaneRecord } from "./contracts";

const ASSIGNMENT_STATES: Record<AssignmentState, true> = {
  queued: true,
  prompting: true,
  working: true,
  blocked: true,
  completed: true,
  failed: true,
  ambiguous: true,
};

/**
 * The mounted build's own identity, for results that must name the code that
 * produced them. The installed plugin is a symlink to a working tree, so a
 * repo edit stales every live session's already-mounted server while the
 * rebind (`/reload-plugins`) stays a human step in OMP core — and a stale
 * server used to fail opaquely (friction f53892758a860acf).
 *
 * `version` and `started_at` are captured at module load, so they describe the
 * mounted code rather than the tree as it looks now; `source_newest_mtime` is
 * read per call from the directories this server actually loads code from.
 * `source_newer_than_process` is therefore proof, not a guess: source that
 * postdates the process is source this process never loaded.
 */
export type MountedBuild = {
  version: string;
  started_at: string;
  source_newest_mtime?: string;
  source_newer_than_process?: boolean;
};

const SOURCE_ROOTS = ["mcp", path.join("io.github.edgar-min.herdr-delegator", "extensions", "lib")] as const;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mountedVersion = ((): string => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return isRecord(parsed) && typeof parsed.version === "string" && parsed.version ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
})();
const mountedStartedAtMs = Date.now();

export function mountedBuild(): MountedBuild {
  const build: MountedBuild = { version: mountedVersion, started_at: new Date(mountedStartedAtMs).toISOString() };
  let newest = 0;
  for (const root of SOURCE_ROOTS) {
    const directory = path.join(packageRoot, root);
    let entries: string[];
    try { entries = readdirSync(directory); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;
      try { newest = Math.max(newest, statSync(path.join(directory, entry)).mtimeMs); } catch { /* skip unreadable entry */ }
    }
  }
  if (newest > 0) {
    build.source_newest_mtime = new Date(newest).toISOString();
    build.source_newer_than_process = newest > mountedStartedAtMs;
  }
  return build;
}

// `expected_provider` / `expected_model` / `effective_thinking` on a lane are
// OBSERVATIONS of what the child session reported, not predictions
// (221abf10d2280b47); `onlyKeys` tolerates their absence on a lane that has not
// reported yet, and their presence on records written before the change.
const LANE_KEYS = ["worker_id", "responsibility_key", "lane_generation", "separation", "active_assignment_id", "queued_assignment_ids", "last_completed_assignment_id", "state", "state_change_seq", "official_session_id", "official_session_path", "expected_provider", "expected_model", "effective_thinking", "created_at", "updated_at"] as const;
const ASSIGNMENT_KEYS = ["assignment_id", "responsibility_key", "worker_id", "state", "instructions_sha256", "prompted_at", "report_sha256", "completed_at", "elapsed_ms", "token_usage", "advisory_unowned_changes", "ambiguous_operation", "ambiguous_state_change_seq", "references", "reported_boundary", "created_at", "updated_at"] as const;
const BIRTH_KEYS = ["generation", "official_session_id", "official_session_path", "pane_id", "origin", "approval_sha256", "born_at"] as const;

function validOrchBirth(value: unknown, index: number): value is OrchBirthRecord {
  return isRecord(value) &&
    onlyKeys(value, BIRTH_KEYS) &&
    value.generation === index + 1 &&
    typeof value.official_session_id === "string" && value.official_session_id.length <= 80 && BOUNDED_TOKEN_RE.test(value.official_session_id) &&
    (value.official_session_path === undefined || (typeof value.official_session_path === "string" && value.official_session_path.length <= 4096)) &&
    typeof value.pane_id === "string" && value.pane_id.length <= 80 && BOUNDED_TOKEN_RE.test(value.pane_id) &&
    ORCH_BIRTH_ORIGINS.includes(value.origin as OrchBirthOrigin) &&
    (value.approval_sha256 === undefined || (typeof value.approval_sha256 === "string" && SHA256_RE.test(value.approval_sha256))) &&
    (value.origin !== "rebirth" || (index > 0 && typeof value.approval_sha256 === "string")) &&
    typeof value.born_at === "string" && value.born_at.length <= 64;
}

const CREATOR_KEYS = ["session_id", "pane_id", "mandate_sha256", "opened_at", "verified"] as const;

function validOrchCreator(value: unknown): value is OrchCreatorRecord {
  if (!isRecord(value) || !onlyKeys(value, CREATOR_KEYS)) return false;
  const verifiedIdentity = (value.verified === undefined || value.verified === true) &&
    typeof value.session_id === "string" &&
    value.session_id.length <= 80 &&
    BOUNDED_TOKEN_RE.test(value.session_id);
  const unverifiedIdentity = value.verified === false && value.session_id === undefined;
  return (verifiedIdentity || unverifiedIdentity) &&
    typeof value.pane_id === "string" && value.pane_id.length <= 80 && BOUNDED_TOKEN_RE.test(value.pane_id) &&
    typeof value.mandate_sha256 === "string" && SHA256_RE.test(value.mandate_sha256) &&
    typeof value.opened_at === "string" && value.opened_at.length <= 64;
}
// Reader-only: nothing writes `pinned_roles` any more (221abf10d2280b47), but
// registries written before that change carry it and must keep validating.
const PINNED_ROLES_KEYS = ["roles", "observed_session_id", "observed_at", "source"] as const;
const PINNED_ROLE_MODEL_KEYS = ["provider", "model", "thinking"] as const;

function validPinnedRoles(value: unknown): value is PinnedRolesRecord {
  return isRecord(value) &&
    exactKeys(value, PINNED_ROLES_KEYS) &&
    isRecord(value.roles) &&
    Object.entries(value.roles).every(([role, model]) =>
      ROLE_RE.test(role) &&
      isRecord(model) &&
      onlyKeys(model, PINNED_ROLE_MODEL_KEYS) &&
      typeof model.provider === "string" && model.provider.length >= 1 && model.provider.length <= 80 && BOUNDED_TOKEN_RE.test(model.provider) &&
      typeof model.model === "string" && model.model.length >= 1 && model.model.length <= 80 && BOUNDED_TOKEN_RE.test(model.model) &&
      (model.thinking === undefined || (typeof model.thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(model.thinking)))) &&
    typeof value.observed_session_id === "string" && value.observed_session_id.length <= 80 && BOUNDED_TOKEN_RE.test(value.observed_session_id) &&
    typeof value.observed_at === "string" && value.observed_at.length <= 64 &&
    typeof value.source === "string" && value.source.length >= 1 && value.source.length <= 80;
}
const BUDGET_KEYS = ["seed_tokens", "seed_minutes", "minutes_floor", "doorbell_policy", "granted_tokens", "granted_minutes", "extensions", "state", "park_reason", "park_detail", "parked_at", "denied_clamp_sha256", "approach_warned", "server_clamp_tokens", "started_at"] as const;
const EXTENSION_KEYS = ["ordinal", "requested_tokens", "requested_minutes", "justification_sha256", "audit_path", "audit_worker_id", "state", "verdict", "granted_tokens", "granted_minutes", "applied", "audit_worker_closed", "retries", "requested_at", "settled_at"] as const;
const APPLIED_KEYS = ["tokens", "minutes"] as const;

/** Both axes, both from the closed vocabulary: a half-recorded application is not a state. */
function validAppliedStates(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    exactKeys(value, APPLIED_KEYS) &&
    APPLIED_KEYS.every((axis) => BUDGET_APPLIED_STATES.includes(value[axis] as BudgetAppliedState))
  );
}

function validCount(value: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function validBudgetExtension(value: unknown, index: number): value is BudgetExtension {
  return isRecord(value) &&
    onlyKeys(value, EXTENSION_KEYS) &&
    value.ordinal === index + 1 &&
    validCount(value.requested_tokens) &&
    (value.requested_minutes === undefined || validCount(value.requested_minutes)) &&
    typeof value.justification_sha256 === "string" && SHA256_RE.test(value.justification_sha256) &&
    typeof value.audit_path === "string" && value.audit_path.length <= 4096 &&
    (value.audit_worker_id === undefined || (typeof value.audit_worker_id === "string" && WORKER_RE.test(value.audit_worker_id))) &&
    (value.audit_worker_closed === undefined || typeof value.audit_worker_closed === "boolean") &&
    (value.state === "pending" || value.state === "settled" || value.state === "abandoned") &&
    (value.verdict === undefined || BUDGET_VERDICTS.includes(value.verdict as BudgetVerdict)) &&
    (value.granted_tokens === undefined || validCount(value.granted_tokens)) &&
    // A recorded minutes grant may not exceed what that extension asked for:
    // the verdict's `granted_minutes` lever is truncated to the request before
    // it is written, so a record above it could only come from a hand edit. The
    // bound is checked only where the request was recorded — an extension
    // written before `requested_minutes` existed has nothing to compare
    // against, and inventing a comparison would reject a healthy registry.
    (value.granted_minutes === undefined || (validCount(value.granted_minutes) && (typeof value.requested_minutes !== "number" || Number(value.granted_minutes) <= value.requested_minutes))) &&
    validAppliedStates(value.applied) &&
    validCount(value.retries, 64) &&
    typeof value.requested_at === "string" && value.requested_at.length <= 64 &&
    (value.settled_at === undefined || (typeof value.settled_at === "string" && value.settled_at.length <= 64));
}

/**
 * Fail-closed budget validation. A registry whose budget record cannot be proved
 * is never reinterpreted generously: the caller preserves and repairs it, because
 * a misread cap is exactly how a run would spend without ever justifying itself.
 */
function validBudget(value: unknown): value is BudgetRecord {
  return isRecord(value) &&
    onlyKeys(value, BUDGET_KEYS) &&
    validCount(value.seed_tokens) &&
    validCount(value.seed_minutes) &&
    (value.minutes_floor === undefined || validCount(value.minutes_floor)) &&
    (value.doorbell_policy === "full" || value.doorbell_policy === "notify") &&
    validCount(value.granted_tokens) &&
    validCount(value.granted_minutes) &&
    Array.isArray(value.extensions) &&
    value.extensions.every((entry, index) => validBudgetExtension(entry, index)) &&
    (value.state === "active" || value.state === "parked") &&
    (value.park_reason === undefined || BUDGET_PARK_REASONS.includes(value.park_reason as BudgetParkReason)) &&
    (value.park_detail === undefined || (typeof value.park_detail === "string" && value.park_detail.length <= 500)) &&
    (value.parked_at === undefined || (typeof value.parked_at === "string" && value.parked_at.length <= 64)) &&
    (value.denied_clamp_sha256 === undefined || value.denied_clamp_sha256 === "absent" || (typeof value.denied_clamp_sha256 === "string" && SHA256_RE.test(value.denied_clamp_sha256))) &&
    (value.approach_warned === undefined || (
      isRecord(value.approach_warned) &&
      exactKeys(value.approach_warned, ["cap_tokens", "cap_minutes", "warned_at"]) &&
      validCount(value.approach_warned.cap_tokens) &&
      validCount(value.approach_warned.cap_minutes) &&
      typeof value.approach_warned.warned_at === "string" && value.approach_warned.warned_at.length <= 64
    )) &&
    // Token values the server wrote to the human-owned clamp or owes it. Both
    // slots are optional and partial: a first write that failed leaves `intended`
    // alone, and a drained owed state removes the field entirely, so this is
    // `onlyKeys`, not `exactKeys`. Additive optional — no schema version bump.
    (value.server_clamp_tokens === undefined || (
      isRecord(value.server_clamp_tokens) &&
      onlyKeys(value.server_clamp_tokens, ["confirmed", "intended"]) &&
      (value.server_clamp_tokens.confirmed === undefined || validCount(value.server_clamp_tokens.confirmed)) &&
      (value.server_clamp_tokens.intended === undefined || validCount(value.server_clamp_tokens.intended))
    )) &&
    typeof value.started_at === "string" && value.started_at.length <= 64;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === allowed.length && actual.every((key, index) => key === [...allowed].sort()[index]);
}


function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validSeparation(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    exactKeys(value, ["kind", "reason", "conflicts_with_worker_id"]) &&
    (value.kind === "direction" || value.kind === "ownership" || value.kind === "dependency") &&
    typeof value.reason === "string" &&
    value.reason.length >= 1 &&
    value.reason.length <= 500 &&
    typeof value.conflicts_with_worker_id === "string" &&
    WORKER_RE.test(value.conflicts_with_worker_id)
  );
}

function validOptionalSafeInteger(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function validTokenUsage(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !onlyKeys(value, ["source", "session_id", "observed_at", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens"])) return false;
  const counts = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens"] as const;
  return value.source === "omp-jsonl" &&
    typeof value.session_id === "string" &&
    value.session_id.length >= 1 &&
    value.session_id.length <= 256 &&
    typeof value.observed_at === "string" &&
    value.observed_at.length <= 64 &&
    counts.some((key) => value[key] !== undefined) &&
    counts.every((key) => validOptionalSafeInteger(value[key]));
}

function validAdvisoryUnownedChanges(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    exactKeys(value, ["advisory", "paths", "truncated"]) &&
    value.advisory === true &&
    Array.isArray(value.paths) &&
    value.paths.length <= 64 &&
    value.paths.every((item) => typeof item === "string" && item.length >= 1 && Buffer.byteLength(item) <= 1_024) &&
    typeof value.truncated === "boolean"
  );
}

/**
 * SHAPE only, and bounded on every axis: at most 16 entries, each exactly a
 * run-relative path and the hash the immutable assignment declared for it. Path
 * SEMANTICS — containment, symlink and hardlink refusal, size, re-verification
 * against the bytes on disk — belong to the tool layer that consumes them; what
 * is fixed here is only that a stored reference can be compared later.
 */
function validReferences(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value) &&
    value.length <= MAX_ASSIGNMENT_REFERENCES &&
    value.every((entry) =>
      isRecord(entry) &&
      exactKeys(entry, ["path", "sha256"]) &&
      typeof entry.path === "string" && entry.path.length >= 1 && Buffer.byteLength(entry.path) <= MAX_ASSIGNMENT_REFERENCE_PATH_BYTES &&
      typeof entry.sha256 === "string" && SHA256_RE.test(entry.sha256))
  );
}
function assertMode600(mode: number, coordinate: string): void {
  if ((mode & 0o777) !== 0o600) throw new McpContractError("unsafe_file_mode", `${coordinate} must have mode 600.`, "storage", "Restore the canonical control-plane file mode before continuing.");
}

/**
 * One assignment-grammar refusal, in the shape every `assignment_artifact_invalid`
 * now takes: WHAT is wrong, WHICH section and line it is in, WHAT the bound is,
 * and the exact text that would satisfy it.
 *
 * The three friction reports behind this (2f772405d442c6f3, 171183a6663fabb1,
 * 0b2c5548cb73bf25) are all the same defect seen from different angles: the
 * grammar was discoverable only by failing, and the failure did not say how to
 * pass. A refusal that names no fix costs an authoring round trip per rule.
 */
function artifactInvalid(what: string, fix: string): McpContractError {
  return new McpContractError("assignment_artifact_invalid", what, "validate", fix);
}

const SECTION_SHAPE = `The canonical assignment is exactly ${ASSIGNMENT_SECTIONS.length} H1 sections in this order — ${ASSIGNMENT_SECTIONS.map((section) => `"# ${section}"`).join(", ")} — each followed by one blank line, optionally followed by a trailing "# ${ASSIGNMENT_REFERENCES_SECTION}" section and nothing after it.`;

function parseListSection(value: string, heading: string): string[] {
  const shape = `Every line of "# ${heading}" is one Markdown bullet "- <text>" of 1 to ${MAX_ASSIGNMENT_BULLET} characters, at most ${MAX_ASSIGNMENT_SECTION_LINES} lines total: no blank lines, no wrapped continuation lines, no nested indentation, no sub-headings. Example:\n- one bounded claim, on one line`;
  const lines = value.trim().split("\n");
  if (lines.length > MAX_ASSIGNMENT_SECTION_LINES) {
    throw artifactInvalid(`Section "# ${heading}" has ${lines.length} lines; the limit is ${MAX_ASSIGNMENT_SECTION_LINES}.`, shape);
  }
  const offending = lines.findIndex((line) => !line.startsWith("- ") || line.length < 3 || line.length > MAX_ASSIGNMENT_BULLET + 2);
  if (offending >= 0) {
    const line = lines[offending];
    const why = !line.startsWith("- ")
      ? line.trim() === ""
        ? "it is blank"
        : `it begins ${JSON.stringify(line.slice(0, 12))} instead of "- "`
      : line.length < 3
        ? "it is a bullet with no text"
        : `it is ${line.length - 2} characters of text and the limit is ${MAX_ASSIGNMENT_BULLET}`;
    throw artifactInvalid(`Section "# ${heading}" line ${offending + 1} is not a bounded Markdown bullet: ${why}.`, shape);
  }
  return lines.map((line) => line.slice(2));
}

const REFERENCE_BULLET_RE = /^- (\S+) sha256:([a-f0-9]{64})$/;
const REFERENCE_SHAPE = `Every line of "# ${ASSIGNMENT_REFERENCES_SECTION}" is exactly "- <path> sha256:<64 lowercase hex>", at most ${MAX_ASSIGNMENT_REFERENCES} lines. The path is relative to the RUN directory, has no "..", no empty segment, no leading "/" and no backslash, and names one regular file of at most ${MAX_ASSIGNMENT_REFERENCE_BYTES} bytes. Example:\n- plan-contract.md sha256:${"0".repeat(64)}`;

/**
 * Path SYNTAX only, decided from the raw declared bytes before anything touches
 * the filesystem. Containment is re-decided against the resolved realpath in the
 * tool layer; this rejects the forms that make a containment check meaningless
 * (traversal, absolute, empty segments) plus the two that make it
 * platform-dependent (backslash separators, control characters).
 */
function assertReferencePathSyntax(raw: string, line: number): void {
  const named = `"# ${ASSIGNMENT_REFERENCES_SECTION}" line ${line}`;
  const reject = (why: string): never => { throw artifactInvalid(`${named} declares path ${JSON.stringify(raw)}, which ${why}.`, REFERENCE_SHAPE); };
  if (Buffer.byteLength(raw) > MAX_ASSIGNMENT_REFERENCE_PATH_BYTES) reject(`is ${Buffer.byteLength(raw)} bytes; the limit is ${MAX_ASSIGNMENT_REFERENCE_PATH_BYTES}`);
  if (raw.startsWith("/")) reject("is absolute; references are relative to the run directory");
  if (/^[A-Za-z]:/.test(raw)) reject("carries a drive letter; references are relative to the run directory");
  if (raw.includes("\\")) reject("contains a backslash; the separator is always \"/\"");
  if (/[\u0000-\u001f\u007f]/.test(raw)) reject("contains a control character");
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "")) reject("contains an empty segment");
  if (segments.some((segment) => segment === "..")) reject('contains a ".." segment; a reference never leaves the run directory');
  if (segments.some((segment) => segment === ".")) reject('contains a "." segment; write the path in canonical form');
}

function parseReferences(value: string): { path: string; sha256: string }[] {
  const lines = value.trim().split("\n");
  if (lines.length > MAX_ASSIGNMENT_REFERENCES) {
    throw artifactInvalid(`Section "# ${ASSIGNMENT_REFERENCES_SECTION}" pins ${lines.length} files; the limit is ${MAX_ASSIGNMENT_REFERENCES}.`, REFERENCE_SHAPE);
  }
  const references = lines.map((line, index) => {
    const match = REFERENCE_BULLET_RE.exec(line);
    if (!match) {
      const why = !line.startsWith("- ")
        ? "it is not a Markdown bullet"
        : /sha256:/i.test(line)
          ? "its hash is not exactly \"sha256:\" followed by 64 lowercase hex characters"
          : "it names no sha256 pin";
      throw artifactInvalid(`Section "# ${ASSIGNMENT_REFERENCES_SECTION}" line ${index + 1} is not a reference bullet: ${why}.`, REFERENCE_SHAPE);
    }
    assertReferencePathSyntax(match[1], index + 1);
    return { path: match[1], sha256: match[2] };
  });
  const duplicate = references.find((reference, index) => references.findIndex((other) => other.path === reference.path) !== index);
  if (duplicate) {
    throw artifactInvalid(`Section "# ${ASSIGNMENT_REFERENCES_SECTION}" pins ${JSON.stringify(duplicate.path)} more than once.`, `Pin each path once. Two hashes for one path cannot both be current, so the duplicate is either a stale line to delete or a different file to name.`);
  }
  return references;
}

/**
 * Body line numbers where a `# ` heading sits INSIDE an open fenced code block.
 *
 * This is the exact shape of friction 171183a6663fabb1, and it needs its own
 * detector because the symptom is indistinguishable from an authoring mistake by
 * the time the split has run: sections are split on `^# ` before anything
 * interprets fences, so one fenced heading silently becomes one extra section.
 * At six sections that is a legal count (the optional trailing `# References`),
 * so the artifact used to fail on a positional heading mismatch and never hear
 * the word "fence" — while two fenced headings, being seven sections, did.
 *
 * Line numbers are file-relative, because that is what the author edits.
 */
function fencedHeadingLines(text: string, bodyOffset: number): number[] {
  const lines = text.split("\n");
  const firstBodyLine = text.slice(0, bodyOffset).split("\n").length;
  const hits: number[] = [];
  let fence: string | undefined;
  for (let index = firstBodyLine - 1; index < lines.length; index += 1) {
    const line = lines[index];
    const delimiter = /^(```+|~~~+)/.exec(line);
    if (delimiter) {
      if (fence === undefined) fence = delimiter[1];
      else if (delimiter[1].startsWith(fence[0]) && delimiter[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined && line.startsWith("# ")) hits.push(index + 1);
  }
  return hits;
}
function parseAssignmentMarkdown(text: string, assignmentId: string, responsibility: string): AssignmentArtifact {
  if (text.includes("\r")) throw artifactInvalid("Assignment Markdown contains a CR byte.", "Rewrite the file with LF line endings only; a CRLF artifact would hash differently on every platform that touched it.");
  const frontmatterEnd = text.indexOf("\n---\n", 4);
  if (!text.startsWith("---\n") || frontmatterEnd < 0) throw artifactInvalid("Assignment Markdown has no closing frontmatter delimiter.", "The file begins with \"---\" on line 1, then assignment_id, responsibility_key and profile on one line each, then \"---\", then a blank line. Example:\n---\nassignment_id: A-001\nresponsibility_key: my-lane\nprofile: task\n---");
  const frontmatter = text.slice(4, frontmatterEnd).split("\n");
  // Three canonical fields, optionally followed by a fourth display-only
  // `label` (ASN-003a). Anything else fails closed: an unknown or repeated
  // fourth key never reaches `scalar` with the `label: ` prefix, and a fifth
  // line is rejected outright, so the relaxation widens what is read and
  // nothing else.
  if (frontmatter.length !== 3 && frontmatter.length !== 4) throw artifactInvalid(`Assignment frontmatter has ${frontmatter.length} lines; it takes 3, or 4 with a display-only label.`, `The frontmatter is exactly "assignment_id: <A-nnn>", "responsibility_key: <key>", "profile: <profile>", optionally followed by "label: <label>". No other key, no repeated key, no blank line inside the block.`);
  const scalar = (line: string, key: string, pattern: RegExp, recovery = "Repair the canonical assignment Markdown."): string => {
    const prefix = `${key}: `;
    const value = line.startsWith(prefix) ? line.slice(prefix.length) : "";
    if (!pattern.test(value)) throw artifactInvalid(`Frontmatter line ${JSON.stringify(line.slice(0, 64))} is not a valid ${key}.`, recovery === "Repair the canonical assignment Markdown." ? `The line reads exactly "${key}: <value>" — one space after the colon, no quotes, no trailing spaces — and the value matches ${pattern.source}.` : recovery);
    return value;
  };
  const parsedAssignmentId = scalar(frontmatter[0], "assignment_id", ASSIGNMENT_RE);
  const parsedResponsibility = scalar(frontmatter[1], "responsibility_key", RESPONSIBILITY_RE);
  const profile = scalar(frontmatter[2], "profile", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  const label = frontmatter.length === 4
    ? scalar(frontmatter[3], "label", ASSIGNMENT_LABEL_RE, `The optional fourth frontmatter field is exactly "label: <value>": 1 to ${MAX_ASSIGNMENT_LABEL} characters of letters, digits, "-" or "_", beginning and ending alphanumeric. It is display only — identity, queue order, settlement, and priority all read assignment_id — so drop the line rather than widening it.`)
    : undefined;
  if (parsedAssignmentId !== assignmentId || parsedResponsibility !== responsibility) throw artifactInvalid(`Assignment frontmatter declares ${parsedAssignmentId}/${parsedResponsibility} but this call names ${assignmentId}/${responsibility}.`, "Call the coordinate the artifact declares, or fix the frontmatter. The filename, the frontmatter, and the call must agree: nothing infers one from another.");

  const bodyOffset = frontmatterEnd + 5;
  const body = text.slice(bodyOffset).trim();
  const sections = body.split(/\n(?=# )/);
  // Exactly the five canonical sections, optionally followed by `# References`
  // as the LAST section and nothing after it (Q4). The split is positional, so
  // the optional section can only ever be trailing — which is also what makes
  // it safe: nothing between the five is reinterpreted.
  const withReferences = sections.length === ASSIGNMENT_SECTIONS.length + 1;
  const positional = sections.every((section, index) => section.startsWith(`# ${index < ASSIGNMENT_SECTIONS.length ? ASSIGNMENT_SECTIONS[index] : ASSIGNMENT_REFERENCES_SECTION}\n`));
  // The fence trap is diagnosed BEFORE the count and the positional check,
  // because a fenced heading is what made those two fire in the first place and
  // neither of them can name it. One fenced heading lands on six sections — a
  // legal count — so it used to be reported as a misplaced `# References`.
  const fenced = sections.length === ASSIGNMENT_SECTIONS.length && positional ? [] : fencedHeadingLines(text, bodyOffset);
  if (fenced.length) {
    throw artifactInvalid(
      `Assignment Markdown has ${fenced.length} line(s) beginning "# " inside a fenced code block, at file line(s) ${fenced.join(", ")}, and each one started a new section: the artifact parsed as ${sections.length} H1 sections instead of ${ASSIGNMENT_SECTIONS.length}.`,
      `Sections are split on a leading "# " before anything interprets fences (friction 171183a6663fabb1), so a fence cannot protect a heading. Indent the fence and its contents by two spaces — the indented block still renders as code and no line inside it begins at column 1 — or drop the "# " from those lines. ${SECTION_SHAPE}`,
    );
  }
  if (sections.length !== ASSIGNMENT_SECTIONS.length && !withReferences) {
    const observed = sections.map((section) => section.split("\n", 1)[0]).join(" | ");
    throw artifactInvalid(
      `Assignment Markdown has ${sections.length} H1 sections; it takes ${ASSIGNMENT_SECTIONS.length}, or ${ASSIGNMENT_SECTIONS.length + 1} with a trailing "# ${ASSIGNMENT_REFERENCES_SECTION}". Observed headings: ${observed}.`,
      `${SECTION_SHAPE} If this artifact DOES carry a trailing "# ${ASSIGNMENT_REFERENCES_SECTION}" section, the mounted server predates it (the section shipped in 3.9.0): respawn the plugin with /reload-plugins and retry the identical call rather than deleting the section.`,
    );
  }
  const sectionValues = sections.map((section, index) => {
    const heading = index < ASSIGNMENT_SECTIONS.length ? ASSIGNMENT_SECTIONS[index] : ASSIGNMENT_REFERENCES_SECTION;
    const prefix = `# ${heading}\n\n`;
    if (!section.startsWith(prefix)) {
      throw artifactInvalid(`Section ${index + 1} of the assignment reads ${JSON.stringify(section.split("\n", 1)[0])}; section ${index + 1} is "# ${heading}" followed by one blank line.`, SECTION_SHAPE);
    }
    return section.slice(prefix.length);
  });
  const goal = sectionValues[0].trim();
  if (!goal) throw artifactInvalid('Section "# Goal" is empty.', "Write the goal as prose in the Goal section. It is the one section a worker reads first, so an empty one dispatches an assignment that states no objective.");
  if (goal.length > MAX_ASSIGNMENT_GOAL) throw artifactInvalid(`Section "# Goal" is ${goal.length} characters; the limit is ${MAX_ASSIGNMENT_GOAL}.`, `Shorten the goal to at most ${MAX_ASSIGNMENT_GOAL} characters. Detail belongs in "# Completion conditions" as bounded bullets, or in a document pinned by hash in a trailing "# ${ASSIGNMENT_REFERENCES_SECTION}" section.`);
  return {
    assignment_id: assignmentId,
    responsibility_key: responsibility,
    profile,
    ...(label ? { label } : {}),
    goal,
    completion_conditions: parseListSection(sectionValues[1], ASSIGNMENT_SECTIONS[1]),
    write_ownership: parseListSection(sectionValues[2], ASSIGNMENT_SECTIONS[2]),
    dependencies: parseListSection(sectionValues[3], ASSIGNMENT_SECTIONS[3]),
    user_boundaries: parseListSection(sectionValues[4], ASSIGNMENT_SECTIONS[4]),
    ...(withReferences ? { references: parseReferences(sectionValues[5]) } : {}),
  };
}

function validateRegistry(value: unknown, runPath: string): asserts value is DelegationRegistry {
  const requiredKeys = ["version", "owner", "run_path", "revision", "responsibilities", "lanes", "assignments", "created_at", "updated_at"] as const;
  // Version first, and with its own error: a server that predates a schema growth
  // must say so, because "malformed" sent an agent to repair a healthy tool-owned
  // file (friction 8c1e0ea5). Unknown-key rejection stays exact within a version.
  if (isRecord(value) && typeof value.version === "number" && !(SUPPORTED_DELEGATION_VERSIONS as readonly number[]).includes(value.version)) {
    throw new McpContractError(
      "registry_version_unsupported",
      `delegation.json declares schema version ${value.version}; this mounted herdr-delegator build (v${mountedVersion}, started ${new Date(mountedStartedAtMs).toISOString()}) supports schema ${SUPPORTED_DELEGATION_VERSIONS.join(", ")}.`,
      "storage",
      value.version > DELEGATION_VERSION
        ? `This mounted build (v${mountedVersion}, schema ${DELEGATION_VERSION}) is older than the registry it is reading (schema ${value.version}): respawn it with /reload-plugins (or start a new OMP session) and retry the identical call. The registry is healthy — never hand-edit a tool-owned file to make a call succeed.`
        : `Preserve the registry and migrate it deliberately: this mounted build (v${mountedVersion}) supports schema ${SUPPORTED_DELEGATION_VERSIONS.join(", ")} and never reinterprets schema ${value.version} in place.`,
      false,
      value.version > DELEGATION_VERSION,
    );
  }
  if (!isRecord(value) || !onlyKeys(value, [...requiredKeys, "orch_births", "orch_creator", "pinned_roles", "budget"]) || requiredKeys.some((key) => value[key] === undefined) || value.owner !== "herdr-delegator" || value.run_path !== runPath || !Number.isInteger(value.revision) || !isRecord(value.responsibilities) || !isRecord(value.lanes) || !isRecord(value.assignments)) {
    throw new McpContractError("delegation_registry_invalid", "delegation.json is malformed or belongs to another run.", "storage", "If this server is older than the fields the file carries, respawn it with /reload-plugins first — a stale reader reports a healthy registry as malformed. Otherwise preserve the registry and repair it from verified evidence; never hand-edit a tool-owned file to make a call succeed.");
  }
  if (value.orch_births !== undefined && (!Array.isArray(value.orch_births) || !value.orch_births.every((birth, index) => validOrchBirth(birth, index)))) {
    throw new McpContractError("delegation_registry_invalid", "An ORCH birth record is malformed.", "storage", "Repair births from verified spawn or claim evidence; generations are contiguous from 1.");
  }
  if (value.orch_creator !== undefined && !validOrchCreator(value.orch_creator)) {
    throw new McpContractError("delegation_registry_invalid", "The ORCH creator record is malformed.", "storage", "Repair the creator record from the opening session's verified attestation, or remove it to reopen the track.");
  }
  if (value.pinned_roles !== undefined && !validPinnedRoles(value.pinned_roles)) {
    throw new McpContractError("delegation_registry_invalid", "The pinned role table is malformed.", "storage", "Repair the pinned role table from the creator session's verified bridge facts, or remove it to fall back to live role resolution.");
  }
  if (value.budget !== undefined && !validBudget(value.budget)) {
    throw new McpContractError("delegation_registry_invalid", "The budget record is malformed.", "storage", "Preserve the registry and the budget ledger, then repair the record from the ledger's recorded extensions and verdicts; never widen a cap by hand.");
  }
  for (const [key, responsibility] of Object.entries(value.responsibilities)) {
    if (!RESPONSIBILITY_RE.test(key) || !isRecord(responsibility) || !exactKeys(responsibility, ["key", "worker_ids"]) || responsibility.key !== key || !Array.isArray(responsibility.worker_ids) || responsibility.worker_ids.some((id) => typeof id !== "string" || !WORKER_RE.test(id))) throw new McpContractError("delegation_registry_invalid", "A responsibility route is malformed.", "storage", "Repair routing from verified worker identities.");
  }
  for (const [workerId, lane] of Object.entries(value.lanes)) {
    if (!WORKER_RE.test(workerId) || !isRecord(lane) || !onlyKeys(lane, LANE_KEYS) || lane.worker_id !== workerId || lane.lane_generation !== 1 || !RESPONSIBILITY_RE.test(String(lane.responsibility_key)) || !validSeparation(lane.separation) || !Array.isArray(lane.queued_assignment_ids) || lane.queued_assignment_ids.some((id) => typeof id !== "string" || !ASSIGNMENT_RE.test(id))) throw new McpContractError("delegation_registry_invalid", "A worker lane is malformed.", "storage", "Repair the lane from verified lifecycle facts.");
  }
  for (const [assignmentId, assignment] of Object.entries(value.assignments)) {
    const validIdentity = ASSIGNMENT_RE.test(assignmentId) &&
      isRecord(assignment) &&
      onlyKeys(assignment, ASSIGNMENT_KEYS) &&
      assignment.assignment_id === assignmentId &&
      typeof assignment.responsibility_key === "string" &&
      RESPONSIBILITY_RE.test(assignment.responsibility_key) &&
      typeof assignment.worker_id === "string" &&
      WORKER_RE.test(assignment.worker_id) &&
      typeof assignment.state === "string" &&
      !!ASSIGNMENT_STATES[assignment.state as AssignmentState] &&
      typeof assignment.instructions_sha256 === "string" &&
      SHA256_RE.test(assignment.instructions_sha256);
    const validSettlement = isRecord(assignment) &&
      (assignment.prompted_at === undefined || (typeof assignment.prompted_at === "string" && assignment.prompted_at.length <= 64)) &&
      (assignment.report_sha256 === undefined || (typeof assignment.report_sha256 === "string" && SHA256_RE.test(assignment.report_sha256))) &&
      (assignment.completed_at === undefined || typeof assignment.completed_at === "string") &&
      validOptionalSafeInteger(assignment.elapsed_ms) &&
      validTokenUsage(assignment.token_usage) &&
      validAdvisoryUnownedChanges(assignment.advisory_unowned_changes) &&
      validReferences(assignment.references) &&
      (assignment.reported_boundary === undefined || assignment.reported_boundary === "blocked");
    if (!validIdentity || !validSettlement) throw new McpContractError("delegation_registry_invalid", "An assignment record is malformed.", "storage", "Repair the assignment from its immutable artifact and verified settlement evidence.");
  }
}

/**
 * In-memory only. A v5 record carries its own floor; a record written before v5
 * gets `max(seed_minutes, granted_minutes)` so no minute an older server
 * allowed is retracted, and a v5 record that somehow lacks it falls back to the
 * seed, which is what a fresh run records.
 */
function projectMinutesFloor(registry: DelegationRegistry): void {
  const budget = registry.budget;
  if (!budget || budget.minutes_floor !== undefined) return;
  budget.minutes_floor = registry.version >= DELEGATION_VERSION
    ? budget.seed_minutes
    : Math.max(budget.seed_minutes, budget.granted_minutes);
}

export type AssignmentFile = { path: string; assignment: AssignmentArtifact; instructionsHash: string };
/**
 * `queue_position` is where this `add` left the assignment in its lane: the
 * 0-based index it holds in the lane queue, `"active"` when the lane is running
 * it now, or `"none"` when a duplicate `add` names a record that is already
 * terminal and therefore holds no place in any queue. It is derived from the
 * lane at the end of the transaction and persisted nowhere, so it reports the
 * placement a caller asked about instead of inviting anyone to store a rank.
 */
export type QueuePosition = number | "active" | "none";
export type LaneSelection = { lane: WorkerLaneRecord; assignment: AssignmentRecord; queued: boolean; duplicate: boolean; queue_position: QueuePosition; artifact: AssignmentFile; revision: number };

export class DelegationStore {
  private constructor(readonly runPath: string, readonly cwd: string, readonly registryPath: string, readonly lockPath: string) {}

  static async resolve(trackId: string, runId: string): Promise<DelegationStore> {
    const resolved = await resolveRunCoordinate(trackId, runId);
    const a2a = path.join(resolved.runPath, "a2a");
    if (await realpath(a2a) !== a2a) throw new McpContractError("run_not_canonical", "Run a2a directory is not canonical.", "storage", "Reconcile the deterministic run before using MCP.");
    return new DelegationStore(resolved.runPath, resolved.manifest.cwd, path.join(a2a, "delegation.json"), path.join(a2a, ".delegation.lock"));
  }

  private empty(): DelegationRegistry {
    const now = nowIso();
    return { version: DELEGATION_VERSION, owner: "herdr-delegator", run_path: this.runPath, revision: 0, responsibilities: {}, lanes: {}, assignments: {}, created_at: now, updated_at: now };
  }

  /**
   * Reads and validates the registry, then projects the v5 `minutes_floor` into
   * MEMORY for a record written before v5 (Q10). The projected value is
   * `max(seed_minutes, granted_minutes)`: under the pre-v5 asymmetric rule the
   * minutes cap simply followed `granted_minutes`, so preserving that figure
   * keeps every minute an older server already allowed and cannot park a run
   * the old rule left running. Nothing is written here — `inspect` must be safe
   * to run — and the first guarded mutation persists the same value through
   * `transaction` below.
   */
  async read(): Promise<DelegationRegistry> {
    try {
      assertMode600((await stat(this.registryPath)).mode, this.registryPath);
      const value: unknown = JSON.parse(await readFile(this.registryPath, "utf8"));
      validateRegistry(value, this.runPath);
      projectMinutesFloor(value);
      return value;
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ENOENT") return this.empty();
      if (error instanceof McpContractError) throw error;
      throw new McpContractError("delegation_registry_invalid", error instanceof Error ? error.message : "Unable to read delegation registry.", "storage", "Preserve the registry and repair it before mutation.");
    }
  }

  async transaction<T>(timeoutMs: number, operation: (registry: DelegationRegistry) => Promise<T>): Promise<T> {
    const owner = await acquireLock(this.lockPath, timeoutMs);
    try {
      await chmod(this.lockPath, 0o600);
      const registry = await this.read();
      const result = await operation(registry);
      registry.revision += 1;
      registry.updated_at = nowIso();
      // Writes always emit the current schema version, so an older file is
      // upgraded the first time anything mutates it. Every upgrade only adds
      // optional fields, so it changes no existing field's meaning — and this
      // is also the one-shot materialize window for the v5 `minutes_floor` the
      // read above projected, so the promotion and the value it implies land in
      // the same atomic write instead of in two observable states.
      registry.version = DELEGATION_VERSION;
      // Validate before writing, not only on the next read. The fail-closed
      // gate is the same one, but running it here attributes a malformed record
      // to the call that produced it instead of to whoever reads next — a
      // corrupt registry that surfaces one call later is exactly the kind of
      // silent failure this project exists to prevent.
      validateRegistry(registry, this.runPath);
      await writeAtomic(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, 0o600);
      assertMode600((await stat(this.registryPath)).mode, this.registryPath);
      return result;
    } finally { await releaseLock(this.lockPath, owner); }
  }

  /**
   * The bytes at a canonical assignment coordinate, or a refusal that says which
   * kind of wrong it is.
   *
   * Both readers used to fold every rejection into `assignment_artifact_missing`,
   * so an artifact that was merely too large was reported as missing or unsafe
   * with no size, no bound, and no fix — and the parser's own size refusal, which
   * has all three, was unreachable because this guard ran first. The size gate
   * must stay here (it is what keeps the read bounded), so the honest error
   * belongs here too: `missing` now means absent, non-canonical, symlinked, or
   * not a regular file, and nothing else.
   */
  private async canonicalArtifactBytes(artifactPath: string, assignmentId: string, missingRecovery: string): Promise<Buffer> {
    try {
      if (await realpath(artifactPath) !== artifactPath) throw new Error("non-canonical artifact");
      const file = await lstat(artifactPath);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error("unsafe artifact");
      if (file.size > MAX_ASSIGNMENT_ARTIFACT_BYTES) {
        throw artifactInvalid(
          `Assignment Markdown for ${assignmentId} is ${file.size} bytes; the limit is ${MAX_ASSIGNMENT_ARTIFACT_BYTES}.`,
          `Keep the artifact at or under ${MAX_ASSIGNMENT_ARTIFACT_BYTES} bytes. Shorten "# Goal" and the bullet sections, and move the detail that does not fit into a document pinned by hash in a trailing "# ${ASSIGNMENT_REFERENCES_SECTION}" section — for example:\n# ${ASSIGNMENT_REFERENCES_SECTION}\n\n- spec/design.md sha256:<64 lowercase hex>`,
        );
      }
      return await readFile(artifactPath);
    } catch (error: unknown) {
      if (error instanceof McpContractError) throw error;
      throw new McpContractError("assignment_artifact_missing", "Canonical assignment Markdown is missing, not a regular file, a symlink, or not at its canonical path.", "validate", missingRecovery);
    }
  }

  async assignmentFile(assignmentId: string, responsibility: string, expectedHash: string): Promise<AssignmentFile> {
    if (!ASSIGNMENT_RE.test(assignmentId) || !RESPONSIBILITY_RE.test(responsibility) || !SHA256_RE.test(expectedHash)) throw new McpContractError("invalid_assignment", "Assignment coordinates or hash are invalid.", "validate", "Use canonical IDs and a lowercase SHA-256 hash.");
    const artifactPath = path.join(this.runPath, "a2a", "assignments", `${assignmentId}.md`);
    const bytes = await this.canonicalArtifactBytes(artifactPath, assignmentId, "Create the ORCH-owned bounded assignment file.");
    if (sha256(bytes) !== expectedHash) throw new McpContractError("assignment_hash_mismatch", "Immutable assignment Markdown hash does not match the request.", "validate", "Use the exact file hash; never overwrite a submitted assignment.");
    return { path: artifactPath, assignment: parseAssignmentMarkdown(bytes.toString("utf8"), assignmentId, responsibility), instructionsHash: expectedHash };
  }

  /**
   * Pre-immutability grammar validation of the canonical assignment file. It
   * parses the exact bytes at the canonical coordinate, returns their SHA-256
   * for a subsequent `add`, and never mutates the registry or any lane.
   */
  async preflight(assignmentId: string, responsibility: string): Promise<AssignmentFile> {
    if (!ASSIGNMENT_RE.test(assignmentId) || !RESPONSIBILITY_RE.test(responsibility)) throw new McpContractError("invalid_assignment", "Assignment coordinates are invalid.", "validate", "Use canonical assignment and responsibility IDs.");
    const artifactPath = path.join(this.runPath, "a2a", "assignments", `${assignmentId}.md`);
    const bytes = await this.canonicalArtifactBytes(artifactPath, assignmentId, "Create the ORCH-owned bounded assignment file before preflight.");
    return { path: artifactPath, assignment: parseAssignmentMarkdown(bytes.toString("utf8"), assignmentId, responsibility), instructionsHash: sha256(bytes) };
  }


  private async reservedWorkerOrdinals(registry: DelegationRegistry): Promise<Set<number>> {
    const reserved = new Set<number>();
    const reserve = (workerId: unknown): void => {
      if (typeof workerId === "string" && WORKER_RE.test(workerId)) reserved.add(Number(workerId.slice(1)));
    };
    for (const workerId of Object.keys(registry.lanes)) reserve(workerId);
    for (const responsibility of Object.values(registry.responsibilities)) {
      for (const workerId of responsibility.worker_ids) reserve(workerId);
    }
    for (const assignment of Object.values(registry.assignments)) reserve(assignment.worker_id);
    // A budget auditor holds a worker ordinal from the moment it is reserved: the
    // lifecycle registry only learns about it once the spawn lands, and two
    // sessions sharing an ordinal is exactly the identity confusion this
    // reservation exists to prevent.
    for (const extension of registry.budget?.extensions ?? []) reserve(extension.audit_worker_id);

    const lifecycle = await readRegistry(path.join(this.runPath, "a2a", "herdr-workers.json"));
    for (const worker of Object.values(lifecycle.workers)) reserve(worker.worker_id);
    for (const entry of await readdir(path.join(this.runPath, "a2a"))) {
      const match = /^w([1-9][0-9]*)-(?:instructions|report)\.md$/.exec(entry);
      if (match) reserved.add(Number(match[1]));
    }
    return reserved;
  }

  /**
   * The next worker ordinal nothing in this run has taken. Shared by every path
   * that needs one, so a predicted coordinate and the coordinate a later `add`
   * actually binds cannot drift apart.
   */
  private async nextWorkerId(registry: DelegationRegistry): Promise<string> {
    const reserved = await this.reservedWorkerOrdinals(registry);
    let ordinal = 1;
    while (reserved.has(ordinal)) ordinal += 1;
    return `w${ordinal}`;
  }

  /**
   * Next free worker ordinal for a server-spawned budget auditor. The auditor is
   * not a responsibility lane — it never appears in `lanes`, so the ORCH cannot
   * address it — but it must not collide with one, and its ordinal is never
   * reused after the audit closes.
   */
  async nextAuditWorkerId(registry: DelegationRegistry): Promise<string> {
    return this.nextWorkerId(registry);
  }

  /**
   * The lane coordinate an unseparated `add` for this responsibility would bind,
   * decided by the same rule `select` uses: reuse the responsibility's live
   * unseparated lane, otherwise take the next free ordinal. It binds nothing.
   *
   * This exists so an assignment can be AUTHORED against the report path its
   * worker will actually own (friction 20b26d0a60e14ab6): before it, the lane
   * coordinate was knowable only after dispatch, so an assignment that had to
   * name its own report surface named it by guess. A prediction stays a
   * prediction — an intervening `add` on another responsibility can take the
   * predicted ordinal — so `lane_reuse` reports which branch produced it.
   */
  async predictLane(registry: DelegationRegistry, responsibility: string): Promise<{ worker_id: string; report_path: string; lane_reuse: boolean }> {
    if (!RESPONSIBILITY_RE.test(responsibility)) throw new McpContractError("invalid_assignment", "Responsibility key is invalid.", "validate", "Use a canonical responsibility key.");
    const live = (registry.responsibilities[responsibility]?.worker_ids ?? [])
      .map((id) => registry.lanes[id])
      .filter((lane): lane is WorkerLaneRecord => !!lane && lane.state !== "closed" && lane.state !== "failed");
    const reused = live.find((candidate) => candidate.separation === undefined);
    const workerId = reused?.worker_id ?? await this.nextWorkerId(registry);
    return { worker_id: workerId, report_path: path.join(this.runPath, "a2a", `${workerId}-report.md`), lane_reuse: reused !== undefined };
  }

  /** The placement a lane record proves, never a rank anything stored. */
  private static position(lane: WorkerLaneRecord, assignmentId: string): QueuePosition {
    if (lane.active_assignment_id === assignmentId) return "active";
    const index = lane.queued_assignment_ids.indexOf(assignmentId);
    return index < 0 ? "none" : index;
  }

  async select(assignmentId: string, responsibility: string, instructionsHash: string, separation: Separation | undefined, urgent: boolean, timeoutMs: number): Promise<LaneSelection> {
    const artifact = await this.assignmentFile(assignmentId, responsibility, instructionsHash);
    let selected!: LaneSelection;
    await this.transaction(timeoutMs, async (registry) => {
      const now = nowIso();
      const existing = registry.assignments[assignmentId];
      if (existing) {
        if (existing.instructions_sha256 !== instructionsHash || existing.responsibility_key !== responsibility) throw new McpContractError("assignment_duplicate_conflict", "Assignment ID already binds different immutable Markdown.", "select", "Allocate a new assignment ID.");
        const boundLane = registry.lanes[existing.worker_id];
        if (boundLane && boundLane.state !== "closed" && boundLane.state !== "failed") {
          const ready = existing.state === "queued" && boundLane.active_assignment_id === assignmentId;
          selected = { lane: boundLane, assignment: existing, queued: !ready && existing.state === "queued", duplicate: !ready, queue_position: DelegationStore.position(boundLane, assignmentId), artifact, revision: registry.revision + 1 };
          return;
        }
        // Rebind path (dogfooded defect): an assignment whose lane died before any
        // prompt lost no work, so a re-add routes it to a live or fresh lane
        // instead of terminally failing it. Dispatched history never rebinds.
        if (existing.state !== "queued" && !(existing.state === "failed" && existing.prompted_at === undefined)) {
          throw new McpContractError("responsibility_ambiguous", "Existing assignment already ran on a lane that is now closed or failed.", "select", "Allocate a new assignment ID for repeated work; never rebind dispatched history.");
        }
        if (boundLane) {
          if (boundLane.active_assignment_id === assignmentId) delete boundLane.active_assignment_id;
          boundLane.queued_assignment_ids = boundLane.queued_assignment_ids.filter((id) => id !== assignmentId);
          boundLane.updated_at = now;
        }
      }

      let responsibilityRecord = registry.responsibilities[responsibility];
      if (!responsibilityRecord) {
        responsibilityRecord = { key: responsibility, worker_ids: [] };
        registry.responsibilities[responsibility] = responsibilityRecord;
      }
      const live = responsibilityRecord.worker_ids.map((id) => registry.lanes[id]).filter((lane): lane is WorkerLaneRecord => !!lane && lane.state !== "closed" && lane.state !== "failed");
      let lane = separation
        ? live.find((candidate) => JSON.stringify(candidate.separation) === JSON.stringify(separation))
        : live.find((candidate) => candidate.separation === undefined);
      if (separation && (!live.some((candidate) => candidate.worker_id === separation.conflicts_with_worker_id) || !separation.reason.trim())) throw new McpContractError("invalid_separation", "Separation must bind a short reason to an existing conflicting worker.", "select", "Use direction, ownership, or dependency with an existing worker ID.");
      if (!lane) {
        const workerId = await this.nextWorkerId(registry);
        lane = { worker_id: workerId, responsibility_key: responsibility, lane_generation: 1, ...(separation ? { separation } : {}), queued_assignment_ids: [], state: "starting", state_change_seq: 0, created_at: now, updated_at: now };
        registry.lanes[workerId] = lane;
        responsibilityRecord.worker_ids.push(workerId);
      }
      const queued = !!lane.active_assignment_id || lane.state === "working" || lane.state === "blocked" || lane.state === "resume-needed";
      let assignment: AssignmentRecord;
      if (existing) {
        existing.worker_id = lane.worker_id;
        existing.state = "queued";
        existing.updated_at = now;
        delete existing.ambiguous_operation;
        delete existing.ambiguous_state_change_seq;
        assignment = existing;
      } else {
        assignment = { assignment_id: assignmentId, responsibility_key: responsibility, worker_id: lane.worker_id, state: "queued", instructions_sha256: instructionsHash, created_at: now, updated_at: now };
        registry.assignments[assignmentId] = assignment;
      }
      // Placement is the one thing `urgent` decides, and it decides it here:
      // append is the rule, head insertion is the exception a caller asked for
      // in this call only. Nothing about the choice is written to the record.
      if (queued) { if (urgent) lane.queued_assignment_ids.unshift(assignmentId); else lane.queued_assignment_ids.push(assignmentId); } else lane.active_assignment_id = assignmentId;
      lane.updated_at = now;
      selected = { lane, assignment, queued, duplicate: false, queue_position: DelegationStore.position(lane, assignmentId), artifact, revision: registry.revision + 1 };
    });
    return selected;
  }

  async mutate(timeoutMs: number, callback: (registry: DelegationRegistry) => void | Promise<void>): Promise<DelegationRegistry> {
    let snapshot!: DelegationRegistry;
    await this.transaction(timeoutMs, async (registry) => {
      await callback(registry);
      snapshot = structuredClone(registry);
      snapshot.revision = registry.revision + 1;
    });
    return snapshot;
  }
}
