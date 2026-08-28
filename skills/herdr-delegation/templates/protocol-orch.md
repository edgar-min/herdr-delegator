# ORCH protocol — <track_id>/<run_id>

Read `protocol.md` first. This document contains the rules for the OMP orchestrator (**ORCH**).

## Role and actors

ORCH decomposes work, chooses responsibility routing, writes plans and assignments, resolves judgment, independently verifies results, and performs recovery. A responsibility worker is a persistent OMP main session in one registry-owned tab and retains context across assignments with the same responsibility. An assignment is one immutable work unit routed to a lane. Host OMP task/subagents handle bounded mechanical work outside the Herdr registry and model-verification contract. The user supplies only decisions that cross the declared escalation boundary and never relays messages, wakes workers, or performs recovery.

Workers share the project `cwd`. Concurrent code-editing workers require disjoint write ownership; overlapping edits are serialized.

## Identity, storage, and model configuration

- Run identity is `(track_id, run_id)`; every tool call uses those coordinates rather than a model-supplied path.
- `storage.root` comes from strict user or project `herdr-delegator.json` configuration and must be absolute.
- `herdr_track {action:"open"}` resolves `<storage.root>/<track_id>/<run_id>`, writes the strict run manifest and the three bundled protocol documents, creates `a2a/`, updates the tool-owned index, fixes the mandate, spawns this ORCH pre-aligned, and records the birth that is this run's only command identity. `init` plus `start_orchestrator` lays out the same run without a mandate and remains for reset siblings and handoff targets; its `start_orchestrator` records a birth exactly like `open`'s spawn does, and is refused only on a run that already carries `open`'s creator record. However this run was created, its ORCH has a birth record.
- You are that birth. Your identity is the latest birth record: guarded commands from any other session fail `orch_identity_mismatch`, from a retired generation `stale_orch_generation`, and from the session that opened the track `creator_session_retired`. You write `plan.md` after birth, in conversation with the user; nobody wrote it for you.
- Tool-owned manifests, indexes, `a2a/herdr-workers.json`, `a2a/delegation.json`, and locks are never edited, moved, copied, or unlocked.

Configuration stores bounded OMP role aliases, never concrete model IDs. The built-in orchestrator role is `@default`; worker profiles `default`, `task`, and `slow` select `@default` so every built-in resolves without user configuration. A configured role may replace any built-in role.

ORCH selects each assignment profile by work characteristics: `default` for dialogue-faithful, meticulous language work; `task` for the best artifact under a clear specification; and `slow` for the deepest, most careful reasoning on hard problems where cost is secondary. Cost-efficient small mechanical work routes to host OMP task/subagents, so no persistent lane profile exists for it. A planning-grade orchestrator prioritizes judgment quality over cost.

The bridge-only OMP extension publishes session-scoped runtime facts. The stdio MCP server derives those facts from the verified Herdr caller pane and active OMP agent directory. Before mutation, bridge facts and Herdr bootstrap metadata must agree on session, pane, provider/model, thinking, nonce, and freshness. After the first prompt boundary, persisted JSONL must also agree on session, provider/model, thinking, and fallback. Missing, stale, unsafe, duplicated, or conflicting identity fails closed.

## Durable file authority

