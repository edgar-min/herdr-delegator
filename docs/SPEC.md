# Herdr Delegator Specification

## Status and language

This document is the normative architecture and Markdown review artifact for `herdr-delegator` 3.4.0 and the bundled `herdr-delegation` skill 3.4.0.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are interpreted as described by RFC 2119.

Statements under **Implemented facts** describe the current source contract. Statements under **Reviewer decisions** identify architecture or documentation choices requiring approval; they are not claims of missing implementation.

## 1. Identity, scope, and versions

- **ID-001**: The public package and OMP plugin name MUST be `herdr-delegator`.
- **ID-002**: The package and plugin version MUST be `3.4.0`.
- **ID-003**: The public skill MUST be named `herdr-delegation` and versioned `3.4.0` under frontmatter metadata.
- **ID-004**: The public MCP tools MUST be exactly `herdr_track`, `herdr_assignment`, `herdr_worker`, `herdr_message`, and `herdr_friction`.
- **ID-005**: OMP MUST be the only officially supported agent runtime.
- **ID-006**: The repository identity MUST be `https://github.com/edgar-min/herdr-delegator`.
- **ID-007**: The license MUST be Apache-2.0 with copyright 2026 Edgar Min.
- **ID-008**: A run MUST be identified by `(track_id, run_id)`, never by a model-supplied path.
- **ID-009**: Track, run, and responsibility IDs MUST match `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`.
- **ID-010**: Assignment IDs MUST match `^A-(?!0+$)[0-9]{3,}$`.
- **ID-011**: Worker IDs MUST match `w[1-9][0-9]*` and remain lowercase in deterministic filenames.

## 2. Configuration and OMP bridge

### 2.1 Configuration hierarchy

- **CFG-001**: Configuration MUST load in this order: built-in defaults, user file, project file, optional run file.
- **CFG-002**: The user file MUST resolve to `${PI_CODING_AGENT_DIR}/herdr-delegator.json`, or `~/.omp/agent/herdr-delegator.json` when the environment variable is unset.
- **CFG-003**: The project file MUST resolve to `<canonical-cwd>/.omp/herdr-delegator.json`.
- **CFG-004**: The optional run file MUST resolve to `<canonical-run>/herdr-delegator.json`.
- **CFG-005**: Later layers MUST override earlier leaves. A worker profile MUST inherit only from the same profile name already accumulated across earlier layers; cross-name inheritance MUST NOT exist. The layer that first defines a profile name MUST declare `role`, otherwise that layer MUST fail closed with `invalid_config` naming the profile and the layer file, so a misspelled profile name can never resolve to another profile's identity. A first definition without `thinking` MUST take `inherit`.
- **CFG-005a**: A worker profile MAY carry `guidance`, `intent`, and `directive`, each bounded single-line prose. `intent` is ORCH-facing profile-selection criteria, with `guidance` rendered as its fallback when `intent` is absent; `directive` is worker-facing execution guidance rendered only to a lane selected with that profile. Each field overrides by same-name layer exactly like `role` and `thinking`, and all three are advisory only — never a role, model, authority, or assignment contract. Blank, over-long, and control-character values MUST fail closed.
- **CFG-006**: At least the user or project layer MUST set an absolute `storage.root`; no temporary or project-directory fallback is allowed.
- **CFG-007**: A run layer MUST NOT relocate its own storage root.
- **CFG-008**: Every consumed configuration layer MUST be recorded by canonical path, scope, and SHA-256.
- **CFG-009**: Configuration MUST use version 1, reject unknown keys, and fail closed when unreadable or malformed.

### 2.2 Roles and bridge facts

- **CFG-010**: The built-in orchestrator profile MUST select role `@default` with thinking `inherit`; configuration MAY select another bounded OMP role alias. A planning-grade role such as `@plan` with elevated thinking SHOULD be configured when judgment quality takes priority over cost.
- **CFG-011**: Built-in worker profiles MUST be exactly `default`, `task`, and `slow`; each MUST select `@default` with thinking `inherit` so it resolves without user configuration. Configuration SHOULD map `task` to `@task` and `slow` to `@slow` when those roles are configured. Cost-efficient small mechanical work MUST route to host OMP task/subagents under RTE-002 rather than to a persistent lane profile.
- **CFG-012**: Profile names MUST match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- **CFG-013**: Role aliases MUST match `^@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- **CFG-014**: Configured thinking MUST be one of `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `auto`.
- **CFG-015**: Configuration MUST contain role aliases, never concrete model IDs.
- **CFG-016**: The OMP extension MUST be bridge-only and MUST NOT register public delegation tools.
- **CFG-017**: The bridge MUST refresh session identity and attestation on session start, session switch, and before agent start; it MUST NOT publish provider, model, thinking, role-resolution, current-model, or configuration-source authority.
- **CFG-018**: The bridge MUST write exactly the strict identity-only fact `{version:1, session_id, reported_session_path?, pane_id, issued_at, nonce}` atomically to an owner-only, session-scoped file under the active OMP agent directory; callers MUST NOT supply that file path. Pane bootstrap metadata MUST contain exactly session and attestation tokens.
- **CFG-019**: MCP and child-bootstrap verifiers MUST be identity-only. MCP MUST derive the fact coordinate from the verified caller pane and official OMP session, then verify ownership, non-symlink type, restrictive modes, strict schema, freshness, nonce, official session/path/pane correspondence, and exact session/attestation token equality; child bootstrap MUST independently verify workspace/tab/pane ownership, official session path, session token, attestation token, and freshness.
- **CFG-020**: [`config.schema.json`](../config.schema.json) and [`config.example.json`](../config.example.json) MUST remain the public configuration schema and built-in profile example.

### 2.3 Advisory skill routing

- **SRT-001**: Configuration MAY declare `skill_routing` in two cooperating parts. `skills` MAY map at most 64 skill names matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` to optional bounded single-line `intent` and `trigger` metadata. `rules` MUST contain at most 16 rules, each carrying 1–8 such skill names and using exactly one of two shapes: the legacy shape declares `boundary` from `plan | authoring | dispatch | completion | settlement | reset` and `surface` from `orch | worker`, with optional rule-level `trigger` and `profiles` containing 1–8 worker profile names matching CFG-012; the additive shape declares `{ agent, moment, skills }`, where agent `orch` accepts moments `plan | authoring | settlement | reset`, while an agent matching CFG-012 accepts worker moments `intake | report`. The parser MUST lower the additive shape into the legacy internal vocabulary: orch moments retain their boundary on surface `orch`, while a profile agent's `intake` and `report` become `dispatch` and `completion` on surface `worker`, scoped to that profile. Malformed routing MUST fail closed with the rest of the layer.
- **SRT-001a**: A rule carrying `profiles` MUST be delivered only where the delivery target's worker profile is named in the list; a rule without `profiles` MUST reach every profile. A named profile that no `worker_profiles` entry defines MUST NOT be an error and MUST simply never match, because rules and profiles may be authored in different layers. A delivery point that holds no profile — every orchestrator-surface point — MUST receive only unscoped rules, so a profile-scoped route can never reach a target whose profile is unknown.
- **SRT-002**: A later configuration layer's `skill_routing` MUST replace the earlier layer's value as one leaf.
- **SRT-003**: Matching routes MUST be delivered deterministically after parse-time lowering: `herdr_track init` results carry orch-surface `plan`/`authoring` routes (plus `reset` for a sibling reset), `herdr_assignment preflight` results carry orch-surface `authoring` routes, the worker dispatch prompt carries worker-surface `dispatch`/`completion` routes filtered by the lane's assignment profile and names that profile's materialized guidance document when one exists, terminal assignment results carry orch-surface `settlement` routes, `guidance.md` carries matching orch-agent `plan`/`authoring`/`settlement`/`reset` routes, and `guidance-<profile>.md` carries that profile agent's `intake`/`report` routes.
- **SRT-004**: Routes are advisory text only. They MUST NOT gate settlement, lifecycle, recovery, or any mutation; a delivered route MUST NOT be recorded or represented as proof that a skill ran.
- **SRT-005**: Advisory route lookup MUST NOT block control flow; a failed lookup degrades to an empty route set while configuration-as-authority paths keep failing closed.
- **SRT-006**: The shipped configuration MUST name no skills; skill names live only in user, project, or run configuration layers.
- **SRT-007**: A result carrying non-empty `skill_routes` MUST also carry one bounded imperative `skill_routes_note` naming the skill resolution scheme (`skill://<name>` or the runtime's skill catalog); the note remains advisory text with no authority.

