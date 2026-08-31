import { createHash } from "node:crypto";
import { z } from "zod";

export const TOOL_NAMES = ["herdr_track", "herdr_assignment", "herdr_worker", "herdr_message", "herdr_friction"] as const;
export const COORDINATE_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const RESPONSIBILITY_RE = COORDINATE_RE;
export const ASSIGNMENT_RE = /^A-(?!0+$)[0-9]{3,}$/;
export const WORKER_RE = /^w[1-9][0-9]*$/;
export const SHA256_RE = /^[a-f0-9]{64}$/;
export const ROLE_RE = /^@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const BOUNDED_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;
// MCP clients abort a single call at 30s, so a longer schema-legal `wait.timeout_ms`
// can only surface as a transport error. The server clamps every effective
// single-call wait below that bound; longer logical waits are composed by
// repeating bounded `wait` calls.
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
// loudly instead of calling malformed. Each upgrade only adds, so no existing
// field changes meaning.
export const DELEGATION_VERSION = 4 as const;
export const SUPPORTED_DELEGATION_VERSIONS = [1, 2, 3, 4] as const;
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
// Mandate bounds (identity/comms redesign, decision 5). The bootstrapper distills
// the conversation into WHAT and WHY; HOW belongs to the born ORCH. Every limit
// below is published in the tool schema up front and named with the observed size
// in its rejection message, per the goal-4096 lesson (friction 29239ed8).
export const MAX_MANDATE_INTENT = 4_096;
export const MAX_MANDATE_ITEM = 500;
export const MAX_MANDATE_ITEMS = 32;
export const MAX_MANDATE_BYTES = 16_384;
// Hard transport ceilings. They exist only so an absurd payload cannot reach the
// named-limit validator; the published limits above are the contract.
const MANDATE_TRANSPORT_STRING = 64_000;
const MANDATE_TRANSPORT_ITEMS = 256;

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

export type MandateBudget = {
  tokens?: number;
  minutes?: number;
  doorbell_policy?: BudgetPolicy;
};

export type Mandate = {
  intent: string;
  constraints: string[];
  shape_of_success: string[];
  budget?: MandateBudget;
};

export type BudgetPolicy = (typeof BUDGET_POLICIES)[number];
export type BudgetVerdict = (typeof BUDGET_VERDICTS)[number];
export type BudgetParkReason = (typeof BUDGET_PARK_REASONS)[number];

/** Bounded self-justification for one extension: done, remaining, why more. */
export type BudgetJustification = {
  done: string;
  remaining: string;
  why_more: string;
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
  justification_sha256: string;
  audit_path: string;
  audit_worker_id?: string;
  state: "pending" | "settled" | "abandoned";
  verdict?: BudgetVerdict;
  granted_tokens?: number;
  /** True once the server proved the auditor session was closed and its tab gone. */
  audit_worker_closed?: boolean;
  retries: number;
  requested_at: string;
  settled_at?: string;
};

export type BudgetRecord = {
  seed_tokens: number;
  seed_minutes: number;
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

export type SkillRouteAdvisory = {
  boundary: "plan" | "authoring" | "dispatch" | "completion" | "settlement" | "reset";
  surface: "orch" | "worker";
  skills: string[];
};

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
  skill_routes?: SkillRouteAdvisory[];
  skill_routes_note?: string;
  data?: T;
  error?: { code: string; phase: ErrorPhase; message: string; recovery: string; ambiguous_effect: boolean };
  friction_hint?: string;
};

