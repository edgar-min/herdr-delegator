// Worker responsibilities for the Herdr delegator extension.
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { FocusRestoration, Operation, RegistryRecord, SessionVerification, ToolParams, WorkerResult } from "./contracts";
import { COORDINATE_RE, ContractError, FOCUS_TIMEOUT_MS, REGISTRY_OWNER, RUN_GENERATION, SETTLED_STATES, compactMessage, isObject, nowIso, sha256 } from "./contracts";
import { canonicalWorkerId, isFile, normalizeTimeout, resolveLaunchProfile, resolveRunCoordinate } from "./config";
import type { BootstrapSessionVerification, CommandResult, OwnedFocus } from "./runtime";
import { assertAgentBelongsToRecord, assertLaunchProfile, assertPersistedMatchesBootstrap, assertRecordIdentity, assertRunWorkspaceLive, canonicalSessionPath, captureFocus, collectMatchingObjects, commandError, convergeBootstrapSessionIdentity, ensureRunWorkspace, firstNumber, firstString, getLiveAgent, isMissingHerdrObject, labelPane, observeOrchestrator, publicState, publicWorker, readRegistry, reconcileDeterministicIdentity, registryPaths, requireHerdrEnvironment, restoreFocus, runHerdr, startWorkerAgent, uniqueBy, updateRecordFromObservation, verifiedHerdrSidebarAuxiliaryPane, verifyWorkerSession, waitForAgentStatus, withRegistryLock, writeRegistryAtomic } from "./runtime";

type StalenessRecord = RegistryRecord & {
  last_activity_revision?: number;
  last_activity_at?: string;
};

type BootstrapWorkerRecord = RegistryRecord & {
  bootstrap_attestation?: string;
  bootstrap_attested_at?: string;
  bootstrap_verified_at?: string;
};

function storeWorkerBootstrap(
  record: RegistryRecord,
  verification: BootstrapSessionVerification,
): void {
  const bootstrapRecord = record as BootstrapWorkerRecord;
  record.agent_session_path = verification.reported_path;
  record.verified_session_id = verification.session_id;
  bootstrapRecord.bootstrap_attestation = verification.attestation;
  bootstrapRecord.bootstrap_attested_at = verification.attested_at;
  bootstrapRecord.bootstrap_verified_at = nowIso();
  record.updated_at = bootstrapRecord.bootstrap_verified_at;
}

function storedWorkerBootstrap(record: RegistryRecord): BootstrapSessionVerification | undefined {
  const bootstrapRecord = record as BootstrapWorkerRecord;
  if (
    !record.agent_session_path ||
    !record.verified_session_id ||
    !bootstrapRecord.bootstrap_attestation ||
    !bootstrapRecord.bootstrap_attested_at ||
    !bootstrapRecord.bootstrap_verified_at
  ) {
    return undefined;
  }
  return {
    session_id: record.verified_session_id,
    reported_path: record.agent_session_path,
    attestation: bootstrapRecord.bootstrap_attestation,
    attested_at: bootstrapRecord.bootstrap_attested_at,
  };
}

