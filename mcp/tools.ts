import { createReadStream } from "node:fs";
import { isUtf8 } from "node:buffer";
import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { initializeRun, inspectOrchestrator, labelOwnedPane, retireOrchestratorSession, startOrchestrator } from "../io.github.edgar-min.herdr-delegator/extensions/lib/track";
import { MAX_ANCHOR_BYTES, classifyOwnershipDeclarations, inboundChannelEntries, loadDelegatorConfig, newestEntryAnchor, readRunIndex, resolveSkillRoutes, storageRootFromConfig, writeAtomic, type InboundChannelObservation, type RunIndexRow } from "../io.github.edgar-min.herdr-delegator/extensions/lib/config";
import { materializeGuidance, materializeWorkerGuidance } from "../io.github.edgar-min.herdr-delegator/extensions/lib/guidance";
import type { SkillRoute, SkillRouteBoundary, SkillRouteSurface } from "../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";
import { closeWorker, ensureWorker, inspectWorker, verifyPromptedWorker } from "../io.github.edgar-min.herdr-delegator/extensions/lib/worker";
import { ContractError as LegacyContractError, type WorkerResult } from "../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";
import { BOOTSTRAP_METADATA_TTL_MS, BOOTSTRAP_TOKEN_PREFIX, BOOTSTRAP_TOKENS } from "../io.github.edgar-min.herdr-delegator/extensions/lib/bridge";
import { HerdrAdapter } from "./herdr-adapter";
import { DelegationStore, mountedBuild } from "./registry";
import { BOUNDED_TOKEN_RE, BUDGET_STEP_FRACTION, DEFAULT_TIMEOUT_MS, MAX_EFFECTIVE_WAIT_MS, MAX_MANDATE_BYTES, MAX_MANDATE_INTENT, MAX_MANDATE_ITEM, MAX_MANDATE_ITEMS, MAX_TIMEOUT_MS, MIN_EXTENSION_INTERVAL_MS, MIN_TIMEOUT_MS, McpContractError, nowIso, ompRuntimeFactsSchema, sha256, type AdvisoryUnownedChanges, type AssignmentRecord, type AssignmentSettlementObservation, type AssignmentState, type BudgetMetering, type BudgetParkReason, type BudgetRecord, type DelegationRegistry, type ErrorPhase, type FrictionRecord, type HerdrAssignmentInput, type HerdrFrictionInput, type HerdrMessageInput, type HerdrTrackInput, type HerdrWorkerInput, type InterRunOwnershipOverlap, type InterRunOwnershipReport, type LaneState, type Mandate, type McpResult, type MessageDelivery, type OmpRuntimeFacts, type OrchBirthOrigin, type OrchBirthRecord, type RunRef, type TokenUsageObservation, type ToolName, type TrackTotals, type WorkerLaneRecord, type WorkerStalenessObservation } from "./contracts";
import { appendLedger, budgetAuditPath, budgetClampPath, budgetLedgerPath, clampFingerprint, clampReconcileValue, clampSchemaGuidance, clampTokensPinned, clampWriteLedgerLine, classifyClampTokens, clearOwedClampTokens, healClampTokens, meterRun, meteringLedgerLine, normalizeJustification, orchPaneLabel, parseVerdict, readAuditDocument, readClamp, renderAuditInput, scaffoldClamp, seedBudget, stepCap, writeClampMaxTokens, type ClampReading, type ClampTokenClass, type ClampWriteOutcome } from "./budget";
import { assertNoAmbiguousWork, assertRevivalDocuments, readCloseApproval, readRebirthApproval, rebirthApprovalPath } from "./revival";


// ---------------------------------------------------------------------------
// Birth-based ORCH identity (identity/comms redesign, decisions 1-3). The latest
// birth record in a2a/delegation.json is the sole command identity for a run:
// guarded run-command ops accept only the latest-generation birth session and
// reject zombies (stale generations) and strangers.
//
// `herdr_track open` stamps a creator record before it spawns anything, so the
// creator record is also the "this run is open-managed" marker:
//   creator + birth      -> normal life; the creator is retired for this run.
//   creator, no birth    -> an open did not finish; only re-running `open` may
//                           complete it, and nothing may claim birth.
//   no creator, no birth -> a legacy run (init + start_orchestrator); the first
//                           attested guarded command claims generation 1.
// ---------------------------------------------------------------------------

function latestBirth(registry: DelegationRegistry): OrchBirthRecord | undefined {
  const births = registry.orch_births;
  return births && births.length ? births[births.length - 1] : undefined;
}

function orchIdentityError(registry: Pick<DelegationRegistry, "orch_births" | "orch_creator">, sessionId: string): McpContractError {
  const births = registry.orch_births ?? [];
  const latest = births[births.length - 1];
  if (!latest) {
    return new McpContractError("orch_birth_missing", "This run was opened but its ORCH was never born, so nothing commands it yet.", "attest", "Re-run herdr_track open from the opening session with the identical mandate; it is idempotent and completes the birth.");
  }
  if (registry.orch_creator?.session_id === sessionId) {
    return new McpContractError("creator_session_retired", `The session that opened this track died for it at birth; generation ${latest.generation} commands this run.`, "attest", "Stop working this track here and converse with the named ORCH pane; refuse to accumulate more context on it.");
  }
  if (births.some((birth) => birth.official_session_id === sessionId)) {
    return new McpContractError("stale_orch_generation", `Caller session belongs to a retired ORCH generation; generation ${latest.generation} commands this run.`, "attest", "Stop commanding this run: a newer ORCH was born. Converse with the current ORCH pane instead.");
  }
  return new McpContractError("orch_identity_mismatch", `Caller session is not this run's ORCH (generation ${latest.generation}).`, "attest", "Only the run's born ORCH session may command it. Coordinate via herdr_message notify_run or the run documents.");
}

