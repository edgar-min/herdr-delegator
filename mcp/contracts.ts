import { createHash } from "node:crypto";
import { z } from "zod";

export const TOOL_NAMES = ["herdr_track", "herdr_assignment", "herdr_worker", "herdr_message", "herdr_friction"] as const;
export const COORDINATE_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const RESPONSIBILITY_RE = COORDINATE_RE;
export const ASSIGNMENT_RE = /^A-(?!0+$)[0-9]{3,}$/;
// Display-only assignment label (M2 P2). It is deliberately NOT identity: it
// lives in the canonical artifact's optional fourth frontmatter field, is read
// again at every display, and is never persisted, queued, settled, or
// scheduled on. The grammar widens ASSIGNMENT_RE only where widening is free —
// letters, digits, `-` and `_` with alphanumeric ends — so a label can never
// become a path component, split an argv `key=value` token, terminate a
// `[Assignment Completion: ...]` header, or reach a RegExp as a metacharacter.
export const MAX_ASSIGNMENT_LABEL = 48;
export const ASSIGNMENT_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,46}[A-Za-z0-9])?$/;
// The canonical assignment artifact's grammar, as bounded numbers, so the parser
// that enforces them, the schema description that publishes them, and the
// documents that teach them read one source rather than restating it (friction
// 2f772405d442c6f3: the
// five-section and Goal limits were discoverable only by failing a preflight).
export const MAX_ASSIGNMENT_ARTIFACT_BYTES = 64 * 1024;
export const MAX_ASSIGNMENT_GOAL = 4_096;
export const MAX_ASSIGNMENT_SECTION_LINES = 64;
export const MAX_ASSIGNMENT_BULLET = 1_000;
// The five required H1 sections, in order, followed by the optional trailing
// `# References` (Q4). Order is part of the grammar: sections are split on H1
// boundaries and matched positionally, never searched for by name.
export const ASSIGNMENT_SECTIONS = ["Goal", "Completion conditions", "Write ownership", "Dependencies", "User boundaries"] as const;
export const ASSIGNMENT_REFERENCES_SECTION = "References";
export const MAX_ASSIGNMENT_REFERENCES = 16;
export const MAX_ASSIGNMENT_REFERENCE_BYTES = 256 * 1024;
export const MAX_ASSIGNMENT_REFERENCE_PATH_BYTES = 1_024;
export const WORKER_RE = /^w[1-9][0-9]*$/;
export const SHA256_RE = /^[a-f0-9]{64}$/;
export const ROLE_RE = /^@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const BOUNDED_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
// Server-issued wait cursor: `v1.r<revision>.s<lane sequence>.b<report bytes>.t<epoch ms>`.
export const WAIT_CURSOR_RE = /^v1\.r\d{1,12}\.s\d{1,12}\.b\d{1,15}\.t\d{13}$/;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;
// MCP clients abort a single call at 30s, so a longer schema-legal `wait.timeout_ms`
// can only surface as a transport error. The server clamps every effective
// single-call probe below that bound; callers end the turn after a timeout rather
// than composing a longer vigil from repeated waits.
export const MAX_EFFECTIVE_WAIT_MS = 25_000;
// The delegation registry's schema version. It is bumped whenever the schema
// grows a field, so that a server process which predates the growth fails with a
// named `registry_version_unsupported` telling the operator to respawn — instead
// of reporting a healthy file as malformed and inviting a hand-repair of a
// tool-owned file (friction 8c1e0ea5). Reading accepts every version in
// SUPPORTED_DELEGATION_VERSIONS; writing always emits the current one. Version 2
// is version 1 plus the optional `budget` record and a birth's optional
// `approval_sha256`; version 3 adds the optional `pinned_roles` record, which is
// no longer written but is still read (221abf10d2280b47); version 4 adds the
// `abandoned` budget-extension state (183b6d4102ddfbfa) — an existing field
// gaining a value, which is exactly the growth an older reader must refuse
// loudly instead of calling malformed. Version 5 adds the budget's approval
// APPLICATION state (friction 09470253737e9da6, 2c8f859d4875bbc0): an
// extension's `requested_minutes`, `granted_minutes` and per-axis `applied`,
// the budget's `minutes_floor`, and an assignment's `references` and
// `reported_boundary`. Each upgrade only adds, so no existing field changes
// meaning.
export const DELEGATION_VERSION = 5 as const;
export const SUPPORTED_DELEGATION_VERSIONS = [1, 2, 3, 4, 5] as const;
export const OBSERVATION_SOURCE = "herdr-delegator:observation";
export const MESSAGE_BOUNDARIES = ["completed", "failed", "blocked", "decision-request"] as const;
// Inter-run conversation (identity/comms redesign, decisions 10-12). A doorbell
// never carries content, so `notify_run` carries no payload at all: the sender
// ORCH appends its entry — kind, note, and any bounded body — to the
// sender-owned inter-run channel document, and the bell only points at it. The
// documented entry kinds live in the skill, not in this schema, because the
// document is the authority and the server never parses it.

// Standardized dogfooding friction taxonomy. Reports go to a global append-only
// local log, never to an external tracker; promotion to issues is a deliberate
// human-gated triage step.
export const FRICTION_KINDS = ["contract-gap", "false-block", "ambiguous-outcome", "excessive-steps", "doc-drift", "defect", "papercut"] as const;
export const FRICTION_REPORTERS = ["agent", "human"] as const;
export const MAX_FRICTION_SUMMARY = 500;
export const MAX_FRICTION_EVIDENCE = 2_000;
export const FRICTION_FINGERPRINT_RE = /^[a-f0-9]{16}$/;
// Mandate bounds (mandate form v2). A mandate is the invocation of ONE planning
// protocol in a new track, and `skills/herdr-create/references/mandate.schema.json`
// is its authority: the zod object below mirrors that schema bound for bound, so
// the advertised contract IS the enforced one. The only limit added here is a
// cap on the whole serialized document, named with the observed size in its
// rejection message per the goal-4096 lesson (friction 29239ed8).
export const MANDATE_VERSION = 2 as const;
export const MANDATE_PROTOCOLS = ["inquire", "elicit", "sketch", "preview", "ideate"] as const;
export const MAX_MANDATE_SENTENCE = 400;
export const MAX_MANDATE_UTTERANCE = 800;
export const MAX_MANDATE_SOURCE = 200;
export const MAX_MANDATE_CANDIDATE = 200;
export const MAX_MANDATE_CANDIDATES = 8;
export const MAX_MANDATE_ITEMS = 32;
export const MAX_MANDATE_BINDS = 8;
/** `entry.binds` coordinates: an index into the mandate's own `open[]` array (plan decision D-01). */
export const MANDATE_BIND_RE = /^open\[[0-9]+\]$/;
export const MAX_MANDATE_BYTES = 65_536;
// Hard transport ceiling for the bounded one-line fields below. It exists only
// so an absurd payload cannot reach the named-limit validator; the published
// limits are the contract.
const MANDATE_TRANSPORT_STRING = 64_000;