### 2.4 Boundary judgment delivery

- **JDG-001**: A field or boundary whose right value is a situational judgment MUST deliver the judgment criteria at that boundary. Published constants MUST remain stated contract facts and MUST NOT be phrased as recommendations, defaults to accept, or the value to use. The binding surfaces are schema `describe` text, the run guidance document, and the worker dispatch pointer.
- **JDG-002**: A bound or fallback MUST be stated as what it is — a ceiling, a clamp, or a fallback — beside the criterion for choosing within it. A describe text MUST NOT invite omission of a field whose declared value is the judgment being asked for.
- **JDG-003**: Judgment criteria are advisory material. They MUST NOT gate settlement, lifecycle, recovery, or any mutation, and their absence MUST NOT block an operation.

### 2.5 Run guidance document

- **GDE-001**: `herdr_track open` and both `revive` modes MUST render `<run>/guidance.md` from resolved configuration before the ORCH spawn. Assignment dispatch MUST materialize `<run>/guidance-<profile>.md` from the configuration current at dispatch when that profile has a directive or matching route.
- **GDE-002**: `guidance.md` MUST carry the worker-profile table (configured name, role alias, and `intent`, with legacy `guidance` as fallback) and every matching orch-agent `plan | authoring | settlement | reset` route with each skill's configured `intent` and `trigger`. `guidance-<profile>.md` MUST carry only that profile's `directive` and matching `intake | report` routes. The renderer MUST author no judgment sentence beyond its closed structural strings.
- **GDE-003**: Guidance rendering MUST perform no installed-presence detection, lockfile lookup, or `SKILL.md` disk walk. Skill bodies resolve natively through `skill://`; an uninstalled skill is a reader-side no-op, and a skill without authored `intent` MUST render a `read skill://<name>` fallback. An absent ORCH route set MUST omit its section, a profile without selection criteria MUST render an em dash in the table, and a profile with neither directive nor route MUST produce no lane document.
- **GDE-004**: Rendering MUST be best-effort and MUST NOT block a spawn or dispatch. An ORCH render failure MUST degrade to a `guidance.md` naming the failure; an ORCH write failure MUST surface as a warning. A lane render or write failure MUST surface as a warning and omit the lane-document pointer.
- **GDE-005**: The ORCH's first prompt MUST name `guidance.md` as a third, explicitly advisory document whenever the run holds one, and MUST keep its two-document form on a run that holds none. A worker dispatch pointer MUST name `guidance-<profile>.md` only when materialization returned a path. Neither document may change scope, authority, ownership, immutable files, completion conditions, settlement, or recovery.
- **GDE-006**: Guidance documents are rendered artifacts, not run state: they MUST add no `run.json` key, `guidance.md` MUST NOT appear in the open result payload, and run layout, manifest, and reconcile checks MUST tolerate its presence or absence.

## 3. Deterministic storage and authority

- **STO-001**: The canonical run path MUST be `<storage.root>/<track_id>/<run_id>` and MUST be derived rather than accepted from callers.
- **STO-002**: Canonical directory identity MUST be verified; symlink and path conflicts MUST fail closed.
- **STO-003**: `run.json` MUST conform to [`run.schema.json`](../run.schema.json), bind run coordinates to canonical `cwd` and `run_path`, and reject unknown fields.
- **STO-004**: `herdr_track {action:"init"}` MUST create or exactly reconcile only the run manifest, the bundled protocol set (`protocol.md`, `protocol-orch.md`, and `protocol-worker.md`), `a2a/`, the storage index row, and reset artifacts when requested. `guidance.md` MUST NOT be created by `init` and MUST be accepted as an optional run file when a previous `open` or `revive` rendered it.
- **STO-005**: Initialization MUST NOT create placeholder plans, assignments, reports, evidence, registries, workspaces, tabs, panes, or OMP sessions.
- **STO-006**: Existing `protocol.md`, `protocol-orch.md`, and `protocol-worker.md` MUST each match a digest this project has shipped for that document — byte-identical to the installed template, or a previously shipped version accepted with a named drift warning. Any other content MUST fail closed, and no template change MUST strand an existing run.
- **STO-007**: `<storage.root>/index.json` MUST be strict version 1, atomic, lock-guarded, and consistent with the run manifest.
- **STO-008**: `a2a/herdr-workers.json` version 3 MUST remain lifecycle identity authority; `a2a/delegation.json` version 3 MUST remain responsibility and assignment routing authority. Registry reads MUST accept schema versions 1–3; writes MUST emit version 3. Each version upgrade only adds optional fields, so no existing field changes meaning, and an unsupported version MUST fail with a named `registry_version_unsupported` rather than a malformed-file error.
- **STO-009**: Tool-owned manifests, indexes, registries, and locks MUST NOT be manually edited, moved, copied, or unlocked.
- **STO-010**: Registry and lock files created by the plugin MUST use restrictive owner-only modes.
- **STO-011**: ORCH MUST author plans, immutable assignments, decisions, and evidence. Workers MUST append only to their authorized report or declared directional peer channel.
- **STO-012**: Canonical paths returned by tools MUST be bounded audit observations, not alternate operation coordinates.
- **STO-013**: Initialization is a reconciliatory multi-artifact transaction. A partial valid owned set MAY be reconciled; conflicting or unowned content MUST fail closed.

## 4. Responsibility and assignment contract

### 4.1 Responsibility lanes

- **RSP-001**: A worker MUST represent a persistent responsibility lane, not one assignment.
- **RSP-002**: Exact responsibility reuse MUST be attempted before creating a new lane.
- **RSP-003**: A lane MUST have at most one active assignment and one FIFO queue.
- **RSP-004**: A busy or blocked matching lane MUST queue subsequent assignments rather than cause worker creation.
- **RSP-005**: There MUST be no fixed worker-count ceiling.
- **RSP-006**: An additional lane for the same responsibility MUST require `kind: direction|ownership|dependency`, a bounded non-empty `reason`, and an existing `conflicts_with_worker_id`.
- **RSP-007**: Lane creation MUST NOT use scoring, automatic decomposition, or busyness as a separation reason.
- **RSP-008**: A new worker number MUST NOT bypass responsibility ambiguity, identity conflict, unsafe topology, or session uncertainty.
- **RSP-009**: Worker ordinals already present in delegation state, lifecycle state, or canonical worker instruction/report filenames MUST remain reserved.

### 4.2 Immutable assignment

- **ASN-001**: One assignment MUST be represented by exactly one ORCH-owned `<run>/a2a/assignments/<assignment_id>.md`.
- **ASN-002**: The assignment file MUST be bounded UTF-8 with LF line endings, a regular non-symlink file, and at most 64 KiB.
- **ASN-003**: Frontmatter MUST contain exactly and in order `assignment_id`, `responsibility_key`, and `profile`.
- **ASN-004**: The body MUST contain exactly and in order `Goal`, `Completion conditions`, `Write ownership`, `Dependencies`, and `User boundaries`.
- **ASN-005**: The final four sections MUST contain one or more bounded Markdown bullets.
- **ASN-006**: The requested assignment ID and responsibility MUST equal the file frontmatter.
- **ASN-007**: The exact file SHA-256 MUST be passed as `instructions_sha256`; a submitted assignment MUST remain immutable.
- **ASN-008**: Duplicate assignment IDs with different responsibility or hash MUST fail closed.
- **ASN-009**: No separate assignment contract, instruction, or receipt file MAY be required or created.
- **ASN-010**: A worker MUST append durable results to its bound `a2a/w<N>-report.md`.
- **ASN-011**: Settlement MUST require an exact `[Assignment Completion: A-NNN]` block containing exactly one `status: completed` or `status: failed` line.
- **ASN-012**: Settlement MUST store the complete worker-report SHA-256 and completion timestamp in `delegation.json`.
- **ASN-013**: Settlement MUST transition the assignment to its terminal state, return the lane to `idle`, record the last completed assignment, and promote the FIFO head.
- **ASN-014**: Assignment completion MUST NOT close the worker tab or official OMP session.