/** Singularity gate for guarded run-command ops; claims birth only on a legacy run. */
export async function assertOrchCommand(store: DelegationStore, facts: OmpRuntimeFacts): Promise<void> {
  const registry = await store.read();
  const latest = latestBirth(registry);
  if (latest) {
    if (latest.official_session_id !== facts.session_id) throw orchIdentityError(registry, facts.session_id);
    return;
  }
  if (registry.orch_creator) throw orchIdentityError(registry, facts.session_id);
  await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
    const current = next.orch_births ?? [];
    const head = current[current.length - 1];
    if (head) {
      if (head.official_session_id !== facts.session_id) throw orchIdentityError(next, facts.session_id);
      return;
    }
    if (next.orch_creator) throw orchIdentityError(next, facts.session_id);
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

let messageDeliverySequence = 0;

function nextMessageDeliveryId(): string {
  messageDeliverySequence += 1;
  return `${Date.now()}.${process.pid}.${messageDeliverySequence}`;
}

async function appendMessageLog(runPath: string, entry: Record<string, unknown>): Promise<void> {
  try { await appendFile(path.join(runPath, "a2a", "messages.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); } catch { /* observability is best-effort */ }
}

function singleLine(value: string): string { return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").trim(); }

/** Deterministic worker agent name; mirrors extensions/lib/worker.ts. */
function workerAgentName(runPath: string, workerId: string): string {
  return `herdr-${workerId}-${sha256(`${runPath}\0${workerId}`).slice(0, 12)}`;
}

/**
 * Sender-owned inter-run channel document (decision 12). Isomorph of the peer
 * channel file `a2a/w<N>-to-w<M>.md`: directional, append-only, and owned by the
 * run that writes it, so no ORCH ever writes inside another run's directory —
 * the counterpart's ack is an append to its own reverse channel plus a bell
 * back. `_` cannot occur in a run coordinate, so `<track>_<run>` parses back
 * unambiguously.
 */
export function interRunChannelPath(runPath: string, toTrackId: string, toRunId: string): string {
  return path.join(runPath, "a2a", `orch-to-${toTrackId}_${toRunId}.md`);
}

/**
 * Birth succeeded but the born ORCH cannot act: OMP is holding it on a
 * permission prompt. Blocked-on-permission is a normal state reported honestly
 * rather than a failed birth (friction 66a5184e15deff47), so `open` reports it
 * as an advisory the retiring caller can act on — one warning line naming the
 * pane the human must click in, plus the structured field for a caller that
 * routes on state instead of prose. Exported so the assembly is exercisable
 * with a synthetic observation; `open` itself spawns a real pane.
 */
export function openPermissionAdvisory(
  observation: Record<string, unknown>,
): { warning: string; field: { state: "blocked"; pane_id: string } } | undefined {
  const blocked = observation.blocked_on_permission;
  if (!isObject(blocked) || blocked.state !== "blocked") return undefined;
  const paneId = blocked.pane_id;
  if (typeof paneId !== "string" || !paneId || paneId.length > 80 || !BOUNDED_TOKEN_RE.test(paneId)) return undefined;
  return {
    warning: `ORCH born but blocked on an OMP permission prompt in pane ${paneId}; it cannot act until a human approves in that pane. Birth succeeded — direct the user to that pane to click the approval.`,
    field: { state: "blocked", pane_id: paneId },
  };
}

/**
 * A doorbell may only point at a document that already exists: a bell with
 * nothing behind it is the silent failure this design exists to prevent, so a
 * missing or empty channel document is rejected as caller input, not reported as
 * a soft delivery outcome.
 */
async function readChannelDocument(channelPath: string): Promise<{ sha256: string; bytes: number; entry_line?: number; lines: number }> {
  let contents: Buffer;
  try { contents = await readFile(channelPath); }
  catch (error: unknown) {
    if (isObject(error) && error.code === "ENOENT") throw new McpContractError("channel_document_missing", "The sender-owned inter-run channel document does not exist, so this bell would point at nothing.", "validate", `Append your entry to ${channelPath} first — one heading with the ISO timestamp, the kind (fact, bottleneck, request, or handoff) and your run coordinates, then the note — and ring the bell after the append.`);
    throw new McpContractError("channel_document_unreadable", "The inter-run channel document cannot be read safely.", "storage", "Inspect the channel document; never ring a bell for a document you cannot read.");
  }
  const document = contents.toString("utf8");
  if (!contents.byteLength || !document.trim()) throw new McpContractError("channel_document_empty", "The inter-run channel document is empty, so this bell would point at nothing.", "validate", `Append your entry to ${channelPath} first, then ring the bell.`);
  const anchor = newestEntryAnchor(document);
  return { sha256: sha256(contents), bytes: contents.byteLength, ...(anchor ? { entry_line: anchor.line } : {}), lines: document.split("\n").length };
}

// The anchor parse and its byte ceiling are the shared append-only-document
// logic in extensions/lib/config.ts; the bell and the inbound observation must
// name the same line of the same document, so there is one implementation.

/** The bell's read-from clause for a document on disk, or nothing to say. */
async function anchorClause(documentPath: string): Promise<string> {
  try {
    const found = await lstat(documentPath);
    if (!found.isFile() || found.isSymbolicLink() || found.size > MAX_ANCHOR_BYTES) return "";
    const anchor = newestEntryAnchor(await readFile(documentPath, "utf8"));
    return anchor ? ` from line ${anchor.line} of ${anchor.lines}` : "";
  } catch {
    return "";
  }
}

/**
 * The read surface for the channel documents other runs addressed to this one.
 * `inspect` is what a live or recovering ORCH already calls, so it is where a
 * missed doorbell is recovered — as an observation, never as a delivery. The
 * storage root is resolved here because the observation itself takes it as an
 * argument, which is what makes it exercisable without any configuration layer.
 */
async function observeInboundChannels(store: DelegationStore): Promise<InboundChannelObservation> {
  try {
    const loaded = await loadDelegatorConfig(store.runPath, store.cwd);
    return await inboundChannelEntries(store.runPath, await storageRootFromConfig(loaded.config, false));
  } catch (error) {
    return { entries: [], truncated: false, observation_warning: `inbound_scan_unavailable: ${singleLine(error instanceof Error ? error.message : String(error)).slice(0, 200)}` };
  }
}

/**
 * The observation coordinate a `wait` returns and the next one may echo back
 * (friction 3b7947a6750ee7db): registry revision, lane sequence, report bytes,
 * and the moment. Echoing it makes the repeated call's arguments genuinely
 * different — a bounded poll is legitimate, an identical repeated call is what
 * trips a host loop detector — and lets the next result state whether anything
 * moved. It grants nothing and reserves nothing.
 */
async function laneWaitCursor(store: DelegationStore, registry: DelegationRegistry, lane: WorkerLaneRecord): Promise<string> {
  let bytes = 0;
  try {
    const found = await lstat(path.join(store.runPath, "a2a", `${lane.worker_id}-report.md`));
    if (found.isFile() && !found.isSymbolicLink()) bytes = found.size;
  } catch { /* an absent report is zero bytes, which is itself a coordinate */ }
  const sequence = Number.isSafeInteger(lane.state_change_seq) && lane.state_change_seq >= 0 ? lane.state_change_seq : 0;
  return `v1.r${registry.revision}.s${sequence}.b${bytes}.t${Date.now()}`;
}

/**
 * True when the lane sequence or the report bytes moved between two cursors.
 *
 * The registry revision is deliberately NOT compared: a wait observes the lane
 * and writes what it observed, so the revision advances on every call including
 * one where nothing happened. Only the axes the WORKER moves can answer "did
 * anything happen"; the revision stays in the token as the coordinate the ORCH's
 * own reads are ordered by.
 */
const CURSOR_AXES_RE = /^v1\.r\d+\.s(\d+)\.b(\d+)\.t\d+$/;

function cursorMoved(previous: string, current: string): boolean | undefined {
  const before = CURSOR_AXES_RE.exec(previous);
  const after = CURSOR_AXES_RE.exec(current);
  if (!before || !after) return undefined;
  return before[1] !== after[1] || before[2] !== after[2];
}

// Lane facts that cannot change between two inspections of the same lane:
// coordinates, the agent identity, the launch configuration, and the one-time
// verification stamps. A compact inspect omits them (friction 588687ae4317fd72)
// and keeps only what a supervision probe is actually asking about.
const INSPECT_INVARIANT_FIELD: Record<string, true> = {
  run_path: true, worker_id: true, generation: true, workspace_id: true, tab_id: true,
  root_pane_id: true, agent_name: true, agent_session_path: true, instruction_path: true,
  prompt_sha256: true, config_sources: true, selected_profile: true, selection_source: true,
  requested_role: true, expected_provider: true, expected_model: true,
  resolved_model_is_fallback: true, verified_at: true, bootstrap_attested_at: true,
  bootstrap_verified_at: true, owner: true, created_tab: true,
};

function compactInspect(result: WorkerResult, staleness: WorkerStalenessObservation | undefined): Record<string, unknown> {
  const worker = isObject(result.worker)
    ? Object.fromEntries(Object.entries(result.worker).filter(([key, value]) => !INSPECT_INVARIANT_FIELD[key] && value !== undefined))
    : undefined;
  const observation = isObject(result.observation) ? result.observation : undefined;
  return {
    ok: result.ok,
    operation: result.operation,
    state: result.state,
    retryable: result.retryable,
    compact: true,
    ...(worker ? { worker } : {}),
    observation: {
      ...(observation && "output" in observation ? { output: observation.output } : {}),
      ...(observation && "report_exists" in observation ? { report_exists: observation.report_exists } : {}),
      ...(staleness ? { staleness } : {}),
    },
  };
}

/**
 * The peer channel document a `wake_peer` bell may name (friction
 * ad32fc202a939bf7). The server never parses plan.md, so it cannot know which
 * channel a plan declared; it can only check the two deterministic names against
 * disk — responsibility-named first, lane-named second — and name nothing when
 * neither exists. A bell pointing at a path that does not exist sends the
 * receiver to look for a document nobody wrote, which is worse than a bell that
 * admits it has no verified path.
 */
async function existingPeerChannel(runPath: string, sender: WorkerLaneRecord, receiver: WorkerLaneRecord): Promise<string | undefined> {
  const candidates = [
    `${sender.responsibility_key}-to-${receiver.responsibility_key}.md`,
    `${sender.worker_id}-to-${receiver.worker_id}.md`,
  ];
  for (const candidate of candidates) {
    try {
      const found = await lstat(path.join(runPath, "a2a", candidate));
      if (found.isFile() && !found.isSymbolicLink()) return `a2a/${candidate}`;
    } catch { /* try the next deterministic candidate */ }
  }
  return undefined;
}

/**
 * What a `wake_worker` bell is about, in the bell text itself (friction
 * a776403dd44aa2af): the assignment axis plus one reason token, so a worker can
 * tell a queue notice from an answer to a decision request without inferring it
 * from the fact that it was woken. Every axis is derived from the lane record —
 * the bell reports, it never decides.
 */
function workerWakeSubject(registry: DelegationRegistry, lane: WorkerLaneRecord): string {
  const active = lane.active_assignment_id;
  if (active) {
    const reason = registry.assignments[active]?.state === "queued" ? "queued" : "orch-response";
    return `assignment ${active} reason=${reason}`;
  }
  if (lane.last_completed_assignment_id) return `assignment ${lane.last_completed_assignment_id} reason=completion`;
  return "no assignment is recorded on this lane reason=orch-response";
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
// Refusals the human's close-approval file may substitute for: ORCH identity, and
// only ORCH identity (plan U3 gate order).
const CLOSE_FORCE_ELIGIBLE_CODES: Record<string, true> = { orch_identity_mismatch: true, stale_orch_generation: true };
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
 *
 * `profile` is the delivery target's worker profile, passed only where the
 * delivery point has one. Without it, profile-scoped rules never match, so an
 * orchestrator-surface point keeps receiving exactly the unscoped rules.
 */
async function advisorySkillRoutes(
  runPath: string,
  cwd: string,
  boundaries: readonly SkillRouteBoundary[],
  surface: SkillRouteSurface,
  profile?: string,
): Promise<SkillRoute[]> {
  try {
    return await resolveSkillRoutes(runPath, cwd, boundaries, surface, profile);
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

/** A bounded single-line reason, safe to join into the capped response field. */
function auditDetail(error: unknown): string {
  return singleLine(error instanceof Error ? error.message : String(error)).slice(0, 160);
}

/**
 * The comparable half of what the active assignments declare they own, plus an
 * honest count of the half that is not comparable at all.
 *
 * Every declaration used to be resolved as if it were a path, so a sentence
 * resolved to a directory name and silently widened the owned set. Only
 * classified declarations are compared now, and both classes keep the audit's
 * long-standing prefix semantics: a declared path covers what lives under it.
 */
type DeclaredOwnership = { prefixes: string[]; classified: number; unclassified: number };

async function declaredActiveOwnership(
  store: DelegationStore,
  registry: DelegationRegistry,
  warnings?: string[],
): Promise<DeclaredOwnership | undefined> {
  const prefixes: string[] = [];
  let classified = 0;
  let unclassified = 0;
  for (const assignment of Object.values(registry.assignments)) {
    if (!ACTIVE_SETTLEMENT_STATES[assignment.state]) continue;
    let declarations: readonly string[];
    try {
      declarations = (await store.assignmentFile(assignment.assignment_id, assignment.responsibility_key, assignment.instructions_sha256)).assignment.write_ownership;
    } catch (error) {
      // Ownership cannot be enumerated, so an audit would compare against a
      // window it cannot see. Skip it, and say so.
      warnings?.push(`ownership_artifacts_unreadable: assignment ${assignment.assignment_id} ownership could not be read, so no unowned-change audit was made: ${auditDetail(error)}`);
      return undefined;
    }
    for (const declaration of declarations) {
      for (const declared of classifyOwnershipDeclarations(declaration)) {
        if (declared.kind === "unclassified") {
          unclassified += 1;
          continue;
        }
        const absolute = path.resolve(store.cwd, declared.value);
        const relative = path.relative(store.cwd, absolute);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          // Lexically outside the project directory the audit observes: it
          // cannot be compared, so it counts as unreadable rather than as
          // ownership of something this audit never looks at.
          unclassified += 1;
          continue;
        }
        classified += 1;
        if (!prefixes.includes(absolute)) prefixes.push(absolute);
      }
    }
  }
  if (unclassified) {
    warnings?.push(`ownership_declarations_unclassified: ${unclassified} of ${classified + unclassified} active ownership declarations are not machine-readable paths, so the audit covered only the other ${classified}.`);
  }
  return { prefixes, classified, unclassified };
}

/**
 * The audit is fail-open by contract, and every one of its exits used to return
 * `undefined` — so a settlement that observed nothing was indistinguishable from
 * a settlement that observed a clean tree (friction 588687ae4317fd72). Each exit
 * now names itself in `warnings`, which the settling response carries and
 * nothing persists. Fail-open is unchanged: a named skip never blocks
 * settlement, changes terminal state, or attributes a path to anyone.
 */
async function observeAdvisoryUnownedChanges(store: DelegationStore, registry: DelegationRegistry, warnings?: string[]): Promise<AdvisoryUnownedChanges | undefined> {
  const skip = (code: string, detail: string): undefined => {
    warnings?.push(`${code}: ${detail}`);
    return undefined;
  };
  const ownership = await declaredActiveOwnership(store, registry, warnings);
  if (!ownership) return undefined;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, GIT_AUDIT_TIMEOUT_MS);
  try {
    const process = Bun.spawn(["git", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
      cwd: store.cwd,
      env: { ...globalThis.process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const [stdout, exitCode] = await Promise.all([new Response(process.stdout).arrayBuffer(), process.exited]);
    if (timedOut) return skip("git_audit_timeout", `git status did not finish within the ${GIT_AUDIT_TIMEOUT_MS} ms abort boundary.`);
    if (exitCode !== 0) return skip("git_audit_command_failed", `git status exited ${exitCode} in the run's project directory, which is also what a directory outside any Git work tree reports.`);
    if (stdout.byteLength > MAX_GIT_OUTPUT_BYTES) return skip("git_audit_output_oversized", `git status produced ${stdout.byteLength} bytes, above the ${MAX_GIT_OUTPUT_BYTES}-byte acceptance bound.`);
    const bytes = Buffer.from(stdout);
    if (!isUtf8(bytes)) return skip("git_audit_output_non_utf8", "git status output is not valid UTF-8, so no path could be read safely.");
    const entries = bytes.toString("utf8").split("\0");
    if (entries.at(-1) !== "") return skip("git_audit_output_unterminated", "git status output does not end at a NUL boundary, so the final record may be partial.");
    entries.pop();
    const modified: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.length < 4 || entry[2] !== " ") return skip("git_audit_porcelain_invalid", `git status record ${index + 1} is not porcelain v1 XY-space-path.`);
      const candidates = [entry.slice(3)];
      if (entry[0] === "R" || entry[1] === "R" || entry[0] === "C" || entry[1] === "C") {
        const original = entries[index + 1];
        if (!original) return skip("git_audit_rename_invalid", `git status record ${index + 1} is a rename or copy with no source path.`);
        candidates.push(original);
        index += 1;
      }
      for (const candidate of candidates) {
        if (!candidate || candidate.includes("\0") || path.isAbsolute(candidate) || Buffer.byteLength(candidate) > 4_096) {
          return skip("git_audit_path_invalid", `git status record ${index + 1} names an empty, absolute, or oversized path.`);
        }
        const absolute = path.resolve(store.cwd, candidate);
        const relative = path.relative(store.cwd, absolute);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
          return skip("git_audit_path_outside_cwd", `git status record ${index + 1} resolves outside the run's project directory.`);
        }
        const covered = ownership.prefixes.some((owned) => absolute === owned || absolute.startsWith(`${owned}${path.sep}`));
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
  } catch (error) {
    return timedOut
      ? skip("git_audit_timeout", `git status was aborted at the ${GIT_AUDIT_TIMEOUT_MS} ms boundary.`)
      : skip("git_audit_exception", auditDetail(error));
  } finally {
    clearTimeout(timer);
  }
}

const INTER_RUN_MAX_PEER_RUNS = 128;
const INTER_RUN_MAX_OVERLAPS = 64;

/**
 * Read-only overlap report for an assignment being authored: which other runs in
 * the same project directory already declare ownership this draft also claims.
 *
 * This is the round trip friction 588687ae4317fd72 asked for — the notify /
 * acknowledge / begin exchange collapses when the author can see the overlap
 * before writing the notice — and it is a report, nothing else. Preflight is
 * non-mutating by contract (ASN-014a), so an overlap is never a refusal, a
 * reservation, or a lease; two orchestrators still settle it in their channel
 * documents (NG-012). It also does not prevent an accident: the units differ,
 * because a declaration names a file and a collision happens inside one.
 *
 * Bounded, deterministic, and loud: newest peers first with the coordinate as
 * tie-break so a capped scan is the same scan every time, and every partial
 * failure names itself instead of shrinking the report silently.
 */
async function observeInterRunOwnership(
  store: DelegationStore,
  requestedDeclarations: readonly string[],
  limits?: { maxPeerRuns?: number; maxOverlaps?: number },
): Promise<InterRunOwnershipReport> {
  const maxPeerRuns = limits?.maxPeerRuns ?? INTER_RUN_MAX_PEER_RUNS;
  const maxOverlaps = limits?.maxOverlaps ?? INTER_RUN_MAX_OVERLAPS;
  const requested: { kind: "path" | "prefix"; value: string }[] = [];
  let unclassified = 0;
  for (const declaration of requestedDeclarations) {
    for (const declared of classifyOwnershipDeclarations(declaration)) {
      if (declared.kind === "unclassified") unclassified += 1;
      else requested.push(declared);
    }
  }

  let index: { runs: Record<string, RunIndexRow> };
  try {
    const loaded = await loadDelegatorConfig(store.runPath, store.cwd);
    index = await readRunIndex(path.join(await storageRootFromConfig(loaded.config, false), "index.json"));
  } catch (error) {
    return { peer_runs_scanned: 0, cwd_shared_by: 0, overlaps: [], unclassified_declarations: unclassified, truncated: false, observation_warning: `inter_run_scan_unavailable: the storage-root index could not be read, so no peer run was examined: ${auditDetail(error)}` };
  }

  const sharing = Object.values(index.runs).filter((row) => row.cwd === store.cwd);
  const peers = sharing
    .filter((row) => row.run_path !== store.runPath)
    .sort((left, right) => {
      if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
      const leftKey = `${left.track_id}/${left.run_id}`;
      const rightKey = `${right.track_id}/${right.run_id}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const scanned = peers.slice(0, maxPeerRuns);

  const warnings: string[] = [];
  const overlaps: InterRunOwnershipOverlap[] = [];
  let overlapsTruncated = false;
  for (const row of scanned) {
    const coordinate = `${row.track_id}/${row.run_id}`;
    let peerStore: DelegationStore;
    let peerRegistry: DelegationRegistry;
    try {
      peerStore = await DelegationStore.resolve(row.track_id, row.run_id);
      peerRegistry = await peerStore.read();
    } catch (error) {
      warnings.push(`inter_run_peer_unreadable: peer run ${coordinate} could not be read: ${auditDetail(error)}`);
      continue;
    }
    for (const assignment of Object.values(peerRegistry.assignments)) {
      // Queued work has not been prompted, so nobody is writing under it yet;
      // counting it as held ownership would report a conflict that does not
      // exist. The active states are the same ones the settlement audit uses.
      if (!ACTIVE_SETTLEMENT_STATES[assignment.state]) continue;
      let declarations: readonly string[];
      try {
        declarations = (await peerStore.assignmentFile(assignment.assignment_id, assignment.responsibility_key, assignment.instructions_sha256)).assignment.write_ownership;
      } catch (error) {
        warnings.push(`inter_run_peer_unreadable: assignment ${assignment.assignment_id} of peer run ${coordinate} could not be read: ${auditDetail(error)}`);
        continue;
      }
      const matched: string[] = [];
      for (const declaration of declarations) {
        for (const declared of classifyOwnershipDeclarations(declaration)) {
          // A peer's prose declaration is the same invisibility on this side of
          // the comparison as on the settling side, so it is counted here too:
          // an empty overlap list means "no overlap among what could be read",
          // and the count is what says how much could not be.
          if (declared.kind === "unclassified") {
            unclassified += 1;
            continue;
          }
          for (const request of requested) {
            // Containment either way: a declared directory covers the file the
            // other side named, and a declared file sits under the other side's
            // directory. Both are the same collision.
            const overlapping = request.value === declared.value
              || request.value.startsWith(`${declared.value}/`)
              || declared.value.startsWith(`${request.value}/`);
            if (overlapping && !matched.includes(request.value)) matched.push(request.value);
          }
        }
      }
      if (!matched.length) continue;
      if (overlaps.length >= maxOverlaps) {
        overlapsTruncated = true;
        continue;
      }
      overlaps.push({ track_id: row.track_id, run_id: row.run_id, assignment_id: assignment.assignment_id, state: assignment.state, paths: matched.sort() });
    }
  }
  overlaps.sort((left, right) => {
    const leftKey = `${left.track_id}/${left.run_id}/${left.assignment_id}`;
    const rightKey = `${right.track_id}/${right.run_id}/${right.assignment_id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  if (peers.length > scanned.length) warnings.push(`inter_run_scan_truncated: ${peers.length} peer runs share this project directory and only the ${maxPeerRuns} most recent were scanned.`);
  if (overlapsTruncated) warnings.push(`inter_run_overlaps_truncated: the report stopped at the ${maxOverlaps}-overlap limit, so this list may be incomplete.`);
  return {
    peer_runs_scanned: scanned.length,
    cwd_shared_by: sharing.length,
    overlaps,
    unclassified_declarations: unclassified,
    truncated: peers.length > scanned.length || overlapsTruncated,
    ...(warnings.length ? { observation_warning: warnings.join(" | ") } : {}),
  };
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
  // Settlement snapshots are cumulative per session, so summing every snapshot
  // re-counts a lane once per settled assignment (the triple-count audit 1 of
  // herdr-redesign/r1 called out). Only the latest snapshot per session counts.
  const latestBySession = new Map<string, TokenUsageObservation>();
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
      const previous = latestBySession.get(assignment.token_usage.session_id);
      if (!previous || Date.parse(assignment.token_usage.observed_at) >= Date.parse(previous.observed_at)) {
        latestBySession.set(assignment.token_usage.session_id, assignment.token_usage);
      }
    }
  }
  for (const usage of latestBySession.values()) {
    for (const [, fieldName] of TOKEN_FIELDS) {
      const nextTokenTotal = tokenTotals[fieldName] + (usage[fieldName] ?? 0);
      if (Number.isSafeInteger(nextTokenTotal)) tokenTotals[fieldName] = nextTokenTotal;
      else {
        tokenTotals[fieldName] = Number.MAX_SAFE_INTEGER;
        saturated = true;
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

async function loadFacts(adapter: HerdrAdapter): Promise<{ facts: OmpRuntimeFacts }> {
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
    throw new McpContractError("omp_fact_bridge_mismatch", "Caller pane has no bootstrap metadata tokens.", "attest", "Start the next OMP turn so its before_agent_start boundary republishes the bridge; if the mismatch persists, restart the OMP process in this pane, then retry the identical call.", false, true);
  }
  const tokens = tokensValue as Record<string, unknown>;
  const namespacedKeys = Object.keys(tokens).filter((key) => key.startsWith(BOOTSTRAP_TOKEN_PREFIX)).sort();
  const expectedKeys = Object.values(BOOTSTRAP_TOKENS).sort();
  if (namespacedKeys.length !== expectedKeys.length || namespacedKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new McpContractError("omp_fact_bridge_mismatch", "Caller pane bootstrap token set is incomplete or contains unexpected namespaced keys.", "attest", "Start the next OMP turn so its before_agent_start boundary republishes the bridge; if the mismatch persists, restart the OMP process in this pane, then retry the identical call.", false, true);
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
  if (tokens[BOOTSTRAP_TOKENS.attestation] !== facts.nonce) {
    throw new McpContractError("omp_fact_bridge_mismatch", "Pane bootstrap metadata and bridge payload disagree.", "attest", "Do not mutate until metadata and fact publication converge.");
  }
  return { facts };
}

type OpenCreatorIdentity =
  | { session_id: string; pane_id: string; verified: true }
  | { pane_id: string; verified: false };

async function runAlreadyInitialized(trackId: string, runId: string, cwd: string): Promise<boolean> {
  const { config } = await loadDelegatorConfig(undefined, cwd);
  const storageRoot = config.storage?.root;
  if (!storageRoot) throw new McpContractError("storage_root_unconfigured", "storage.root is not configured.", "storage", "Configure storage.root before opening a track.");
  try {
    await realpath(path.join(storageRoot, trackId, runId));
    return true;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function loadOpenCreator(
  adapter: HerdrAdapter,
  allowDegraded: boolean,
): Promise<{ identity: OpenCreatorIdentity; mismatch?: McpContractError }> {
  try {
    const { facts } = await loadFacts(adapter);
    return { identity: { session_id: facts.session_id, pane_id: facts.pane_id, verified: true } };
  } catch (error) {
    if (!allowDegraded || !(error instanceof McpContractError) || error.code !== "omp_fact_bridge_mismatch") throw error;
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId || paneId.length > 80 || !BOUNDED_TOKEN_RE.test(paneId)) throw error;
    return { identity: { pane_id: paneId, verified: false }, mismatch: error };
  }
}

function sameOpenCreator(
  existing: NonNullable<DelegationRegistry["orch_creator"]>,
  attempted: OpenCreatorIdentity,
): boolean {
  if (existing.pane_id !== attempted.pane_id) return false;
  if (existing.verified === false || attempted.verified === false) return true;
  return existing.session_id === attempted.session_id;
}

function normalizeLegacyPhase(phase: string): ErrorPhase {
  if (phase.includes("model")) return "model-verify";
  if (phase.includes("bootstrap") || phase.includes("attest")) return "attest";
  if (phase.includes("prompt")) return "prompt";
  if (phase.includes("wait") || phase.includes("inspect")) return "wait";
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
    // Every failure names the code that produced it. The installed plugin is a
    // symlink to a working tree, so a live session can be holding a server whose
    // module graph predates the tree it is reading; without this stamp such a
    // server fails opaquely and the operator debugs the wrong build
    // (friction f53892758a860acf). `source_newer_than_process` is the decisive
    // field: true means this process never loaded the current source.
    return { ok: false, tool, action, run, effect: ambiguous ? "ambiguous" : "none", retryable, ...(hint ? { friction_hint: hint } : {}), error: { code, phase, message, recovery, ambiguous_effect: ambiguous }, data: { build: mountedBuild() } };
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

/**
 * Settles one assignment from its own durable evidence, or leaves it untouched.
 *
 * The predicate is unchanged: the lane is observed idle or failed AND its report
 * carries the tool-recognized completion block with exactly one status line.
 * `warnings` is an optional observation sink — a block that exists but does not
 * parse names itself there instead of degrading into a silent no-op, because a
 * worker that believes it reported and a run that disagrees is precisely the
 * state nobody discovers by reading a registry (friction bbc360a158e3a3bf).
 */
export async function settleIfReported(store: DelegationStore, registry: DelegationRegistry, lane: WorkerLaneRecord, assignment: AssignmentRecord, warnings?: string[]): Promise<DelegationRegistry> {
  if (lane.state !== "idle" && lane.state !== "failed") return registry;
  let report: Buffer;
  try { report = await readFile(path.join(store.runPath, "a2a", `${lane.worker_id}-report.md`)); }
  catch { return registry; }
  const completion = new RegExp(`^\\[Assignment Completion: ${assignment.assignment_id}\\]$([\\s\\S]*?)(?=^\\[[^\\n]+\\]$|(?![\\s\\S]))`, "m").exec(report.toString("utf8"));
  const statuses = completion?.[1].match(/^status: (completed|failed)$/gm) ?? [];
  if (completion && statuses.length !== 1) {
    warnings?.push(`completion_block_unparsable: [Assignment Completion: ${assignment.assignment_id}] in a2a/${lane.worker_id}-report.md carries ${statuses.length} recognized status lines; exactly one line reading "status: completed" or "status: failed" settles it, so the assignment stays ${assignment.state}.`);
  }
  if (!completion || statuses.length !== 1 || !lane.official_session_id || !Number.isSafeInteger(lane.state_change_seq)) return registry;
  const terminal = statuses[0] === "status: failed" ? "failed" as const : "completed" as const;
  const settledAt = nowIso();
  const [tokenUsage, advisoryUnownedChanges] = await Promise.all([
    observeTokenUsage(lane, settledAt),
    observeAdvisoryUnownedChanges(store, registry, warnings),
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
 * Settlement sweep at the observation and consumption points (friction
 * bbc360a158e3a3bf).
 *
 * Settlement used to hang off two call points only, both of them reached by the
 * ORCH's own `add`/`wait` (promptAssignment's tail and the wait tail). A lane
 * that finished while nobody asked therefore stayed `working` in the registry,
 * and the two readers that consume that record as truth — the budget audit's
 * machine facts and `add`'s FIFO placement — read a settled lane as busy. The
 * sweep re-runs the unchanged settlement predicate for every lane holding a live
 * assignment, so the truth is restored by whoever looks, not only by whoever
 * waits.
 *
 * A doorbell is deliberately NOT a trigger: a bell is non-authoritative by
 * contract, so it may point at a report but never settle one.
 *
 * The predicate needs a LIVE lane state, because the stale registry state is
 * exactly the defect; a lane the caller has just observed is passed as `fresh`
 * so one observation is never paid for twice.
 */
export async function sweepSettlements(
  store: DelegationStore,
  run: RunRef,
  registry: DelegationRegistry,
  warnings: string[],
  fresh?: string,
): Promise<DelegationRegistry> {
  let current = registry;
  for (const workerId of Object.keys(current.lanes)) {
    const assignmentId = current.lanes[workerId].active_assignment_id;
    if (!assignmentId) continue;
    const assignment = current.assignments[assignmentId];
    if (!assignment || !ACTIVE_SETTLEMENT_STATES[assignment.state]) continue;
    if (current.lanes[workerId].state !== "idle" && current.lanes[workerId].state !== "failed") {
      if (workerId === fresh) continue;
      try {
        const live = await inspectWorker({ operation: "inspect_worker", track_id: run.track_id, run_id: run.run_id, worker_id: workerId });
        current = await updateLaneFromWorker(store, workerId, live);
      } catch (error) {
        warnings.push(`settlement_sweep_unobserved: lane ${workerId} could not be observed, so assignment ${assignmentId} stays ${assignment.state}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    const before = current.assignments[assignmentId].state;
    current = await settleIfReported(store, current, current.lanes[workerId], current.assignments[assignmentId], warnings);
    const settled = current.assignments[assignmentId].state;
    if (settled === before) continue;
    const promoted = current.lanes[workerId].active_assignment_id;
    warnings.push(`settlement_swept: assignment ${assignmentId} on lane ${workerId} settled as ${settled} from its reported completion block${promoted ? `; queued head ${promoted} promoted` : ""}.`);
  }
  return current;
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
// ---------------------------------------------------------------------------
// Mandate (identity/comms redesign, decision 5). The bootstrapper distills the
// conversation into WHAT and WHY; HOW belongs to the born ORCH, which writes
// plan.md in clean context with the user. The document is persisted as
// orchestrator-instructions.md, which start_orch fingerprints at first prompt
// and refuses to replay after a change — so a mandate is settled before birth,
// never edited behind a living ORCH.
//
// Every published limit is enforced here and names the observed size in its
// rejection (goal-4096 lesson, friction 29239ed8): a caller learns the bound
// from the failure instead of by bisection.
// ---------------------------------------------------------------------------

function mandateBullets(values: readonly string[], field: string): string[] {
  if (values.length > MAX_MANDATE_ITEMS) {
    throw new McpContractError("mandate_too_large", `${field} has ${values.length} entries; the limit is ${MAX_MANDATE_ITEMS}.`, "validate", `Keep at most ${MAX_MANDATE_ITEMS} entries; fold the rest into the intent or leave them to the ORCH's plan.`);
  }
  return values.map((value, index) => {
    const item = singleLine(value);
    if (!item) throw new McpContractError("mandate_invalid", `${field} entry ${index + 1} is empty after single-line normalization.`, "validate", "Give each entry one concrete line, or drop it.");
    if (item.length > MAX_MANDATE_ITEM) {
      throw new McpContractError("mandate_too_large", `${field} entry ${index + 1} is ${item.length} characters; the limit is ${MAX_MANDATE_ITEM}.`, "validate", `Shorten the entry to at most ${MAX_MANDATE_ITEM} characters; a mandate names the boundary, not its reasoning.`);
    }
    return item;
  });
}


// A clean auditor session on the strongest configured reasoning profile. The
// responsibility key exists only to name its pane on the supervision surface:
// an auditor is never a responsibility lane, so the ORCH cannot address it.
const AUDIT_RESPONSIBILITY = "budget-audit";
const AUDIT_PROFILE = "slow";
// Landing attempts before a verdictless audit is abandoned. Each attempt
// re-runs the auditor, so this is one observation plus three genuine retries —
// an explicit policy threshold, deliberately far below the registry validator's
// 64-retry storage bound, which exists to reject an absurd record and was never
// a cadence. Silence past this point is a machine failure to escalate to the
// human, not a verdict to keep waiting for (friction 183b6d4102ddfbfa).
const MAX_AUDIT_LANDING_ATTEMPTS = 4;

/** The mandate's budget section: a declared estimate plus the cadence it buys. */
function budgetSection(mandate: Mandate): string {
  const seeded = seedBudget(mandate, nowIso());
  const declared = mandate.budget?.tokens || mandate.budget?.minutes ? "declared in the mandate" : "not declared; these are the documented defaults";
  return [
    `- seed: ${seeded.seed_tokens} tokens / ${seeded.seed_minutes} minutes (${declared})`,
    `- doorbell policy: ${seeded.doorbell_policy}`,
    "",
    "This seed is a calibration estimate, never a contract. Crossing it parks the run;",
    "you then justify an extension (done / remaining / why more) through",
    "herdr_track budget_extend, a clean auditor judges your run documents against the",
    "machine facts, and the verdict is recorded in budget-ledger.md. Keep plan.md and",
    "the lane reports current: an audit reads them, so stale documents cost budget.",
  ].join("\n");
}

/**
 * The audit ordinal a clamp write cites in its server note: the latest settled
 * extension, which is the approval the written ceiling came from.
 */
function lastSettledAuditOrdinal(record: BudgetRecord): number {
  for (let index = record.extensions.length - 1; index >= 0; index -= 1) {
    const entry = record.extensions[index];
    if (entry.state === "settled") return entry.ordinal;
  }
  return record.extensions.length;
}

/** Bounded machine facts for the auditor: what the registry knows, not what the ORCH says. */
function machineFacts(registry: DelegationRegistry): string[] {
  const totals = trackTotals(registry);
  const facts = [
    `lanes: ${totals.lane_count}; assignments by state: ${ASSIGNMENT_STATE_ORDER.map((state) => `${state}=${totals.assignments_by_state[state]}`).join(" ")}`,
    `settled observations: ${totals.settled_elapsed_observations} elapsed (${totals.settled_elapsed_ms} ms), ${totals.settled_token_usage.observations} token snapshots (${totals.settled_token_usage.total_tokens} tokens)`,
    `ORCH generations born: ${(registry.orch_births ?? []).length}`,
  ];
  for (const assignment of Object.values(registry.assignments)) {
    facts.push(`assignment ${assignment.assignment_id} (${assignment.responsibility_key}, lane ${assignment.worker_id}): state ${assignment.state}${assignment.report_sha256 ? `, report sha256=${assignment.report_sha256}` : ", no verified report hash"}${assignment.completed_at ? `, settled ${assignment.completed_at}` : ""}`);
  }
  return facts.slice(0, 64);
}

export function renderMandate(run: RunRef, mandate: Mandate): string {
  const intent = mandate.intent.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!intent) throw new McpContractError("mandate_invalid", "The mandate intent is empty after normalization.", "validate", "State why this track exists and what it must achieve, in the user's terms.");
  if (intent.length > MAX_MANDATE_INTENT) {
    throw new McpContractError("mandate_too_large", `The mandate intent is ${intent.length} characters; the limit is ${MAX_MANDATE_INTENT}.`, "validate", `Shorten the intent to at most ${MAX_MANDATE_INTENT} characters; a mandate carries WHAT and WHY, and the ORCH writes the detail into plan.md.`);
  }
  const constraints = mandateBullets(mandate.constraints, "Constraints");
  const success = mandateBullets(mandate.shape_of_success, "Shape of success");
  const document = `---
version: 1
track_id: ${run.track_id}
run_id: ${run.run_id}
---

# Mandate

You are the orchestrator born for run ${run.track_id}/${run.run_id}. This document is
your mandate: it fixes what this track must achieve and why, and deliberately says
nothing about how. The session that wrote it has died for this track and will not
answer for it — the user converses with you now, in this pane.

Before delegating anything, write plan.md in this run directory in conversation with
the user. The plan is yours; it is the only place how belongs.

## Intent

${intent}

## Constraints

${constraints.length ? constraints.map((item) => `- ${item}`).join("\n") : "- None recorded at open; the mandate imposes no boundary beyond the intent above."}

## Shape of success

${success.map((item) => `- ${item}`).join("\n")}

## Budget

${budgetSection(mandate)}
`;
  const bytes = Buffer.byteLength(document);
  if (bytes > MAX_MANDATE_BYTES) {
    throw new McpContractError("mandate_too_large", `The rendered mandate is ${bytes} bytes; the limit is ${MAX_MANDATE_BYTES}.`, "validate", `Shorten the intent or drop entries until the whole document fits in ${MAX_MANDATE_BYTES} bytes.`);
  }
  return document;
}

export class CompositeTools {
  constructor(private readonly adapter: HerdrAdapter) {}

  async track(input: HerdrTrackInput): Promise<McpResult> {
    const run = runRef(input);
    try {
      if (input.action === "open") return await this.openTrack(input, run);
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
        try { await loadFacts(this.adapter); orchestrator = await inspectOrchestrator({ operation: "inspect_orch", track_id: input.track_id, run_id: input.run_id }); } catch (error) { orchestrator = { unavailable: error instanceof Error ? error.message : String(error) }; }
        const budget = await this.observeBudget(store, registry);
        const inboundChannels = await observeInboundChannels(store);
        return { ok: true, tool: "herdr_track", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, data: { registry, orchestrator, totals: trackTotals(registry), budget, inbound_channels: inboundChannels } };
      }
      if (input.action === "budget_extend") return await this.extendBudget(input, run, store);
      const runtime = await loadFacts(this.adapter);
      if (input.action === "start_orchestrator") {
        // Legacy compatibility path only. On an open-managed run the spawn is
        // owned by `open`, so allowing it here would hand any attested session a
        // generation bump around the creator lockout.
        if ((await store.read()).orch_creator) throw new McpContractError("track_opened_atomically", "This run was opened with herdr_track open, which owns its ORCH spawn.", "attest", "Re-run herdr_track open with the identical mandate to reconcile the ORCH; start_orchestrator remains only for runs created by init.");
        const result = await startOrchestrator({ operation: "start_orch", track_id: input.track_id, run_id: input.run_id });
        const birth = await this.recordSpawnBirth(store, result.orchestrator);
        return { ok: true, tool: "herdr_track", action: input.action, run, effect: "confirmed", retryable: false, data: { ...result, ...(birth ? { orch_birth: birth } : { orch_birth_warning: "Spawned ORCH identity incomplete; birth not recorded — its first guarded command claims this run." }) } };
      }
      if (input.action === "revive") return await this.reviveTrack(input, run, store, runtime);
      const forced = await this.authorizeClose(store, run, runtime.facts);
      await this.judgeBudget(store, run, "close");
      const registry = await store.read();
      if (registry.revision !== input.expected_registry_revision) throw new McpContractError("stale_registry_revision", "Track close registry revision is stale.", "close", "Inspect the track and retry only from its fresh revision.", false, true);
      // A lane that never reached a live session is never-born, not unsettled:
      // `select` stamps `starting` before `ensure_worker` runs, so a rejected
      // dispatch used to leave a worker-less `starting` lane that no close path
      // accepted — the run itself could never be closed (friction
      // cf7c4a8eb2bdb9c1). It carries nothing to settle and is collected below
      // with the rest of the lanes.
      const neverBorn = (lane: WorkerLaneRecord): boolean =>
        lane.state === "starting" && !lane.official_session_id && !lane.official_session_path;
      const unsafe = Object.values(registry.lanes).filter((lane) => lane.state !== "idle" && lane.state !== "closed" && lane.state !== "failed" && !neverBorn(lane));
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
      if (forced) {
        // Durable attribution for a closure no ORCH authorized. The ledger is an
        // append-only run document, so the record survives independently of
        // whoever reads the registry next — and a laneless run's closure would
        // otherwise be indistinguishable from a no-op revision bump.
        await appendLedger(store.runPath, "closed (human-approved force)", [
          `closed_by session ${forced.closedBySessionId} (attested, not this run's ORCH)`,
          `approval ${forced.approval.path} sha256 ${forced.approval.sha256}: ${singleLine(forced.approval.reason)}`,
          `approved generation ${forced.generation}, proven gone: ${forced.evidence}`,
          `closed_at ${forced.closedAt}`,
        ]).catch(() => undefined);
        await appendMessageLog(store.runPath, {
          at: forced.closedAt,
          kind: "track_closed_force",
          closed_by: forced.closedBySessionId,
          approval_sha256: forced.approval.sha256,
          approved_generation: forced.generation,
          dead_orch_evidence: forced.evidence,
        });
      }
      return { ok: true, tool: "herdr_track", action: input.action, run, effect: "confirmed", retryable: false, registry_revision: closed.revision, data: { closed_workers: Object.keys(closed.lanes), ...(forced ? { forced_close: { closed_by: forced.closedBySessionId, closed_at: forced.closedAt, approved_generation: forced.generation, approval: { path: forced.approval.path, sha256: forced.approval.sha256, reason: forced.approval.reason }, dead_orch_evidence: forced.evidence } } : {}) } };
    } catch (error) { return resultError("herdr_track", input.action, run, error); }
  }

  /**
   * Authorizes a track close. The normal answer is the ORCH-only gate, unchanged:
   * a run with a live ORCH is closed by that ORCH and nothing else.
   *
   * The exception exists because ORCH-only left a real hole: when the recorded
   * ORCH is gone for good — pane closed, session not resumable, no documents to
   * rebirth from — every close was refused forever and the run could never be
   * disposed of (friction 5a95bb71e1a73d73). What the dead ORCH can no longer
   * exercise belongs to the human, so the substitute for `assertOrchCommand` is
   * the human's approval file plus proof of death, never a second agent's word:
   * the caller is still attested, the approval still names this run and this
   * generation, and the recorded ORCH is still proven absent by fresh
   * observation. Anything ambiguous refuses.
   */
  private async authorizeClose(
    store: DelegationStore,
    run: RunRef,
    facts: OmpRuntimeFacts,
  ): Promise<{ approval: { path: string; sha256: string; reason: string }; generation: number; evidence: string; closedBySessionId: string; closedAt: string } | undefined> {
    try {
      await assertOrchCommand(store, facts);
      return undefined;
    } catch (error) {
      // Only an identity refusal is eligible: the approval file substitutes for
      // ORCH identity and for nothing else, so a storage or attestation failure
      // stays exactly as fatal as it was.
      if (!(error instanceof McpContractError) || !CLOSE_FORCE_ELIGIBLE_CODES[error.code]) throw error;
      const born = latestBirth(await store.read());
      if (!born) throw error;
      const approval = await readCloseApproval(store.runPath, run, born.generation);
      const evidence = await this.assertRecordedOrchGone(born, facts.pane_id);
      return { approval, generation: born.generation, evidence, closedBySessionId: facts.session_id, closedAt: nowIso() };
    }
  }

  /**
   * Proof, by fresh observation, that a recorded ORCH is gone. Absence has to be
   * proven rather than assumed: this path closes a run against its ORCH's
   * authority, so a live or merely unobservable ORCH must refuse. Returns the
   * evidence sentence for the closure record.
   */
  private async assertRecordedOrchGone(born: OrchBirthRecord, callerPaneId: string): Promise<string> {
    const refuseAmbiguous = (detail: string): never => {
      throw new McpContractError(
        "orch_liveness_unknown",
        `The recorded ORCH (generation ${born.generation}, session ${born.official_session_id}) could not be proven gone: ${detail}.`,
        "close",
        "Nothing was closed. Observe the recorded pane and session directly, then retry once absence is observable — this path never assumes a silence means death.",
        false,
        true,
      );
    };
    let agents: unknown;
    try { agents = (await this.adapter.listAgents(DEFAULT_TIMEOUT_MS)).data; }
    catch (error) { return refuseAmbiguous(`the Herdr agent list could not be read (${error instanceof Error ? error.message : String(error)})`); }
    const liveSessionReferences = matchingObjects(
      agents,
      (candidate) => candidate.source === "herdr:omp" && candidate.agent === "omp" && typeof candidate.value === "string",
    ).map((candidate) => candidate.value as string);
    // An absence read from a census that cannot even see the caller is not
    // evidence of absence: an empty or truncated agent list would otherwise read
    // exactly like a dead ORCH. The caller's own pane is the one entry the list
    // must contain, so its presence is what makes this observation a census.
    const observedPaneIds = new Set(
      matchingObjects(agents, (candidate) => typeof candidate.pane_id === "string").map((candidate) => candidate.pane_id as string),
    );
    if (!observedPaneIds.has(callerPaneId)) {
      refuseAmbiguous(`the Herdr agent list does not report the calling pane ${callerPaneId}, so it is not a census this path can read absence from`);
    }
    const recordedIsLive = liveSessionReferences.some((value) => {
      if (value === born.official_session_id) return true;
      const stem = path.basename(value).replace(/\.jsonl$/, "");
      return stem === born.official_session_id || stem.endsWith(`_${born.official_session_id}`);
    });
    if (recordedIsLive) {
      throw new McpContractError(
        "orch_still_live",
        `The recorded ORCH (generation ${born.generation}, session ${born.official_session_id}) is live, so this run is not orphaned.`,
        "close",
        `Nothing was closed. Close this run from its own ORCH pane ${born.pane_id}: an approval file never overrides a live ORCH, and the human's approval was for a run whose ORCH is gone.`,
      );
    }
    let paneEvidence = "the recorded pane is absent";
    try {
      const pane = await this.adapter.getPane(born.pane_id, DEFAULT_TIMEOUT_MS);
      const stillThere = matchingObjects(pane.data, (candidate) => candidate.pane_id === born.pane_id).length > 0;
      paneEvidence = stillThere
        ? `the recorded pane ${born.pane_id} exists but carries no reference to the recorded session`
        : `the recorded pane ${born.pane_id} is no longer reported`;
    } catch (error) {
      // A pane the daemon cannot resolve is the ordinary shape of a closed pane;
      // the agent list above already carried the decisive absence.
      paneEvidence = `the recorded pane ${born.pane_id} is unresolvable (${error instanceof McpContractError ? error.code : "observation failed"})`;
    }
    return `no live Herdr agent references session ${born.official_session_id}; ${paneEvidence}`;
  }

  /**
   * The single atomic op that opens a track (decisions 1, 3, 4, 5): ensure the
   * track space and run scaffolding, fix the mandate, spawn the ORCH pane
   * pre-aligned to the configured orchestrator role, and record its birth.
   *
   * Partial-failure semantics are fail-closed and re-entrant rather than
   * compensating, because the committed pieces are exactly the ones it is never
   * safe to delete blindly:
   *  - before the creator stamp: nothing identity-bearing exists. A failure
   *    leaves at most an initialized run directory and a mandate file, and the
   *    identical call reconciles them.
   *  - the creator stamp lands before the spawn, so a failed spawn leaves a run
   *    that no session can command and no session can claim: only this creator,
   *    re-running the identical open, can finish the birth.
   *  - birth and retirement are the same record write: the creator is retired
   *    exactly when an ORCH exists to replace it, never before.
   * Residue a failure can leave — the run directory, the mandate, the track
   * space, and (past the spawn) the ORCH pane — is named in the failure's
   * recovery text and reused by the retry; nothing is orphaned silently.
   */
  private async openTrack(input: Extract<HerdrTrackInput, { action: "open" }>, run: RunRef): Promise<McpResult> {
    // Cheapest gate first: a malformed mandate is the caller's own input and is
    // rejected without spending an attestation round trip.
    const document = renderMandate(run, input.mandate);
    const mandateHash = sha256(document);
    const freshCoordinate = !(await runAlreadyInitialized(input.track_id, input.run_id, input.cwd));
    const creatorAttempt = await loadOpenCreator(this.adapter, freshCoordinate);

    const scaffolding = await initializeRun({ operation: "init_run", track_id: input.track_id, run_id: input.run_id, cwd: input.cwd });
    const store = await DelegationStore.resolve(input.track_id, input.run_id);
    const opened = await store.read();
    const creator = opened.orch_creator;
    if (creatorAttempt.mismatch && (creator || latestBirth(opened))) throw creatorAttempt.mismatch;
    if (creator && creator.mandate_sha256 !== mandateHash) {
      throw new McpContractError("mandate_conflict", "This run was already opened with a different mandate.", "validate", "Open a sibling run for a different mandate; a settled mandate is never rewritten behind a live ORCH.");
    }
    const born = latestBirth(opened);
    if (born) {
      return { ok: true, tool: "herdr_track", action: "open", run, effect: "none", retryable: false, registry_revision: opened.revision, data: { already_open: true, creator, creator_verified: creator?.verified !== false, orch_birth: born, orch_pane_id: born.pane_id, space: `herdr/${input.track_id}`, orch_pane: `ORCH ${input.track_id}/${input.run_id}`, mandate: { path: path.join(store.runPath, "orchestrator-instructions.md"), sha256: mandateHash }, next_step: `This track is already commanded by its ORCH pane ${born.pane_id} ("ORCH ${input.track_id}/${input.run_id}"). Direct the user there and do no further work on this track here.` } };
    }
    if (creator && !sameOpenCreator(creator, creatorAttempt.identity)) {
      throw new McpContractError("track_open_in_progress", "Another caller is opening this run and its ORCH is not born yet.", "attest", "Let the opening caller finish or retry its identical open; a second opener would race the same birth.");
    }

    const instructionPath = path.join(store.runPath, "orchestrator-instructions.md");
    let existingMandate: Buffer | undefined;
    try { existingMandate = await readFile(instructionPath); }
    catch (error: unknown) { if (!isObject(error) || error.code !== "ENOENT") throw new McpContractError("mandate_unreadable", "The run's orchestrator-instructions.md cannot be read safely.", "storage", "Inspect the run directory; never overwrite an unreadable mandate."); }
    if (existingMandate && sha256(existingMandate) !== mandateHash) {
      throw new McpContractError("mandate_conflict", "This run already holds a different orchestrator-instructions.md.", "validate", "Open a sibling run for a different mandate; the instruction file is fingerprinted at first prompt and never replayed after a change.");
    }
    if (!existingMandate) await writeAtomic(instructionPath, document);

    const stamped = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
      if (creatorAttempt.mismatch && next.orch_creator) throw creatorAttempt.mismatch;
      if (next.orch_creator && !sameOpenCreator(next.orch_creator, creatorAttempt.identity)) {
        throw new McpContractError("track_open_in_progress", "Another caller claimed this open while the mandate was being fixed.", "attest", "Let the opening caller finish; a second opener would race the same birth.");
      }
      next.orch_creator = creatorAttempt.identity.verified
        ? { session_id: creatorAttempt.identity.session_id, pane_id: creatorAttempt.identity.pane_id, mandate_sha256: mandateHash, opened_at: nowIso(), verified: true }
        : { pane_id: creatorAttempt.identity.pane_id, mandate_sha256: mandateHash, opened_at: nowIso(), verified: false };
      // The seed is a calibration estimate, and the clock starts at the open that
      // will spawn the ORCH — not at the first guarded op, so an idle-but-live run
      // still ages against its declared wall clock.
      next.budget ??= seedBudget(input.mandate, nowIso());
    });
    const seeded = stamped.budget ?? seedBudget(input.mandate, nowIso());
    const stampedCreator = stamped.orch_creator;
    if (!stampedCreator) throw new McpContractError("creator_stamp_missing", "The open creator stamp did not persist.", "storage", "Preserve the initialized run and retry the identical open.");
    const clampScaffold = await scaffoldClamp(store.runPath);
    await appendLedger(store.runPath, "seed", [
      `seed: ${seeded.seed_tokens} tokens / ${seeded.seed_minutes} min (declared estimate, not a contract)`,
      `doorbell policy: ${seeded.doorbell_policy}`,
      clampSchemaGuidance(store.runPath),
      `creator verification: ${stampedCreator.verified === false ? "unverified (omp_fact_bridge_mismatch)" : "attested"}`,
      "metering basis: high-water context size (max of input+cacheRead+cacheWrite+output+reasoning across a session's assistant turns), not cumulative per-turn spend — seeds sized for the older cumulative meter read larger than what this basis will judge",
    ]).catch(() => undefined);
    // Advisory delivery surface, never a gate: the document is rendered (or
    // degrades to a document naming its own failure) before the spawn, and only
    // a failed write is reported — open proceeds either way.
    const guidance = await materializeGuidance(store.runPath);

    const spawned = await startOrchestrator({ operation: "start_orch", track_id: input.track_id, run_id: input.run_id });
    const birth = await this.recordSpawnBirth(store, spawned.orchestrator);
    if (!birth) {
      throw new McpContractError("orch_birth_incomplete", "The ORCH pane started but did not report a bounded official session identity, so no birth was recorded.", "attest", `Re-run the identical herdr_track open: the spawned pane is preserved, its first prompt is not replayed, and the retry records the birth once Herdr reports the session. The creator still owns this run until then.`);
    }
    const observation = isObject(spawned.observation) ? spawned.observation : {};
    const permission = openPermissionAdvisory(observation);
    const creatorWarning = stampedCreator.verified === false
      ? "Opening creator is unverified because pane attestation failed with omp_fact_bridge_mismatch; existing-run operations remain fail-closed."
      : undefined;
    const warnings = [observation.role_fallback_warning, observation.pane_label_warning, observation.template_drift_warning, guidance.warning, permission?.warning, creatorWarning, clampScaffold.warning].filter((value): value is string => typeof value === "string");
    const retirementText = stampedCreator.verified === false
      ? "the unverified opening pane is retired for this track and cannot issue guarded calls"
      : "this session is retired for this track and every guarded call it makes now fails with creator_session_retired";
    // No skill routes here: plan and authoring boundaries belong to the ORCH,
    // and this result is read by the session that just retired.
    return {
      ok: true,
      tool: "herdr_track",
      action: "open",
      run,
      effect: "confirmed",
      retryable: false,
      registry_revision: stamped.revision,
      data: {
        run: scaffolding.run,
        space: `herdr/${input.track_id}`,
        orch_pane: typeof observation.pane_label === "string" ? observation.pane_label : `ORCH ${input.track_id}/${input.run_id}`,
        orch_pane_id: birth.pane_id,
        orch_birth: birth,
        mandate: { path: instructionPath, sha256: mandateHash, bytes: Buffer.byteLength(document) },
        creator: stampedCreator,
        creator_verified: stampedCreator.verified !== false,
        ...(stampedCreator.session_id ? { creator_retired: stampedCreator.session_id } : {}),
        next_step: `This track's ORCH is born in pane ${birth.pane_id} ("ORCH ${input.track_id}/${input.run_id}"). Tell the user to continue there: ${retirementText}. Do not accumulate more context on this track here.`,
        ...(warnings.length ? { warnings } : {}),
        ...(permission ? { orch_blocked_on_permission: permission.field } : {}),
      },
    };
  }

  /** Records the spawned target ORCH as a birth generation (idempotent per identity). */
  private async recordSpawnBirth(store: DelegationStore, orchestrator: unknown, origin: OrchBirthOrigin = "spawn", approvalSha256?: string): Promise<OrchBirthRecord | undefined> {
    const paneId = stringField(orchestrator, ["pane_id"]);
    const sessionId = stringField(orchestrator, ["session_id"]);
    const sessionPath = stringField(orchestrator, ["session_path"]);
    if (!paneId || !sessionId || paneId.length > 80 || sessionId.length > 80 || !BOUNDED_TOKEN_RE.test(paneId) || !BOUNDED_TOKEN_RE.test(sessionId)) return undefined;
    let recorded: OrchBirthRecord | undefined;
    await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
      const births = next.orch_births ?? [];
      const latest = births[births.length - 1];
      if (latest && latest.official_session_id === sessionId && latest.pane_id === paneId) { recorded = latest; return; }
      recorded = { generation: births.length + 1, official_session_id: sessionId, ...(sessionPath && sessionPath.length <= 4096 ? { official_session_path: sessionPath } : {}), pane_id: paneId, origin, ...(approvalSha256 ? { approval_sha256: approvalSha256 } : {}), born_at: nowIso() };
      next.orch_births = [...births, recorded];
    });
    return recorded;
  }

  /**
   * Revival (decision 9). The commanding ORCH may be exactly what is missing, so
   * this is the one guarded-shaped op that does not require the caller to be the
   * birth session — but it still cannot transfer command:
   *  - `resume` reconnects the recorded birth session by its official path. The
   *    extension refuses if the session that comes back is a different one, and
   *    the birth record is rewritten only when identity is unchanged, so no
   *    generation appears and no caller gains command by reviving.
   *  - `rebirth` does create generation+1, so it is gated on the human's approval
   *    file, on run documents sufficient to reconstruct command, on no ambiguous
   *    work, and on the old ORCH not being live.
   * A zombie — any session from a retired generation — is rejected either way:
   * revival is not a way back for a generation that was already replaced.
   */
  private async reviveTrack(
    input: Extract<HerdrTrackInput, { action: "revive" }>,
    run: RunRef,
    store: DelegationStore,
    runtime: { facts: OmpRuntimeFacts },
  ): Promise<McpResult> {
    const mode = input.mode ?? "resume";
    const before = await store.read();
    const born = latestBirth(before);
    if (!born) {
      throw new McpContractError("orch_birth_missing", "This run has no ORCH birth record, so there is nothing to revive.", "resume", "Open the track (or start its ORCH on a legacy run); revival restores a birth that already happened.");
    }
    const priorGeneration = (before.orch_births ?? []).some((birth) => birth.generation !== born.generation && birth.official_session_id === runtime.facts.session_id);
    if (priorGeneration) {
      throw new McpContractError("stale_orch_generation", `Caller session belongs to a retired ORCH generation; generation ${born.generation} is this run's ORCH.`, "attest", "A replaced generation does not revive itself. Converse with the current ORCH pane, or ask the human to approve a rebirth if that generation is gone for good.");
    }

    let approval: { sha256: string; reason?: string } | undefined;
    let documents: { path: string; bytes: number; sha256: string }[] | undefined;
    let retired: unknown;
    if (mode === "rebirth") {
      assertNoAmbiguousWork(before);
      documents = await assertRevivalDocuments(store.runPath);
      approval = await readRebirthApproval(store.runPath, born.generation + 1);
      const retirement = await retireOrchestratorSession({ operation: "retire_orch_session", track_id: run.track_id, run_id: run.run_id });
      retired = retirement.observation;
    }
    // A revived ORCH — resumed or reborn — must see the configuration that is
    // current now, not the rendering its first birth got. Best-effort as at open.
    const guidance = await materializeGuidance(store.runPath);

    const started = await startOrchestrator({ operation: "start_orch", track_id: run.track_id, run_id: run.run_id });
    const observedSession = stringField(started.orchestrator, ["session_id"]);
    if (mode === "resume" && observedSession && observedSession !== born.official_session_id) {
      // Fail closed: a resume that came back as a different session is a context
      // loss nobody approved, so it is never recorded as a birth.
      throw new McpContractError(
        "revival_session_changed",
        `Resume reconnected session ${observedSession}, not the recorded birth session ${born.official_session_id}.`,
        "resume",
        "Nothing was recorded. Inspect the track before retrying: if the recorded session is truly gone, a clean rebirth is the approved path, not a silent replacement.",
        true,
      );
    }
    const birth = await this.recordSpawnBirth(store, started.orchestrator, mode === "rebirth" ? "rebirth" : "spawn", approval?.sha256);
    const after = await store.read();
    // A parked run is revivable — that is the point of parking rather than dying
    // — but the spawn just relabelled the pane to its plain name, so the budget
    // marker has to be re-applied and the ledger has to carry the revival.
    const budgetRecord = after.budget;
    const warnings: string[] = [];
    if (birth && budgetRecord) {
      const marker = await labelOwnedPane(birth.pane_id, orchPaneLabel(run, budgetRecord));
      if (marker) warnings.push(marker);
      await appendLedger(store.runPath, `revived (${mode})`, [
        `generation ${birth.generation} (${birth.origin}) in pane ${birth.pane_id}`,
        `budget state at revival: ${budgetRecord.state}${budgetRecord.park_reason ? ` (${budgetRecord.park_reason})` : ""}`,
        ...(approval ? [`human approval ${approval.sha256}${approval.reason ? `: ${approval.reason}` : ""}`] : []),
      ]).catch(() => undefined);
    }
    const observation = isObject(started.observation) ? started.observation : {};
    for (const candidate of [observation.role_fallback_warning, observation.pane_label_warning, observation.template_drift_warning, guidance.warning]) {
      if (typeof candidate === "string") warnings.push(candidate);
    }
    return {
      ok: true,
      tool: "herdr_track",
      action: "revive",
      run,
      effect: "confirmed",
      retryable: false,
      registry_revision: after.revision,
      data: {
        mode,
        orch_birth: birth,
        generation_before: born.generation,
        context_kept: mode === "resume",
        orch_pane: typeof observation.pane_label === "string" ? observation.pane_label : `ORCH ${run.track_id}/${run.run_id}`,
        ...(retired ? { retired_session: retired } : {}),
        ...(documents ? { documents } : {}),
        ...(approval ? { approval: { path: rebirthApprovalPath(store.runPath), sha256: approval.sha256, ...(approval.reason ? { reason: approval.reason } : {}) } } : {}),
        ...(budgetRecord ? { budget: { state: budgetRecord.state, ...(budgetRecord.park_reason ? { park_reason: budgetRecord.park_reason } : {}) } } : {}),
        orchestrator: started.orchestrator,
        next_step: mode === "resume"
          ? `Generation ${born.generation} is back in pane ${birth?.pane_id ?? "its anchor pane"} with its context. Converse there; nothing about command identity changed.`
          : `Generation ${birth?.generation ?? born.generation + 1} is born in pane ${birth?.pane_id ?? "its anchor pane"} with no inherited context. It reads the mandate and plan.md; the retired session is named in data.retired_session and is not coming back.`,
        ...(warnings.length ? { warnings } : {}),
      },
    };
  }

  /**
   * Read-only budget view for `inspect`: the record, the human clamp, and a
   * fresh conservative metering. It never transitions state — an observation
   * that could park a run would make inspection unsafe to run.
   */
  private async observeBudget(store: DelegationStore, registry: DelegationRegistry): Promise<Record<string, unknown>> {
    const record = registry.budget ?? seedBudget(undefined, registry.created_at);
    const clampReading = await readClamp(store.runPath);
    const metering = await meterRun(registry, record, clampReading.clamp);
    return {
      record,
      metering,
      ledger_path: budgetLedgerPath(store.runPath),
      clamp_path: budgetClampPath(store.runPath),
      ...(clampReading.unreadable ? { clamp_unreadable: clampReading.unreadable } : {}),
      ...(clampReading.clamp ? { clamp: clampReading.clamp } : {}),
    };
  }

  /**
   * Applies the classification-time repairs — the T2 self-heal and the X1
   * clear-heal — and returns the record to classify with.
   *
   * BOTH classification sites run this: the judgment every guarded op makes and
   * the grant path's own pre-settle read. The grant path needs it because a lost
   * `confirmed` promotion is repaired by whichever classification observes the
   * disk next, and a `budget_extend` does not judge the budget first — so a
   * crash between a successful clamp write and its promotion, followed directly
   * by another extension, would otherwise let the server's OWN bytes classify
   * as a human pin and freeze the ceiling it had just raised.
   */
  private async healClampState(store: DelegationStore, reading: ClampReading, record: BudgetRecord): Promise<BudgetRecord> {
    const owed = record.server_clamp_tokens;
    if (owed?.intended === undefined || owed.intended === owed.confirmed) return record;
    // Probe a copy first: `store.mutate` always bumps the revision, so a
    // no-op repair must not write the registry at every guarded op.
    if (!healClampTokens(reading, { ...record, server_clamp_tokens: { ...owed } })) return record;
    const healed = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
      const current = next.budget ?? seedBudget(undefined, next.created_at);
      healClampTokens(reading, current);
      next.budget = current;
    });
    return healed.budget ?? record;
  }

  /**
   * The budget judgment every guarded op makes (decisions 7-8). Over the cap the
   * run parks explicitly — reason in the registry, entry in the append-only
   * ledger, marker on the ORCH pane name — and only the landing allowlist still
   * runs: `wait` may settle work already in flight and `close` may clean up,
   * while `add` and `resume` (new or restarted work) are refused. Nothing here
   * ever kills a session: a parked run waits, and phase 6 revives it.
   */
  private async judgeBudget(store: DelegationStore, run: RunRef, action: "add" | "wait" | "resume" | "close"): Promise<{ metering: BudgetMetering; parked: boolean; warning?: string }> {
    const registry = await store.read();
    const notify = (registry.budget ?? seedBudget(undefined, registry.created_at)).doorbell_policy === "notify";
    const warnings: string[] = [];
    // Classification read — the first of the owed case's three deliberate clamp
    // reads (trigger, helper, metering; never collapsed into one). The two heals
    // and the owed-write reconcile run HERE, before the metering read below:
    // write first, then read fresh, so the healing op itself never parks on the
    // stale cap, rings no doorbell, and appends no reversed ledger entry.
    const triggerReading = await readClamp(store.runPath);
    let record = await this.healClampState(store, triggerReading, registry.budget ?? seedBudget(undefined, registry.created_at));
    // The reconcile completes an audit-approved write, never a human keystroke:
    // with the grant path gated on write permission, every owed `intended` was
    // recorded by a settled grant whose write was permitted at settle time.
    const reconcileValue = notify ? clampReconcileValue(triggerReading, record) : undefined;
    if (reconcileValue !== undefined) {
      const outcome = await writeClampMaxTokens(store.runPath, reconcileValue, record, lastSettledAuditOrdinal(record));
      if (outcome.outcome === "written") {
        try {
          const promoted = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
            const current = next.budget ?? seedBudget(undefined, next.created_at);
            current.server_clamp_tokens = { ...current.server_clamp_tokens, confirmed: outcome.value };
            next.budget = current;
          });
          record = promoted.budget ?? record;
        } catch (error) {
          warnings.push(`The reconciled ceiling ${outcome.value} reached the clamp file but its promotion in the registry failed (${error instanceof Error ? error.message : String(error)}); the next guarded op's classification heals it.`);
        }
      } else if (outcome.outcome === "failed") {
        warnings.push(outcome.warning);
      }
    }
    // Metering read: fresh, so a reconcile that just landed is already in the cap.
    const clampReading = await readClamp(store.runPath);
    const metering = await meterRun(registry, record, clampReading.clamp);
    const lastExtension = record.extensions[record.extensions.length - 1];
    // One predicate, token axis only (`pin_present`): a human-valued max_tokens is
    // a permanent ceiling on exactly the dimension a token grant would raise, so
    // an over-cap token axis under a pin is a human decision, not a cadence step.
    // A run over on minutes only keeps `over-cap`, because a grant raises
    // granted_minutes and an extension there genuinely helps.
    const pinPresent = notify && classifyClampTokens(clampReading, record) === "pinned";
    const tokenAxisOver = metering.judged_tokens >= metering.cap_tokens;
    const reason: BudgetParkReason | undefined = clampReading.unreadable
      ? "clamp-unreadable"
      : !metering.over_cap
        ? undefined
        : lastExtension?.verdict === "deny"
          ? "denied"
          : record.doorbell_policy === "full" && record.granted_tokens > (clampReading.clamp?.max_tokens ?? record.seed_tokens)
            ? "approval-required"
            : pinPresent && tokenAxisOver
              ? "approval-required"
              : "over-cap";
    const pinnedCeiling = clampReading.clamp?.max_tokens;
    const pinDetail = `${budgetClampPath(store.runPath)} holds a human-set max_tokens (${pinnedCeiling}): the token ceiling is the human's decision and no tool op raises it.`;
    // The terminating signal on the last axis: a settled extension that moved
    // nothing (0 tokens, therefore 0 minutes) under a pin leaves budget_extend
    // with nothing to buy, so every surface routes to the human instead of back
    // to the extend op. No extend/zero-grant/interval loop exists on any axis.
    const zeroMoveSettled = pinPresent && lastExtension?.state === "settled" && (lastExtension.granted_tokens ?? 0) === 0;
    const zeroMoveClause = zeroMoveSettled
      ? ` Extension ${lastExtension?.ordinal} settled granting 0 tokens and 0 minutes, so budget_extend has nothing left to buy: this is the human's decision, not a retry.`
      : "";
    const minutesExceptionOpen = pinPresent
      && !zeroMoveSettled
      && metering.elapsed_minutes >= metering.cap_minutes
      && clampReading.clamp?.max_minutes === undefined;
    const humanRoute = `Escalate to the human with ${budgetLedgerPath(store.runPath)}; only they change ${budgetClampPath(store.runPath)}. Raising max_tokens above the judged spend releases this park directly, an edit at or below it keeps the pin, and deleting max_tokens hands the ceiling back so the next approved grant resumes automatic raises.`;
    const detail = clampReading.unreadable
      ? `The human-owned clamp file cannot be trusted: ${clampReading.unreadable}. No tool op raises what the human lowered, so the run waits.`
      : reason !== undefined && pinPresent
        ? `${meteringLedgerLine(metering)}. ${pinDetail}${zeroMoveClause}`
        : `${meteringLedgerLine(metering)}.`;
    const clampScaffold = reason ? await scaffoldClamp(store.runPath) : undefined;
    if (reason && (record.state !== "parked" || record.park_reason !== reason)) {
      const parked = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
        const current = next.budget ?? seedBudget(undefined, next.created_at);
        current.state = "parked";
        current.park_reason = reason;
        current.park_detail = detail.slice(0, 500);
        current.parked_at = nowIso();
        next.budget = current;
      });
      await this.budgetDoorbell(store, run, registry, parked.budget ?? record, `parked (${reason})`, [detail]);
    } else if (!reason && record.state === "parked") {
      const resumed = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
        const current = next.budget ?? seedBudget(undefined, next.created_at);
        current.state = "active";
        delete current.park_reason;
        delete current.park_detail;
        delete current.parked_at;
        next.budget = current;
      });
      await this.budgetDoorbell(store, run, registry, resumed.budget ?? record, "resumed", [detail]);
    }
    if (!reason) {
      // Approach warning: one doorbell at 80% of the effective cap, without
      // parking. The armed state lives in the server-owned record and re-arms
      // only when the effective cap changes (clamp edit or granted extension).
      const warned = record.approach_warned;
      const capChanged = warned !== undefined && (warned.cap_tokens !== metering.cap_tokens || warned.cap_minutes !== metering.cap_minutes);
      const approaching = metering.judged_tokens >= metering.cap_tokens * 0.8 || metering.elapsed_minutes >= metering.cap_minutes * 0.8;
      if (approaching && (warned === undefined || capChanged)) {
        const stamped = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
          const current = next.budget ?? seedBudget(undefined, next.created_at);
          current.approach_warned = { cap_tokens: metering.cap_tokens, cap_minutes: metering.cap_minutes, warned_at: nowIso() };
          next.budget = current;
        });
        await this.budgetDoorbell(store, run, stamped, stamped.budget ?? record, "approaching (80% of cap)", [detail]);
      } else if (!approaching && capChanged) {
        // The cap moved and spend sits below the threshold again: drop the
        // stale marker so the next crossing rings once more.
        await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
          const current = next.budget ?? seedBudget(undefined, next.created_at);
          delete current.approach_warned;
          next.budget = current;
        });
      }
      return { metering, parked: false, ...(warnings.length ? { warning: warnings.join(" | ") } : {}) };
    }
    if (action === "wait" || action === "close") {
      const parkWarnings = [clampScaffold?.warning, ...warnings].filter((value): value is string => typeof value === "string");
      return { metering, parked: true, ...(parkWarnings.length ? { warning: parkWarnings.join(" | ") } : {}) };
    }
    const recovery = reason === "clamp-unreadable"
      ? `Ask the human to repair ${budgetClampPath(store.runPath)}; the run resumes on the next guarded op once the clamp parses.`
      : reason === "denied"
        ? `A machine audit denied the last extension. Escalate to the human with the verdict and ${budgetLedgerPath(store.runPath)}; the next budget_extend stays refused until the human changes ${budgetClampPath(store.runPath)}. That file is the human's absolute ceiling: raising max_tokens above the judged spend releases this park directly, an edit at or below the judged spend pins the ceiling and routes every further token request to the human, and deleting max_tokens hands it back so the next approved grant resumes automatic raises.${pinPresent ? ` The ceiling is pinned now (max_tokens ${pinnedCeiling}), so budget_extend returns the pinned refusal while this park reads \`denied\` — both route to the same human, which is not a contradiction.${zeroMoveClause}` : ""}`
        : reason === "approval-required"
          ? pinPresent
            ? `The human pinned this run's token ceiling. ${pinDetail} budget_extend cannot buy token headroom here. ${humanRoute}${zeroMoveClause}${minutesExceptionOpen ? " The wall clock is over its own ceiling and no max_minutes is set, so a budget_extend may still buy minutes: the token pin does not govern the time dimension." : ""}`
            : `The mandate's doorbell policy is full, so the human approves each extension by raising ${budgetClampPath(store.runPath)}. Ask, then retry.`
          : pinPresent && !minutesExceptionOpen
            ? `${pinDetail} ${humanRoute}${zeroMoveClause}`
            : `Call herdr_track {action:"budget_extend"} with a bounded justification (done / remaining / why more). Work already in flight can still land: wait and close remain allowed while parked.${minutesExceptionOpen ? ` The wall clock, not the token cap, is what is over: a grant raises granted_minutes, and the human's token pin in ${budgetClampPath(store.runPath)} does not govern the time dimension.` : ""}`
    throw new McpContractError(
      "budget_parked",
      `This run is budget-parked (${reason}) and ${action} would start new work.`,
      "budget",
      `${recovery} ${clampSchemaGuidance(store.runPath)}${clampScaffold?.warning ? ` Warning: ${clampScaffold.warning}` : ""}${warnings.length ? ` Warning: ${warnings.join(" | ")}` : ""}`,
      false,
      true,
    );
  }

  /**
   * The human-facing doorbell for a budget boundary: a marker on the ORCH pane
   * name plus an entry in the append-only ledger. It is async and ignorable by
   * design — silence is consent — and a failed rename is a warning, never a
   * failed budget transition.
   */
  private async budgetDoorbell(store: DelegationStore, run: RunRef, registry: DelegationRegistry, record: BudgetRecord, heading: string, lines: readonly string[]): Promise<string | undefined> {
    const birth = latestBirth(registry);
    const markerWarning = birth ? await labelOwnedPane(birth.pane_id, orchPaneLabel(run, record)) : "No ORCH birth record: the budget marker has no pane to name.";
    const clampScaffold = heading.startsWith("parked") ? await scaffoldClamp(store.runPath) : undefined;
    const warnings = [markerWarning, clampScaffold?.warning].filter((value): value is string => typeof value === "string");
    const ledgerLines = heading.startsWith("parked") ? [...lines, clampSchemaGuidance(store.runPath)] : [...lines];
    await appendLedger(store.runPath, heading, [...ledgerLines, ...warnings.map((warning) => `doorbell warning: ${warning}`)]).catch(() => undefined);
    return warnings.length ? warnings.join(" | ") : undefined;
  }

  /**
   * Self-extension (decision 7): a guarded op that costs a bounded justification
   * and buys nothing on its own. The ladder is self-justification -> machine
   * audit -> human, and this method only ever walks the first two rungs. The
   * server spawns the auditor; the ORCH never does, never learns its pane, and
   * cannot address it, because the auditor is not a responsibility lane.
   */
  private async extendBudget(input: Extract<HerdrTrackInput, { action: "budget_extend" }>, run: RunRef, store: DelegationStore): Promise<McpResult> {
    const runtime = await loadFacts(this.adapter);
    await assertOrchCommand(store, runtime.facts);
    // Every guarded budget op sweeps first: an auditor whose close did not land
    // must not survive as an orphan pane, and this is the one op that is already
    // talking to Herdr (friction fa85b380).
    await this.sweepAuditors(store, run, timeout(input));
    const { normalized, sha256: justificationHash } = normalizeJustification(input.justification);
    let registry = await store.read();
    const record = registry.budget ?? seedBudget(undefined, registry.created_at);
    const clampReading = await readClamp(store.runPath);
    const metering = await meterRun(registry, record, clampReading.clamp);
    const pending = record.extensions.find((entry) => entry.state === "pending");
    if (pending) {
      if (pending.justification_sha256 !== justificationHash) {
        throw new McpContractError("budget_audit_in_flight", `Audit ${pending.ordinal} is still open for a different justification.`, "budget", `Re-send the identical justification to land audit ${pending.ordinal}, or read ${pending.audit_path} to see what the auditor has written so far. A second request would let one ORCH shop for a verdict.`, false, true);
      }
      return await this.landAudit(store, run, timeout(input));
    }
    // A human pin on the token ceiling makes almost every extension pointless
    // before it costs an auditor session: under a pin `cap_tokens` can never
    // move, so the only grant that buys anything is a minutes raise the run
    // actually needs. Everything else — including a proactive extend below the
    // pin — is refused here, at the same rung as `budget_denied`, and AFTER the
    // pending-landing branch above so a pending audit always lands and its
    // auditor session is still closed: a human edit mid-audit strands nothing.
    if (record.doorbell_policy === "notify" && clampTokensPinned(clampReading.clamp?.max_tokens, record)) {
      const minutesException = metering.elapsed_minutes >= metering.cap_minutes && clampReading.clamp?.max_minutes === undefined;
      if (!minutesException) {
        throw new McpContractError(
          "budget_clamp_pinned",
          `The human pinned this run's token ceiling at max_tokens ${clampReading.clamp?.max_tokens}, so no verdict can raise the effective token cap.`,
          "budget",
          `Escalate to the human with ${budgetLedgerPath(store.runPath)}; only they change ${budgetClampPath(store.runPath)}. Raising max_tokens above the judged spend resumes the run directly, an edit at or below the judged spend keeps the pin, and deleting max_tokens hands the ceiling back so the next approved grant resumes automatic raises. Spending an auditor session on a ceiling that cannot move is not an escalation. ${clampSchemaGuidance(store.runPath)}`,
          false,
          true,
        );
      }
    }
    // The ladder ends at the human. A denied run may not simply re-word its
    // justification and buy a second audit: the next attempt is released only
    // once a human has touched the clamp file, which is the human's own surface.
    if (record.park_reason === "denied" && record.denied_clamp_sha256 !== undefined) {
      const fingerprint = await clampFingerprint(store.runPath);
      if (fingerprint === record.denied_clamp_sha256) {
        throw new McpContractError("budget_denied", "A machine audit denied the last extension and no human has touched the clamp file since.", "budget", `Escalate to the human with ${budgetLedgerPath(store.runPath)} and the audit document; a change to ${budgetClampPath(store.runPath)} is what releases the next attempt. Re-wording the justification is not an escalation. ${clampSchemaGuidance(store.runPath)}`, false, true);
      }
    }
    // Covenant: extensions may not arrive faster than the published interval, so
    // a runaway becomes slow and visible instead of impossible.
    const previous = record.extensions[record.extensions.length - 1];
    const settledAt = previous?.settled_at ? Date.parse(previous.settled_at) : undefined;
    if (settledAt !== undefined && Number.isFinite(settledAt) && Date.now() - settledAt < MIN_EXTENSION_INTERVAL_MS) {
      const waitMinutes = Math.ceil((MIN_EXTENSION_INTERVAL_MS - (Date.now() - settledAt)) / 60_000);
      throw new McpContractError("budget_extension_too_soon", `Extension ${previous.ordinal} settled less than ${Math.round(MIN_EXTENSION_INTERVAL_MS / 60_000)} minutes ago.`, "budget", `Wait about ${waitMinutes} more minutes and land work in the meantime; the frequency covenant exists so that repeated extensions stay visible.`, false, true);
    }
    const step = stepCap(record);
    const requested = Math.min(input.requested_tokens ?? step, step);
    const ordinal = record.extensions.length + 1;
    const auditPath = budgetAuditPath(store.runPath, ordinal);
    const auditWorkerId = await store.nextAuditWorkerId(registry);
    await appendLedger(store.runPath, `extension ${ordinal} requested`, [
      meteringLedgerLine(metering),
      `done: ${normalized.done}`,
      `remaining: ${normalized.remaining}`,
      `why more: ${normalized.why_more}`,
      `requested: +${requested} tokens (step cap +${step})`,
      `audit: ${auditPath} (clean session ${auditWorkerId} on the slow profile)`,
    ]);
    registry = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
      const current = next.budget ?? seedBudget(undefined, next.created_at);
      current.extensions = [...current.extensions, {
        ordinal,
        requested_tokens: requested,
        justification_sha256: justificationHash,
        audit_path: auditPath,
        audit_worker_id: auditWorkerId,
        state: "pending",
        retries: 0,
        requested_at: nowIso(),
      }];
      next.budget = current;
    });
    // The auditor judges the ORCH's narrative against the registry, so the
    // registry must be true before it is quoted: a lane that settled while
    // nobody waited would otherwise be presented as unfinished work
    // (friction bbc360a158e3a3bf, same defect class as 183b6d4102ddfbfa).
    const sweepWarnings: string[] = [];
    const swept = await sweepSettlements(store, run, registry, sweepWarnings);
    if (sweepWarnings.length) await appendLedger(store.runPath, `extension ${ordinal} settlement sweep`, sweepWarnings).catch(() => undefined);
    const facts = machineFacts(swept);
    await writeAtomic(auditPath, renderAuditInput(run, ordinal, record, normalized, requested, metering, facts));
    try {
      await this.runAuditor(run, ordinal, auditPath, auditWorkerId, timeout(input));
    } catch (error) {
      // Fail-closed: an audit that cannot run never becomes a grant. The run
      // parks with the reason, the pending record survives for the retry, and
      // the human sees the marker. The retry re-runs this spawn (see landAudit):
      // before that, an audit whose session never started was re-READ forever
      // while nothing ever re-prompted it (friction 183b6d4102ddfbfa).
      const detail = error instanceof Error ? error.message : String(error);
      await this.parkForAudit(store, run, ordinal, `audit ${ordinal} could not run: ${detail}`);
      throw new McpContractError("budget_audit_unavailable", `Audit ${ordinal} could not be run: ${detail}`, "budget", `The run is parked and audit ${ordinal} stays pending. Retry the identical budget_extend; it re-runs the auditor, and nothing is granted until a verdict lands in ${auditPath}.`, false, true);
    }
    return await this.landAudit(store, run, timeout(input));
  }

  /**
   * Lands a pending audit: read the verdict the auditor appended, record it
   * server-side, and only then move the cap. Silence is never budget — but it is
   * no longer endless either (friction 183b6d4102ddfbfa). A landing attempt that
   * finds no verdict re-runs the auditor, because the old retry only re-READ the
   * document while nothing ever re-prompted a session that had failed to start
   * or failed to be prompted. After MAX_AUDIT_LANDING_ATTEMPTS the audit is
   * abandoned explicitly: the run stays parked, the attempt is recorded as
   * having bought nothing, and the pending blocker is cleared so the ladder can
   * take its next rung instead of the run waiting on a verdict that never comes.
   */
  private async landAudit(store: DelegationStore, run: RunRef, timeoutMs: number): Promise<McpResult> {
    let registry = await store.read();
    const record = registry.budget ?? seedBudget(undefined, registry.created_at);
    const pending = record.extensions.find((entry) => entry.state === "pending");
    if (!pending) throw new McpContractError("budget_audit_missing", "No audit is pending for this run.", "budget", "Send a fresh budget_extend with a bounded justification.");
    const audit = await readAuditDocument(pending.audit_path);
    const verdict = audit ? parseVerdict(audit.document, pending.ordinal) : undefined;
    if (!verdict) {
      const retried = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
        const current = next.budget ?? seedBudget(undefined, next.created_at);
        const entry = current.extensions.find((candidate) => candidate.ordinal === pending.ordinal);
        if (entry) entry.retries += 1;
        next.budget = current;
      });
      const retries = retried.budget?.extensions.find((entry) => entry.ordinal === pending.ordinal)?.retries ?? pending.retries + 1;
      if (retries >= MAX_AUDIT_LANDING_ATTEMPTS) {
        const abandoned = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
          const current = next.budget ?? seedBudget(undefined, next.created_at);
          const entry = current.extensions.find((candidate) => candidate.ordinal === pending.ordinal);
          // No `settled_at`: nothing settled and nothing was granted, so the
          // frequency covenant has no verdict to count from and the next
          // justification is not made to wait out an interval it never bought.
          if (entry) entry.state = "abandoned";
          next.budget = current;
        });
        const detail = `audit ${pending.ordinal} abandoned after ${retries} landing attempts without a verdict block in ${pending.audit_path}; nothing was granted`;
        await appendLedger(store.runPath, `extension ${pending.ordinal} abandoned`, [
          detail,
          "recorded server-side; no cap moved and the run stays parked until a later audit lands or the human raises the clamp",
        ]).catch(() => undefined);
        const closeWarning = await this.closeAuditor(store, run, pending.ordinal, pending.audit_worker_id, timeoutMs);
        await this.parkForAudit(store, run, pending.ordinal, detail);
        return { ok: true, tool: "herdr_track", action: "budget_extend", run, effect: "confirmed", retryable: false, registry_revision: abandoned.revision, data: { budget: abandoned.budget, audit: { ordinal: pending.ordinal, state: "abandoned", path: pending.audit_path, retries }, ...(closeWarning ? { warnings: [closeWarning] } : {}), next_step: `Audit ${pending.ordinal} produced no verdict in ${retries} attempts and is abandoned; the run stays parked (audit-unavailable). Read ${pending.audit_path} and ${budgetLedgerPath(store.runPath)}: send a fresh budget_extend only if the auditor can plausibly run now, and otherwise escalate to the human, who releases the run by raising ${budgetClampPath(store.runPath)}.` } };
      }
      // Re-prompt rung: the document exists, so the auditor only needs to be
      // running against it. A session that is still working is left alone.
      const rerun = pending.audit_worker_id ? await this.repromptAuditor(run, pending.ordinal, pending.audit_path, pending.audit_worker_id, timeoutMs) : "the pending audit records no auditor session, so nothing could be re-prompted";
      await this.parkForAudit(store, run, pending.ordinal, `audit ${pending.ordinal} has no verdict block yet (attempt ${retries}${rerun ? `; ${rerun}` : "; auditor re-prompted"})`);
      return { ok: true, tool: "herdr_track", action: "budget_extend", run, effect: "none", retryable: true, registry_revision: retried.revision, data: { budget: retried.budget, audit: { ordinal: pending.ordinal, state: "pending", path: pending.audit_path, retries, attempts_before_abandon: MAX_AUDIT_LANDING_ATTEMPTS, ...(rerun ? { auditor: rerun } : { auditor: "re-prompted" }) }, next_step: `The auditor has not appended its verdict yet. Re-send the identical budget_extend to land audit ${pending.ordinal}; the run stays parked until a verdict exists, and after ${MAX_AUDIT_LANDING_ATTEMPTS} attempts the audit is abandoned instead of pending forever.` } };
    }
    const granted = verdict.verdict === "deny"
      ? 0
      : Math.min(verdict.granted_tokens ?? pending.requested_tokens, pending.requested_tokens);
    // A grant moves both dimensions. Wall clock keeps accruing while a run is
    // parked, so a token-only grant would leave a minutes-parked run parked
    // forever — the cadence would become the wall this design refuses to be.
    const grantedMinutes = granted > 0 ? Math.max(1, Math.floor(record.granted_minutes * BUDGET_STEP_FRACTION)) : 0;
    const denyScaffold = verdict.verdict === "deny" ? await scaffoldClamp(store.runPath) : undefined;
    const deniedFingerprint = verdict.verdict === "deny" ? await clampFingerprint(store.runPath) : undefined;
    // GATED T1. Under `notify` an approved ceiling belongs in the human-visible
    // clamp file, or the approval is invisible and the override clamp silently
    // caps every later grant. The classification runs BEFORE the settle
    // mutation, and `intended` is recorded only when it permits a write: the
    // registry never learns a number the disk will not hold, so no approval is
    // owed forever, no human lowering is misread, and no later non-grant op can
    // resurrect a refused write. The reading here is a PREDICTION of the
    // helper's own authoritative read below — a pin landing between them is
    // caught there and drained by the clear-on-skip.
    const clampWriteGated = record.doorbell_policy === "notify" && granted > 0;
    let preSettleClass: ClampTokenClass | undefined;
    let gateRecord = record;
    if (clampWriteGated) {
      const preSettleReading = await readClamp(store.runPath);
      gateRecord = await this.healClampState(store, preSettleReading, record);
      preSettleClass = classifyClampTokens(preSettleReading, gateRecord);
    }
    const writePermitted = preSettleClass === "open" || preSettleClass === "server-authored";
    const previousCeiling = gateRecord.server_clamp_tokens?.confirmed;
    const settled = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
      const current = next.budget ?? seedBudget(undefined, next.created_at);
      const entry = current.extensions.find((candidate) => candidate.ordinal === pending.ordinal);
      if (entry) {
        entry.state = "settled";
        entry.verdict = verdict.verdict;
        entry.granted_tokens = granted;
        entry.settled_at = nowIso();
      }
      current.granted_tokens += granted;
      current.granted_minutes += grantedMinutes;
      if (deniedFingerprint === undefined) delete current.denied_clamp_sha256;
      else current.denied_clamp_sha256 = deniedFingerprint;
      if (clampWriteGated) {
        if (writePermitted) current.server_clamp_tokens = { ...current.server_clamp_tokens, intended: current.granted_tokens };
        else clearOwedClampTokens(current);
      }
      next.budget = current;
    });
    const settledRecord = settled.budget ?? record;
    // T2: write the approved ceiling, then promote `confirmed` to the value the
    // helper reports it WROTE (never a re-read of `intended`, which may have
    // moved). The promotion is a best-effort follow-up: its failure is a warning
    // that the next guarded op's self-heal repairs, never a failed grant.
    const clampWarnings: string[] = [];
    let clampOutcome: ClampWriteOutcome | undefined;
    if (clampWriteGated && writePermitted) {
      const outcome = await writeClampMaxTokens(store.runPath, settledRecord.granted_tokens, settledRecord, pending.ordinal);
      clampOutcome = outcome;
      try {
        if (outcome.outcome === "written") {
          await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
            const current = next.budget ?? seedBudget(undefined, next.created_at);
            current.server_clamp_tokens = { ...current.server_clamp_tokens, confirmed: outcome.value };
            next.budget = current;
          });
        } else if (outcome.outcome === "skipped" && outcome.reason === "pinned") {
          // CLEAR-ON-SKIP: drain the owed state at the refusal itself, where the
          // event is known, rather than waiting for a later disk state to imply
          // it. The clear-heal remains the repair for a failed best-effort clear.
          await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
            const current = next.budget ?? seedBudget(undefined, next.created_at);
            clearOwedClampTokens(current);
            next.budget = current;
          });
        }
      } catch (error) {
        clampWarnings.push(`The clamp write outcome (${outcome.outcome}) could not be recorded in the registry (${error instanceof Error ? error.message : String(error)}); the next guarded op's classification repairs it.`);
      }
      if (outcome.outcome === "failed") clampWarnings.push(outcome.warning);
    }
    await appendLedger(store.runPath, `extension ${pending.ordinal} verdict ${verdict.verdict}`, [
      `granted: +${granted} tokens, +${grantedMinutes} min -> cap ${settledRecord.granted_tokens} tokens / ${settledRecord.granted_minutes} min`,
      `verdict read from ${pending.audit_path} sha256=${audit?.sha256 ?? "unreadable"}`,
      "recorded server-side; the orchestrator never wrote this entry",
      ...(clampOutcome ? [clampWriteLedgerLine(store.runPath, clampOutcome, previousCeiling)] : []),
      ...(clampWriteGated && !writePermitted ? [`clamp write: skipped (${preSettleClass}) — ${budgetClampPath(store.runPath)} is the human's ceiling on the token axis and was not touched; the approved figure lives in the registry only, and no write is owed`] : []),
      ...(clampWarnings.map((warning) => `clamp warning: ${warning}`)),
      ...(verdict.verdict === "deny" ? [`escalation: the human decides from here, armed with this verdict and the ledger; the next attempt is released only by a change to ${budgetClampPath(store.runPath)} (fingerprint at deny: ${deniedFingerprint})`, clampSchemaGuidance(store.runPath), ...(denyScaffold?.warning ? [`scaffold warning: ${denyScaffold.warning}`] : [])] : []),
    ]);
    const closeWarning = await this.closeAuditor(store, run, pending.ordinal, pending.audit_worker_id, timeoutMs);
    // Re-judge with the new cap: a grant that still leaves the run over its
    // ceiling stays parked, and the reason is recomputed rather than guessed.
    const judged = await this.judgeBudget(store, run, "wait");
    const fresh = await store.read();
    return {
      ok: true,
      tool: "herdr_track",
      action: "budget_extend",
      run,
      effect: "confirmed",
      retryable: false,
      registry_revision: fresh.revision,
      data: {
        budget: fresh.budget,
        metering: judged.metering,
        audit: { ordinal: pending.ordinal, state: "settled", path: pending.audit_path, verdict: verdict.verdict, granted_tokens: granted },
        ledger_path: budgetLedgerPath(store.runPath),
        ...((closeWarning || judged.warning || denyScaffold?.warning || clampWarnings.length) ? { warnings: [closeWarning, judged.warning, denyScaffold?.warning, ...clampWarnings].filter((value): value is string => typeof value === "string") } : {}),
        next_step: verdict.verdict === "deny"
          ? `Denied. Escalate to the human with ${budgetLedgerPath(store.runPath)} and ${pending.audit_path}; no tool op raises the ceiling from here. ${clampSchemaGuidance(store.runPath)}`
          : clampOutcome?.outcome === "skipped" && clampOutcome.reason === "pinned"
            ? `Granted +${granted} tokens in the registry, but ${budgetClampPath(store.runPath)} holds a human ceiling, so the effective token cap did not move. Escalate to the human; only they change that file.`
            : judged.parked
              ? `Granted +${granted} tokens, and the run is still parked: read data.budget.park_reason.`
              : `Granted +${granted} tokens; the run is active again.`,
      },
    };
  }

  /**
   * Spawns the auditor session and hands it its own audit document. Shared by
   * the request path and the landing retry, so a session that never started, or
   * started and was never prompted, is actually re-run instead of being re-read
   * (friction 183b6d4102ddfbfa). The ORCH never learns this session's pane.
   */
  private async runAuditor(run: RunRef, ordinal: number, auditPath: string, workerId: string, timeoutMs: number): Promise<void> {
    const ensured = await ensureWorker({ operation: "ensure_worker", track_id: run.track_id, run_id: run.run_id, worker_id: workerId, responsibility_key: AUDIT_RESPONSIBILITY, profile: AUDIT_PROFILE, timeout_ms: timeoutMs });
    const agentName = stringField(ensured.worker, ["agent_name"]);
    if (!agentName) throw new McpContractError("budget_audit_unavailable", "The auditor session started without a canonical agent name.", "budget", "Retry the identical budget_extend; the audit is not granted until a verdict lands.");
    await this.adapter.prompt(agentName, `Budget audit ${ordinal} for run ${run.track_id}/${run.run_id}. Read ${auditPath} and follow it exactly: judge the orchestrator's narrative against the machine facts it contains, then append your bounded reasoning and the exact verdict block to that same file. You are a clean auditor: do not contact the orchestrator, do not call any herdr_* tool, and change nothing else in this run.`, ["idle", "done"], timeoutMs);
  }

  /**
   * One bounded re-run of a pending audit's auditor, reported as an observation.
   * An auditor that is still working is left alone — re-prompting a thinking
   * session would be the double-prompt this design refuses — and a failed re-run
   * degrades to text, because the landing attempt itself must still park and
   * return rather than fail.
   */
  private async repromptAuditor(run: RunRef, ordinal: number, auditPath: string, workerId: string, timeoutMs: number): Promise<string | undefined> {
    try {
      const observed = await inspectWorker({ operation: "inspect_worker", track_id: run.track_id, run_id: run.run_id, worker_id: workerId, timeout_ms: timeoutMs });
      if (observed.state === "working" || observed.state === "prompted") return `auditor ${workerId} is still ${observed.state}, so it was not re-prompted`;
    } catch { /* no live session: the re-run below is exactly the repair */ }
    try {
      await this.runAuditor(run, ordinal, auditPath, workerId, timeoutMs);
      return undefined;
    } catch (error) {
      return `auditor ${workerId} could not be re-prompted: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Fail-closed parking for an audit that could not produce a verdict. */
  private async parkForAudit(store: DelegationStore, run: RunRef, ordinal: number, detail: string): Promise<void> {
    const parked = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
      const current = next.budget ?? seedBudget(undefined, next.created_at);
      current.state = "parked";
      current.park_reason = "audit-unavailable";
      current.park_detail = detail.slice(0, 500);
      current.parked_at = nowIso();
      next.budget = current;
    });
    await this.budgetDoorbell(store, run, parked, parked.budget ?? seedBudget(undefined, parked.created_at), `parked (audit-unavailable, audit ${ordinal})`, [detail]);
  }

  /**
   * Closes the auditor once it has actually settled, and records that it is gone.
   *
   * The first cut closed it the instant its verdict block landed, but an auditor
   * is usually still `working` at that moment and `close_worker` accepts only a
   * settled state — so every audit leaked a live pane that no public op could
   * reach, since the auditor is deliberately not a lane (friction fa85b380).
   * Waiting for the boundary fixes the common case; `sweepAuditors` covers the
   * rest, because a leaked session must not depend on one call succeeding.
   */
  private async closeAuditor(store: DelegationStore, run: RunRef, ordinal: number, workerId: string | undefined, timeoutMs: number): Promise<string | undefined> {
    if (!workerId) return undefined;
    try {
      const observed = await inspectWorker({ operation: "inspect_worker", track_id: run.track_id, run_id: run.run_id, worker_id: workerId, timeout_ms: timeoutMs });
      const agentName = stringField(observed.worker, ["agent_name"]);
      if (agentName) await this.adapter.wait(agentName, ["idle", "done"], Math.min(timeoutMs, MAX_EFFECTIVE_WAIT_MS)).catch(() => undefined);
      const settled = await inspectWorker({ operation: "inspect_worker", track_id: run.track_id, run_id: run.run_id, worker_id: workerId });
      const sequence = numberField(settled.worker, ["state_change_seq"]);
      if (sequence === undefined) return `Auditor ${workerId} has no live state sequence; it stays recorded for the next sweep.`;
      await closeWorker({ operation: "close_worker", track_id: run.track_id, run_id: run.run_id, worker_id: workerId, expected_state_change_seq: sequence });
      await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
        const entry = next.budget?.extensions.find((candidate) => candidate.ordinal === ordinal);
        if (entry) entry.audit_worker_closed = true;
      });
      await appendLedger(store.runPath, `audit ${ordinal} session closed`, [`auditor ${workerId} settled and closed; no orphan pane remains`]).catch(() => undefined);
      return undefined;
    } catch (error) {
      return `Auditor ${workerId} stayed open and is queued for the next sweep: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Server-side sweep of auditors whose close never landed. It runs at the
   * budget ops that already talk to Herdr, never on a pending audit (that
   * session is still working), and adds no public action on the auditor — the
   * ORCH still cannot address it.
   */
  private async sweepAuditors(store: DelegationStore, run: RunRef, timeoutMs: number): Promise<void> {
    const registry = await store.read();
    for (const extension of registry.budget?.extensions ?? []) {
      // A pending audit's session is still working; a settled or abandoned one
      // must not survive as an orphan pane.
      if (extension.state === "pending" || !extension.audit_worker_id || extension.audit_worker_closed) continue;
      const warning = await this.closeAuditor(store, run, extension.ordinal, extension.audit_worker_id, timeoutMs);
      if (warning) await appendLedger(store.runPath, `audit ${extension.ordinal} session sweep failed`, [warning]).catch(() => undefined);
    }
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
    // The lane's profile lives in the canonical assignment artifact, so it is
    // read from there rather than mirrored into the registry. An unreadable
    // artifact leaves the profile unknown, which delivers only unscoped rules —
    // an advisory lookup never widens delivery on a failed read, and never
    // blocks the dispatch it decorates.
    const laneProfile = await store
      .preflight(assignmentId, record.responsibility_key)
      .then((artifact) => artifact.assignment.profile)
      .catch(() => undefined);
    const workerRoutes = await advisorySkillRoutes(store.runPath, store.cwd, ["dispatch", "completion"], "worker", laneProfile);
    // The lane's own advisory document, materialized at dispatch so it carries
    // the configuration current now. Absence stays a no-op: an unknown profile, a
    // profile the configuration gives neither a directive nor a route, and a
    // failed render or write all name no path, so the pointer omits the clause.
    const laneGuidance = laneProfile ? await materializeWorkerGuidance(store.runPath, laneProfile) : {};
    if (laneGuidance.warning) warnings.push(laneGuidance.warning);
    const pointer = `Assignment ${assignmentId}; responsibility ${record.responsibility_key}; instructions ${artifactPath} sha256=${record.instructions_sha256}; worker protocol ${workerProtocolPath}. Append [Assignment Completion: ${assignmentId}] to ${reportPath} and remain idle. After appending a completion block or an [ORCH Decision Request], call herdr_message {action:"wake_orch"} once per protocol-worker.md.${skillRoutePointer(workerRoutes)}${laneGuidance.path ? ` Lane guidance (advisory, not a contract): ${laneGuidance.path}.` : ""}`;
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
    // Everything below runs AFTER the prompt was delivered, so no failure here
    // may report `effect: "none"`: the worker already holds the assignment
    // pointer and the registry already carries `prompting` + `prompted_at`. The
    // pre-prompt catch above marks that ambiguity, but this boundary was left
    // unguarded, so a post-prompt verification failure reported a fully
    // dispatched assignment as a no-effect error and invited a duplicate
    // re-add (friction 66d45887c8bfec74). `verifyPromptedWorker` throws the
    // extension's `ContractError`, which is why both error types are
    // recognized here — the same asymmetry the resume path never had.
    try {
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
      registry = await settleIfReported(store, registry, registry.lanes[workerId], registry.assignments[assignmentId], warnings);
      const terminal = await reportTerminalObservation(this.adapter, registry, assignmentId, beforeSettlement, paneId);
      if (terminal) warnings.push(terminal);
      return registry;
    } catch (error) {
      await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
        const current = next.assignments[assignmentId];
        current.state = "ambiguous";
        current.ambiguous_operation = "prompt";
        current.updated_at = nowIso();
      });
      const recovery = "The assignment prompt was already delivered; inspect_worker to observe the lane's real state instead of re-adding or re-prompting the assignment.";
      if (error instanceof McpContractError) throw new McpContractError(error.code, error.message, error.phase, recovery, true, false);
      if (error instanceof LegacyContractError) throw new McpContractError(error.code, error.message, normalizeLegacyPhase(error.phase), recovery, true, false);
      throw new McpContractError("prompt_verification_failed", error instanceof Error ? error.message : String(error), "prompt", recovery, true, false);
    }
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
        // The lane coordinate the assignment will run on, at authoring time
        // (friction 20b26d0a60e14ab6): an assignment that must name its own
        // report surface should read it here instead of guessing it.
        if (existing) {
          const bound = { worker_id: existing.worker_id, report_path: path.join(store.runPath, "a2a", `${existing.worker_id}-report.md`), lane_reuse: true };
          return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, ...skillRouteFields(routes), assignment: { assignment_id: input.assignment_id, state: existing.state }, data: { already_registered: true, instructions_sha256: existing.instructions_sha256, ...bound } };
        }
        const artifact = await store.preflight(input.assignment_id, input.responsibility_key);
        const predicted = await store.predictLane(registry, input.responsibility_key);
        // Authoring-time overlap, read from the artifact just validated. It is
        // an observation appended to a non-mutating result: preflight still
        // decides nothing (ASN-014a).
        const interRunOwnership = await observeInterRunOwnership(store, artifact.assignment.write_ownership);
        return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, ...skillRouteFields(routes), data: { already_registered: false, path: artifact.path, instructions_sha256: artifact.instructionsHash, profile: artifact.assignment.profile, goal_bytes: Buffer.byteLength(artifact.assignment.goal), completion_conditions: artifact.assignment.completion_conditions.length, write_ownership: artifact.assignment.write_ownership.length, dependencies: artifact.assignment.dependencies.length, user_boundaries: artifact.assignment.user_boundaries.length, ...predicted, inter_run_ownership: interRunOwnership } };
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
        await this.judgeBudget(store, run, "add");
        // FIFO placement is judged from the lane record, so the sweep runs
        // first: a lane that finished while nobody asked must not queue this
        // assignment behind a completed one (friction bbc360a158e3a3bf).
        const sweepWarnings: string[] = [];
        await sweepSettlements(store, run, await store.read(), sweepWarnings);
        const sweptData = sweepWarnings.length ? { data: { settlement_sweep: sweepWarnings } } : {};
        const selected = await store.select(input.assignment_id, input.responsibility_key, input.instructions_sha256, input.separation, timeout(input));
        if (selected.duplicate) return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, registry_revision: selected.revision, worker: selected.lane, assignment: { assignment_id: input.assignment_id, state: selected.assignment.state }, ...sweptData };
        if (selected.queued) return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "confirmed", retryable: false, registry_revision: selected.revision, worker: selected.lane, assignment: { assignment_id: input.assignment_id, state: "queued" }, ...sweptData };
        let ensured: WorkerResult;
        try {
          ensured = await ensureWorker({ operation: "ensure_worker", track_id: input.track_id, run_id: input.run_id, worker_id: selected.lane.worker_id, responsibility_key: selected.lane.responsibility_key, profile: selected.artifact.assignment.profile, timeout_ms: timeout(input) });
        } catch (error) {
          const cleaned = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
            const assignment = next.assignments[input.assignment_id];
            const lane = next.lanes[selected.lane.worker_id];
            assignment.state = "failed";
            assignment.updated_at = nowIso();
            if (lane.active_assignment_id === input.assignment_id) delete lane.active_assignment_id;
            lane.queued_assignment_ids = lane.queued_assignment_ids.filter((id) => id !== input.assignment_id);
            // A lane this call brought into being and that never reached a live
            // session is not a lane: leaving it `starting` made it a ghost no
            // close path accepted (friction cf7c4a8eb2bdb9c1). `failed` is the
            // honest terminal record — track close treats it as settled, and a
            // re-add of the same assignment rebinds onto a fresh lane.
            lane.state = selected.lane.state === "starting" && lane.official_session_id === undefined
              ? "failed"
              : selected.lane.state;
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
        const warnings: string[] = [...sweepWarnings];
        const until = input.wait?.until ?? ["idle", "done", "blocked"];
        registry = await this.promptAssignment(store, run, lane.worker_id, input.assignment_id, agentName, paneId, until, timeout(input), warnings);
        registry = await this.dispatchPromotedHead(store, run, lane.worker_id, until, timeout(input), warnings) ?? registry;
        const settledAssignment = registry.assignments[input.assignment_id];
        const settlement = settlementObservation(settledAssignment, warnings.length ? warnings.join(" | ") : undefined);
        const settlementRoutes = settledAssignment.state === "completed" || settledAssignment.state === "failed" ? await advisorySkillRoutes(store.runPath, store.cwd, ["settlement"], "orch") : [];
        return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "confirmed", retryable: false, registry_revision: registry.revision, worker: registry.lanes[lane.worker_id], ...skillRouteFields(settlementRoutes), assignment: { assignment_id: input.assignment_id, state: settledAssignment.state, ...(settlement ? { settlement } : {}) }, ...sweptData };
      }

      // `wait` is a guarded run-command op (it dispatches promoted heads), so
      // only the run's born ORCH session may issue it.
      const commandFacts = await loadFacts(this.adapter);
      await assertOrchCommand(store, commandFacts.facts);
      // Landing allowlist: a parked run may still settle work in flight, but a
      // promoted head is new work and stays queued until the budget is restored.
      const budgetJudgment = await this.judgeBudget(store, run, "wait");
      let registry = await store.read();
      const assignment = registry.assignments[input.assignment_id];
      if (!assignment) throw new McpContractError("assignment_artifact_missing", "Assignment is not registered to a lane.", "select", "Add the canonical assignment first.");
      if (assignment.state === "queued") {
        const queuedWarnings: string[] = [];
        const dispatched = budgetJudgment.parked ? undefined : await this.dispatchPromotedHead(store, run, assignment.worker_id, input.wait?.until ?? ["idle", "done", "blocked"], timeout(input), queuedWarnings);
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
      const inspected = await inspectWorker({ operation: "inspect_worker", track_id: input.track_id, run_id: input.run_id, worker_id: lane.worker_id, timeout_ms: timeout(input) });
      registry = await updateLaneFromWorker(store, lane.worker_id, inspected);
      const tailWarnings: string[] = [];
      const agentName = stringField(inspected.worker, ["agent_name"]);
      if (!agentName) throw new McpContractError("worker_identity_conflict", "Assignment lane has no canonical agent name.", "wait", "Reconcile lifecycle identity before waiting.");
      const waited = await this.adapter.wait(agentName, input.wait?.until ?? ["idle", "done", "blocked"], timeout(input));
      const waitTimedOut = waited.timedOut === true;
      if (waited.warning) tailWarnings.push(waited.warning);
      const finalInspect = await inspectWorker({ operation: "inspect_worker", track_id: input.track_id, run_id: input.run_id, worker_id: lane.worker_id });
      registry = await updateLaneFromWorker(store, lane.worker_id, finalInspect);
      registry = await store.mutate(DEFAULT_TIMEOUT_MS, (next) => {
        const state = next.lanes[lane.worker_id].state;
        next.assignments[input.assignment_id].state = state === "blocked" ? "blocked" : "working";
        next.assignments[input.assignment_id].updated_at = nowIso();
      });
      const beforeSettlement = registry.assignments[input.assignment_id].state;
      registry = await settleIfReported(store, registry, registry.lanes[lane.worker_id], registry.assignments[input.assignment_id], tailWarnings);
      const terminal = await reportTerminalObservation(this.adapter, registry, input.assignment_id, beforeSettlement, stringField(finalInspect.worker, ["root_pane_id"]));
      if (terminal) tailWarnings.push(terminal);
      registry = (budgetJudgment.parked ? undefined : await this.dispatchPromotedHead(store, run, lane.worker_id, input.wait?.until ?? ["idle", "done", "blocked"], timeout(input), tailWarnings)) ?? registry;
      const settledAssignment = registry.assignments[input.assignment_id];
      const settlement = settlementObservation(settledAssignment, tailWarnings.length ? tailWarnings.join(" | ") : undefined);
      const settlementRoutes = settledAssignment.state === "completed" || settledAssignment.state === "failed" ? await advisorySkillRoutes(store.runPath, store.cwd, ["settlement"], "orch") : [];
      // The cursor this observation ends at. Handing it to the next wait makes
      // that call's arguments differ from this one's, so a legitimate bounded
      // poll does not read as a repeated identical call (friction
      // 3b7947a6750ee7db), and the answer below says whether anything moved.
      const cursor = await laneWaitCursor(store, registry, registry.lanes[lane.worker_id]);
      const moved = input.wait?.cursor === undefined ? undefined : cursorMoved(input.wait.cursor, cursor);
      const cursorData = {
        wait_cursor: cursor,
        ...(moved === undefined ? {} : { moved_since_cursor: moved }),
        ...(waitTimedOut ? { next_step: `The wait window elapsed without ${(input.wait?.until ?? ["idle", "done", "blocked"]).join("/")}. Prefer the worker's doorbell over polling: it rings when the report changes. If you do wait again, pass wait.cursor=${cursor} so the call is not an identical repeat, and spend the interval on your own work.` } : {}),
      };
      return { ok: true, tool: "herdr_assignment", action: input.action, run, effect: "none", retryable: false, ...(waitTimedOut ? { timed_out: true } : {}), registry_revision: registry.revision, worker: registry.lanes[lane.worker_id], ...skillRouteFields(settlementRoutes), assignment: { assignment_id: input.assignment_id, state: settledAssignment.state, ...(settlement ? { settlement } : {}) }, data: cursorData };
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
        // Observation point: an ORCH that looks at a lane learns the truth,
        // including a settlement nobody waited for (friction bbc360a158e3a3bf).
        // The inspected lane is `fresh`, so its live state is not re-read.
        const sweepWarnings: string[] = [];
        registry = await sweepSettlements(store, run, registry, sweepWarnings, input.worker_id);
        const rawStaleness = isObject(result.observation?.staleness) ? result.observation.staleness : undefined;
        const lastActivityAt = stringField(rawStaleness, ["last_activity_at"]);
        const observedAt = stringField(rawStaleness, ["observed_at"]);
        const staleness: WorkerStalenessObservation | undefined = lastActivityAt && observedAt
          ? { observed_at: observedAt, last_activity_at: lastActivityAt, queue_depth: registry.lanes[input.worker_id].queued_assignment_ids.length }
          : undefined;
        const full: WorkerResult = staleness ? { ...result, observation: { ...result.observation, staleness } } : result;
        // A compact inspect drops what cannot change between two inspections of
        // the same lane, so a supervision probe costs a fraction of the context
        // (friction 588687ae4317fd72). The full form stays the default.
        const data = input.compact ? compactInspect(result, staleness) : full;
        return { ok: true, tool: "herdr_worker", action: input.action, run, effect: "none", retryable: false, registry_revision: registry.revision, worker: registry.lanes[input.worker_id], data: sweepWarnings.length ? { ...data, settlement_sweep: sweepWarnings } : data };
      }
      const runtime = await loadFacts(this.adapter);
      await assertOrchCommand(store, runtime.facts);
      await this.judgeBudget(store, run, input.action === "resume" ? "resume" : "close");
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
          const result = await ensureWorker({ operation: "ensure_worker", track_id: input.track_id, run_id: input.run_id, worker_id: input.worker_id, responsibility_key: assignment.responsibility_key, profile: artifact.assignment.profile });
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
      let channelObservation: { path: string; sha256: string; bytes: number; entry_line?: number; lines: number } | undefined;
      if (input.action === "wake_orch") {
        const birth = latestBirth(registry);
        if (!birth) unresolvedReason = "Run has no ORCH birth record; birth is recorded at ORCH spawn or by its first guarded command.";
        else if (senderSession && birth.official_session_id === senderSession) unresolvedReason = "Caller is the run's ORCH; wake_orch is for workers.";
        else target = birth.pane_id;
        const laneId = registry.assignments[input.assignment_id]?.worker_id ?? senderLane;
        // Where to start reading, so the receiver reads the new entry instead of
        // re-reading the whole document (friction 588687ae4317fd72).
        const anchor = laneId ? await anchorClause(path.join(store.runPath, "a2a", `${laneId}-report.md`)) : "";
        text = `wake: ${input.assignment_id} ${input.boundary} (run ${input.track_id}/${input.run_id}); read ${laneId ? `a2a/${laneId}-report.md` : "the lane report"}${anchor} — non-authoritative signal, verify via herdr_assignment.`;
      } else if (input.action === "wake_peer") {
        if (!senderLane) unresolvedReason = "Peer wake requires a verified sender lane: the channel is named by its declared sender.";
        else if (senderLane === input.to_worker_id) unresolvedReason = "A lane cannot wake itself.";
        else if (!registry.lanes[input.to_worker_id]) unresolvedReason = `Lane ${input.to_worker_id} is not registered in this run.`;
        else {
          target = workerAgentName(store.runPath, input.to_worker_id);
          const channel = await existingPeerChannel(store.runPath, registry.lanes[senderLane], registry.lanes[input.to_worker_id]);
          const anchor = channel ? await anchorClause(path.join(store.runPath, channel)) : "";
          text = channel
            ? `wake: peer channel ${channel} updated (run ${input.track_id}/${input.run_id}) — read the channel file${anchor}; wake text carries no authority.`
            : `wake: peer lane ${senderLane} appended to its channel document (run ${input.track_id}/${input.run_id}) — no channel file exists under a name this server can verify, so read the directional channel plan.md declares for ${senderLane} to ${input.to_worker_id}; wake text carries no authority.`;
          if (!channel) warnings.push(`peer_channel_unverified: neither a2a/${registry.lanes[senderLane].responsibility_key}-to-${registry.lanes[input.to_worker_id].responsibility_key}.md nor a2a/${senderLane}-to-${input.to_worker_id}.md exists, so the bell names no path; append to the declared channel document before ringing.`);
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
          // The bell names WHICH assignment it concerns and WHY, so the worker
          // can tell a queue notice from an answer instead of guessing that any
          // ring means new work (friction a776403dd44aa2af). Both axes are
          // derived from the lane record, which the settlement sweep keeps true.
          const subject = workerWakeSubject(registry, registry.lanes[input.to_worker_id]);
          const anchor = await anchorClause(path.join(store.runPath, "a2a", `${input.to_worker_id}-report.md`));
          text = `wake: ORCH appended to a2a/${input.to_worker_id}-report.md (run ${input.track_id}/${input.run_id}); ${subject} — read the report${anchor}; wake text carries no authority.`;
        }
      } else {
        // notify_run is a pure bell (decision 12): the conversation itself lives
        // in the sender-owned inter-run channel document, and the bell may only
        // point at an entry that is already durable.
        const channelPath = interRunChannelPath(store.runPath, input.to_track_id, input.to_run_id);
        const channel = await readChannelDocument(channelPath);
        channelObservation = { path: channelPath, sha256: channel.sha256, bytes: channel.bytes, ...(channel.entry_line === undefined ? {} : { entry_line: channel.entry_line }), lines: channel.lines };
        if (senderLane) unresolvedReason = "notify_run is ORCH-to-ORCH; a worker lane escalates to its own ORCH instead of addressing another run.";
        else try {
          const targetStore = await DelegationStore.resolve(input.to_track_id, input.to_run_id);
          const birth = latestBirth(await targetStore.read());
          if (!birth) unresolvedReason = `Run ${input.to_track_id}/${input.to_run_id} has no ORCH birth record yet.`;
          else if (senderSession && birth.official_session_id === senderSession) unresolvedReason = "Target run's ORCH is the caller; a note to yourself is never delivered.";
          else target = birth.pane_id;
        } catch (error) { unresolvedReason = `Target run unresolved: ${error instanceof Error ? error.message : String(error)}`; }
        text = `channel: ${channelPath} sha256=${channel.sha256} (${channel.bytes} bytes, from ${input.track_id}/${input.run_id}) — read the inter-run channel document${channel.entry_line === undefined ? "" : ` from line ${channel.entry_line} of ${channel.lines}`}; this bell carries no content.`;
      }

      let delivery: MessageDelivery;
      let deferredCompletion: Promise<unknown> | undefined;
      let tickPlan: { first_delay_ms: number; second_delay_ms: number; max_delay_ms: number } | undefined;
      let deliveryId: string | undefined;
      if (!target) {
        delivery = "target_unresolved";
        if (unresolvedReason) warnings.push(unresolvedReason);
      } else {
        try {
          const dispatch = await this.adapter.notify(target, text, 15_000);
          if (dispatch.delivery === "deferred") {
            delivery = "deferred";
            deferredCompletion = dispatch.completion;
            tickPlan = dispatch.tick_plan;
            deliveryId = nextMessageDeliveryId();
          } else {
            delivery = "delivered";
          }
        } catch (error) {
          const detail = `${error instanceof McpContractError ? error.code : ""} ${error instanceof Error ? error.message : String(error)}`;
          delivery = /agent_blocked/i.test(detail) ? "rejected_blocked" : /not.?found|missing/i.test(detail) ? "target_unresolved" : "failed";
          warnings.push(`Delivery ${delivery}: ${singleLine(detail).slice(0, 300)}`);
        }
      }
      // A non-delivered bell said only what failed, never what is still true, so
      // the sending ORCH stopped there (friction ef27dbff9f8d30ac ③). The
      // channel document is durable either way; naming that, its coordinates,
      // and the honest limit of this tool turns a dead end into a decision. Only
      // notify_run has a channel document, so the observation this branch tests
      // is also what confines the clause to it — the wake_* bells are untouched.
      if (channelObservation && (delivery === "target_unresolved" || delivery === "rejected_blocked" || delivery === "failed")) {
        warnings.push(`Channel document remains durable at ${channelObservation.path} (sha256=${channelObservation.sha256}, ${channelObservation.bytes} bytes). A future or live target ORCH can discover it from its first prompt or herdr_track inspect; this tool does not guarantee redelivery. Decide whether to escalate now.`);
      }
      await appendMessageLog(store.runPath, {
        at: nowIso(),
        action: input.action,
        sender,
        delivery,
        target: target ?? null,
        text,
        ...(deliveryId ? { delivery_id: deliveryId } : {}),
        ...(tickPlan ? { tick_plan: tickPlan } : {}),
        ...(warnings.length ? { warnings } : {}),
      });
      if (deferredCompletion && target && deliveryId) {
        const finalBase = { action: input.action, sender, target, delivery_id: deliveryId, deferred: true };
        void deferredCompletion.then(
          async () => appendMessageLog(store.runPath, { at: nowIso(), ...finalBase, delivery: "delivered" }),
          async (error) => appendMessageLog(store.runPath, {
            at: nowIso(),
            ...finalBase,
            delivery: "failed",
            warnings: [`Deferred delivery failed: ${singleLine(error instanceof Error ? error.message : String(error)).slice(0, 300)}`],
          }),
        );
      }
      const confirmed = delivery === "delivered" || delivery === "deferred";
      return {
        ok: true,
        tool: "herdr_message",
        action: input.action,
        run,
        effect: confirmed ? "confirmed" : "none",
        retryable: !confirmed,
        data: {
          delivery,
          sender,
          target: target ?? null,
          ...(delivery === "deferred" ? { explanation: "Delivery deferred to avoid interrupting the focused target; the durable document already carries the content.", tick_plan: tickPlan, delivery_id: deliveryId } : {}),
          ...(channelObservation ? { channel: channelObservation } : {}),
          ...(warnings.length ? { warnings } : {}),
        },
      };
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