// Budget = justification cadence, not a wall (identity/comms redesign, decisions
// 7-8). Metering is a run-level aggregate over the ORCH and every lane session,
// judged at every guarded op with conservative margins; precise accounting is a
// non-goal. The seed in the mandate is a declared estimate, never a contract, and
// a run that declares none still gets these defaults so that no run can spend
// unbounded without ever justifying itself.
//
// The fallbacks are calibrated deliberately tight: roughly 15k generative tokens
// per minute for an ORCH plus one worker lane, over half an hour of focused work.
// They exist so the audit cadence is meaningful on an undeclared run, not so runs
// fit inside them — a nontrivial undeclared run is expected to park early and
// justify itself. A caller that knows the scope declares its own estimate.
export const DEFAULT_BUDGET_TOKENS = 500_000;
export const DEFAULT_BUDGET_MINUTES = 30;
export const MAX_BUDGET_TOKENS = 1_000_000_000;
export const MAX_BUDGET_MINUTES = 100_000;
// Covenants: one extension may raise the cap by at most half of what is already
// granted, and extensions may not arrive faster than this interval. Runaway
// therefore becomes slow and visible instead of impossible.
export const BUDGET_STEP_FRACTION = 0.5;
export const MIN_EXTENSION_INTERVAL_MS = 15 * 60_000;
// A session whose official JSONL cannot be read is charged this much rather than
// nothing: an unmeasurable session must never look free.
export const ASSUMED_SESSION_TOKENS = 50_000;
export const MAX_JUSTIFICATION_ITEM = 500;
export const BUDGET_POLICIES = ["full", "notify"] as const;
export const BUDGET_VERDICTS = ["grant", "partial", "deny"] as const;
export const BUDGET_PARK_REASONS = ["over-cap", "audit-unavailable", "clamp-unreadable", "approval-required", "denied"] as const;
// How an approved grant was APPLIED on one axis, which is a different question
// from what the auditor decided (friction 09470253737e9da6: verdict `grant`,
// granted_tokens 600000, effective cap still 400000, run still parked on
// `approval-required`). The audit verdict is the decision; this is its
// application. `applied` — the axis ceiling carried the granted figure.
// `awaiting-clamp` — the human still has to raise the clamp for it to take
// effect (where a `full`-policy clamp does not already carry the granted
// figure, and wherever the clamp is unreadable). `pinned` — a human ceiling on
// that axis is below the granted figure and no tool op raises it.
// `write-owed` — the server's own clamp write did not land and is retried at
// the next guarded op. `none` — nothing was granted on that axis, or the
// verdict was not a grant.
//
// TENSE MATTERS (integration review I4). On a disposed extension `applied` and
// `none` are terminal application HISTORY: they record how that grant landed at
// its settlement, and a later clamp change does not rewrite them, so an axis
// recorded `applied` may since have been capped below the figure it applied.
// The three transient states describe an outstanding application condition and
// are re-derived at every observation. Never read any of them as the current
// permission to spend: `effective_cap`, `usable` (axis usage < axis effective
// cap at the observed moment) and `park_reason` are what say whether the run can
// proceed right now, which is also why a grant may read `awaiting-clamp` on an
// axis that is perfectly usable because the human's ceiling was already high.
export const BUDGET_APPLIED_STATES = ["applied", "awaiting-clamp", "pinned", "write-owed", "none"] as const;
// The emergency carve-out's own audit vocabulary (BUD-016, friction
// 8917760a9545c642). It is deliberately disjoint from BUDGET_VERDICTS: the two
// audits judge different questions, are written to different documents, and
// dispose differently — a budget verdict moves a cap, an emergency verdict can
// only decide whether the carve-out stays open, because a registration that
// already dispatched cannot be recalled. There is no partial verdict: an add
// either was the repair of a run-blocking failure or was not.
export const EMERGENCY_VERDICTS = ["justified", "unjustified"] as const;

// Succession claim grammar (M5 Phase A, friction a421acd8c19127be). A reset or
// handoff copies planning context, not truth (LIFE-008), and the measured
// failure was not a weak revalidation but an absent one: the reported track had
// no `reset_of` and no `reset.json`, so nothing on the reset path applied. What
// every succession did have was a hand-written handoff document under a filename
// the author chose, which no code could find. So the canonical coordinate is
// fixed here, and the load-bearing claims inside it must carry the coordinates
// and commands that make re-measuring them cheap.
//
// The truth of a prose claim is undecidable; its presentation is not. The
// disposition vocabulary is therefore closed at three values, and every value
// outside it is a parse failure rather than a third state — an unverified claim
// must say so instead of reading as a checked one.
export const SUCCESSION_DOCUMENT_NAME = "handoff.md";
export const SUCCESSION_CLAIMS_HEADING = "Inherited claims";
export const CLAIM_COLUMNS = ["claim", "coordinate", "command", "observed", "disposition"] as const;
export const CLAIM_DISPOSITIONS = ["measured", "unverified", "withdrawn"] as const;
// A Git object name as `git rev-parse HEAD` prints it: the freshness comparison
// is an equality against that exact 40-hex form, never a prefix match.
export const CLAIM_SHA_RE = /^[0-9a-f]{40}$/;
export type ClaimDisposition = (typeof CLAIM_DISPOSITIONS)[number];
export type InheritedClaim = {
  claim: string;
  disposition: ClaimDisposition;
  coordinate?: string;
  command?: string;
  observed?: { sha: string; at: string };
};

export type ToolName = (typeof TOOL_NAMES)[number];
export type Effect = "none" | "confirmed" | "ambiguous";
export type ErrorPhase = "validate" | "storage" | "select" | "model-verify" | "attest" | "prompt" | "wait" | "budget" | "settlement" | "resume" | "close";
export type AssignmentState = "queued" | "prompting" | "working" | "blocked" | "completed" | "failed" | "ambiguous";
export type LaneState = "starting" | "idle" | "working" | "blocked" | "resume-needed" | "closing" | "closed" | "failed";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];
export type RunRef = { track_id: string; run_id: string };
export type MessageBoundary = (typeof MESSAGE_BOUNDARIES)[number];
export type FrictionKind = (typeof FRICTION_KINDS)[number];
export type FrictionReporter = (typeof FRICTION_REPORTERS)[number];
export type FrictionRecord = {
  at: string;
  kind: FrictionKind;
  reporter: FrictionReporter;
  summary: string;
  fingerprint: string;
  tool?: string;
  error_code?: string;
  evidence?: string;
  track_id?: string;
  run_id?: string;
  pane_id?: string;
};
// Delivery is an observation, never a contract failure: a message tool call only
// hard-errors on invalid input, so a broken channel stays visible instead of
// silently killing the flow behind retryable errors.
export type MessageDelivery = "delivered" | "deferred" | "rejected_blocked" | "target_unresolved" | "failed";

export type Separation = {
  kind: "direction" | "ownership" | "dependency";
  reason: string;
  conflicts_with_worker_id: string;
};

export type TokenUsageObservation = {
  source: "omp-jsonl";
  session_id: string;
  observed_at: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
};

export type AdvisoryUnownedChanges = {
  advisory: true;
  paths: string[];
  truncated: boolean;
};

/**
 * Read-only preflight observation of the ownership other runs in the same
 * project directory have already declared. It is output, never persisted state
 * and never a verdict: an overlap is a fact two orchestrators negotiate in their
 * channel documents (NG-012), not something the server arbitrates or refuses.
 */
export type InterRunOwnershipOverlap = {
  track_id: string;
  run_id: string;
  assignment_id: string;
  state: AssignmentState;
  /** The requesting artifact's own declared values that the peer also covers. */
  paths: string[];
};

