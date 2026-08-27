# Herdr Delegator Specification

## Status and language

This document is the normative architecture and Markdown review artifact for `herdr-delegator` 1.0.0 and the bundled `herdr-delegation` skill 1.0.0.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are interpreted as described by RFC 2119.

Statements under **Implemented facts** describe the current source contract. Statements under **Reviewer decisions** identify architecture or documentation choices requiring approval; they are not claims of missing implementation.

## 1. Identity, scope, and versions

- **ID-001**: The public package and OMP plugin name MUST be `herdr-delegator`.
- **ID-002**: The package and plugin version MUST be `1.0.0`.
- **ID-003**: The public skill MUST be named `herdr-delegation` and versioned `1.0.0` under frontmatter metadata.
- **ID-004**: The public MCP tools MUST be exactly `herdr_track`, `herdr_assignment`, and `herdr_worker`.
- **ID-005**: OMP MUST be the only officially supported agent runtime.
- **ID-006**: The repository identity MUST be `https://github.com/edgar-min/herdr-delegator`.
- **ID-007**: The license MUST be Apache-2.0 with copyright 2026 Jisung Min.
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
- **CFG-005**: Later layers MUST override earlier leaves. A new worker profile MUST inherit unspecified leaves from the resolved `default` profile.
- **CFG-006**: At least the user or project layer MUST set an absolute `storage.root`; no temporary or project-directory fallback is allowed.
- **CFG-007**: A run layer MUST NOT relocate its own storage root.
- **CFG-008**: Every consumed configuration layer MUST be recorded by canonical path, scope, and SHA-256.
- **CFG-009**: Configuration MUST use version 1, reject unknown keys, and fail closed when unreadable or malformed.

### 2.2 Roles and bridge facts

- **CFG-010**: The built-in orchestrator profile MUST select role `@default` with thinking `inherit`; configuration MAY select another bounded OMP role alias.
- **CFG-011**: Built-in worker profiles MUST be `default` → `@default` and `slow` → `@slow`, both with thinking `inherit`.
- **CFG-012**: Profile names MUST match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- **CFG-013**: Role aliases MUST match `^@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- **CFG-014**: Configured thinking MUST be one of `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `auto`.
- **CFG-015**: Configuration MUST contain role aliases, never concrete model IDs.
- **CFG-016**: The OMP extension MUST be bridge-only and MUST NOT register public delegation tools.
- **CFG-017**: The bridge MUST refresh current session/model/thinking and configured role resolutions on session start, session switch, and before agent start.
- **CFG-018**: Bridge facts MUST be written atomically to an owner-only, session-scoped file under the active OMP agent directory; callers MUST NOT supply that file path.
- **CFG-019**: MCP MUST derive the bridge coordinate from the verified caller pane and official OMP session, then verify ownership, non-symlink type, restrictive modes, strict schema, freshness, nonce, pane/session correspondence, and bootstrap metadata equality.
- **CFG-020**: [`config.schema.json`](../config.schema.json) and [`config.example.json`](../config.example.json) MUST remain the public configuration schema and built-in profile example.

## 3. Deterministic storage and authority

- **STO-001**: The canonical run path MUST be `<storage.root>/<track_id>/<run_id>` and MUST be derived rather than accepted from callers.
- **STO-002**: Canonical directory identity MUST be verified; symlink and path conflicts MUST fail closed.
- **STO-003**: `run.json` MUST conform to [`run.schema.json`](../run.schema.json), bind run coordinates to canonical `cwd` and `run_path`, and reject unknown fields.
- **STO-004**: `herdr_track {action:"init"}` MUST create or exactly reconcile only the run manifest, bundled protocol, `a2a/`, storage index row, and reset artifacts when requested.
- **STO-005**: Initialization MUST NOT create placeholder plans, assignments, reports, evidence, registries, workspaces, tabs, panes, or OMP sessions.
- **STO-006**: Existing `protocol.md` MUST be byte-identical to the bundled template.
- **STO-007**: `<storage.root>/index.json` MUST be strict version 1, atomic, lock-guarded, and consistent with the run manifest.
- **STO-008**: `a2a/herdr-workers.json` version 3 MUST remain lifecycle identity authority; `a2a/delegation.json` version 1 MUST remain responsibility and assignment routing authority.
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