const coordinate = z.string().regex(COORDINATE_RE);
const assignmentId = z.string().regex(ASSIGNMENT_RE);
const workerId = z.string().regex(WORKER_RE);
const hash = z.string().regex(SHA256_RE);
const wait = z.object({
  until: z.array(z.enum(["idle", "done", "blocked"])).min(1).optional().describe("Agent states that satisfy the wait; an already-current state satisfies it immediately. Name the states that actually answer what you are waiting for — a blocked lane answers a readiness question but not a completion one."),
  timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional().describe(`Requested wait budget. Size it to how long the awaited boundary plausibly needs: short for a state probe, longer only when awaiting a settlement you expect imminently, and repeat bounded waits instead of asking for the maximum. A single server-side wait is clamped to ${MAX_EFFECTIVE_WAIT_MS} ms because MCP clients abort a call at 30000 ms; a longer logical wait is achieved by repeating bounded wait calls.`),
}).strict().optional();
const run = { track_id: coordinate, run_id: coordinate };
const separation = z.object({
  kind: z.enum(["direction", "ownership", "dependency"]),
  reason: z.string().min(1).max(500),
  conflicts_with_worker_id: workerId,
}).strict();
const mandateBudget = z.object({
  tokens: z.number().int().positive().max(MAX_BUDGET_TOKENS).optional().describe(`Declared token estimate for the whole run — a calibration seed, never a contract; crossing it parks the run until the ORCH justifies an extension. Estimate what this mandate's scope should take. Undeclared falls back to ${DEFAULT_BUDGET_TOKENS}, which is deliberately tight.`),
  minutes: z.number().int().positive().max(MAX_BUDGET_MINUTES).optional().describe(`Declared wall-clock estimate in minutes, measured from the first metered guarded op — the same calibration seed in time, never a contract. Undeclared falls back to ${DEFAULT_BUDGET_MINUTES}, which is deliberately tight.`),
  doorbell_policy: z.enum(BUDGET_POLICIES).optional().describe("Who decides an extension. notify (the fallback): the machine audit decides each one and the human is only notified. full: the human approves every extension by raising the human-owned clamp file, and no audit verdict alone raises the cap. Choose full when the run's spend needs human authority, notify when the audit is sufficient."),
}).strict().optional().describe("Budget seed and extension policy. Declare an estimate calibrated to this mandate's scope — the tokens and minutes the work should take, not a ceiling to wish for. An undeclared seed falls back to tight documented defaults that will park a nontrivial run early.");
const mandate = z.object({
  intent: z.string().min(1).max(MANDATE_TRANSPORT_STRING).describe(`Why this track exists and what it must achieve, in the user's terms. WHAT and WHY only — HOW is the born ORCH's to decide. Limit ${MAX_MANDATE_INTENT} characters.`),
  constraints: z.array(z.string().min(1).max(MANDATE_TRANSPORT_STRING)).max(MANDATE_TRANSPORT_ITEMS).describe(`Boundaries the ORCH may not cross: budgets, forbidden surfaces, required approvals. At most ${MAX_MANDATE_ITEMS} entries of ${MAX_MANDATE_ITEM} characters each; pass an empty array when there are none.`),
  shape_of_success: z.array(z.string().min(1).max(MANDATE_TRANSPORT_STRING)).min(1).max(MANDATE_TRANSPORT_ITEMS).describe(`Observable conditions that make the track done. At most ${MAX_MANDATE_ITEMS} entries of ${MAX_MANDATE_ITEM} characters each.`),
  budget: mandateBudget,
}).strict().describe(`Bounded mandate persisted as orchestrator-instructions.md and fingerprinted at the ORCH's first prompt. The whole rendered document is limited to ${MAX_MANDATE_BYTES} bytes.`);
const justification = z.object({
  done: z.string().min(1).max(MANDATE_TRANSPORT_STRING).describe(`What the run has already delivered, in observable terms. One line, limit ${MAX_JUSTIFICATION_ITEM} characters.`),
  remaining: z.string().min(1).max(MANDATE_TRANSPORT_STRING).describe(`What concretely remains before the shape of success is met. One line, limit ${MAX_JUSTIFICATION_ITEM} characters.`),
  why_more: z.string().min(1).max(MANDATE_TRANSPORT_STRING).describe(`Why the remaining work needs more budget than the current cap. One line, limit ${MAX_JUSTIFICATION_ITEM} characters.`),
}).strict().describe("Bounded self-justification. It is appended verbatim to the append-only budget ledger and handed to a clean auditor session that never talks to you.");