async function verifyWorkerBootstrap(
  binary: string,
  record: RegistryRecord,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BootstrapSessionVerification> {
  if (!record.tab_id || !record.root_pane_id) {
    throw new ContractError(
      "worker_coordinates_missing",
      "The worker has no complete coordinates for bootstrap verification.",
      "session_verify",
    );
  }
  const converged = await convergeBootstrapSessionIdentity(
    binary,
    record.agent_name,
    {
      workspaceId: record.workspace_id,
      tabId: record.tab_id,
      paneId: record.root_pane_id,
    },
    record.agent_session_path,
    record.verified_session_id,
    timeoutMs,
    signal,
  );
  assertAgentBelongsToRecord(record, converged.observation);
  storeWorkerBootstrap(record, converged.verification);
  return converged.verification;
}

export async function ensureWorker(
  params: ToolParams,
  signal?: AbortSignal,
): Promise<WorkerResult> {
  const timeoutMs = normalizeTimeout(params.timeout_ms);
  const coordinate = await resolveRunCoordinate(params.track_id, params.run_id, params.cwd);
  const runPath = coordinate.runPath;
  const workerId = canonicalWorkerId(params.worker_id);
  const cwd = coordinate.manifest.cwd;
  const workerKey = sha256(`${runPath}\0${workerId}`);
  const { registryPath } = registryPaths(runPath);
  const resolved = await resolveLaunchProfile(params, runPath, cwd);
  const { binary, paneId } = await requireHerdrEnvironment();
  const orchestrator = await observeOrchestrator(binary, paneId, resolved.orchestrator, timeoutMs, signal);
  const focusBefore = await captureFocus(binary, signal);
  const owned: OwnedFocus = { tab_ids: new Set(), pane_ids: new Set() };
  const agentName = `herdr-${workerId}-${workerKey.slice(0, 12)}`;
  let record!: RegistryRecord;
  let modelVerification!: Record<string, unknown>;
  let focusRestoration: FocusRestoration = "unchanged";

  try {
    record = await withRegistryLock(runPath, timeoutMs, async (registry, targetRegistryPath) => {
      const persisted = registry.workers[workerKey];
      if (persisted) {
        assertRecordIdentity(persisted, runPath, workerId, workerKey);
        assertLaunchProfile(persisted, resolved.launch);
      }
      const run = await ensureRunWorkspace(
        binary,
        registry,
        targetRegistryPath,
        runPath,
        coordinate.manifest.track_id,
        coordinate.manifest.run_id,
        cwd,
        orchestrator,
        timeoutMs,
        signal,
      );
      if (!run.workspace_id) {
        throw new ContractError("run_workspace_not_ready", "The run workspace has no live ID.", "workspace_reconcile");
      }
      await assertRunWorkspaceLive(binary, registry, timeoutMs, signal, runPath, cwd);
      owned.workspace_id = run.workspace_id;
      if (run.anchor_tab_id) owned.tab_ids.add(run.anchor_tab_id);
      if (run.anchor_pane_id) owned.pane_ids.add(run.anchor_pane_id);
      // On a legacy run (init + caller-session ORCH) this ensure is what
      // creates or adopts the run anchor, and nothing ever spawns into it, so
      // the bare shell under an "ORCH ..." tab reads as a dead ORCH to the
      // supervising human (friction 1ffc55fca1b7bd9e). A spawn-managed run has
      // a target_orchestrator record before any worker ensure, so its absence
      // marks the anchor as a placeholder. Display-only: the deterministic tab
      // label is untouched, a later start_orchestrator relabels the pane at
      // birth, and a failed rename is ignored like every cosmetic rename.
      if (!registry.run?.target_orchestrator && run.anchor_pane_id) {
        await labelPane(
          binary,
          run.anchor_pane_id,
          `anchor ${coordinate.manifest.track_id}/${coordinate.manifest.run_id} — no ORCH born here; legacy run commanded from the caller session`,
          timeoutMs,
          signal,
        );
      }

      let current = registry.workers[workerKey];
      if (current && (current.run_path !== runPath || current.worker_id !== workerId)) {
        throw new ContractError("identity_conflict", "The registry worker key points to a different identity.", "registry");
      }
      if (!current) {
        const timestamp = nowIso();
        current = {
          run_path: runPath,
          worker_id: workerId,
          worker_key: workerKey,
          generation: RUN_GENERATION,
          workspace_id: run.workspace_id,
          agent_name: agentName,
          state: "planned",
          owner: REGISTRY_OWNER,
          created_tab: false,
          config_sources: resolved.launch.config_sources,
          selected_profile: resolved.launch.selected_profile,
          selection_source: resolved.launch.selection_source,
          requested_role: resolved.launch.requested_role,
          created_at: timestamp,
          updated_at: timestamp,
        };
        registry.workers[workerKey] = current;
        await writeRegistryAtomic(targetRegistryPath, registry);
      }
      assertRecordIdentity(current, runPath, workerId, workerKey);
      if (
        current.generation !== RUN_GENERATION ||
        current.workspace_id !== run.workspace_id ||
        current.owner !== REGISTRY_OWNER
      ) {
        throw new ContractError(
          "identity_conflict",
          "The worker record does not belong to the current run workspace generation.",
          "registry",
          { recovery: "Preserve the record and inspect its run ownership before continuing." },
        );
      }
      if (current.tab_id) owned.tab_ids.add(current.tab_id);
      if (current.root_pane_id) owned.pane_ids.add(current.root_pane_id);

      const live = await getLiveAgent(binary, current.agent_name, timeoutMs, signal);
      if (live.ok) {
        assertAgentBelongsToRecord(current, live.data);
        await updateRecordFromObservation(current, live.data);
        await writeRegistryAtomic(targetRegistryPath, registry);
        return current;
      }
      if (!isMissingHerdrObject(live)) {
        throw commandError(live, "reconcile", "Retry agent get, then inspect the worker coordinates.");
      }

      const recovered = await reconcileDeterministicIdentity(binary, current, cwd, timeoutMs, signal);
      if (recovered.agentData) {
        current.tab_id = recovered.tabId;
        current.root_pane_id = recovered.rootPaneId;
        await updateRecordFromObservation(current, recovered.agentData);
        await writeRegistryAtomic(targetRegistryPath, registry);
        return current;
      }
      if (recovered.tabId && recovered.rootPaneId) {
        current.tab_id = recovered.tabId;
        current.root_pane_id = recovered.rootPaneId;
        if (!current.created_tab) {
          current.created_tab = true;
          current.state = "pane-created";
          current.updated_at = nowIso();
          await writeRegistryAtomic(targetRegistryPath, registry);
        }
      } else if (current.tab_id) {
        const oldTab = await runHerdr(binary, ["tab", "get", current.tab_id], timeoutMs, signal);
        if (oldTab.ok) {
          throw new ContractError(
            "identity_conflict",
            "The registry worker tab still exists but no longer has its deterministic identity.",
            "reconcile",
            { recovery: "Preserve the tab and inspect its ownership before creating a replacement." },
          );
        }
        if (!isMissingHerdrObject(oldTab)) {
          throw commandError(oldTab, "reconcile", "Read the registry worker tab again.");
        }
        delete current.tab_id;
        delete current.root_pane_id;
      }

      if (!current.root_pane_id) {
        const created = await runHerdr(
          binary,
          [
            "tab",
            "create",
            "--workspace",
            run.workspace_id,
            "--cwd",
            cwd,
            "--label",
            current.agent_name,
            "--no-focus",
          ],
          timeoutMs,
          signal,
        );
        if (!created.ok) {
          throw commandError(
            created,
            "tab_create",
            "Read the owned workspace tab list by deterministic label before retrying ensure_worker.",
            created.timedOut,
          );
        }
        current.tab_id = firstString(created.data, ["tab_id"]);
        const roots = collectMatchingObjects(created.data, (item) => isObject(item.root_pane));
        current.root_pane_id =
          firstString(roots[0]?.root_pane, ["pane_id"]) ??
          firstString(created.data, ["root_pane_id"]);
        if (!current.tab_id || !current.root_pane_id) {
          throw new ContractError(
            "invalid_herdr_response",
            "The tab-create response has no tab_id or root_pane.pane_id.",
            "tab_create",
            {
              ambiguousEffect: true,
              recovery: "Read tab list/get with the same deterministic label and do not create another tab.",
            },
          );
        }
        owned.tab_ids.add(current.tab_id);
        owned.pane_ids.add(current.root_pane_id);
        current.created_tab = true;
        current.state = "pane-created";
        current.updated_at = nowIso();
        await writeRegistryAtomic(targetRegistryPath, registry);
      }

      const beforeStart = await getLiveAgent(binary, current.agent_name, timeoutMs, signal);
      if (beforeStart.ok) {
        assertAgentBelongsToRecord(current, beforeStart.data);
        await updateRecordFromObservation(current, beforeStart.data);
        await writeRegistryAtomic(targetRegistryPath, registry);
        return current;
      }
      if (!isMissingHerdrObject(beforeStart)) {
        throw commandError(beforeStart, "agent_start", "Inspect the deterministic worker agent before starting it.");
      }

      const started = await startWorkerAgent(binary, current, resolved.launch, cwd, timeoutMs, signal);
      await updateRecordFromObservation(current, started, "agent-ready");
      if (!SETTLED_STATES[current.state]) current.state = "agent-ready";
      await writeRegistryAtomic(targetRegistryPath, registry);
      return current;
    });
    const storedBootstrap = storedWorkerBootstrap(record);
    let persistedSessionExists = false;
    if (record.agent_session_path !== undefined) {
      try {
        const sessionFile = await lstat(record.agent_session_path);
        if (!sessionFile.isFile() || sessionFile.isSymbolicLink() || !record.agent_session_path.endsWith(".jsonl")) {
          throw new ContractError("session_identity_mismatch", "The official persisted session path is not a regular JSONL file.", "session_verify");
        }
        persistedSessionExists = true;
      } catch (error: unknown) {
        if (error instanceof ContractError) throw error;
        if (!isObject(error) || error.code !== "ENOENT") {
          throw new ContractError("session_identity_mismatch", "The official persisted session path cannot be verified safely.", "session_verify");
        }
      }
    }
    if (persistedSessionExists) {
      if (!storedBootstrap) {
        throw new ContractError(
          "session_verification_incomplete",
          "The persisted worker session has no complete stored bootstrap identity.",
          "session_verify",
          { recovery: "Preserve the worker and session; do not infer or replace missing bootstrap facts." },
        );
      }
      const persisted: SessionVerification = await verifyWorkerSession(binary, record, timeoutMs, signal);
      assertPersistedMatchesBootstrap(persisted, storedBootstrap);
      record = await withRegistryLock(runPath, timeoutMs, async (registry, targetRegistryPath) => {
        const current = registry.workers[workerKey];
        if (!current) throw new ContractError("worker_missing", "The registry record disappeared during persisted model verification.", "registry");
        assertLaunchProfile(current, resolved.launch);
        const currentBootstrap = storedWorkerBootstrap(current);
        if (
          current.agent_session_path !== record.agent_session_path ||
          (current.verified_session_id !== undefined && current.verified_session_id !== persisted.session_id) ||
          JSON.stringify(currentBootstrap) !== JSON.stringify(storedBootstrap)
        ) {
          throw new ContractError("session_identity_mismatch", "The registry session or bootstrap identity changed during persisted model verification.", "registry");
        }
        current.agent_session_path = record.agent_session_path;
        current.verified_session_id = persisted.session_id;
        current.resolved_model_is_fallback = persisted.resolved_model_is_fallback;
        current.verified_at = record.verified_at;
        await writeRegistryAtomic(targetRegistryPath, registry);
        return current;
      });
      modelVerification = { status: "persisted-verified", ...persisted, verified_at: record.verified_at };
    } else {
      const bootstrapVerification = await verifyWorkerBootstrap(binary, record, timeoutMs, signal);
      record = await withRegistryLock(runPath, timeoutMs, async (registry, targetRegistryPath) => {
        const current = registry.workers[workerKey];
        if (!current) throw new ContractError("worker_missing", "The registry record disappeared during bootstrap model verification.", "registry");
        assertLaunchProfile(current, resolved.launch);
        if (current.agent_session_path !== undefined && current.agent_session_path !== bootstrapVerification.reported_path) {
          throw new ContractError("session_identity_mismatch", "The registry session path changed during bootstrap verification.", "registry");
        }
        storeWorkerBootstrap(current, bootstrapVerification);
        await writeRegistryAtomic(targetRegistryPath, registry);
        return current;
      });
      modelVerification = {
        status: "bootstrap-verified",
        session_id: bootstrapVerification.session_id,
        attested_at: bootstrapVerification.attested_at,
      };
    }
  } finally {
    focusRestoration = await restoreFocus(binary, focusBefore, owned);
  }
  // Supervision surface (decision 4): the lane's pane carries `w<N> <responsibility>`
  // so a human scanning the track space reads responsibilities, not hashes.
  const responsibilityKey = typeof params.responsibility_key === "string" && COORDINATE_RE.test(params.responsibility_key)
    ? params.responsibility_key
    : undefined;
  const paneLabelWarning = responsibilityKey && record.root_pane_id
    ? await labelPane(binary, record.root_pane_id, `${workerId} ${responsibilityKey}`, FOCUS_TIMEOUT_MS, signal)
    : undefined;

  return {
    ok: true,
    operation: "ensure_worker",
    worker_key: workerKey,
    state: publicState(record.state),
    retryable: false,
    registry_path: registryPath,
    worker: publicWorker(record),
    observation: {
      focus_restoration: focusRestoration,
      model_verification: modelVerification,
      ...(responsibilityKey ? { pane_label: `${workerId} ${responsibilityKey}` } : {}),
      ...(paneLabelWarning ? { pane_label_warning: paneLabelWarning } : {}),
      ...(resolved.warnings.length ? { role_resolution_warning: resolved.warnings.join(" | ") } : {}),
    },
  };
}

export async function verifyPromptedWorker(
  params: ToolParams,
  signal?: AbortSignal,
): Promise<Pick<WorkerResult, "state" | "worker" | "observation">> {
  const timeoutMs = normalizeTimeout(params.timeout_ms);
  const coordinate = await resolveRunCoordinate(params.track_id, params.run_id);
  const runPath = coordinate.runPath;
  const workerId = canonicalWorkerId(params.worker_id);
  const workerKey = sha256(`${runPath}\0${workerId}`);
  const { registryPath } = registryPaths(runPath);
  const { binary } = await requireHerdrEnvironment();
  const verified = await withRegistryLock(runPath, timeoutMs, async (registry, targetRegistryPath) => {
    await assertRunWorkspaceLive(binary, registry, timeoutMs, signal, runPath, coordinate.manifest.cwd);
    const current = registry.workers[workerKey];
    if (!current?.root_pane_id || !current.agent_name) {
      throw new ContractError("worker_not_ensured", "No registry-owned worker exists for post-prompt verification.", "session_verify");
    }
    assertRecordIdentity(current, runPath, workerId, workerKey);
    const bootstrap = storedWorkerBootstrap(current);
    if (!bootstrap) {
      throw new ContractError("session_verification_incomplete", "The prompted worker has no retained bootstrap attestation.", "session_verify");
    }
    const persisted = await verifyWorkerSession(binary, current, timeoutMs, signal);
    assertPersistedMatchesBootstrap(persisted, bootstrap);
    const live = await getLiveAgent(binary, current.agent_name, Math.min(timeoutMs, 15_000), signal);
    if (!live.ok) throw commandError(live, "session_verify", "Re-read the prompted worker before settlement.");
    assertAgentBelongsToRecord(current, live.data);
    await updateRecordFromObservation(current, live.data, "prompted");
    current.updated_at = nowIso();
    await writeRegistryAtomic(targetRegistryPath, registry);
    return { record: current, persisted };
  });
  return {
    state: publicState(verified.record.state),
    worker: publicWorker(verified.record),
    observation: {
      model_verification: {
        status: "persisted-verified",
        ...verified.persisted,
        verified_at: verified.record.verified_at,
      },
    },
  };
}

export async function inspectWorker(params: ToolParams, signal?: AbortSignal): Promise<WorkerResult> {
  const timeoutMs = normalizeTimeout(params.timeout_ms);
  const coordinate = await resolveRunCoordinate(params.track_id, params.run_id);
  const runPath = coordinate.runPath;
  const workerId = canonicalWorkerId(params.worker_id);
  const workerKey = sha256(`${runPath}\0${workerId}`);
  const { registryPath } = registryPaths(runPath);
  const outputLines = params.output_lines === undefined ? 50 : Number(params.output_lines);
  if (!Number.isInteger(outputLines) || outputLines < 1 || outputLines > 200) {
    throw new ContractError("invalid_output_lines", "output_lines must be an integer from 1 through 200.", "validate");
  }
  const { binary } = await requireHerdrEnvironment();
  const registry = await readRegistry(registryPath);
  await assertRunWorkspaceLive(binary, registry, timeoutMs, signal, runPath, coordinate.manifest.cwd);
  const existing = registry.workers[workerKey];
  if (!existing?.root_pane_id || !existing.agent_name) {
    throw new ContractError("worker_not_ensured", "No worker registry record exists to inspect.", "inspect");
  }

  assertRecordIdentity(existing, runPath, workerId, workerKey);
  const [agent, pane, output] = await Promise.all([
    getLiveAgent(binary, existing.agent_name, timeoutMs, signal),
    runHerdr(binary, ["pane", "get", existing.root_pane_id], timeoutMs, signal, false),
    runHerdr(
      binary,
      [
        "pane",
        "read",
        existing.root_pane_id,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(outputLines),
        "--format",
        "text",
      ],
      timeoutMs,
      signal,
      false,
    ),
  ]);
  if (!agent.ok) throw commandError(agent, "inspect", "Reconcile the identity with ensure_worker.");
  if (!pane.ok) throw commandError(pane, "inspect", "Check the registry root pane, then retry pane observation.");
  assertAgentBelongsToRecord(existing, agent.data);
  if (!output.ok) throw commandError(output, "inspect", "Check the registry root pane, then retry pane read.");

  const observedAt = nowIso();
  const activityRevision = firstNumber(pane.data, ["revision"]);
  const reportPath = path.join(runPath, "a2a", `${workerId}-report.md`);
  const reportExists = await isFile(reportPath);
  const record = await withRegistryLock(runPath, timeoutMs, async (latest, targetRegistryPath) => {
    const current = latest.workers[workerKey] as StalenessRecord | undefined;
    if (!current) throw new ContractError("worker_missing", "The registry record disappeared during inspection.", "registry");
    await assertRunWorkspaceLive(binary, latest, timeoutMs, signal, runPath, coordinate.manifest.cwd);
    if (current.last_activity_revision !== activityRevision || !current.last_activity_at) {
      if (activityRevision !== undefined) current.last_activity_revision = activityRevision;
      current.last_activity_at = observedAt;
    }
    await updateRecordFromObservation(current, agent.data);
    await writeRegistryAtomic(targetRegistryPath, latest);
    return current;
  });

  return {
    ok: true,
    operation: "inspect_worker",
    worker_key: workerKey,
    state: publicState(record.state),
    retryable: false,
    registry_path: registryPath,
    worker: publicWorker(record),
    observation: {
      output: output.data,
      output_lines: outputLines,
      report_exists: reportExists,
      report_path: reportPath,
      staleness: {
        observed_at: observedAt,
        last_activity_at: record.last_activity_at,
      },
    },
  };
}

export async function closeWorker(params: ToolParams, signal?: AbortSignal): Promise<WorkerResult> {
  const timeoutMs = normalizeTimeout(params.timeout_ms);
  const coordinate = await resolveRunCoordinate(params.track_id, params.run_id);
  const runPath = coordinate.runPath;
  const workerId = canonicalWorkerId(params.worker_id);
  const workerKey = sha256(`${runPath}\0${workerId}`);
  const { registryPath } = registryPaths(runPath);
  const { binary } = await requireHerdrEnvironment();
  const focusBefore = await captureFocus(binary, signal);
  const owned: OwnedFocus = { tab_ids: new Set(), pane_ids: new Set() };
  let focusRestoration: FocusRestoration = "unchanged";
  let result!: WorkerResult;

  try {
    const closed = await withRegistryLock(runPath, timeoutMs, async (registry, targetRegistryPath) => {
      const run = await assertRunWorkspaceLive(binary, registry, timeoutMs, signal, runPath, coordinate.manifest.cwd);
      owned.workspace_id = run.workspace_id;
      if (run.anchor_tab_id) owned.tab_ids.add(run.anchor_tab_id);
      if (run.anchor_pane_id) owned.pane_ids.add(run.anchor_pane_id);
      const record = registry.workers[workerKey];
      if (!record?.tab_id || !record.root_pane_id || !record.agent_name) {
        throw new ContractError(
          "worker_not_ensured",
          "No complete registry-owned worker coordinates exist to close.",
          "close_prepare",
        );
      }
      assertRecordIdentity(record, runPath, workerId, workerKey);
      if (
        record.workspace_id !== run.workspace_id ||
        record.owner !== REGISTRY_OWNER ||
        record.created_tab !== true
      ) {
        throw new ContractError(
          "worker_not_owned",
          "The registry does not prove that herdr-delegator created this worker tab in the owned run workspace.",
          "close_prepare",
          { recovery: "Do not close the tab automatically; inspect its ownership outside this tool." },
        );
      }
      owned.tab_ids.add(record.tab_id);
      owned.pane_ids.add(record.root_pane_id);

      if (record.state === "closing") {
        const tabAfterAmbiguousClose = await runHerdr(
          binary,
          ["tab", "get", record.tab_id],
          Math.min(timeoutMs, 15_000),
          signal,
        );
        if (!tabAfterAmbiguousClose.ok && isMissingHerdrObject(tabAfterAmbiguousClose)) {
          record.state = "closed";
          record.closed_at = nowIso();
          record.updated_at = record.closed_at;
          await writeRegistryAtomic(targetRegistryPath, registry);
          return {
            record,
            stateBefore: "closing",
            recovered: true,
            acceptedAuxiliaryPaneIds: [],
          };
        }
        throw new ContractError(
          "close_effect_ambiguous",
          "A previous close attempt has an unresolved effect.",
          "close_prepare",
          {
            retryable: true,
            ambiguousEffect: true,
            recovery: "Inspect the tab and registry coordinates; do not issue another close until absence is proven.",
          },
        );
      }

      const agent = await getLiveAgent(binary, record.agent_name, timeoutMs, signal);
      if (!agent.ok) {
        throw commandError(agent, "close_prepare", "Read the live agent and tab coordinates before deciding whether to close.");
      }
      assertAgentBelongsToRecord(record, agent.data);
      const liveState = firstString(agent.data, ["agent_status", "state", "status"]);
      if (liveState !== "idle" && liveState !== "done" && liveState !== "failed") {
        throw new ContractError(
          "worker_not_settled",
          `The live worker state is ${liveState ?? "unknown"}; only idle, done, or failed may be closed.`,
          "close_prepare",
          { recovery: "Wait for a settled state or resolve the block, then inspect the worker again." },
        );
      }

      const [tab, panes] = await Promise.all([
        runHerdr(binary, ["tab", "get", record.tab_id], timeoutMs, signal),
        runHerdr(binary, ["pane", "list", "--workspace", record.workspace_id], timeoutMs, signal),
      ]);
      if (!tab.ok) throw commandError(tab, "close_prepare", "Read the registry tab again before closing.");
      if (!panes.ok) throw commandError(panes, "close_prepare", "Read the workspace pane list again before closing.");
      const tabObject = collectMatchingObjects(
        tab.data,
        (candidate) => candidate.tab_id === record.tab_id,
      )[0];
      if (!tabObject || tabObject.label !== record.agent_name) {
        throw new ContractError(
          "identity_conflict",
          "The live tab identity or deterministic label differs from the registry-owned worker.",
          "close_prepare",
          { recovery: "Do not close the tab; inspect the conflicting live identity." },
        );
      }
      const tabPaneCandidates = collectMatchingObjects(
        panes.data,
        (candidate) =>
          candidate.tab_id === record.tab_id &&
          typeof candidate.pane_id === "string",
      );
      const tabPanes = uniqueBy(tabPaneCandidates, ["pane_id"]);
      const rootPanes = tabPanes.filter(
        (pane) => pane.pane_id === record.root_pane_id,
      );
      const auxiliaryPaneCandidates = tabPaneCandidates.filter(
        (pane) => pane.pane_id !== record.root_pane_id,
      );
      const auxiliaryPanes = tabPanes.filter(
        (pane) => pane.pane_id !== record.root_pane_id,
      );
      const auxiliaryPaneProofs = await Promise.all(
        auxiliaryPaneCandidates.map((pane) =>
          verifiedHerdrSidebarAuxiliaryPane(pane, record, run.cwd)
        ),
      );
      if (
        rootPanes.length !== 1 ||
        auxiliaryPaneProofs.some((verified) => !verified)
      ) {
        throw new ContractError(
          "other_pane_occupant",
          "The worker tab contains an occupant other than the registry root pane or a verified Herdr Sidebar auxiliary pane, or its pane topology is ambiguous.",
          "close_prepare",
          { recovery: "Do not close the tab while another pane occupant or ambiguous pane topology exists." },
        );
      }
      const acceptedAuxiliaryPaneIds = auxiliaryPanes.map(
        (pane) => pane.pane_id as string,
      );

      await updateRecordFromObservation(record, agent.data);
      record.state = "closing";
      record.updated_at = nowIso();
      await writeRegistryAtomic(targetRegistryPath, registry);
      const closeResult = await runHerdr(
        binary,
        ["tab", "close", record.tab_id],
        timeoutMs,
        signal,
      );
      if (!closeResult.ok) {
        throw commandError(
          closeResult,
          "close_worker",
          "The close effect may be ambiguous; inspect tab absence and do not repeat the close blindly.",
          true,
        );
      }
      record.state = "closed";
      record.closed_at = nowIso();
      record.updated_at = record.closed_at;
      await writeRegistryAtomic(targetRegistryPath, registry);
      return {
        record,
        stateBefore: liveState,
        recovered: false,
        acceptedAuxiliaryPaneIds,
      };
    });

    result = {
      ok: true,
      operation: "close_worker",
      worker_key: workerKey,
      state: "closed",
      retryable: false,
      registry_path: registryPath,
      worker: publicWorker(closed.record),
      observation: {
        tab_id: closed.record.tab_id,
        state_before_close: closed.stateBefore,
        recovered_ambiguous_close: closed.recovered,
        closed_at: closed.record.closed_at,
        accepted_auxiliary_pane_ids: closed.acceptedAuxiliaryPaneIds ?? [],
      },
    };
  } finally {
    focusRestoration = await restoreFocus(binary, focusBefore, owned);
  }
  result.observation = {
    ...(result.observation ?? {}),
    focus_restoration: focusRestoration,
  };
  return result;
}

export async function failureResult(
  operation: Operation,
  params: ToolParams,
  error: unknown,
): Promise<WorkerResult> {
  const known = error instanceof ContractError ? error : undefined;
  return {
    ok: false,
    operation,
    worker_key: "",
    state: "failed",
    retryable: known?.retryable ?? false,
    registry_path: "",
    error: {
      code: known?.code ?? "internal_error",
      message: compactMessage(known?.message, "herdr_worker encountered an internal error."),
      phase: known?.phase ?? "internal",
      ambiguous_effect: known?.ambiguousEffect ?? false,
      recovery: known?.recovery ?? "Inspect the current coordinates and state with inspect_worker before retrying.",
    },
  };
}

export function resultSummary(result: WorkerResult): string {
  if (result.ok) return `${result.operation} completed: ${result.worker?.worker_id ?? "worker"} state=${result.state}`;
  return `${result.operation} failed: ${result.error?.code ?? "unknown"} (${result.error?.message ?? "error"})`;
}