| Coordinate | Writer | Authority |
|---|---|---|
| `run.json`, `reset.json`, `<storage.root>/index.json` | `herdr_track` | deterministic run identity, reset lineage, and storage index |
| `protocol.md`, `protocol-orch.md`, `protocol-worker.md` | `herdr_track` | the bundled protocol set this run was created with; an older shipped version is accepted with a named warning and never edited in place |
| `plan.md`, `evidence.md` | ORCH | goal, routing, decisions, and independent verification |
| `a2a/assignments/A-NNN.md` | ORCH | one immutable assignment contract and instruction source |
| `a2a/w<N>-report.md` | worker `w<N>` | append-only evidence, result, decision request, and completion block |
| `[ORCH Response]` report blocks | ORCH | decision, acceptance, or recovery judgment |
| `a2a/w<N>-to-w<M>.md` | declared sender | append-only peer facts for a plan-authorized directional channel |
| `a2a/orch-to-<to_track_id>_<to_run_id>.md` | this run's ORCH | append-only inter-run conversation this run owns, named for the run it is *addressed to*; the counterpart owns the mirror file in its own run directory |
| `budget-ledger.md` | MCP | append-only seed, justifications, verdicts, parks, resumes — the trail a human is handed on a deny |
| `budget-clamp.json` | the user | absolute ceiling on this run's budget; clamping to 0 is the kill switch |
| `budget-audit-<n>.md` | MCP, then the auditor | the extension request plus machine facts, then the auditor's reasoning and verdict |
| `rebirth-approval.json` | the user | written approval for one clean rebirth, naming the generation it authorizes |
| `a2a/delegation.json` | MCP | responsibility routing, lane and assignment state, birth chain, budget record, hashes, timestamps |
| `a2a/herdr-workers.json` | lifecycle authority | workspace, tab, pane, official session, model verification, and guarded close state |
| `orchestrator-instructions.md` | `open`, or a source ORCH | the mandate: what this track must achieve and why, fingerprinted at first prompt |
| `orchestrator-report.md` | target ORCH | optional target-ORCH result |
| `a2a/messages.jsonl` | MCP | append-only log of every doorbell this run sent, delivered or not; a bounded observation, never authority |

There are no separate assignment contract or receipt files. MCP stores the verified worker-report hash in `delegation.json`. Terminal output and Herdr metadata are observations, not reports or decisions. Never place secrets in any audit or control channel.

You hold write access to every lane report, and the only content that is yours to add is a response block: a `[ORCH Response]` heading line, then the assignment ID, the judgment, the grounds, and any changed conditions. A completion or failure block is the worker's word and only the worker's; writing one yourself fabricates a settlement MCP will hash and store under your birth record. The write is possible, attributable, and permanent — that is the whole guarantee, so do not spend it.

## Responsibility routing

A responsibility key names durable direction, ownership, and context. Exact responsibility reuse is the default. There is no fixed worker-count ceiling.

Each lane has at most one active assignment and one FIFO queue. A busy lane queues a same-responsibility assignment; busyness is not a reason to create another worker.

An additional lane for the same responsibility requires one bounded separation witness: `direction`, `ownership`, or `dependency`. The witness contains a short `reason` and an existing `conflicts_with_worker_id`. No scoring or automatic decomposition applies. Never allocate a new worker number to bypass ambiguous responsibility, identity, topology, or session ownership.

## Canonical assignment

Assignment IDs match `^A-(?!0+$)[0-9]{3,}$`. ORCH writes exactly `<run>/a2a/assignments/<assignment_id>.md` as bounded UTF-8 with LF line endings.

Frontmatter contains, in order:

1. `assignment_id`
2. `responsibility_key`
3. `profile`

The body contains, in order:

1. `# Goal`
2. `# Completion conditions`
3. `# Write ownership`
4. `# Dependencies`
5. `# User boundaries`

The final four sections contain one or more bounded Markdown bullets. The artifact becomes immutable when submitted. `herdr_assignment.add` receives its exact SHA-256 as `instructions_sha256`.

## Public MCP contract

The public surface contains exactly five composite tools. Every action receives `track_id` and `run_id`.

### `herdr_track`

| Action | Required action-specific fields | Effect |
|---|---|---|
| `open` | `cwd`, bounded `mandate` | the single atomic birth: space, run layout, mandate, pre-aligned ORCH spawn, birth record; the opening session is retired for this track |
| `init` | `cwd`; optional `reset_of` | legacy layout for reset siblings and handoff targets |
| `inspect` | none | returns bounded delegation, ORCH, and budget observations |
| `start_orchestrator` | none | legacy spawn; refused on a run that carries a creator record |
| `budget_extend` | `justification` (`done`, `remaining`, `why_more`); optional `requested_tokens`, `wait` | records the justification, spawns a clean auditor, lands its verdict |
| `revive` | optional `mode` (`resume` default, `rebirth`) | resumes the recorded birth session, or starts generation+1 with the user's written approval |
| `close` | fresh `expected_registry_revision` | fresh-inspects and safely closes every settled lane, all-or-nothing |

