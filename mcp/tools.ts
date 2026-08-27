import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { initializeRun, inspectOrchestrator, startOrchestrator } from "../extensions/lib/track";
import { closeWorker, ensureWorker, inspectWorker, resolveBlock, verifyPromptedWorker } from "../extensions/lib/worker";
import { ContractError as LegacyContractError, type ThinkingLevel, type WorkerResult } from "../extensions/lib/contracts";
import { BOOTSTRAP_METADATA_TTL_MS, BOOTSTRAP_TOKEN_PREFIX, BOOTSTRAP_TOKENS } from "../extensions/lib/bridge";
import { HerdrAdapter } from "./herdr-adapter";
import { DelegationStore } from "./registry";
import { BOUNDED_TOKEN_RE, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, McpContractError, nowIso, ompRuntimeFactsSchema, sha256, type AssignmentRecord, type DelegationRegistry, type ErrorPhase, type HerdrAssignmentInput, type HerdrTrackInput, type HerdrWorkerInput, type LaneState, type McpResult, type OmpRuntimeFacts, type RunRef, type ToolName, type WorkerLaneRecord } from "./contracts";

function field(value: unknown, names: readonly string[]): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) { for (const child of value) { const found = field(child, names); if (found !== undefined) return found; } return undefined; }
  for (const name of names) if (name in value) return (value as Record<string, unknown>)[name];
  for (const child of Object.values(value)) { const found = field(child, names); if (found !== undefined) return found; }
  return undefined;
}
function stringField(value: unknown, names: readonly string[]): string | undefined { const found = field(value, names); return typeof found === "string" ? found : undefined; }
function numberField(value: unknown, names: readonly string[]): number | undefined { const found = field(value, names); return typeof found === "number" && Number.isFinite(found) ? found : undefined; }
function timeout(value: { wait?: { timeout_ms?: number } }): number { const candidate = value.wait?.timeout_ms ?? DEFAULT_TIMEOUT_MS; return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, candidate)); }
function runRef(input: { track_id: string; run_id: string }): RunRef { return { track_id: input.track_id, run_id: input.run_id }; }
function laneState(raw: string | undefined): LaneState { if (raw === "blocked") return "blocked"; if (raw === "working" || raw === "prompted") return "working"; if (raw === "closed") return "closed"; if (raw === "failed") return "failed"; if (raw === "resume-needed") return "resume-needed"; return "idle"; }

function matchingObjects(
  value: unknown,
  predicate: (candidate: Record<string, unknown>) => boolean,
  output: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const child of value) matchingObjects(child, predicate, output);
    return output;
  }
  const candidate = value as Record<string, unknown>;
  if (predicate(candidate)) output.push(candidate);
  for (const child of Object.values(candidate)) matchingObjects(child, predicate, output);
  return output;
}

function exactUnique(values: (string | undefined)[], coordinate: string): string {
  const unique = [...new Set(values.filter((value): value is string => value !== undefined))];
  if (unique.length !== 1) throw new McpContractError("omp_fact_bridge_mismatch", `${coordinate} is absent or ambiguous.`, "attest", "Refresh the exact caller pane and OMP bridge before mutation.");
  return unique[0];
}

function boundedAbsolutePath(value: string, coordinate: string): void {
  if (value.includes("\0") || Buffer.byteLength(value) > 4_096 || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new McpContractError("omp_fact_bridge_invalid", `${coordinate} is not a bounded normalized absolute path.`, "model-verify", "Let the OMP extension republish strict session facts.");
  }
}