export const herdrTrackInputShape = {
  ...run,
  action: z.enum(["open", "init", "inspect", "start_orchestrator", "budget_extend", "revive", "close"]),
  cwd: z.string().min(1).optional(),
  mandate: mandate.optional(),
  reset_of: z.object(run).strict().optional(),
  justification: justification.optional(),
  requested_tokens: z.number().int().positive().max(MAX_BUDGET_TOKENS).optional().describe("Token cap you are asking for. Ask for what the remaining work named in the justification needs; one extension may raise the cap by at most half of what is already granted regardless of what is requested."),
  mode: z.enum(REVIVAL_MODES).optional().describe("How to bring the ORCH back. resume (the fallback) reconnects the recorded birth session and keeps its context, bumping no generation. rebirth destroys that context and starts generation+1; it needs the human-owned rebirth-approval.json naming that generation, run documents sufficient to reconstruct command, and an ORCH that is not live. Resume unless the recorded session is genuinely gone."),
  wait,
  expected_registry_revision: z.number().int().nonnegative().optional(),
};
export const herdrAssignmentInputShape = {
  ...run,
  action: z.enum(["add", "preflight", "wait"]),
  assignment_id: z.string().min(3).max(32),
  responsibility_key: coordinate.optional(),
  instructions_sha256: hash.optional(),
  separation: separation.optional(),
  wait,
};
export const herdrWorkerInputShape = {
  ...run,
  action: z.enum(["list", "inspect", "resume", "close"]),
  responsibility_key: coordinate.optional(),
  worker_id: workerId.optional(),
  output_lines: z.number().int().min(1).max(200).optional().describe("Trailing lines of the worker's captured output to return. Ask for the fewest that answer the question you have; 200 is the ceiling, not the reading size."),
  expected_session_id: z.string().min(1).max(256).optional(),
  expected_state_change_seq: z.number().int().nonnegative().optional(),
};
export const herdrMessageInputShape = {
  ...run,
  action: z.enum(["wake_orch", "wake_peer", "wake_worker", "notify_run"]),
  assignment_id: z.string().min(3).max(32).optional(),
  boundary: z.enum(MESSAGE_BOUNDARIES).optional(),
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
  evidence: z.string().min(1).max(MAX_FRICTION_EVIDENCE).optional().describe("Bounded verbatim evidence: error output, the exact rejected input, or reproduction notes."),
  track_id: coordinate.optional(),
  run_id: coordinate.optional(),
  fingerprint: z.string().regex(FRICTION_FINGERPRINT_RE).optional(),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum records to return. Ask for the number you will actually read; 200 is the ceiling, not the page size."),
};

export const herdrTrackSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("open"), cwd: z.string().min(1), mandate }).strict(),
  z.object({ ...run, action: z.literal("init"), cwd: z.string().min(1), reset_of: z.object(run).strict().optional() }).strict(),
  z.object({ ...run, action: z.literal("inspect") }).strict(),
  z.object({ ...run, action: z.literal("start_orchestrator") }).strict(),
  z.object({ ...run, action: z.literal("budget_extend"), justification, requested_tokens: z.number().int().positive().max(MAX_BUDGET_TOKENS).optional(), wait }).strict(),
  z.object({ ...run, action: z.literal("revive"), mode: z.enum(REVIVAL_MODES).optional(), wait }).strict(),
  z.object({ ...run, action: z.literal("close"), expected_registry_revision: z.number().int().nonnegative() }).strict(),
]);
export const herdrAssignmentSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("add"), assignment_id: assignmentId, responsibility_key: coordinate, instructions_sha256: hash, separation: separation.optional(), wait }).strict(),
  z.object({ ...run, action: z.literal("preflight"), assignment_id: assignmentId, responsibility_key: coordinate }).strict(),
  z.object({ ...run, action: z.literal("wait"), assignment_id: assignmentId, wait }).strict(),
]);
export const herdrWorkerSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("list"), responsibility_key: coordinate.optional() }).strict(),
  z.object({ ...run, action: z.literal("inspect"), worker_id: workerId, output_lines: z.number().int().min(1).max(200).optional() }).strict(),
  z.object({ ...run, action: z.literal("resume"), worker_id: workerId, expected_session_id: z.string().min(1).max(256) }).strict(),
  z.object({ ...run, action: z.literal("close"), worker_id: workerId, expected_session_id: z.string().min(1).max(256), expected_state_change_seq: z.number().int().nonnegative() }).strict(),
]);
export const herdrMessageSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("wake_orch"), assignment_id: assignmentId, boundary: z.enum(MESSAGE_BOUNDARIES) }).strict(),
  z.object({ ...run, action: z.literal("wake_peer"), to_worker_id: workerId }).strict(),
  z.object({ ...run, action: z.literal("wake_worker"), to_worker_id: workerId }).strict(),
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