### `herdr_assignment`

| Action | Required action-specific fields | Effect |
|---|---|---|
| `preflight` | `assignment_id`, `responsibility_key` | validates the canonical draft's grammar before immutability, returns its server-computed `instructions_sha256` and configured `authoring` skill routes, and never mutates state |
| `add` | `assignment_id`, `responsibility_key`, `instructions_sha256`; optional `separation`, `wait` | reuses, queues, or creates a lane and dispatches the canonical assignment |
| `wait` | `assignment_id`; optional `wait` | waits on the active assignment without mutation on timeout |

There is no response action. Answering a worker — a decision request, a ruling, or a worker genuinely blocked on input — is always an `[ORCH Response]` append to its report followed by `herdr_message {action:"wake_worker"}`; the wake is pane input, so it reaches an idle worker and an input-waiting one alike.

The `wait` field named in the tables above is an object: `{until: [...], timeout_ms: N}`. Its `until` values are *agent* states — `idle`, `done`, `blocked` — a separate vocabulary from assignment state; request all three that apply, because an OMP worker commonly reports `done` at a turn boundary, not only `idle`. `timeout_ms` is 1,000–300,000; the server clamps one call's effective wait, so compose longer logical waits by repeating bounded `wait` calls. Waiting discipline: settle on wake messages plus bounded `wait` verification, never fixed sleep loops — a sleep both overshoots finished work and undershoots slow work. Assignment state, the other vocabulary, is exactly `queued | prompting | working | blocked | completed | failed | ambiguous`.

### `herdr_worker`

| Action | Required action-specific fields | Effect |
|---|---|---|
| `list` | optional `responsibility_key` | lists bounded responsibility lanes |
| `inspect` | `worker_id`; optional `output_lines` 1–200 | freshly observes one registry-owned worker |
| `resume` | `worker_id`, exact `expected_session_id` | reconciles only the verified official session |
| `close` | `worker_id`, exact `expected_session_id`, fresh `expected_state_change_seq` | safely closes a settled responsibility lane |

Callers never supply raw Herdr targets, arbitrary paths, argv, terminal commands, or generic close operations.

### `herdr_message`

| Action | Required action-specific fields | Effect |
|---|---|---|
| `wake_orch` | `assignment_id`, `boundary` from `completed`/`failed`/`blocked`/`decision-request` | worker-sent doorbell to this run's born ORCH |
| `wake_peer` | `to_worker_id` | doorbell to a registered peer lane after a plan-authorized channel append |
| `wake_worker` | `to_worker_id` | ORCH-to-own-worker doorbell after appending an `[ORCH Response]` to the lane report |
| `notify_run` | `to_track_id`, `to_run_id` | ORCH-to-ORCH bell, refused unless this run's inter-run channel document for that target already exists |

Every doorbell points at a document and carries no content of its own. The server composes every delivered text and resolves targets from birth records and the worker registry; callers never supply prompt text, panes, or agent names. Delivery is a soft observation (`data.delivery`: `delivered`, `rejected_blocked`, `target_unresolved`, `failed`) and every attempt is appended to the sending run's `a2a/messages.jsonl`. Only invalid input hard-errors — including a bell whose document does not exist yet, which is the caller skipping the append.

### `herdr_friction`

| Action | Required action-specific fields | Effect |
|---|---|---|
| `report` | `kind`, `reporter`, one-line `summary` ≤500 chars; optional `tool`, `error_code`, `evidence`, run coordinates | appends one standardized observation to the global local log |
| `list` | optional `kind`, `fingerprint`, `limit` | grouped inspection of prior reports |

