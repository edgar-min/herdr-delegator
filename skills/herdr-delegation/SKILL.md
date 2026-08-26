---
name: herdr-delegation
description: Delegate substantial independent work from an OMP planning session to persistent Herdr worker tabs with deterministic storage, audited coordination, model-verified routing, recovery, verification, and safe closure.
version: 3.0.0
---

# Herdr delegation

The session that reads this skill is **ORCH**. ORCH runs under OMP role `@plan`, decomposes and owns the work, writes judgment-bearing plans and worker instructions, resolves decisions, independently verifies results, and performs recovery. Configuration selects OMP roles; the calling OMP process resolves each selected role to the exact concrete provider/model and effective thinking used for launch.

Herdr provides durable tabs, relay, and live-state observation. Files in the deterministic run are the audit source of truth. The user does not wake workers, carry peer messages, or perform recovery.

## 1. Route work before creating tabs

Use the host OMP task/subagent mechanism in the current ORCH session for bounded mechanical or light work. It creates no Herdr workspace, tab, worker record, or `a2a` worker file set. Keep that work non-judgmental; ORCH owns and verifies the result. This plugin neither controls nor verifies the model used by host task/subagents.

Use a separate Herdr worker tab only for a substantial independent slice that benefits from main-session context, explicit write ownership, persistence, exact-session resume, blocked-state handling, or peer coordination.

Slice first. Parallelize only disjoint ownership. Worker tabs share the configured project `cwd`; never run two code-editing workers concurrently against the same shared working directory. Serialize overlapping writes.

## 2. Configure deterministic storage

Configure `storage.root` as an absolute path in `herdr-delegator.json` at user or project scope:

- user: `${PI_CODING_AGENT_DIR}/herdr-delegator.json`, or `~/.omp/agent/herdr-delegator.json` when that environment variable is unset;
- project: `<cwd>/.omp/herdr-delegator.json`.

Project configuration overrides user configuration. At least one of those layers must set `storage.root`; there is no temporary-directory or `cwd` fallback. An optional run-local `<resolved-run>/herdr-delegator.json` may override model profiles but may not relocate its storage root.

The built-in routing contract is:

- ORCH: `@plan`, thinking `inherit`;
- worker profile `default`: `@default`, thinking `inherit`;
- worker profile `slow`: `@slow`, thinking `inherit`.

Configuration may override worker-profile role/thinking leaves or add bounded named profiles. ORCH must explicitly pass a configured profile on every `ensure_worker` call; there is no implicit worker default or automatic fallback selection.
Configuration accepts OMP role aliases, never concrete model IDs. Launch pinning precedes a two-stage session gate:

The caller first resolves the configured role and captures the exact concrete provider/model plus effective thinking. The child OMP process is launched with those concrete values, so role-alias resolution cannot drift across processes.

1. **Pre-prompt gate:** before any work prompt, the child extension reports an in-process bootstrap attestation through Herdr pane metadata: official session ID and reported path, concrete provider/model, thinking, nonce, and timestamp. The controller proves the intended pane/session and compares every expected fact exactly.
2. **Persisted gate:** the reported session path may precede JSONL creation and is not resume-eligible yet. After the first prompt boundary, persisted JSONL must exist and match the attested session, concrete model, thinking, and fallback status before success or later resume.
Attestation or report failure is fail-closed. Never send a synthetic prompt merely to force JSONL creation.

Choose lowercase `track_id` and `run_id` values matching `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`. Run identity is the pair, not a path supplied by the model.

## 3. Initialize one run

Call `herdr_track.init_run` with:

- `track_id` and `run_id`;
- the absolute canonical project `cwd`;
- optional `timeout_ms` from 1,000 through 300,000.

The tool resolves `<storage-root>/<track-id>/<run-id>` and atomically creates or reconciles only:

```text
<storage-root>/
  index.json                         # tool-owned storage index
  <track-id>/<run-id>/
    run.json                         # strict version-1 manifest
    protocol.md                      # byte-for-byte bundled template
    a2a/
```

