# a2a communication protocol — <track_id>/<run_id>

This deterministic run is the file communication channel between the planning session (**ORCH**) and independent worker sessions. Files are the audit source of truth. Herdr transports prompts and exposes live state; it does not own judgments. The user does not wake workers, relay messages, or perform recovery.

## Identity, storage, and model contract

- ORCH runs under OMP role `@plan`. Configuration selects OMP role aliases only, never concrete model IDs. The caller resolves the selected role and effective thinking to an exact concrete provider/model before launch.
- Run identity is lowercase `track_id` plus `run_id`. Every tool call uses those IDs; an arbitrary run path is never an input substitute.
- `storage.root` is configured as an absolute path in user `${PI_CODING_AGENT_DIR}/herdr-delegator.json` (default `~/.omp/agent/herdr-delegator.json`) or project `<cwd>/.omp/herdr-delegator.json`. There is no temporary-path fallback.
- `herdr_track.init_run` deterministically resolves `<storage-root>/<track-id>/<run-id>`, writes strict `run.json`, copies this protocol, creates `a2a/`, and updates the tool-owned storage index. It creates no placeholder plan, instruction, report, evidence, registry, workspace, tab, or session.
- Worker tabs require an explicit configured profile on every `ensure_worker`. Built-ins are `default` (`@default`) and `slow` (`@slow`), both with thinking `inherit`; no implicit selection exists.
- The child OMP launches with the caller-captured concrete provider/model and effective thinking, preventing cross-process role-alias drift. Before any work prompt, the child extension reports session-bound in-process bootstrap attestation through Herdr pane metadata: official session ID/reported path, concrete provider/model, thinking, nonce, and timestamp. The controller proves the target pane/session and compares all facts exactly.
- A bootstrap-reported session path may precede JSONL creation and is not resume-eligible yet. After the first prompt boundary, JSONL must exist and match the bootstrap/session/model/thinking/fallback facts before success or resume. Attestation/report failure is fail-closed; never send a synthetic prompt to create JSONL.
- Bounded mechanical/light work uses the host OMP task/subagent mechanism in the current ORCH session. It creates no Herdr worker or `a2a` worker files. ORCH owns and verifies it; this plugin does not control or verify its model.

## Roles

- **ORCH**: decomposes work, chooses routing, writes plan/instructions, judges decisions, independently verifies results, and performs recovery.
- **Herdr worker (`w1`, `w2`, ...)**: an independent OMP main session in a separate registry-owned tab. It performs only its assigned substantial slice and writes its own report.
- **Host task/subagent**: bounded, mechanical, non-judgmental work inside the current ORCH session; never treated as a persistent worker.
- **User**: supplies only decisions meeting the escalation boundary below; never acts as transport or recovery operator.

Worker tabs share the project `cwd`. Parallelize only disjoint ownership, and never run concurrent code-editing workers against one shared working directory. Serialize overlapping writes.

## File authority

| File | Writer | Authority and purpose |
|---|---|---|
| `run.json` | `herdr_track` | Strict version-1 track/run/cwd/path manifest and optional reset coordinate; never edit |
| `reset.json` | `herdr_track` | Strict sibling-reset lineage, source-plan hash, and fixed worker/evidence policies; never edit |
| `plan.md` | ORCH | Goal, completion scenarios, prohibitions, user decisions, routing, ownership, dependencies, quiet windows, lineage, and integration checks |
| `protocol.md` | `herdr_track` | Byte-for-byte bundled communication and lifecycle contract; keep project-specific constraints in `plan.md` and instructions |
| `orchestrator-instructions.md` | predecessor ORCH | Complete prompt source when `start_orch` launches a target ORCH |
| `orchestrator-report.md` | target ORCH | Target ORCH progress, decisions, evidence, and handoff result |
| `a2a/w<N>-instructions.md` | ORCH | Complete worker assignment and constrained prompt source |
| `a2a/w<N>-report.md` | Worker `w<N>` | Append-only timestamped progress, evidence, decision requests, and completion |
| `[ORCH Response]` in a worker report | ORCH | Decision or closure judgment |
| `[ORCH Addendum]` in worker instructions | ORCH | New information for an already-prompted worker, consumed at the next natural boundary |
| `a2a/w<N>-to-w<M>.md` | Sender `w<N>` | Append-only directional peer facts, only for a plan-declared channel |
| `a2a/herdr-workers.json` and `.herdr-workers.lock` | plugin tools | Registry version 3 identity, workspace/anchor, ORCH observation, model verification, and worker lifecycle; never edit, move, copy, or unlock |
| `evidence.md` | ORCH | Independent before/after, slice, and integration evidence when needed |
| `<storage-root>/index.json` and lock | `herdr_track` | Deterministic storage index and transaction state; never hand-edit or unlock |

