import { createReadStream } from "node:fs";
import { isUtf8 } from "node:buffer";
import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { initializeRun, inspectOrchestrator, startOrchestrator } from "../io.github.edgar-min.herdr-delegator/extensions/lib/track";
import { resolveSkillRoutes } from "../io.github.edgar-min.herdr-delegator/extensions/lib/config";
import type { SkillRoute, SkillRouteBoundary, SkillRouteSurface } from "../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";
import { closeWorker, ensureWorker, inspectWorker, resolveBlock, verifyPromptedWorker } from "../io.github.edgar-min.herdr-delegator/extensions/lib/worker";
import { ContractError as LegacyContractError, type ThinkingLevel, type WorkerResult } from "../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";
import { BOOTSTRAP_METADATA_TTL_MS, BOOTSTRAP_TOKEN_PREFIX, BOOTSTRAP_TOKENS } from "../io.github.edgar-min.herdr-delegator/extensions/lib/bridge";
import { HerdrAdapter } from "./herdr-adapter";
import { DelegationStore } from "./registry";
import { BOUNDED_TOKEN_RE, DEFAULT_TIMEOUT_MS, MAX_EFFECTIVE_WAIT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, McpContractError, nowIso, ompRuntimeFactsSchema, sha256, type AdvisoryUnownedChanges, type AssignmentRecord, type AssignmentSettlementObservation, type AssignmentState, type DelegationRegistry, type ErrorPhase, type FrictionRecord, type HerdrAssignmentInput, type HerdrFrictionInput, type HerdrMessageInput, type HerdrTrackInput, type HerdrWorkerInput, type LaneState, type McpResult, type MessageDelivery, type OmpRuntimeFacts, type OrchBirthRecord, type RunRef, type TokenUsageObservation, type ToolName, type TrackTotals, type WorkerLaneRecord, type WorkerStalenessObservation } from "./contracts";


// ---------------------------------------------------------------------------
// Birth-based ORCH identity (identity/comms redesign, decision 1-2). The
// latest birth record in a2a/delegation.json is the sole command identity for
// a run: guarded run-command ops accept only the latest-generation birth
// session and reject zombies (stale generations) and strangers. Until the
// atomic `open` op exists, a run with no birth is claimed by the first
// attested guarded command (origin "claim"); `start_orchestrator` records the
// spawned ORCH as a new generation (origin "spawn").
// ---------------------------------------------------------------------------

function latestBirth(registry: DelegationRegistry): OrchBirthRecord | undefined {
  const births = registry.orch_births;
  return births && births.length ? births[births.length - 1] : undefined;
}

function orchIdentityError(births: readonly OrchBirthRecord[], sessionId: string): McpContractError {
  const latest = births[births.length - 1];
  if (births.some((birth) => birth.official_session_id === sessionId)) {
    return new McpContractError("stale_orch_generation", `Caller session belongs to a retired ORCH generation; generation ${latest.generation} commands this run.`, "attest", "Stop commanding this run: a newer ORCH was born. Converse with the current ORCH pane instead.");
  }
  return new McpContractError("orch_identity_mismatch", `Caller session is not this run's ORCH (generation ${latest.generation}).`, "attest", "Only the run's born ORCH session may command it. Coordinate via herdr_message notify_run or the run documents.");
}

/** Singularity gate for guarded run-command ops; claims birth on first command. */
export async function assertOrchCommand(store: DelegationStore, facts: OmpRuntimeFacts): Promise<void> {
  const registry = await store.read();
  const births = registry.orch_births ?? [];
  const latest = births[births.length - 1];
  if (latest) {
    if (latest.official_session_id !== facts.session_id) throw orchIdentityError(births, facts.session_id);
    return;
  }
  await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
    const current = next.orch_births ?? [];
    const head = current[current.length - 1];
    if (head) {
      if (head.official_session_id !== facts.session_id) throw orchIdentityError(current, facts.session_id);
      return;
    }
    next.orch_births = [...current, {
      generation: current.length + 1,
      official_session_id: facts.session_id,
      ...(facts.reported_session_path ? { official_session_path: facts.reported_session_path } : {}),
      pane_id: facts.pane_id,
      origin: "claim",
      born_at: nowIso(),
    }];
  });
}

async function appendMessageLog(runPath: string, entry: Record<string, unknown>): Promise<void> {
  try { await appendFile(path.join(runPath, "a2a", "messages.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); } catch { /* observability is best-effort */ }
}

function singleLine(value: string): string { return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").trim(); }

/** Deterministic worker agent name; mirrors extensions/lib/worker.ts. */
function workerAgentName(runPath: string, workerId: string): string {
  return `herdr-${workerId}-${sha256(`${runPath}\0${workerId}`).slice(0, 12)}`;
}
function field(value: unknown, names: readonly string[]): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) { for (const child of value) { const found = field(child, names); if (found !== undefined) return found; } return undefined; }
  for (const name of names) if (name in value) return (value as Record<string, unknown>)[name];
  for (const child of Object.values(value)) { const found = field(child, names); if (found !== undefined) return found; }
  return undefined;
}
function stringField(value: unknown, names: readonly string[]): string | undefined { const found = field(value, names); return typeof found === "string" ? found : undefined; }
function numberField(value: unknown, names: readonly string[]): number | undefined { const found = field(value, names); return typeof found === "number" && Number.isFinite(found) ? found : undefined; }
// The public schema still accepts up to MAX_TIMEOUT_MS, but a single server-side
// call is clamped under the 30s MCP client transport bound; a longer logical wait
// is composed by repeating bounded `wait` calls.
function timeout(value: { wait?: { timeout_ms?: number } }): number { const candidate = value.wait?.timeout_ms ?? DEFAULT_TIMEOUT_MS; return Math.min(MAX_EFFECTIVE_WAIT_MS, Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, candidate))); }
function runRef(input: { track_id: string; run_id: string }): RunRef { return { track_id: input.track_id, run_id: input.run_id }; }
function laneState(raw: string | undefined): LaneState { if (raw === "blocked") return "blocked"; if (raw === "working" || raw === "prompted") return "working"; if (raw === "closed") return "closed"; if (raw === "failed") return "failed"; if (raw === "resume-needed") return "resume-needed"; return "idle"; }