## 5. Public MCP tool contract

### 5.1 Common result and input rules

- **TOOL-001**: The public surface MUST contain exactly the five tools named in ID-004; raw Herdr management MUST NOT be public.
- **TOOL-002**: Every input MUST be a strict action-discriminated object and reject extra or action-inappropriate fields.
- **TOOL-003**: Every action MUST include `track_id` and `run_id`.
- **TOOL-004**: Where a `wait` object is accepted, `timeout_ms` MUST be an integer from 1,000 through 300,000 and default to 120,000; `until` values MUST be drawn from `idle`, `done`, and `blocked`.
- **TOOL-005**: Results MUST include `ok`, `tool`, `action`, `run`, `effect`, and `retryable`, plus bounded registry, worker, assignment, `timed_out`, data, or error fields as applicable.
- **TOOL-006**: Effect MUST be `none`, `confirmed`, or `ambiguous`.
- **TOOL-007**: Structured errors MUST include code, phase, bounded message, recovery guidance, and `ambiguous_effect`.
- **TOOL-008**: An ambiguous effect MUST never be advertised as blindly retryable.
- **TOOL-009**: Callers MUST NOT provide arbitrary run, assignment, report, session, pane, tab, workspace, executable, argv, or command coordinates.

### 5.2 `herdr_track`

- **RUN-001**: `open` MUST be the single atomic entry for a new track and MUST, in one call, lay out the run, fix the bounded mandate as `orchestrator-instructions.md`, stamp the creator, spawn the ORCH pre-aligned to the configured orchestrator role, and record the ORCH birth. `cwd` MUST be an existing absolute canonical project path.
- **RUN-001a**: `open` MUST stamp the creator record before the spawn, so a failed spawn leaves a run no other caller can command and only the same creator coordinate can complete; it MUST be re-entrant under an identical mandate and MUST refuse a different mandate with `mandate_conflict`.
- **RUN-001b**: An attested creator session MUST be retired for that run, and its later guarded calls MUST fail `creator_session_retired`. A degraded opening pane MUST likewise be retired from guarded calls but has no session ID to record as retired. The result MUST carry a redirection pointer naming the ORCH pane.
- **RUN-001c**: Mandate limits MUST be published up front and named with the observed size on rejection: intent 4096 characters, each list entry 500 characters, at most 32 entries per list, whole rendered document 16384 bytes.
- **RUN-001d**: `open` MUST NOT record a role table. A caller launched with an explicit model has its `default` role overridden in the process-local runtime layer, so its observed role resolutions are its own launch identity and not the user's configuration; recording them made every later spawn inherit the caller's model (friction 221abf10d2280b47). Registries written before this rule MAY carry an optional `pinned_roles` record and MUST remain readable; nothing writes it and no spawn resolves through it.
- **RUN-001e**: Fresh `open` alone MAY cross exactly `omp_fact_bridge_mismatch`; every operation resolving an existing run MUST remain fail-closed behind bridge verification. `OrchCreatorRecord` MUST be the additive union of attested `{session_id, pane_id, mandate_sha256, opened_at, verified?:true}` and degraded `{pane_id, mandate_sha256, opened_at, verified:false}` with no `session_id`. An attested retry from the same pane MUST upgrade a degraded record, while a bridge outage MUST NOT downgrade an attested record.
- **RUN-002**: `init` MUST accept `cwd` and optional `reset_of` and MUST remain available for reset siblings and handoff targets; it MUST be refused on a run that carries a creator record.
- **RUN-003**: `inspect` MUST accept no action-specific fields and return bounded delegation registry, target-ORCH, and budget observation, reporting unavailable bridge-dependent observation without mutating.
- **RUN-004**: `start_orchestrator` MUST accept no action-specific fields, MUST pass the configured orchestrator role to the child as an unresolved alias rather than a concrete model, MUST verify bootstrap attestation, and MUST preserve prompt no-replay evidence; it MUST be refused with `track_opened_atomically` on an `open`-managed run.
- **RUN-004a**: No alignment command MUST exist. Every ORCH MUST be born pre-aligned by its spawn, and caller model alignment MUST NOT be a precondition of `open`.
- **RUN-005**: `budget_extend` MUST require a bounded justification (`done`, `remaining`, `why_more`) and MUST grant nothing on its own; see section 5.6.
- **RUN-006**: `revive` MUST default to resuming the recorded birth session with no new generation, and MUST create generation+1 only under the gates in section 5.7.
- **RUN-007**: `close` MUST require a fresh nonnegative `expected_registry_revision`.
- **RUN-008**: Track close MUST fresh-inspect and session-verify every idle candidate before mutation and MUST reject the entire close when any lane is active, blocked, ambiguous, identity-conflicted, or unsafe.
- **RUN-009**: A sibling reset MUST use a different coordinate under the same storage root, copy the source plan, and record `close-settled-preserve-active` plus `revalidate-before-import`.
- **RUN-010**: A run's ORCH identity MUST be the latest record in the registry's birth chain. Guarded run-command ops MUST accept only that session while its recorded ORCH is live, MUST reject a retired generation with `stale_orch_generation`, a stranger with `orch_identity_mismatch`, and the retired creator with `creator_session_retired`; `close` alone admits the RUN-013 force path once the recorded ORCH is provably gone.
- **RUN-011**: Names MUST be the supervision surface: space `herdr/<track_id>`, run anchor tab and ORCH pane `ORCH <track_id>/<run_id>` plus an optional status marker, worker pane `w<N> <responsibility_key>`. Labelling MUST be display-only and MUST degrade to a warning.
- **RUN-012**: A run's materialized protocol documents MUST be accepted when they match any digest this project has shipped for that document; an older-but-shipped digest MUST be accepted with a named `template_drift_warning`, and any other content MUST fail closed. A template change MUST NOT make an existing run unloadable or unrevivable.
- **RUN-013 (force close)**: `close` MUST be ORCH-only while the run's recorded ORCH is live. A non-ORCH attested caller MUST close a run only when all of these hold: the caller passes bootstrap attestation; `<run>/close-approval.json` exists as a canonical regular file ≤8 KiB parsing exactly as `{"version":1,"track_id","run_id","approve_close_generation","reason"}` and naming this run and its latest recorded ORCH generation; a fresh Herdr observation shows no live agent referencing the recorded ORCH session, with the caller's own pane present in that census; and `expected_registry_revision` matches. The approval file MUST be human-owned: the machine verifies its contents and never its authorship, and no agent writes it. A live recorded ORCH MUST refuse `orch_still_live`; an observation that cannot be read as a census MUST refuse `orch_liveness_unknown`. Closure attribution (caller session, approval SHA-256, death evidence, timestamp) MUST be recorded in the run's append-only ledger and message log.

### 5.3 `herdr_assignment`

- **ASN-014a**: `preflight` MUST require `assignment_id` and `responsibility_key`, validate the canonical draft grammar at the derived coordinate, return the server-computed SHA-256 of the exact validated bytes, and never mutate the registry, a lane, or the artifact; an already-registered assignment MUST return its immutable state instead.
- **ASN-015**: `add` MUST require `assignment_id`, `responsibility_key`, and `instructions_sha256`; it MAY accept `separation` and `wait`.
- **ASN-016**: `add` MUST verify the immutable artifact before routing, select exact responsibility reuse or valid separation, ensure session/model identity, record prompt intent, send only a canonical pointer, wait to a natural boundary, and verify persisted identity after prompt.
- **ASN-017**: A duplicate identical assignment MUST return a no-effect observation; a queued assignment MUST remain queued without lifecycle wait.
- **ASN-018**: `wait` MUST require only `assignment_id` plus optional `wait`; a timeout MUST have no mutation effect. An elapsed wait window MUST surface as a successful no-effect observation carrying `timed_out: true` and the freshly observed lane state, never as an error result.
- **ASN-019**: There MUST be no assignment response action. ORCH answers a worker — decision request, ruling, or a worker blocked on input — by appending an `[ORCH Response]` block to `a2a/w<N>-report.md` and sending `herdr_message {action:"wake_worker"}`; the wake is pane input, so it reaches an idle and an input-waiting worker alike.
- **ASN-020**: The report append MUST be the authority and the wake MUST be a pointer only; a missing or failed wake MUST NOT block settlement.
- **ASN-021**: `blocked` MUST remain an observable assignment and lane state; only the response tool action is removed.
- **ASN-022**: Secrets or account access MUST be escalated to the user, never requested through a worker report or a doorbell.
- **ASN-023**: A prompt or active-assignment resume whose effect cannot be proved MUST converge on assignment state `ambiguous` with bounded replay facts.
- **ASN-024**: Assignment state MUST be exactly `queued`, `prompting`, `working`, `blocked`, `completed`, `failed`, or `ambiguous`.
- **ASN-025**: Internal lifecycle phases MUST NOT expand the public or persisted assignment state vocabulary.