export type InterRunOwnershipReport = {
  peer_runs_scanned: number;
  cwd_shared_by: number;
  overlaps: InterRunOwnershipOverlap[];
  unclassified_declarations: number;
  truncated: boolean;
  observation_warning?: string;
};

export type AssignmentSettlementObservation = {
  elapsed_ms?: number;
  token_usage?: TokenUsageObservation;
  advisory_unowned_changes?: AdvisoryUnownedChanges;
  observation_warning?: string;
};

export type WorkerStalenessObservation = {
  observed_at: string;
  last_activity_at: string;
  queue_depth: number;
};

export type TrackTotals = {
  lane_count: number;
  assignments_by_state: Record<AssignmentState, number>;
  settled_elapsed_ms: number;
  settled_elapsed_observations: number;
  settled_token_usage: {
    observations: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
  };
  saturated: boolean;
};

export type AssignmentArtifact = {
  assignment_id: string;
  responsibility_key: string;
  goal: string;
  completion_conditions: string[];
  write_ownership: string[];
  dependencies: string[];
  user_boundaries: string[];
  profile: string;
  /**
   * Optional display-only label read from the artifact's fourth frontmatter
   * field. It appears here because the parser saw it, never because anything
   * stored it: AssignmentRecord has no counterpart, so a label cannot reach the
   * registry, a lane queue, a settlement, or a scheduling decision.
   */
  label?: string;
  /**
   * The optional trailing `# References` section, as the artifact declared it:
   * a run-relative path and the SHA-256 the author pinned it at. Grammar and
   * path syntax are decided here, at parse time; existence, containment,
   * symlink and hardlink refusal, the size bound, and the hash comparison are
   * filesystem questions the tool layer answers (Q4, Q13).
   */
  references?: { path: string; sha256: string }[];
};

export type AssignmentRecord = {
  assignment_id: string;
  responsibility_key: string;
  worker_id: string;
  state: AssignmentState;
  instructions_sha256: string;
  prompted_at?: string;
  report_sha256?: string;
  completed_at?: string;
  elapsed_ms?: number;
  token_usage?: TokenUsageObservation;
  advisory_unowned_changes?: AdvisoryUnownedChanges;
  ambiguous_operation?: "prompt" | "resume";
  ambiguous_state_change_seq?: number;
  /**
   * Files the immutable assignment pinned by hash in its optional trailing
   * `# References` section (v5). The registry stores the SHAPE only — the
   * run-relative path and the hash the artifact declared — so a later drift
   * check has something to compare against; every path semantic (containment,
   * symlink and hardlink refusal, size bound, re-verification) lives in the
   * tool layer that reads them.
   */
  references?: { path: string; sha256: string }[];
  /**
   * A boundary the worker REPORTED and the machine did not act on (v5): a
   * `status: blocked` completion block is recognized and recorded here, and it
   * settles nothing. Assignment state, lane runtime state, `wait.until`
   * semantics, and doorbell boundaries are untouched by it; a later
   * `completed`/`failed` block is what settles (friction 89bc054958c59c88).
   */
  reported_boundary?: "blocked";
  created_at: string;
  updated_at: string;
};

export type WorkerLaneRecord = {
  worker_id: string;
  responsibility_key: string;
  lane_generation: 1;
  separation?: Separation;
  active_assignment_id?: string;
  queued_assignment_ids: string[];
  last_completed_assignment_id?: string;
  state: LaneState;
  state_change_seq: number;
  official_session_id?: string;
  official_session_path?: string;
  expected_provider?: string;
  expected_model?: string;
  effective_thinking?: Thinking;
  created_at: string;
  updated_at: string;
};

export type ResponsibilityRecord = {
  key: string;
  worker_ids: string[];
};

// Birth-based ORCH identity (identity/comms redesign, decision 1): ORCH is
// born, never appointed. The latest birth record is the sole command identity
// for a run; stale-generation (zombie) sessions are rejected at guarded ops.
// A birth's origin also records how the generation came to exist: `spawn` from an
// atomic open or a legacy start, `claim` from a legacy run's first guarded
// command, and `rebirth` from decision 9's approved clean restart. The chain is
// therefore self-describing — a generation carrying `rebirth` names both the
// context destruction and the human approval that allowed it.
export const ORCH_BIRTH_ORIGINS = ["claim", "spawn", "rebirth"] as const;
export type OrchBirthOrigin = (typeof ORCH_BIRTH_ORIGINS)[number];
export const REVIVAL_MODES = ["resume", "rebirth"] as const;
export type RevivalMode = (typeof REVIVAL_MODES)[number];
export type OrchBirthRecord = {
  generation: number;
  official_session_id: string;
  official_session_path?: string;
  pane_id: string;
  origin: OrchBirthOrigin;
  /** SHA-256 of the human-owned approval file that authorized a rebirth. */
  approval_sha256?: string;
  born_at: string;
};

// Death of the bootstrapper (decision 3). `herdr_track open` stamps the creator
// before it spawns anything, so the record doubles as the open-in-flight marker.
// An attested creator is keyed by its official session; a degraded creator has
// only the inherited pane coordinate and is explicitly unverified. Creator plus
// birth means the opening caller is retired for this run.
type OrchCreatorBase = {
  pane_id: string;
  mandate_sha256: string;
  opened_at: string;
};
export type OrchCreatorRecord = OrchCreatorBase & (
  | { session_id: string; verified?: true }
  | { session_id?: never; verified: false }
);

// LEGACY, READ-ONLY (friction 221abf10d2280b47). `open` no longer records a
// creator role table: spawns pass the role ALIAS and each child resolves it from
// its own persisted settings, so a caller's observed role values are neither
// needed nor trustworthy as a configuration record. Registries written before
// that change still carry the field and MUST keep validating, so the shape stays
// here as a reader contract only. Nothing writes it.
export type PinnedRoleModel = {
  provider: string;
  model: string;
  thinking?: Thinking;
};
export type PinnedRolesRecord = {
  roles: Record<string, PinnedRoleModel>;
  observed_session_id: string;
  observed_at: string;
  source: string;
};

export type MandateProtocol = (typeof MANDATE_PROTOCOLS)[number];

export type MandateBudget = {
  tokens: number;
  minutes: number;
  doorbell_policy: BudgetPolicy;
};

export type MandateEntry = {
  protocol: MandateProtocol;
  utterance: string;
  reason: string;
  binds?: string[];
};

export type MandateDecision = {
  decision: string;
  source: string;
  reason: string;
};

export type MandateOpenItem = {
  item: string;
  candidates?: string[];
};

/** The mandate form v2 object, shaped exactly like references/mandate.schema.json. */
export type Mandate = {
  mandate_version: typeof MANDATE_VERSION;
  purpose: string;
  language: string;
  entry: MandateEntry;
  settled: MandateDecision[];
  substrate: string[];
  open: MandateOpenItem[];
  done_when: string[];
  forbidden: string[];
  budget: MandateBudget;
};

export type BudgetPolicy = (typeof BUDGET_POLICIES)[number];
export type BudgetVerdict = (typeof BUDGET_VERDICTS)[number];
export type BudgetParkReason = (typeof BUDGET_PARK_REASONS)[number];
export type BudgetAppliedState = (typeof BUDGET_APPLIED_STATES)[number];
export type EmergencyVerdict = (typeof EMERGENCY_VERDICTS)[number];