const ASSIGNMENT_STATE_ORDER: readonly AssignmentState[] = ["queued", "prompting", "working", "blocked", "completed", "failed", "ambiguous"];
const ACTIVE_SETTLEMENT_STATES: Partial<Record<AssignmentState, true>> = { prompting: true, working: true, blocked: true, ambiguous: true };
const TOKEN_FIELDS = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cache_read_tokens"],
  ["cacheWrite", "cache_write_tokens"],
  ["reasoningTokens", "reasoning_tokens"],
  ["totalTokens", "total_tokens"],
] as const;
const MAX_ADVISORY_PATHS = 64;
const MAX_ADVISORY_PATH_BYTES = 1_024;
const MAX_GIT_OUTPUT_BYTES = 128 * 1024;
const GIT_AUDIT_TIMEOUT_MS = 2_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Advisory route lookup for one delivery point. The advisory channel must
 * never block control flow, so a failed lookup degrades to an empty route
 * set; the underlying configuration error still fails closed on every
 * mutating action that loads configuration as authority.
 */
async function advisorySkillRoutes(
  runPath: string,
  cwd: string,
  boundaries: readonly SkillRouteBoundary[],
  surface: SkillRouteSurface,
): Promise<SkillRoute[]> {
  try {
    return await resolveSkillRoutes(runPath, cwd, boundaries, surface);
  } catch {
    return [];
  }
}


export const SKILL_ROUTES_NOTE = "Before proceeding, read each routed skill that is installed (resolve the name via skill://<name> or the runtime's skill catalog) and apply it at its boundary. A missing skill is a no-op. Routes are advisory and never change scope, ownership, settlement, or completion grammar.";

// Lockstep advisory fields for every result that carries routes.
function skillRouteFields(routes: SkillRoute[]): { skill_routes?: SkillRoute[]; skill_routes_note?: string } {
  return routes.length ? { skill_routes: routes, skill_routes_note: SKILL_ROUTES_NOTE } : {};
}

function skillRoutePointer(routes: SkillRoute[]): string {
  if (!routes.length) return "";
  const grouped = routes.map((route) => `${route.boundary}: ${route.skills.join(", ")}`).join("; ");
  return ` Advisory skill routes — ${grouped}. ${SKILL_ROUTES_NOTE}`;
}

async function observeTokenUsage(lane: WorkerLaneRecord, observedAt: string): Promise<TokenUsageObservation | undefined> {
  if (!lane.official_session_id || !lane.official_session_path) return undefined;
  try {
    const file = await lstat(lane.official_session_path);
    if (!file.isFile() || file.isSymbolicLink()) return undefined;
    const sums: Partial<Record<(typeof TOKEN_FIELDS)[number][1], number>> = {};
    let sawUsage = false;
    const lines = createInterface({ input: createReadStream(lane.official_session_path), crlfDelay: Infinity });
    for await (const line of lines) {
      if (Buffer.byteLength(line) > 1024 * 1024) return undefined;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!isObject(parsed) || !isObject(parsed.message) || parsed.message.role !== "assistant" || !isObject(parsed.message.usage)) continue;
      for (const [source, target] of TOKEN_FIELDS) {
        const value = parsed.message.usage[source];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue;
        const next = (sums[target] ?? 0) + value;
        if (!Number.isSafeInteger(next)) return undefined;
        sums[target] = next;
        sawUsage = true;
      }
    }
    return sawUsage ? { source: "omp-jsonl", session_id: lane.official_session_id, observed_at: observedAt, ...sums } : undefined;
  } catch {
    return undefined;
  }
}

async function declaredActiveOwnership(store: DelegationStore, registry: DelegationRegistry): Promise<string[] | undefined> {
  const owned: string[] = [];
  try {
    for (const assignment of Object.values(registry.assignments)) {
      if (!ACTIVE_SETTLEMENT_STATES[assignment.state]) continue;
      const artifact = await store.assignmentFile(assignment.assignment_id, assignment.responsibility_key, assignment.instructions_sha256);
      for (const declaration of artifact.assignment.write_ownership) {
        if (declaration.includes("\0") || Buffer.byteLength(declaration) > 4_096) return undefined;
        owned.push(path.resolve(store.cwd, declaration));
      }
    }
    return owned;
  } catch {
    return undefined;
  }
}

