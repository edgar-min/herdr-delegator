// Runtime responsibilities for the Herdr delegator MCP migration.
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, readFile, realpath, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  BOOTSTRAP_METADATA_TTL_MS,
  BOOTSTRAP_TOKEN_PREFIX,
  BOOTSTRAP_TOKENS,
  type BootstrapSessionVerification,
} from "./bridge";
export type { BootstrapSessionVerification } from "./bridge";
import type { FocusRestoration, Operation, OrchestratorRecord, Registry, RegistryRecord, ResolvedLaunchProfile, RunRecord, SessionVerification, ThinkingLevel, WorkerState } from "./contracts";
import { ContractError, FOCUS_TIMEOUT_MS, LOCK_STALE_MS, LOCK_WAIT_MAX_MS, MAX_SESSION_BYTES, OPERATIONS, PROFILE_RE, PUBLIC_WORKER_STATES, REGISTRY_OWNER, REGISTRY_STATES, REGISTRY_VERSION, ROLE_RE, RUN_GENERATION, SHA256_RE, WORKER_RE, compactMessage, isObject, nowIso, sha256, sleep } from "./contracts";
import { isConfigSource, isFile, isResetLineage, isTargetOrchestratorRecord, isThinkingLevel } from "./config";

type BootstrapExpectedProfile = Pick<
  RegistryRecord,
  "expected_provider" | "expected_model" | "effective_thinking"
>;

type BootstrapOwnership = {
  workspaceId: string;
  tabId: string;
  paneId: string;
};

function isBoundedAttestationToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 80 &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)
  );
}

export function deepValues(value: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) deepValues(item, key, out);
    return out;
  }
  if (!isObject(value)) return out;
  if (Object.prototype.hasOwnProperty.call(value, key)) out.push(value[key]);
  for (const child of Object.values(value)) deepValues(child, key, out);
  return out;
}

export function firstString(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = deepValues(value, key).find((item) => typeof item === "string" && item.length > 0);
    if (typeof found === "string") return found;
  }
  return undefined;
}

export function firstNumber(value: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    const found = deepValues(value, key).find((item) => Number.isSafeInteger(item));
    if (typeof found === "number") return found;
  }
  return undefined;
}

export function collectMatchingObjects(
  value: unknown,
  predicate: (candidate: Record<string, unknown>) => boolean,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectMatchingObjects(item, predicate, out);
    return out;
  }
  if (!isObject(value)) return out;
  if (predicate(value)) out.push(value);
  for (const child of Object.values(value)) collectMatchingObjects(child, predicate, out);
  return out;
}

export function uniqueBy(
  items: Record<string, unknown>[],
  keys: string[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const item of items) {
    const id = keys.map((key) => String(item[key] ?? "")).join("\0");
    if (!id.replace(/\0/g, "") || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
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

function isRegistry(value: unknown): value is Registry {
  if (!isObject(value) || value.version !== REGISTRY_VERSION || !isObject(value.workers)) return false;
  if (value.run !== undefined) {
    if (!isObject(value.run)) return false;
    const run = value.run;
    if (!isObject(run.orchestrator)) return false;
    const orchestrator = run.orchestrator;
    const optionalRunStrings = [
      run.workspace_id,
      run.anchor_tab_id,
      run.anchor_pane_id,
      orchestrator.session_path,
      orchestrator.session_id,
      orchestrator.workspace_id,
      orchestrator.tab_id,
    ];
    if (
      typeof run.run_path !== "string" ||
      !path.isAbsolute(run.run_path) ||
      typeof run.cwd !== "string" ||
      !path.isAbsolute(run.cwd) ||
      typeof run.run_key !== "string" ||
      run.owner !== REGISTRY_OWNER ||
      run.generation !== RUN_GENERATION ||
      typeof run.workspace_label !== "string" ||
      (run.workspace_state !== "workspace-creating" && run.workspace_state !== "ready") ||
      typeof run.created_workspace !== "boolean" ||
      typeof run.created_at !== "string" ||
      typeof run.updated_at !== "string" ||
      typeof orchestrator.pane_id !== "string" ||
      typeof orchestrator.requested_role !== "string" ||
      !ROLE_RE.test(orchestrator.requested_role) ||
      typeof orchestrator.expected_provider !== "string" ||
      typeof orchestrator.expected_model !== "string" ||
      !isThinkingLevel(orchestrator.effective_thinking) ||
      !Array.isArray(orchestrator.config_sources) ||
      !orchestrator.config_sources.every(isConfigSource) ||
      typeof orchestrator.observed_at !== "string" ||
      !optionalRunStrings.every((item) => item === undefined || typeof item === "string")
    ) {
      return false;
    }
    if (
      (run.reset_lineage !== undefined && !isResetLineage(run.reset_lineage)) ||
      (run.target_orchestrator !== undefined &&
        (!isTargetOrchestratorRecord(run.target_orchestrator) ||
          !hasValidBootstrapFacts(run.target_orchestrator)))
    ) {
      return false;
    }
  }
  return Object.entries(value.workers).every(([workerKey, record]) => {
    if (!isObject(record)) return false;
    const optionalStrings = [
      record.tab_id,
      record.root_pane_id,
      record.agent_session_path,
      record.instruction_path,
      record.prompt_sha256,
      record.verified_session_id,
      record.verified_at,
      record.closed_at,
      record.bootstrap_attestation,
      record.bootstrap_attested_at,
      record.bootstrap_verified_at,
      record.last_output_sha256,
      record.last_output_at,
      record.last_activity_at,
    ];
    const optionalNumbers = [
      record.revision,
      record.state_change_seq,
      record.resolving_state_change_seq,
      record.last_activity_revision,
    ];
    return (
      record.worker_key === workerKey &&
      typeof record.run_path === "string" &&
      path.isAbsolute(record.run_path) &&
      typeof record.worker_id === "string" &&
      WORKER_RE.test(record.worker_id) &&
      record.generation === RUN_GENERATION &&
      typeof record.workspace_id === "string" &&
      typeof record.agent_name === "string" &&
      /^[a-z][a-z0-9_-]{0,31}$/.test(record.agent_name) &&
      typeof record.state === "string" &&
      !!REGISTRY_STATES[record.state] &&
      record.owner === REGISTRY_OWNER &&
      typeof record.created_tab === "boolean" &&
      Array.isArray(record.config_sources) &&
      record.config_sources.every(isConfigSource) &&
      typeof record.selected_profile === "string" &&
      PROFILE_RE.test(record.selected_profile) &&
      record.selection_source === "explicit" &&
      typeof record.requested_role === "string" &&
      ROLE_RE.test(record.requested_role) &&
      typeof record.expected_provider === "string" &&
      typeof record.expected_model === "string" &&
      isThinkingLevel(record.effective_thinking) &&
      (record.resolved_model_is_fallback === undefined || typeof record.resolved_model_is_fallback === "boolean") &&
      typeof record.created_at === "string" &&
      typeof record.updated_at === "string" &&
      optionalStrings.every((item) => item === undefined || typeof item === "string") &&
      optionalNumbers.every((item) => item === undefined || Number.isSafeInteger(item)) &&
      (record.last_output_sha256 === undefined || (typeof record.last_output_sha256 === "string" && SHA256_RE.test(record.last_output_sha256))) &&
      (record.last_output_at === undefined || (typeof record.last_output_at === "string" && record.last_output_at.length <= 64)) &&
      (record.last_activity_at === undefined || (typeof record.last_activity_at === "string" && record.last_activity_at.length <= 64)) &&
      (record.last_activity_revision === undefined || (typeof record.last_activity_revision === "number" && Number.isSafeInteger(record.last_activity_revision) && record.last_activity_revision >= 0)) &&
      hasValidBootstrapFacts(record)
    );
  });
}

export function isOperation(value: unknown): value is Operation {
  return typeof value === "string" && OPERATIONS.some((operation) => operation === value);
}

export function normalizeState(value: unknown, fallback: WorkerState = "agent-ready"): WorkerState {
  const raw = firstString(value, ["agent_status", "state", "status"]);
  if (raw === "working" || raw === "idle" || raw === "done" || raw === "blocked") return raw;
  return fallback;
}

function isPublicWorkerState(state: string): state is WorkerState {
  return Object.prototype.hasOwnProperty.call(PUBLIC_WORKER_STATES, state);
}

export function publicState(state: string): WorkerState {
  if (state === "prompting") return "prompted";
  return isPublicWorkerState(state) ? state : "failed";
}

export function assertRecordIdentity(
  record: RegistryRecord,
  runPath: string,
  workerId: string,
  workerKey: string,
): void {
  const expectedAgentName = `herdr-${workerId}-${workerKey.slice(0, 12)}`;
  if (
    record.run_path !== runPath ||
    record.worker_id !== workerId ||
    record.worker_key !== workerKey ||
    record.agent_name !== expectedAgentName
  ) {
    throw new ContractError(
      "identity_conflict",
      "The registry record does not match the requested canonical worker identity.",
      "registry",
      { recovery: "Do not overwrite the registry; inspect the conflicting identity coordinates." },
    );
  }
}

export function publicWorker(record: RegistryRecord): Record<string, unknown> {
  const bootstrapRecord = record as RegistryRecord & {
    bootstrap_attestation?: string;
    bootstrap_attested_at?: string;
    bootstrap_verified_at?: string;
  };
  return {
    run_path: record.run_path,
    worker_id: record.worker_id,
    generation: record.generation,
    workspace_id: record.workspace_id,
    tab_id: record.tab_id,
    root_pane_id: record.root_pane_id,
    agent_name: record.agent_name,
    agent_session_path: record.agent_session_path,
    revision: record.revision,
    state_change_seq: record.state_change_seq,
    instruction_path: record.instruction_path,
    prompt_sha256: record.prompt_sha256,
    config_sources: record.config_sources,
    selected_profile: record.selected_profile,
    selection_source: record.selection_source,
    requested_role: record.requested_role,
    expected_provider: record.expected_provider,
    expected_model: record.expected_model,
    effective_thinking: record.effective_thinking,
    resolved_model_is_fallback: record.resolved_model_is_fallback,
    verified_session_id: record.verified_session_id,
    verified_at: record.verified_at,
    verification_status:
      record.verified_at && record.resolved_model_is_fallback !== undefined
        ? "persisted-verified"
        : bootstrapRecord.bootstrap_verified_at
          ? "bootstrap-verified"
          : "unverified",
    bootstrap_attested_at: bootstrapRecord.bootstrap_attested_at,
    bootstrap_verified_at: bootstrapRecord.bootstrap_verified_at,
    owner: record.owner,
    created_tab: record.created_tab,
    closed_at: record.closed_at,
  };
}

async function findHerdrBinary(): Promise<string> {
  const bunWhich = Bun.which("herdr");
  if (bunWhich) return bunWhich;
  const entries = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, process.platform === "win32" ? "herdr.exe" : "herdr");
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  throw new ContractError(
    "herdr_not_found",
    "The Herdr binary was not found in PATH.",
    "environment",
    { recovery: "Check the Herdr installation and PATH in the user environment." },
  );
}

export async function requireHerdrEnvironment(): Promise<{ binary: string; paneId: string }> {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    throw new ContractError(
      "not_in_herdr",
      "The current OMP session is not running inside a Herdr-managed pane.",
      "environment",
      { recovery: "Start the controlling OMP session in a Herdr-managed pane, then retry." },
    );
  }
  return { binary: await findHerdrBinary(), paneId: process.env.HERDR_PANE_ID };
}

export type CommandResult =
  | { ok: true; data: unknown; stdout: string }
  | { ok: false; code: string; message: string; timedOut: boolean; aborted: boolean };

type SpawnedHerdrProcess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string | number): void;
};