/** Bounded self-justification for one extension: done, remaining, why more. */
export type BudgetJustification = {
  done: string;
  remaining: string;
  why_more: string;
};

/**
 * The bounded claim an `add` carries to pass a budget park once (BUD-016): what
 * operational failure blocks the run, and why registering the repair cannot wait
 * for the ordinary extension ladder. These two lines are the whole subject of
 * the post-hoc audit, so they are rendered verbatim into its document.
 */
export type EmergencyClaim = {
  failure: string;
  why_now: string;
};

/** One admitted emergency registration: the claim plus the assignment it was made for. */
export type EmergencyRequest = {
  assignment_id: string;
  claim: EmergencyClaim;
};

/**
 * One trip up the escalation ladder. `pending` means the auditor session was
 * spawned and its verdict has not landed yet; the next `budget_extend` with the
 * identical justification lands it. `abandoned` is the explicit end of an audit
 * that never produced a verdict: the landing attempts ran out, so the attempt is
 * closed as bought-nothing rather than left pending forever (friction
 * 183b6d4102ddfbfa). Only `settled` ever moved a cap. The ORCH never writes this
 * record and never speaks to the auditor.
 */
export type BudgetExtension = {
  ordinal: number;
  requested_tokens: number;
  /**
   * The wall-clock side of the same request (v5, friction 2c8f859d4875bbc0: a
   * run over its minutes axis had no extension path at all). Same covenant as
   * the token axis — a request above half of what is already granted is
   * TRUNCATED to the step, never refused — and an omitted axis falls back to
   * its own step, so a grant still moves both dimensions.
   */
  requested_minutes?: number;
  justification_sha256: string;
  audit_path: string;
  audit_worker_id?: string;
  state: "pending" | "settled" | "abandoned";
  verdict?: BudgetVerdict;
  granted_tokens?: number;
  /** Minutes this extension actually moved, recorded on the same footing as `granted_tokens`. */
  granted_minutes?: number;
  /**
   * How the grant was applied per axis, recorded separately from the verdict
   * above. `applied`/`none` are terminal application HISTORY on a disposed
   * extension and a later clamp change does not rewrite them; the three
   * transient states describe an outstanding condition, are re-derived at every
   * observation from the live clamp and policy, and the next guarded mutation
   * writes the derivation back. Current permission to spend is `effective_cap`,
   * `usable` and `park_reason`, never this field.
   */
  applied?: { tokens: BudgetAppliedState; minutes: BudgetAppliedState };
  /** True once the server proved the auditor session was closed and its tab gone. */
  audit_worker_closed?: boolean;
  retries: number;
  requested_at: string;
  settled_at?: string;
};

export type BudgetRecord = {
  seed_tokens: number;
  seed_minutes: number;
  /**
   * The `full`-policy minutes ceiling a verdict alone may not exceed — the
   * symmetric counterpart of `seed_tokens` on the token axis (Q10). A new run
   * seeds it from `seed_minutes`. A registry written before v5 has none, and is
   * read with `max(seed_minutes, granted_minutes)` projected in memory so that
   * minutes already valid under the older asymmetric rule stay valid; the first
   * guarded mutation materializes that projection once, together with the v5
   * promotion. Preserving a value the old rule already allowed is not a new
   * approval, and nothing here parks a run that was not parked before.
   */
  minutes_floor?: number;
  doorbell_policy: BudgetPolicy;
  granted_tokens: number;
  granted_minutes: number;
  extensions: BudgetExtension[];
  state: "active" | "parked";
  park_reason?: BudgetParkReason;
  park_detail?: string;
  parked_at?: string;
  // Set when an audit denies: the fingerprint of the human-owned clamp file at
  // that moment. A denied run may not re-audit its way out — only a human
  // touching the clamp file releases the next attempt (decision 7's ladder ends
  // at the human, so the machine must be able to tell that the human acted).
  denied_clamp_sha256?: string;
  // Armed-state for the 80% approach doorbell: present once the "approaching"
  // warning fired for this effective cap; a cap change re-arms it (the field is
  // replaced or cleared on the next guarded op). Additive and optional — absent
  // in older registries, no version bump.
  approach_warned?: { cap_tokens: number; cap_minutes: number; warned_at: string };
  // Token VALUES the server wrote into the human-owned clamp file, or committed
  // to write — never a byte fingerprint of that file: a human edit to
  // `max_minutes` or `note` expresses no opinion about the token ceiling and must
  // not pin it. `confirmed` is the last value a write is known to have landed;
  // `intended` is the value a settled, write-permitted grant owes the file.
  // A present `max_tokens` equal to neither is the human's own ceiling — a
  // permanent pin, `0` included. Additive and optional — absent in older
  // registries, no version bump.
  server_clamp_tokens?: { confirmed?: number; intended?: number };
  started_at: string;
};

/**
 * The judgment a guarded op makes. `judged_tokens` is the conservative figure:
 * measured usage plus a charge for every session whose JSONL could not be read.
 */
export type BudgetMetering = {
  observed_at: string;
  measured_tokens: number;
  measured_sessions: number;
  unmeasured_sessions: number;
  assumed_tokens: number;
  judged_tokens: number;
  elapsed_minutes: number;
  cap_tokens: number;
  cap_minutes: number;
  over_cap: boolean;
  clamp?: { path: string; max_tokens?: number; max_minutes?: number };
};

export type DelegationRegistry = {
  version: (typeof SUPPORTED_DELEGATION_VERSIONS)[number];
  owner: "herdr-delegator";
  run_path: string;
  revision: number;
  responsibilities: Record<string, ResponsibilityRecord>;
  lanes: Record<string, WorkerLaneRecord>;
  orch_births?: OrchBirthRecord[];
  orch_creator?: OrchCreatorRecord;
  pinned_roles?: PinnedRolesRecord;
  budget?: BudgetRecord;
  assignments: Record<string, AssignmentRecord>;
  created_at: string;
  updated_at: string;
};

const boundedTokenSchema = z.string().min(1).max(80).regex(BOUNDED_TOKEN_RE);
export const ompRuntimeFactsSchema = z.object({
  version: z.literal(1),
  session_id: boundedTokenSchema,
  reported_session_path: z.string().min(1).max(4096).optional(),
  pane_id: boundedTokenSchema,
  issued_at: z.string().min(1).max(64),
  nonce: z.string().regex(/^\d{13}\.[0-9a-f]{16}$/),
}).strict();
export type OmpRuntimeFacts = z.infer<typeof ompRuntimeFactsSchema>;

export type McpResult<T = unknown> = {
  ok: boolean;
  tool: ToolName;
  action: string;
  run: RunRef;
  effect: Effect;
  retryable: boolean;
  timed_out?: boolean;
  registry_revision?: number;
  worker?: Partial<WorkerLaneRecord>;
  assignment?: { assignment_id: string; state: AssignmentState; settlement?: AssignmentSettlementObservation };
  data?: T;
  error?: { code: string; phase: ErrorPhase; message: string; recovery: string; ambiguous_effect: boolean };
  friction_hint?: string;
};