async function loadFacts(adapter: HerdrAdapter): Promise<{ facts: OmpRuntimeFacts; ctx: ExtensionContext; thinking: ThinkingLevel }> {
  const callerPane = process.env.HERDR_PANE_ID;
  if (!callerPane || callerPane.length > 80 || !BOUNDED_TOKEN_RE.test(callerPane)) {
    throw new McpContractError("omp_fact_bridge_missing", "Inherited HERDR_PANE_ID is unavailable or invalid.", "model-verify", "Launch this stdio server from the active OMP pane.");
  }
  const [agentObservation, paneObservation] = await Promise.all([
    adapter.getAgent(callerPane, 10_000),
    adapter.getPane(callerPane, 10_000),
  ]);
  const officialReference = (value: unknown, kind: "id" | "path"): string[] => matchingObjects(
    value,
    (candidate) => candidate.source === "herdr:omp" && candidate.agent === "omp" && candidate.kind === kind && typeof candidate.value === "string",
  ).map((candidate) => candidate.value as string);
  const agentPath = exactUnique(officialReference(agentObservation.data, "path"), "Caller agent official session path");
  const panePath = exactUnique(officialReference(paneObservation.data, "path"), "Caller pane official session path");
  if (agentPath !== panePath) throw new McpContractError("omp_fact_bridge_mismatch", "Agent and pane observations disagree on the official OMP session path.", "attest", "Do not mutate until Herdr caller identity converges.");
  boundedAbsolutePath(agentPath, "official session path");

  const paneCandidates = matchingObjects(paneObservation.data, (candidate) => candidate.pane_id === callerPane);
  if (paneCandidates.length !== 1) throw new McpContractError("omp_fact_bridge_mismatch", "Caller pane observation is absent or ambiguous.", "attest", "Inspect the inherited Herdr pane identity.");
  const tokensValue = paneCandidates[0].tokens;
  if (tokensValue === null || typeof tokensValue !== "object" || Array.isArray(tokensValue)) {
    throw new McpContractError("omp_fact_bridge_mismatch", "Caller pane has no bootstrap metadata tokens.", "attest", "Refresh the OMP bootstrap bridge before mutation.");
  }
  const tokens = tokensValue as Record<string, unknown>;
  const namespacedKeys = Object.keys(tokens).filter((key) => key.startsWith(BOOTSTRAP_TOKEN_PREFIX)).sort();
  const expectedKeys = Object.values(BOOTSTRAP_TOKENS).sort();
  if (namespacedKeys.length !== expectedKeys.length || namespacedKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new McpContractError("omp_fact_bridge_mismatch", "Caller pane bootstrap token set is incomplete or contains unexpected namespaced keys.", "attest", "Refresh metadata and bridge facts together.");
  }
  const metadataSession = tokens[BOOTSTRAP_TOKENS.sessionId];
  const officialSessionId = typeof metadataSession === "string" ? metadataSession : undefined;
  if (!officialSessionId || officialSessionId.length > 80 || !BOUNDED_TOKEN_RE.test(officialSessionId)) {
    throw new McpContractError("omp_fact_bridge_mismatch", "Caller pane metadata has no bounded official session ID.", "attest", "Refresh the active OMP bridge.");
  }
  const nativeIds = [...officialReference(agentObservation.data, "id"), ...officialReference(paneObservation.data, "id")];
  if (nativeIds.length > 0 && exactUnique(nativeIds, "Caller official session ID") !== officialSessionId) {
    throw new McpContractError("omp_fact_bridge_mismatch", "Native and metadata session IDs disagree.", "attest", "Do not mutate until caller identity converges.");
  }
  const sessionFilename = path.basename(agentPath);
  const sessionStem = sessionFilename.endsWith(".jsonl") ? sessionFilename.slice(0, -".jsonl".length) : sessionFilename;
  if (sessionStem !== officialSessionId && !sessionStem.endsWith(`_${officialSessionId}`)) {
    throw new McpContractError("omp_fact_bridge_mismatch", "Official session path does not identify the caller session ID.", "attest", "Refresh the exact active OMP session.");
  }

  const configuredAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  const agentDirectory = configuredAgentDirectory ? path.resolve(configuredAgentDirectory) : path.join(homedir(), ".omp", "agent");
  boundedAbsolutePath(agentDirectory, "active agent directory");
  const runtimeDirectory = path.join(agentDirectory, "herdr-delegator", "runtime", "omp-facts");
  const factPath = path.join(runtimeDirectory, `${officialSessionId}.json`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) throw new McpContractError("omp_fact_bridge_unsafe", "Current process user ownership cannot be verified.", "model-verify", "Run the MCP server in the supported OMP POSIX environment.");
  const [directoryStat, factStat] = await Promise.all([lstat(runtimeDirectory), lstat(factPath)]);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o700 || directoryStat.uid !== uid) {
    throw new McpContractError("omp_fact_bridge_unsafe", "OMP fact runtime directory is not an owned mode-0700 real directory.", "model-verify", "Let the OMP extension recreate the private runtime directory.");
  }
  if (!factStat.isFile() || factStat.isSymbolicLink() || (factStat.mode & 0o777) !== 0o600 || factStat.uid !== uid || factStat.size > 64 * 1024) {
    throw new McpContractError("omp_fact_bridge_unsafe", "OMP fact file is not an owned bounded mode-0600 regular file.", "model-verify", "Let the OMP extension atomically republish this session fact.");
  }
  let facts: OmpRuntimeFacts;
  try { facts = ompRuntimeFactsSchema.parse(JSON.parse(await readFile(factPath, "utf8"))); }
  catch (error) { throw new McpContractError("omp_fact_bridge_invalid", error instanceof Error ? error.message : "OMP fact bridge failed strict parsing.", "model-verify", "Let the extension republish a strict version-1 bridge."); }
  if (path.basename(factPath, ".json") !== officialSessionId || facts.session_id !== officialSessionId || facts.pane_id !== callerPane) {
    throw new McpContractError("omp_fact_bridge_mismatch", "Fact filename, payload session, or pane does not match the official caller.", "attest", "Do not mutate; refresh the exact caller bridge.");
  }
  boundedAbsolutePath(facts.cwd, "bridge cwd");
  for (const source of facts.config_sources) boundedAbsolutePath(source.path, `config source ${source.scope}`);
  if (facts.reported_session_path !== undefined) {
    boundedAbsolutePath(facts.reported_session_path, "reported session path");
    if (facts.reported_session_path !== agentPath) throw new McpContractError("omp_fact_bridge_mismatch", "Bridge and native official session paths disagree.", "attest", "Refresh the same active session bridge.");
  }
  const issuedAt = Date.parse(facts.issued_at);
  const nonceMatch = /^(\d{13})\.[0-9a-f]{16}$/.exec(facts.nonce);
  const now = Date.now();
  if (!Number.isSafeInteger(issuedAt) || new Date(issuedAt).toISOString() !== facts.issued_at || !nonceMatch || Number(nonceMatch[1]) !== issuedAt || issuedAt > now + 5_000 || now - issuedAt > BOOTSTRAP_METADATA_TTL_MS) {
    throw new McpContractError("omp_fact_bridge_stale", "OMP fact timestamp or nonce is stale, skewed, or inconsistent.", "model-verify", "Refresh facts from the current before_agent_start boundary.");
  }
  if (
    tokens[BOOTSTRAP_TOKENS.provider] !== facts.current.provider ||
    tokens[BOOTSTRAP_TOKENS.model] !== facts.current.model ||
    tokens[BOOTSTRAP_TOKENS.thinking] !== facts.current.thinking ||
    tokens[BOOTSTRAP_TOKENS.attestation] !== facts.nonce
  ) {
    throw new McpContractError("omp_fact_bridge_mismatch", "Pane bootstrap metadata and bridge payload disagree.", "attest", "Do not mutate until metadata and fact publication converge.");
  }
  const models = {
    current: () => ({ provider: facts.current.provider, id: facts.current.model }),
    resolve: (role: string) => { const model = facts.roles[role]; return model ? { provider: model.provider, id: model.model } : undefined; },
  };
  return { facts, ctx: { models } as unknown as ExtensionContext, thinking: facts.current.thinking };
}

