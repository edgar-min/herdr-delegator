// Config responsibilities for the Herdr delegator extension.
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigSource, ConfigThinkingLevel, DelegatorConfig, ModelProfile, OrchestratorRecord, ResetLineage, ResolvedLaunchProfile, ResolvedRun, RunManifest, TargetOrchestratorRecord, ThinkingLevel, ToolParams } from "./contracts";
import { CONFIG_THINKING_LEVELS, COORDINATE_RE, ContractError, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, PROFILE_RE, RESET_EVIDENCE_POLICY, RESET_WORKER_POLICY, ROLE_RE, SHA256_RE, THINKING_LEVELS, WORKER_RE, assertExactKeys, compactMessage, isObject, sha256 } from "./contracts";

type TargetOrchestratorRecordWithBootstrapFacts = TargetOrchestratorRecord & {
  bootstrap_attestation?: string;
  bootstrap_attested_at?: string;
  bootstrap_verified_at?: string;
};

const DEFAULT_CONFIG: DelegatorConfig = {
  version: 1,
  orchestrator: { role: "@plan", thinking: "inherit" },
  worker_profiles: {
    default: { role: "@default", thinking: "inherit" },
    slow: { role: "@slow", thinking: "inherit" },
  },
};

export const PROTOCOL_TEMPLATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../skills/herdr-delegation/templates/protocol.md",
);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.some((level) => level === value);
}

function isConfigThinkingLevel(value: unknown): value is ConfigThinkingLevel {
  return typeof value === "string" && CONFIG_THINKING_LEVELS.some((level) => level === value);
}

function parseProfilePatch(value: unknown, coordinate: string): Partial<ModelProfile> {
  if (!isObject(value)) {
    throw new ContractError("invalid_config", `${coordinate}: expected an object.`, "config");
  }
  assertExactKeys(value, ["role", "thinking"], coordinate);
  if (value.role !== undefined && (typeof value.role !== "string" || !ROLE_RE.test(value.role))) {
    throw new ContractError("invalid_config", `${coordinate}.role: expected an OMP role such as @default.`, "config");
  }
  if (value.thinking !== undefined && !isConfigThinkingLevel(value.thinking)) {
    throw new ContractError("invalid_config", `${coordinate}.thinking: unsupported thinking level.`, "config");
  }
  return {
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    ...(isConfigThinkingLevel(value.thinking) ? { thinking: value.thinking } : {}),
  };
}

type ConfigPatch = {
  orchestrator?: Partial<ModelProfile>;
  worker_profiles?: Record<string, Partial<ModelProfile>>;
  storage?: { root: string };
};

function parseConfigPatch(value: unknown, coordinate: string): ConfigPatch {
  if (!isObject(value)) {
    throw new ContractError("invalid_config", `${coordinate}: expected a JSON object.`, "config");
  }
  assertExactKeys(value, ["version", "orchestrator", "worker_profiles", "storage"], coordinate);
  if (value.version !== 1) {
    throw new ContractError("invalid_config", `${coordinate}.version: expected 1.`, "config");
  }
  const patch: ConfigPatch = {};
  if (value.orchestrator !== undefined) {
    patch.orchestrator = parseProfilePatch(value.orchestrator, `${coordinate}.orchestrator`);
    if (patch.orchestrator.role !== undefined && patch.orchestrator.role !== "@plan") {
      throw new ContractError(
        "invalid_config",
        `${coordinate}.orchestrator.role: the main ORCH role is fixed at @plan.`,
        "config",
      );
    }
  }
  if (value.worker_profiles !== undefined) {
    if (!isObject(value.worker_profiles)) {
      throw new ContractError("invalid_config", `${coordinate}.worker_profiles: expected an object.`, "config");
    }
    patch.worker_profiles = {};
    for (const [name, profile] of Object.entries(value.worker_profiles)) {
      if (!PROFILE_RE.test(name)) {
        throw new ContractError("invalid_config", `${coordinate}.worker_profiles: invalid profile name ${JSON.stringify(name)}.`, "config");
      }
      patch.worker_profiles[name] = parseProfilePatch(profile, `${coordinate}.worker_profiles.${name}`);
    }
  }
  if (value.storage !== undefined) {
    if (!isObject(value.storage)) {
      throw new ContractError("invalid_config", `${coordinate}.storage: expected an object.`, "config");
    }
    assertExactKeys(value.storage, ["root"], `${coordinate}.storage`);
    if (typeof value.storage.root !== "string" || !path.isAbsolute(value.storage.root)) {
      throw new ContractError("invalid_config", `${coordinate}.storage.root: expected an absolute path.`, "config");
    }
    patch.storage = { root: path.normalize(value.storage.root) };
  }
  return patch;
}