async function observeAdvisoryUnownedChanges(store: DelegationStore, registry: DelegationRegistry): Promise<AdvisoryUnownedChanges | undefined> {
  const ownership = await declaredActiveOwnership(store, registry);
  if (!ownership) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GIT_AUDIT_TIMEOUT_MS);
  try {
    const process = Bun.spawn(["git", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
      cwd: store.cwd,
      env: { ...globalThis.process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const [stdout, exitCode] = await Promise.all([new Response(process.stdout).arrayBuffer(), process.exited]);
    if (exitCode !== 0 || stdout.byteLength > MAX_GIT_OUTPUT_BYTES) return undefined;
    const bytes = Buffer.from(stdout);
    if (!isUtf8(bytes)) return undefined;
    const entries = bytes.toString("utf8").split("\0");
    if (entries.at(-1) !== "") return undefined;
    entries.pop();
    const modified: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.length < 4 || entry[2] !== " ") return undefined;
      const candidates = [entry.slice(3)];
      if (entry[0] === "R" || entry[1] === "R" || entry[0] === "C" || entry[1] === "C") {
        const original = entries[index + 1];
        if (!original) return undefined;
        candidates.push(original);
        index += 1;
      }
      for (const candidate of candidates) {
        if (!candidate || candidate.includes("\0") || path.isAbsolute(candidate) || Buffer.byteLength(candidate) > 4_096) return undefined;
        const absolute = path.resolve(store.cwd, candidate);
        const relative = path.relative(store.cwd, absolute);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
        const covered = ownership.some((owned) => absolute === owned || absolute.startsWith(`${owned}${path.sep}`));
        if (!covered && !modified.includes(relative)) modified.push(relative);
      }
    }
    modified.sort();
    const boundedPaths: string[] = [];
    let truncated = false;
    for (const modifiedPath of modified) {
      if (boundedPaths.length === MAX_ADVISORY_PATHS || Buffer.byteLength(modifiedPath) > MAX_ADVISORY_PATH_BYTES) {
        truncated = true;
        continue;
      }
      boundedPaths.push(modifiedPath);
    }
    return { advisory: true, paths: boundedPaths, truncated };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function settlementObservation(assignment: AssignmentRecord, warning?: string): AssignmentSettlementObservation | undefined {
  if (assignment.state !== "completed" && assignment.state !== "failed") return undefined;
  const observation: AssignmentSettlementObservation = {};
  if (assignment.elapsed_ms !== undefined) observation.elapsed_ms = assignment.elapsed_ms;
  if (assignment.token_usage !== undefined) observation.token_usage = assignment.token_usage;
  if (assignment.advisory_unowned_changes !== undefined) observation.advisory_unowned_changes = assignment.advisory_unowned_changes;
  if (warning !== undefined) observation.observation_warning = warning.length <= 300 ? warning : `${warning.slice(0, 297)}...`;
  return observation;
}

function trackTotals(registry: DelegationRegistry): TrackTotals {
  const assignmentsByState = Object.fromEntries(ASSIGNMENT_STATE_ORDER.map((state) => [state, 0])) as Record<AssignmentState, number>;
  const tokenTotals: TrackTotals["settled_token_usage"] = { observations: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };
  let settledElapsedMs = 0;
  let settledElapsedObservations = 0;
  let saturated = false;
  for (const assignment of Object.values(registry.assignments)) {
    assignmentsByState[assignment.state] += 1;
    if (assignment.state !== "completed" && assignment.state !== "failed") continue;
    if (assignment.elapsed_ms !== undefined) {
      const nextElapsedMs = settledElapsedMs + assignment.elapsed_ms;
      if (Number.isSafeInteger(nextElapsedMs)) settledElapsedMs = nextElapsedMs;
      else {
        settledElapsedMs = Number.MAX_SAFE_INTEGER;
        saturated = true;
      }
      settledElapsedObservations += 1;
    }
    if (assignment.token_usage) {
      tokenTotals.observations += 1;
      for (const [, fieldName] of TOKEN_FIELDS) {
        const nextTokenTotal = tokenTotals[fieldName] + (assignment.token_usage[fieldName] ?? 0);
        if (Number.isSafeInteger(nextTokenTotal)) tokenTotals[fieldName] = nextTokenTotal;
        else {
          tokenTotals[fieldName] = Number.MAX_SAFE_INTEGER;
          saturated = true;
        }
      }
    }
  }
  return {
    lane_count: Object.keys(registry.lanes).length,
    assignments_by_state: assignmentsByState,
    settled_elapsed_ms: settledElapsedMs,
    settled_elapsed_observations: settledElapsedObservations,
    settled_token_usage: tokenTotals,
    saturated,
  };
}

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
    throw new McpContractError("omp_fact_bridge_mismatch", "Caller pane has no bootstrap metadata tokens.", "attest", "Republish the bridge with /reload-plugins (or a new OMP session), then retry the identical call.", false, true);
  }
  const tokens = tokensValue as Record<string, unknown>;
  const namespacedKeys = Object.keys(tokens).filter((key) => key.startsWith(BOOTSTRAP_TOKEN_PREFIX)).sort();
  const expectedKeys = Object.values(BOOTSTRAP_TOKENS).sort();
  if (namespacedKeys.length !== expectedKeys.length || namespacedKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new McpContractError("omp_fact_bridge_mismatch", "Caller pane bootstrap token set is incomplete or contains unexpected namespaced keys.", "attest", "Republish the bridge with /reload-plugins (or a new OMP session), then retry the identical call.", false, true);
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

// ---------------------------------------------------------------------------
// Dogfooding friction log. Reports are global (agent-directory scoped), local,
// and append-only: friction must stay recordable even when the run layout or
// the OMP fact bridge is itself the broken part, so this path never touches
// loadFacts or a DelegationStore. Promotion to an external tracker is a
// deliberate human-gated triage step outside this server.
// ---------------------------------------------------------------------------

const FRICTION_LIST_DEFAULT = 50;
const FRICTION_GROUP_LIMIT = 20;
const FRICTION_HINT_THRESHOLD = 2;
const MAX_TRACKED_ERROR_CODES = 64;
const sessionErrorCounts = new Map<string, number>();

function frictionLogPath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agentDirectory = configured ? path.resolve(configured) : path.join(homedir(), ".omp", "agent");
  return path.join(agentDirectory, "herdr-delegator", "friction", "friction.jsonl");
}

/** Duplicate-grouping key: digit runs collapse so IDs and paths group together. */
function frictionFingerprint(kind: string, tool: string | undefined, errorCode: string | undefined, summary: string): string {
  const normalized = summary.toLowerCase().replace(/[0-9]+/g, "#").replace(/\s+/g, " ").trim();
  return sha256(`${kind}\0${tool ?? ""}\0${errorCode ?? ""}\0${normalized}`).slice(0, 16);
}

function isFrictionRecord(value: unknown): value is FrictionRecord {
  return isObject(value) && typeof value.at === "string" && typeof value.kind === "string" && typeof value.summary === "string" && typeof value.fingerprint === "string";
}

type FrictionScan = { total: number; malformed: number; counts: Map<string, number>; entries: FrictionRecord[] };

/** Streaming scan; keeps only the newest `keep` matching entries in memory. */
async function scanFriction(filter: { kind?: string; fingerprint?: string }, keep: number): Promise<FrictionScan> {
  const scan: FrictionScan = { total: 0, malformed: 0, counts: new Map(), entries: [] };
  try {
    for await (const line of createInterface({ input: createReadStream(frictionLogPath(), "utf8"), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let record: FrictionRecord;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isFrictionRecord(parsed)) throw new Error("unexpected record shape");
        record = parsed;
      } catch { scan.malformed += 1; continue; }
      if (filter.kind && record.kind !== filter.kind) continue;
      if (filter.fingerprint && record.fingerprint !== filter.fingerprint) continue;
      scan.total += 1;
      scan.counts.set(record.fingerprint, (scan.counts.get(record.fingerprint) ?? 0) + 1);
      if (keep > 0) { scan.entries.push(record); if (scan.entries.length > keep) scan.entries.shift(); }
    }
  } catch (error: unknown) {
    if (!(isObject(error) && error.code === "ENOENT")) throw new McpContractError("friction_log_unreadable", error instanceof Error ? error.message : "Friction log could not be read.", "storage", "Repair or remove the corrupt friction log before reporting.");
  }
  return scan;
}

/**
 * Session-local repeat-error observation: the friction nudge only fires once a
 * non-retryable code recurs — i.e. when a retry loop is evidenced — never on a
 * first failure or on contract-legal retryable staleness.
 */
function frictionHintFor(tool: ToolName, code: string, retryable: boolean): string | undefined {
  if (tool === "herdr_friction" || retryable) return undefined;
  const count = (sessionErrorCounts.get(code) ?? 0) + 1;
  if (sessionErrorCounts.has(code) || sessionErrorCounts.size < MAX_TRACKED_ERROR_CODES) sessionErrorCounts.set(code, count);
  if (count < FRICTION_HINT_THRESHOLD) return undefined;
  return `Error '${code}' has recurred ${count} times this session. If the contract itself — not this call's input — is the obstacle, record it once via herdr_friction {action:"report"} after resolving or abandoning this path; do not report every error.`;
}

function resultError(tool: ToolName, action: string, run: RunRef, error: unknown): McpResult {
  const failure = (code: string, phase: ErrorPhase, message: string, recovery: string, ambiguous: boolean, retryable: boolean): McpResult => {
    const hint = frictionHintFor(tool, code, retryable);
    return { ok: false, tool, action, run, effect: ambiguous ? "ambiguous" : "none", retryable, ...(hint ? { friction_hint: hint } : {}), error: { code, phase, message, recovery, ambiguous_effect: ambiguous } };
  };
  if (error instanceof McpContractError) return failure(error.code, error.phase, error.message, error.recovery, error.ambiguousEffect, error.retryable);
  if (error instanceof LegacyContractError) return failure(error.code, normalizeLegacyPhase(error.phase), error.message, error.recovery, error.ambiguousEffect, error.retryable);
  return failure("internal_error", "validate", error instanceof Error ? error.message : String(error), "Inspect stderr and canonical registries; do not repeat a mutation blindly.", false, false);
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

export async function settleIfReported(store: DelegationStore, registry: DelegationRegistry, lane: WorkerLaneRecord, assignment: AssignmentRecord): Promise<DelegationRegistry> {
  if (lane.state !== "idle" && lane.state !== "failed") return registry;
  let report: Buffer;
  try { report = await readFile(path.join(store.runPath, "a2a", `${lane.worker_id}-report.md`)); }
  catch { return registry; }
  const completion = new RegExp(`^\\[Assignment Completion: ${assignment.assignment_id}\\]$([\\s\\S]*?)(?=^\\[[^\\n]+\\]$|(?![\\s\\S]))`, "m").exec(report.toString("utf8"));
  const statuses = completion?.[1].match(/^status: (completed|failed)$/gm) ?? [];
  if (!completion || statuses.length !== 1 || !lane.official_session_id || !Number.isSafeInteger(lane.state_change_seq)) return registry;
  const terminal = statuses[0] === "status: failed" ? "failed" as const : "completed" as const;
  const settledAt = nowIso();
  const [tokenUsage, advisoryUnownedChanges] = await Promise.all([
    observeTokenUsage(lane, settledAt),
    observeAdvisoryUnownedChanges(store, registry),
  ]);
  const promptedAt = assignment.prompted_at === undefined ? undefined : Date.parse(assignment.prompted_at);
  const settledAtMs = Date.parse(settledAt);
  const elapsedMs = promptedAt !== undefined && Number.isSafeInteger(promptedAt) && promptedAt <= settledAtMs
    ? settledAtMs - promptedAt
    : undefined;
  return store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
    const currentLane = next.lanes[lane.worker_id];
    const current = next.assignments[assignment.assignment_id];
    current.state = terminal;
    current.report_sha256 = sha256(report);
    current.completed_at = settledAt;
    current.updated_at = settledAt;
    if (elapsedMs !== undefined && Number.isSafeInteger(elapsedMs)) current.elapsed_ms = elapsedMs;
    if (tokenUsage !== undefined) current.token_usage = tokenUsage;
    if (advisoryUnownedChanges !== undefined) current.advisory_unowned_changes = advisoryUnownedChanges;
    currentLane.last_completed_assignment_id = assignment.assignment_id;
    delete currentLane.active_assignment_id;
    currentLane.state = "idle";
    currentLane.updated_at = current.completed_at;
    const following = currentLane.queued_assignment_ids.shift();
    if (following) currentLane.active_assignment_id = following;
  });
}