function normalizeLegacyPhase(phase: string): ErrorPhase {
  if (phase.includes("model")) return "model-verify";
  if (phase.includes("bootstrap") || phase.includes("attest")) return "attest";
  if (phase.includes("prompt")) return "prompt";
  if (phase.includes("wait") || phase.includes("inspect")) return "wait";
  if (phase.includes("respond") || phase.includes("block")) return "respond";
  if (phase.includes("session") || phase.includes("resume")) return "resume";
  if (phase.includes("close")) return "close";
  if (phase.includes("registry") || phase.includes("storage") || phase.includes("run")) return "storage";
  return "validate";
}

function resultError(tool: ToolName, action: string, run: RunRef, error: unknown): McpResult {
  if (error instanceof McpContractError) return { ok: false, tool, action, run, effect: error.ambiguousEffect ? "ambiguous" : "none", retryable: error.retryable, error: { code: error.code, phase: error.phase, message: error.message, recovery: error.recovery, ambiguous_effect: error.ambiguousEffect } };
  if (error instanceof LegacyContractError) return { ok: false, tool, action, run, effect: error.ambiguousEffect ? "ambiguous" : "none", retryable: error.retryable, error: { code: error.code, phase: normalizeLegacyPhase(error.phase), message: error.message, recovery: error.recovery, ambiguous_effect: error.ambiguousEffect } };
  return { ok: false, tool, action, run, effect: "none", retryable: false, error: { code: "internal_error", phase: "validate", message: error instanceof Error ? error.message : String(error), recovery: "Inspect stderr and canonical registries; do not repeat a mutation blindly.", ambiguous_effect: false } };
}