- **TOOL-001**: The public surface MUST contain exactly the three tools named in ID-004; raw Herdr management MUST NOT be public.
- **TOOL-002**: Every input MUST be a strict action-discriminated object and reject extra or action-inappropriate fields.
- **TOOL-003**: Every action MUST include `track_id` and `run_id`.
- **TOOL-004**: Where a `wait` object is accepted, `timeout_ms` MUST be an integer from 1,000 through 300,000 and default to 120,000; `until` values MUST be drawn from `idle`, `done`, and `blocked`.
- **TOOL-005**: Results MUST include `ok`, `tool`, `action`, `run`, `effect`, and `retryable`, plus bounded registry, worker, assignment, data, or error fields as applicable.
- **TOOL-006**: Effect MUST be `none`, `confirmed`, or `ambiguous`.
- **TOOL-007**: Structured errors MUST include code, phase, bounded message, recovery guidance, and `ambiguous_effect`.
- **TOOL-008**: An ambiguous effect MUST never be advertised as blindly retryable.
- **TOOL-009**: Callers MUST NOT provide arbitrary run, assignment, report, session, pane, tab, workspace, executable, argv, or command coordinates.

### 5.2 `herdr_track`

- **RUN-001**: `init` MUST accept `cwd` and optional `reset_of`; `cwd` MUST be an existing absolute canonical project path.
- **RUN-002**: `inspect` MUST accept no action-specific fields and return bounded delegation registry and target-ORCH observation, reporting unavailable bridge-dependent observation without mutating.
- **RUN-003**: `start_orchestrator` MUST accept no action-specific fields and MUST derive canonical plan and orchestrator instruction coordinates.
- **RUN-004**: `start_orchestrator` MUST resolve the configured OMP orchestrator role through bridge facts, pin the child to concrete provider/model/thinking, verify bootstrap attestation, and preserve prompt no-replay evidence.
- **RUN-005**: `close` MUST require a fresh nonnegative `expected_registry_revision`.
- **RUN-006**: Track close MUST fresh-inspect and session-verify every idle candidate before mutation and MUST reject the entire close when any lane is active, blocked, ambiguous, identity-conflicted, or unsafe.
- **RUN-007**: A sibling reset MUST use a different coordinate under the same storage root, copy the source plan, and record `close-settled-preserve-active` plus `revalidate-before-import`.

### 5.3 `herdr_assignment`

- **ASN-015**: `add` MUST require `assignment_id`, `responsibility_key`, and `instructions_sha256`; it MAY accept `separation` and `wait`.
- **ASN-016**: `add` MUST verify the immutable artifact before routing, select exact responsibility reuse or valid separation, ensure session/model identity, record prompt intent, send only a canonical pointer, wait to a natural boundary, and verify persisted identity after prompt.
- **ASN-017**: A duplicate identical assignment MUST return a no-effect observation; a queued assignment MUST remain queued without lifecycle wait.
- **ASN-018**: `wait` MUST require only `assignment_id` plus optional `wait`; a timeout MUST have no mutation effect.
- **ASN-019**: `respond` MUST require `assignment_id`, a fresh nonnegative `expected_state_change_seq`, and one strict response.
- **ASN-020**: A text response MUST contain 1–8,000 characters. A key response MUST contain 1–32 values drawn only from `enter`, `esc`, `up`, `down`, `left`, `right`, `tab`, `shift+tab`, `y`, and `n`.
- **ASN-021**: `respond` MUST fresh-inspect the bound lane, require state `blocked`, and reject a stale sequence before sending input.
- **ASN-022**: Text MUST be used only for free-form input; allowlisted keys MUST be used only for an inspected interactive surface.
- **ASN-023**: A prompt, response, or active-assignment resume whose effect cannot be proved MUST converge on assignment state `ambiguous` with bounded replay facts.
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
- **WRK-008**: Assignment delivery and blocked response MUST be available only through `herdr_assignment`, not worker lifecycle actions.

## 6. Documents, control, and observation

- **COM-001**: Documents MUST carry contracts, ownership, user boundaries, decisions, durable results, completion, verification, reset lineage, and handoff.
- **COM-002**: MCP prompt/control MUST carry canonical coordinates and hashes, waits, bounded blocked responses, resume, and close.
- **COM-003**: Herdr metadata MUST carry display-only responsibility, assignment, assignment state, bootstrap identity, and live observation.
- **COM-004**: Herdr metadata and terminal output MUST NOT be treated as contract, judgment, settlement, or session authority by themselves.
- **COM-005**: Observation metadata source MUST be `herdr-delegator:observation` and tokens MUST be limited to `responsibility`, `assignment`, and `assignment-state`.
- **COM-006**: Observation reporting MUST NOT overwrite Herdr semantic agent state.
- **COM-007**: Workers MUST append only to their own reports; ORCH decisions and acceptance SHOULD use `[ORCH Response]` blocks.
- **COM-008**: Peer files MAY carry existing artifact, readiness, dependency, quiet-window, reproduction, and interface facts; ORCH alone changes scope, ownership, priority, approval, or completion conditions.

