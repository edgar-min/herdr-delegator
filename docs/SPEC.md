# Herdr Delegator Specification

## Status and language

This document is the normative architecture and Markdown review artifact for `herdr-delegator` 0.4.0 and the bundled `herdr-delegation` skill 3.0.0.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described by RFC 2119.

Statements under **Implemented facts** describe the current implementation and bundled skill. Statements under **Reviewer decisions** identify architecture or documentation choices that require approval; they are not claims of missing implementation.

## 1. Identity, naming, and versions

- **ID-001**: The public package and OMP plugin name MUST be `herdr-delegator`.
- **ID-002**: The package version MUST be `0.4.0`.
- **ID-003**: The public skill name MUST be `herdr-delegation` and its version MUST be `3.0.0`.
- **ID-004**: The public tools MUST be named `herdr_track` and `herdr_worker`.
- **ID-005**: The repository identity MUST be `https://github.com/edgar-min/herdr-delegator`.
- **ID-006**: The license MUST be Apache-2.0 with copyright 2026 Jisung Min.
- **ID-007**: A run MUST be identified by `(track_id, run_id)`, not by a model-supplied path.
- **ID-008**: Track and run IDs MUST match `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`.
- **ID-009**: Worker IDs MUST canonically match `w[1-9][0-9]*` and use lowercase in deterministic filenames.
- **ID-010**: Registry format version MUST be 3; run manifest and reset contract versions MUST be 1.

## 2. Configuration

### 2.1 Hierarchy

- **CFG-001**: Configuration MUST be loaded in this order: built-in defaults, user file, project file, optional run file.
- **CFG-002**: The user file MUST resolve to `${PI_CODING_AGENT_DIR}/herdr-delegator.json`, or `~/.omp/agent/herdr-delegator.json` when the environment variable is unset.
- **CFG-003**: The project file MUST resolve to `<canonical-cwd>/.omp/herdr-delegator.json`.
- **CFG-004**: The optional run file MUST resolve to `<canonical-run>/herdr-delegator.json`.
- **CFG-005**: Later layers MUST override earlier leaves. A new worker profile MUST inherit unspecified leaves from the resolved `default` profile.
- **CFG-006**: At least the user or project layer MUST set `storage.root` to an absolute path. There MUST be no temporary-directory or project-directory fallback.
- **CFG-007**: A run layer MUST NOT relocate its own storage root.
- **CFG-008**: Each consumed layer MUST be recorded by canonical path, scope, and SHA-256.

### 2.2 Strictness and defaults