async function updateLaneFromWorker(store: DelegationStore, workerId: string, result: Pick<WorkerResult, "state" | "worker">): Promise<DelegationRegistry> {
  return store.mutate(DEFAULT_TIMEOUT_MS, (registry) => {
    const lane = registry.lanes[workerId];
    if (!lane) throw new McpContractError("worker_identity_conflict", "Lifecycle result has no responsibility lane.", "select", "Preserve both registries and reconcile identity.");
    lane.state = laneState(result.state);
    lane.state_change_seq = numberField(result.worker, ["state_change_seq"]) ?? lane.state_change_seq;
    lane.official_session_id = stringField(result.worker, ["verified_session_id"]) ?? lane.official_session_id;
    lane.official_session_path = stringField(result.worker, ["agent_session_path"]) ?? lane.official_session_path;
    lane.expected_provider = stringField(result.worker, ["expected_provider"]) ?? lane.expected_provider;
    lane.expected_model = stringField(result.worker, ["expected_model"]) ?? lane.expected_model;
    const thinking = stringField(result.worker, ["effective_thinking"]); if (thinking) lane.effective_thinking = thinking as WorkerLaneRecord["effective_thinking"];
    lane.updated_at = nowIso();
  });
}

async function settleIfReported(store: DelegationStore, registry: DelegationRegistry, lane: WorkerLaneRecord, assignment: AssignmentRecord): Promise<DelegationRegistry> {
  if (lane.state !== "idle" && lane.state !== "failed") return registry;
  let report: Buffer;
  try { report = await readFile(path.join(store.runPath, "a2a", `${lane.worker_id}-report.md`)); }
  catch { return registry; }
  const completion = new RegExp(`^\\[Assignment Completion: ${assignment.assignment_id}\\]$([\\s\\S]*?)(?=^\\[[^\\n]+\\]$|(?![\\s\\S]))`, "m").exec(report.toString("utf8"));
  const statuses = completion?.[1].match(/^status: (completed|failed)$/gm) ?? [];
  if (!completion || statuses.length !== 1 || !lane.official_session_id || !Number.isSafeInteger(lane.state_change_seq)) return registry;
  const terminal = statuses[0] === "status: failed" ? "failed" as const : "completed" as const;
  return store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
    const currentLane = next.lanes[lane.worker_id];
    const current = next.assignments[assignment.assignment_id];
    current.state = terminal;
    current.report_sha256 = sha256(report);
    current.completed_at = nowIso();
    current.updated_at = current.completed_at;
    currentLane.last_completed_assignment_id = assignment.assignment_id;
    delete currentLane.active_assignment_id;
    currentLane.state = "idle";
    currentLane.updated_at = current.completed_at;
    const following = currentLane.queued_assignment_ids.shift();
    if (following) currentLane.active_assignment_id = following;
  });
}


