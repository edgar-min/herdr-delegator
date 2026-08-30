// Contracts responsibilities for the Herdr delegator extension.
import { createHash } from "node:crypto";

export const OPERATIONS = ["ensure_worker", "prompt_wait", "inspect_worker", "close_worker"] as const;

export const WORKER_RE = /^w[1-9][0-9]*$/i;

export const COORDINATE_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const ROLE_RE = /^@[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const TRACK_OPERATIONS = ["init_run", "start_orch", "inspect_orch", "retire_orch_session"] as const;

export const SHA256_RE = /^[a-f0-9]{64}$/;

export const RESET_WORKER_POLICY = "close-settled-preserve-active" as const;

export const RESET_EVIDENCE_POLICY = "revalidate-before-import" as const;

export const SETTLED_STATES: Record<string, true> = { idle: true, done: true, blocked: true };

export const DEDUPE_STATES: Record<string, true> = {
  prompting: true,
  prompted: true,
  working: true,
  idle: true,
  done: true,
  blocked: true,
};

export const DEFAULT_TIMEOUT_MS = 120_000;

export const MIN_TIMEOUT_MS = 1_000;

export const MAX_TIMEOUT_MS = 300_000;

export const LOCK_STALE_MS = MAX_TIMEOUT_MS + 30_000;

export const LOCK_WAIT_MAX_MS = 5_000;

const MAX_ERROR_MESSAGE = 500;

export const REGISTRY_OWNER = "herdr-delegator";

export const REGISTRY_VERSION = 3 as const;

export const RUN_GENERATION = 1 as const;

export const FOCUS_TIMEOUT_MS = 10_000;

export const MAX_SESSION_BYTES = 1024 * 1024;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;

export const CONFIG_THINKING_LEVELS = ["inherit", ...THINKING_LEVELS] as const;

export type Operation = (typeof OPERATIONS)[number];

export type TrackOperation = (typeof TRACK_OPERATIONS)[number];

export type WorkerState =
  | "planned"
  | "pane-created"
  | "agent-ready"
  | "prompted"
  | "working"
  | "idle"
  | "done"
  | "blocked"
  | "closed"
  | "failed";

type WorkspaceState = "workspace-creating" | "ready";

export type FocusRestoration =
  | "unchanged"
  | "restored"
  | "partial"
  | "skipped-concurrent-user-focus";

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ConfigThinkingLevel = (typeof CONFIG_THINKING_LEVELS)[number];

export type ModelProfile = {
  role: string;
  thinking: ConfigThinkingLevel;
  /**
   * Optional profile-selection criteria prose, authored per profile in a
   * configuration layer. It is delivered to judgment boundaries as advisory
   * material and never resolves a model, a role, or authority.
   */
  guidance?: string;
};

/** A concrete model as the OMP model facade reports it. */
export type OmpModelIdentity = { provider: string; id: string };

/**
 * The read-only slice of an OMP session this delegator resolves profiles from.
 *
 * Only `ctx.models` is ever consulted, so the contract is stated structurally
 * instead of as the whole `ExtensionContext`: the MCP server process rebuilds
 * the same facade from published bridge facts and must satisfy it exactly.
 *
 * `roleThinking` is the part OMP's own facade cannot answer. `models.resolve()`
 * deliberately strips a role's `:level` thinking suffix and resolves to the base
 * model, so the level a role is bound to is only observable beside it. It stays
 * optional because a bridge published before this field existed carries no
 * role-bound level, and absence means exactly what it meant then: nothing is
 * bound, so `inherit` keeps the live session level.
 */
export type OmpModelContext = {
  models: {
    current(): OmpModelIdentity | undefined;
    resolve(spec: string): OmpModelIdentity | undefined;
    roleThinking?(role: string): ThinkingLevel | undefined;
  };
};

export const SKILL_ROUTE_BOUNDARIES = ["plan", "authoring", "dispatch", "completion", "settlement", "reset"] as const;
export const MAX_SKILL_ROUTE_RULES = 16;
export const MAX_SKILLS_PER_ROUTE = 8;
export const MAX_PROFILES_PER_ROUTE = 8;
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Bound for configured advisory prose (`worker_profiles.<name>.guidance`,
 * `skill_routing.rules[].trigger`). Single-line by contract so the text can be
 * rendered into tables and prompts without escaping.
 */
export const MAX_GUIDANCE_LENGTH = 500;
export const GUIDANCE_CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type SkillRouteBoundary = (typeof SKILL_ROUTE_BOUNDARIES)[number];

export type SkillRouteSurface = "orch" | "worker";

export type SkillRoute = {
  boundary: SkillRouteBoundary;
  surface: SkillRouteSurface;
  skills: string[];
  /**
   * Optional prose naming when this route applies. Advisory selection criteria
   * for the surface that reads the route; never a gate.
   */
  trigger?: string;
  /**
   * Optional worker-profile scope. A rule carrying it is delivered only when the
   * delivery target's profile is named here; a rule without it reaches every
   * profile. A named profile no `worker_profiles` entry defines simply never
   * matches — rules and profiles may live in different layers, and routes are
   * advisory. A surface with no profile in hand (every orchestrator-surface
   * delivery point) matches only unscoped rules, so a profile-scoped route can
   * never leak to a target whose profile is unknown.
   */
  profiles?: string[];
};

export type DelegatorConfig = {
  version: 1;
  orchestrator: ModelProfile;
  worker_profiles: Record<string, ModelProfile>;
  storage?: { root: string };
  skill_routing?: { rules: SkillRoute[] };
};

export type ConfigSource = {
  scope: "user" | "project" | "run";
  path: string;
  sha256: string;
};

/**
 * What a spawn actually launches with. No concrete model is resolved here any
 * more (friction 221abf10d2280b47): the spawn passes the ROLE ALIAS and the
 * child expands it against its own persisted settings, because a runtime model
 * override is process-local and a caller's override must not decide a child's
 * model. `effective_thinking` is `inherit` when the delegator profile holds no
 * explicit opinion, which means the spawn omits `--thinking` and the role's own
 * `:level` suffix governs in the child.
 */
export type ResolvedLaunchProfile = {
  config_sources: ConfigSource[];
  selected_profile: string;
  selection_source: "explicit";
  requested_role: string;
  effective_thinking: ConfigThinkingLevel;
};

export type RunManifest = {
  version: 1;
  track_id: string;
  run_id: string;
  cwd: string;
  run_path: string;
  created_at: string;
  reset_of?: { track_id: string; run_id: string; path: string };
};

export type ResolvedRun = {
  runPath: string;
  manifest: RunManifest;
  config: DelegatorConfig;
  sources: ConfigSource[];
  storageRoot: string;
};

export type ResetLineage = {
  version: 1;
  reset_of: string;
  source_plan_sha256: string;
  worker_policy: typeof RESET_WORKER_POLICY;
  evidence_policy: typeof RESET_EVIDENCE_POLICY;
  created_at: string;
};

export type TargetOrchestratorRecord = {
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  agent_name: string;
  session_path?: string;
  session_id?: string;
  state: string;
  state_change_seq?: number;
  instruction_path: string;
  prompt_sha256?: string;
  prompt_state: "unprompted" | "prompting" | "prompted";
  config_sources: ConfigSource[];
  requested_role: string;
  // Post-spawn OBSERVATION, never a prediction (plan rev 3 deviation 1). Absent
  // until the child reports its own identity through bootstrap attestation: the
  // delegator no longer computes an expected model, so there is nothing to
  // record before the child answers. Records written by earlier versions carry
  // concrete values and stay valid.
  expected_provider?: string;
  expected_model?: string;
  effective_thinking?: ThinkingLevel;
  resolved_model_is_fallback?: boolean;
  verified_at?: string;
  created_at: string;
  updated_at: string;
};

export type SessionVerification = {
  session_id: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  resolved_model_is_fallback: boolean;
};

export const PUBLIC_WORKER_STATES: Record<WorkerState, true> = {
  planned: true,
  "pane-created": true,
  "agent-ready": true,
  prompted: true,
  working: true,
  idle: true,
  done: true,
  blocked: true,
  closed: true,
  failed: true,
};

export const REGISTRY_STATES: Record<string, true> = {
  planned: true,
  "pane-created": true,
  "agent-ready": true,
  prompting: true,
  prompted: true,
  working: true,
  idle: true,
  done: true,
  blocked: true,
  closing: true,
  closed: true,
  failed: true,
};

export type OrchestratorRecord = {
  session_path?: string;
  session_id?: string;
  workspace_id?: string;
  tab_id?: string;
  pane_id: string;
  requested_role: string;
  // Post-spawn observation; see TargetOrchestratorRecord.
  expected_provider?: string;
  expected_model?: string;
  effective_thinking?: ThinkingLevel;
  config_sources: ConfigSource[];
  observed_at: string;
};

export type RunRecord = {
  run_path: string;
  run_key: string;
  cwd: string;
  owner: typeof REGISTRY_OWNER;
  generation: typeof RUN_GENERATION;
  workspace_label: string;
  workspace_id?: string;
  anchor_tab_id?: string;
  anchor_pane_id?: string;
  workspace_state: WorkspaceState;
  created_workspace: boolean;
  created_at: string;
  updated_at: string;
  orchestrator: OrchestratorRecord;
  reset_lineage?: ResetLineage;
  target_orchestrator?: TargetOrchestratorRecord;
};

export type RegistryRecord = {
  run_path: string;
  worker_id: string;
  worker_key: string;
  generation: typeof RUN_GENERATION;
  workspace_id: string;
  tab_id?: string;
  root_pane_id?: string;
  agent_name: string;
  agent_session_path?: string;
  state: string;
  revision?: number;
  state_change_seq?: number;
  instruction_path?: string;
  prompt_sha256?: string;
  owner: typeof REGISTRY_OWNER;
  created_tab: boolean;
  config_sources: ConfigSource[];
  selected_profile: string;
  selection_source: ResolvedLaunchProfile["selection_source"];
  requested_role: string;
  // Post-spawn observation; see TargetOrchestratorRecord.
  expected_provider?: string;
  expected_model?: string;
  effective_thinking?: ThinkingLevel;
  resolved_model_is_fallback?: boolean;
  verified_session_id?: string;
  verified_at?: string;
  closed_at?: string;
  created_at: string;
  updated_at: string;
};

export type Registry = {
  version: typeof REGISTRY_VERSION;
  run?: RunRecord;
  workers: Record<string, RegistryRecord>;
};

export type WorkerResult = {
  ok: boolean;
  operation: Operation;
  worker_key: string;
  state: WorkerState;
  retryable: boolean;
  registry_path: string;
  worker?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    phase: string;
    ambiguous_effect: boolean;
    recovery: string;
  };
};