async function readConfigLayer(
  scope: ConfigSource["scope"],
  candidatePath: string,
): Promise<{ patch: ConfigPatch; source: ConfigSource } | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(candidatePath);
  } catch (error: unknown) {
    if (isObject(error) && error.code === "ENOENT") return undefined;
    throw new ContractError(
      "invalid_config",
      `${candidatePath}: cannot read configuration.`,
      "config",
      { recovery: "Fix the file permissions or path; the layer is never silently ignored." },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ContractError(
      "invalid_config",
      `${candidatePath}: malformed JSON.`,
      "config",
      { recovery: "Correct the named configuration file; it is never rewritten or quarantined." },
    );
  }
  const canonicalPath = await realpath(candidatePath);
  return {
    patch: parseConfigPatch(parsed, canonicalPath),
    source: { scope, path: canonicalPath, sha256: sha256(raw) },
  };
}

function mergeConfigPatch(config: DelegatorConfig, patch: ConfigPatch): void {
  if (patch.orchestrator) config.orchestrator = { ...config.orchestrator, ...patch.orchestrator };
  for (const [name, profile] of Object.entries(patch.worker_profiles ?? {})) {
    const base = config.worker_profiles[name] ?? config.worker_profiles.default;
    config.worker_profiles[name] = { ...base, ...profile };
  }
  if (patch.storage) config.storage = patch.storage;
}

export async function loadDelegatorConfig(runPath: string | undefined, cwd: string): Promise<{
  config: DelegatorConfig;
  sources: ConfigSource[];
}> {
  const config: DelegatorConfig = structuredClone(DEFAULT_CONFIG);
  const sources: ConfigSource[] = [];
  const userRoot = process.env.PI_CODING_AGENT_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_DIR)
    : path.join(homedir(), ".omp", "agent");
  const baseCandidates: Array<[ConfigSource["scope"], string]> = [
    ["user", path.join(userRoot, "herdr-delegator.json")],
    ["project", path.join(cwd, ".omp", "herdr-delegator.json")],
  ];
  for (const [scope, candidatePath] of baseCandidates) {
    const layer = await readConfigLayer(scope, candidatePath);
    if (!layer) continue;
    mergeConfigPatch(config, layer.patch);
    sources.push(layer.source);
  }
  if (!config.storage) {
    throw new ContractError(
      "storage_root_unconfigured",
      "At least the user or project configuration must set storage.root to an absolute path.",
      "config",
      { recovery: "Configure storage.root before initializing or resolving a run." },
    );
  }
  const baseStorageRoot = config.storage.root;
  if (runPath) {
    const layer = await readConfigLayer("run", path.join(runPath, "herdr-delegator.json"));
    if (layer) {
      if (layer.patch.storage && layer.patch.storage.root !== baseStorageRoot) {
        throw new ContractError(
          "invalid_config",
          "Run configuration may not relocate its own storage root.",
          "config",
        );
      }
      mergeConfigPatch(config, layer.patch);
      sources.push(layer.source);
    }
  }
  return { config, sources };
}

export function modelIdentity(model: ExtensionContext["model"]): { provider: string; model: string } {
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
    throw new ContractError("model_role_unresolved", "The configured OMP role did not resolve to a concrete model.", "model_verify");
  }
  return { provider: model.provider, model: model.id };
}