### 5.4 `herdr_worker`

- **WRK-001**: `list` MAY accept `responsibility_key` and MUST return only bounded registry-owned lane observations.
- **WRK-002**: `inspect` MUST require `worker_id` and MAY accept `output_lines` from 1 through 200.
- **WRK-003**: Inspection MUST validate run, registry, workspace, tab, pane, and official session identity before updating bounded lane observation.
- **WRK-004**: `resume` MUST require `worker_id` and exact `expected_session_id`; its profile MUST be derived from the bound immutable assignment.
- **WRK-005**: Resume MUST fresh-inspect and exact-match requested, delegation-registry, lifecycle-registry, and JSONL session identity before mutation.
- **WRK-006**: `close` MUST require `worker_id`, exact `expected_session_id`, and fresh nonnegative `expected_state_change_seq`.
- **WRK-007**: Worker close MUST require a settled lane, exact registry/session ownership, and safe pane topology.
- **WRK-008**: Assignment delivery MUST be available only through `herdr_assignment`, not worker lifecycle actions; answering a worker MUST be a report append plus `herdr_message wake_worker`.

### 5.5 `herdr_message`

- **MSG-001**: `wake_orch` MUST require `assignment_id` and a `boundary` from `completed`, `failed`, `blocked`, `decision-request`; `wake_peer` and `wake_worker` MUST require `to_worker_id`; `notify_run` MUST require exactly `to_track_id` and `to_run_id` and MUST accept no payload.
- **MSG-002**: The server MUST compose every delivered text and resolve every target from birth records and the worker registry; callers MUST NOT supply prompt text, panes, agent names, or argv.
- **MSG-003**: Delivery MUST be transported as Herdr agent-prompt pane input — the pane input is what triggers the receiving session — and MUST NOT use any other signaling channel.
- **MSG-004**: A message call MUST hard-error only on invalid input; delivery outcome MUST surface as a successful observation with `delivery` drawn from `delivered`, `deferred`, `rejected_blocked`, `target_unresolved`, `failed`. A target not proved focused MUST send immediately. A focused target MUST return `deferred` immediately, wait 60 seconds in the server process, re-probe once, send then if unfocused or the probe fails, otherwise wait a final 90 seconds and send exactly once.
- **MSG-005**: Every immediate send attempt and outcome MUST be appended best-effort to the sending run's `a2a/messages.jsonl`. A deferred send MUST append one scheduled row immediately with a delivery ID and the 60s/90s/150s tick plan, then one final delivered/failed row with the same identity after the background send. Log failure MUST NOT block the message; server shutdown MAY lose the soft deferred send because the named document already carries the authoritative content, with a missing final row exposing that loss.
- **MSG-006**: Sender identity is advisory routing context: an unverifiable bridge MUST degrade the sender to `unverified` with a warning instead of refusing delivery, except `wake_peer`, whose channel name requires a verified sender lane.
- **MSG-007**: A doorbell MUST carry no content of its own. `notify_run` MUST require the sender-owned inter-run channel document `a2a/orch-to-<to_track_id>_<to_run_id>.md` to exist and be non-empty, MUST ring with that document's path, SHA-256, and byte count, and MUST hard-error `channel_document_missing` or `channel_document_empty` otherwise.
- **MSG-008**: `notify_run` MUST be ORCH-to-ORCH only; a worker lane sender MUST be refused as the forbidden cross-organization message it is.

### 5.6 Budget

- **BUD-001**: A budget MUST be a justification cadence, not a wall: crossing a cap MUST park the run explicitly and MUST NOT terminate any session.
- **BUD-002**: Metering MUST be a run-level aggregate over every session the registry knows — each ORCH generation and every lane — read from the official OMP JSONL on a generative basis (input, output, cache-write, reasoning; never cache-read or a total that includes it), plus wall clock from the recorded start. Precise accounting is a non-goal.
- **BUD-003**: A session whose snapshot cannot be read MUST be charged a documented conservative allowance rather than nothing, and the observation MUST report measured, assumed, and judged totals separately.
- **BUD-004**: The budget MUST be judged at every guarded op. While parked, only a landing allowlist MUST run: assignment `wait`, worker `close`, track `close`, `budget_extend`, doorbells, and read-only actions. A queued head MUST NOT be dispatched, and `add` and worker `resume` MUST fail `budget_parked`.
- **BUD-005**: Park reasons MUST be exactly `over-cap`, `audit-unavailable`, `clamp-unreadable`, `approval-required`, `denied`, recorded in the registry with a bounded detail, appended to the append-only ledger, and marked on the ORCH pane name.
- **BUD-006**: A parked run MUST resume automatically at the next guarded op whose judgment is no longer over the ceiling.
- **BUD-007**: The mandate MAY declare a seed (`tokens`, `minutes`, `doorbell_policy`) as an estimate calibrated to the mandate's scope, never a contract. An undeclared seed MUST fall back to documented defaults of 500,000 tokens and 30 minutes so no run spends unbounded without ever justifying itself. Those fallbacks are deliberately tight — roughly the generative throughput of an ORCH plus one lane over half an hour of focused work — so a nontrivial undeclared run is expected to park early and justify itself; per JDG-002 they MUST be published as fallbacks rather than as values to accept by omission.
- **BUD-008**: `budget_extend` MUST require a bounded justification, MUST be limited to at most +50% of the granted cap per extension, MUST NOT arrive within the published minimum interval of the previous extension, and MUST grant nothing without a recorded verdict.
- **BUD-009**: The server — never the ORCH — MUST spawn the auditor as a clean session on the `slow` worker profile, seed its document with the request and machine facts, and record the verdict server-side. The auditor MUST NOT be a responsibility lane, MUST NOT be addressable by the ORCH, and MUST be closed once settled, with unclosed auditors swept at later budget ops.
- **BUD-010**: A verdict MUST be `grant`, `partial`, or `deny`. A grant MUST move both the token and wall-clock dimensions. Under doorbell policy `notify` a grant of more than zero tokens MUST also write the new granted token figure into `budget-clamp.json` as `max_tokens` whenever the value already there is absent or equal to a token value the server recorded, so an approved ceiling is visible in the human-owned file rather than only in the registry. A deny MUST park the run and MUST end the ladder at the user: a further extension MUST be refused until the human-owned clamp file changes.
- **BUD-012**: `budget-clamp.json` MUST be human-owned, and a present bound MUST be the effective ceiling; clamping to 0 MUST be a kill switch. An unreadable or malformed clamp MUST park the run rather than degrade to no clamp. The server MUST write `max_tokens` only when the value on disk is absent or equal to a token value it recorded as written or owed; the comparison MUST be by value and never by a fingerprint of the file, so an edit to `max_minutes` or `note` expresses no opinion about the token ceiling. Any other present value MUST be treated as the human's permanent pin, `0` included — a classification of "not provably server-authored", never a proof of who typed it (NG-014). Under a pin the effective token cap MUST NOT rise, an over-cap token axis MUST park `approval-required` and route to the human, and `budget_extend` MUST be refused unless the run is over on wall clock with no `max_minutes` set. Raising `max_tokens` above the judged spend MUST resume the run directly; an edit at or below the judged spend MUST pin; deleting `max_tokens` MUST hand the ceiling back so the next approved grant resumes automatic raises. A value equal to a ceiling the server recorded MUST be documented as reading machine-written, and every write MUST be atomic, MUST preserve `max_minutes`, and MUST NOT throw to its caller.
- **BUD-012a**: Fresh `open` MUST scaffold an inert owner-only `budget-clamp.json`, and every park path MUST scaffold it lazily for a legacy run that lacks it. Scaffolding MUST use create-exclusive semantics, MUST never overwrite an existing file, and MUST degrade write failure to a warning. Every park/deny recovery and corresponding ledger entry MUST state that the file already exists and accepts exactly `{version:1, max_tokens?, max_minutes?, note?}`; only the human may edit its values. Both the scaffold note and the note a server write leaves behind MUST state the pin contract and the equal-value exception, and MUST stay inside the schema's own note bound.
- **BUD-013**: Under doorbell policy `full` an audit verdict alone MUST NOT raise the effective cap and MUST NOT write the clamp; the human raises the clamp. Under `notify` the ledger and pane marker MUST be the notification, the ledger MUST name the outcome of every grant-path clamp write, and a park on a pinned token ceiling MUST also read `approval-required` while naming the pinned file and the human decision rather than the `full` policy.
- **BUD-014**: The budget ledger MUST be server-written and append-only, and the ORCH MUST NOT write it or the registry's budget record.