## 7. Model, session, workspace, and focus safety

- **MOD-001**: Before prompt, bridge facts and Herdr bootstrap metadata MUST exact-match official session, pane, provider/model, thinking, nonce, and freshness.
- **MOD-002**: After the first prompt boundary, canonical OMP JSONL MUST exact-match session, provider/model, thinking, and fallback before success or later resume.
- **MOD-003**: A bootstrap-reported path MAY precede JSONL creation and MUST NOT become resume authority until persisted verification succeeds.
- **MOD-004**: A synthetic prompt MUST NOT be sent solely to create JSONL.
- **MOD-005**: Missing, stale, unsafe, corrupt, mismatched, concurrently resumed, known-duplicate, or credibly duplicate session evidence MUST fail closed.
- **MOD-006**: A model MUST NOT supply a session path or resume argument.
- **OWN-001**: One deterministic run workspace MUST contain a retained anchor and one registry-owned tab per worker lane.
- **OWN-002**: Labels are hints; stable IDs, canonical `cwd`, registry binding, agent identity, and session evidence establish ownership.
- **OWN-003**: Focus restoration MUST reverse only displacement onto registry-owned coordinates and MUST preserve unrelated current user focus.
- **OWN-004**: `focus_restoration: partial` MUST be a warning, not proof that the main operation failed.
- **OWN-005**: Safe worker close MUST allow only the exact registry root pane plus structurally verified Herdr Sidebar panes.
- **OWN-006**: A verified Sidebar MUST share workspace/tab/canonical `cwd`, have exact label `Sidebar`, expose no non-null agent/session evidence, and have non-empty tokens whose keys begin `herdr-sidebar-`.
- **OWN-007**: No public operation MAY close the retained run workspace.

## 8. Ambiguous effects, recovery, and closure

- **LIFE-001**: A wait timeout MUST be treated as a no-effect observation; a mutating timeout MAY have taken effect.
- **LIFE-002**: Prompt, response, resume, target start, or close uncertainty MUST be inspected before retry.
- **LIFE-003**: Recovery MUST verify routing, operation fingerprint, state sequence, report, official session, workspace/tab/pane ownership, and topology as applicable.
- **LIFE-004**: Recovery MAY continue from a proved effect or retry from proved absence; unresolved ambiguity MUST preserve every coordinate and prohibit replay.
- **LIFE-005**: A response that initially returns an ambiguous transport result MAY be accepted only after fresh inspection proves the sequence advanced and the assignment reached the expected boundary.
- **LIFE-006**: ORCH MUST resolve or escalate blocked state and reconcile ambiguity before lane or track closure.
- **LIFE-007**: Material worker claims MUST be independently reproduced before acceptance.
- **LIFE-008**: A reset copies planning context, not truth; inherited evidence MUST be revalidated.
- **LIFE-009**: Handoff MUST preserve responsibility routing, assignment ledger, official sessions/models, reset lineage, active source lanes, blocked/ambiguous operations, focus warnings, and review status.
- **LIFE-010**: The target ORCH MUST use the configured role and its own exact official persisted session; it MUST NOT resume source ORCH context.

## 9. Routing and user boundaries

- **RTE-001**: ORCH MUST retain decomposition, responsibility naming, scope, priority, approval, completion contracts, integration, and final judgment.
- **RTE-002**: Bounded mechanical work SHOULD use host OMP task/subagents and MUST NOT create Herdr delegation state.
- **RTE-003**: Substantial independent work requiring persistence, explicit ownership, exact-session resume, blocked handling, or durable routing SHOULD use responsibility workers.
- **RTE-004**: Host task/subagent model choice remains outside this plugin's selection and verification contract.
- **RTE-005**: Parallel workers MUST have disjoint write ownership; overlapping shared-`cwd` edits MUST be serialized.
- **RTE-006**: Workers MUST self-resolve from their assignment, plan, canonical project documents/settings, and code before requesting judgment.
- **RTE-007**: ORCH MUST escalate only plan-marked user decisions, irreversible external actions, shared governance, secrets/account access, or judgment only the user can supply.
- **RTE-008**: Assignment completion MUST leave the responsibility worker idle and available for follow-up work unless ORCH separately closes the lane or track.