Report as `agent` only after resolving or abandoning a difficulty where the contract itself — not the call's input — was the obstacle. Never report every error.

### Advisory skill routes

Configuration may declare `skill_routing.rules` mapping boundaries (`plan`, `authoring`, `dispatch`, `completion`, `settlement`, `reset`) and surfaces (`orch`, `worker`) to installed skill names. Matching routes are delivered deterministically: `init` results carry `plan`/`authoring` (plus `reset` on a sibling reset), `preflight` results carry `authoring`, the dispatch prompt carries worker-surface `dispatch`/`completion` routes, and terminal assignment results carry `settlement`. When a result carries `skill_routes`, read each routed skill that is installed — resolve the name via `skill://<name>` or the runtime's skill catalog — and apply it before proceeding at that boundary. A missing skill is a no-op. Routes are advisory text only — never invocation proof, settlement condition, or authority over scope, ownership, or lifecycle.

## Dispatch and settlement judgment

`herdr_assignment.add`:

1. verifies the immutable assignment path, grammar, and hash;
2. selects exact responsibility reuse, FIFO queueing, or a justified separated lane;
3. ensures the lane with the assignment's configured profile;
4. verifies bootstrap identity before prompt;
5. records prompt intent before sending a pointer to the canonical assignment and `protocol-worker.md`;
6. waits for a natural boundary;
7. verifies persisted session/model identity after prompt;
8. checks the worker report for settlement.

ORCH judges settlement only from an exact final report block headed `[Assignment Completion: A-NNN]`, followed by one blank line and exactly one `status: completed` or `status: failed` line. Settlement stores the full report SHA-256 and completion timestamp, transitions the assignment to its terminal state, returns the lane to `idle`, and promotes the FIFO head.

Assignment completion never closes the tab or official OMP session. The worker remains available for another assignment with the same responsibility.

Workers send one `herdr_message {action:"wake_orch"}` after a completion block or a decision request. A message is a non-authoritative doorbell delivered as Herdr pane input: on receipt, verify through `herdr_assignment wait` or `herdr_worker inspect` and judge settlement only from the report. Prefer event-driven waiting — dispatch, continue other work, and settle on wake — over long polling loops.

ORCH↔ORCH conversation lives in one append-only document per direction, owned by the run that writes it: `a2a/orch-to-<to_track_id>_<to_run_id>.md`. Append your entry — the kind (`fact`, `bottleneck`, `request`, `handoff`) and one bounded line, plus any bounded body — then ring `herdr_message {action:"notify_run", to_track_id, to_run_id}`. The bell carries no content and is refused when that document does not exist. The counterpart answers in its own reverse channel and rings back; a handoff is simply the channel's first conversation and the counterpart's append is its signature. Resource contention between runs is negotiated in the same two documents and each side records the agreement it accepted; on failed negotiation both sides stop and raise decision requests to their own users. The server does not enforce inter-run contracts — that is a named non-goal, not an oversight.

## Blocked, timeout, and ambiguous operations

A worker that blocks or posts a decision request is answered by an `[ORCH Response]` append to its report plus `herdr_message {action:"wake_worker"}`. There is no exact-sequence response path any more: the report append is the authority and the wake is only the pointer.

A `wait` whose window elapses returns a normal `timed_out: true` observation with the fresh lane state — it has no effect, is not an error, and may be repeated. A prompt, response, resume, or close timeout may have changed external state and is never replayed blindly.

Recovery order:

1. inspect the assignment and worker;
2. verify responsibility routing, registry ownership, official session, workspace/tab/root-pane identity, and live sequence;
3. verify the operation fingerprint, report, and bounded observation;
4. continue from a proved effect or retry only after proved absence;
5. preserve all coordinates when effect or ownership remains ambiguous.

Potentially effected assignment operations converge on the single `ambiguous` state with bounded replay facts. Do not invent additional public states.