- **CFG-009**: Configuration objects MUST use version 1 and reject unknown keys.
- **CFG-010**: Unreadable or malformed configuration MUST fail closed; the extension MUST NOT silently ignore, rewrite, or quarantine it.
- **CFG-011**: The ORCH role MUST be fixed at `@plan`; its default thinking value MUST be `inherit`.
- **CFG-012**: Built-in worker profiles MUST be `default` → `@default` and `slow` → `@slow`, both with thinking `inherit`.
- **CFG-013**: A worker profile name MUST match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- **CFG-014**: A role MUST match `^@[A-Za-z0-9][A-Za-z0-9._-]*$`.
- **CFG-015**: Configured thinking MUST be one of `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `auto`.
- **CFG-016**: Every `ensure_worker` call MUST explicitly select a configured profile. There MUST be no implicit worker-profile selection or automatic fallback.
- **CFG-017**: [`config.schema.json`](../config.schema.json) MUST remain the public strict schema and [`config.example.json`](../config.example.json) MUST demonstrate required storage plus built-in routing.

## 3. Storage, manifest, index, and authority

- **STO-001**: The canonical run path MUST be derived deterministically as `<configured storage.root>/<track_id>/<run_id>`; callers and models MUST NOT supply or relocate it.
- **STO-002**: The tool MUST validate canonical directory identity and reject symlink/path conflicts where canonical identity is required.
- **STO-003**: `run.json` MUST conform to [`run.schema.json`](../run.schema.json), bind the coordinate pair to canonical `cwd` and `run_path`, and reject unknown properties.
- **STO-004**: `init_run` MUST create or exactly reconcile only `run.json`, bundled `protocol.md`, `a2a/`, the storage index row, and reset artifacts when requested. Each owned file replacement and index mutation MUST be atomic and lock-guarded.
- **STO-005**: Ordinary initialization MUST NOT create placeholder plans, instructions, reports, evidence, registries, workspaces, tabs, panes, or OMP sessions.
- **STO-006**: Existing `protocol.md` MUST be byte-for-byte equal to the bundled template.
- **STO-007**: An uninitialized target directory containing files outside the initialization set MUST be rejected rather than adopted.
- **STO-008**: `<storage.root>/index.json` MUST be tool-owned, lock-guarded, strict version 1, and consistent with the run manifest.
- **STO-009**: `a2a/herdr-workers.json` and its lock MUST be worker-tool authority. Models, users, ORCH, and workers MUST NOT edit, copy, move, or unlock them manually.
- **STO-010**: The ORCH MUST author work-specific planning and instruction artifacts. Workers and target ORCH sessions MUST append only to their authorized report or declared directional peer channel.
- **STO-011**: Atomic writes MUST use restrictive file modes where the implementation creates audit state.
- **STO-012**: Canonical paths returned in results MUST be bounded audit observations, not alternate operation coordinates.

- **STO-013**: `init_run` is a reconciliatory multi-artifact transaction, not a claim of whole-operation rollback. If interruption leaves a partial initialized set, every surviving artifact MUST be individually valid and owned; recovery MUST re-enter `init_run`, reconcile that set exactly, and fail closed on any conflict before creating later lifecycle state.

## 4. Public tool contract

### 4.1 Common rules

- **TOOL-001**: All public operation inputs MUST be strict operation-specific objects; extra fields MUST be rejected by the registered tool schema.
- **TOOL-002**: All timeout values MUST be integer milliseconds from 1,000 through 300,000 inclusive; the default MUST be 120,000.
- **TOOL-003**: Worker operations MUST address the same object by `track_id`, `run_id`, and `worker_id`. Track operations MUST use `track_id` and `run_id`.
- **TOOL-004**: Successful and failed results MUST expose bounded details. A worker result MUST include `ok`, `operation`, `worker_key`, public `state`, `retryable`, and `registry_path`; a track result MUST include the analogous `run_key` contract.
- **TOOL-005**: Failure details MUST include a stable error code, bounded message, phase, `ambiguous_effect`, and recovery guidance.
- **TOOL-006**: Retryability MUST NOT imply that an ambiguous external effect can be retried without inspection.
- **TOOL-007**: Tool summary text MUST be derived from the structured result; structured details remain authoritative for automation.

### 4.2 `herdr_track.init_run`

**Input**

- **RUN-001**: Input MUST contain `operation: "init_run"`, valid track/run IDs, and the absolute canonical project `cwd` input; it MAY contain `timeout_ms`.
- **RUN-002**: A sibling reset MAY include exactly `reset_of: { track_id, run_id }`; the source coordinate MUST differ and use the same configured storage root.

**Invariants and effects**

- **RUN-003**: The operation MUST resolve configuration before the run path and MUST canonicalize an existing project directory.
- **RUN-004**: Initialization MUST be idempotent only when existing manifest, protocol, reset lineage, and index identity reconcile exactly.
- **RUN-005**: For reset, the source manifest and canonical source `plan.md` MUST be validated before mutation.
- **RUN-006**: Reset MUST copy the source plan byte-for-byte and detect a source-plan change during the storage transaction.
- **RUN-007**: `reset.json` MUST conform to [`reset.schema.json`](../reset.schema.json), recording `close-settled-preserve-active` and `revalidate-before-import`.

**Output**

- **RUN-008**: Success MUST report state `initialized`, deterministic run key, canonical run/cwd, manifest/protocol coordinates, registry coordinate, storage root, index path, and reset source when present.

### 4.3 `herdr_track.start_orch`

**Input**

- **ORCH-001**: Input MUST contain `operation: "start_orch"`, track/run IDs, and optionally `timeout_ms`; it MUST NOT accept a caller-supplied instruction, path, profile, model, or resume session.

**Invariants and effects**

- **ORCH-002**: Canonical `plan.md` and `orchestrator-instructions.md` MUST exist before start.
- **ORCH-003**: The operation MUST resolve exactly `<run>/orchestrator-instructions.md` and fingerprint it.
- **ORCH-004**: The caller MUST resolve configured ORCH role `@plan` to the concrete provider/model and effective thinking, and the child MUST launch pinned to those captured concrete values rather than resolving the alias again.
- **ORCH-005**: Before any work prompt, the child MUST emit session-bound bootstrap attestation for the intended pane/session, including official session ID, reported session path, concrete provider/model, thinking, nonce, and timestamp. A fresh target MUST start without resume; reconciliation MAY resume only the target run's exact registry-recorded official session after persisted-file, ownership, and duplicate checks.
- **ORCH-006**: The canonical instruction SHA-256 MUST be recorded before delivery and remain a permanent no-replay guard for that instruction. On an ambiguous first return, `prompt_state: prompting` MAY remain permanent; recovery MUST NOT redeliver and MUST instead reconcile the exact persisted JSONL, record persisted verification, and inspect settled state.

**Output**

- **ORCH-007**: Success MUST expose bounded run, target ORCH, prompt fingerprint/state, concrete model/thinking, official session ID, reported session path, persisted/resume-eligibility status, reset lineage, focus, and report-presence observations sufficient for subsequent inspection.

### 4.4 `herdr_track.inspect_orch`

**Input**

- **ORI-001**: Input MUST contain `operation: "inspect_orch"`, track/run IDs, and optionally `timeout_ms`.

**Invariants and output**

- **ORI-002**: Inspection MUST NOT accept model-supplied live-object coordinates.
- **ORI-003**: Inspection MUST validate run/workspace/anchor/target ownership and current configured ORCH role.
- **ORI-004**: Output MUST bound live state and sequence, official session/model verification, prompt fingerprint/state, bootstrap attestation, reported path versus persisted/resume-eligible path, target identity, reset lineage, focus observations, and target report presence.
- **ORI-005**: ORCH MUST inspect after start and before judging state or recovering an ambiguous effect.

### 4.5 `herdr_worker.ensure_worker`

**Input**

- **WRK-001**: Input MUST contain `operation: "ensure_worker"`, track/run/worker IDs, project `cwd`, and explicit configured `profile`; it MAY contain `timeout_ms`.

**Invariants and effects**

- **WRK-002**: The operation MUST reconcile the requested `cwd` with the manifest's canonical `cwd`.
- **WRK-003**: Before Herdr launch-path mutation, the caller MUST verify the calling ORCH, resolve the explicitly selected worker role to concrete provider/model and effective thinking, and require the child to launch pinned to those captured values.
- **WRK-004**: It MUST create or reconcile one deterministic configured-storage run workspace with retained anchor and exactly one registry-owned worker identity/tab for the worker key.
- **WRK-005**: A new worker number MUST NOT be used to bypass an identity, ownership, topology, session, or multiple-candidate conflict.
- **WRK-006**: Resume or reconciliation MUST use exact recorded identity, MUST distinguish a bootstrap-reported session path from a persisted JSONL path, and MUST prove persisted existence, identity, and duplicate safety before treating the session as resume-eligible or sending any prompt.

**Output**

- **WRK-007**: Success MUST include deterministic worker key, canonical registry coordinate, bounded public worker identity/state, launch profile, pinned concrete model/thinking, bootstrap and persisted-session verification, reported and resume-eligible path status, workspace ownership, focus restoration, and recovery-relevant observations.

### 4.6 `herdr_worker.prompt_wait`

**Input**

- **PRM-001**: Input MUST contain `operation: "prompt_wait"`, track/run/worker IDs, exact deterministic `instruction_path`, and optionally `timeout_ms`.
- **PRM-002**: The instruction path MUST resolve to `<run>/a2a/<worker_id>-instructions.md`; arbitrary paths MUST be rejected.

**Invariants and effects**

- **PRM-003**: The worker MUST already have been successfully ensured and reconciled.
- **PRM-004**: Intent and the instruction SHA-256 MUST be recorded before delivery. That fingerprint MUST remain durable no-replay evidence for the instruction even when an ambiguous effect leaves the recorded prompt state at `prompting`.
- **PRM-005**: A matching fingerprint in prompting, prompted, working, idle, done, or blocked state MUST cause inspection and persisted-session reconciliation rather than duplicate delivery.
- **PRM-006**: After submission, the instruction SHOULD remain immutable; new information SHOULD be appended in an `[ORCH Addendum]` for a natural boundary.
- **PRM-007**: The operation MUST wait only to a bounded natural boundary and MUST treat timeout as a potentially ambiguous effect.

**Output**

- **PRM-008**: Output MUST report bounded state, fingerprint/delivery observations, report presence, and recovery guidance.

### 4.7 `herdr_worker.inspect_worker`

**Input**

- **INS-001**: Input MUST contain `operation: "inspect_worker"`, track/run/worker IDs, and optionally `timeout_ms` and `output_lines` from 1 through 200.

**Invariants and output**

- **INS-002**: Inspection MUST validate registry/run identity, workspace/tab/pane ownership, deterministic agent identity, and official session where present.
- **INS-003**: Output MUST include bounded public worker state, `state_change_seq`, prompt identity/state, report presence, session/model verification, topology/focus observations, and requested bounded terminal output where available.
- **INS-004**: ORCH MUST inspect after every wait, timeout, stall, ambiguous effect, block response, or close uncertainty and immediately before judgment, response, retry, recovery, or close.

### 4.8 `herdr_worker.resolve_block`

**Input**

- **BLK-001**: Input MUST contain `operation: "resolve_block"`, track/run/worker IDs, exact nonnegative `expected_state_change_seq`, one response, and optionally `timeout_ms`.
- **BLK-002**: A text response MUST contain 1–8,000 characters and MUST be used only when fresh inspection proves the blocked surface accepts free-form text; text MUST NOT be used to select an interactive option.
- **BLK-003**: A key response MUST contain 1–20 values drawn only from `enter`, `esc`, arrows, `tab`, `shift+tab`, `y`, and `n`, and MUST be used for an inspected interactive-option surface according to its current selection semantics.

**Invariants and effects**

- **BLK-004**: The latest fresh inspection MUST prove state `blocked`, and its sequence MUST equal `expected_state_change_seq`.
- **BLK-005**: ORCH MUST have a non-user answer grounded in the plan, instructions, or canonical project sources. User-owned, secret-bearing, irreversible, or governance decisions MUST be escalated instead.
- **BLK-006**: Response intent MUST be recorded against the sequence before delivery, and timeout MUST be treated as a potentially ambiguous effect.

**Output**

- **BLK-007**: Output MUST report the post-response bounded state/sequence or structured ambiguous recovery guidance.

### 4.9 `herdr_worker.close_worker`

**Input**

- **CLS-001**: Input MUST contain `operation: "close_worker"`, track/run/worker IDs, and optionally `timeout_ms`.

**Invariants and effects**

- **CLS-002**: A fresh inspection MUST first prove a settled `idle`, `done`, or `failed` worker plus exact identity, registry ownership, tab ownership, and safe pane topology.
- **CLS-003**: The owned worker tab MUST contain only its exact registry root pane and zero or more verified Herdr Sidebar auxiliaries.
- **CLS-004**: A verified Sidebar MUST share workspace/tab/canonical run `cwd`, have exact label `Sidebar`, expose no non-null agent or agent-session evidence, and have a non-empty token object whose keys all start `herdr-sidebar-`.
- **CLS-005**: Unknown, blocked, working, identity-conflicted, mixed, extra-pane, unsafe-topology, or ambiguously closed workers MUST be preserved.
- **CLS-006**: Close MUST NOT close the retained run workspace.
- **CLS-007**: A timeout MUST be treated as potentially effective; inspection MUST precede any retry.

**Output**

- **CLS-008**: Success MUST report state `closed` and bounded closure/topology/focus observations. After the owned tab is removed, `inspect_worker` MAY return `agent_not_found`; the registry's `closed` record remains authoritative and the retained run anchor MUST survive. Uncertainty MUST report structured non-destructive recovery.

## 5. Routing and coordination

- **RTE-001**: ORCH MUST retain decomposition, scope, priority, approval, completion contracts, integration, and final judgment.
- **RTE-002**: Bounded mechanical or light work SHOULD use current-session host task/subagents, using the host's smol routing when available, and MUST NOT create Herdr worker state.
- **RTE-003**: Substantial independent work needing persistence, explicit ownership, exact-session resume, block handling, or peer coordination SHOULD use a persistent Herdr worker tab. The explicit `default` profile SHOULD serve ordinary durable work; `slow` SHOULD be selected only when the slice requires its configured higher-capability or deliberative route.
- **RTE-004**: Host task/subagent model choice remains outside this plugin's selection and verification contract; the smol routing recommendation is an ORCH routing decision, not plugin enforcement.
- **RTE-005**: Parallel workers MUST have disjoint write ownership. Overlapping edits in the shared canonical `cwd` MUST be serialized.
- **RTE-006**: `plan.md` MUST state goal, observable completion, prohibitions, user decisions, phases, routing, assignments, exact write ownership, dependencies, readiness, peer channels, quiet windows, ORCH integration checks, and reset lineage when present.
- **RTE-007**: Worker instructions MUST state required reading, scope, prohibitions, ordered work, completion checks, report path, dependencies, profile, and delegation policy.
- **RTE-008**: Every instruction MUST be compared once with copied `protocol.md` before prompting.
- **RTE-009**: Peer facts MUST route through ORCH. A directional `w<N>-to-w<M>.md` channel MUST exist only when declared.
- **RTE-010**: Peers MAY exchange artifact coordinates, dependency/readiness/quiet-window facts, reproductions, and interface facts; only ORCH MAY change scope, ownership, priority, approval, or completion contracts.

## 6. Model roles and verification

- **MOD-001**: Configuration MUST contain OMP role aliases and thinking values, never concrete model IDs. For every guarded ORCH or worker launch, the caller MUST resolve the selected configured role to concrete provider/model and effective thinking, and the child MUST launch with those exact captured values.
- **MOD-002**: Before any work prompt, the child extension MUST emit session-bound in-process bootstrap attestation through the intended Herdr pane metadata, including official session ID, reported path, concrete provider/model, thinking, nonce, and timestamp; the controller MUST verify pane/session binding and every expected fact exactly.
- **MOD-003**: A bootstrap-reported session path is an observation and MAY precede file creation; it MUST NOT become persisted or resume-eligible authority until official OMP session JSONL exists. After the first prompt boundary, that JSONL MUST verify session ID, canonical cwd, provider, model, thinking, and fallback status against the launch expectation and bootstrap attestation.
- **MOD-004**: Attestation or persisted-verification failure MUST fail closed, and the controller MUST NOT send a synthetic prompt merely to create JSONL. Session input MUST be bounded; missing, corrupt, oversized, mismatched, known-duplicate, or credibly duplicate session evidence MUST fail closed.
- **MOD-005**: The model MUST NOT supply a session path or resume argument.
- **MOD-006**: Manual resume MAY occur only in a proved owned interactive shell or one owned replacement tab after file and duplicate checks.
- **MOD-007**: One OMP JSONL session MUST NOT be resumed concurrently.

## 7. Workspace, tab, pane, and focus ownership

- **OWN-001**: One deterministic run workspace MUST contain one retained anchor tab/pane and one owned tab per Herdr worker.
- **OWN-002**: Labels MUST be treated only as hints; stable IDs, canonical `cwd`, registry binding, agent identity, and session evidence establish ownership.
- **OWN-003**: No public operation MAY close the run workspace.
- **OWN-004**: Focus capture/restoration MUST be internal and ownership-guarded.
- **OWN-005**: Automation MUST restore only displacement onto registry-owned coordinates and MUST NOT override focus moved elsewhere, which may be concurrent user action.
- **OWN-006**: `focus_restoration: partial` MUST be recorded as a warning, not interpreted as proof that the main operation failed.

## 8. Prompt, report, block, and dedupe authority

- **COM-001**: Copied `protocol.md` MUST be authoritative for run communication rules.
- **COM-002**: Workers MUST append only to their own `w<N>-report.md`; the target ORCH MUST write only its authorized report; ORCH MUST record decisions and closure judgments in `[ORCH Response]` blocks.
- **COM-003**: Runtime output and Herdr state MUST remain observations, not substitutes for reports.
- **COM-004**: Matching instruction fingerprints MUST be treated as deduplication evidence.
- **COM-005**: A worker decision request MUST batch situation, options, tradeoffs, and recommendation while independent work continues where safe.
- **COM-006**: ORCH MUST independently verify decision grounds before responding to a block.

## 9. Close, resume, reset, and handoff

- **LIFE-001**: ORCH MUST freshly inspect every registry-owned worker and target ORCH before run closure.
- **LIFE-002**: ORCH MUST resolve or escalate blocked states and reconcile every unknown or ambiguous effect before closure.
- **LIFE-003**: Only safe settled workers MAY be closed through `close_worker`; unsafe or active workers MUST be preserved with exact recovery coordinates.
- **LIFE-004**: Material worker claims MUST be independently reproduced before acceptance. Independent evidence SHOULD be recorded in `evidence.md` when used.
- **LIFE-005**: Durable decisions and evidence SHOULD be promoted to permanent project locations before run closure; the deterministic run MUST remain the audit record.
- **LIFE-006**: A sibling reset MUST create a different target coordinate under the same configured storage root, copy and fingerprint the canonical source plan through `init_run`, record fixed lineage policies, and MUST NOT traverse or mutate source workers.
- **LIFE-007**: Copied reset evidence MUST NOT be inherited as truth; it MUST be revalidated before citation.
- **LIFE-008**: The target ORCH MUST launch against the target's canonical instructions, use its own exact official persisted session for future resume, and MUST NOT resume source ORCH context as the target.
- **LIFE-009**: A handoff MUST preserve track/run identity, canonical path observations, config hashes, registry/workspace/anchor identity, official sessions/models, reset lineage, active source workers, blocked/ambiguous effects, focus warnings, and review status.
- **LIFE-010**: A successor MUST accept, defer, or reject every carried item before assuming relay.
- **LIFE-011**: The final sibling-target lifecycle MUST initialize and reconcile the target, author its canonical instructions, start or reconcile exactly one pinned target ORCH, inspect before judgment or recovery, persist post-prompt JSONL verification, deduplicate by the permanent instruction fingerprint, verify the authorized report, and retain the run anchor.

## 10. Security, privacy, and secrets

- **SEC-001**: All mutation paths MUST fail closed when identity, authority, model, session, ownership, topology, or effect cannot be proved.
- **SEC-002**: Arbitrary run, registry, instruction, session, workspace, tab, pane, or resume coordinates from model input MUST NOT be trusted.
- **SEC-003**: Storage index and registry mutations MUST be atomic and lock-guarded.
- **SEC-004**: Ambiguous prompt, block-response, start, or close effects MUST be inspected and reconciled; blind retry MUST NOT occur.
- **SEC-005**: Error messages and live output returned to the model MUST be bounded.
- **SEC-006**: Plans, instructions, reports, evidence, peer channels, configuration examples, and tool responses MUST NOT contain secrets, authentication material, access tokens, private keys, personal data, or unnecessary private-source excerpts.
- **SEC-007**: This plugin MUST NOT be represented as a secret store, redaction layer, sandbox, authorization system, or data-loss-prevention system.
- **SEC-008**: Secrets or account access required by a decision MUST be escalated to the user rather than requested through a worker report or block response.
- **SEC-009**: Public documentation and package metadata MUST remain product-neutral, English-only, and free of local machine paths.

## 11. Installation, discovery, and packaging

- **PKG-001**: `package.json` MUST retain the OMP extension entry `./extensions/herdr-delegator.ts`, existing scripts, and development dependencies.
- **PKG-002**: Package metadata MUST declare description, Apache-2.0 license, repository, homepage, bugs, keywords, and an explicit publish allowlist.
- **PKG-003**: The publish allowlist MUST include extension modules, the `herdr-delegation` skill, schemas and examples, README, LICENSE, and docs.
- **PKG-004**: README prerequisites MUST require current OMP, Herdr, and official `herdr integration install omp`.
- **PKG-005**: README MUST document GitHub installation through OMP plugin install and a local development link.
- **PKG-006**: A remote repository command MUST NOT be described as release-verified until final repository installation is exercised. Supported OMP command syntax MAY be identified separately from repository availability.
- **PKG-007**: Skill discovery MUST begin with `/skill:herdr-delegation` after plugin discovery/reload.
- **PKG-008**: Development documentation MUST identify `bun install` and `bun run check`.

## 12. Module architecture

- **ARC-001**: The extension MUST comprise exactly six responsibility modules: registration and dispatch in `extensions/herdr-delegator.ts`; dependency-free shared contracts in `extensions/lib/contracts.ts`; strict configuration, validation, canonical paths, manifests, and atomic storage in `extensions/lib/config.ts`; Herdr, launch pinning, bootstrap, persisted-session, ownership, and focus mechanisms in `extensions/lib/runtime.ts`; worker lifecycle in `extensions/lib/worker.ts`; and run/reset/target-ORCH lifecycle in `extensions/lib/track.ts`.
- **ARC-002**: Module dependencies MUST remain acyclic and flow `entry → worker|track|runtime|config|contracts`, `worker|track → runtime|config|contracts`, `runtime → config|contracts`, and `config → contracts`. Lifecycle ownership MUST remain in `worker` and `track`; `contracts` MUST depend on none of the other five modules.

## 13. Observable acceptance scenarios

- **ACC-001 — Clean initialization**: Given valid layered configuration and a canonical project directory, `init_run` derives configured deterministic storage and creates the manifest, bundled protocol, `a2a` directory, and index row with atomic owned mutations; it creates no worker, placeholder report, workspace, tab, or session. After interruption, a valid partial owned set reconciles exactly, while any conflict fails closed.
- **ACC-002 — Idempotent reconciliation**: Repeating `init_run` with the same coordinate/cwd and unchanged owned artifacts succeeds without changing identity; any manifest/protocol conflict fails closed.
- **ACC-003 — Explicit routing and pinning**: Bounded light work routes to host task/subagents without registry state. `ensure_worker` without a profile is rejected; `default` or `slow` is explicit, the caller resolves its role, and the child session proves the exact pinned concrete model/thinking.
- **ACC-004 — Prompt dedupe and ambiguous recovery**: Repeating a prompt request with a matching fingerprint does not deliver a duplicate. A permanent `prompting` fingerprint after an ambiguous return remains a no-replay guard while exact persisted JSONL verification and inspection establish recovery.
- **ACC-005 — Stale block response**: A block response with a stale `expected_state_change_seq` is rejected without sending input.
- **ACC-006 — Ambiguous timeout**: A timed-out prompt, response, target start, or close reports ambiguity and requires inspection; no blind resend or replacement occurs.
- **ACC-007 — Exact resume and path authority**: A bootstrap-reported session path alone is not resume authority. A reconciled worker or target ORCH resumes only its registry-recorded official session after the JSONL exists and passes persisted identity, model/thinking/fallback, ownership, and duplicate checks.
- **ACC-008 — Concurrent focus**: If focus moves away from operation-owned coordinates, restoration is skipped rather than overriding possible user action.
- **ACC-009 — Sidebar-aware close**: A settled worker with only its root pane and structurally verified Sidebar auxiliaries closes; any mixed or unproved pane prevents closure. A later `agent_not_found` observation leaves the registry `closed` record authoritative and the anchor retained.
- **ACC-010 — Sibling reset**: Reset to a different configured-storage coordinate copies the source plan, records fixed lineage policies, leaves source workers untouched, and requires evidence revalidation.
- **ACC-011 — Target ORCH**: `start_orch` resolves canonical target instructions, pins the child to caller-resolved `@plan` concrete identity, verifies pre-prompt bootstrap and post-prompt persisted JSONL, fingerprints delivery, and recovers or deduplicates without replay; `inspect_orch` reports official identity, path authority, verification, and settled state before judgment.
- **ACC-012 — Shared-directory safety**: The plan assigns disjoint writes to concurrent workers or serializes overlap; the plugin does not claim filesystem isolation it does not provide.
- **ACC-013 — Public package**: Published contents are bounded by `files` and contain extension modules, skill, schemas/examples, README, LICENSE, and review docs without local paths or secrets.

## 14. Known non-goals

- **NG-001**: General-purpose process, terminal, workspace, or tab management.
- **NG-002**: Automatic task decomposition, scope changes, prioritization, approval, completion judgment, or user-decision replacement.
- **NG-003**: Selecting or verifying models used by host task/subagents.
- **NG-004**: Concurrent-write isolation for workers sharing one project directory.
- **NG-005**: Closing the retained Herdr workspace.
- **NG-006**: Treating terminal text, labels, or worker reports as sufficient ownership or correctness proof.
- **NG-007**: Automatically trusting or importing evidence from a source reset run.
- **NG-008**: Secret management, credential transport, redaction, privacy classification, or sandboxing.
- **NG-009**: Guessing through malformed state, repairing registries manually, or bypassing conflicts with replacement identities.

## Review checklist

### Implemented facts to verify against code and schemas

- [ ] Package/plugin `herdr-delegator` is 0.4.0; skill `herdr-delegation` is 3.0.0.
- [ ] Public tool names and every operation/input limit match `extensions/herdr-delegator.ts`.
- [ ] Configuration hierarchy, strict keys, defaults, role aliases, profile routing, and configured deterministic storage-root rules match `config.schema.json` and `extensions/lib/config.ts`.
- [ ] Run/reset fields, atomic per-artifact writes, partial-init reconciliation boundaries, and lineage policies match `run.schema.json`, `reset.schema.json`, and track initialization.
- [ ] Caller role resolution and child concrete launch pinning match entry, runtime, worker, and track behavior.
- [ ] Pre-prompt session-bound bootstrap attestation and post-prompt persisted JSONL verification match runtime, worker, and track behavior, including reported-path versus resume-eligible-path handling.
- [ ] Permanent prompt fingerprints, ambiguous target recovery, and no-replay behavior match worker and track state transitions.
- [ ] Free-form text and interactive-option key resolution, post-close `agent_not_found`, registry closed authority, focus, and topology invariants match runtime and worker behavior.
- [ ] The six modules and acyclic dependency direction match imports and keep lifecycle ownership in worker and track.
- [ ] Package publish allowlist contains every public runtime, skill, schema/example, license, and review document.
- [ ] README installation language distinguishes supported OMP syntax from final repository install verification.
- [ ] No public artifact contains a local machine path, secret, private token, or product-specific dependency outside OMP and Herdr.

### Reviewer decisions to approve or request changes to

- [ ] Approve the authority split: tools own index/registry/locks; ORCH owns plans/instructions/judgments; workers own only authorized reports/channels.
- [ ] Approve deterministic identity as `(track_id, run_id)` with no arbitrary run-path input.
- [ ] Approve fixed ORCH role `@plan`, caller concrete resolution, child exact concrete launch pinning, and explicit worker-profile selection with no implicit fallback.
- [ ] Approve routing boundary: light work uses host smol task/subagents where available; ordinary durable work uses explicit `default` persistent tabs and higher-capability durable slices use explicit `slow`.
- [ ] Approve shared-directory policy: parallel writes require disjoint ownership; overlap is serialized.
- [ ] Approve the two-stage session gate, distinction between reported and persisted/resume-eligible paths, and fail-closed attestation/JSONL policy.
- [ ] Approve permanent fingerprint no-replay behavior, including persisted verification without rewriting an ambiguous `prompting` state.
- [ ] Approve free-form text versus interactive-option key resolution and sequence-exact no-effect handling.
- [ ] Approve exact-session resume and fail-closed duplicate/ambiguity policy.
- [ ] Approve guarded focus restoration and the interpretation of `partial` as a warning.
- [ ] Approve Sidebar structural proof, registry authority after post-close `agent_not_found`, and refusal to close mixed or unproved tabs.
- [ ] Approve sibling-reset and target-ORCH lifecycle: preserve source authority, revalidate evidence, pin target identity, inspect, persist verification, deduplicate, and retain the anchor.
- [ ] Approve no-secret/public-artifact boundary and explicit non-goals.

### Markdown documents to approve or request changes to

- [ ] [`README.md`](../README.md): public identity, prerequisites, install status, configuration, lifecycle, security, and development entry points.
- [ ] [`docs/ARCHITECTURE.md`](ARCHITECTURE.md): actor model, authority, module graph, state machines, recovery, and trust boundaries.
- [ ] `docs/SPEC.md`: normative IDs, operation contracts, acceptance scenarios, non-goals, and this checklist.
- [ ] [`config.schema.json`](../config.schema.json), [`run.schema.json`](../run.schema.json), and [`reset.schema.json`](../reset.schema.json): strict public data contracts.
- [ ] [`LICENSE`](../LICENSE): canonical Apache License 2.0 text and copyright notice.
