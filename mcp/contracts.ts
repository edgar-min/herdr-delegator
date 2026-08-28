import { createHash } from "node:crypto";
import { z } from "zod";

export const TOOL_NAMES = ["herdr_track", "herdr_assignment", "herdr_worker"] as const;
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
export const MAX_RESPONSE_TEXT = 8_000;
export const DELEGATION_VERSION = 1 as const;
export const OBSERVATION_SOURCE = "herdr-delegator:observation";

export type ToolName = (typeof TOOL_NAMES)[number];
export type Effect = "none" | "confirmed" | "ambiguous";
export type ErrorPhase = "validate" | "storage" | "select" | "model-verify" | "attest" | "prompt" | "wait" | "respond" | "settlement" | "resume" | "close";
export type AssignmentState = "queued" | "prompting" | "working" | "blocked" | "completed" | "failed" | "ambiguous";
export type LaneState = "starting" | "idle" | "working" | "blocked" | "resume-needed" | "closing" | "closed" | "failed";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
export type RunRef = { track_id: string; run_id: string };

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
  ambiguous_operation?: "prompt" | "respond" | "resume";
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

export type DelegationRegistry = {
  version: 1;
  owner: "herdr-delegator";
  run_path: string;
  revision: number;
  responsibilities: Record<string, ResponsibilityRecord>;
  lanes: Record<string, WorkerLaneRecord>;
  assignments: Record<string, AssignmentRecord>;
  created_at: string;
  updated_at: string;
};

const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const boundedTokenSchema = z.string().min(1).max(80).regex(BOUNDED_TOKEN_RE);
const concreteModelSchema = z.object({ provider: boundedTokenSchema, model: boundedTokenSchema }).strict();
export const ompRuntimeFactsSchema = z.object({
  version: z.literal(1),
  session_id: boundedTokenSchema,
  reported_session_path: z.string().min(1).max(4096).optional(),
  pane_id: boundedTokenSchema,
  cwd: z.string().min(1).max(4096),
  current: concreteModelSchema.extend({ thinking: thinkingSchema }).strict(),
  roles: z.record(z.string().regex(ROLE_RE), concreteModelSchema),
  config_sources: z.array(z.object({
    scope: boundedTokenSchema,
    path: z.string().min(1).max(4096),
    sha256: z.string().regex(SHA256_RE),
  }).strict()).max(64),
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
  registry_revision?: number;
  worker?: Partial<WorkerLaneRecord>;
  assignment?: { assignment_id: string; state: AssignmentState; settlement?: AssignmentSettlementObservation };
  skill_routes?: SkillRouteAdvisory[];
  data?: T;
  error?: { code: string; phase: ErrorPhase; message: string; recovery: string; ambiguous_effect: boolean };
};

const coordinate = z.string().regex(COORDINATE_RE);
const assignmentId = z.string().regex(ASSIGNMENT_RE);
const workerId = z.string().regex(WORKER_RE);
const hash = z.string().regex(SHA256_RE);
const wait = z.object({
  until: z.array(z.enum(["idle", "done", "blocked"])).min(1).optional().describe("Agent states that satisfy the wait; an already-current state satisfies it immediately."),
  timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional().describe(`Requested wait budget. A single server-side wait is clamped to ${MAX_EFFECTIVE_WAIT_MS} ms because MCP clients abort a call at 30000 ms; achieve a longer logical wait by repeating bounded wait calls.`),
}).strict().optional();
const run = { track_id: coordinate, run_id: coordinate };
const separation = z.object({
  kind: z.enum(["direction", "ownership", "dependency"]),
  reason: z.string().min(1).max(500),
  conflicts_with_worker_id: workerId,
}).strict();

export const herdrTrackInputShape = {
  ...run,
  action: z.enum(["init", "inspect", "start_orchestrator", "close"]),
  cwd: z.string().min(1).optional(),
  reset_of: z.object(run).strict().optional(),
  expected_registry_revision: z.number().int().nonnegative().optional(),
};
export const herdrAssignmentInputShape = {
  ...run,
  action: z.enum(["add", "preflight", "wait", "respond"]),
  assignment_id: z.string().min(3).max(32),
  responsibility_key: coordinate.optional(),
  instructions_sha256: hash.optional(),
  separation: separation.optional(),
  wait,
  expected_state_change_seq: z.number().int().nonnegative().optional(),
  response: z.unknown().optional(),
};
export const herdrWorkerInputShape = {
  ...run,
  action: z.enum(["list", "inspect", "resume", "close"]),
  responsibility_key: coordinate.optional(),
  worker_id: workerId.optional(),
  output_lines: z.number().int().min(1).max(200).optional(),
  expected_session_id: z.string().min(1).max(256).optional(),
  expected_state_change_seq: z.number().int().nonnegative().optional(),
};

export const herdrTrackSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("init"), cwd: z.string().min(1), reset_of: z.object(run).strict().optional() }).strict(),
  z.object({ ...run, action: z.literal("inspect") }).strict(),
  z.object({ ...run, action: z.literal("start_orchestrator") }).strict(),
  z.object({ ...run, action: z.literal("close"), expected_registry_revision: z.number().int().nonnegative() }).strict(),
]);
export const herdrAssignmentSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("add"), assignment_id: assignmentId, responsibility_key: coordinate, instructions_sha256: hash, separation: separation.optional(), wait }).strict(),
  z.object({ ...run, action: z.literal("preflight"), assignment_id: assignmentId, responsibility_key: coordinate }).strict(),
  z.object({ ...run, action: z.literal("wait"), assignment_id: assignmentId, wait }).strict(),
  z.object({ ...run, action: z.literal("respond"), assignment_id: assignmentId, expected_state_change_seq: z.number().int().nonnegative(), response: z.discriminatedUnion("kind", [z.object({ kind: z.literal("text"), text: z.string().min(1).max(MAX_RESPONSE_TEXT) }).strict(), z.object({ kind: z.literal("keys"), keys: z.array(z.enum(["enter", "esc", "up", "down", "left", "right", "tab", "shift+tab", "y", "n"])).min(1).max(32) }).strict()]) }).strict(),
]);
export const herdrWorkerSchema = z.discriminatedUnion("action", [
  z.object({ ...run, action: z.literal("list"), responsibility_key: coordinate.optional() }).strict(),
  z.object({ ...run, action: z.literal("inspect"), worker_id: workerId, output_lines: z.number().int().min(1).max(200).optional() }).strict(),
  z.object({ ...run, action: z.literal("resume"), worker_id: workerId, expected_session_id: z.string().min(1).max(256) }).strict(),
  z.object({ ...run, action: z.literal("close"), worker_id: workerId, expected_session_id: z.string().min(1).max(256), expected_state_change_seq: z.number().int().nonnegative() }).strict(),
]);

export type HerdrTrackInput = z.infer<typeof herdrTrackSchema>;
export type HerdrAssignmentInput = z.infer<typeof herdrAssignmentSchema>;
export type HerdrWorkerInput = z.infer<typeof herdrWorkerSchema>;

export class McpContractError extends Error {
  constructor(public readonly code: string, message: string, public readonly phase: ErrorPhase, public readonly recovery: string, public readonly ambiguousEffect = false, public readonly retryable = false) { super(message); }
}
export const nowIso = (): string => new Date().toISOString();
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
