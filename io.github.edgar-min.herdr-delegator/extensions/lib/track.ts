// Track lifecycle responsibilities for the Herdr delegator extension.
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { FocusRestoration, OmpModelContext, ResetLineage, RunManifest, RunRecord, SessionVerification, TargetOrchestratorRecord, ThinkingLevel, TrackOperation, TrackParams, TrackResult } from "./contracts";
import { ContractError, REGISTRY_OWNER, RUN_GENERATION, RESET_EVIDENCE_POLICY, RESET_WORKER_POLICY, assertExactKeys, compactMessage, isObject, nowIso, sha256 } from "./contracts";
import { PROTOCOL_TEMPLATE_PATH, canonicalCoordinate, canonicalCwd, canonicalOrchestratorInstruction, copyAtomic, effectiveThinking, isFile, loadDelegatorConfig, modelIdentity, normalizeTimeout, readRunIndex, readRunManifest, resolveOrchestratorProfile, resolveRunCoordinate, storageRootFromConfig, validateOrchestratorRun, writeAtomic } from "./config";
import type { BootstrapSessionVerification, OwnedFocus } from "./runtime";
import { acquireLock, assertNoDuplicateSession, assertPersistedMatchesBootstrap, assertRunWorkspaceLive, canonicalSessionPath, captureFocus, collectMatchingObjects, commandError, convergeBootstrapSessionIdentity, convergeOfficialSessionIdentity, deepValues, ensureRunWorkspace, firstNumber, firstString, getLiveAgent, isMissingHerdrObject, normalizeState, observeOrchestrator, readRegistry, readSessionVerification, registryPaths, releaseLock, reportedSessionPath, requireHerdrEnvironment, restoreFocus, runHerdr, uniqueBy, withRegistryLock, writeRegistryAtomic } from "./runtime";
import { verifiedHerdrSidebarAuxiliaryPane } from "./worker";

const PROTOCOL_DOCUMENT_NAMES = ["protocol.md", "protocol-orch.md", "protocol-worker.md"] as const;