/**
 * Terminal observation of an already-committed settlement. It is a display-only
 * side effect, so every failure degrades to a bounded warning: a settled
 * assignment is never re-reported as an error or as ambiguous.
 */
export async function reportTerminalObservation(
  adapter: HerdrAdapter,
  registry: DelegationRegistry,
  assignmentId: string,
  previousState: string,
  paneId: string | undefined,
): Promise<string | undefined> {
  const assignment = registry.assignments[assignmentId];
  if (assignment.state === previousState || (assignment.state !== "completed" && assignment.state !== "failed")) return undefined;
  if (!paneId) return "Settlement observation skipped: the settled assignment has no canonical worker pane.";
  try {
    const observed = await adapter.reportObservation(paneId, assignment.responsibility_key, assignmentId, assignment.state, registry.revision, 10_000);
    return observed.warning;
  } catch (error) {
    return `Settlement observation failed after the settlement committed: ${error instanceof Error ? error.message : String(error)}`;
  }
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
        // Attestation-gated, but identity-free: init records no ORCH identity
        // (friction 8a9dc4d2 — handoff init must never stamp the source
        // session as the target run's wake target).
        await loadFacts(this.adapter);
        const result = await initializeRun({ operation: "init_run", track_id: input.track_id, run_id: input.run_id, cwd: input.cwd, reset_of: input.reset_of });
        const initialized = await DelegationStore.resolve(input.track_id, input.run_id);
        const boundaries: SkillRouteBoundary[] = input.reset_of ? ["plan", "authoring", "reset"] : ["plan", "authoring"];
        const routes = await advisorySkillRoutes(initialized.runPath, initialized.cwd, boundaries, "orch");
        return { ok: true, tool: "herdr_track", action: input.action, run, effect: "confirmed", retryable: false, ...skillRouteFields(routes), data: result };
      }
      const store = await DelegationStore.resolve(input.track_id, input.run_id);
      if (input.action === "inspect") {
        const registry = await store.read();
        let orchestrator: unknown;
        try { const runtime = await loadFacts(this.adapter); orchestrator = await inspectOrchestrator({ operation: "inspect_orch", track_id: input.track_id, run_id: input.run_id }, runtime.ctx); } catch (error) { orchestrator = { unavailable: error instanceof Error ? error.message : String(error) }; }
        return { ok: true, tool: "herdr_track", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, data: { registry, orchestrator, totals: trackTotals(registry) } };
      }
      const runtime = await loadFacts(this.adapter);
      if (input.action === "start_orchestrator") {
        const result = await startOrchestrator({ operation: "start_orch", track_id: input.track_id, run_id: input.run_id }, runtime.ctx, runtime.thinking);
        const birth = await this.recordSpawnBirth(store, result.orchestrator);
        return { ok: true, tool: "herdr_track", action: input.action, run, effect: "confirmed", retryable: false, data: { ...result, ...(birth ? { orch_birth: birth } : { orch_birth_warning: "Spawned ORCH identity incomplete; birth not recorded — its first guarded command claims this run." }) } };
      }
      await assertOrchCommand(store, runtime.facts);
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

  /** Records the spawned target ORCH as the run's newest birth generation (idempotent per identity). */
  private async recordSpawnBirth(store: DelegationStore, orchestrator: unknown): Promise<OrchBirthRecord | undefined> {
    const paneId = stringField(orchestrator, ["pane_id"]);
    const sessionId = stringField(orchestrator, ["session_id"]);
    const sessionPath = stringField(orchestrator, ["session_path"]);
    if (!paneId || !sessionId || paneId.length > 80 || sessionId.length > 80 || !BOUNDED_TOKEN_RE.test(paneId) || !BOUNDED_TOKEN_RE.test(sessionId)) return undefined;
    let recorded: OrchBirthRecord | undefined;
    await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
      const births = next.orch_births ?? [];
      const latest = births[births.length - 1];
      if (latest && latest.official_session_id === sessionId && latest.pane_id === paneId) { recorded = latest; return; }
      recorded = { generation: births.length + 1, official_session_id: sessionId, ...(sessionPath && sessionPath.length <= 4096 ? { official_session_path: sessionPath } : {}), pane_id: paneId, origin: "spawn", born_at: nowIso() };
      next.orch_births = [...births, recorded];
    });
    return recorded;
  }

  /**
   * Shared assignment dispatch: prompt the lane's worker with the canonical
   * assignment pointer, verify the prompted session, and settle if a completion
   * block is already reported. Used by `add` and by FIFO promotion.
   */
  private async promptAssignment(store: DelegationStore, run: RunRef, workerId: string, assignmentId: string, agentName: string, paneId: string, until: string[], timeoutMs: number, warnings: string[]): Promise<DelegationRegistry> {
    const snapshot = await store.read();
    const record = snapshot.assignments[assignmentId];
    if (!record) throw new McpContractError("assignment_artifact_missing", "Assignment vanished from the registry before dispatch.", "select", "Inspect the minimal registry before prompting.");
    const workerProtocolPath = path.join(store.runPath, "protocol-worker.md");
    const artifactPath = path.join(store.runPath, "a2a", "assignments", `${assignmentId}.md`);
    const reportPath = path.join(store.runPath, "a2a", `${workerId}-report.md`);
    const promptedAt = nowIso();
    let registry = await store.mutate(timeoutMs, (next) => {
      next.assignments[assignmentId].state = "prompting";
      next.assignments[assignmentId].prompted_at = promptedAt;
      next.assignments[assignmentId].updated_at = promptedAt;
      next.lanes[workerId].state = "working";
    });
    const workerRoutes = await advisorySkillRoutes(store.runPath, store.cwd, ["dispatch", "completion"], "worker");
    const pointer = `Assignment ${assignmentId}; responsibility ${record.responsibility_key}; instructions ${artifactPath} sha256=${record.instructions_sha256}; worker protocol ${workerProtocolPath}. Append [Assignment Completion: ${assignmentId}] to ${reportPath} and remain idle. After appending a completion block or an [ORCH Decision Request], call herdr_message {action:"wake_orch"} once per protocol-worker.md.${skillRoutePointer(workerRoutes)}`;
    try {
      const prompted = await this.adapter.prompt(agentName, pointer, until, timeoutMs);
      if (prompted.warning) warnings.push(prompted.warning);
    } catch (error) {
      if (error instanceof McpContractError && error.ambiguousEffect) await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
        const current = next.assignments[assignmentId];
        current.state = "ambiguous";
        current.ambiguous_operation = "prompt";
        current.updated_at = nowIso();
      });
      throw error;
    }
    const verified = await verifyPromptedWorker({ track_id: run.track_id, run_id: run.run_id, worker_id: workerId, timeout_ms: timeoutMs });
    registry = await updateLaneFromWorker(store, workerId, verified);
    const observedState = laneState(verified.state);
    const seq = numberField(verified.worker, ["state_change_seq"]) ?? registry.lanes[workerId].state_change_seq;
    registry = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
      next.lanes[workerId].state = observedState;
      next.lanes[workerId].state_change_seq = seq;
      next.assignments[assignmentId].state = observedState === "blocked" ? "blocked" : "working";
      next.assignments[assignmentId].updated_at = nowIso();
    });
    const progress = await this.adapter.reportObservation(paneId, record.responsibility_key, assignmentId, registry.assignments[assignmentId].state, registry.revision, 10_000).then((observed) => observed.warning).catch((error: unknown) => `Progress observation failed: ${error instanceof Error ? error.message : String(error)}`);
    if (progress) warnings.push(progress);
    const beforeSettlement = registry.assignments[assignmentId].state;
    registry = await settleIfReported(store, registry, registry.lanes[workerId], registry.assignments[assignmentId]);
    const terminal = await reportTerminalObservation(this.adapter, registry, assignmentId, beforeSettlement, paneId);
    if (terminal) warnings.push(terminal);
    return registry;
  }

  /**
   * FIFO promotion dispatch (dogfooded defect fix): a settlement that promotes
   * a queued head must also deliver it, or the lane idles while its head stays
   * queued forever. One promoted head is dispatched per guarded call; a chain
   * of instant completions drains across subsequent calls.
   */
  private async dispatchPromotedHead(store: DelegationStore, run: RunRef, workerId: string, until: string[], timeoutMs: number, warnings: string[]): Promise<DelegationRegistry | undefined> {
    const registry = await store.read();
    const lane = registry.lanes[workerId];
    const headId = lane?.active_assignment_id;
    if (!lane || !headId || lane.state !== "idle" || registry.assignments[headId]?.state !== "queued") return undefined;
    const live = await inspectWorker({ operation: "inspect_worker", track_id: run.track_id, run_id: run.run_id, worker_id: workerId });
    const agentName = stringField(live.worker, ["agent_name"]);
    const paneId = stringField(live.worker, ["root_pane_id"]);
    if (!agentName || !paneId) {
      warnings.push(`Promoted assignment ${headId} not dispatched: lane ${workerId} lacks canonical agent or pane coordinates.`);
      return undefined;
    }
    warnings.push(`Promoted queued assignment ${headId} dispatched to ${workerId}.`);
    return this.promptAssignment(store, run, workerId, headId, agentName, paneId, until, timeoutMs, warnings);
  }

  async assignment(input: HerdrAssignmentInput): Promise<McpResult> {
    const run = runRef(input);
    try {
      const store = await DelegationStore.resolve(input.track_id, input.run_id);
      if (input.action === "preflight") {
        const registry = await store.read();
        const existing = registry.assignments[input.assignment_id];
        const routes = await advisorySkillRoutes(store.runPath, store.cwd, ["authoring"], "orch");
        if (existing) {
          return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, ...skillRouteFields(routes), assignment: { assignment_id: input.assignment_id, state: existing.state }, data: { already_registered: true, instructions_sha256: existing.instructions_sha256 } };
        }
        const artifact = await store.preflight(input.assignment_id, input.responsibility_key);
        return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, ...skillRouteFields(routes), data: { already_registered: false, path: artifact.path, instructions_sha256: artifact.instructionsHash, profile: artifact.assignment.profile, goal_bytes: Buffer.byteLength(artifact.assignment.goal), completion_conditions: artifact.assignment.completion_conditions.length, write_ownership: artifact.assignment.write_ownership.length, dependencies: artifact.assignment.dependencies.length, user_boundaries: artifact.assignment.user_boundaries.length } };
      }
      if (input.action === "add") {
        const workerProtocolPath = path.join(store.runPath, "protocol-worker.md");
        try {
          const protocolStat = await lstat(workerProtocolPath);
          if (!protocolStat.isFile() || protocolStat.isSymbolicLink() || (await realpath(workerProtocolPath)) !== workerProtocolPath) {
            throw new Error("protocol path is not canonical");
          }
        } catch {
          throw new McpContractError("invalid_run_layout", "protocol-worker.md is missing or not a canonical regular file.", "validate", "Re-initialize and reconcile the exact run before dispatching an assignment.");
        }
        const runtime = await loadFacts(this.adapter);
        await assertOrchCommand(store, runtime.facts);
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
        const warnings: string[] = [];
        const until = input.wait?.until ?? ["idle", "done", "blocked"];
        registry = await this.promptAssignment(store, run, lane.worker_id, input.assignment_id, agentName, paneId, until, timeout(input), warnings);
        registry = await this.dispatchPromotedHead(store, run, lane.worker_id, until, timeout(input), warnings) ?? registry;
        const settledAssignment = registry.assignments[input.assignment_id];
        const settlement = settlementObservation(settledAssignment, warnings.length ? warnings.join(" | ") : undefined);
        const settlementRoutes = settledAssignment.state === "completed" || settledAssignment.state === "failed" ? await advisorySkillRoutes(store.runPath, store.cwd, ["settlement"], "orch") : [];
        return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "confirmed", retryable: false, registry_revision: registry.revision, worker: registry.lanes[lane.worker_id], ...skillRouteFields(settlementRoutes), assignment: { assignment_id: input.assignment_id, state: settledAssignment.state, ...(settlement ? { settlement } : {}) } };
      }

      // wait/respond are guarded run-command ops (they respond and dispatch
      // promoted heads): only the run's born ORCH session may issue them.
      const commandFacts = await loadFacts(this.adapter);
      await assertOrchCommand(store, commandFacts.facts);
      let registry = await store.read();
      const assignment = registry.assignments[input.assignment_id];
      if (!assignment) throw new McpContractError("assignment_artifact_missing", "Assignment is not registered to a lane.", "select", "Add the canonical assignment first.");
      if (assignment.state === "queued") {
        if (input.action === "respond") throw new McpContractError("assignment_not_prompted", "Assignment is queued; its worker was never prompted, so there is no blocked request to answer.", "respond", "Wait on the assignment first: a queued head on an idle lane is dispatched by the next guarded wait or add call.", false, true);
        const queuedWarnings: string[] = [];
        const dispatched = await this.dispatchPromotedHead(store, run, assignment.worker_id, input.wait?.until ?? ["idle", "done", "blocked"], timeout(input), queuedWarnings);
        if (!dispatched) return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, worker: registry.lanes[assignment.worker_id], assignment: { assignment_id: assignment.assignment_id, state: "queued" } };
        const fresh = dispatched.assignments[input.assignment_id];
        const dispatchSettlement = settlementObservation(fresh, queuedWarnings.length ? queuedWarnings.join(" | ") : undefined);
        const dispatchRoutes = fresh.state === "completed" || fresh.state === "failed" ? await advisorySkillRoutes(store.runPath, store.cwd, ["settlement"], "orch") : [];
        return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "confirmed", retryable: false, registry_revision: dispatched.revision, worker: dispatched.lanes[assignment.worker_id], ...skillRouteFields(dispatchRoutes), assignment: { assignment_id: input.assignment_id, state: fresh.state, ...(dispatchSettlement ? { settlement: dispatchSettlement } : {}) } };
      }
      if (assignment.state === "completed" || assignment.state === "failed") {
        const settlementRoutes = await advisorySkillRoutes(store.runPath, store.cwd, ["settlement"], "orch");
        return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, ...skillRouteFields(settlementRoutes), assignment: { assignment_id: assignment.assignment_id, state: assignment.state, settlement: settlementObservation(assignment) } };
      }
      const lane = registry.lanes[assignment.worker_id];
      if (!lane) throw new McpContractError("worker_identity_conflict", "Assignment lane is absent.", "select", "Reconcile the responsibility registry.");
      const inspected = await inspectWorker({ operation: "inspect_worker", track_id: input.track_id, run_id: input.run_id, worker_id: lane.worker_id, ...(input.action === "wait" ? { timeout_ms: timeout(input) } : {}) });
      registry = await updateLaneFromWorker(store, lane.worker_id, inspected);
      const tailWarnings: string[] = [];
      let waitTimedOut = false;
      if (input.action === "wait") {
        const agentName = stringField(inspected.worker, ["agent_name"]);
        if (!agentName) throw new McpContractError("worker_identity_conflict", "Assignment lane has no canonical agent name.", "wait", "Reconcile lifecycle identity before waiting.");
        const waited = await this.adapter.wait(agentName, input.wait?.until ?? ["idle", "done", "blocked"], timeout(input));
        waitTimedOut = waited.timedOut === true;
        if (waited.warning) tailWarnings.push(waited.warning);
      } else {
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
      const terminal = await reportTerminalObservation(this.adapter, registry, input.assignment_id, beforeSettlement, stringField(finalInspect.worker, ["root_pane_id"]));
      if (terminal) tailWarnings.push(terminal);
      registry = await this.dispatchPromotedHead(store, run, lane.worker_id, input.action === "wait" ? input.wait?.until ?? ["idle", "done", "blocked"] : ["idle", "done", "blocked"], timeout(input.action === "wait" ? input : {}), tailWarnings) ?? registry;
      const settledAssignment = registry.assignments[input.assignment_id];
      const settlement = settlementObservation(settledAssignment, tailWarnings.length ? tailWarnings.join(" | ") : undefined);
      const settlementRoutes = settledAssignment.state === "completed" || settledAssignment.state === "failed" ? await advisorySkillRoutes(store.runPath, store.cwd, ["settlement"], "orch") : [];
      return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: input.action === "respond" ? "confirmed" : "none", retryable: false, ...(waitTimedOut ? { timed_out: true } : {}), registry_revision: registry.revision, worker: registry.lanes[lane.worker_id], ...skillRouteFields(settlementRoutes), assignment: { assignment_id: input.assignment_id, state: settledAssignment.state, ...(settlement ? { settlement } : {}) } };
    } catch (error) { return resultError("herdr_assignment", input.action, run, error); }
  }

  async worker(input: HerdrWorkerInput): Promise<McpResult> {
    const run = runRef(input);
    try {
      const store = await DelegationStore.resolve(input.track_id, input.run_id); let registry = await store.read();
      if (input.action === "list") { const lanes = Object.values(registry.lanes).filter((lane) => !input.responsibility_key || lane.responsibility_key === input.responsibility_key); return { ok: true, tool: "herdr_worker", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, data: { lanes } }; }
      const lane = registry.lanes[input.worker_id]; if (!lane) throw new McpContractError("worker_identity_conflict", "Worker is not registry-owned.", "select", "Use list and inspect the canonical registry.");
      if (input.action === "inspect") {
        const result = await inspectWorker({ operation: "inspect_worker", track_id: input.track_id, run_id: input.run_id, worker_id: input.worker_id, output_lines: input.output_lines });
        registry = await updateLaneFromWorker(store, input.worker_id, result);
        const rawStaleness = isObject(result.observation?.staleness) ? result.observation.staleness : undefined;
        const lastActivityAt = stringField(rawStaleness, ["last_activity_at"]);
        const observedAt = stringField(rawStaleness, ["observed_at"]);
        let data: WorkerResult = result;
        if (lastActivityAt && observedAt) {
          const staleness: WorkerStalenessObservation = {
            observed_at: observedAt,
            last_activity_at: lastActivityAt,
            queue_depth: registry.lanes[input.worker_id].queued_assignment_ids.length,
          };
          data = { ...result, observation: { ...result.observation, staleness } };
        }
        return { ok: true, tool: "herdr_worker", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, worker: registry.lanes[input.worker_id], data };
      }
      const runtime = await loadFacts(this.adapter);
      await assertOrchCommand(store, runtime.facts);
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

  /**
   * Non-authoritative doorbells. Only invalid input hard-errors: delivery is a
   * soft observation (`data.delivery`) because a messaging channel that fails
   * loudly-but-retryably invites loops, while one that fails silently stalls the
   * whole flow. Every attempt is appended to the sender run's a2a/messages.jsonl.
   */
  async message(input: HerdrMessageInput): Promise<McpResult> {
    const run = runRef(input);
    try {
      const store = await DelegationStore.resolve(input.track_id, input.run_id);
      const registry = await store.read();
      const warnings: string[] = [];
      // Sender identity is advisory routing/logging context, never a gate: with a
      // degraded bridge the message still flows, honestly marked unverified.
      let senderSession: string | undefined;
      try { senderSession = (await loadFacts(this.adapter)).facts.session_id; }
      catch (error) { warnings.push(`Sender attestation unavailable: ${error instanceof Error ? error.message : String(error)}`); }
      const senderLane = senderSession ? Object.values(registry.lanes).find((lane) => lane.official_session_id === senderSession)?.worker_id : undefined;
      const sender = senderLane ?? (senderSession ? "orch" : "unverified");

      let target: string | undefined;
      let text = "";
      let unresolvedReason: string | undefined;
      if (input.action === "wake_orch") {
        const birth = latestBirth(registry);
        if (!birth) unresolvedReason = "Run has no ORCH birth record; birth is recorded at ORCH spawn or by its first guarded command.";
        else if (senderSession && birth.official_session_id === senderSession) unresolvedReason = "Caller is the run's ORCH; wake_orch is for workers.";
        else target = birth.pane_id;
        const laneId = registry.assignments[input.assignment_id]?.worker_id ?? senderLane;
        text = `wake: ${input.assignment_id} ${input.boundary} (run ${input.track_id}/${input.run_id}); read ${laneId ? `a2a/${laneId}-report.md` : "the lane report"} — non-authoritative signal, verify via herdr_assignment.`;
      } else if (input.action === "wake_peer") {
        if (!senderLane) unresolvedReason = "Peer wake requires a verified sender lane: the channel is named by its declared sender.";
        else if (senderLane === input.to_worker_id) unresolvedReason = "A lane cannot wake itself.";
        else if (!registry.lanes[input.to_worker_id]) unresolvedReason = `Lane ${input.to_worker_id} is not registered in this run.`;
        else {
          target = workerAgentName(store.runPath, input.to_worker_id);
          text = `wake: peer channel a2a/${senderLane}-to-${input.to_worker_id}.md updated (run ${input.track_id}/${input.run_id}) — read the channel file; wake text carries no authority.`;
        }
      } else if (input.action === "wake_worker") {
        // ORCH-to-own-worker doorbell (dogfooded contract gap): a worker that
        // posted a decision request and idled without a formal blocked state was
        // previously unreachable by its own ORCH.
        const birth = latestBirth(registry);
        if (!senderSession) unresolvedReason = "Worker wake requires an attested ORCH sender.";
        else if (senderLane) unresolvedReason = "wake_worker is ORCH-to-own-worker; a worker lane wakes peers via wake_peer.";
        else if (birth && birth.official_session_id !== senderSession) unresolvedReason = registry.orch_births?.some((prior) => prior.official_session_id === senderSession) ? `Sender is a retired ORCH generation; generation ${birth.generation} commands this run.` : `Sender is not this run's ORCH (generation ${birth.generation}).`;
        else if (!registry.lanes[input.to_worker_id]) unresolvedReason = `Lane ${input.to_worker_id} is not registered in this run.`;
        else {
          target = workerAgentName(store.runPath, input.to_worker_id);
          text = `wake: ORCH appended a response in a2a/${input.to_worker_id}-report.md (run ${input.track_id}/${input.run_id}) — read the report; wake text carries no authority.`;
        }
      } else {
        try {
          const targetStore = await DelegationStore.resolve(input.to_track_id, input.to_run_id);
          const birth = latestBirth(await targetStore.read());
          if (!birth) unresolvedReason = `Run ${input.to_track_id}/${input.to_run_id} has no ORCH birth record yet.`;
          else if (senderSession && birth.official_session_id === senderSession) unresolvedReason = "Target run's ORCH is the caller; a note to yourself is never delivered.";
          else target = birth.pane_id;
        } catch (error) { unresolvedReason = `Target run unresolved: ${error instanceof Error ? error.message : String(error)}`; }
        text = `orch note (${input.kind}) from ${input.track_id}/${input.run_id}: ${singleLine(input.note)} — non-authoritative; verify against that run's documents.`;
      }

      let delivery: MessageDelivery;
      if (!target) { delivery = "target_unresolved"; if (unresolvedReason) warnings.push(unresolvedReason); }
      else {
        try { await this.adapter.notify(target, text, 15_000); delivery = "delivered"; }
        catch (error) {
          const detail = `${error instanceof McpContractError ? error.code : ""} ${error instanceof Error ? error.message : String(error)}`;
          delivery = /agent_blocked/i.test(detail) ? "rejected_blocked" : /not.?found|missing/i.test(detail) ? "target_unresolved" : "failed";
          warnings.push(`Delivery ${delivery}: ${singleLine(detail).slice(0, 300)}`);
        }
      }
      await appendMessageLog(store.runPath, { at: nowIso(), action: input.action, sender, delivery, target: target ?? null, text, ...(warnings.length ? { warnings } : {}) });
      return { ok: true, tool: "herdr_message", action: input.action, run, effect: delivery === "delivered" ? "confirmed" : "none", retryable: delivery !== "delivered", data: { delivery, sender, target: target ?? null, ...(warnings.length ? { warnings } : {}) } };
    } catch (error) { return resultError("herdr_message", input.action, run, error); }
  }

  /**
   * Standardized dogfooding friction capture. Reports never leave the machine:
   * they append to a global mode-600 JSONL that a human-gated triage pass may
   * later promote to an external tracker. The action deliberately skips the
   * OMP fact bridge so a broken bridge — itself friction — stays reportable.
   */
  async friction(input: HerdrFrictionInput): Promise<McpResult> {
    const run: RunRef = { track_id: (input.action === "report" ? input.track_id : undefined) ?? "global", run_id: (input.action === "report" ? input.run_id : undefined) ?? "global" };
    try {
      const logPath = frictionLogPath();
      if (input.action === "report") {
        const summary = singleLine(input.summary);
        if (!summary) throw new McpContractError("invalid_friction", "Summary is empty after single-line normalization.", "validate", "Provide one concrete observable symptom.");
        const fingerprint = frictionFingerprint(input.kind, input.tool, input.error_code, summary);
        const prior = (await scanFriction({ fingerprint }, 0)).counts.get(fingerprint) ?? 0;
        const paneId = process.env.HERDR_PANE_ID;
        const record: FrictionRecord = {
          at: nowIso(), kind: input.kind, reporter: input.reporter, summary, fingerprint,
          ...(input.tool ? { tool: input.tool } : {}),
          ...(input.error_code ? { error_code: input.error_code } : {}),
          ...(input.evidence ? { evidence: input.evidence } : {}),
          ...(input.track_id ? { track_id: input.track_id } : {}),
          ...(input.run_id ? { run_id: input.run_id } : {}),
          ...(paneId && paneId.length <= 80 && BOUNDED_TOKEN_RE.test(paneId) ? { pane_id: paneId } : {}),
        };
        await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
        await appendFile(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        return { ok: true, tool: "herdr_friction", action: input.action, run, effect: "confirmed", retryable: false, data: { fingerprint, prior_reports: prior, log_path: logPath } };
      }
      const scan = await scanFriction({ kind: input.kind, fingerprint: input.fingerprint }, input.limit ?? FRICTION_LIST_DEFAULT);
      const groups = [...scan.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, FRICTION_GROUP_LIMIT).map(([fingerprint, count]) => ({ fingerprint, count }));
      return { ok: true, tool: "herdr_friction", action: input.action, run, effect: "none", retryable: false, data: { total: scan.total, ...(scan.malformed ? { malformed: scan.malformed } : {}), groups, entries: scan.entries, log_path: logPath } };
    } catch (error) { return resultError("herdr_friction", input.action, run, error); }
  }
}