export async function resolveLaunchProfile(
  params: ToolParams,
  runPath: string,
  cwd: string,
  ctx: ExtensionContext,
  currentThinking: ThinkingLevel,
): Promise<{ launch: ResolvedLaunchProfile; orchestrator: Omit<OrchestratorRecord, "pane_id" | "observed_at"> }> {
  const { config, sources } = await loadDelegatorConfig(runPath, cwd);
  const resolvedOrchestrator = modelIdentity(ctx.models.resolve(config.orchestrator.role));
  const currentOrchestrator = modelIdentity(ctx.models.current());
  const orchestratorThinking = config.orchestrator.thinking === "inherit"
    ? currentThinking
    : config.orchestrator.thinking;
  if (
    resolvedOrchestrator.provider !== currentOrchestrator.provider ||
    resolvedOrchestrator.model !== currentOrchestrator.model ||
    orchestratorThinking !== currentThinking
  ) {
    throw new ContractError(
      "orchestrator_model_mismatch",
      "The live ORCH model or thinking level does not match its configured OMP role.",
      "model_verify",
      { recovery: "Select the configured ORCH role and thinking level before creating or reconciling workers." },
    );
  }
  if (typeof params.profile !== "string" || !PROFILE_RE.test(params.profile)) {
    throw new ContractError(
      "invalid_profile",
      "ensure_worker.profile is required and must name a configured worker profile.",
      "validate",
    );
  }
  const selectedProfile = params.profile;
  const profile = config.worker_profiles[selectedProfile];
  if (!profile) {
    throw new ContractError(
      "invalid_profile",
      `Selected worker profile ${JSON.stringify(selectedProfile)} is not configured.`,
      "config",
    );
  }
  const workerModel = modelIdentity(ctx.models.resolve(profile.role));
  const launch: ResolvedLaunchProfile = {
    config_sources: sources,
    selected_profile: selectedProfile,
    selection_source: "explicit",
    requested_role: profile.role,
    expected_provider: workerModel.provider,
    expected_model: workerModel.model,
    effective_thinking: profile.thinking === "inherit" ? currentThinking : profile.thinking,
  };
  return {
    launch,
    orchestrator: {
      requested_role: config.orchestrator.role,
      expected_provider: resolvedOrchestrator.provider,
      expected_model: resolvedOrchestrator.model,
      effective_thinking: orchestratorThinking,
      config_sources: sources,
    },
  };
}

export async function resolveOrchestratorProfile(
  runPath: string,
  cwd: string,
  ctx: ExtensionContext,
  currentThinking: ThinkingLevel,
): Promise<{
  launch: Omit<TargetOrchestratorRecordWithBootstrapFacts,
    "workspace_id" | "tab_id" | "pane_id" | "agent_name" | "session_path" | "session_id" |
    "state" | "state_change_seq" | "instruction_path" | "prompt_sha256" | "prompt_state" |
    "resolved_model_is_fallback" | "verified_at" | "created_at" | "updated_at"
  >;
  caller: Omit<OrchestratorRecord, "pane_id" | "observed_at">;
}> {
  const { config, sources } = await loadDelegatorConfig(runPath, cwd);
  const resolved = modelIdentity(ctx.models.resolve(config.orchestrator.role));
  const current = modelIdentity(ctx.models.current());
  const effectiveThinking = config.orchestrator.thinking === "inherit"
    ? currentThinking
    : config.orchestrator.thinking;
  if (
    resolved.provider !== current.provider ||
    resolved.model !== current.model ||
    effectiveThinking !== currentThinking
  ) {
    throw new ContractError(
      "orchestrator_model_mismatch",
      "The live caller ORCH model or thinking level does not match the configured orchestrator OMP role.",
      "model_verify",
      { recovery: "Select the configured orchestrator role and thinking level before mutating Herdr state." },
    );
  }
  const profile = {
    config_sources: sources,
    requested_role: config.orchestrator.role,
    expected_provider: resolved.provider,
    expected_model: resolved.model,
    effective_thinking: effectiveThinking,
  };
  return { launch: profile, caller: profile };
}