`init_run` does not create placeholder plans, instructions, reports, evidence, registries, workspaces, tabs, or OMP sessions. ORCH then authors the files the work actually needs:

```text
<resolved-run>/
  plan.md
  evidence.md                        # when independent evidence is recorded
  orchestrator-instructions.md       # only when start_orch will launch a target ORCH
  orchestrator-report.md             # written by that target ORCH
  a2a/
    w<N>-instructions.md
    w<N>-report.md
    w<N>-to-w<M>.md                  # only for a declared peer channel
    herdr-workers.json               # registry version 3; tool-owned
    .herdr-workers.lock              # tool-owned
```

Never edit, move, copy, or unlock the registry or lock. Canonical paths returned in tool details are bounded audit observations. Continue addressing every tool operation by `track_id` and `run_id`; never replace those coordinates with an arbitrary run path.

## 4. Write a condition-bearing plan

`plan.md` must state:

- the goal and observable completion scenarios;
- files, systems, and actions workers must not modify;
- every item requiring explicit user confirmation;
- phases, routing choice, worker assignment, and exact write ownership;
- producer/consumer dependencies, readiness signals, peer channels, and quiet windows;
- ORCH-owned slice and integration checks;
- reset lineage when present.

Separate read-only measurement from repair. Worker instructions name required reading, scope, prohibitions, ordered work, completion checks, report path, dependencies, profile choice, and delegation policy. Compare each instruction file once against the copied `protocol.md` before prompting. Current project rules and this skill govern; historical runs are evidence, not doctrine.

## 5. Operate `herdr_worker` safely

Every worker call uses `track_id`, `run_id`, and `worker_id`. Worker IDs match `w[1-9][0-9]*`; use lowercase in file names. The tool resolves and verifies `run.json`, storage configuration, canonical `cwd`, registry identity, and the dedicated workspace.

### Mandatory start and observation sequence

For each new, reconciled, or resumed worker:

1. Call **`ensure_worker`** with track/run IDs, worker ID, absolute canonical `cwd`, explicit configured `profile` (`default`, `slow`, or another configured profile), and optional timeout. It verifies the calling ORCH, resolves the selected worker role to an exact provider/model and effective thinking, creates or reconciles the deterministic run workspace and retained anchor, and creates, reconciles, or resumes exactly one registry-owned worker in its own tab. Before any work prompt, the child must provide matching session-bound bootstrap attestation from the intended pane.
2. If ensure reports resume, reconciliation, or ambiguity, call **`inspect_worker`** before any prompt. Do not prompt until official session identity and live state are proved.
3. Call **`prompt_wait`** with the same IDs and the exact deterministic `<resolved-run>/a2a/<worker-id>-instructions.md`. The required `instruction_path` is a constrained file coordinate, not run identity. The tool fingerprints it, records intent before delivery, prevents duplicate prompting, and waits for a natural boundary.
4. Call **`inspect_worker`** after `prompt_wait` and before every judgment, blocked response, retry, recovery, or close.

A matching instruction fingerprint in `prompting`, `prompted`, `working`, or a settled state is a deduplication signal: inspect instead of resending. After submission, do not rewrite the instruction; append an `[ORCH Addendum]` for new information to be consumed at the next natural boundary.

### Operation rules

- **`ensure_worker`**: initial creation or same-identity reconciliation after interruption. Never use a new worker number to bypass an identity, ownership, topology, session, or multiple-candidate conflict.
- **`prompt_wait`**: prompt only after successful ensure and any required post-reconciliation inspection.
- **`inspect_worker`**: inspect after each wait, timeout, stall, ambiguous effect, block response, or close uncertainty, and immediately before a decision or close. Optional `output_lines` is 1–200.
- **`resolve_block`**: only when the latest inspection proves `blocked`, ORCH has a non-user answer grounded in the plan, instructions, or canonical project sources, and `expected_state_change_seq` equals the exact latest blocked sequence. Use bounded text only for free-form text input. For an interactive option dialog, inspect it and use bounded allowlisted keys, such as `enter` for a preauthorized recommended selection. If a response leaves state and sequence unchanged, record a no-effect observation and inspect; it is not permission to replay blindly.
- **`close_worker`**: mandatory during closure, but only after a fresh inspection proves `idle`, `done`, or `failed` and identity, registry ownership, tab ownership, and pane topology are safe. After close, `inspect_worker` may return `agent_not_found`; the registry's `closed` record is authoritative and the retained run anchor remains.