Canonical paths returned in bounded tool details are audit observations. Tool calls continue to use track/run IDs. The one path-valued worker input, `prompt_wait.instruction_path`, must equal the exact deterministic worker instruction coordinate; it never establishes run identity.

Terminal output and Herdr state are live observations, not substitutes for plans, instructions, reports, evidence, or decisions. Never write another worker's report. Never place secrets in paths, arguments, prompts, output, logs, reports, or evidence.

## Condition-bearing plan and instructions

Before work begins, `plan.md` states observable completion, prohibitions, user-confirmed items, routing, exact write ownership, producer/consumer dependencies, readiness signals, peer channels, quiet windows, ORCH verification, and any reset lineage. Separate read-only measurement from repair.

Each worker instruction names required reading, scope and non-goals, prohibitions, ordered work, completion checks, report path, dependencies, explicit profile, and delegation policy. Compare it once with this deployed protocol before prompting. Current project rules and this protocol govern; prior runs are evidence only.

## `herdr_track` lifecycle

### `init_run`

Call with bounded lowercase `track_id`/`run_id`, absolute canonical project `cwd`, optional `timeout_ms` (1,000–300,000), and optional sibling `reset_of: { track_id, run_id }`. It performs storage initialization only. ORCH authors judgment files afterward.

### `start_orch`

Call only after canonical `plan.md` and `orchestrator-instructions.md` exist. Inputs are track/run IDs and optional timeout—never `cwd`, instruction path, session path, executable, or argv. The tool resolves the instruction, has the caller resolve configured `@plan` to exact provider/model plus effective thinking, launches the child with those concrete values, verifies its pre-prompt bootstrap attestation from the intended pane, fingerprints/deduplicates the prompt, and waits for a natural boundary.

A fresh target starts without resume. Reconciliation may resume only that target run's exact registry-recorded official session path after persisted JSONL identity, owned-shell, and duplicate checks. Recovery after an ambiguous first return may retain `prompt_state: prompting` permanently as the never-replay fingerprint. It need not become `prompted`; `verified_at` plus persisted fallback/model facts establishes persisted verification and settled state. A dead ORCH cannot start or resume itself; use native Herdr/OMP restoration or a live predecessor control surface.

### `inspect_orch`

Call after `start_orch` and before judgment or ambiguous-effect recovery. It reports bounded run/workspace/anchor identity, target official session and model verification, live state and sequence, prompt fingerprint/state, reset lineage, focus observation, and `orchestrator-report.md` presence. It returns no arbitrary transcript.

Never retry an ambiguous target start or prompt blindly. Inspect; continue from a proved effect, retry only from proved absence when recovery guidance permits, otherwise preserve coordinates and fail closed.

## `herdr_worker` automated relay

Every call uses `track_id`, `run_id`, and lowercase `worker_id` matching `w[1-9][0-9]*`. Optional timeout is 1,000–300,000 milliseconds; optional inspection output is 1–200 lines.

### Mandatory sequence

1. Call **`ensure_worker`** with track/run IDs, worker ID, canonical project `cwd`, and an explicit configured `profile`. It verifies run/cwd/config and calling ORCH, resolves the selected worker role to an exact concrete provider/model and effective thinking, launches with those captured values, verifies pre-prompt bootstrap attestation from the intended pane, and proves registry/workspace/anchor/session identity before prompt-path mutation.
2. If ensure reports resume, reconciliation, or ambiguity, call **`inspect_worker`** before prompting. Continue only when official identity and live state are proved.
3. Call **`prompt_wait`** with the same IDs and exact `<resolved-run>/a2a/<worker-id>-instructions.md`. It fingerprints the instruction, records prompt intent before submission, prevents duplicates, and waits for `idle`, `done`, or `blocked` boundaries.
4. Call **`inspect_worker`** after the wait and before judgment, block response, retry, recovery, or close.