export function isConfigSource(value: unknown): value is ConfigSource {
  return (
    isObject(value) &&
    (value.scope === "user" || value.scope === "project" || value.scope === "run") &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasValidBootstrapFacts(record: Record<string, unknown>): boolean {
  const facts = [
    record.bootstrap_attestation,
    record.bootstrap_attested_at,
    record.bootstrap_verified_at,
  ];
  if (facts.every((value) => value === undefined)) return true;
  return (
    facts.every((value) => typeof value === "string") &&
    /^\d{13}\.[0-9a-f]{16}$/.test(String(record.bootstrap_attestation)) &&
    !Number.isNaN(Date.parse(String(record.bootstrap_attested_at))) &&
    !Number.isNaN(Date.parse(String(record.bootstrap_verified_at)))
  );
}

export function isResetLineage(value: unknown): value is ResetLineage {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "version",
      "reset_of",
      "source_plan_sha256",
      "worker_policy",
      "evidence_policy",
      "created_at",
    ]) &&
    value.version === 1 &&
    typeof value.reset_of === "string" &&
    path.isAbsolute(value.reset_of) &&
    typeof value.source_plan_sha256 === "string" &&
    SHA256_RE.test(value.source_plan_sha256) &&
    value.worker_policy === RESET_WORKER_POLICY &&
    value.evidence_policy === RESET_EVIDENCE_POLICY &&
    typeof value.created_at === "string" &&
    Number.isFinite(Date.parse(value.created_at))
  );
}

export function isTargetOrchestratorRecord(value: unknown): value is TargetOrchestratorRecordWithBootstrapFacts {
  if (!isObject(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "workspace_id",
      "tab_id",
      "pane_id",
      "agent_name",
      "session_path",
      "session_id",
      "state",
      "state_change_seq",
      "instruction_path",
      "prompt_sha256",
      "prompt_state",
      "config_sources",
      "requested_role",
      "expected_provider",
      "expected_model",
      "effective_thinking",
      "resolved_model_is_fallback",
      "bootstrap_attestation",
      "bootstrap_attested_at",
      "bootstrap_verified_at",
      "verified_at",
      "created_at",
      "updated_at",
    ])
  ) {
    return false;
  }
  const optionalStrings = [value.session_path, value.session_id, value.prompt_sha256, value.verified_at];
  return (
    typeof value.workspace_id === "string" &&
    typeof value.tab_id === "string" &&
    typeof value.pane_id === "string" &&
    typeof value.agent_name === "string" &&
    /^herdr-orch-[a-f0-9]{12}$/.test(value.agent_name) &&
    typeof value.state === "string" &&
    value.state.length > 0 &&
    (value.state_change_seq === undefined || Number.isSafeInteger(value.state_change_seq)) &&
    typeof value.instruction_path === "string" &&
    path.isAbsolute(value.instruction_path) &&
    (value.prompt_state === "unprompted" || value.prompt_state === "prompting" || value.prompt_state === "prompted") &&
    Array.isArray(value.config_sources) &&
    value.config_sources.every(isConfigSource) &&
    typeof value.requested_role === "string" &&
    ROLE_RE.test(value.requested_role) &&
    typeof value.expected_provider === "string" &&
    typeof value.expected_model === "string" &&
    isThinkingLevel(value.effective_thinking) &&
    (value.resolved_model_is_fallback === undefined || typeof value.resolved_model_is_fallback === "boolean") &&
    hasValidBootstrapFacts(value) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    optionalStrings.every((item) => item === undefined || typeof item === "string") &&
    (value.prompt_sha256 === undefined ||
      (typeof value.prompt_sha256 === "string" && SHA256_RE.test(value.prompt_sha256)))
  );
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

export function canonicalCoordinate(value: unknown, field: "track_id" | "run_id"): string {
  if (typeof value !== "string" || !COORDINATE_RE.test(value)) {
    throw new ContractError(
      `invalid_${field}`,
      `${field} must match lowercase [a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?.`,
      "validate",
    );
  }
  return value;
}

function isRunManifest(value: unknown): value is RunManifest {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["version", "track_id", "run_id", "cwd", "run_path", "created_at", "reset_of"].includes(key))) {
    return false;
  }
  if (
    value.version !== 1 ||
    typeof value.track_id !== "string" ||
    !COORDINATE_RE.test(value.track_id) ||
    typeof value.run_id !== "string" ||
    !COORDINATE_RE.test(value.run_id) ||
    typeof value.cwd !== "string" ||
    !path.isAbsolute(value.cwd) ||
    typeof value.run_path !== "string" ||
    !path.isAbsolute(value.run_path) ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at))
  ) {
    return false;
  }
  if (value.reset_of === undefined) return true;
  if (!isObject(value.reset_of)) return false;
  return (
    Object.keys(value.reset_of).length === 3 &&
    typeof value.reset_of.track_id === "string" &&
    COORDINATE_RE.test(value.reset_of.track_id) &&
    typeof value.reset_of.run_id === "string" &&
    COORDINATE_RE.test(value.reset_of.run_id) &&
    typeof value.reset_of.path === "string" &&
    path.isAbsolute(value.reset_of.path)
  );
}