type FocusSnapshot = {
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
};

export type OwnedFocus = {
  workspace_id?: string;
  tab_ids: Set<string>;
  pane_ids: Set<string>;
};

export async function runHerdr(
  binary: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  expectJson = true,
): Promise<CommandResult> {
  let proc: SpawnedHerdrProcess;
  try {
    proc = Bun.spawn([binary, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    }) as SpawnedHerdrProcess;
  } catch (error: unknown) {
    return {
      ok: false,
      code: "herdr_spawn_failed",
      message: compactMessage(isObject(error) ? error.message : undefined, "Failed to start the Herdr process."),
      timedOut: false,
      aborted: false,
    };
  }

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timedOut = false;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try {
      proc.kill("SIGKILL");
    } catch {}
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {}
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  if (timedOut || aborted) {
    return {
      ok: false,
      code: aborted ? "operation_aborted" : "herdr_timeout",
      message: aborted ? "The tool call was cancelled." : "The Herdr call did not finish before the timeout.",
      timedOut,
      aborted,
    };
  }

  let parsed: unknown;
  if (expectJson && stdout.trim()) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return {
        ok: false,
        code: "invalid_herdr_response",
        message: "Herdr returned an unparseable response.",
        timedOut: false,
        aborted: false,
      };
    }
  }

  if (exitCode === 0) return { ok: true, data: expectJson ? parsed : stdout, stdout };

  let errorPayload: unknown;
  try {
    errorPayload = JSON.parse(stderr);
  } catch {
    errorPayload = undefined;
  }
  const code = firstString(errorPayload, ["code"]) ?? (exitCode === 2 ? "herdr_cli_usage" : "herdr_error");
  const message = compactMessage(
    firstString(errorPayload, ["message"]),
    exitCode === 2 ? "The Herdr CLI argument contract is incompatible." : "The Herdr request failed.",
  );
  return { ok: false, code, message, timedOut: false, aborted: false };
}

export function commandError(
  result: Exclude<CommandResult, { ok: true }>,
  phase: string,
  recovery: string,
  ambiguousEffect = false,
): ContractError {
  const retryable =
    result.timedOut ||
    /timeout|stalled|socket|server|unavailable|connection|not_found|not found/i.test(`${result.code} ${result.message}`);
  return new ContractError(result.code, result.message, phase, {
    retryable,
    ambiguousEffect,
    recovery,
  });
}

export function registryPaths(runPath: string): { registryPath: string; lockPath: string } {
  const a2a = path.join(runPath, "a2a");
  return {
    registryPath: path.join(a2a, "herdr-workers.json"),
    lockPath: path.join(a2a, ".herdr-workers.lock"),
  };
}

export async function readRegistry(registryPath: string): Promise<Registry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error: unknown) {
    if (isObject(error) && error.code === "ENOENT") {
      return { version: REGISTRY_VERSION, workers: {} };
    }
    throw new ContractError(
      "invalid_registry",
      "The worker registry is corrupt.",
      "registry",
      { recovery: "Do not overwrite the registry; inspect and repair it first." },
    );
  }
  if (isObject(parsed) && (parsed.version === 1 || parsed.version === 2)) {
    throw new ContractError(
      "registry_version_unsupported",
      `Registry version ${parsed.version} is unsupported and cannot be reinterpreted as model-verified registry v3.`,
      "registry",
      { recovery: "Preserve the legacy file for inspection, then start a new canonical run or perform an explicitly approved migration." },
    );
  }
  if (!isRegistry(parsed)) {
    throw new ContractError(
      "invalid_registry",
      "The worker registry is corrupt or uses an unsupported format.",
      "registry",
      { recovery: "Do not overwrite the registry; inspect and repair it first." },
    );
  }
  return parsed;
}