Do not skip or reorder the sequence. Never create another worker number to escape uncertainty.

### State-based operation rules

- **`ensure_worker`**: first creation or reconciliation of the same deterministic identity after interruption. It may reconcile a live worker, use a proved owned shell, or create one owned replacement tab only after duplicate checks. It is not authority to replace an identity-conflicted worker.
- **`prompt_wait`**: only after successful ensure and any required inspection. A matching fingerprint in `prompting`, `prompted`, `working`, `idle`, `done`, or `blocked` means inspect rather than send again. After submission, change instructions only by appending an `[ORCH Addendum]` for the next natural boundary.
- **`inspect_worker`**: after ensure when resume/reconciliation/ambiguity occurred; after every wait; after timeout, stall, ambiguous effect, block response, or close uncertainty; and immediately before a decision or close.
- **`resolve_block`**: only after latest inspection proves `blocked`; pin `expected_state_change_seq` to that exact sequence. ORCH must have a non-user answer grounded by plan, instruction, or canonical project source. Use bounded text only for free-form text input. For an interactive option dialog, inspect it and use bounded allowlisted keys, such as `enter` for a preauthorized recommended selection. If a response leaves state and sequence unchanged, it is a no-effect observation: inspect and do not replay blindly.
- **`close_worker`**: mandatory for registry-owned workers during closure, only after fresh inspection proves `idle`, `done`, or `failed` and registry identity, tab ownership, and pane topology are safe. A post-close `inspect_worker` may return `agent_not_found`; the registry `closed` record is authoritative and the retained run anchor remains.

### Timeout, stall, and ambiguous effect

A timed-out prompt, response, or close may already have taken effect. Never repeat it blindly. Inspect and reconcile:

- deterministic run/worker identity and registry ownership;
- workspace, anchor, tab, and exact root-pane coordinates;
- live state and `state_change_seq`;
- instruction fingerprint and registry phase;
- report presence and bounded terminal observation;
- official OMP session path/identity and model verification;
- for close, whether the owned tab still exists and whether every pane is safe.

Continue from a proved effect. Retry only when absence is proved and recovery guidance permits. If effect, identity, ownership, topology, or duplicate safety remains ambiguous, preserve files and coordinates and raise an ORCH decision. Do not resend, respond, close, or create a replacement.

### Workspace, focus, resume, and close boundaries

The deterministic run has one dedicated workspace with a retained anchor tab/pane; each worker has a separate registry-owned tab. Labels are hints, not identity proof. No public operation closes a workspace.

Focus restoration is guarded and best-effort. Automation restores only displacement onto owned coordinates and never overrides unrelated current focus. Record `focus_restoration: partial`; it is a warning, not proof of operation failure.

Context continuity exists only through the exact official OMP session path stored in registry version 3. A bootstrap-reported path is not resume-eligible until its JSONL exists and persisted identity is verified. Prefer native Herdr restoration. Manual resume requires a proved owned shell or one owned replacement tab plus file and duplicate checks. Never take a session path or resume arguments from model input, and never resume one JSONL concurrently. Missing/corrupt paths, known duplicates, and credible duplicate ambiguity fail closed.

Safe close allows only the exact registry root pane plus verified Herdr Sidebar auxiliary panes. Each Sidebar must share workspace/tab and canonical run `cwd`, have exact label `Sidebar`, expose no non-null `agent` or `agent_session`, and have a non-empty `tokens` object whose every key begins `herdr-sidebar-`. Any unproved, mixed, or extra pane prevents close.

## Self-resolution and user escalation

Before a worker requests a decision:

1. Read its instructions, then `plan.md`, canonical project documents/settings, then code.
2. If evidence is clear and action is within ownership, proceed and cite the exact coordinate afterward.
3. If evidence is absent or conflicting, append one batched `[ORCH Decision Request]`: situation in at most three lines, options, tradeoffs, and recommendation. Continue independent work where possible.
4. ORCH independently verifies the grounds and either resolves the current block or escalates.