async function reportTerminalObservation(
  adapter: HerdrAdapter,
  registry: DelegationRegistry,
  assignmentId: string,
  previousState: string,
  paneId: string | undefined,
): Promise<void> {
  const assignment = registry.assignments[assignmentId];
  if (assignment.state === previousState || (assignment.state !== "completed" && assignment.state !== "failed")) return;
  if (!paneId) throw new McpContractError("worker_identity_conflict", "Settled assignment has no canonical pane for terminal observation.", "settlement", "Inspect the worker pane before retrying settlement observation.");
  await adapter.reportObservation(paneId, assignment.responsibility_key, assignmentId, assignment.state, registry.revision, 10_000);
}
function assertLiveWorkerSession(
  lane: WorkerLaneRecord,
  observation: WorkerResult,
  expectedSessionId: string,
  phase: "resume" | "close",
): number {
  const liveSessionId = stringField(observation.worker, ["verified_session_id"]);
  const liveSessionPath = stringField(observation.worker, ["agent_session_path"]);
  const liveSequence = numberField(observation.worker, ["state_change_seq"]);
  if (
    !lane.official_session_id ||
    lane.official_session_id !== expectedSessionId ||
    liveSessionId !== expectedSessionId ||
    !liveSessionPath ||
    (lane.official_session_path !== undefined && lane.official_session_path !== liveSessionPath) ||
    liveSequence === undefined
  ) {
    throw new McpContractError("worker_identity_conflict", "Registry and fresh live observation do not prove the exact expected worker session.", phase, "Preserve the worker and reconcile its official session before mutation.");
  }
  const filename = path.basename(liveSessionPath);
  const stem = filename.endsWith(".jsonl") ? filename.slice(0, -".jsonl".length) : filename;
  if (stem !== expectedSessionId && !stem.endsWith(`_${expectedSessionId}`)) {
    throw new McpContractError("worker_identity_conflict", "Live official session path does not identify the expected session ID.", phase, "Do not resume or close this worker.");
  }
  return liveSequence;
}
export class CompositeTools {
  constructor(private readonly adapter: HerdrAdapter) {}