### 5.7 Revival

- **REV-001**: `revive` MUST NOT require the caller to be the birth session, because the ORCH may be exactly what is missing; a caller from a retired generation MUST be refused `stale_orch_generation`.
- **REV-002**: `resume` MUST reconnect the recorded birth session by its exact official path, MUST create no generation, and MUST refuse `revival_session_changed` without recording a birth when a different session identity returns.
- **REV-002a**: When the recorded ORCH agent is missing and its recorded `session_path` is absolute, canonical, and an existing file, `startOrchestrator` MAY recreate a missing anchor tab or pane only inside the still-live, identity-matching workspace. It MUST reuse the deterministic anchor label, accept only a surviving tab whose other pane is a verified Herdr Sidebar, update run and target tab/pane coordinates in one atomic registry write, and report the old/new coordinates. A live recorded agent, missing workspace, wrong workspace identity, ambiguous topology, or ordinary worker workspace reconciliation MUST retain the strict non-recreation behavior.
- **REV-003**: `rebirth` MUST create generation+1 only when all of: a human-owned `rebirth-approval.json` names exactly the next generation and acknowledges the context loss; the run's mandate and `plan.md` are non-empty and canonical; no assignment is `ambiguous`; and the previous ORCH agent is not live.
- **REV-004**: Session retirement MUST drop only the recorded session identity and MUST preserve workspace, anchor tab, pane, agent name, instruction path, and launch profile; no public operation MUST close the retained workspace or kill a running session.
- **REV-005**: A rebirth birth record MUST carry `origin: "rebirth"` and the approval's SHA-256, and MUST NOT exist at generation 1.
- **REV-006**: The approval gate MUST be documented as a contents check, never an authorship proof: the guarantee is attributability through the artifact, the generation record, and the ledger.
- **REV-007**: A parked run MUST remain revivable, and revival MUST re-apply the budget marker and record the revival in the ledger. A reborn generation MUST remain inside the run's metered aggregate.

## 6. Documents, control, and observation

- **COM-001**: Documents MUST carry contracts, ownership, user boundaries, decisions, durable results, completion, verification, reset lineage, budget trail, and handoff.
- **COM-002**: MCP prompt/control MUST carry canonical coordinates and hashes, waits, lifecycle actions, budget justification, and revival.
- **COM-003**: Herdr metadata MUST carry display-only responsibility, assignment, assignment state, bootstrap identity, and live observation.
- **COM-004**: Herdr metadata, terminal output, public settlement/staleness/total observations, and advisory ownership observations MUST NOT be treated as contract, judgment, settlement, attribution, or session authority by themselves.
- **COM-005**: Observation metadata source MUST be `herdr-delegator:observation` and tokens MUST be limited to `responsibility`, `assignment`, and `assignment-state`.
- **COM-006**: Observation reporting MUST NOT overwrite Herdr semantic agent state.
- **COM-007**: Workers MUST append only to their own reports; ORCH decisions and acceptance SHOULD use `[ORCH Response]` blocks.
- **COM-008**: Peer files MAY carry existing artifact, readiness, dependency, quiet-window, reproduction, and interface facts; ORCH alone changes scope, ownership, priority, approval, or completion conditions.

### 6.1 Settlement observability

- **OBS-001**: An applicable assignment record MAY persist `prompted_at` as an ISO-8601 tool timestamp of at most 64 characters captured immediately before prompt, and a terminal assignment MAY persist `elapsed_ms` as the nonnegative safe-integer difference between the tool settlement timestamp and `prompted_at`; `elapsed_ms` MUST be absent when that boundary cannot be proved.
- **OBS-002**: A terminal assignment MAY persist `token_usage` as a cumulative canonical OMP session-JSONL snapshot with fixed `source: "omp-jsonl"`, verified `session_id` of 1–256 characters, ISO-8601 tool `observed_at` of at most 64 characters, and at least one of optional `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, or `total_tokens`, each a nonnegative safe integer. The snapshot MUST NOT claim per-assignment attribution.
- **OBS-003**: A terminal assignment MAY persist `advisory_unowned_changes` with exact fields `advisory: true`, `paths`, and `truncated`; `paths` MUST be sorted project-relative paths outside the union of declared ownership for active or settling assignments, limited to 64 entries of 1–1,024 UTF-8 bytes each, and `truncated` MUST report exclusion by the entry-count or entry-length bound.
- **OBS-004**: The unowned-change audit MUST run as a best-effort, fail-open `git status --porcelain=v1 -z --untracked-files=normal` observation with optional locks and terminal prompts disabled, a 2,000 ms abort boundary, a 128 KiB output acceptance bound, and both source and destination paths checked for renames and copies. Any non-git directory, command error, timeout, malformed or ambiguous output, unsafe path, or ownership-artifact error MUST omit the observation without blocking settlement or changing terminal state, and the audit MUST NOT attribute a path to any worker.
- **OBS-005**: Lifecycle state MAY persist `last_activity_revision` as a nonnegative safe integer and `last_activity_at` as the at-most-64-character ISO-8601 tool timestamp when the current pane revision was first observed. Strict compatibility parsing MAY accept `last_output_sha256` and at-most-64-character `last_output_at`, but current public observations MUST NOT emit or expose those compatibility fields.
- **OBS-006**: A terminal `herdr_assignment` result MAY expose `assignment.settlement` containing optional `elapsed_ms`, `token_usage`, and `advisory_unowned_changes` with the same meanings and bounds as the persisted fields; nonterminal assignment results MUST NOT expose settlement actuals.
- **OBS-007**: `herdr_worker inspect` MAY expose `data.observation.staleness` with at-most-64-character ISO-8601 `observed_at` and `last_activity_at` plus `queue_depth`, the exact nonnegative safe-integer count of `queued_assignment_ids` excluding the active assignment.
- **OBS-008**: `herdr_track inspect` MUST expose `data.totals` with nonnegative safe-integer `lane_count`; `assignments_by_state` exact counts for all seven ASN-024 states; nonnegative safe-integer `settled_elapsed_ms` and `settled_elapsed_observations`; `settled_token_usage.observations`; nonnegative safe-integer cumulative `settled_token_usage.input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, and `total_tokens`; and boolean `saturated`.
- **OBS-009**: Track elapsed and token cumulatives MUST clamp to `Number.MAX_SAFE_INTEGER` when an addition would overflow; `saturated` MUST become `true` when such clamping occurs.
- **OBS-010**: Persisted canonical OMP JSONL MUST be the only token-usage authority and tool-owned prompt/settlement/activity timestamps MUST be the only elapsed/staleness time authority. Public settlement, staleness, totals, and unowned-change observations are bounded advisory views for ORCH judgment, not mutation, attribution, correctness, or budget authority.
- **OBS-011**: Settlement observability MUST add no public action or assignment state; the state vocabulary remains exactly the seven ASN-024 values.
- **OBS-012**: Phase 1 settlement observability MUST define no enforcement, budget or staleness threshold, hook, resident monitor, budget configuration key, or money unit.

## 7. Model, session, workspace, and focus safety