export async function storageRootFromConfig(config: DelegatorConfig, create: boolean): Promise<string> {
  const configured = config.storage?.root;
  if (!configured) {
    throw new ContractError("storage_root_unconfigured", "storage.root is not configured.", "config");
  }
  if (create) {
    try {
      await mkdir(configured, { recursive: true, mode: 0o700 });
    } catch (error: unknown) {
      throw new ContractError(
        "storage_root_unavailable",
        compactMessage(isObject(error) ? error.message : undefined, "Unable to create the configured storage root."),
        "storage",
      );
    }
  }
  try {
    const canonical = await realpath(configured);
    if (!(await isDirectory(canonical))) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new ContractError(
      "storage_root_unavailable",
      "The configured storage root is not an accessible directory.",
      "storage",
    );
  }
}

export async function readRunManifest(runPath: string): Promise<RunManifest> {
  const manifestPath = path.join(runPath, "run.json");
  let parsed: unknown;
  try {
    if ((await realpath(manifestPath)) !== manifestPath) throw new Error("not canonical");
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new ContractError("invalid_run_manifest", "run.json is missing, malformed, or not canonical.", "validate");
  }
  if (!isRunManifest(parsed)) {
    throw new ContractError("invalid_run_manifest", "run.json does not match schema version 1.", "validate");
  }
  return parsed;
}

export async function resolveRunCoordinate(
  trackIdInput: unknown,
  runIdInput: unknown,
  cwdInput?: unknown,
): Promise<ResolvedRun> {
  const trackId = canonicalCoordinate(trackIdInput, "track_id");
  const runId = canonicalCoordinate(runIdInput, "run_id");
  const bootstrapCwd = cwdInput === undefined ? await realpath(process.cwd()) : await canonicalCwd(cwdInput);
  const base = await loadDelegatorConfig(undefined, bootstrapCwd);
  const storageRoot = await storageRootFromConfig(base.config, false);
  const expectedPath = path.join(storageRoot, trackId, runId);
  let runPath: string;
  try {
    runPath = await realpath(expectedPath);
  } catch {
    throw new ContractError("run_not_initialized", "The configured run coordinate has not been initialized.", "validate");
  }
  if (runPath !== expectedPath || !(await isDirectory(runPath))) {
    throw new ContractError("run_path_mismatch", "The run coordinate does not resolve to its exact canonical storage path.", "validate");
  }
  const manifest = await readRunManifest(runPath);
  let canonicalManifestCwd: string;
  try {
    canonicalManifestCwd = await realpath(manifest.cwd);
  } catch {
    throw new ContractError("invalid_run_manifest", "run.json cwd is no longer canonical and accessible.", "validate");
  }
  if (
    manifest.track_id !== trackId ||
    manifest.run_id !== runId ||
    manifest.run_path !== runPath ||
    canonicalManifestCwd !== manifest.cwd ||
    (cwdInput !== undefined && bootstrapCwd !== manifest.cwd)
  ) {
    throw new ContractError("run_manifest_mismatch", "run.json identity, path, or cwd conflicts with the requested coordinate.", "validate");
  }
  const a2aPath = path.join(runPath, "a2a");
  const protocolPath = path.join(runPath, "protocol.md");
  let canonicalA2a: string;
  let canonicalProtocol: string;
  try {
    [canonicalA2a, canonicalProtocol] = await Promise.all([realpath(a2aPath), realpath(protocolPath)]);
  } catch {
    throw new ContractError("invalid_run_layout", "The initialized run must contain protocol.md and a2a/.", "validate");
  }
  if (
    canonicalA2a !== a2aPath ||
    canonicalProtocol !== protocolPath ||
    !(await isDirectory(a2aPath)) ||
    !(await isFile(protocolPath))
  ) {
    throw new ContractError("invalid_run_layout", "The initialized run layout is not canonical.", "validate");
  }
  const loaded = await loadDelegatorConfig(runPath, manifest.cwd);
  const verifiedRoot = await storageRootFromConfig(loaded.config, false);
  if (verifiedRoot !== storageRoot) {
    throw new ContractError("storage_root_changed", "Layered configuration no longer resolves this run's storage root.", "config");
  }
  return { runPath, manifest, config: loaded.config, sources: loaded.sources, storageRoot };
}