export type TrackResult = {
  ok: boolean;
  operation: TrackOperation;
  run_key: string;
  state: string;
  retryable: boolean;
  registry_path: string;
  run?: Record<string, unknown>;
  orchestrator?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    phase: string;
    ambiguous_effect: boolean;
    recovery: string;
  };
};

export type ToolParams = {
  operation?: unknown;
  track_id?: unknown;
  run_id?: unknown;
  worker_id?: unknown;
  timeout_ms?: unknown;
  cwd?: unknown;
  instruction_path?: unknown;
  output_lines?: unknown;
  expected_state_change_seq?: unknown;
  profile?: unknown;
  responsibility_key?: unknown;
};

export type TrackParams = {
  operation?: unknown;
  track_id?: unknown;
  run_id?: unknown;
  timeout_ms?: unknown;
  cwd?: unknown;
  reset_of?: unknown;
};

export class ContractError extends Error {
  code: string;
  phase: string;
  retryable: boolean;
  ambiguousEffect: boolean;
  recovery: string;

  constructor(
    code: string,
    message: string,
    phase: string,
    options: { retryable?: boolean; ambiguousEffect?: boolean; recovery?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.phase = phase;
    this.retryable = options.retryable ?? false;
    this.ambiguousEffect = options.ambiguousEffect ?? false;
    this.recovery = options.recovery ?? "Check the input and current worker coordinates, then call inspect_worker.";
  }
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function compactMessage(value: unknown, fallback: string): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return text.replace(/[\r\n\t]+/g, " ").slice(0, MAX_ERROR_MESSAGE);
}

// Identity coordinates are already bounded upstream (role regex, model registry
// tokens, thinking enum), but the mismatch message is the one place two
// independently-sourced identities meet, so each value is clamped again here
// before it reaches an error string.
const MAX_IDENTITY_VALUE = 64;

export type OrchestratorIdentity = {
  provider: string;
  model: string;
  thinking: string;
};

function boundedIdentityValue(value: string): string {
  const printable = value.replace(/[^\x21-\x7e]+/g, "");
  if (!printable) return "unknown";
  return printable.length > MAX_IDENTITY_VALUE ? `${printable.slice(0, MAX_IDENTITY_VALUE - 1)}~` : printable;
}

function boundedIdentity(identity: OrchestratorIdentity): { model: string; thinking: string } {
  return {
    model: `${boundedIdentityValue(identity.provider)}/${boundedIdentityValue(identity.model)}`,
    thinking: boundedIdentityValue(identity.thinking),
  };
}

/**
 * The single `orchestrator_model_mismatch` constructor. Code, phase, retryable
 * and ambiguous-effect stay exactly as the fail-closed gates always set them;
 * only the bounded message and recovery text are enriched, so both sides of the
 * comparison and the remaining remedies are visible at the callsite. A born ORCH
 * is spawned pre-aligned, so this now fires only when the session dispatching
 * work has drifted off its role — there is no alignment command to run.
 */
export function orchestratorMismatchError(subject: string, role: string, expected: OrchestratorIdentity, live: OrchestratorIdentity): ContractError {
  const want = boundedIdentity(expected);
  const have = boundedIdentity(live);
  const boundedRole = boundedIdentityValue(role);
  return new ContractError(
    "orchestrator_model_mismatch",
    compactMessage(
      `${subject} does not match configured orchestrator role ${boundedRole}: expected ${want.model} thinking=${want.thinking}, live ${have.model} thinking=${have.thinking}.`,
      "The live ORCH model or thinking level does not match its configured OMP role.",
    ),
    "model_verify",
    {
      recovery: compactMessage(
        `Guarded dispatch runs from the run's born ORCH, which is spawned pre-aligned. If you are that ORCH, /switch to ${want.model} with thinking ${want.thinking} — or relaunch with omp --model ${want.model} --thinking ${want.thinking} — before retrying; if you are not, converse with the ORCH pane instead of commanding its run.`,
        "Select the configured orchestrator role and thinking level before mutating Herdr state.",
      ),
    },
  );
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  coordinate: string,
): void {
  const allowedSet: Record<string, true> = {};
  for (const key of allowed) allowedSet[key] = true;
  const unknown = Object.keys(value).find((key) => !allowedSet[key]);
  if (unknown) {
    throw new ContractError(
      "invalid_config",
      `${coordinate}: unknown field ${JSON.stringify(unknown)}.`,
      "config",
      { recovery: "Correct the named configuration file; it is never rewritten or ignored." },
    );
  }
}