### Ambiguous effects

A timed-out prompt, block response, or close may have taken effect. Never retry blindly. Inspect and reconcile deterministic identity, registry ownership, live state and `state_change_seq`, prompt fingerprint and phase, report presence, official session, workspace coordinates, bounded terminal observation, and—during close—tab/topology state.

Continue from a proved effect. Retry only when absence is proved and recovery guidance permits it. If effect, identity, ownership, topology, or duplicate-session safety remains ambiguous, preserve every coordinate and stop the mutation. Do not resend, answer, close, or create a replacement.

### Workspace, focus, resume, and safe close

One deterministic run workspace contains a retained anchor tab/pane plus one owned tab per worker. Labels are hints, never identity proof. No public operation closes the workspace.

Focus capture and restoration are internal and guarded. Automation restores only displacement onto registry-owned coordinates and never overrides focus that moved elsewhere, which may be concurrent user action. `focus_restoration: partial` is a warning to record, not proof that the operation failed.

Context continuity exists only through the exact official OMP session path already recorded in registry version 3. A bootstrap-reported path may exist before its JSONL file and is not resume-eligible until that file exists and persisted identity has been verified. Reconciliation prefers Herdr native restoration. Manual resume is eligible only in a proved owned interactive shell or one owned replacement tab after file and duplicate checks. Never accept a session path or resume argument from model input, and never resume one OMP JSONL concurrently. Missing/corrupt paths, known duplicates, and credible duplicate ambiguity fail closed.

Safe close permits only the exact registry root pane and verified Herdr Sidebar auxiliary panes in the worker tab. Each Sidebar pane must share the workspace/tab and canonical run `cwd`, have exact label `Sidebar`, expose no non-null `agent` or `agent_session` evidence, and have a non-empty `tokens` object whose keys all begin `herdr-sidebar-`. Any unproved, mixed, or extra pane prevents close.

## 6. Operate target ORCH sessions

`herdr_track` exposes three operations:

- **`init_run`**: deterministic storage initialization described above;
- **`start_orch`**: starts or reconciles one target ORCH for an initialized run after canonical `plan.md` and `orchestrator-instructions.md` exist;
- **`inspect_orch`**: returns bounded target run/workspace/anchor identity, official session/model verification, live state/sequence, prompt fingerprint/state, reset lineage, focus observations, and report presence.

`start_orch` accepts only track/run IDs and optional timeout. It resolves exactly `<resolved-run>/orchestrator-instructions.md`, resolves the configured `@plan` role in the caller, launches the target with the captured exact concrete provider/model and effective thinking, verifies pre-prompt bootstrap attestation from the target pane, fingerprints the instruction, and deduplicates delivery. A fresh target starts without resume. Reconciliation may resume only that target run's exact registry-recorded official session after persisted JSONL identity and ownership/duplicate checks.

After `start_orch`, call `inspect_orch` before judging its state or recovering an ambiguous effect. A target recovered after an ambiguous first return may permanently retain `prompt_state: prompting` as its never-replay fingerprint. It need not be rewritten to `prompted`; `verified_at` together with persisted fallback/model facts proves persisted verification and settled state. A dead ORCH cannot start or resume itself. Use native Herdr/OMP restoration or a live predecessor ORCH/control surface to start or reconcile the target.

## 7. Communication and decision boundaries

The copied `protocol.md` is authoritative. Workers append only to their own `w<N>-report.md`; ORCH writes decisions and closure judgments in `[ORCH Response]` blocks. Runtime terminal output and Herdr state are observations, not substitutes for reports.