export async function validateOrchestratorRun(resolved: ResolvedRun): Promise<ResetLineage | undefined> {
  const { runPath, manifest, storageRoot } = resolved;
  const planPath = path.join(runPath, "plan.md");
  const instructionPath = path.join(runPath, "orchestrator-instructions.md");
  try {
    if (
      (await realpath(planPath)) !== planPath ||
      (await realpath(instructionPath)) !== instructionPath ||
      !(await isFile(planPath)) ||
      !(await isFile(instructionPath))
    ) {
      throw new Error("not canonical");
    }
  } catch {
    throw new ContractError(
      "invalid_orchestrator_layout",
      "The run must contain canonical plan.md and orchestrator-instructions.md before start or inspection.",
      "validate",
    );
  }
  if (!manifest.reset_of) return undefined;
  const resetPath = path.join(runPath, "reset.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resetPath, "utf8"));
  } catch {
    throw new ContractError("invalid_reset_contract", "reset.json must contain valid JSON.", "validate");
  }
  if (!isObject(parsed)) {
    throw new ContractError("invalid_reset_contract", "reset.json must be an object.", "validate");
  }
  try {
    assertExactKeys(
      parsed,
      ["version", "reset_of", "source_plan_sha256", "worker_policy", "evidence_policy", "created_at"],
      resetPath,
    );
  } catch {
    throw new ContractError("invalid_reset_contract", "reset.json has fields outside the published contract.", "validate");
  }
  if (!isResetLineage(parsed)) {
    throw new ContractError("invalid_reset_contract", "reset.json does not match reset schema version 1.", "validate");
  }
  const sourcePath = path.join(storageRoot, manifest.reset_of.track_id, manifest.reset_of.run_id);
  if (sourcePath !== manifest.reset_of.path || parsed.reset_of !== sourcePath || sourcePath === runPath) {
    throw new ContractError("invalid_reset_source", "Reset lineage does not match its deterministic source coordinate.", "validate");
  }
  const sourceManifest = await readRunManifest(sourcePath);
  if (
    sourceManifest.track_id !== manifest.reset_of.track_id ||
    sourceManifest.run_id !== manifest.reset_of.run_id ||
    sourceManifest.run_path !== sourcePath
  ) {
    throw new ContractError("invalid_reset_source", "Reset source manifest does not match its canonical coordinate.", "validate");
  }
  const sourcePlan = path.join(sourcePath, "plan.md");
  if (!(await isFile(sourcePlan))) {
    throw new ContractError("invalid_reset_source", "The reset source must contain plan.md.", "validate");
  }
  if (sha256(await readFile(sourcePlan)) !== parsed.source_plan_sha256) {
    throw new ContractError(
      "reset_source_changed",
      "The source plan hash no longer matches source_plan_sha256.",
      "validate",
      { recovery: "Initialize a new sibling reset after the source plan is settled." },
    );
  }
  return parsed;
}

export async function canonicalOrchestratorInstruction(runPath: string): Promise<string> {
  const expected = path.join(runPath, "orchestrator-instructions.md");
  try {
    if ((await realpath(expected)) !== expected || !(await isFile(expected))) throw new Error("not canonical");
  } catch {
    throw new ContractError(
      "invalid_instruction_path",
      "orchestrator-instructions.md is missing or not canonical inside the resolved run.",
      "validate",
    );
  }
  return expected;
}

export function canonicalWorkerId(workerId: unknown): string {
  if (typeof workerId !== "string" || !WORKER_RE.test(workerId)) {
    throw new ContractError("invalid_worker_id", "worker_id must use the w1 or w2 form.", "validate");
  }
  return workerId.toLowerCase();
}