- **MOD-001**: Before prompt, bridge facts and Herdr bootstrap metadata MUST exact-match official session and pane identity, any reported official session path, the session and attestation tokens, nonce, and freshness; provider, model, and thinking MUST NOT participate in either pre-prompt verifier.
- **MOD-002**: After the first prompt boundary, canonical OMP JSONL MUST exact-match session, provider/model, thinking, and fallback before success or later resume.
- **MOD-003**: A bootstrap-reported path MAY precede JSONL creation and MUST NOT become resume authority until persisted verification succeeds.
- **MOD-004**: A synthetic prompt MUST NOT be sent solely to create JSONL.
- **MOD-005**: Missing, stale, unsafe, corrupt, mismatched, concurrently resumed, known-duplicate, or credibly duplicate session evidence MUST fail closed.
- **MOD-006**: A model MUST NOT supply a session path or resume argument.
- **MOD-007**: A spawn MUST NOT transport a model resolved by the caller. The `default` role MUST be spawned with no model argument, so the child resolves the user's configured default itself; every other configured role MUST be passed as an unresolved alias, so the child expands it against its own persisted settings layers. A thinking level MUST be passed only when the delegator profile states an explicit non-`inherit` opinion; otherwise the role's own suffix governs in the child. Rationale: a model override is process-local, so a caller cannot resolve a role on a child's behalf without substituting its own launch identity for the user's configuration (friction 221abf10d2280b47). Consequently the caller holds no expected model, and a child's reported provider/model/thinking MUST be recorded as an observation rather than compared against a caller prediction; `expected_provider`, `expected_model`, and `effective_thinking` on a record are that observation and MUST be absent until the child reports. This MUST NOT relax either verification gate: MOD-001 remains identity-only before prompt, while MOD-002 independently verifies the child's persisted session/provider/model/thinking/fallback after prompt. What is deliberately given up: a role's resolution is no longer knowable before the child reports, so a misconfigured role surfaces as an observed model rather than a pre-spawn refusal, and the silent-fallback warning — which required resolving roles in the caller — no longer exists.
- **OWN-001**: One deterministic run workspace MUST contain a retained anchor and one registry-owned tab per worker lane.
- **OWN-002**: Labels are hints; stable IDs, canonical `cwd`, registry binding, agent identity, and session evidence establish ownership.
- **OWN-003**: Focus restoration MUST reverse only displacement onto registry-owned coordinates and MUST preserve unrelated current user focus.
- **OWN-004**: `focus_restoration: partial` MUST be a warning, not proof that the main operation failed.
- **OWN-005**: Safe worker close MUST allow only the exact registry root pane plus structurally verified Herdr Sidebar panes.
- **OWN-006**: A verified Sidebar MUST share workspace/tab/canonical `cwd`, have exact label `Sidebar`, expose no non-null agent/session evidence, and have non-empty tokens whose keys begin `herdr-sidebar-`.
- **OWN-007**: No public operation MAY close the retained run workspace.

## 8. Ambiguous effects, recovery, and closure

- **LIFE-001**: A wait timeout MUST be treated as a no-effect observation returned as a successful `timed_out` result; a mutating timeout MAY have taken effect.
- **LIFE-002**: Prompt, response, resume, target start, or close uncertainty MUST be inspected before retry.
- **LIFE-003**: Recovery MUST verify routing, operation fingerprint, state sequence, report, official session, workspace/tab/pane ownership, and topology as applicable.
- **LIFE-004**: Recovery MAY continue from a proved effect or retry from proved absence; unresolved ambiguity MUST preserve every coordinate and prohibit replay.
- **LIFE-005**: A response that initially returns an ambiguous transport result MAY be accepted only after fresh inspection proves the sequence advanced and the assignment reached the expected boundary.
- **LIFE-006**: ORCH MUST resolve or escalate blocked state and reconcile ambiguity before lane or track closure.
- **LIFE-007**: Material worker claims MUST be independently reproduced before acceptance.
- **LIFE-008**: A reset copies planning context, not truth; inherited evidence MUST be revalidated.
- **LIFE-009**: Handoff MUST preserve responsibility routing, assignment ledger, official sessions/models, reset lineage, active source lanes, blocked/ambiguous operations, focus warnings, and review status.
- **LIFE-010**: The target ORCH MUST use the configured role and its own exact official persisted session; it MUST NOT resume source ORCH context.

### 8.1 Messages

- **WAKE-001**: A message is one bounded server-composed doorbell naming only a boundary fact and a report, channel, or run; it MUST NOT carry contract, settlement, judgment, instruction, or identity authority.
- **WAKE-002**: Workers SHOULD send exactly one `wake_orch` after a completion block or a decision request; the dispatch prompt MUST direct them to it.
- **WAKE-003**: A peer wake MUST be sent only over a plan-authorized directional channel and only by its declared sender; a receiver MUST act on the named file, never on message text.
- **WAKE-004**: On message receipt, settlement and state MUST still be established only through guarded tool actions; a missing, failed, or rejected message MUST NOT block settlement or recovery.
- **WAKE-005**: Orchestrator-to-orchestrator communication MUST be an append to the sender-owned inter-run channel document followed by a payload-free `notify_run`; the entry structure carries the kind (`fact`, `bottleneck`, `request`, `handoff`) and the note. The counterpart MUST answer in its own reverse channel, and both sides MUST record anything durable in their own run documents.
- **WAKE-006**: Resource contention between runs MUST be negotiated in those channel documents with each side recording the agreement it accepted; on failed negotiation both sides MUST stop and raise decision requests to their own users. Server-side enforcement of an inter-run contract is a named non-goal.

## 9. Routing and user boundaries

- **RTE-001**: ORCH MUST retain decomposition, responsibility naming, scope, priority, approval, completion contracts, integration, and final judgment.
- **RTE-002**: Bounded mechanical work SHOULD use host OMP task/subagents and MUST NOT create Herdr delegation state.
- **RTE-003**: Substantial independent work requiring persistence, explicit ownership, exact-session resume, blocked handling, or durable routing SHOULD use responsibility workers.
- **RTE-004**: Host task/subagent model choice remains outside this plugin's selection and verification contract.
- **RTE-005**: Parallel workers MUST have disjoint write ownership; overlapping shared-`cwd` edits MUST be serialized.
- **RTE-006**: Workers MUST self-resolve from their assignment, plan, canonical project documents/settings, and code before requesting judgment.
- **RTE-007**: ORCH MUST escalate only plan-marked user decisions, irreversible external actions, shared governance, secrets/account access, or judgment only the user can supply.
- **RTE-008**: Assignment completion MUST leave the responsibility worker idle and available for follow-up work unless ORCH separately closes the lane or track.
- **RTE-009**: By default, after drafting `plan.md` with the user and before freezing it, ORCH MUST dispatch a slow-profile lane charged to adversarially review the draft for omissions, unstated assumptions, and vulnerabilities; it MUST answer and disposition evidence-cited findings until a round has no blocking findings or ORCH records acceptance with grounds, and `plan.md` MUST record the review lane and dispositions. Items requiring user authority MUST continue through RTE-007, while a trivially fixed plan MAY skip review when `plan.md` records that proportionality judgment. The adversarial charge is repository-owned, while the review's reasoning depth follows the installation's role mapping for the `slow` profile.

## 10. Security and privacy

- **SEC-001**: Mutation MUST fail closed when identity, authority, model, session, ownership, topology, or effect cannot be proved.
- **SEC-002**: Storage and registry mutations MUST be atomic and lock-guarded.
- **SEC-003**: Errors and live output returned to the model MUST be bounded.
- **SEC-004**: Plans, assignments, reports, evidence, peer channels, examples, and tool responses MUST NOT contain secrets, authentication material, private keys, personal data, or unnecessary private-source excerpts.
- **SEC-005**: This plugin MUST NOT be represented as a secret store, redaction layer, sandbox, authorization system, or data-loss-prevention system.
- **SEC-006**: Secrets or account access MUST be escalated to the user rather than requested through worker reports, doorbells, or any budget or revival artifact.
- **SEC-007**: Public documentation and package metadata MUST remain product-neutral, English-only, and free of local machine paths.

## 11. Installation and packaging