const coordinate = z.string().regex(COORDINATE_RE);
// The published judgment criterion for `assignment_id` (JDG-001). This was the
// one identity field whose published shape dropped its regex while the enforced
// schema kept it, so the advertised contract accepted `A-R1` and the handler
// then refused it as an unnamed zod string — which is how a legal assignment
// got renamed instead of corrected (friction 87ef22382241e18f). Published and
// enforced now share this schema object, so the advertised grammar IS the
// enforced grammar, and the refusal carries the same sentence as the contract.
export const ASSIGNMENT_ID_GUIDANCE = `Assignment identifier, exactly ${ASSIGNMENT_RE.source}: the literal prefix "A-", then three or more digits that are not all zero — A-001, A-014, A-1207. The grammar is closed rather than conventional, because this single value is at once the registry key, the artifact filename on a case-insensitive filesystem, a literal interpolated into the completion-block pattern, and a pane metadata token value; past that fixed prefix the value admits no further letters, no case variants, no dots and no path separators. You choose the ID — the server never allocates one — and it encodes nothing: a human-readable name belongs in the artifact's optional display-only \`label\` frontmatter field, and two runs that both hold A-001 are told apart by the <track_id>/<run_id>/<assignment_id> coordinate, never by the ID alone.`;
const assignmentId = z.string().regex(ASSIGNMENT_RE, { error: ASSIGNMENT_ID_GUIDANCE }).describe(ASSIGNMENT_ID_GUIDANCE);
const workerId = z.string().regex(WORKER_RE);
const hash = z.string().regex(SHA256_RE);
// A wait cursor is an observation coordinate, never a session token or a
// promise: registry revision, lane state sequence, report bytes, and the moment
// the observation was taken. An explicit later recovery probe can hand it back
// to learn whether anything moved since then. It is not permission to extend a
// timed-out wait into a polling loop. The server owns the format; a caller only
// echoes it.
const waitCursor = z.string().max(80).regex(WAIT_CURSOR_RE);
const wait = z.object({
  until: z.array(z.enum(["idle", "done", "blocked"])).min(1).optional().describe("Agent states that satisfy the wait; an already-current state satisfies it immediately. Name the states that actually answer what you are waiting for — a blocked lane answers a readiness question but not a completion one."),
  timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional().describe(`Requested budget for one short state probe, used only when the awaited boundary is already expected to have occurred or as explicit recovery after a missing or inconsistent doorbell. A single server-side wait is clamped to ${MAX_EFFECTIVE_WAIT_MS} ms because MCP clients abort a call at 30000 ms. A timed-out wait ends the ORCH turn; do not repeat it or compose a longer vigil.`),
  cursor: waitCursor.optional().describe("The observation coordinate returned by an earlier wait (data.wait_cursor). Supply it only on an explicit later recovery probe after a missing or inconsistent doorbell; the result then reports whether anything moved since that observation. Never use it to repeat a timed-out wait. Omit it on the first wait."),
}).strict().optional();
const run = { track_id: coordinate, run_id: coordinate };
const separation = z.object({
  kind: z.enum(["direction", "ownership", "dependency"]),
  reason: z.string().min(1).max(500),
  conflicts_with_worker_id: workerId,
}).strict();
const mandateBudget = z.object({
  tokens: z.number().int().positive().max(MAX_BUDGET_TOKENS).describe(`Declared token estimate for the whole run — a calibration seed, never a contract; crossing it parks the run until the ORCH justifies an extension. Estimate what this mandate's scope should take: a single-lane implementation track spends tokens fast against little wall clock, so its token figure is the axis that binds.`),
  minutes: z.number().int().positive().max(MAX_BUDGET_MINUTES).describe(`Declared wall-clock estimate in minutes, measured from the open that spawns the ORCH — the same calibration seed in time, never a contract. A track that coordinates several lanes or waits on human gates burns minutes without burning tokens, so its minute figure is the axis that binds.`),
  doorbell_policy: z.enum(BUDGET_POLICIES).describe("Who decides an extension. notify: the machine audit decides each one and the human is only notified. full: the human approves every extension by raising the human-owned clamp file, and no audit verdict alone raises the cap."),
}).strict().describe("Budget seed and extension policy. The two axes are independent ceilings and the narrower one parks the run, so what you are really declaring is an implicit rate: tokens divided by minutes. Measured rates on this project's own closed runs span roughly 1,000 to 15,000 generative tokens per minute, and a seed rate several times off its run's real rate is what parks a run on the axis nobody was watching.");
const mandateEntry = z.object({
  protocol: z.enum(MANDATE_PROTOCOLS).describe("The one protocol the ORCH runs on its first turn, chosen by the gate descriptions in references/mandate.schema.json. inquire: facts the task needs are missing and some are reachable through the substrate. elicit: the intent is articulated but its decision coordinates are implicit in the substrate. sketch: a form has to be made that the user would recognize on sight. preview: a direction commitment is imminent and at least two named candidates cannot be judged from their descriptions. ideate: the space of options itself is what is missing. Enum membership is not availability — a protocol that protocols/UPSTREAM.json does not pin is refused with mandate_protocol_unavailable."),
  utterance: z.string().min(1).max(MAX_MANDATE_UTTERANCE).describe(`The invocation text the protocol receives, self-contained: what the user asks of this first turn, naming the bound substrate[] items by their inline coordinates and referring to a bound open item by its role ("the bound open item"), never by an open[N] coordinate — entry.binds is where that binding lives, and a coordinate in this text is reported as a one-unit defect. The ORCH passes it to the protocol unchanged. Limit ${MAX_MANDATE_UTTERANCE} characters.`),
  reason: z.string().min(1).max(MAX_MANDATE_SENTENCE).describe(`One sentence naming the deficit that chose this protocol, in the gate's own terms. Limit ${MAX_MANDATE_SENTENCE} characters.`),
  binds: z.array(z.string().regex(MANDATE_BIND_RE)).min(1).max(MAX_MANDATE_BINDS).optional().describe(`The open items this utterance is about, each an "open[N]" coordinate into this mandate's own open[] array. Required for preview and elicit, whose gates are decided on the bound item; optional otherwise, and omitted only when the first turn is about no open item in particular. At most ${MAX_MANDATE_BINDS} entries, each index must exist in open[], and for preview every bound item must carry two or more candidates.`),
}).strict().superRefine((value, ctx) => {
  // The two gates that are decided ON the bound item: without binds there is
  // nothing for the deterministic gate or the judge to read them against.
  if ((value.protocol === "preview" || value.protocol === "elicit") && value.binds === undefined) {
    ctx.addIssue({ code: "custom", path: ["binds"], message: `entry.binds is required when entry.protocol is ${value.protocol}: its gate is decided on the bound open item.` });
  }
}).describe("The one protocol the ORCH runs first, the exact input it is invoked with, and the open items that input is about.");
const mandateDecision = z.object({
  decision: z.string().min(1).max(MAX_MANDATE_SENTENCE).describe(`The decision as the user made it, one sentence. Limit ${MAX_MANDATE_SENTENCE} characters.`),
  source: z.string().min(1).max(MAX_MANDATE_SOURCE).describe(`Where the decision was made: a run document with its section (plan.md D-03), or "user, creator conversation <date>". Limit ${MAX_MANDATE_SOURCE} characters.`),
  reason: z.string().min(1).max(MAX_MANDATE_SENTENCE).describe(`The reason the user stated, or exactly "unstated". Never a reason the creator supplied.`),
}).strict();
const mandateOpenItem = z.object({
  item: z.string().min(1).max(MAX_MANDATE_SENTENCE).describe(`The open question as the user would say it, self-contained. Limit ${MAX_MANDATE_SENTENCE} characters.`),
  candidates: z.array(z.string().min(1).max(MAX_MANDATE_CANDIDATE)).max(MAX_MANDATE_CANDIDATES).optional().describe(`Alternatives already named in the conversation, subordinate data of the item. At most ${MAX_MANDATE_CANDIDATES} entries of ${MAX_MANDATE_CANDIDATE} characters. Candidate count is one input to routing, never a routing decision.`),
}).strict();
const mandateSentences = (what: string): z.ZodArray<z.ZodString> => z.array(z.string().min(1).max(MAX_MANDATE_SENTENCE)).max(MAX_MANDATE_ITEMS).describe(`${what} At most ${MAX_MANDATE_ITEMS} entries of ${MAX_MANDATE_SENTENCE} characters each; pass an empty array when there are none.`);
const mandate = z.object({
  mandate_version: z.literal(MANDATE_VERSION).describe("The mandate form version. Only 2 is accepted."),
  purpose: z.string().min(1).max(MAX_MANDATE_SENTENCE).describe(`Why this track exists and what it must achieve, one sentence in the user's own terms. Limit ${MAX_MANDATE_SENTENCE} characters.`),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).describe("BCP-47 tag of the language the creator conversation was held in (ko, en, ja-JP). The ORCH presents the entry protocol and every later turn in this language."),
  entry: mandateEntry,
  settled: z.array(mandateDecision).max(MAX_MANDATE_ITEMS).describe(`Decisions the user already made, each with its source and the reason the user gave or exactly "unstated". A creator-added interpretation is not a decision and belongs in open[]. At most ${MAX_MANDATE_ITEMS} entries.`),
  substrate: mandateSentences("Where the user's externalized thinking lives, one place per item, coordinate inline. One item must point at the run document that records the currently operative decisions."),
  open: z.array(mandateOpenItem).max(MAX_MANDATE_ITEMS).describe(`What the conversation did not settle, kept open on purpose for the new track to resolve with the user. The creator never closes an open item by guessing. At most ${MAX_MANDATE_ITEMS} entries.`),
  done_when: z.array(z.string().min(1).max(MAX_MANDATE_SENTENCE)).min(1).max(MAX_MANDATE_ITEMS).describe(`Observable conditions that make the track done, each verifiable by a delegate from a durable record and never a restatement of purpose. At most ${MAX_MANDATE_ITEMS} entries of ${MAX_MANDATE_SENTENCE} characters each.`),
  forbidden: mandateSentences("Track-specific prohibitions and every action the user reserves in this track: stage progression, lifecycle, remote changes, acceptance."),
  budget: mandateBudget,
}).strict().describe(`The mandate: the invocation of ONE planning protocol in a new track, shaped exactly like skills/herdr-create/references/mandate.schema.json. It is persisted verbatim as <run>/mandate.json and fingerprinted at the ORCH's first prompt, so it is settled before birth and never edited behind a living ORCH. The whole serialized document is limited to ${MAX_MANDATE_BYTES} bytes.`);
const justification = z.object({
  done: z.string().min(1).max(MANDATE_TRANSPORT_STRING).describe(`What the run has already delivered, in observable terms. One line, limit ${MAX_JUSTIFICATION_ITEM} characters.`),
  remaining: z.string().min(1).max(MANDATE_TRANSPORT_STRING).describe(`What concretely remains before the shape of success is met. One line, limit ${MAX_JUSTIFICATION_ITEM} characters.`),
  why_more: z.string().min(1).max(MANDATE_TRANSPORT_STRING).describe(`Why the remaining work needs more budget than the current cap. One line, limit ${MAX_JUSTIFICATION_ITEM} characters.`),
}).strict().describe("Bounded self-justification. It is appended verbatim to the append-only budget ledger and handed to a clean auditor session that never talks to you.");
// The emergency carve-out's input (BUD-016). It is a call-time field, never
// artifact frontmatter and never encoded in an identity: whether a registration
// was an emergency is a fact about the moment it was made, not about the
// immutable document (ASN-003a, ASN-007). Published and enforced share this
// object, so an older server that predates the field refuses it by name at its
// own strict boundary instead of persisting anything it cannot judge.
const emergency = z.object({
  failure: z.string().min(1).max(MANDATE_TRANSPORT_STRING).describe(`The operational failure that blocks this run itself — what is broken right now, in observable terms, not what work you want to continue. A clean auditor judges this line after the fact, and a claim it cannot recognize as a run-blocking failure is what closes the carve-out for the whole run. One line, limit ${MAX_JUSTIFICATION_ITEM} characters.`),
  why_now: z.string().min(1).max(MANDATE_TRANSPORT_STRING).describe(`Why registering this repair cannot wait for the ordinary ladder — budget_extend, or the human raising the clamp. The ladder is the default path out of a park; this field must say what makes it insufficient here. One line, limit ${MAX_JUSTIFICATION_ITEM} characters.`),
}).strict().optional().describe("Emergency carve-out for ONE registration while the run is budget-parked on the cadence reason `over-cap`. It buys registration only: nothing is granted, the park stands, and a queued assignment still is not promoted. It creates a post-hoc audit debt — the server writes `emergency-audit-<n>.md`, a clean auditor judges these two lines, and no second emergency add is admissible until that verdict lands. The verdict cannot recall what was already dispatched: `unjustified` closes the carve-out for this run permanently and routes the run's budget decisions to the human. Omit it unless this add repairs a failure that blocks the run itself; on an unparked run it asserts no authority and is recorded as unused.");
// The two axes an extension may ask for. Published and enforced share these
// objects, so the advertised grammar IS the enforced grammar (JDG-001). Both
// state the same three facts a caller cannot otherwise know: the covenant
// TRUNCATES rather than refuses, an omitted axis still moves by its own step
// because a grant moves both dimensions, and the registry figure a grant
// records is not automatically the effective ceiling — under `full`, or under a
// human clamp value below it, the response's `applied` and `required_clamp`
// name what is still owed.
const requestedTokens = z.number().int().positive().max(MAX_BUDGET_TOKENS).optional().describe("Token cap increase you are asking for. Ask for what the remaining work named in the justification needs. One extension may raise the cap by at most half of what is already granted, and a larger ask is TRUNCATED to that step rather than refused. Omitted, it defaults to that same step, because a grant moves both dimensions. A grant records the figure in the registry; `applied.tokens` is history — how that grant landed at settlement — while `effective_cap`, `usable` and `park_reason` say what the run may do now; read `required_clamp` for the exact value a human must write when the grant did not reach the ceiling.");
const requestedMinutes = z.number().int().positive().max(MAX_BUDGET_MINUTES).optional().describe("Wall-clock increase in minutes you are asking for — the axis a run coordinating several lanes or waiting on human gates exhausts first, and the one that used to have no extension path at all. Same covenant as the token axis: at most half of what is already granted, a larger ask TRUNCATED to that step, and an omitted axis defaulting to its own step. A grant records the figure in the registry; `applied.minutes` is settlement history, `effective_cap`/`usable`/`park_reason` are the present, and `required_clamp` names the value a human must write when the grant did not reach the ceiling. Under `full` no verdict raises either axis above the run's approval floor until the human writes max_minutes.");