`resolve_block` is not a convenience prompt. It requires a non-user decision, canonical grounds, and the latest inspected blocked sequence.

Escalate to the user only for:

- an item explicitly marked user-confirmed in `plan.md`;
- irreversible or destructive action outside registry-owned workers;
- a shared rule or cross-session governance change;
- secrets, authentication, account access, or account-specific input;
- judgment only the user can supply.

Do not escalate merely because a worker asks, a tool times out, or an operation is unfamiliar.

## Peer routing through ORCH

Workers may use directional `w<N>-to-w<M>.md` files only within plan-declared ownership. The sender alone appends; the receiver treats the file as read-only. Peer facts may establish artifact coordinates/readiness, dependencies, existing interface contracts, quiet windows, reproduction results, and compatibility observations.

Peers confirm contracts; ORCH changes contracts. Scope, priority, assignment, ownership, approval, completion conditions, conflicting evidence, irreversible actions, governance, and user-confirmed items go to ORCH.

Use `[REQ wN-<monotonic-number>]` and `[REPLY wN-<monotonic-number>]`. One message covers one dependency; cite coordinates instead of pasting evidence. Workers check only at natural boundaries—startup, before a block, after a phase/commit/deployment/proposal boundary, and before completion. No polling or acknowledgment-only messages.

ORCH relays a peer-file coordinate through `[ORCH Addendum]` or a newly planned prompt. When a fact affects execution, each affected worker records message ID, adopted fact, affected step, and artifact coordinate in its report.

## Reporting and ORCH verification

Reports are push records. Workers append at natural boundaries and exit normally after completion. Each completion entry states artifact coordinates, exact checks/results, self-decided grounds, and procedural friction. ORCH uses wait and inspection operations; it does not poll files or interrupt working sessions.

ORCH independently reproduces material claims, samples reported coordinates, and runs a separate live demonstration where possible. Slice verification stays inside the slice; integration verification runs once at the boundary. ORCH records acceptance or recovery in `[ORCH Response]` and performs recovery directly.

## Sibling reset

Reset uses `herdr_track.init_run` with a new sibling target coordinate and `reset_of` source coordinate under the same storage root. The tool validates source manifest and plan, copies the source plan, writes strict lineage/reset records, and fixes policies to `close-settled-preserve-active` and `revalidate-before-import`. It never traverses or mutates source workers.

ORCH may revise the copied target plan before `start_orch`. Freshly inspect source workers; close safe settled registry-owned workers through `close_worker`, and preserve working, blocked, unknown, conflicted, or unsafe workers plus source workspace and recovery coordinates. Old evidence is not inherited as truth; revalidate before citation.

Author target `orchestrator-instructions.md`; `start_orch` launches one clean target ORCH under `@plan`. Target resume uses only its own exact official session path. Native restoration or a live predecessor starts/reconciles it; a dead ORCH cannot resume itself.

## Common worker rules

- Obey exact ownership and prohibitions.
- Record out-of-scope gaps; do not repair them in place.
- Keep secrets out of all channels; refer only to approved names or references.
- Do not create a competing project convention.
- Do not delegate unless current project rules and worker instructions permit it.
- If a worker created a worktree, remove it only when clean, fully merged, and zero commits ahead. Preserve dirty/unmerged worktrees and report their state.
- Project-specific additions: <project rules>

## Closure

ORCH closes only after implementation and integration verification:

1. Freshly inspect every registry-owned worker and target ORCH when present.
2. Resolve/escalate blocked state and reconcile every unknown or ambiguous effect.
3. Close each registry-owned worker proved `idle`, `done`, or `failed` with safe identity and Sidebar-aware topology. Preserve every unsafe worker.
4. Promote durable decisions, rules, and evidence to permanent project coordinates.
5. Record closure judgment in plan/reports/evidence. The plugin storage index is tool-owned; never hand-edit it.
6. Delete only non-audit scratch files.
7. Remove only clean, fully merged worktrees with zero commits ahead; preserve dirty or unmerged worktrees for user disposition.

The deterministic run remains its audit record; do not manually relocate it into a temporary archive. Never declare closure while a worker is working, blocked, unknown, identity-conflicted, unsafe to close, or affected by unresolved ambiguity.