- **PKG-001**: Root `plugin.json` MUST conform to Agent Plugins 1.0.0, identify `herdr-delegator` version 3.4.0, and contain client-specific OMP data only under `extensions.io.github.edgar-min.herdr-delegator`.
- **PKG-002**: Root `mcp.json` MUST conform to Agent Plugins 1.0.0 and advertise one `herdr-delegator` stdio server that survives a stripped spawn environment: command `sh` with args `["-c", "exec \"${PLUGIN_ROOT:-.}/bin/herdr-delegator-mcp\""]` and an env carrying a guaranteed baseline `PATH` (`/usr/bin:/bin`); `.mcp.json` MUST NOT exist. (friction 9072a9da598edd89)
- **PKG-003**: Agent Plugins portable authority MUST remain `plugin.json`, `skills/`, and `mcp.json`. `package.json` MUST remain npm/current-OMP compatibility metadata with version 3.4.0, direct runtime dependencies, and only the namespaced `omp.extensions` entry.
- **PKG-004**: The publish allowlist MUST include `plugin.json`, `mcp.json`, executable `bin/herdr-delegator-mcp`, `io.github.edgar-min.herdr-delegator/**/*.ts`, `mcp/**/*.ts`, the bundled skill, schemas/examples, README, CHANGELOG, LICENSE, and docs.
- **PKG-005**: README prerequisites MUST require OMP, Herdr, Bun, and `herdr integration install omp`, and MUST document GitHub installation plus local development linking. The POSIX launcher MUST first prepend `${HOME}/.local/bin`, `${HOME}/.bun/bin`, and `/usr/local/bin` to `PATH` (so its own Bun lookup and the server's Herdr binary discovery survive a stripped spawn environment), resolve Bun only from `PATH`, `${BUN_INSTALL}/bin/bun`, or `${HOME}/.bun/bin/bun`, emit no stdout, and exit 127 with one stderr error when Bun is unavailable.
- **PKG-006**: `/reload-plugins` MUST be documented as the skill/MCP reload boundary; changed OMP extension cutover MUST be verified in a new OMP session.

## 12. Module architecture

- **ARC-001**: `io.github.edgar-min.herdr-delegator/extensions/herdr-delegator.ts` MUST remain a bridge-only entry and MUST NOT register public MCP tools.
- **ARC-002**: `io.github.edgar-min.herdr-delegator/extensions/lib/bridge.ts` MUST own OMP fact publication and bootstrap metadata reporting.
- **ARC-003**: `mcp/server.ts` MUST own stdio transport and exactly five public registrations.
- **ARC-004**: `mcp/contracts.ts` MUST own strict public schemas and bounded shared MCP contracts.
- **ARC-005**: `mcp/herdr-adapter.ts` MUST expose fixed, bounded Herdr operations and MUST NOT accept raw public argv.
- **ARC-006**: `mcp/registry.ts` MUST own immutable assignment parsing, responsibility routing, FIFO lane state, and minimal delegation registry.
- **ARC-007**: `mcp/tools.ts` MUST own composite track, assignment, and worker transactions and consume internal lifecycle authority without exposing it as another public surface.
- **ARC-008**: Existing configuration, runtime, worker, and track lifecycle modules MAY remain internal implementation dependencies; their old operations MUST NOT appear as public tools.
- **ARC-009**: `io.github.edgar-min.herdr-delegator/extensions/lib/guidance.ts` MUST own guidance-document rendering and materialization, and MUST expose no throwing path to a spawn caller.
- **ARC-010**: `scripts/check-templates.ts` MUST fail the repository check when an installed protocol template's digest is absent from its own shipped-digest allowlist, or when a list is unsorted or duplicated.

## 13. Observable acceptance scenarios

- **ACC-001 — Clean initialization**: `herdr_track init` derives deterministic storage, creates the byte-identical three-document bundled protocol set plus only owned initialization artifacts, and creates no worker or placeholder work artifact.
- **ACC-002 — Five-tool boundary**: MCP initialization lists exactly `herdr_track`, `herdr_assignment`, `herdr_worker`, `herdr_message`, and `herdr_friction`; the extension registers none of them.
- **ACC-003 — Exact responsibility reuse**: Two sequential assignments with the same responsibility route to the same worker ID, workspace, tab, root pane, and official OMP session.
- **ACC-004 — Context retention**: The second reused assignment can report a nonce or fact established only by the first assignment in that same official session.
- **ACC-005 — Busy-lane FIFO**: A second same-responsibility assignment queues while the lane is active and does not create another worker.
- **ACC-006 — Simple separation**: A second lane is created only with one valid separation kind, short reason, and existing conflicting worker.
- **ACC-007 — Immutable assignment**: Hash mismatch, malformed Markdown, unsafe file identity, or duplicate ID/content conflict fails before prompt.
- **ACC-008 — Seven states**: Persisted and public assignment observations use only the seven states in ASN-024.
- **ACC-009 — Answer without a response action**: An `[ORCH Response]` append plus `wake_worker` reaches an idle worker and an input-waiting one alike; no response tool action exists to reject a stale sequence.
- **ACC-010 — Budget cadence**: Crossing the cap parks the run with a named reason, ledger entry, and pane marker; `add` is refused while `wait` and `close` still land work; the clamp is scaffolded without overwrite and every park/deny surface names `{version:1, max_tokens?, max_minutes?, note?}`; an extension's verdict is recorded server-side before the cap moves; a `notify` grant lands the approved ceiling in the clamp file unless the value there is the human's, in which case the registry alone moves and the park routes to the human; a deny routes to the user and is not re-auditable until the clamp changes.
- **ACC-010a — Revival**: A resume reconnects the recorded birth session with no new generation and may recreate only a dead anchor inside a live identity-matching workspace when the agent is gone and recorded session path is grounded; a live agent or dead/mismatched workspace keeps strict behavior. A rebirth is refused without the user's approval file, sufficient documents, an ambiguity-free run, and a non-live ORCH.
- **ACC-010b — Template compatibility**: A run materialized from a previously shipped protocol set still reconciles and still revives, with a named drift warning; the repository check fails when an installed template's digest is missing from its allowlist.
- **ACC-010c — Guidance delivery**: An `open` or revival on configured profile criteria and orch routes produces config-only `guidance.md`; dispatch materializes and points to `guidance-<profile>.md` only for a profile with a directive or route. Empty route sets omit sections, absent profile intent renders an em dash, missing lane content yields no lane document, a missing skill is a reader-side no-op resolved through `skill://`, and render/write failures preserve birth or dispatch through the documented degraded surface.
- **ACC-010d — Degraded fresh open**: A fresh `open` under `omp_fact_bridge_mismatch` records the degraded creator union member with no session ID and still births the ORCH; the same outage against an existing run fails closed, and a later attested same-pane retry upgrades without any verified-to-degraded transition.
- **ACC-010e — Focus-polite doorbell**: A focused target returns `deferred` promptly, sends once after the 60-second re-probe and optional 90-second tail, and writes scheduled/final `messages.jsonl` rows with one delivery ID; an unfocused or unprobeable target sends immediately.
- **ACC-011 — Completion retention**: A verified completion block stores report hash, returns the lane to idle, records last completion, and leaves the worker tab/session open.
- **ACC-012 — Exact resume**: Resume succeeds only for the registry-bound, persisted-verified, non-duplicated official session.
- **ACC-013 — Sidebar-aware close**: A settled lane closes only with the registry root pane and verified Sidebar auxiliaries; mixed or unproved topology fails closed.
- **ACC-014 — Shared-directory safety**: Concurrent workers have disjoint ownership or overlapping edits are serialized.
- **ACC-015 — OMP-only package**: Published package discovery provides the bridge, stdio MCP, skill, and direct runtime dependencies without another runtime adapter.

## 14. Known non-goals

- **NG-001**: Support for agent runtimes other than OMP.
- **NG-002**: General-purpose process, terminal, workspace, pane, or tab management.
- **NG-003**: Automatic decomposition, responsibility scoring, prioritization, approval, or user-judgment replacement.
- **NG-004**: Selecting or verifying models used by host task/subagents.
- **NG-005**: Concurrent-write isolation for a shared project directory.
- **NG-006**: Closing the retained Herdr workspace.
- **NG-007**: Treating metadata, terminal text, labels, or reports as sufficient ownership or correctness proof.
- **NG-008**: Automatically trusting evidence from a source reset run.
- **NG-009**: Secret management, credential transport, redaction, privacy classification, or sandboxing.
- **NG-010**: Guessing through malformed state, manually repairing registries, or bypassing conflicts with replacement identities.
- **NG-011**: Money units and precise cost accounting. Budget itself is in scope (section 5.6): the machine meters conservatively, parks explicitly, and demands justification, but it never claims an exact spend figure or a currency amount.
- **NG-012**: Server-enforced inter-run contracts, including file-boundary validation across runs. Contention is a contract pattern between orchestrators, recorded in both channel documents and arbitrated by the users.
- **NG-013**: Preventing a budget-parked ORCH from opening a *different* track with a fresh seed. The escape is deliberately named rather than closed: the opener becomes that track's retired creator, so it gains no command there, and the new space and ORCH pane are loud on the supervision surface. Cross-track budget aggregation sits with the deferred items, not with the guarantees.
- **NG-014**: Proving who authored a human-owned file. The clamp, rebirth-approval, and close-approval gates check contents, not authorship — the guarantee is attributability through durable artifacts, never prevention.

## Review checklist

### Implemented facts to verify against source

- [ ] Agent Plugins `plugin.json`, Agent Skills frontmatter, package metadata, and skill metadata identify version 3.4.0.
- [ ] `mcp/server.ts` registers exactly `herdr_track`, `herdr_assignment`, `herdr_worker`, `herdr_message`, and `herdr_friction`; the namespaced OMP extension is bridge-only and registers no command.
- [ ] Every action and field matches the discriminated schemas in `mcp/contracts.ts`.
- [ ] Assignment Markdown grammar, hash verification, report settlement, and the seven-state union match `mcp/registry.ts`.
- [ ] Exact responsibility reuse, one active assignment, FIFO queueing, ordinal reservation, and simple separation match routing source.
- [ ] Bridge fact derivation, exact identity-only fact fields, exact session/attestation pane tokens, and both pre-prompt identity verifiers match bridge, runtime, and MCP source.
- [ ] MOD-001 preserves identity-only pre-prompt attestation; MOD-002 independently preserves exact post-prompt JSONL session/provider/model/thinking/fallback verification.
- [ ] Prompt/resume ambiguity prohibits replay and converges on the single public `ambiguous` state.
- [ ] Root `plugin.json`/`mcp.json`, executable plugin-relative launcher, namespaced extension path, publish allowlist, and direct runtime dependencies match Agent Plugins and compatibility metadata.
- [ ] Documents, MCP control, and Herdr observation carry only their assigned authority.
- [ ] Public artifacts contain no local machine path, secret, product dependency outside OMP/Herdr, or implementation history.
- [ ] Persisted `prompted_at`, `elapsed_ms`, `token_usage`, `advisory_unowned_changes`, lifecycle activity fields, and compatibility parsing match registry and lifecycle source bounds.
- [ ] Public `assignment.settlement`, worker `staleness`, and track `totals` fields match `mcp/contracts.ts` and `mcp/tools.ts`, including overflow-triggered saturation.
- [ ] The ownership audit command, 2-second/128-KiB/64-path bounds, fail-open behavior, and no-attribution contract match source.
- [ ] Same-name-only profile inheritance, the first-definition `role` requirement, and the bounded `guidance`/`intent`/`directive`/skill-metadata/rule fields match `extensions/lib/config.ts` and `config.schema.json`.
- [ ] Config-only ORCH/lane guidance rendering, partial absence, degrade paths, the `skill://` pointer, and profile-filtered dispatch delivery match `extensions/lib/guidance.ts`, `extensions/lib/config.ts`, and `mcp/tools.ts`.
- [ ] Every schema `describe` text states its constants as facts and carries the judgment criterion for the field it documents (JDG-001).

### Live behavior to verify

- [ ] Sequential exact-responsibility assignments reuse the same worker ID, workspace/tab/pane, official session, and retained context.
- [ ] A busy matching lane queues FIFO instead of creating a worker.
- [ ] A new lane requires `direction`, `ownership`, or `dependency` plus a short reason and conflicting worker.
- [ ] A blocked or decision-requesting worker is answered by an `[ORCH Response]` append plus `wake_worker`, and the wake reaches it as pane input.
- [ ] `notify_run` is refused without its channel document, and a worker lane cannot send one; a focused valid target defers on the 60s/90s plan with two journal rows, while an unfocused or unprobeable target sends immediately.
- [ ] Crossing the budget cap parks the run with a named reason, ledger entry, and pane marker; `wait`/`close` still land work, `add`/`resume` are refused, the clamp exists without overwrite, every park/deny surface names its exact schema, and the run resumes by itself once under the ceiling.
- [ ] An extension's verdict is recorded server-side before the cap moves; a failed or silent audit parks and never grants; a `notify` grant writes the approved `max_tokens` into the clamp and records both the intended and the confirmed value, while a human-valued `max_tokens` is left untouched, parks `approval-required` on the token axis, refuses `budget_extend` outside the wall-clock exception, and is named in the auditor's input document; a deny is not re-auditable until the human edits the clamp file.
- [ ] A resume reconnects the recorded birth session with no new generation; a dead anchor is recreated only for a missing ORCH agent with a grounded session path inside a live identity-matching workspace; a rebirth without approval, documents, an ambiguity-free run, or a dead ORCH is refused.
- [ ] A run created from a previously shipped protocol set still reconciles, still revives, and reports a named drift warning.
- [ ] Completion stores the report hash, returns the lane to idle, promotes FIFO, and retains the tab/session.
- [ ] Track and worker close refuse active, blocked, ambiguous, stale-session, stale-sequence, or unsafe-topology state.
- [ ] Terminal assignment results expose bounded settlement actuals without changing settlement prerequisites or the seven assignment states.
- [ ] Worker staleness and track totals remain advisory observations; audit failure never blocks settlement.

### Reviewer decisions to approve or request changes

- [ ] Approve OMP-only scope and refusal to predesign another runtime adapter.
- [ ] Approve the three-tool composite MCP boundary and bridge-only extension.
- [ ] Approve built-in orchestrator role `@default`, with a planning-grade role such as `@plan` and elevated thinking recommended for judgment-intensive orchestration.
- [ ] Approve built-in worker profiles `default`, `task`, and `slow`, all safely resolving through `@default` unless configured otherwise, with small mechanical work routed to host OMP task/subagents.
- [ ] Approve Phase 1 actuals as observation-only, with no enforcement, thresholds, hooks, monitor, budget configuration, or money units.
- [ ] Approve persistent responsibility reuse, no fixed lane ceiling, and simple separation without scoring.
- [ ] Approve one immutable assignment Markdown and report-hash settlement without contract/receipt sidecars.
- [ ] Approve exactly seven assignment states and observe-before-retry ambiguity handling.
- [ ] Approve the document/control/observation authority split.
- [ ] Approve assignment completion without worker closure.
- [ ] Approve exact-session resume, guarded focus restoration, Sidebar-safe close, and retained workspace.
- [ ] Approve host task/subagents for bounded mechanical work and serialized overlapping worker edits.
- [ ] Approve sibling reset evidence revalidation and configuration-selected target ORCH.
- [ ] Approve no-secret/public-artifact boundaries and explicit non-goals.

### Markdown and schema artifacts to approve

- [ ] [`README.md`](../README.md): package, installation, responsibility routing, MCP surface, lifecycle, and safety.
- [ ] [`docs/ARCHITECTURE.md`](ARCHITECTURE.md): process boundary, authority, assignment state, recovery, and trust boundaries.
- [ ] `docs/SPEC.md`: unique normative IDs, current actions, acceptance scenarios, non-goals, and this checklist.
- [ ] [`skills/herdr-delegation/SKILL.md`](../skills/herdr-delegation/SKILL.md): ORCH procedure and public contract.
- [ ] [`skills/herdr-delegation/templates/protocol.md`](../skills/herdr-delegation/templates/protocol.md), [`protocol-orch.md`](../skills/herdr-delegation/templates/protocol-orch.md), and [`protocol-worker.md`](../skills/herdr-delegation/templates/protocol-worker.md): deployed role-scoped run protocol set.
- [ ] [`skills/herdr-delegation/templates/handoff.md`](../skills/herdr-delegation/templates/handoff.md): responsibility and assignment handoff.
- [ ] [`config.schema.json`](../config.schema.json), [`run.schema.json`](../run.schema.json), and [`reset.schema.json`](../reset.schema.json): strict public data contracts.
- [ ] [`LICENSE`](../LICENSE): canonical Apache License 2.0 text and copyright notice.