export async function writeRegistryAtomic(registryPath: string, registry: Registry): Promise<void> {
  const tempPath = `${registryPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const payload = `${JSON.stringify(registry, null, 2)}\n`;
  try {
    await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tempPath, registryPath);
  } catch (error: unknown) {
    try {
      await unlink(tempPath);
    } catch {}
    throw new ContractError(
      "registry_write_failed",
      compactMessage(isObject(error) ? error.message : undefined, "Failed to replace the worker registry atomically."),
      "registry",
      { retryable: true, recovery: "Check registry and a2a directory permissions, then retry." },
    );
  }
}

export async function acquireLock(lockPath: string, timeoutMs: number): Promise<string> {
  const owner = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const deadline = Date.now() + Math.min(timeoutMs, LOCK_WAIT_MAX_MS);
  let delay = 40;
  while (Date.now() <= deadline) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ owner, createdAt: nowIso() }));
      await handle.sync();
      await handle.close();
      return owner;
    } catch (error: unknown) {
      if (!isObject(error) || error.code !== "EEXIST") {
        throw new ContractError(
          "lock_acquire_failed",
          compactMessage(isObject(error) ? error.message : undefined, "Failed to acquire the worker registry lock."),
          "lock",
          { retryable: true },
        );
      }
    }

    let stale = false;
    try {
      const lockInfo: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      const createdAt = isObject(lockInfo) && typeof lockInfo.createdAt === "string"
        ? Date.parse(lockInfo.createdAt)
        : Number.NaN;
      const fileInfo = await lstat(lockPath);
      const ageBase = Number.isFinite(createdAt) ? createdAt : fileInfo.mtimeMs;
      stale = Date.now() - ageBase > LOCK_STALE_MS;
    } catch (error: unknown) {
      if (isObject(error) && error.code === "ENOENT") continue;
      try {
        const fileInfo = await lstat(lockPath);
        stale = Date.now() - fileInfo.mtimeMs > LOCK_STALE_MS;
      } catch {}
    }
    if (stale) {
      try {
        await unlink(lockPath);
        continue;
      } catch (error: unknown) {
        if (isObject(error) && error.code === "ENOENT") continue;
      }
    }
    await sleep(delay);
    delay = Math.min(250, Math.ceil(delay * 1.5));
  }
  throw new ContractError(
    "registry_locked",
    "Timed out waiting for the worker registry lock.",
    "lock",
    { retryable: true, recovery: "Retry after the active call finishes, or inspect the stale lock owner and createdAt fields." },
  );
}

export async function releaseLock(lockPath: string, owner: string): Promise<void> {
  try {
    const current: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (isObject(current) && current.owner === owner) await unlink(lockPath);
  } catch {
    // Never remove a lock whose ownership cannot be proven.
  }
}

export async function withRegistryLock<T>(
  runPath: string,
  timeoutMs: number,
  callback: (registry: Registry, registryPath: string) => Promise<T>,
): Promise<T> {
  const { registryPath, lockPath } = registryPaths(runPath);
  const owner = await acquireLock(lockPath, timeoutMs);
  try {
    const registry = await readRegistry(registryPath);
    return await callback(registry, registryPath);
  } finally {
    await releaseLock(lockPath, owner);
  }
}

export async function canonicalSessionPath(data: unknown): Promise<string | undefined> {
  const reference = collectMatchingObjects(
    data,
    (candidate) =>
      candidate.source === "herdr:omp" &&
      candidate.agent === "omp" &&
      candidate.kind === "path" &&
      typeof candidate.value === "string",
  )[0];
  if (typeof reference?.value !== "string") return undefined;
  try {
    const canonical = await realpath(reference.value);
    return (await isFile(canonical)) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export function reportedSessionPath(data: unknown): string | undefined {
  const references = uniqueBy(
    collectMatchingObjects(
      data,
      (candidate) =>
        candidate.source === "herdr:omp" &&
        candidate.agent === "omp" &&
        candidate.kind === "path" &&
        typeof candidate.value === "string",
    ),
    ["source", "agent", "kind", "value"],
  );
  if (references.length !== 1 || typeof references[0]?.value !== "string") return undefined;
  const reported = references[0].value;
  if (!path.isAbsolute(reported) || path.normalize(reported) !== reported) return undefined;
  return reported;
}

function sessionIdMatchesReportedPath(sessionId: string, reportedPath: string): boolean {
  return path.basename(reportedPath) === `${path.basename(reportedPath, ".jsonl")}.jsonl` &&
    path.basename(reportedPath, ".jsonl").endsWith(`_${sessionId}`);
}

function bootstrapIdentityError(): ContractError {
  return new ContractError(
    "session_identity_mismatch",
    "The live agent did not converge on a stable official OMP path and bootstrap attestation.",
    "session_verify",
    { recovery: "Preserve the agent; restart its OMP process with the current herdr-delegator extension before prompting." },
  );
}

function parseBootstrapSnapshot(
  agentData: unknown,
  paneData: unknown,
  ownership: BootstrapOwnership,
  expected: BootstrapExpectedProfile,
): { observation: unknown; verification: BootstrapSessionVerification } {
  const agentWorkspaceId = firstString(agentData, ["workspace_id"]);
  const agentTabId = firstString(agentData, ["tab_id"]);
  const agentPaneId = firstString(agentData, ["pane_id"]);
  const paneCandidates = uniqueBy(
    collectMatchingObjects(
      paneData,
      (candidate) => candidate.pane_id === ownership.paneId,
    ),
    ["pane_id"],
  );
  const pane = paneCandidates[0];
  if (
    agentWorkspaceId !== ownership.workspaceId ||
    agentTabId !== ownership.tabId ||
    agentPaneId !== ownership.paneId ||
    paneCandidates.length !== 1 ||
    !pane ||
    pane.workspace_id !== ownership.workspaceId ||
    pane.tab_id !== ownership.tabId ||
    pane.agent !== "omp"
  ) {
    throw bootstrapIdentityError();
  }
  const reportedPath = reportedSessionPath(pane);
  const tokens = pane.tokens;
  if (!reportedPath || !isObject(tokens)) throw bootstrapIdentityError();
  const namespacedKeys = Object.keys(tokens)
    .filter((key) => key.startsWith(BOOTSTRAP_TOKEN_PREFIX))
    .sort();
  const expectedKeys = Object.values(BOOTSTRAP_TOKENS).sort();
  if (
    namespacedKeys.length !== expectedKeys.length ||
    namespacedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw bootstrapIdentityError();
  }
  const sessionId = tokens[BOOTSTRAP_TOKENS.sessionId];
  const provider = tokens[BOOTSTRAP_TOKENS.provider];
  const model = tokens[BOOTSTRAP_TOKENS.model];
  const thinking = tokens[BOOTSTRAP_TOKENS.thinking];
  const attestation = tokens[BOOTSTRAP_TOKENS.attestation];
  const attestationMatch = typeof attestation === "string"
    ? /^(\d{13})\.([0-9a-f]{16})$/.exec(attestation)
    : null;
  const attestedAtMs = attestationMatch ? Number(attestationMatch[1]) : Number.NaN;
  const now = Date.now();
  if (
    !isBoundedAttestationToken(sessionId) ||
    !isBoundedAttestationToken(attestation) ||
    !isBoundedAttestationToken(provider) ||
    !isBoundedAttestationToken(model) ||
    !isThinkingLevel(thinking) ||
    !attestationMatch ||
    !Number.isSafeInteger(attestedAtMs) ||
    attestedAtMs > now + 5_000 ||
    now - attestedAtMs > BOOTSTRAP_METADATA_TTL_MS ||
    !sessionIdMatchesReportedPath(sessionId, reportedPath) ||
    provider !== expected.expected_provider ||
    model !== expected.expected_model ||
    thinking !== expected.effective_thinking
  ) {
    throw bootstrapIdentityError();
  }
  return {
    observation: agentData,
    verification: {
      session_id: sessionId,
      reported_path: reportedPath,
      provider,
      model,
      thinking,
      attestation,
      attested_at: new Date(attestedAtMs).toISOString(),
    },
  };
}

export async function convergeBootstrapSessionIdentity(
  binary: string,
  agentName: string,
  ownership: BootstrapOwnership,
  expected: BootstrapExpectedProfile,
  expectedPath: string | undefined,
  expectedSessionId: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ observation: unknown; verification: BootstrapSessionVerification }> {
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 10_000));
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new ContractError(
        "operation_aborted",
        "The tool call was cancelled.",
        "session_verify",
        { recovery: "Preserve the agent; do not prompt after a cancelled bootstrap verification." },
      );
    }
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const firstAgent = await getLiveAgent(binary, agentName, remainingMs, signal);
      if (!firstAgent.ok) throw bootstrapIdentityError();
      const firstPane = await runHerdr(
        binary,
        ["pane", "get", ownership.paneId],
        remainingMs,
        signal,
      );
      if (!firstPane.ok) throw bootstrapIdentityError();
      const first = parseBootstrapSnapshot(firstAgent.data, firstPane.data, ownership, expected);

      const secondAgent = await getLiveAgent(binary, agentName, remainingMs, signal);
      if (!secondAgent.ok) throw bootstrapIdentityError();
      const secondPane = await runHerdr(
        binary,
        ["pane", "get", ownership.paneId],
        remainingMs,
        signal,
      );
      if (!secondPane.ok) throw bootstrapIdentityError();
      const second = parseBootstrapSnapshot(secondAgent.data, secondPane.data, ownership, expected);
      if (
        first.verification.reported_path !== second.verification.reported_path ||
        first.verification.session_id !== second.verification.session_id ||
        first.verification.attestation !== second.verification.attestation ||
        expectedPath !== undefined && second.verification.reported_path !== expectedPath ||
        expectedSessionId !== undefined && second.verification.session_id !== expectedSessionId
      ) {
        throw bootstrapIdentityError();
      }
      return second;
    } catch (error) {
      if (signal?.aborted) throw error;
      const delayMs = Math.min(100, deadline - Date.now());
      if (delayMs <= 0) break;
      await sleep(delayMs);
    }
  }
  throw bootstrapIdentityError();
}

export function assertPersistedMatchesBootstrap(
  persisted: SessionVerification,
  bootstrap: BootstrapSessionVerification,
): void {
  if (
    persisted.session_id !== bootstrap.session_id ||
    persisted.provider !== bootstrap.provider ||
    persisted.model !== bootstrap.model ||
    persisted.thinking !== bootstrap.thinking
  ) {
    throw new ContractError(
      "session_identity_mismatch",
      "The persisted OMP session initialization differs from its bootstrap attestation.",
      "session_verify",
      { recovery: "Preserve the agent and registry; do not resume or prompt the conflicting identity." },
    );
  }
}

async function sessionIdFromPath(sessionPath: string | undefined): Promise<string | undefined> {
  if (!sessionPath) return undefined;
  let handle: FileHandle | undefined;
  try {
    handle = await open(sessionPath, "r");
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (isObject(entry) && entry.type === "session") {
        return firstString(entry, ["id", "session_id"]);
      }
    }
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
  return undefined;
}

function splitModelIdentity(entry: Record<string, unknown>): { provider: string; model: string } | undefined {
  const provider = typeof entry.provider === "string" ? entry.provider : undefined;
  const model = typeof entry.model === "string"
    ? entry.model
    : typeof entry.modelId === "string"
      ? entry.modelId
      : undefined;
  if (!model) return undefined;
  if (provider) return { provider, model };
  const separator = model.indexOf("/");
  if (separator < 1 || separator === model.length - 1) return undefined;
  return { provider: model.slice(0, separator), model: model.slice(separator + 1) };
}

export async function readSessionVerification(
  sessionPath: string,
  record: Pick<RegistryRecord, "expected_provider" | "expected_model" | "effective_thinking">,
): Promise<SessionVerification> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(sessionPath, "r");
    const buffer = Buffer.alloc(MAX_SESSION_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (bytesRead === MAX_SESSION_BYTES && !text.endsWith("\n")) {
      text = text.slice(0, Math.max(0, text.lastIndexOf("\n") + 1));
    }
    let sessionId: string | undefined;
    let modelIdentityValue: { provider: string; model: string } | undefined;
    let fallback: boolean | undefined;
    let thinking: ThinkingLevel | undefined;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(entry)) continue;
      if (entry.role === "user" || (isObject(entry.message) && entry.message.role === "user")) break;
      if (entry.type === "session") sessionId = firstString(entry, ["id", "session_id"]) ?? sessionId;
      if (entry.type === "model_change") {
        modelIdentityValue = splitModelIdentity(entry) ?? modelIdentityValue;
        if (typeof entry.resolvedModelIsFallback === "boolean") fallback = entry.resolvedModelIsFallback;
      }
      if (entry.type === "thinking_level_change") {
        const candidate = firstString(entry, ["thinkingLevel", "thinking_level", "level"]);
        if (isThinkingLevel(candidate)) thinking = candidate;
      }
    }
    if (!sessionId || !modelIdentityValue || fallback === undefined || !thinking) {
      throw new ContractError(
        "session_verification_incomplete",
        "The session header, initial model change, fallback flag, and thinking change were not all found before the first user message within 1 MiB.",
        "session_verify",
        { recovery: "Preserve the worker and inspect its official OMP session initialization; do not prompt it." },
      );
    }
    if (
      modelIdentityValue.provider !== record.expected_provider ||
      modelIdentityValue.model !== record.expected_model ||
      thinking !== record.effective_thinking
    ) {
      throw new ContractError(
        "model_profile_mismatch",
        "The official OMP session model or thinking level differs from the persisted launch profile.",
        "session_verify",
        { recovery: "Preserve the worker without prompting; reconcile the configured role or start an explicitly approved new run." },
      );
    }
    return {
      session_id: sessionId,
      provider: modelIdentityValue.provider,
      model: modelIdentityValue.model,
      thinking,
      resolved_model_is_fallback: fallback,
    };
  } finally {
    await handle?.close();
  }
}

export async function convergeOfficialSessionIdentity(
  binary: string,
  agentName: string,
  ownership: { workspaceId?: string; tabId?: string; paneId?: string },
  expectedPath: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ observation: unknown; canonicalPath: string }> {
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 10_000));
  const identityError = () =>
    new ContractError(
      "session_identity_mismatch",
      "The live agent did not converge on a stable official canonical OMP session identity.",
      "session_verify",
      { recovery: "Preserve the agent and reconcile its official Herdr session reference before prompting." },
    );

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const observed = await getLiveAgent(binary, agentName, remainingMs, signal);
    if (!observed.ok) {
      if (observed.aborted) {
        throw commandError(observed, "session_verify", "Preserve the agent; the identity wait was cancelled.");
      }
      throw identityError();
    }
    const workspaceId = firstString(observed.data, ["workspace_id"]);
    const tabId = firstString(observed.data, ["tab_id"]);
    const paneId = firstString(observed.data, ["pane_id"]);
    if (
      (ownership.workspaceId !== undefined && workspaceId !== ownership.workspaceId) ||
      (ownership.tabId !== undefined && tabId !== ownership.tabId) ||
      (ownership.paneId !== undefined && paneId !== ownership.paneId)
    ) {
      throw identityError();
    }
    const canonicalPath = await canonicalSessionPath(observed.data);
    if (canonicalPath) {
      if (expectedPath !== undefined && canonicalPath !== expectedPath) throw identityError();
      return { observation: observed.data, canonicalPath };
    }

    const delayMs = Math.min(100, deadline - Date.now());
    if (delayMs <= 0) break;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(
          new ContractError(
            "operation_aborted",
            "The tool call was cancelled.",
            "session_verify",
            { recovery: "Preserve the agent; do not prompt after a cancelled identity wait." },
          ),
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw identityError();
}

export async function verifyWorkerSession(
  binary: string,
  record: RegistryRecord,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SessionVerification> {
  const converged = await convergeOfficialSessionIdentity(
    binary,
    record.agent_name,
    {
      workspaceId: record.workspace_id,
      tabId: record.tab_id,
      paneId: record.root_pane_id,
    },
    record.agent_session_path,
    timeoutMs,
    signal,
  );
  assertAgentBelongsToRecord(record, converged.observation);
  const beforePath = converged.canonicalPath;
  const verification = await readSessionVerification(beforePath, record);
  if (record.verified_session_id && record.verified_session_id !== verification.session_id) {
    throw new ContractError(
      "session_identity_mismatch",
      "The official session header identity differs from the persisted verified session identity.",
      "session_verify",
      { recovery: "Do not prompt or resume this worker; preserve the registry and session file for inspection." },
    );
  }
  const after = await getLiveAgent(binary, record.agent_name, Math.min(timeoutMs, 15_000), signal);
  if (!after.ok) throw commandError(after, "session_verify", "Re-read the official worker identity before prompting.");
  assertAgentBelongsToRecord(record, after.data);
  const afterPath = await canonicalSessionPath(after.data);
  if (afterPath !== beforePath) {
    throw new ContractError(
      "session_identity_mismatch",
      "The official OMP session identity changed during model verification.",
      "session_verify",
      { recovery: "Do not prompt; reconcile the live agent and session path with ensure_worker." },
    );
  }
  record.agent_session_path = beforePath;
  record.verified_session_id = verification.session_id;
  record.resolved_model_is_fallback = verification.resolved_model_is_fallback;
  record.verified_at = nowIso();
  return verification;
}

export function assertLaunchProfile(record: RegistryRecord, launch: ResolvedLaunchProfile): void {
  if (
    record.selected_profile !== launch.selected_profile ||
    record.requested_role !== launch.requested_role ||
    record.expected_provider !== launch.expected_provider ||
    record.expected_model !== launch.expected_model ||
    record.effective_thinking !== launch.effective_thinking
  ) {
    throw new ContractError(
      "model_profile_mismatch",
      "The persisted worker launch profile no longer matches current layered configuration and role resolution.",
      "model_verify",
      { recovery: "Do not resume or prompt this worker; preserve it and use an explicitly approved new run or profile." },
    );
  }
}

export async function updateRecordFromObservation(
  record: RegistryRecord,
  data: unknown,
  fallback?: WorkerState,
): Promise<void> {
  record.state = normalizeState(data, fallback ?? "agent-ready");
  record.revision = firstNumber(data, ["revision"]) ?? record.revision;
  record.state_change_seq = firstNumber(data, ["state_change_seq"]) ?? record.state_change_seq;
  record.agent_session_path = (await canonicalSessionPath(data)) ?? record.agent_session_path;
  record.workspace_id = firstString(data, ["workspace_id"]) ?? record.workspace_id;
  record.tab_id = firstString(data, ["tab_id"]) ?? record.tab_id;
  record.root_pane_id = firstString(data, ["pane_id"]) ?? record.root_pane_id;
  record.updated_at = nowIso();
}

export async function observeOrchestrator(
  binary: string,
  paneId: string,
  launch: Omit<OrchestratorRecord, "pane_id" | "observed_at">,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OrchestratorRecord> {
  const current = await runHerdr(binary, ["pane", "get", paneId], timeoutMs, signal);
  if (!current.ok) throw commandError(current, "caller", "Read the controlling Herdr pane again.");
  const observedPane = firstString(current.data, ["pane_id"]);
  if (observedPane !== paneId) {
    throw new ContractError(
      "caller_context_mismatch",
      "HERDR_PANE_ID does not match the explicitly inspected Herdr pane.",
      "caller",
      { recovery: "Check the managed pane environment and Herdr server connection." },
    );
  }
  const sessionPath = await canonicalSessionPath(current.data);
  return {
    session_path: sessionPath,
    session_id: await sessionIdFromPath(sessionPath),
    workspace_id: firstString(current.data, ["workspace_id"]),
    tab_id: firstString(current.data, ["tab_id"]),
    pane_id: paneId,
    ...launch,
    observed_at: nowIso(),
  };
}

function parseFocusSnapshot(data: unknown): FocusSnapshot {
  return {
    workspace_id: firstString(data, ["focused_workspace_id"]),
    tab_id: firstString(data, ["focused_tab_id"]),
    pane_id: firstString(data, ["focused_pane_id"]),
  };
}

export async function captureFocus(binary: string, signal?: AbortSignal): Promise<FocusSnapshot> {
  const snapshot = await runHerdr(binary, ["api", "snapshot"], FOCUS_TIMEOUT_MS, signal);
  if (!snapshot.ok) {
    throw commandError(snapshot, "focus_capture", "Retry after Herdr can provide a global session snapshot.");
  }
  return parseFocusSnapshot(snapshot.data);
}

export async function restoreFocus(
  binary: string,
  before: FocusSnapshot,
  owned: OwnedFocus,
): Promise<FocusRestoration> {
  const snapshot = await runHerdr(binary, ["api", "snapshot"], FOCUS_TIMEOUT_MS);
  if (!snapshot.ok) return "partial";
  const after = parseFocusSnapshot(snapshot.data);
  if (
    after.workspace_id === before.workspace_id &&
    after.tab_id === before.tab_id &&
    after.pane_id === before.pane_id
  ) {
    return "unchanged";
  }
  const movedToOwned =
    (!!owned.workspace_id && after.workspace_id === owned.workspace_id) ||
    (!!after.tab_id && owned.tab_ids.has(after.tab_id)) ||
    (!!after.pane_id && owned.pane_ids.has(after.pane_id));
  if (!movedToOwned) return "skipped-concurrent-user-focus";

  let partial = false;
  if (before.workspace_id) {
    const focused = await runHerdr(binary, ["workspace", "focus", before.workspace_id], FOCUS_TIMEOUT_MS);
    partial ||= !focused.ok;
  }
  if (before.tab_id) {
    const focused = await runHerdr(binary, ["tab", "focus", before.tab_id], FOCUS_TIMEOUT_MS);
    partial ||= !focused.ok;
  }
  if (before.pane_id) {
    const focused = await runHerdr(binary, ["agent", "focus", before.pane_id], FOCUS_TIMEOUT_MS);
    partial ||= !focused.ok;
  }
  return partial ? "partial" : "restored";
}

async function validateWorkspaceCandidate(
  binary: string,
  workspaceId: string,
  workspaceLabel: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ anchorTabId: string; anchorPaneId: string }> {
  const [workspace, snapshot] = await Promise.all([
    runHerdr(binary, ["workspace", "get", workspaceId], timeoutMs, signal),
    runHerdr(binary, ["api", "snapshot"], timeoutMs, signal),
  ]);
  if (!workspace.ok) throw commandError(workspace, "workspace_reconcile", "Read the candidate workspace again.");
  if (!snapshot.ok) throw commandError(snapshot, "workspace_reconcile", "Read a fresh Herdr snapshot.");
  const workspaceObject = collectMatchingObjects(
    workspace.data,
    (candidate) => candidate.workspace_id === workspaceId,
  )[0];
  if (!workspaceObject || workspaceObject.label !== workspaceLabel) {
    throw new ContractError(
      "identity_conflict",
      "The candidate workspace ID or deterministic label does not match the run reservation.",
      "workspace_reconcile",
      { recovery: "Preserve the candidate and inspect its identity; labels alone are not ownership proof." },
    );
  }
  const tabs = uniqueBy(
    collectMatchingObjects(
      snapshot.data,
      (candidate) => candidate.workspace_id === workspaceId && typeof candidate.tab_id === "string",
    ),
    ["tab_id"],
  );
  if (tabs.length !== 1) {
    throw new ContractError(
      "identity_conflict",
      "An uncommitted workspace candidate does not have exactly one anchor tab.",
      "workspace_reconcile",
      { recovery: "Preserve the workspace and inspect its topology before adoption." },
    );
  }
  const anchorTabId = firstString(tabs[0], ["tab_id"]);
  const panes = uniqueBy(
    collectMatchingObjects(
      snapshot.data,
      (candidate) => candidate.tab_id === anchorTabId && typeof candidate.pane_id === "string",
    ),
    ["pane_id"],
  );
  const anchorPaneId = firstString(panes[0], ["pane_id"]);
  if (!anchorTabId || panes.length !== 1 || !anchorPaneId) {
    throw new ContractError(
      "identity_conflict",
      "An uncommitted workspace candidate does not have exactly one anchor pane.",
      "workspace_reconcile",
      { recovery: "Preserve the workspace and inspect its topology before adoption." },
    );
  }
  const pane = await runHerdr(binary, ["pane", "get", anchorPaneId], timeoutMs, signal);
  if (!pane.ok) throw commandError(pane, "workspace_reconcile", "Read the anchor pane again.");
  const paneCwd = firstString(pane.data, ["cwd"]);
  let canonicalPaneCwd: string | undefined;
  try {
    canonicalPaneCwd = paneCwd ? await realpath(paneCwd) : undefined;
  } catch {
    canonicalPaneCwd = undefined;
  }
  if (canonicalPaneCwd !== cwd) {
    throw new ContractError(
      "identity_conflict",
      "The workspace candidate anchor cwd differs from the canonical requested cwd.",
      "workspace_reconcile",
      { recovery: "Preserve the workspace and inspect its provenance before adoption." },
    );
  }
  return { anchorTabId, anchorPaneId };
}

export async function ensureRunWorkspace(
  binary: string,
  registry: Registry,
  registryPath: string,
  runPath: string,
  cwd: string,
  orchestrator: OrchestratorRecord,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunRecord> {
  const runKey = sha256(runPath);
  const workspaceLabel = `herdr-run-${runKey.slice(0, 12)}`;
  const timestamp = nowIso();
  if (!registry.run) {
    registry.run = {
      run_path: runPath,
      run_key: runKey,
      cwd,
      owner: REGISTRY_OWNER,
      generation: RUN_GENERATION,
      workspace_label: workspaceLabel,
      workspace_state: "workspace-creating",
      created_workspace: false,
      created_at: timestamp,
      updated_at: timestamp,
      orchestrator,
    };
    await writeRegistryAtomic(registryPath, registry);
  }
  const run = registry.run;
  if (
    run.run_path !== runPath ||
    run.run_key !== runKey ||
    run.cwd !== cwd ||
    run.owner !== REGISTRY_OWNER ||
    run.generation !== RUN_GENERATION ||
    run.workspace_label !== workspaceLabel
  ) {
    throw new ContractError(
      "identity_conflict",
      "The run registry does not match the requested canonical run identity.",
      "workspace_reconcile",
      { recovery: "Do not overwrite or migrate the run record implicitly; inspect the conflicting registry." },
    );
  }
  run.orchestrator = orchestrator;
  run.updated_at = nowIso();

  if (run.workspace_id && run.workspace_state === "ready") {
    const workspace = await runHerdr(binary, ["workspace", "get", run.workspace_id], timeoutMs, signal);
    if (workspace.ok) {
      const candidate = collectMatchingObjects(
        workspace.data,
        (item) => item.workspace_id === run.workspace_id,
      )[0];
      if (!candidate || candidate.label !== workspaceLabel || !run.anchor_pane_id) {
        throw new ContractError(
          "identity_conflict",
          "The registered workspace no longer matches its deterministic label or anchor.",
          "workspace_reconcile",
          { recovery: "Preserve the live workspace and inspect registry ownership before continuing." },
        );
      }
      const anchor = await runHerdr(binary, ["pane", "get", run.anchor_pane_id], timeoutMs, signal);
      if (!anchor.ok) throw commandError(anchor, "workspace_reconcile", "Read the registered anchor pane again.");
      const anchorCwd = firstString(anchor.data, ["cwd"]);
      let canonicalAnchorCwd: string | undefined;
      try {
        canonicalAnchorCwd = anchorCwd ? await realpath(anchorCwd) : undefined;
      } catch {
        canonicalAnchorCwd = undefined;
      }
      if (canonicalAnchorCwd !== cwd) {
        throw new ContractError(
          "identity_conflict",
          "The registered workspace anchor cwd differs from the canonical run cwd.",
          "workspace_reconcile",
          { recovery: "Preserve the workspace and inspect its provenance before continuing." },
        );
      }
      await writeRegistryAtomic(registryPath, registry);
      return run;
    }
    if (!/not_found|not found/i.test(`${workspace.code} ${workspace.message}`)) {
      throw commandError(workspace, "workspace_reconcile", "Read the registered workspace again.");
    }
    run.workspace_state = "workspace-creating";
    delete run.workspace_id;
    delete run.anchor_tab_id;
    delete run.anchor_pane_id;
    run.created_workspace = false;
    await writeRegistryAtomic(registryPath, registry);
  }
  const recoveringLostWorkspace =
    run.workspace_state === "workspace-creating" &&
    !run.workspace_id &&
    Object.keys(registry.workers).length > 0;

  const listed = await runHerdr(binary, ["workspace", "list"], timeoutMs, signal);
  if (!listed.ok) throw commandError(listed, "workspace_reconcile", "Read the workspace list again.");
  const candidates = uniqueBy(
    collectMatchingObjects(listed.data, (item) => item.label === workspaceLabel),
    ["workspace_id"],
  );
  if (candidates.length > 1) {
    throw new ContractError(
      "identity_conflict",
      "Multiple workspaces have the deterministic run label.",
      "workspace_reconcile",
      { recovery: "Preserve every candidate; labels are hints and cannot disambiguate ownership." },
    );
  }

  let workspaceId: string;
  let anchorTabId: string;
  let anchorPaneId: string;
  if (candidates.length === 1) {
    workspaceId = firstString(candidates[0], ["workspace_id"]) ?? "";
    if (
      !workspaceId ||
      (!recoveringLostWorkspace &&
        Object.values(registry.workers).some((worker) => worker.workspace_id !== workspaceId))
    ) {
      throw new ContractError(
        "identity_conflict",
        "The sole labelled workspace candidate conflicts with registry ownership.",
        "workspace_reconcile",
        { recovery: "Preserve the candidate and inspect registry ownership before adoption." },
      );
    }
    const anchor = await validateWorkspaceCandidate(
      binary,
      workspaceId,
      workspaceLabel,
      cwd,
      timeoutMs,
      signal,
    );
    anchorTabId = anchor.anchorTabId;
    anchorPaneId = anchor.anchorPaneId;
  } else {
    const created = await runHerdr(
      binary,
      ["workspace", "create", "--cwd", cwd, "--label", workspaceLabel, "--no-focus"],
      timeoutMs,
      signal,
    );
    if (!created.ok) {
      throw commandError(
        created,
        "workspace_create",
        "List and reconcile the deterministic workspace label before retrying creation.",
        created.timedOut,
      );
    }
    workspaceId = firstString(created.data, ["workspace_id"]) ?? "";
    anchorTabId = firstString(created.data, ["tab_id"]) ?? "";
    const roots = collectMatchingObjects(created.data, (item) => isObject(item.root_pane));
    anchorPaneId =
      firstString(roots[0]?.root_pane, ["pane_id"]) ??
      firstString(created.data, ["root_pane_id"]) ??
      "";
    if (!workspaceId || !anchorTabId || !anchorPaneId) {
      throw new ContractError(
        "invalid_herdr_response",
        "The workspace-create response omitted workspace, anchor tab, or anchor pane coordinates.",
        "workspace_create",
        {
          ambiguousEffect: true,
          recovery: "List and reconcile the deterministic label; do not issue a second create blindly.",
        },
      );
    }
  }
  run.workspace_id = workspaceId;
  run.anchor_tab_id = anchorTabId;
  run.anchor_pane_id = anchorPaneId;
  run.workspace_state = "ready";
  run.created_workspace = true;
  run.updated_at = nowIso();
  if (recoveringLostWorkspace) {
    for (const worker of Object.values(registry.workers)) {
      worker.workspace_id = workspaceId;
      delete worker.tab_id;
      delete worker.root_pane_id;
      worker.created_tab = false;
      worker.state = "planned";
      worker.updated_at = run.updated_at;
    }
  }
  await writeRegistryAtomic(registryPath, registry);
  return run;
}

export async function assertRunWorkspaceLive(
  binary: string,
  registry: Registry,
  timeoutMs: number,
  signal?: AbortSignal,
  expectedRunPath?: string,
  expectedCwd?: string,
): Promise<RunRecord> {
  const run = registry.run;
  if (
    !run ||
    run.owner !== REGISTRY_OWNER ||
    run.generation !== RUN_GENERATION ||
    run.workspace_state !== "ready" ||
    !run.workspace_id ||
    !run.anchor_tab_id ||
    !run.anchor_pane_id ||
    (expectedRunPath !== undefined && run.run_path !== expectedRunPath) ||
    (expectedCwd !== undefined && run.cwd !== expectedCwd)
  ) {
    throw new ContractError(
      "run_workspace_not_ready",
      "The registry has no complete owned run workspace.",
      "workspace_reconcile",
      { recovery: "Call ensure_worker to reconcile the canonical run workspace." },
    );
  }
  const [workspace, snapshot, anchor] = await Promise.all([
    runHerdr(binary, ["workspace", "get", run.workspace_id], timeoutMs, signal),
    runHerdr(binary, ["api", "snapshot"], timeoutMs, signal),
    runHerdr(binary, ["pane", "get", run.anchor_pane_id], timeoutMs, signal),
  ]);
  if (!workspace.ok) throw commandError(workspace, "workspace_reconcile", "Call ensure_worker to recover the run workspace.");
  if (!snapshot.ok) throw commandError(snapshot, "workspace_reconcile", "Read a fresh Herdr snapshot.");
  if (!anchor.ok) throw commandError(anchor, "workspace_reconcile", "Read the run anchor pane again.");
  const liveWorkspace = collectMatchingObjects(
    workspace.data,
    (item) => item.workspace_id === run.workspace_id,
  )[0];
  const anchorTab = collectMatchingObjects(
    snapshot.data,
    (item) => item.tab_id === run.anchor_tab_id && item.workspace_id === run.workspace_id,
  )[0];
  const anchorPane = collectMatchingObjects(
    snapshot.data,
    (item) => item.pane_id === run.anchor_pane_id && item.tab_id === run.anchor_tab_id,
  )[0];
  const liveAnchorCwd = firstString(anchor.data, ["cwd"]);
  let canonicalAnchorCwd: string | undefined;
  try {
    canonicalAnchorCwd = liveAnchorCwd ? await realpath(liveAnchorCwd) : undefined;
  } catch {
    canonicalAnchorCwd = undefined;
  }
  if (
    !liveWorkspace ||
    liveWorkspace.label !== run.workspace_label ||
    !anchorTab ||
    !anchorPane ||
    canonicalAnchorCwd !== run.cwd
  ) {
    throw new ContractError(
      "identity_conflict",
      "The live run workspace, anchor topology, or canonical cwd differs from the registry.",
      "workspace_reconcile",
      { recovery: "Preserve the workspace and inspect its identity before continuing." },
    );
  }
  return run;
}

export async function getLiveAgent(
  binary: string,
  agentName: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return runHerdr(binary, ["agent", "get", agentName], timeoutMs, signal);
}

/**
 * MCP clients abort a single call at 30s, so every effective server-side status
 * wait is clamped below that bound; longer logical waits are composed by
 * repeating bounded waits.
 */
export const MAX_EFFECTIVE_WAIT_MS = 25_000;
const STATUS_READ_TIMEOUT_MS = 5_000;

/**
 * Waits for the agent to reach one of `until`. The current status is read before
 * subscribing, so a state that is already satisfied resolves immediately instead
 * of timing out against a status stream that will never re-emit it.
 */
export async function waitForAgentStatus(
  binary: string,
  agentName: string,
  until: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const waitMs = Math.min(timeoutMs, MAX_EFFECTIVE_WAIT_MS);
  const current = await getLiveAgent(binary, agentName, Math.min(waitMs, STATUS_READ_TIMEOUT_MS), signal);
  if (current.ok) {
    const status = firstString(current.data, ["agent_status", "state", "status"]);
    if (status !== undefined && until.includes(status)) return current;
  }
  return runHerdr(
    binary,
    ["agent", "wait", agentName, ...until.flatMap((state) => ["--until", state]), "--timeout", String(waitMs)],
    waitMs + 1_000,
    signal,
  );
}

export function assertAgentBelongsToRecord(record: RegistryRecord, data: unknown): void {
  const livePane = firstString(data, ["pane_id"]);
  const liveWorkspace = firstString(data, ["workspace_id"]);
  if (
    (record.root_pane_id && livePane && record.root_pane_id !== livePane) ||
    (liveWorkspace && record.workspace_id !== liveWorkspace)
  ) {
    throw new ContractError(
      "identity_conflict",
      "The deterministic agent name points to a live pane different from the registry.",
      "reconcile",
      { recovery: "Do not close the conflicting tab or pane; inspect ownership first." },
    );
  }
}

export async function reconcileDeterministicIdentity(
  binary: string,
  record: RegistryRecord,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ tabId?: string; rootPaneId?: string; agentData?: unknown }> {
  const [agents, tabs] = await Promise.all([
    runHerdr(binary, ["agent", "list"], timeoutMs, signal),
    runHerdr(binary, ["tab", "list", "--workspace", record.workspace_id], timeoutMs, signal),
  ]);
  if (!agents.ok) throw commandError(agents, "reconcile", "Read the agent list again.");
  if (!tabs.ok) throw commandError(tabs, "reconcile", "Read the tab list again.");
  const agentMatches = uniqueBy(
    collectMatchingObjects(agents.data, (item) => item.name === record.agent_name),
    ["name", "pane_id"],
  );
  const tabMatches = uniqueBy(
    collectMatchingObjects(tabs.data, (item) => item.label === record.agent_name),
    ["tab_id"],
  );
  if (agentMatches.length > 1 || tabMatches.length > 1) {
    throw new ContractError(
      "identity_conflict",
      "Multiple live candidates match the deterministic worker identity.",
      "reconcile",
      { recovery: "Preserve every candidate and inspect ownership before continuing." },
    );
  }
  const agentMatch = agentMatches[0];
  if (agentMatch) {
    const pane = firstString(agentMatch, ["pane_id"]);
    const tab = firstString(agentMatch, ["tab_id"]);
    if ((record.root_pane_id && pane !== record.root_pane_id) || (record.tab_id && tab !== record.tab_id)) {
      throw new ContractError(
        "identity_conflict",
        "The live deterministic agent coordinates differ from the registry.",
        "reconcile",
        { recovery: "Inspect the conflicting coordinates before continuing." },
      );
    }
    return { tabId: tab, rootPaneId: pane, agentData: agentMatch };
  }

  const tabMatch = tabMatches[0];
  if (!tabMatch) return {};
  const tabId = firstString(tabMatch, ["tab_id"]);
  if (!tabId) throw new ContractError("invalid_herdr_response", "The worker tab has no tab_id.", "reconcile");
  if (record.tab_id && record.tab_id !== tabId) {
    throw new ContractError(
      "identity_conflict",
      "A deterministic worker label points to a replacement tab not reserved by the registry.",
      "reconcile",
      { recovery: "Preserve the tab and inspect ownership before continuing." },
    );
  }
  const tabGet = await runHerdr(binary, ["tab", "get", tabId], timeoutMs, signal);
  if (!tabGet.ok) throw commandError(tabGet, "reconcile", "Read the deterministic tab again.");
  let rootPaneId = firstString(tabGet.data, ["root_pane_id"]);
  if (!rootPaneId) {
    const roots = collectMatchingObjects(tabGet.data, (item) => isObject(item.root_pane));
    rootPaneId = firstString(roots[0]?.root_pane, ["pane_id"]);
  }
  if (!rootPaneId || (record.root_pane_id && record.root_pane_id !== rootPaneId)) {
    throw new ContractError(
      "identity_conflict",
      "The deterministic worker tab root pane differs from the registry.",
      "reconcile",
      { recovery: "Preserve the tab and inspect its pane topology." },
    );
  }
  const paneGet = await runHerdr(binary, ["pane", "get", rootPaneId], timeoutMs, signal);
  if (!paneGet.ok) throw commandError(paneGet, "reconcile", "Read the root pane again.");
  const paneCwd = firstString(paneGet.data, ["cwd"]);
  let canonicalPaneCwd: string | undefined;
  try {
    canonicalPaneCwd = paneCwd ? await realpath(paneCwd) : undefined;
  } catch {
    canonicalPaneCwd = undefined;
  }
  if (canonicalPaneCwd !== cwd) {
    throw new ContractError(
      "identity_conflict",
      "The deterministic worker pane cwd differs from the requested cwd.",
      "reconcile",
      { recovery: "Preserve the pane and inspect identity ownership." },
    );
  }
  return { tabId, rootPaneId };
}

export function isMissingHerdrObject(result: Exclude<CommandResult, { ok: true }>): boolean {
  return result.code === "agent_not_found" || /not_found|not found/i.test(`${result.code} ${result.message}`);
}

async function assertOwnedShellPane(
  binary: string,
  record: RegistryRecord,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!record.tab_id || !record.root_pane_id) {
    throw new ContractError("worker_coordinates_missing", "The worker pane coordinates are incomplete.", "resume_prepare");
  }
  const [tab, pane, processInfo] = await Promise.all([
    runHerdr(binary, ["tab", "get", record.tab_id], timeoutMs, signal),
    runHerdr(binary, ["pane", "get", record.root_pane_id], timeoutMs, signal),
    runHerdr(binary, ["pane", "process-info", "--pane", record.root_pane_id], timeoutMs, signal),
  ]);
  if (!tab.ok) throw commandError(tab, "resume_prepare", "Reconcile the owned worker tab before resume.");
  if (!pane.ok) throw commandError(pane, "resume_prepare", "Reconcile the owned worker pane before resume.");
  if (!processInfo.ok) throw commandError(processInfo, "resume_prepare", "Inspect the worker pane process before resume.");
  const tabObject = collectMatchingObjects(tab.data, (item) => item.tab_id === record.tab_id)[0];
  const paneObject = collectMatchingObjects(pane.data, (item) => item.pane_id === record.root_pane_id)[0];
  if (
    !tabObject ||
    tabObject.label !== record.agent_name ||
    !paneObject ||
    firstString(paneObject, ["workspace_id"]) !== record.workspace_id ||
    firstString(paneObject, ["tab_id"]) !== record.tab_id
  ) {
    throw new ContractError(
      "identity_conflict",
      "The manual-resume target is not the registry-owned deterministic worker pane.",
      "resume_prepare",
      { recovery: "Preserve the pane and inspect its ownership before starting any process." },
    );
  }
  const paneCwd = firstString(paneObject, ["cwd"]);
  let canonicalPaneCwd: string | undefined;
  try {
    canonicalPaneCwd = paneCwd ? await realpath(paneCwd) : undefined;
  } catch {
    canonicalPaneCwd = undefined;
  }
  if (canonicalPaneCwd !== cwd) {
    throw new ContractError(
      "identity_conflict",
      "The manual-resume target cwd differs from the requested canonical cwd.",
      "resume_prepare",
      { recovery: "Preserve the pane and inspect its ownership before starting any process." },
    );
  }
  const processText = String(JSON.stringify(processInfo.data)).toLowerCase();
  const shellObserved = /(?:^|[/"\s])(zsh|bash|fish|sh|nu)(?:["\s]|$)/.test(processText);
  if (!shellObserved || /(?:^|[/"\s])(omp|oh-my-pi)(?:["\s]|$)/.test(processText)) {
    throw new ContractError(
      "duplicate_session_ambiguous",
      "The owned target pane is not provably an interactive shell with no OMP process.",
      "resume_prepare",
      { recovery: "Inspect pane process-info and native Herdr restoration; do not start a second OMP process." },
    );
  }
}

export async function assertNoDuplicateSession(
  binary: string,
  sessionPath: string,
  targetPaneId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!(await isFile(sessionPath))) {
    throw new ContractError(
      "session_reference_missing",
      "The registry-recorded OMP session file no longer exists.",
      "resume_prepare",
      { recovery: "Preserve the worker record; context-preserving resume is unavailable and reset requires user judgment." },
    );
  }
  const agents = await runHerdr(binary, ["agent", "list"], timeoutMs, signal);
  if (!agents.ok) throw commandError(agents, "resume_prepare", "Read the complete Herdr agent list before resume.");
  const liveAgents = uniqueBy(
    collectMatchingObjects(
      agents.data,
      (item) => typeof item.pane_id === "string" && typeof item.name === "string",
    ),
    ["name", "pane_id"],
  );
  for (const liveAgent of liveAgents) {
    const paneId = firstString(liveAgent, ["pane_id"]);
    if (!paneId || paneId === targetPaneId) continue;
    const liveSessionPath = await canonicalSessionPath(liveAgent);
    if (liveSessionPath === sessionPath) {
      throw new ContractError(
        "duplicate_session_conflict",
        "Another live Herdr agent reports the registry-recorded OMP session path.",
        "resume_prepare",
        { recovery: "Do not resume; inspect both agents and let the user decide which process survives." },
      );
    }
    const serialized = String(JSON.stringify(liveAgent)).toLowerCase();
    if (!liveSessionPath && /"omp"|"herdr:omp"/.test(serialized)) {
      throw new ContractError(
        "duplicate_session_ambiguous",
        "A live OMP agent has no canonical session reference, so duplicate-session safety cannot be proved.",
        "resume_prepare",
        { recovery: "Allow native restoration or inspect the unreferenced live agent before manual resume." },
      );
    }
  }
}

export async function startWorkerAgent(
  binary: string,
  record: RegistryRecord,
  launch: ResolvedLaunchProfile,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!record.root_pane_id) {
    throw new ContractError("worker_coordinates_missing", "The worker root pane is missing.", "agent_start");
  }
  assertLaunchProfile(record, launch);
  await assertOwnedShellPane(binary, record, cwd, timeoutMs, signal);
  const args = [
    "agent",
    "start",
    record.agent_name,
    "--kind",
    "omp",
    "--pane",
    record.root_pane_id,
    "--timeout",
    String(timeoutMs),
  ];
  const resumePath = record.agent_session_path;
  if (resumePath) {
    await assertNoDuplicateSession(binary, resumePath, record.root_pane_id, timeoutMs, signal);
  }
  args.push(
    "--",
    ...(resumePath ? [`--resume=${resumePath}`] : []),
    "--model",
    `${launch.expected_provider}/${launch.expected_model}`,
    "--thinking",
    launch.effective_thinking,
  );
  const started = await runHerdr(binary, args, timeoutMs + 1_000, signal);
  if (!started.ok) {
    const afterFailure = await getLiveAgent(binary, record.agent_name, Math.min(timeoutMs, 10_000), signal);
    if (afterFailure.ok) {
      assertAgentBelongsToRecord(record, afterFailure.data);
      const observedPath = await canonicalSessionPath(afterFailure.data);
      if (resumePath && observedPath !== resumePath) {
        throw new ContractError(
          "identity_conflict",
          "The agent observed after an ambiguous start does not report the registry-recorded session path.",
          "agent_start",
          { ambiguousEffect: true, recovery: "Preserve the pane and inspect the live agent; do not prompt it." },
        );
      }
      return afterFailure.data;
    }
    throw commandError(
      started,
      "agent_start",
      "Check agent get and root-pane process-info before retrying the start.",
      started.timedOut || /timeout|not_ready/i.test(`${started.code} ${started.message}`),
    );
  }
  const ready = deepValues(started.data, "interactive_ready").find((item) => typeof item === "boolean");
  if (ready === false) {
    throw new ContractError(
      "agent_not_ready",
      "The OMP agent did not reach interactive readiness.",
      "agent_start",
      { retryable: true, recovery: "Read agent get and pane process-info, then recover the existing process." },
    );
  }
  const verified = await getLiveAgent(binary, record.agent_name, Math.min(timeoutMs, 15_000), signal);
  if (!verified.ok) throw commandError(verified, "agent_verify", "Inspect the started agent before prompting.");
  assertAgentBelongsToRecord(record, verified.data);
  const observedPath = await canonicalSessionPath(verified.data);
  if (resumePath && observedPath !== resumePath) {
    throw new ContractError(
      "identity_conflict",
      "The resumed worker did not re-report the registry-recorded canonical session path.",
      "agent_verify",
      { recovery: "Preserve the pane and do not prompt it until session identity is resolved." },
    );
  }
  return verified.data;
}