Peer facts route through ORCH. A worker may append to a declared directional `w<N>-to-w<M>.md`; ORCH relays its coordinate through an addendum or a new prompt. Peers may confirm existing artifact coordinates, dependencies, readiness, quiet windows, reproduction results, and interface facts. Only ORCH changes scope, ownership, priority, approval, or completion contracts.

Apply the self-resolution ladder before escalation:

1. Read worker instructions, then `plan.md`, canonical project documents/settings, then code.
2. If evidence is clear and action is within ownership, proceed and cite the coordinate.
3. If evidence is absent or conflicting, append one batched `[ORCH Decision Request]` with situation, options, tradeoffs, and recommendation; continue independent work.
4. ORCH independently verifies the grounds, resolves a non-user block against the current sequence, or escalates.

Escalate to the user only for plan-marked user decisions, irreversible/destructive actions outside registry-owned workers, shared governance changes, secrets/authentication/account access, or judgment only the user can supply. A worker request, timeout, or unfamiliar operation is not itself a user boundary.

## 8. Sibling reset

A reset always uses a sibling target coordinate. Call `herdr_track.init_run` with new target `track_id`/`run_id`, canonical `cwd`, and `reset_of: { track_id, run_id }` for a different source under the same storage root.

The tool validates the source manifest and canonical `plan.md`, copies that plan byte-for-byte, creates strict `run.json` and `reset.json` lineage, and records fixed policies:

- workers: `close-settled-preserve-active`;
- evidence: `revalidate-before-import`.

It does not traverse or mutate source workers. ORCH may revise the copied target plan before launch. Freshly inspect source workers; close settled registry-owned workers only through `close_worker`, and preserve working, blocked, unknown, conflicted, or unsafe-topology workers with the source workspace and exact recovery coordinates. Old evidence is not inherited as truth; revalidate it before citation.

Author target `orchestrator-instructions.md`, then call `start_orch`. The target starts one clean ORCH under `@plan`; its future resume uses only its own exact official session path. Never resume the source ORCH context as the target.

## 9. Verification and closure

Before accepting a worker result, ORCH independently reproduces the material claim. Sample reported coordinates and, where possible, run a separate live demonstration. Keep slice checks inside the slice and run integration verification once at the integration boundary. Record the closure judgment in `[ORCH Response]` and independent evidence in `evidence.md` when used.

To close a run:

1. Freshly inspect every registry-owned worker and the target ORCH when present.
2. Resolve or escalate blocked state and reconcile every unknown or ambiguous effect.
3. Close each safe settled worker through `close_worker`; preserve anything not proved safe.
4. Promote durable decisions, rules, and evidence to permanent project locations.
5. Record closure judgment in the run's plan, reports, and evidence. The plugin-owned storage index remains an observed storage record; never hand-edit `<storage-root>/index.json`.
6. Delete only non-audit scratch files.
7. Inspect worktree hygiene. Remove only clean worktrees whose branch is fully merged with zero commits ahead, then delete the merged branch. Preserve dirty or unmerged worktrees for user disposition.

The deterministic run remains the audit record. Do not manually relocate or archive it outside the configured storage contract, and never declare closure while any registry-owned worker is working, blocked, unknown, identity-conflicted, unsafe to close, or affected by unresolved ambiguity.

## 10. Hand off a track

When ORCH context threatens judgment quality, stop issuing work and let active workers reach a natural reporting boundary. Complete `templates/handoff.md`, preserving track/run IDs, canonical path observation, storage-config source hashes, registry/workspace/anchor, ORCH and worker official sessions and verified models, reset lineage, active preserved source workers, blocked/ambiguous effects, focus warnings, and review status.
Initialize a sibling successor run with `herdr_track.init_run`, author its plan and `orchestrator-instructions.md`, and use `start_orch` to launch the new `@plan` ORCH. Remaining worker instructions must be rewritten; old addenda may be stale. The successor accepts, defers, or rejects every carried item and assumes relay only after acceptance.

## Templates

- `templates/protocol.md` — copied byte-for-byte by `init_run`; keep project-specific constraints in `plan.md` and instructions so repeated initialization remains reconcilable.
- `templates/handoff.md` — complete when transferring judgment to a successor track.