export const herdrTrackInputShape = {
  ...run,
  action: z.enum(["open", "check", "init", "inspect", "start_orchestrator", "budget_extend", "revive", "close"]),
  cwd: z.string().min(1).optional(),
  mandate: mandate.optional(),
  reset_of: z.object(run).strict().optional(),
  justification: justification.optional(),
  requested_tokens: requestedTokens,
  requested_minutes: requestedMinutes,
  mode: z.enum(REVIVAL_MODES).optional().describe("How to bring the ORCH back. resume (the fallback) reconnects the recorded birth session and keeps its context, bumping no generation. rebirth destroys that context and starts generation+1; it needs the human-owned rebirth-approval.json naming that generation, run documents sufficient to reconstruct command, and an ORCH that is not live. Resume unless the recorded session is genuinely gone."),
  wait,
  expected_registry_revision: z.number().int().nonnegative().optional(),
};
// Queue insertion position for one `add` (friction 8917760a9545c642 ②). It is a
// call-time field and nothing else: it is never written to the artifact, the
// assignment ID, the label, or any registry record (ASN-003a), so a queue that
// was reordered once carries no priority anyone can re-read later.
const urgent = z.boolean().optional().describe("Insert this assignment at the HEAD of its lane's queue instead of appending it. It decides placement inside the queue and nothing else: an idle lane dispatches immediately, so the field has no effect there; a parked run still refuses to promote a queued head; nothing already dispatched is interrupted or recalled; and it is orthogonal to `emergency`, which buys registration past a budget park rather than queue order. It is call-time only — never persisted, never part of identity — so read the placement back from `data.queue_position` in this call's response. A mounted server older than this field silently drops it and appends: an absent `data.queue_position` in the response means the placement you asked for did not happen.");
// The whole authoring contract, published where an ORCH reads it BEFORE writing a
// file rather than after a preflight refuses one (friction 2f772405d442c6f3,
// 171183a6663fabb1, 0b2c5548cb73bf25). Every number here is the constant the
// parser enforces, so the text and the behavior are checked against one
// source rather than restated independently.
export const ASSIGNMENT_GRAMMAR_GUIDANCE = `The canonical assignment is one UTF-8 Markdown file at <run>/a2a/assignments/<assignment_id>.md, LF line endings only, at most ${MAX_ASSIGNMENT_ARTIFACT_BYTES} bytes.

Frontmatter: "---", then exactly "assignment_id: <A-nnn>", "responsibility_key: <key>", "profile: <profile>", optionally "label: <display-only label>", then "---", then a blank line. One space after each colon, no quoting, no trailing space. No other key, no repeated key, no blank line inside the block. Each value has its own published grammar: assignment_id on the assignment_id field of this same schema, responsibility_key a bounded lowercase coordinate, profile the configured-profile grammar (letters, digits, ".", "_" or "-", beginning alphanumeric, up to 64 characters — not lowercase-only), label — display only, never identity — 1 to ${MAX_ASSIGNMENT_LABEL} characters of letters, digits, "-" or "_", beginning and ending alphanumeric, no spaces (${ASSIGNMENT_LABEL_RE.source}). A refusal quotes the offending line and the pattern it had to match.

Body: the ${ASSIGNMENT_SECTIONS.length} required H1 sections, all of them, in this order — ${ASSIGNMENT_SECTIONS.map((section) => `"# ${section}"`).join(", ")} — each heading followed by one blank line, optionally followed by a trailing "# ${ASSIGNMENT_REFERENCES_SECTION}" section and nothing after it. "# Goal" is free prose of at most ${MAX_ASSIGNMENT_GOAL} characters. The other four are Markdown bullets only: at least one and at most ${MAX_ASSIGNMENT_SECTION_LINES} lines each, every line "- <text>" of 1 to ${MAX_ASSIGNMENT_BULLET} characters, with no blank lines, no wrapped continuation lines, no nested indentation and no sub-headings. An empty bullet section is refused: a section with nothing in it states nothing.

Trap: a line beginning "# " at column 1 starts a new section wherever it appears, INCLUDING inside a fenced code block, because sections are split before anything interprets fences. Indent such a fence so no line inside it begins at column 1.

"# ${ASSIGNMENT_REFERENCES_SECTION}" pins documents by hash: at most ${MAX_ASSIGNMENT_REFERENCES} bullets, each exactly "- <path> sha256:<64 lowercase hex>", where the hash is SHA-256 over the file's exact bytes. The path is relative to the RUN directory with no "..", no empty segment, no leading "/" and no backslash, and must name a regular file inside the run directory — no symlink, no hardlinked file, no directory, no two bullets naming the same file — of at most ${MAX_ASSIGNMENT_REFERENCE_BYTES} bytes; a document larger than that is split into several files and each part pinned by its own bullet. preflight and add verify every hash and REFUSE on a mismatch (\`reference_hash_mismatch\`, nothing registered); from the first dispatch onward a mismatch is a \`reference_drift\` warning on wait, worker inspect and track close, and the dispatch is never recalled. An artifact carrying this section is rejected by servers older than 3.9.0 with "missing or extra sections": respawn the plugin rather than deleting the section.

Settlement grammar: the worker appends, at the END of its own lane report and at column 1, "[Assignment Completion: <assignment_id>]" on one line — the bare ID, never the coordinate and never the label — and one recognized status line on the next. The three recognized lines are exactly "status: completed", "status: failed" and "status: blocked": lowercase key, lowercase value, no heading marker before the header, exactly one of them per block. Only completed and failed settle; blocked is recorded as a reported boundary that settles nothing, and a later completed/failed block is what settles. When a report carries several valid blocks for one assignment the LAST one in file order is acted on; a block appended after the assignment already settled changes nothing and is reported as \`completion_block_after_terminal\`.

add makes the registered artifact read-only (0444). It is immutable from that instant: author a NEW assignment rather than editing a dispatched one.`;
const routingGoal = z.string().min(1).max(MAX_ASSIGNMENT_GOAL);
const routingSection = z.array(z.string().min(1).max(MAX_ASSIGNMENT_BULLET)).max(MAX_ASSIGNMENT_SECTION_LINES);
const routingBounds = {
  write_ownership: routingSection.optional(),
  dependencies: routingSection.optional(),
  user_boundaries: routingSection.optional(),
};