  async track(input: HerdrTrackInput): Promise<McpResult> {
    const run = runRef(input);
    try {
      if (input.action === "init") {
        await loadFacts(this.adapter);
        const result = await initializeRun({ operation: "init_run", track_id: input.track_id, run_id: input.run_id, cwd: input.cwd, reset_of: input.reset_of });
        return { ok: true, tool: "herdr_track", action: input.action, run, effect: "confirmed", retryable: false, data: result };
      }
      const store = await DelegationStore.resolve(input.track_id, input.run_id);
      if (input.action === "inspect") {
        const registry = await store.read();
        let orchestrator: unknown;
        try { const runtime = await loadFacts(this.adapter); orchestrator = await inspectOrchestrator({ operation: "inspect_orch", track_id: input.track_id, run_id: input.run_id }, runtime.ctx); } catch (error) { orchestrator = { unavailable: error instanceof Error ? error.message : String(error) }; }
        return { ok: true, tool: "herdr_track", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, data: { registry, orchestrator } };
      }
      const runtime = await loadFacts(this.adapter);
      if (input.action === "start_orchestrator") {
        const result = await startOrchestrator({ operation: "start_orch", track_id: input.track_id, run_id: input.run_id }, runtime.ctx, runtime.thinking);
        return { ok: true, tool: "herdr_track", action: input.action, run, effect: "confirmed", retryable: false, data: result };
      }
      const registry = await store.read();
      if (registry.revision !== input.expected_registry_revision) throw new McpContractError("stale_registry_revision", "Track close registry revision is stale.", "close", "Inspect the track and retry only from its fresh revision.", false, true);
      const unsafe = Object.values(registry.lanes).filter((lane) => lane.state !== "idle" && lane.state !== "closed" && lane.state !== "failed");
      if (unsafe.length) throw new McpContractError("track_not_settled", "At least one responsibility lane is active or blocked.", "close", "Settle every lane before track closure.");
      const closeCandidates: { lane: WorkerLaneRecord; liveSequence: number }[] = [];
      for (const lane of Object.values(registry.lanes)) if (lane.state === "idle") {
        if (!lane.official_session_id) throw new McpContractError("worker_identity_conflict", "Close requires a verified official session.", "close", "Inspect and verify the lane before closure.");
        const live = await inspectWorker({ operation: "inspect_worker", track_id: input.track_id, run_id: input.run_id, worker_id: lane.worker_id });
        closeCandidates.push({ lane, liveSequence: assertLiveWorkerSession(lane, live, lane.official_session_id, "close") });
      }
      for (const candidate of closeCandidates) {
        await closeWorker({ operation: "close_worker", track_id: input.track_id, run_id: input.run_id, worker_id: candidate.lane.worker_id, expected_state_change_seq: candidate.liveSequence });
      }
      const closed = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => { for (const lane of Object.values(next.lanes)) if (lane.state !== "failed") lane.state = "closed"; });
      return { ok: true, tool: "herdr_track", action: input.action, run, effect: "confirmed", retryable: false, registry_revision: closed.revision, data: { closed_workers: Object.keys(closed.lanes) } };
    } catch (error) { return resultError("herdr_track", input.action, run, error); }
  }

  async assignment(input: HerdrAssignmentInput): Promise<McpResult> {
    const run = runRef(input);
    try {
      const store = await DelegationStore.resolve(input.track_id, input.run_id);
      if (input.action === "add") {
        const runtime = await loadFacts(this.adapter);
        const selected = await store.select(input.assignment_id, input.responsibility_key, input.instructions_sha256, input.separation, timeout(input));
        if (selected.duplicate) return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, registry_revision: selected.revision, worker: selected.lane, assignment: { assignment_id: input.assignment_id, state: selected.assignment.state } };
        if (selected.queued) return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "confirmed", retryable: false, registry_revision: selected.revision, worker: selected.lane, assignment: { assignment_id: input.assignment_id, state: "queued" } };
        let ensured: WorkerResult;
        try {
          ensured = await ensureWorker({ operation: "ensure_worker", track_id: input.track_id, run_id: input.run_id, worker_id: selected.lane.worker_id, profile: selected.artifact.assignment.profile, timeout_ms: timeout(input) }, runtime.ctx, runtime.thinking);
        } catch (error) {
          const cleaned = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
            const assignment = next.assignments[input.assignment_id];
            const lane = next.lanes[selected.lane.worker_id];
            assignment.state = "failed";
            assignment.updated_at = nowIso();
            if (lane.active_assignment_id === input.assignment_id) delete lane.active_assignment_id;
            lane.queued_assignment_ids = lane.queued_assignment_ids.filter((id) => id !== input.assignment_id);
            lane.state = selected.lane.state;
            lane.updated_at = assignment.updated_at;
            const following = lane.queued_assignment_ids.shift();
            if (following) lane.active_assignment_id = following;
          });
          return {
            ...resultError("herdr_assignment", input.action, run, error),
            effect: "none",
            registry_revision: cleaned.revision,
            worker: cleaned.lanes[selected.lane.worker_id],
            assignment: { assignment_id: input.assignment_id, state: "failed" },
          };
        }
        let registry = await updateLaneFromWorker(store, selected.lane.worker_id, ensured);
        const lane = registry.lanes[selected.lane.worker_id];
        const agentName = stringField(ensured.worker, ["agent_name"]);
        const paneId = stringField(ensured.worker, ["root_pane_id"]);
        if (!agentName || !paneId) throw new McpContractError("worker_identity_conflict", "Ensured worker lacks canonical agent or pane coordinates.", "attest", "Inspect the lifecycle registry before prompting.");
        registry = await store.mutate(timeout(input), (next) => {
          next.assignments[input.assignment_id].state = "prompting";
          next.assignments[input.assignment_id].updated_at = nowIso();
          next.lanes[lane.worker_id].state = "working";
        });
        const pointer = `Assignment ${input.assignment_id}; responsibility ${input.responsibility_key}; instructions ${selected.artifact.path} sha256=${input.instructions_sha256}. Append [Assignment Completion: ${input.assignment_id}] to ${path.join(store.runPath, "a2a", `${lane.worker_id}-report.md`)} and remain idle.`;
        try { await this.adapter.prompt(agentName, pointer, input.wait?.until ?? ["idle", "done", "blocked"], timeout(input)); }
        catch (error) {
          if (error instanceof McpContractError && error.ambiguousEffect) await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
            const assignment = next.assignments[input.assignment_id];
            assignment.state = "ambiguous";
            assignment.ambiguous_operation = "prompt";
            assignment.updated_at = nowIso();
          });
          throw error;
        }
        const verified = await verifyPromptedWorker({ track_id: input.track_id, run_id: input.run_id, worker_id: lane.worker_id, timeout_ms: timeout(input) });
        registry = await updateLaneFromWorker(store, lane.worker_id, verified);
        const observedState = laneState(verified.state);
        const seq = numberField(verified.worker, ["state_change_seq"]) ?? lane.state_change_seq;
        registry = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
          next.lanes[lane.worker_id].state = observedState;
          next.lanes[lane.worker_id].state_change_seq = seq;
          next.assignments[input.assignment_id].state = observedState === "blocked" ? "blocked" : "working";
          next.assignments[input.assignment_id].updated_at = nowIso();
        });
        await this.adapter.reportObservation(paneId, input.responsibility_key, input.assignment_id, registry.assignments[input.assignment_id].state, registry.revision, 10_000);
        const beforeSettlement = registry.assignments[input.assignment_id].state;
        registry = await settleIfReported(store, registry, registry.lanes[lane.worker_id], registry.assignments[input.assignment_id]);
        await reportTerminalObservation(this.adapter, registry, input.assignment_id, beforeSettlement, paneId);
        return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "confirmed", retryable: false, registry_revision: registry.revision, worker: registry.lanes[lane.worker_id], assignment: { assignment_id: input.assignment_id, state: registry.assignments[input.assignment_id].state } };
      }

      let registry = await store.read();
      const assignment = registry.assignments[input.assignment_id];
      if (!assignment) throw new McpContractError("assignment_artifact_missing", "Assignment is not registered to a lane.", "select", "Add the canonical assignment first.");
      if (assignment.state === "queued") return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, worker: registry.lanes[assignment.worker_id], assignment: { assignment_id: assignment.assignment_id, state: "queued" } };
      if (assignment.state === "completed" || assignment.state === "failed") return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, assignment: { assignment_id: assignment.assignment_id, state: assignment.state } };
      const lane = registry.lanes[assignment.worker_id];
      if (!lane) throw new McpContractError("worker_identity_conflict", "Assignment lane is absent.", "select", "Reconcile the responsibility registry.");
      const inspected = await inspectWorker({ operation: "inspect_worker", track_id: input.track_id, run_id: input.run_id, worker_id: lane.worker_id, ...(input.action === "wait" ? { timeout_ms: timeout(input) } : {}) });
      registry = await updateLaneFromWorker(store, lane.worker_id, inspected);
      if (input.action === "wait") {
        const agentName = stringField(inspected.worker, ["agent_name"]);
        if (!agentName) throw new McpContractError("worker_identity_conflict", "Assignment lane has no canonical agent name.", "wait", "Reconcile lifecycle identity before waiting.");
        await this.adapter.wait(agentName, input.wait?.until ?? ["idle", "done", "blocked"], timeout(input));
      } else {
        await loadFacts(this.adapter);
        const currentLane = registry.lanes[lane.worker_id];
        if (currentLane.state !== "blocked") throw new McpContractError("agent_blocked", "Worker is not freshly proved blocked.", "respond", "Inspect and respond only at the latest blocked sequence.", false, true);
        if (currentLane.state_change_seq !== input.expected_state_change_seq) throw new McpContractError("stale_state_change_seq", "Blocked response sequence is stale.", "respond", "Inspect and use the exact latest sequence.", false, true);
        try {
          await resolveBlock({ operation: "resolve_block", track_id: input.track_id, run_id: input.run_id, worker_id: lane.worker_id, expected_state_change_seq: input.expected_state_change_seq, response: input.response });
        } catch (error) {
          if (error instanceof LegacyContractError && error.ambiguousEffect) await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
            const current = next.assignments[input.assignment_id];
            current.state = "ambiguous";
            current.ambiguous_operation = "respond";
            current.ambiguous_state_change_seq = input.expected_state_change_seq;
            current.updated_at = nowIso();
          });
          throw error;
        }
      }
      const finalInspect = await inspectWorker({ operation: "inspect_worker", track_id: input.track_id, run_id: input.run_id, worker_id: lane.worker_id });
      registry = await updateLaneFromWorker(store, lane.worker_id, finalInspect);
      registry = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
        const state = next.lanes[lane.worker_id].state;
        next.assignments[input.assignment_id].state = state === "blocked" ? "blocked" : "working";
        next.assignments[input.assignment_id].updated_at = nowIso();
      });
      const beforeSettlement = registry.assignments[input.assignment_id].state;
      registry = await settleIfReported(store, registry, registry.lanes[lane.worker_id], registry.assignments[input.assignment_id]);
      await reportTerminalObservation(this.adapter, registry, input.assignment_id, beforeSettlement, stringField(finalInspect.worker, ["root_pane_id"]));
      return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: input.action === "respond" ? "confirmed" : "none", retryable: false, registry_revision: registry.revision, worker: registry.lanes[lane.worker_id], assignment: { assignment_id: input.assignment_id, state: registry.assignments[input.assignment_id].state } };
    } catch (error) { return resultError("herdr_assignment", input.action, run, error); }
  }

  async worker(input: HerdrWorkerInput): Promise<McpResult> {
    const run = runRef(input);
    try {
      const store = await DelegationStore.resolve(input.track_id, input.run_id); let registry = await store.read();
      if (input.action === "list") { const lanes = Object.values(registry.lanes).filter((lane) => !input.responsibility_key || lane.responsibility_key === input.responsibility_key); return { ok: true, tool: "herdr_worker", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, data: { lanes } }; }
      const lane = registry.lanes[input.worker_id]; if (!lane) throw new McpContractError("worker_identity_conflict", "Worker is not registry-owned.", "select", "Use list and inspect the canonical registry.");
      if (input.action === "inspect") {
        const result = await inspectWorker({ operation: "inspect_worker", track_id: input.track_id, run_id: input.run_id, worker_id: input.worker_id, output_lines: input.output_lines }); registry = await updateLaneFromWorker(store, input.worker_id, result);
        return { ok: true, tool: "herdr_worker", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, worker: registry.lanes[input.worker_id], data: result };
      }
      const runtime = await loadFacts(this.adapter);
      const live = await inspectWorker({ operation: "inspect_worker", track_id: input.track_id, run_id: input.run_id, worker_id: input.worker_id });
      const liveSequence = assertLiveWorkerSession(lane, live, input.expected_session_id, input.action);
      registry = await updateLaneFromWorker(store, input.worker_id, live);
      const currentLane = registry.lanes[input.worker_id];
      if (input.action === "resume") {
        const assignmentId = currentLane.active_assignment_id ?? currentLane.last_completed_assignment_id;
        if (!assignmentId) throw new McpContractError("resume_not_eligible", "Lane has no assignment from which to recover its pinned profile.", "resume", "Reconcile the lane assignment history before resume.");
        const assignment = registry.assignments[assignmentId];
        if (!assignment) throw new McpContractError("resume_not_eligible", "Lane assignment is absent from the minimal registry.", "resume", "Reconcile assignment routing before resume.");
        const artifact = await store.assignmentFile(assignmentId, assignment.responsibility_key, assignment.instructions_sha256);
        try {
          const result = await ensureWorker({ operation: "ensure_worker", track_id: input.track_id, run_id: input.run_id, worker_id: input.worker_id, profile: artifact.assignment.profile }, runtime.ctx, runtime.thinking);
          registry = await updateLaneFromWorker(store, input.worker_id, result);
          return { ok: true, tool: "herdr_worker", action: input.action, run, effect: "confirmed", retryable: false, registry_revision: registry.revision, worker: registry.lanes[input.worker_id], data: result };
        } catch (error) {
          if (currentLane.active_assignment_id && error instanceof LegacyContractError && error.ambiguousEffect) await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
            const current = next.assignments[assignmentId];
            current.state = "ambiguous";
            current.ambiguous_operation = "resume";
            current.ambiguous_state_change_seq = liveSequence;
            current.updated_at = nowIso();
          });
          throw error;
        }
      }
      if (liveSequence !== input.expected_state_change_seq) throw new McpContractError("stale_state_change_seq", "Worker close sequence is stale.", "close", "Freshly inspect before close.", false, true);
      const result = await closeWorker({ operation: "close_worker", track_id: input.track_id, run_id: input.run_id, worker_id: input.worker_id, expected_state_change_seq: liveSequence });
      registry = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => { next.lanes[input.worker_id].state = "closed"; });
      return { ok: true, tool: "herdr_worker", action: input.action, run, effect: "confirmed", retryable: false, registry_revision: registry.revision, worker: registry.lanes[input.worker_id], data: result };
    } catch (error) { return resultError("herdr_worker", input.action, run, error); }
  }
}