## 10. Security and privacy

- **SEC-001**: Mutation MUST fail closed when identity, authority, model, session, ownership, topology, or effect cannot be proved.
- **SEC-002**: Storage and registry mutations MUST be atomic and lock-guarded.
- **SEC-003**: Errors and live output returned to the model MUST be bounded.
- **SEC-004**: Plans, assignments, reports, evidence, peer channels, examples, and tool responses MUST NOT contain secrets, authentication material, private keys, personal data, or unnecessary private-source excerpts.
- **SEC-005**: This plugin MUST NOT be represented as a secret store, redaction layer, sandbox, authorization system, or data-loss-prevention system.
- **SEC-006**: Secrets or account access MUST be escalated to the user rather than requested through worker reports or blocked responses.
- **SEC-007**: Public documentation and package metadata MUST remain product-neutral, English-only, and free of local machine paths.

## 11. Installation and packaging

- **PKG-001**: Root `plugin.json` MUST conform to Agent Plugins 1.0.0, identify `herdr-delegator` version 1.0.0, and contain client-specific OMP data only under `extensions.io.github.edgar-min.herdr-delegator`.
- **PKG-002**: Root `mcp.json` MUST conform to Agent Plugins 1.0.0 and advertise one `herdr-delegator` stdio server using bare command `sh`, sole arg `${PLUGIN_ROOT}/bin/herdr-delegator-mcp`, and `${PLUGIN_ROOT}` as `cwd`; `.mcp.json` MUST NOT exist.
- **PKG-003**: Agent Plugins portable authority MUST remain `plugin.json`, `skills/`, and `mcp.json`. `package.json` MUST remain npm/current-OMP compatibility metadata with version 1.0.0, direct runtime dependencies, and only the namespaced `omp.extensions` entry.
- **PKG-004**: The publish allowlist MUST include `plugin.json`, `mcp.json`, executable `bin/herdr-delegator-mcp`, `io.github.edgar-min.herdr-delegator/**/*.ts`, `mcp/**/*.ts`, the bundled skill, schemas/examples, README, LICENSE, and docs.
- **PKG-005**: README prerequisites MUST require OMP, Herdr, Bun, and `herdr integration install omp`, and MUST document GitHub installation plus local development linking. The POSIX launcher MUST resolve Bun only from `PATH`, `${BUN_INSTALL}/bin/bun`, or `${HOME}/.bun/bin/bun`, emit no stdout, and exit 127 with one stderr error when Bun is unavailable.
- **PKG-006**: `/reload-plugins` MUST be documented as the skill/MCP reload boundary; changed OMP extension cutover MUST be verified in a new OMP session.

## 12. Module architecture

- **ARC-001**: `io.github.edgar-min.herdr-delegator/extensions/herdr-delegator.ts` MUST remain a bridge-only entry and MUST NOT register public MCP tools.
- **ARC-002**: `io.github.edgar-min.herdr-delegator/extensions/lib/bridge.ts` MUST own OMP fact publication and bootstrap metadata reporting.
- **ARC-003**: `mcp/server.ts` MUST own stdio transport and exactly three public registrations.
- **ARC-004**: `mcp/contracts.ts` MUST own strict public schemas and bounded shared MCP contracts.
- **ARC-005**: `mcp/herdr-adapter.ts` MUST expose fixed, bounded Herdr operations and MUST NOT accept raw public argv.
- **ARC-006**: `mcp/registry.ts` MUST own immutable assignment parsing, responsibility routing, FIFO lane state, and minimal delegation registry.
- **ARC-007**: `mcp/tools.ts` MUST own composite track, assignment, and worker transactions and consume internal lifecycle authority without exposing it as another public surface.
- **ARC-008**: Existing configuration, runtime, worker, and track lifecycle modules MAY remain internal implementation dependencies; their old operations MUST NOT appear as public tools.

## 13. Observable acceptance scenarios