export const herdrAssignmentInputShape = {
  ...run,
  action: z.enum(["route", "add", "preflight", "wait"]).describe(`Call route with a goal before writing an assignment or reading the delegation rules to ask who should do the work; it is advisory and read-only. preflight validates the canonical assignment file and decides nothing; add registers it immutably and dispatches it; wait observes the lane holding it.\n\n${ASSIGNMENT_GRAMMAR_GUIDANCE}`),
  goal: routingGoal.optional(),
  ...routingBounds,
  assignment_id: assignmentId.optional(),
  responsibility_key: coordinate.optional(),
  instructions_sha256: hash.optional(),
  separation: separation.optional(),
  urgent,
  emergency,
  wait,
};
export const herdrWorkerInputShape = {
  ...run,
  action: z.enum(["list", "inspect", "resume", "close"]),
  responsibility_key: coordinate.optional(),
  worker_id: workerId.optional(),
  output_lines: z.number().int().min(1).max(200).optional().describe("Trailing lines of the worker's captured output to return. Ask for the fewest that answer the question you have; 200 is the ceiling, not the reading size."),
  compact: z.boolean().optional().describe("Omit the lane's invariant identity and configuration metadata — coordinates, agent name, profile, model, config sources — and return only what can change: state, sequence, verified session, captured output, and staleness. Use it for a supervision probe on a lane you have already inspected once; the full form is the default."),
  expected_session_id: z.string().min(1).max(256).optional(),
  expected_state_change_seq: z.number().int().nonnegative().optional(),
};
export const herdrMessageInputShape = {
  ...run,
  action: z.enum(["wake_orch", "wake_orch_audit", "wake_peer", "wake_worker", "notify_run"]),
  assignment_id: assignmentId.optional().describe("Which assignment the bell is about. Required by wake_orch, where it names the assignment whose boundary you reached. Optional on wake_worker, where it selects the subject axis of a bell the server composes: it MUST be the target lane's active assignment or one of its queued assignments, and any other value — a terminal assignment on that lane, another lane's assignment, or an unregistered ID — is reported as `data.delivery: \"target_unresolved\"` rather than guessed. No other action accepts it."),
  boundary: z.enum(MESSAGE_BOUNDARIES).optional().describe("The worker boundary that produced this bell. It belongs to wake_orch alone and every other action rejects it: a doorbell the ORCH sends to its own worker announces no boundary, because the worker's own report is what states one."),
  to_worker_id: workerId.optional(),
  to_track_id: coordinate.optional(),
  to_run_id: coordinate.optional(),
};
export const herdrFrictionInputShape = {
  action: z.enum(["report", "list"]),
  kind: z.enum(FRICTION_KINDS).optional().describe("Standardized friction type. contract-gap: the grammar/schema cannot express a legitimate intent. false-block: a guard rejected a correct action. ambiguous-outcome: a result left the effective state or next step unclear. excessive-steps: one logical operation needed too many calls. doc-drift: documented behavior disagrees with observed behavior. defect: outright wrong behavior. papercut: any other observed annoyance."),
  reporter: z.enum(FRICTION_REPORTERS).optional().describe("agent: autonomous observation by the calling agent. human: a user-observed issue transcribed on the user's behalf."),
  summary: z.string().min(1).max(MAX_FRICTION_SUMMARY).optional().describe("One concrete single-line symptom; normalized for duplicate grouping."),
  tool: boundedTokenSchema.optional().describe("Surface the friction concerns (a herdr_* tool, skill, doc, or CLI name)."),
  error_code: boundedTokenSchema.optional(),
  evidence: z.string().min(1).max(MAX_FRICTION_EVIDENCE).optional().describe("Bounded verbatim evidence: error output, the exact rejected input, or reproduction notes. When the friction is an error, include the error message verbatim and not only its code: one code is thrown from several boundaries with different messages, so a later reader who has to reconstruct which boundary failed can do it from the message and otherwise only by eliminating candidates from the surviving state."),
  track_id: coordinate.optional(),
  run_id: coordinate.optional(),
  fingerprint: z.string().regex(FRICTION_FINGERPRINT_RE).optional(),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum records to return. Ask for the number you will actually read; 200 is the ceiling, not the page size."),
};