export function normalizeTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || Number(value) < MIN_TIMEOUT_MS || Number(value) > MAX_TIMEOUT_MS) {
    throw new ContractError(
      "invalid_timeout",
      `timeout_ms must be an integer from ${MIN_TIMEOUT_MS} through ${MAX_TIMEOUT_MS}.`,
      "validate",
    );
  }
  return Number(value);
}

export async function canonicalCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new ContractError("invalid_cwd", "cwd must be an existing absolute path.", "validate");
  }
  try {
    const canonical = await realpath(cwd);
    if (!(await isDirectory(canonical))) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new ContractError("invalid_cwd", "cwd cannot be resolved to a real directory path.", "validate");
  }
}

export async function canonicalInstruction(
  runPath: string,
  workerId: string,
  instructionPath: unknown,
): Promise<string> {
  if (typeof instructionPath !== "string" || !path.isAbsolute(instructionPath)) {
    throw new ContractError(
      "invalid_instruction_path",
      "instruction_path must be an absolute path.",
      "validate",
    );
  }
  const expected = path.join(runPath, "a2a", `${workerId}-instructions.md`);
  let canonical: string;
  try {
    canonical = await realpath(instructionPath);
  } catch {
    throw new ContractError(
      "invalid_instruction_path",
      "instruction_path cannot be resolved to a real path.",
      "validate",
    );
  }
  if (canonical !== expected || !(await isFile(canonical))) {
    throw new ContractError(
      "instruction_path_mismatch",
      `instruction_path must be exactly ${expected}.`,
      "validate",
    );
  }
  return canonical;
}

type RunIndexRow = {
  track_id: string;
  run_id: string;
  run_path: string;
  cwd: string;
  state: "initialized";
  created_at: string;
  updated_at: string;
};

export async function writeAtomic(target: string, value: string | Buffer, mode = 0o600): Promise<void> {
  const tempPath = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tempPath, value, { mode, flag: "wx" });
    await rename(tempPath, target);
  } catch (error: unknown) {
    try {
      await unlink(tempPath);
    } catch {}
    throw new ContractError(
      "storage_write_failed",
      compactMessage(isObject(error) ? error.message : undefined, `Failed to atomically write ${path.basename(target)}.`),
      "storage",
      { retryable: true },
    );
  }
}

export async function copyAtomic(source: string, target: string): Promise<void> {
  const tempPath = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await copyFile(source, tempPath, fsConstants.COPYFILE_EXCL);
    await rename(tempPath, target);
  } catch (error: unknown) {
    try {
      await unlink(tempPath);
    } catch {}
    throw new ContractError(
      "storage_write_failed",
      compactMessage(isObject(error) ? error.message : undefined, `Failed to atomically copy ${path.basename(target)}.`),
      "storage",
      { retryable: true },
    );
  }
}

export async function readRunIndex(indexPath: string): Promise<{ version: 1; runs: Record<string, RunIndexRow> }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(indexPath, "utf8"));
  } catch (error: unknown) {
    if (isObject(error) && error.code === "ENOENT") return { version: 1, runs: {} };
    throw new ContractError("invalid_run_index", "The storage-root index.json is malformed.", "storage");
  }
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.runs)) {
    throw new ContractError("invalid_run_index", "The storage-root index.json has an unsupported structure.", "storage");
  }
  for (const [key, row] of Object.entries(parsed.runs)) {
    if (
      !isObject(row) ||
      key !== `${row.track_id}/${row.run_id}` ||
      typeof row.track_id !== "string" ||
      !COORDINATE_RE.test(row.track_id) ||
      typeof row.run_id !== "string" ||
      !COORDINATE_RE.test(row.run_id) ||
      typeof row.run_path !== "string" ||
      !path.isAbsolute(row.run_path) ||
      typeof row.cwd !== "string" ||
      !path.isAbsolute(row.cwd) ||
      row.state !== "initialized" ||
      typeof row.created_at !== "string" ||
      typeof row.updated_at !== "string"
    ) {
      throw new ContractError("invalid_run_index", "The storage-root index.json contains an invalid run row.", "storage");
    }
  }
  return parsed as { version: 1; runs: Record<string, RunIndexRow> };
}