async function initializeRun(params: TrackParams): Promise<TrackResult> {
  const timeoutMs = normalizeTimeout(params.timeout_ms);
  const trackId = canonicalCoordinate(params.track_id, "track_id");
  const runId = canonicalCoordinate(params.run_id, "run_id");
  const cwd = await canonicalCwd(params.cwd);
  const loaded = await loadDelegatorConfig(undefined, cwd);
  const storageRoot = await storageRootFromConfig(loaded.config, true);
  const runPath = path.join(storageRoot, trackId, runId);
  const runKey = sha256(runPath);
  const protocolTemplateDirectory = path.dirname(PROTOCOL_TEMPLATE_PATH);
  const protocolDocuments = await Promise.all(PROTOCOL_DOCUMENT_NAMES.map(async (name) => {
    const templatePath = path.join(protocolTemplateDirectory, name);
    return { name, templatePath, template: await readFile(templatePath) };
  }));
  let resetCoordinate: { track_id: string; run_id: string; path: string } | undefined;
  let sourcePlanPath: string | undefined;
  let sourcePlanHash: string | undefined;
  if (params.reset_of !== undefined) {
    if (!isObject(params.reset_of)) {
      throw new ContractError("invalid_reset_source", "reset_of must contain track_id and run_id.", "validate");
    }
    try {
      assertExactKeys(params.reset_of, ["track_id", "run_id"], "reset_of");
    } catch {
      throw new ContractError("invalid_reset_source", "reset_of must contain exactly track_id and run_id.", "validate");
    }
    const sourceTrackId = canonicalCoordinate(params.reset_of.track_id, "track_id");
    const sourceRunId = canonicalCoordinate(params.reset_of.run_id, "run_id");
    const sourcePath = path.join(storageRoot, sourceTrackId, sourceRunId);
    if (sourcePath === runPath) {
      throw new ContractError("invalid_reset_source", "A reset source must be a different run coordinate.", "validate");
    }
    try {
      if ((await realpath(sourcePath)) !== sourcePath) throw new Error("not canonical");
    } catch {
      throw new ContractError("invalid_reset_source", "The reset source coordinate is missing or not canonical.", "validate");
    }
    const sourceManifest = await readRunManifest(sourcePath);
    let sourceCwd: string;
    try {
      sourceCwd = await realpath(sourceManifest.cwd);
    } catch {
      throw new ContractError("invalid_reset_source", "The reset source cwd is no longer accessible.", "validate");
    }
    if (
      sourceManifest.track_id !== sourceTrackId ||
      sourceManifest.run_id !== sourceRunId ||
      sourceManifest.run_path !== sourcePath ||
      sourceCwd !== sourceManifest.cwd
    ) {
      throw new ContractError("invalid_reset_source", "The reset source manifest conflicts with its coordinate.", "validate");
    }
    sourcePlanPath = path.join(sourcePath, "plan.md");
    try {
      if ((await realpath(sourcePlanPath)) !== sourcePlanPath || !(await isFile(sourcePlanPath))) {
        throw new Error("not canonical");
      }
    } catch {
      throw new ContractError("invalid_reset_source", "The reset source must contain canonical plan.md.", "validate");
    }
    sourcePlanHash = sha256(await readFile(sourcePlanPath));
    resetCoordinate = { track_id: sourceTrackId, run_id: sourceRunId, path: sourcePath };
  }

  const indexPath = path.join(storageRoot, "index.json");
  const lockPath = path.join(storageRoot, ".run-index.lock");
  const owner = await acquireLock(lockPath, timeoutMs);
  let stagingPath: string | undefined;
  try {
    const runParent = path.dirname(runPath);
    await mkdir(runParent, { recursive: true, mode: 0o700 });
    if ((await realpath(runParent)) !== runParent) {
      throw new ContractError("run_init_conflict", "The canonical target parent resolves elsewhere.", "storage");
    }

    const index = await readRunIndex(indexPath);
    const indexKey = `${trackId}/${runId}`;
    const existingRow = index.runs[indexKey];
    let targetExists = false;
    try {
      const targetStat = await lstat(runPath);
      targetExists = true;
      if (!targetStat.isDirectory() || (await realpath(runPath)) !== runPath) {
        throw new ContractError("run_init_conflict", "The target run path is not a canonical directory.", "storage");
      }
    } catch (error: unknown) {
      if (error instanceof ContractError) throw error;
      if (!isObject(error) || error.code !== "ENOENT") {
        throw new ContractError(
          "run_init_conflict",
          compactMessage(isObject(error) ? error.message : undefined, "The target run path cannot be inspected safely."),
          "storage",
        );
      }
    }

    let manifest: RunManifest;
    if (targetExists) {
      manifest = await readRunManifest(runPath);
      if (
        manifest.track_id !== trackId ||
        manifest.run_id !== runId ||
        manifest.run_path !== runPath ||
        manifest.cwd !== cwd ||
        JSON.stringify(manifest.reset_of) !== JSON.stringify(resetCoordinate)
      ) {
        throw new ContractError(
          "run_init_conflict",
          "Existing run.json conflicts with the requested identity, cwd, path, or reset lineage.",
          "storage",
        );
      }
      const a2aPath = path.join(runPath, "a2a");
      try {
        if ((await realpath(a2aPath)) !== a2aPath || (await lstat(a2aPath)).isDirectory() === false) {
          throw new Error("not canonical");
        }
      } catch {
        throw new ContractError("run_init_conflict", "Existing a2a is missing or not a canonical directory.", "storage");
      }

      const missingProtocols: typeof protocolDocuments = [];
      for (const protocol of protocolDocuments) {
        const protocolPath = path.join(runPath, protocol.name);
        try {
          const protocolStat = await lstat(protocolPath);
          if (!protocolStat.isFile() || protocolStat.isSymbolicLink() || (await realpath(protocolPath)) !== protocolPath || !(await readFile(protocolPath)).equals(protocol.template)) {
            throw new ContractError(
              "run_init_conflict",
              `Existing ${protocol.name} is not canonical or differs from the bundled template.`,
              "storage",
            );
          }
        } catch (error: unknown) {
          if (error instanceof ContractError) throw error;
          if (!isObject(error) || error.code !== "ENOENT") {
            throw new ContractError("run_init_conflict", `Existing ${protocol.name} cannot be inspected safely.`, "storage");
          }
          missingProtocols.push(protocol);
        }
      }
      if (missingProtocols.length > 0) {
        const entries = (await readdir(runPath)).sort();
        const a2aEntries = await readdir(a2aPath);
        const boundedRecoveryEntries: Record<string, true> = { a2a: true, "run.json": true, "protocol.md": true, "protocol-orch.md": true, "protocol-worker.md": true };
        const recoverableIncompleteTarget =
          resetCoordinate === undefined &&
          existingRow === undefined &&
          entries.every((entry) => boundedRecoveryEntries[entry]) &&
          a2aEntries.length === 0;
        if (!existingRow && !recoverableIncompleteTarget) {
          throw new ContractError(
            "run_init_conflict",
            "Missing role-scoped protocols are not in an index-owned run or the bounded manifest-plus-empty-a2a recovery layout.",
            "storage",
          );
        }
        for (const protocol of missingProtocols) {
          const protocolPath = path.join(runPath, protocol.name);
          await copyAtomic(protocol.templatePath, protocolPath);
          if ((await realpath(protocolPath)) !== protocolPath || !(await readFile(protocolPath)).equals(protocol.template)) {
            throw new ContractError("storage_write_failed", `Recovered ${protocol.name} failed byte verification.`, "storage");
          }
        }
      }

      if (resetCoordinate && sourcePlanPath && sourcePlanHash) {
        const sourcePlan = await readFile(sourcePlanPath);
        if (sha256(sourcePlan) !== sourcePlanHash) {
          throw new ContractError(
            "reset_source_changed",
            "The reset source plan changed while init_run held the storage transaction.",
            "storage",
          );
        }
        const targetPlanPath = path.join(runPath, "plan.md");
        const resetPath = path.join(runPath, "reset.json");
        const reset: ResetLineage = {
          version: 1,
          reset_of: resetCoordinate.path,
          source_plan_sha256: sourcePlanHash,
          worker_policy: RESET_WORKER_POLICY,
          evidence_policy: RESET_EVIDENCE_POLICY,
          created_at: manifest.created_at,
        };
        try {
          if (
            (await realpath(targetPlanPath)) !== targetPlanPath ||
            (await realpath(resetPath)) !== resetPath ||
            !(await readFile(targetPlanPath)).equals(sourcePlan) ||
            JSON.stringify(JSON.parse(await readFile(resetPath, "utf8"))) !== JSON.stringify(reset)
          ) {
            throw new Error("reset mismatch");
          }
        } catch {
          throw new ContractError(
            "run_init_conflict",
            "Existing reset plan or reset.json is missing, non-canonical, or conflicts with the requested lineage.",
            "storage",
          );
        }
      }
    } else {
      if (existingRow) {
        throw new ContractError("run_index_conflict", "index.json names a target run directory that does not exist.", "storage");
      }
      const stagingPrefix = `.${runId}.init-`;
      stagingPath = await mkdtemp(path.join(runParent, stagingPrefix));
      if (
        path.dirname(stagingPath) !== runParent ||
        !path.basename(stagingPath).startsWith(stagingPrefix) ||
        (await realpath(stagingPath)) !== stagingPath
      ) {
        throw new ContractError("run_init_conflict", "The staging directory is outside its canonical target parent.", "storage");
      }

      manifest = {
        version: 1,
        track_id: trackId,
        run_id: runId,
        cwd,
        run_path: runPath,
        created_at: nowIso(),
        ...(resetCoordinate ? { reset_of: resetCoordinate } : {}),
      };
      await mkdir(path.join(stagingPath, "a2a"), { mode: 0o700 });
      await writeAtomic(path.join(stagingPath, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      for (const protocol of protocolDocuments) {
        await copyAtomic(protocol.templatePath, path.join(stagingPath, protocol.name));
      }

      let sourcePlan: Buffer | undefined;
      let reset: ResetLineage | undefined;
      if (resetCoordinate && sourcePlanPath && sourcePlanHash) {
        sourcePlan = await readFile(sourcePlanPath);
        if (sha256(sourcePlan) !== sourcePlanHash) {
          throw new ContractError(
            "reset_source_changed",
            "The reset source plan changed while init_run held the storage transaction.",
            "storage",
          );
        }
        await copyAtomic(sourcePlanPath, path.join(stagingPath, "plan.md"));
        reset = {
          version: 1,
          reset_of: resetCoordinate.path,
          source_plan_sha256: sourcePlanHash,
          worker_policy: RESET_WORKER_POLICY,
          evidence_policy: RESET_EVIDENCE_POLICY,
          created_at: manifest.created_at,
        };
        await writeAtomic(path.join(stagingPath, "reset.json"), `${JSON.stringify(reset, null, 2)}\n`);
      }

      const stagedManifest = await readRunManifest(stagingPath);
      const stagedProtocolMatches = await Promise.all(protocolDocuments.map(async (protocol) =>
        (await readFile(path.join(stagingPath!, protocol.name))).equals(protocol.template)
      ));
      const expectedEntries = resetCoordinate
        ? ["a2a", "plan.md", "protocol-orch.md", "protocol-worker.md", "protocol.md", "reset.json", "run.json"]
        : ["a2a", "protocol-orch.md", "protocol-worker.md", "protocol.md", "run.json"];
      if (
        JSON.stringify(stagedManifest) !== JSON.stringify(manifest) ||
        JSON.stringify((await readdir(stagingPath)).sort()) !== JSON.stringify(expectedEntries) ||
        (await realpath(path.join(stagingPath, "a2a"))) !== path.join(stagingPath, "a2a") ||
        (await readdir(path.join(stagingPath, "a2a"))).length !== 0 ||
        stagedProtocolMatches.some((matches) => !matches) ||
        (sourcePlan !== undefined && !(await readFile(path.join(stagingPath, "plan.md"))).equals(sourcePlan)) ||
        (reset !== undefined &&
          JSON.stringify(JSON.parse(await readFile(path.join(stagingPath, "reset.json"), "utf8"))) !==
            JSON.stringify(reset))
      ) {
        throw new ContractError("storage_write_failed", "The staged run failed pre-commit byte or contract verification.", "storage");
      }

      await rename(stagingPath, runPath);
      stagingPath = undefined;
      if ((await realpath(runPath)) !== runPath) {
        throw new ContractError(
          "run_commit_ambiguous",
          "The run rename completed but the committed target is not canonical.",
          "storage",
          {
            ambiguousEffect: true,
            recovery: `Reconcile the exact ${trackId}/${runId} manifest and canonical run path before retrying init_run; never delete the committed target automatically.`,
          },
        );
      }
    }

    if (
      existingRow &&
      (existingRow.run_path !== runPath || existingRow.cwd !== cwd || existingRow.created_at !== manifest.created_at)
    ) {
      throw new ContractError("run_index_conflict", "index.json conflicts with the initialized run manifest.", "storage");
    }
    if (!existingRow) {
      index.runs[indexKey] = {
        track_id: trackId,
        run_id: runId,
        run_path: runPath,
        cwd,
        state: "initialized",
        created_at: manifest.created_at,
        updated_at: manifest.created_at,
      };
      try {
        await writeAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
      } catch (error: unknown) {
        throw new ContractError(
          "run_index_update_ambiguous",
          compactMessage(
            isObject(error) ? error.message : undefined,
            "The run is complete, but its storage index update did not complete.",
          ),
          "storage",
          {
            retryable: true,
            ambiguousEffect: true,
            recovery: `Call init_run again with exact track_id=${trackId}, run_id=${runId}, and cwd=${cwd}; it must reconcile this manifest before retrying index.json. Never delete the committed target.`,
          },
        );
      }
    }
    return {
      ok: true,
      operation: "init_run",
      run_key: runKey,
      state: "initialized",
      retryable: false,
      registry_path: path.join(runPath, "a2a", "herdr-workers.json"),
      run: {
        track_id: trackId,
        run_id: runId,
        run_path: runPath,
        cwd,
        manifest_path: path.join(runPath, "run.json"),
        protocol_path: path.join(runPath, "protocol.md"),
        reset_of: resetCoordinate,
      },
      observation: { index_path: indexPath, storage_root: storageRoot },
    };
  } catch (error: unknown) {
    if (stagingPath !== undefined) {
      try {
        if (
          path.dirname(stagingPath) !== path.dirname(runPath) ||
          !path.basename(stagingPath).startsWith(`.${runId}.init-`) ||
          (await realpath(stagingPath)) !== stagingPath
        ) {
          throw new Error("unverified staging coordinate");
        }
        await rm(stagingPath, { recursive: true, force: false });
      } catch (cleanupError: unknown) {
        if (!isObject(cleanupError) || cleanupError.code !== "ENOENT") {
          throw new ContractError(
            "run_staging_cleanup_failed",
            compactMessage(
              isObject(cleanupError) ? cleanupError.message : undefined,
              "Fresh initialization failed and its verified staging directory could not be removed.",
            ),
            "storage",
            {
              ambiguousEffect: true,
              recovery: `Inspect only the bounded staging coordinate ${stagingPath}; the final target ${runPath} was not committed.`,
            },
          );
        }
      }
    }
    throw error;
  } finally {
    await releaseLock(lockPath, owner);
  }
}

type BootstrapTargetRecord = TargetOrchestratorRecord & {
  bootstrap_attestation?: string;
  bootstrap_attested_at?: string;
  bootstrap_verified_at?: string;
};

function storeTargetBootstrap(
  target: TargetOrchestratorRecord,
  verification: BootstrapSessionVerification,
): void {
  const bootstrapTarget = target as BootstrapTargetRecord;
  target.session_path = verification.reported_path;
  target.session_id = verification.session_id;
  bootstrapTarget.bootstrap_attestation = verification.attestation;
  bootstrapTarget.bootstrap_attested_at = verification.attested_at;
  bootstrapTarget.bootstrap_verified_at = nowIso();
  target.updated_at = bootstrapTarget.bootstrap_verified_at;
}

function storedTargetBootstrap(
  target: TargetOrchestratorRecord,
): BootstrapSessionVerification | undefined {
  const bootstrapTarget = target as BootstrapTargetRecord;
  if (
    !target.session_path ||
    !target.session_id ||
    !bootstrapTarget.bootstrap_attestation ||
    !bootstrapTarget.bootstrap_attested_at ||
    !bootstrapTarget.bootstrap_verified_at
  ) {
    return undefined;
  }
  return {
    session_id: target.session_id,
    reported_path: target.session_path,
    provider: target.expected_provider,
    model: target.expected_model,
    thinking: target.effective_thinking,
    attestation: bootstrapTarget.bootstrap_attestation,
    attested_at: bootstrapTarget.bootstrap_attested_at,
  };
}

async function verifyTargetBootstrapSession(
  binary: string,
  run: RunRecord,
  target: TargetOrchestratorRecord,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BootstrapSessionVerification> {
  const converged = await convergeBootstrapSessionIdentity(
    binary,
    target.agent_name,
    {
      workspaceId: target.workspace_id,
      tabId: target.tab_id,
      paneId: target.pane_id,
    },
    target,
    target.session_path,
    target.session_id,
    timeoutMs,
    signal,
  );
  assertTargetAgentBelongs(run, target, converged.observation);
  storeTargetBootstrap(target, converged.verification);
  return converged.verification;
}

function publicTargetOrchestrator(record: TargetOrchestratorRecord): Record<string, unknown> {
  const bootstrapTarget = record as BootstrapTargetRecord;
  return {
    workspace_id: record.workspace_id,
    tab_id: record.tab_id,
    pane_id: record.pane_id,
    agent_name: record.agent_name,
    session_path: record.session_path,
    session_id: record.session_id,
    state: record.state,
    state_change_seq: record.state_change_seq,
    instruction_path: record.instruction_path,
    prompt_sha256: record.prompt_sha256,
    prompt_state: record.prompt_state,
    config_sources: record.config_sources,
    requested_role: record.requested_role,
    expected_provider: record.expected_provider,
    expected_model: record.expected_model,
    effective_thinking: record.effective_thinking,
    resolved_model_is_fallback: record.resolved_model_is_fallback,
    verified_at: record.verified_at,
    verification_status:
      record.verified_at && record.resolved_model_is_fallback !== undefined
        ? "persisted-verified"
        : bootstrapTarget.bootstrap_verified_at
          ? "bootstrap-verified"
          : "unverified",
    bootstrap_attested_at: bootstrapTarget.bootstrap_attested_at,
    bootstrap_verified_at: bootstrapTarget.bootstrap_verified_at,
  };
}

function publicResetRun(run: RunRecord): Record<string, unknown> {
  return {
    run_path: run.run_path,
    run_key: run.run_key,
    cwd: run.cwd,
    generation: run.generation,
    workspace_label: run.workspace_label,
    workspace_id: run.workspace_id,
    anchor_tab_id: run.anchor_tab_id,
    anchor_pane_id: run.anchor_pane_id,
    workspace_state: run.workspace_state,
    reset_lineage: run.reset_lineage,
  };
}

function assertTargetLaunchProfile(
  record: TargetOrchestratorRecord,
  launch: Pick<
    TargetOrchestratorRecord,
    "config_sources" | "requested_role" | "expected_provider" | "expected_model" | "effective_thinking"
  >,
): void {
  if (
    record.requested_role !== launch.requested_role ||
    record.expected_provider !== launch.expected_provider ||
    record.expected_model !== launch.expected_model ||
    record.effective_thinking !== launch.effective_thinking ||
    JSON.stringify(record.config_sources) !== JSON.stringify(launch.config_sources)
  ) {
    throw new ContractError(
      "model_profile_mismatch",
      "The target ORCH launch profile differs from the registry-recorded orchestrator role resolution.",
      "model_verify",
      { recovery: "Preserve the target session; initialize a sibling run instead of switching its launch profile in place." },
    );
  }
}

function assertTargetAgentBelongs(
  run: RunRecord,
  target: TargetOrchestratorRecord,
  data: unknown,
): void {
  const paneId = firstString(data, ["pane_id"]);
  const workspaceId = firstString(data, ["workspace_id"]);
  const tabId = firstString(data, ["tab_id"]);
  if (
    paneId !== target.pane_id ||
    workspaceId !== target.workspace_id ||
    (tabId !== undefined && tabId !== target.tab_id) ||
    target.workspace_id !== run.workspace_id ||
    target.tab_id !== run.anchor_tab_id ||
    target.pane_id !== run.anchor_pane_id
  ) {
    throw new ContractError(
      "identity_conflict",
      "The deterministic target ORCH does not own the target run anchor coordinates.",
      "orch_reconcile",
      { recovery: "Preserve the workspace and inspect its anchor and deterministic agent identity." },
    );
  }
}

async function assertTargetAnchorShell(
  binary: string,
  run: RunRecord,
  target: TargetOrchestratorRecord,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const [tab, pane, panes, processInfo] = await Promise.all([
    runHerdr(binary, ["tab", "get", target.tab_id], timeoutMs, signal),
    runHerdr(binary, ["pane", "get", target.pane_id], timeoutMs, signal),
    runHerdr(binary, ["pane", "list", "--workspace", target.workspace_id], timeoutMs, signal),
    runHerdr(binary, ["pane", "process-info", "--pane", target.pane_id], timeoutMs, signal),
  ]);
  if (!tab.ok) throw commandError(tab, "orch_start_prepare", "Inspect the target run anchor tab.");
  if (!pane.ok) throw commandError(pane, "orch_start_prepare", "Inspect the target run anchor pane.");
  if (!panes.ok) throw commandError(panes, "orch_start_prepare", "Inspect the target run anchor tab panes.");
  if (!processInfo.ok) throw commandError(processInfo, "orch_start_prepare", "Inspect the anchor process.");
  const tabObjects = uniqueBy(
    collectMatchingObjects(tab.data, (item) => item.tab_id === target.tab_id),
    ["tab_id"],
  );
  const paneObjects = uniqueBy(
    collectMatchingObjects(pane.data, (item) => item.pane_id === target.pane_id),
    ["pane_id"],
  );
  const tabObject = tabObjects[0];
  const paneObject = paneObjects[0];
  const tabPanes = uniqueBy(
    collectMatchingObjects(
      panes.data,
      (item) => item.tab_id === target.tab_id && typeof item.pane_id === "string",
    ),
    ["pane_id"],
  );
  const rootPanes = tabPanes.filter((candidate) => candidate.pane_id === target.pane_id);
  const auxiliaryPanes = tabPanes.filter((candidate) => candidate.pane_id !== target.pane_id);
  const auxiliaryProofs = await Promise.all(
    auxiliaryPanes.map((candidate) =>
      verifiedHerdrSidebarAuxiliaryPane(
        candidate,
        {
          workspace_id: target.workspace_id,
          tab_id: target.tab_id,
          root_pane_id: target.pane_id,
        },
        run.cwd,
      )
    ),
  );
  const paneCwd = firstString(paneObject, ["cwd"]);
  let canonicalPaneCwd: string | undefined;
  try {
    canonicalPaneCwd = paneCwd ? await realpath(paneCwd) : undefined;
  } catch {
    canonicalPaneCwd = undefined;
  }
  const processRecord = collectMatchingObjects(
    processInfo.data,
    (item) => Array.isArray(item.foreground_processes),
  )[0];
  const foregroundProcesses = Array.isArray(processRecord?.foreground_processes)
    ? processRecord.foreground_processes.filter(isObject)
    : [];
  const foreground = foregroundProcesses[0];
  const shellPid = firstNumber(processRecord, ["shell_pid"]);
  const foregroundPid = firstNumber(foreground, ["pid"]);
  const foregroundName = firstString(foreground, ["name", "argv0"]);
  const shellObserved =
    foregroundProcesses.length === 1 &&
    shellPid !== undefined &&
    foregroundPid === shellPid &&
    typeof foregroundName === "string" &&
    /^-?(?:zsh|bash|fish|sh|nu)$/.test(path.basename(foregroundName));
  const processText = String(JSON.stringify(processInfo.data)).toLowerCase();
  if (
    run.owner !== REGISTRY_OWNER ||
    run.generation !== RUN_GENERATION ||
    run.workspace_state !== "ready" ||
    run.workspace_id !== target.workspace_id ||
    run.anchor_tab_id !== target.tab_id ||
    run.anchor_pane_id !== target.pane_id ||
    tabObjects.length !== 1 ||
    !tabObject ||
    firstString(tabObject, ["workspace_id"]) !== target.workspace_id ||
    paneObjects.length !== 1 ||
    !paneObject ||
    firstString(paneObject, ["workspace_id"]) !== target.workspace_id ||
    firstString(paneObject, ["tab_id"]) !== target.tab_id ||
    rootPanes.length !== 1 ||
    auxiliaryProofs.some((verified) => !verified) ||
    deepValues(paneObject, "agent").some((value) => value !== undefined && value !== null) ||
    deepValues(paneObject, "agent_session").some((value) => value !== undefined && value !== null) ||
    canonicalPaneCwd !== run.cwd ||
    !shellObserved ||
    /(?:^|[/"\s])(omp|oh-my-pi)(?:["\s]|$)/.test(processText)
  ) {
    throw new ContractError(
      "duplicate_session_ambiguous",
      "The target run anchor is not provably its registry-owned interactive shell.",
      "orch_start_prepare",
      { recovery: "Inspect target anchor ownership and native restoration; never start a second OMP process blindly." },
    );
  }
}

async function startTargetOrchestratorAgent(
  binary: string,
  run: RunRecord,
  target: TargetOrchestratorRecord,
  launch: Pick<
    TargetOrchestratorRecord,
    "config_sources" | "requested_role" | "expected_provider" | "expected_model" | "effective_thinking"
  >,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  await assertTargetAnchorShell(binary, run, target, timeoutMs, signal);
  assertTargetLaunchProfile(target, launch);
  const resumePath = target.session_path;
  if (resumePath) await assertNoDuplicateSession(binary, resumePath, target.pane_id, timeoutMs, signal);
  const args = [
    "agent",
    "start",
    target.agent_name,
    "--kind",
    "omp",
    "--pane",
    target.pane_id,
    "--timeout",
    String(timeoutMs),
    "--",
    ...(resumePath ? [`--resume=${resumePath}`] : []),
    "--model",
    `${launch.expected_provider}/${launch.expected_model}`,
    "--thinking",
    launch.effective_thinking,
  ];
  const started = await runHerdr(binary, args, timeoutMs + 1_000, signal);
  if (!started.ok) {
    const inspected = await getLiveAgent(binary, target.agent_name, Math.min(timeoutMs, 10_000), signal);
    if (inspected.ok) {
      assertTargetAgentBelongs(run, target, inspected.data);
      const observedPath = await canonicalSessionPath(inspected.data);
      if (resumePath && observedPath !== resumePath) {
        throw new ContractError(
          "session_identity_mismatch",
          "The target ORCH observed after an ambiguous resume has a different official session path.",
          "orch_start",
          { ambiguousEffect: true, recovery: "Use inspect_orch; do not start or prompt another target ORCH." },
        );
      }
      return inspected.data;
    }
    throw commandError(
      started,
      "orch_start",
      "Use inspect_orch before retrying; never replay an ambiguous target ORCH start blindly.",
      started.timedOut || /timeout|not_ready/i.test(`${started.code} ${started.message}`),
    );
  }
  const live = await getLiveAgent(binary, target.agent_name, Math.min(timeoutMs, 15_000), signal);
  if (!live.ok) throw commandError(live, "orch_verify", "Inspect the target ORCH before prompting.");
  assertTargetAgentBelongs(run, target, live.data);
  const observedPath = await canonicalSessionPath(live.data);
  if (resumePath && observedPath !== resumePath) {
    throw new ContractError(
      "session_identity_mismatch",
      "The resumed target ORCH did not re-report its registry-recorded official session path.",
      "orch_verify",
      { recovery: "Preserve the anchor and inspect_orch; do not prompt it." },
    );
  }
  return live.data;
}

function updateTargetFromObservation(target: TargetOrchestratorRecord, data: unknown): void {
  target.state = normalizeState(data, "agent-ready");
  target.state_change_seq = firstNumber(data, ["state_change_seq"]) ?? target.state_change_seq;
  target.updated_at = nowIso();
}

async function assertTargetConfiguredRole(
  run: RunRecord,
  target: TargetOrchestratorRecord,
  ctx: OmpModelContext,
): Promise<void> {
  const { config, sources } = await loadDelegatorConfig(run.run_path, run.cwd);
  const resolved = modelIdentity(ctx.models.resolve(config.orchestrator.role));
  // Passing the persisted level as the live one keeps `inherit` with no
  // role-bound level the tautology it has always been here — this check owns
  // configuration drift, not session drift — while a role that does bind a
  // level is now compared against it.
  const configuredThinking = effectiveThinking(config.orchestrator, ctx, target.effective_thinking);
  if (
    config.orchestrator.role !== target.requested_role ||
    resolved.provider !== target.expected_provider ||
    resolved.model !== target.expected_model ||
    configuredThinking !== target.effective_thinking ||
    JSON.stringify(sources) !== JSON.stringify(target.config_sources)
  ) {
    throw new ContractError(
      "model_profile_mismatch",
      "The target ORCH registry profile no longer matches the layered orchestrator OMP role configuration.",
      "model_verify",
      { recovery: "Preserve the target session; use a revised sibling run for a different role configuration." },
    );
  }
}

async function verifyTargetOrchestratorSession(
  binary: string,
  run: RunRecord,
  target: TargetOrchestratorRecord,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SessionVerification> {
  const converged = await convergeOfficialSessionIdentity(
    binary,
    target.agent_name,
    {
      workspaceId: target.workspace_id,
      tabId: target.tab_id,
      paneId: target.pane_id,
    },
    target.session_path,
    timeoutMs,
    signal,
  );
  assertTargetAgentBelongs(run, target, converged.observation);
  const beforePath = converged.canonicalPath;
  const verification = await readSessionVerification(beforePath, target);
  if (target.session_id && target.session_id !== verification.session_id) {
    throw new ContractError(
      "session_identity_mismatch",
      "The target ORCH session header differs from its registry-recorded identity.",
      "session_verify",
      { recovery: "Preserve the target session; never resume or prompt the conflicting identity." },
    );
  }
  const after = await getLiveAgent(binary, target.agent_name, Math.min(timeoutMs, 15_000), signal);
  if (!after.ok) throw commandError(after, "session_verify", "Re-inspect the target ORCH identity.");
  assertTargetAgentBelongs(run, target, after.data);
  if ((await canonicalSessionPath(after.data)) !== beforePath) {
    throw new ContractError(
      "session_identity_mismatch",
      "The target ORCH official session path changed during verification.",
      "session_verify",
    );
  }
  target.session_path = beforePath;
  target.session_id = verification.session_id;
  target.resolved_model_is_fallback = verification.resolved_model_is_fallback;
  target.verified_at = nowIso();
  updateTargetFromObservation(target, after.data);
  return verification;
}

async function inspectOrchestrator(
  params: TrackParams,
  ctx: OmpModelContext,
  signal?: AbortSignal,
): Promise<TrackResult> {
  const timeoutMs = normalizeTimeout(params.timeout_ms);
  const coordinate = await resolveRunCoordinate(params.track_id, params.run_id);
  const runPath = coordinate.runPath;
  const lineage = await validateOrchestratorRun(coordinate);
  const runKey = sha256(runPath);
  const { registryPath } = registryPaths(runPath);
  const { binary } = await requireHerdrEnvironment();
  const registry = await readRegistry(registryPath);
  const run = await assertRunWorkspaceLive(binary, registry, timeoutMs, signal, runPath, coordinate.manifest.cwd);
  if (JSON.stringify(run.reset_lineage) !== JSON.stringify(lineage)) {
    throw new ContractError("reset_lineage_mismatch", "The registry reset lineage differs from run.json/reset.json.", "registry");
  }
  const target = run.target_orchestrator;
  if (!target) {
    throw new ContractError("orch_not_started", "The target run has no registry-recorded ORCH lifecycle.", "inspect");
  }
  await assertTargetConfiguredRole(run, target, ctx);
  const live = await getLiveAgent(binary, target.agent_name, timeoutMs, signal);
  const reportPath = path.join(runPath, "orchestrator-report.md");
  if (!live.ok) {
    if (!isMissingHerdrObject(live)) throw commandError(live, "inspect", "Inspect the deterministic target ORCH again.");
    return {
      ok: true,
      operation: "inspect_orch",
      run_key: runKey,
      state: target.state,
      retryable: false,
      registry_path: registryPath,
      run: publicResetRun(run),
      orchestrator: publicTargetOrchestrator(target),
      observation: {
        live: false,
        model_verified: false,
        report_exists: await isFile(reportPath),
        report_path: reportPath,
      },
    };
  }
  assertTargetAgentBelongs(run, target, live.data);
  let verification: Record<string, unknown>;
  if (target.prompt_state === "unprompted") {
    const bootstrap = await verifyTargetBootstrapSession(binary, run, target, timeoutMs, signal);
    verification = { status: "bootstrap-verified", ...bootstrap };
  } else {
    const persisted = await verifyTargetOrchestratorSession(binary, run, target, timeoutMs, signal);
    const bootstrap = storedTargetBootstrap(target);
    if (!bootstrap) {
      throw new ContractError(
        "session_verification_incomplete",
        "The live target ORCH has no registry-recorded bootstrap attestation.",
        "session_verify",
      );
    }
    assertPersistedMatchesBootstrap(persisted, bootstrap);
    verification = { status: "persisted-verified", ...persisted };
  }
  await withRegistryLock(runPath, timeoutMs, async (latest, targetRegistryPath) => {
    const currentRun = latest.run;
    const current = currentRun?.target_orchestrator;
    if (!currentRun || !current) {
      throw new ContractError("orch_missing", "The target ORCH record disappeared during inspection.", "registry");
    }
    assertTargetAgentBelongs(currentRun, current, live.data);
    Object.assign(current, target);
    await writeRegistryAtomic(targetRegistryPath, latest);
  });
  return {
    ok: true,
    operation: "inspect_orch",
    run_key: runKey,
    state: target.state,
    retryable: false,
    registry_path: registryPath,
    run: publicResetRun(run),
    orchestrator: publicTargetOrchestrator(target),
    observation: {
      live: true,
      state_change_seq: target.state_change_seq,
      model_verification: verification,
      prompt_fingerprint: target.prompt_sha256,
      reset_lineage: lineage,
      report_exists: await isFile(reportPath),
      report_path: reportPath,
    },
  };
}

async function startOrchestrator(
  params: TrackParams,
  ctx: OmpModelContext,
  currentThinking: ThinkingLevel,
  signal?: AbortSignal,
): Promise<TrackResult> {
  const timeoutMs = normalizeTimeout(params.timeout_ms);
  const coordinate = await resolveRunCoordinate(params.track_id, params.run_id);
  const runPath = coordinate.runPath;
  const lineage = await validateOrchestratorRun(coordinate);
  const cwd = coordinate.manifest.cwd;
  const instructionPath = await canonicalOrchestratorInstruction(runPath);
  const orchestratorProtocolPath = path.join(runPath, "protocol-orch.md");
  const orchestratorProtocolTemplatePath = path.join(path.dirname(PROTOCOL_TEMPLATE_PATH), "protocol-orch.md");
  try {
    const protocolStat = await lstat(orchestratorProtocolPath);
    if (
      !protocolStat.isFile() ||
      protocolStat.isSymbolicLink() ||
      (await realpath(orchestratorProtocolPath)) !== orchestratorProtocolPath ||
      !(await readFile(orchestratorProtocolPath)).equals(await readFile(orchestratorProtocolTemplatePath))
    ) {
      throw new Error("protocol mismatch");
    }
  } catch {
    throw new ContractError("invalid_instruction_path", "protocol-orch.md is missing, non-canonical, or differs from its bundled template.", "validate");
  }
  const instructionFingerprint = sha256(await readFile(instructionPath));
  const runKey = sha256(runPath);
  const agentName = `herdr-orch-${runKey.slice(0, 12)}`;
  const { registryPath } = registryPaths(runPath);
  const resolved = await resolveOrchestratorProfile(runPath, cwd, ctx, currentThinking);
  const { binary, paneId } = await requireHerdrEnvironment();
  const caller = await observeOrchestrator(binary, paneId, resolved.caller, timeoutMs, signal);
  const focusBefore = await captureFocus(binary, signal);
  const owned: OwnedFocus = { tab_ids: new Set(), pane_ids: new Set() };
  let focusRestoration: FocusRestoration = "unchanged";
  let target!: TargetOrchestratorRecord;
  let run!: RunRecord;
  let verification!: Record<string, unknown>;
  let bootstrapVerification: BootstrapSessionVerification | undefined;
  let duplicatePrompt = false;
  try {
    ({ run, target } = await withRegistryLock(runPath, timeoutMs, async (registry, targetRegistryPath) => {
      const liveRun = await ensureRunWorkspace(
        binary,
        registry,
        targetRegistryPath,
        runPath,
        cwd,
        caller,
        timeoutMs,
        signal,
      );
      if (!liveRun.workspace_id || !liveRun.anchor_tab_id || !liveRun.anchor_pane_id) {
        throw new ContractError("run_workspace_not_ready", "The target reset workspace has no complete anchor.", "workspace");
      }
      await assertRunWorkspaceLive(binary, registry, timeoutMs, signal, runPath, cwd);
      if (liveRun.reset_lineage === undefined) {
        if (lineage !== undefined) {
          if (liveRun.target_orchestrator || Object.keys(registry.workers).length > 0) {
            throw new ContractError(
              "reset_lineage_mismatch",
              "The registry reset lineage differs from run.json/reset.json.",
              "registry",
            );
          }
          liveRun.reset_lineage = lineage;
          liveRun.updated_at = nowIso();
          await writeRegistryAtomic(targetRegistryPath, registry);
        }
      } else if (
        lineage === undefined ||
        JSON.stringify(liveRun.reset_lineage) !== JSON.stringify(lineage)
      ) {
        throw new ContractError(
          "reset_lineage_mismatch",
          "The registry reset lineage differs from run.json/reset.json.",
          "registry",
        );
      }
      owned.workspace_id = liveRun.workspace_id;
      owned.tab_ids.add(liveRun.anchor_tab_id);
      owned.pane_ids.add(liveRun.anchor_pane_id);
      let current = liveRun.target_orchestrator;
      if (!current) {
        const timestamp = nowIso();
        current = {
          workspace_id: liveRun.workspace_id,
          tab_id: liveRun.anchor_tab_id,
          pane_id: liveRun.anchor_pane_id,
          agent_name: agentName,
          state: "planned",
          instruction_path: instructionPath,
          prompt_state: "unprompted",
          ...resolved.launch,
          created_at: timestamp,
          updated_at: timestamp,
        };
        liveRun.target_orchestrator = current;
        await writeRegistryAtomic(targetRegistryPath, registry);
      } else {
        if (
          current.agent_name !== agentName ||
          current.workspace_id !== liveRun.workspace_id ||
          current.tab_id !== liveRun.anchor_tab_id ||
          current.pane_id !== liveRun.anchor_pane_id ||
          current.instruction_path !== instructionPath
        ) {
          throw new ContractError(
            "identity_conflict",
            "The registry target ORCH identity differs from the deterministic reset-run anchor.",
            "orch_reconcile",
          );
        }
        assertTargetLaunchProfile(current, resolved.launch);
      }
      const live = await getLiveAgent(binary, current.agent_name, timeoutMs, signal);
      if (live.ok) {
        assertTargetAgentBelongs(liveRun, current, live.data);
        const observedPath = reportedSessionPath(live.data);
        if (current.session_path && observedPath !== current.session_path) {
          throw new ContractError(
            "session_identity_mismatch",
            "The live target ORCH official session differs from the registry.",
            "orch_reconcile",
          );
        }
        updateTargetFromObservation(current, live.data);
      } else {
        if (!isMissingHerdrObject(live)) {
          throw commandError(live, "orch_reconcile", "Inspect the target ORCH before retrying.");
        }
        if (current.prompt_state !== "unprompted" && !current.session_path) {
          throw new ContractError(
            "session_reference_missing",
            "A previously prompted target ORCH has no official session path for safe recovery.",
            "orch_reconcile",
            { recovery: "Preserve the run and use inspect_orch; never create a substitute ORCH." },
          );
        }
        const started = await startTargetOrchestratorAgent(
          binary,
          liveRun,
          current,
          resolved.launch,
          timeoutMs,
          signal,
        );
        updateTargetFromObservation(current, started);
      }
      liveRun.updated_at = nowIso();
      await writeRegistryAtomic(targetRegistryPath, registry);
      return { run: liveRun, target: current };
    }));

    if (target.prompt_state === "unprompted") {
      bootstrapVerification = await verifyTargetBootstrapSession(binary, run, target, timeoutMs, signal);
      verification = { status: "bootstrap-verified", ...bootstrapVerification };
    } else {
      const persisted = await verifyTargetOrchestratorSession(binary, run, target, timeoutMs, signal);
      const storedBootstrap = storedTargetBootstrap(target);
      if (!storedBootstrap) {
        throw new ContractError(
          "session_verification_incomplete",
          "The persisted target ORCH has no registry-recorded bootstrap attestation.",
          "session_verify",
          { recovery: "Preserve the target ORCH; create a new reset run rather than prompting it." },
        );
      }
      assertPersistedMatchesBootstrap(persisted, storedBootstrap);
      verification = { status: "persisted-verified", ...persisted };
    }
    target = await withRegistryLock(runPath, timeoutMs, async (registry, targetRegistryPath) => {
      const currentRun = registry.run;
      const current = currentRun?.target_orchestrator;
      if (!currentRun || !current) {
        throw new ContractError("orch_missing", "The target ORCH record disappeared during verification.", "registry");
      }
      assertTargetLaunchProfile(current, resolved.launch);
      Object.assign(current, target);
      if (current.prompt_sha256 && current.prompt_sha256 !== instructionFingerprint) {
        throw new ContractError(
          "instruction_changed",
          "orchestrator-instructions.md changed after its first recorded fingerprint.",
          "prompt_prepare",
          { recovery: "Create or revise a sibling run before launch; never replay a changed target ORCH prompt." },
        );
      }
      if (current.prompt_state !== "unprompted") {
        duplicatePrompt = true;
      } else {
        current.prompt_sha256 = instructionFingerprint;
        current.prompt_state = "prompting";
        current.updated_at = nowIso();
      }
      await writeRegistryAtomic(targetRegistryPath, registry);
      return current;
    });

    if (!duplicatePrompt) {
      const prompt = `Read ${instructionPath} and ${orchestratorProtocolPath}, then carry out every instruction in them. After handoff revalidation, a terminal boundary, or a decision request in orchestrator-report.md, send one bounded herdr_message {action:"notify_run"} to the source run named in handoff.md.`;
      const prompted = await runHerdr(
        binary,
        [
          "agent",
          "prompt",
          target.agent_name,
          prompt,
          "--wait",
          "--until",
          "idle",
          "--until",
          "done",
          "--until",
          "blocked",
          "--timeout",
          String(timeoutMs),
        ],
        timeoutMs + 1_000,
        signal,
      );
      if (!prompted.ok) {
        throw commandError(
          prompted,
          "orch_prompt",
          "Use inspect_orch; a prompting fingerprint is never replayed blindly.",
          prompted.timedOut || /stalled|timeout/i.test(`${prompted.code} ${prompted.message}`),
        );
      }
      const verifiedBootstrap = bootstrapVerification;
      if (!verifiedBootstrap) {
        throw new ContractError(
          "session_verification_incomplete",
          "The first target ORCH prompt has no retained bootstrap verification.",
          "session_verify",
        );
      }
      target = await withRegistryLock(runPath, timeoutMs, async (registry, targetRegistryPath) => {
        const currentRun = registry.run;
        const current = currentRun?.target_orchestrator;
        if (!currentRun || !current || current.prompt_sha256 !== instructionFingerprint) {
          throw new ContractError("orch_missing", "The target ORCH prompt record changed during submission.", "registry");
        }
        updateTargetFromObservation(current, prompted.data);
        const persisted = await verifyTargetOrchestratorSession(
          binary,
          currentRun,
          current,
          timeoutMs,
          signal,
        );
        assertPersistedMatchesBootstrap(persisted, verifiedBootstrap);
        verification = { status: "persisted-verified", ...persisted };
        current.prompt_state = "prompted";
        current.updated_at = nowIso();
        await writeRegistryAtomic(targetRegistryPath, registry);
        return current;
      });
    }
  } finally {
    focusRestoration = await restoreFocus(binary, focusBefore, owned);
  }
  return {
    ok: true,
    operation: "start_orch",
    run_key: runKey,
    state: target.state,
    retryable: false,
    registry_path: registryPath,
    run: publicResetRun(run),
    orchestrator: publicTargetOrchestrator(target),
    observation: {
      duplicate_prompt_suppressed: duplicatePrompt,
      focus_restoration: focusRestoration,
      model_verification: verification,
      prompt_fingerprint: instructionFingerprint,
      reset_lineage: lineage,
      report_exists: await isFile(path.join(runPath, "orchestrator-report.md")),
      report_path: path.join(runPath, "orchestrator-report.md"),
    },
  };
}

async function trackFailureResult(
  operation: TrackOperation,
  params: TrackParams,
  error: unknown,
): Promise<TrackResult> {
  const known = error instanceof ContractError ? error : undefined;
  return {
    ok: false,
    operation,
    run_key: "",
    state: "failed",
    retryable: known?.retryable ?? false,
    registry_path: "",
    error: {
      code: known?.code ?? "internal_error",
      message: compactMessage(known?.message, "herdr_track encountered an internal error."),
      phase: known?.phase ?? "internal",
      ambiguous_effect: known?.ambiguousEffect ?? false,
      recovery: known?.recovery ?? "Use inspect_orch before retrying any target ORCH effect.",
    },
  };
}

function trackResultSummary(result: TrackResult): string {
  if (result.ok) return `${result.operation} completed: target ORCH state=${result.state}`;
  return `${result.operation} failed: ${result.error?.code ?? "unknown"} (${result.error?.message ?? "error"})`;
}

export { initializeRun, inspectOrchestrator, startOrchestrator, trackFailureResult, trackResultSummary };