export const herdrTrackSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("open"), cwd: z.string().min(1), mandate }).strict(),
  z.object({ ...run, action: z.literal("check"), cwd: z.string().min(1), mandate }).strict(),
  z.object({ ...run, action: z.literal("init"), cwd: z.string().min(1), reset_of: z.object(run).strict().optional() }).strict(),
  z.object({ ...run, action: z.literal("inspect") }).strict(),
  z.object({ ...run, action: z.literal("start_orchestrator") }).strict(),
  z.object({ ...run, action: z.literal("budget_extend"), justification, requested_tokens: requestedTokens, requested_minutes: requestedMinutes, wait }).strict(),
  z.object({ ...run, action: z.literal("revive"), mode: z.enum(REVIVAL_MODES).optional(), wait }).strict(),
  z.object({ ...run, action: z.literal("close"), expected_registry_revision: z.number().int().nonnegative() }).strict(),
]);
export const herdrAssignmentSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("route"), goal: routingGoal, ...routingBounds }).strict(),
  z.object({ ...run, action: z.literal("add"), assignment_id: assignmentId, responsibility_key: coordinate, instructions_sha256: hash, separation: separation.optional(), urgent, emergency, wait }).strict(),
  z.object({ ...run, action: z.literal("preflight"), assignment_id: assignmentId, responsibility_key: coordinate }).strict(),
  z.object({ ...run, action: z.literal("wait"), assignment_id: assignmentId, wait }).strict(),
]);
export const herdrWorkerSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("list"), responsibility_key: coordinate.optional() }).strict(),
  z.object({ ...run, action: z.literal("inspect"), worker_id: workerId, output_lines: z.number().int().min(1).max(200).optional(), compact: z.boolean().optional() }).strict(),
  z.object({ ...run, action: z.literal("resume"), worker_id: workerId, expected_session_id: z.string().min(1).max(256) }).strict(),
  z.object({ ...run, action: z.literal("close"), worker_id: workerId, expected_session_id: z.string().min(1).max(256), expected_state_change_seq: z.number().int().nonnegative() }).strict(),
]);
export const herdrMessageSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("wake_orch"), assignment_id: assignmentId, boundary: z.enum(MESSAGE_BOUNDARIES) }).strict(),
  // The clean auditor's own bell. It carries no assignment and no boundary
  // because an audit is not an assignment: the run coordinate is the whole
  // input, and the audit document it points at stays the sole authority for the
  // verdict. A separate action rather than relaxed `wake_orch` fields, so the
  // worker bell keeps its published requirement to name both.
  z.object({ ...run, action: z.literal("wake_orch_audit") }).strict(),
  z.object({ ...run, action: z.literal("wake_peer"), to_worker_id: workerId }).strict(),
  z.object({ ...run, action: z.literal("wake_worker"), to_worker_id: workerId, assignment_id: assignmentId.optional() }).strict(),
  z.object({ ...run, action: z.literal("notify_run"), to_track_id: coordinate, to_run_id: coordinate }).strict(),
]);
export const herdrFrictionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("report"), kind: z.enum(FRICTION_KINDS), reporter: z.enum(FRICTION_REPORTERS), summary: z.string().min(1).max(MAX_FRICTION_SUMMARY), tool: boundedTokenSchema.optional(), error_code: boundedTokenSchema.optional(), evidence: z.string().min(1).max(MAX_FRICTION_EVIDENCE).optional(), track_id: coordinate.optional(), run_id: coordinate.optional() }).strict(),
  z.object({ action: z.literal("list"), kind: z.enum(FRICTION_KINDS).optional(), fingerprint: z.string().regex(FRICTION_FINGERPRINT_RE).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
]);

export type HerdrTrackInput = z.infer<typeof herdrTrackSchema>;
export type HerdrAssignmentInput = z.infer<typeof herdrAssignmentSchema>;
export type HerdrWorkerInput = z.infer<typeof herdrWorkerSchema>;
export type HerdrMessageInput = z.infer<typeof herdrMessageSchema>;
export type HerdrFrictionInput = z.infer<typeof herdrFrictionSchema>;

export class McpContractError extends Error {
  constructor(public readonly code: string, message: string, public readonly phase: ErrorPhase, public readonly recovery: string, public readonly ambiguousEffect = false, public readonly retryable = false) { super(message); }
}
export const nowIso = (): string => new Date().toISOString();
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