## Observation, focus, resume, and close

Herdr observation metadata—`responsibility`, `assignment`, and `assignment-state`—is display-only. It never changes Herdr semantic agent state and is not contract, settlement, or identity authority.

Resume uses only the exact registry-recorded official OMP JSONL after persisted model/session verification and duplicate checks. Focus restoration only reverses displacement onto registry-owned coordinates; unrelated current focus wins.

Safe worker close requires the exact registry root pane plus only structurally verified Herdr Sidebar panes. Track close rejects the entire operation if any lane is active, blocked, ambiguous, identity-conflicted, or unsafe. No public operation closes the retained workspace.

## Decisions and escalation

Workers resolve from their assignment, `plan.md`, canonical project documents/settings, and code. ORCH alone changes scope, ownership, priority, approval, and completion conditions. Peer files carry only existing facts, readiness, dependencies, quiet windows, and compatibility observations.

Escalate to the user only for plan-marked user decisions, irreversible actions outside registry-owned workers, shared governance, secrets/authentication/account access, or judgment only the user can supply.

## Verification, reset, and handoff

ORCH independently reproduces material claims and runs integration verification once at the integration boundary.

A sibling reset uses `herdr_track {action:"init", reset_of:{...}}` at a different coordinate. It copies planning context, not truth. Revalidate inherited evidence; close only freshly proved safe settled source lanes; preserve active or unsafe source lanes.

The built-in target ORCH role is `@default`; configuring a planning-grade role such as `@plan` with elevated thinking is recommended. A handoff writes its first entry into this run's `a2a/orch-to-<target_track>_<target_run>.md` (kind `handoff`), using the `handoff.md` observation list bundled with the delegation skill as the body — it is a checklist of what to state, not a file to copy into the run. Point the target's `orchestrator-instructions.md` at that channel document, then start the target with `herdr_track {action:"start_orchestrator"}` and inspect before judgment or recovery. The target acks in its own reverse channel and rings back; that append is the signature.

## Budget: a justification cadence

Every guarded op meters this run — your session plus every lane session, from the official OMP JSONL, on a generative basis, plus wall clock since the track opened — and judges it against the cap. Crossing the cap parks the run: an explicit state with a named reason, an entry in `budget-ledger.md`, and a `budget-parked:<reason>` marker on your pane name. Nothing is killed.

While parked, only the landing allowlist runs: `herdr_assignment wait`, `herdr_worker close`, `herdr_track close`, `herdr_track budget_extend`, every doorbell, and every read-only action. A queued head is not dispatched — that is new work — and `add` and `resume` fail `budget_parked`. The run resumes by itself on the next guarded op whose judgment is back under the ceiling.

`herdr_track {action:"budget_extend"}` costs a bounded justification (done / remaining / why more, 500 characters each) and buys nothing by itself. Covenants: at most +50% of what is granted per extension, and no extension within 15 minutes of the last. The server — never you — spawns a clean auditor session that judges your run documents against the registry's machine facts and appends a verdict; a grant moves both tokens and wall clock, a deny ends the ladder at the user. You cannot address the auditor, and silence never becomes budget. Keep `plan.md`, the lane reports, and `evidence.md` current: the auditor reads them, so stale documents cost budget.

`budget-clamp.json` is the user's file and can only lower the ceiling; clamping to 0 is the kill switch. Never write it, and never write the ledger.

## Revival

A birth record outlives the session it names. `herdr_track {action:"revive"}` resumes the recorded birth session with its context and creates no generation; `mode: "rebirth"` starts generation+1 with nothing inherited and is refused unless the user has written `rebirth-approval.json` naming exactly that generation, the mandate and `plan.md` are non-empty, no assignment is `ambiguous`, and the old ORCH is not live. The server checks that file's contents, never its authorship — writing it yourself is a forgery, not an approval. A reborn generation inherits the run's metered spend, so rebirth is not a way to reset the budget.