- **ACC-001 — Clean initialization**: `herdr_track init` derives deterministic storage, creates only owned initialization artifacts, and creates no worker or placeholder work artifact.
- **ACC-002 — Three-tool boundary**: MCP initialization lists exactly `herdr_track`, `herdr_assignment`, and `herdr_worker`; the extension registers none of them.
- **ACC-003 — Exact responsibility reuse**: Two sequential assignments with the same responsibility route to the same worker ID, workspace, tab, root pane, and official OMP session.
- **ACC-004 — Context retention**: The second reused assignment can report a nonce or fact established only by the first assignment in that same official session.
- **ACC-005 — Busy-lane FIFO**: A second same-responsibility assignment queues while the lane is active and does not create another worker.
- **ACC-006 — Simple separation**: A second lane is created only with one valid separation kind, short reason, and existing conflicting worker.
- **ACC-007 — Immutable assignment**: Hash mismatch, malformed Markdown, unsafe file identity, or duplicate ID/content conflict fails before prompt.
- **ACC-008 — Seven states**: Persisted and public assignment observations use only the seven states in ASN-024.
- **ACC-009 — Exact blocked response**: A stale sequence is rejected without input; a fresh allowlisted key response to an inspected dialog advances the sequence and reaches a natural boundary.
- **ACC-010 — Ambiguous response recovery**: When response transport is ambiguous, no replay occurs; fresh inspection may prove the effect by a sequence advance and completed assignment.
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

## Review checklist

### Implemented facts to verify against source

- [ ] Agent Plugins `plugin.json`, Agent Skills frontmatter, package metadata, and skill metadata identify version 1.0.0.
- [ ] `mcp/server.ts` registers exactly `herdr_track`, `herdr_assignment`, and `herdr_worker`; the namespaced OMP extension is bridge-only.
- [ ] Every action and field matches the discriminated schemas in `mcp/contracts.ts`.
- [ ] Assignment Markdown grammar, hash verification, report settlement, and the seven-state union match `mcp/registry.ts`.
- [ ] Exact responsibility reuse, one active assignment, FIFO queueing, ordinal reservation, and simple separation match routing source.
- [ ] Bridge fact derivation, strict file/session/metadata verification, and configured role resolution match bridge and MCP source.
- [ ] Pre-prompt bootstrap and post-prompt JSONL gates preserve exact provider/model/thinking/session identity.
- [ ] Prompt/response/resume ambiguity prohibits replay and converges on the single public `ambiguous` state.
- [ ] Worker resume and close exact-session/sequence gates match composite and lifecycle source.
- [ ] Root `plugin.json`/`mcp.json`, executable plugin-relative launcher, namespaced extension path, publish allowlist, and direct runtime dependencies match Agent Plugins and compatibility metadata.
- [ ] Documents, MCP control, and Herdr observation carry only their assigned authority.
- [ ] Public artifacts contain no local machine path, secret, product dependency outside OMP/Herdr, or implementation history.

### Live behavior to verify

- [ ] Sequential exact-responsibility assignments reuse the same worker ID, workspace/tab/pane, official session, and retained context.
- [ ] A busy matching lane queues FIFO instead of creating a worker.
- [ ] A new lane requires `direction`, `ownership`, or `dependency` plus a short reason and conflicting worker.
- [ ] A fresh blocked assignment rejects stale sequence and accepts only bounded text or allowlisted keys for the inspected surface.
- [ ] An ambiguous blocked response is inspected, never replayed blindly, and may settle only after the advanced sequence and report completion are proved.
- [ ] Completion stores the report hash, returns the lane to idle, promotes FIFO, and retains the tab/session.
- [ ] Track and worker close refuse active, blocked, ambiguous, stale-session, stale-sequence, or unsafe-topology state.

### Reviewer decisions to approve or request changes

- [ ] Approve OMP-only scope and refusal to predesign another runtime adapter.
- [ ] Approve the three-tool composite MCP boundary and bridge-only extension.
- [ ] Approve configuration-selected orchestrator role with built-in `@default`.
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
- [ ] [`skills/herdr-delegation/templates/protocol.md`](../skills/herdr-delegation/templates/protocol.md): deployed run protocol.
- [ ] [`skills/herdr-delegation/templates/handoff.md`](../skills/herdr-delegation/templates/handoff.md): responsibility and assignment handoff.
- [ ] [`config.schema.json`](../config.schema.json), [`run.schema.json`](../run.schema.json), and [`reset.schema.json`](../reset.schema.json): strict public data contracts.
- [ ] [`LICENSE`](../LICENSE): canonical Apache License 2.0 text and copyright notice.
