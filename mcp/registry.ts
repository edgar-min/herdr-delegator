import { chmod, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { acquireLock, readRegistry, releaseLock } from "../io.github.edgar-min.herdr-delegator/extensions/lib/runtime";
import { resolveRunCoordinate, writeAtomic } from "../io.github.edgar-min.herdr-delegator/extensions/lib/config";
import { ASSIGNMENT_RE, DELEGATION_VERSION, McpContractError, RESPONSIBILITY_RE, SHA256_RE, WORKER_RE, nowIso, sha256, type AssignmentArtifact, type AssignmentRecord, type AssignmentState, type DelegationRegistry, type ResponsibilityRecord, type Separation, type WorkerLaneRecord } from "./contracts";

const ASSIGNMENT_STATES: Record<AssignmentState, true> = {
  queued: true,
  prompting: true,
  working: true,
  blocked: true,
  completed: true,
  failed: true,
  ambiguous: true,
};
const LIST_SECTIONS = ["Completion conditions", "Write ownership", "Dependencies", "User boundaries"] as const;
const MAX_ARTIFACT_BYTES = 64 * 1024;

const LANE_KEYS = ["worker_id", "responsibility_key", "lane_generation", "separation", "active_assignment_id", "queued_assignment_ids", "last_completed_assignment_id", "state", "state_change_seq", "official_session_id", "official_session_path", "expected_provider", "expected_model", "effective_thinking", "created_at", "updated_at"] as const;
const ASSIGNMENT_KEYS = ["assignment_id", "responsibility_key", "worker_id", "state", "instructions_sha256", "prompted_at", "report_sha256", "completed_at", "elapsed_ms", "token_usage", "advisory_unowned_changes", "ambiguous_operation", "ambiguous_state_change_seq", "created_at", "updated_at"] as const;
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
function assertMode600(mode: number, coordinate: string): void {
  if ((mode & 0o777) !== 0o600) throw new McpContractError("unsafe_file_mode", `${coordinate} must have mode 600.`, "storage", "Restore the canonical control-plane file mode before continuing.");
}

function parseListSection(value: string, heading: string): string[] {
  const lines = value.trim().split("\n");
  if (lines.length > 64 || lines.some((line) => !line.startsWith("- ") || line.length < 3 || line.length > 1_002)) {
    throw new McpContractError("assignment_artifact_invalid", `${heading} must contain only bounded Markdown bullets.`, "validate", "Repair the immutable assignment Markdown before dispatch.");
  }
  return lines.map((line) => line.slice(2));
}

function parseAssignmentMarkdown(text: string, assignmentId: string, responsibility: string): AssignmentArtifact {
  if (text.includes("\r") || Buffer.byteLength(text) > MAX_ARTIFACT_BYTES) throw new McpContractError("assignment_artifact_invalid", "Assignment Markdown must be bounded UTF-8 with LF line endings.", "validate", "Rewrite the canonical assignment file.");
  const frontmatterEnd = text.indexOf("\n---\n", 4);
  if (!text.startsWith("---\n") || frontmatterEnd < 0) throw new McpContractError("assignment_artifact_invalid", "Assignment Markdown requires strict frontmatter.", "validate", "Add assignment_id, responsibility_key, and profile frontmatter.");
  const frontmatter = text.slice(4, frontmatterEnd).split("\n");
  if (frontmatter.length !== 3) throw new McpContractError("assignment_artifact_invalid", "Assignment frontmatter has unexpected fields.", "validate", "Keep only assignment_id, responsibility_key, and profile.");
  const scalar = (line: string, key: string, pattern: RegExp): string => {
    const prefix = `${key}: `;
    const value = line.startsWith(prefix) ? line.slice(prefix.length) : "";
    if (!pattern.test(value)) throw new McpContractError("assignment_artifact_invalid", `Invalid ${key} frontmatter.`, "validate", "Repair the canonical assignment Markdown.");
    return value;
  };
  const parsedAssignmentId = scalar(frontmatter[0], "assignment_id", ASSIGNMENT_RE);
  const parsedResponsibility = scalar(frontmatter[1], "responsibility_key", RESPONSIBILITY_RE);
  const profile = scalar(frontmatter[2], "profile", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  if (parsedAssignmentId !== assignmentId || parsedResponsibility !== responsibility) throw new McpContractError("assignment_artifact_invalid", "Assignment frontmatter conflicts with requested coordinates.", "validate", "Use the file matching the requested assignment and responsibility.");

  const body = text.slice(frontmatterEnd + 5).trim();
  const sections = body.split(/\n(?=# )/);
  const expectedHeadings = ["Goal", ...LIST_SECTIONS];
  if (sections.length !== expectedHeadings.length) throw new McpContractError("assignment_artifact_invalid", "Assignment Markdown has missing or extra sections.", "validate", "Use the canonical five-section assignment format.");
  const sectionValues = sections.map((section, index) => {
    const prefix = `# ${expectedHeadings[index]}\n\n`;
    if (!section.startsWith(prefix)) throw new McpContractError("assignment_artifact_invalid", `Expected heading ${expectedHeadings[index]}.`, "validate", "Keep canonical section order and headings.");
    return section.slice(prefix.length);
  });
  const goal = sectionValues[0].trim();
  if (!goal || goal.length > 4_096 || goal.includes("\n# ")) throw new McpContractError("assignment_artifact_invalid", "Goal must be one bounded Markdown section.", "validate", "Repair the assignment goal.");
  return {
    assignment_id: assignmentId,
    responsibility_key: responsibility,
    profile,
    goal,
    completion_conditions: parseListSection(sectionValues[1], LIST_SECTIONS[0]),
    write_ownership: parseListSection(sectionValues[2], LIST_SECTIONS[1]),
    dependencies: parseListSection(sectionValues[3], LIST_SECTIONS[2]),
    user_boundaries: parseListSection(sectionValues[4], LIST_SECTIONS[3]),
  };
}

function validateRegistry(value: unknown, runPath: string): asserts value is DelegationRegistry {
  if (!isRecord(value) || !exactKeys(value, ["version", "owner", "run_path", "revision", "responsibilities", "lanes", "assignments", "created_at", "updated_at"]) || value.version !== DELEGATION_VERSION || value.owner !== "herdr-delegator" || value.run_path !== runPath || !Number.isInteger(value.revision) || !isRecord(value.responsibilities) || !isRecord(value.lanes) || !isRecord(value.assignments)) {
    throw new McpContractError("delegation_registry_invalid", "delegation.json is malformed or belongs to another run.", "storage", "Preserve and repair the minimal registry; do not infer ownership.");
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
      validAdvisoryUnownedChanges(assignment.advisory_unowned_changes);
    if (!validIdentity || !validSettlement) throw new McpContractError("delegation_registry_invalid", "An assignment record is malformed.", "storage", "Repair the assignment from its immutable artifact and verified settlement evidence.");
  }
}

export type AssignmentFile = { path: string; assignment: AssignmentArtifact; instructionsHash: string };
export type LaneSelection = { lane: WorkerLaneRecord; assignment: AssignmentRecord; queued: boolean; duplicate: boolean; artifact: AssignmentFile; revision: number };

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
    return { version: 1, owner: "herdr-delegator", run_path: this.runPath, revision: 0, responsibilities: {}, lanes: {}, assignments: {}, created_at: now, updated_at: now };
  }

  async read(): Promise<DelegationRegistry> {
    try {
      assertMode600((await stat(this.registryPath)).mode, this.registryPath);
      const value: unknown = JSON.parse(await readFile(this.registryPath, "utf8"));
      validateRegistry(value, this.runPath);
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
      await writeAtomic(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, 0o600);
      assertMode600((await stat(this.registryPath)).mode, this.registryPath);
      return result;
    } finally { await releaseLock(this.lockPath, owner); }
  }

  async assignmentFile(assignmentId: string, responsibility: string, expectedHash: string): Promise<AssignmentFile> {
    if (!ASSIGNMENT_RE.test(assignmentId) || !RESPONSIBILITY_RE.test(responsibility) || !SHA256_RE.test(expectedHash)) throw new McpContractError("invalid_assignment", "Assignment coordinates or hash are invalid.", "validate", "Use canonical IDs and a lowercase SHA-256 hash.");
    const artifactPath = path.join(this.runPath, "a2a", "assignments", `${assignmentId}.md`);
    try {
      if (await realpath(artifactPath) !== artifactPath) throw new Error("non-canonical artifact");
      const file = await lstat(artifactPath);
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_ARTIFACT_BYTES) throw new Error("unsafe artifact");
      const bytes = await readFile(artifactPath);
      if (sha256(bytes) !== expectedHash) throw new McpContractError("assignment_hash_mismatch", "Immutable assignment Markdown hash does not match the request.", "validate", "Use the exact file hash; never overwrite a submitted assignment.");
      return { path: artifactPath, assignment: parseAssignmentMarkdown(bytes.toString("utf8"), assignmentId, responsibility), instructionsHash: expectedHash };
    } catch (error: unknown) {
      if (error instanceof McpContractError) throw error;
      throw new McpContractError("assignment_artifact_missing", "Canonical assignment Markdown is missing or unsafe.", "validate", "Create the ORCH-owned bounded assignment file.");
    }
  }

  /**
   * Pre-immutability grammar validation of the canonical assignment file. It
   * parses the exact bytes at the canonical coordinate, returns their SHA-256
   * for a subsequent `add`, and never mutates the registry or any lane.
   */
  async preflight(assignmentId: string, responsibility: string): Promise<AssignmentFile> {
    if (!ASSIGNMENT_RE.test(assignmentId) || !RESPONSIBILITY_RE.test(responsibility)) throw new McpContractError("invalid_assignment", "Assignment coordinates are invalid.", "validate", "Use canonical assignment and responsibility IDs.");
    const artifactPath = path.join(this.runPath, "a2a", "assignments", `${assignmentId}.md`);
    try {
      if (await realpath(artifactPath) !== artifactPath) throw new Error("non-canonical artifact");
      const file = await lstat(artifactPath);
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_ARTIFACT_BYTES) throw new Error("unsafe artifact");
      const bytes = await readFile(artifactPath);
      return { path: artifactPath, assignment: parseAssignmentMarkdown(bytes.toString("utf8"), assignmentId, responsibility), instructionsHash: sha256(bytes) };
    } catch (error: unknown) {
      if (error instanceof McpContractError) throw error;
      throw new McpContractError("assignment_artifact_missing", "Canonical assignment Markdown is missing or unsafe.", "validate", "Create the ORCH-owned bounded assignment file before preflight.");
    }
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

    const lifecycle = await readRegistry(path.join(this.runPath, "a2a", "herdr-workers.json"));
    for (const worker of Object.values(lifecycle.workers)) reserve(worker.worker_id);
    for (const entry of await readdir(path.join(this.runPath, "a2a"))) {
      const match = /^w([1-9][0-9]*)-(?:instructions|report)\.md$/.exec(entry);
      if (match) reserved.add(Number(match[1]));
    }
    return reserved;
  }

  async select(assignmentId: string, responsibility: string, instructionsHash: string, separation: Separation | undefined, timeoutMs: number): Promise<LaneSelection> {
    const artifact = await this.assignmentFile(assignmentId, responsibility, instructionsHash);
    let selected!: LaneSelection;
    await this.transaction(timeoutMs, async (registry) => {
      const existing = registry.assignments[assignmentId];
      if (existing) {
        if (existing.instructions_sha256 !== instructionsHash || existing.responsibility_key !== responsibility) throw new McpContractError("assignment_duplicate_conflict", "Assignment ID already binds different immutable Markdown.", "select", "Allocate a new assignment ID.");
        const lane = registry.lanes[existing.worker_id];
        if (!lane) throw new McpContractError("responsibility_ambiguous", "Existing assignment has no uniquely owned lane.", "select", "Inspect the minimal registry; do not create a replacement.");
        const ready = existing.state === "queued" && lane.active_assignment_id === assignmentId;
        selected = { lane, assignment: existing, queued: !ready && existing.state === "queued", duplicate: !ready, artifact, revision: registry.revision + 1 };
        return;
      }

      const now = nowIso();
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
        const reserved = await this.reservedWorkerOrdinals(registry);
        let ordinal = 1;
        while (reserved.has(ordinal)) ordinal += 1;
        const workerId = `w${ordinal}`;
        lane = { worker_id: workerId, responsibility_key: responsibility, lane_generation: 1, ...(separation ? { separation } : {}), queued_assignment_ids: [], state: "starting", state_change_seq: 0, created_at: now, updated_at: now };
        registry.lanes[workerId] = lane;
        responsibilityRecord.worker_ids.push(workerId);
      }
      const queued = !!lane.active_assignment_id || lane.state === "working" || lane.state === "blocked" || lane.state === "resume-needed";
      const assignment: AssignmentRecord = { assignment_id: assignmentId, responsibility_key: responsibility, worker_id: lane.worker_id, state: "queued", instructions_sha256: instructionsHash, created_at: now, updated_at: now };
      registry.assignments[assignmentId] = assignment;
      if (queued) lane.queued_assignment_ids.push(assignmentId); else lane.active_assignment_id = assignmentId;
      lane.updated_at = now;
      selected = { lane, assignment, queued, duplicate: false, artifact, revision: registry.revision + 1 };
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
