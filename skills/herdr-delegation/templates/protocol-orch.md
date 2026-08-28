# ORCH protocol — <track_id>/<run_id>

Read `protocol.md` first. This document contains the rules for the OMP orchestrator (**ORCH**).

## Role and actors

ORCH decomposes work, chooses responsibility routing, writes plans and assignments, resolves judgment, independently verifies results, and performs recovery. A responsibility worker is a persistent OMP main session in one registry-owned tab and retains context across assignments with the same responsibility. An assignment is one immutable work unit routed to a lane. Host OMP task/subagents handle bounded mechanical work outside the Herdr registry and model-verification contract. The user supplies only decisions that cross the declared escalation boundary and never relays messages, wakes workers, or performs recovery.

Workers share the project `cwd`. Concurrent code-editing workers require disjoint write ownership; overlapping edits are serialized.

## Identity, storage, and model configuration

- Run identity is `(track_id, run_id)`; every tool call uses those coordinates rather than a model-supplied path.
- `storage.root` comes from strict user or project `herdr-delegator.json` configuration and must be absolute.
- `herdr_track {action:"init"}` resolves `<storage.root>/<track_id>/<run_id>`, writes the strict run manifest and the three bundled protocol documents, creates `a2a/`, and updates the tool-owned index.
- ORCH authors `plan.md` and assignment artifacts after initialization.
- Tool-owned manifests, indexes, `a2a/herdr-workers.json`, `a2a/delegation.json`, and locks are never edited, moved, copied, or unlocked.

Configuration stores bounded OMP role aliases, never concrete model IDs. The built-in orchestrator role is `@default`; worker profiles `default`, `task`, and `slow` select `@default` so every built-in resolves without user configuration. A configured role may replace any built-in role.

ORCH selects each assignment profile by work characteristics: `default` for dialogue-faithful, meticulous language work; `task` for the best artifact under a clear specification; and `slow` for the deepest, most careful reasoning on hard problems where cost is secondary. Cost-efficient small mechanical work routes to host OMP task/subagents, so no persistent lane profile exists for it. A planning-grade orchestrator prioritizes judgment quality over cost.

The bridge-only OMP extension publishes session-scoped runtime facts. The stdio MCP server derives those facts from the verified Herdr caller pane and active OMP agent directory. Before mutation, bridge facts and Herdr bootstrap metadata must agree on session, pane, provider/model, thinking, nonce, and freshness. After the first prompt boundary, persisted JSONL must also agree on session, provider/model, thinking, and fallback. Missing, stale, unsafe, duplicated, or conflicting identity fails closed.

## Durable file authority

| Coordinate | Writer | Authority |
|---|---|---|
| `run.json`, `reset.json`, `<storage.root>/index.json` | `herdr_track` | deterministic run identity, reset lineage, and storage index |
| `protocol.md`, `protocol-orch.md`, `protocol-worker.md` | `herdr_track` | byte-identical bundled protocol set |
| `plan.md`, `evidence.md` | ORCH | goal, routing, decisions, and independent verification |
| `a2a/assignments/A-NNN.md` | ORCH | one immutable assignment contract and instruction source |
| `a2a/w<N>-report.md` | worker `w<N>` | append-only evidence, result, decision request, and completion block |
| `[ORCH Response]` report blocks | ORCH | decision, acceptance, or recovery judgment |
| `a2a/w<N>-to-w<M>.md` | declared sender | append-only peer facts for a plan-authorized directional channel |
| `a2a/delegation.json` | MCP | responsibility routing, lane and assignment state, hashes, and timestamps |
| `a2a/herdr-workers.json` | lifecycle authority | workspace, tab, pane, official session, model verification, and guarded close state |
| `orchestrator-instructions.md`, `orchestrator-report.md` | source ORCH, target ORCH | optional target-ORCH startup and result |

There are no separate assignment contract or receipt files. MCP stores the verified worker-report hash in `delegation.json`. Terminal output and Herdr metadata are observations, not reports or decisions. Never place secrets in any audit or control channel.

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

The public surface contains exactly four composite tools. Every action receives `track_id` and `run_id`.

### `herdr_track`

| Action | Required action-specific fields | Effect |
|---|---|---|
| `init` | `cwd`; optional `reset_of` | initializes or reconciles deterministic storage |
| `inspect` | none | returns bounded delegation and ORCH observations |
| `start_orchestrator` | none | starts or reconciles the configured OMP ORCH |
| `close` | fresh `expected_registry_revision` | fresh-inspects and safely closes every settled lane, all-or-nothing |

### `herdr_assignment`

| Action | Required action-specific fields | Effect |
|---|---|---|
| `preflight` | `assignment_id`, `responsibility_key` | validates the canonical draft's grammar before immutability, returns its server-computed `instructions_sha256` and configured `authoring` skill routes, and never mutates state |
| `add` | `assignment_id`, `responsibility_key`, `instructions_sha256`; optional `separation`, `wait` | reuses, queues, or creates a lane and dispatches the canonical assignment |
| `wait` | `assignment_id`; optional `wait` | waits on the active assignment without mutation on timeout |
| `respond` | `assignment_id`, fresh `expected_state_change_seq`, bounded `response` | answers only a freshly proved blocked assignment |

`wait.until` values are `idle`, `done`, and `blocked` — request all three that apply; an OMP worker commonly reports `done` at a turn boundary, not only `idle`. `timeout_ms` is 1,000–300,000; the server clamps one call's effective wait, so compose longer logical waits by repeating bounded `wait` calls. Waiting discipline: settle on wake messages plus bounded `wait` verification, never fixed sleep loops — a sleep both overshoots finished work and undershoots slow work. A text response is bounded. A key response uses only the MCP allowlist. Assignment state is exactly `queued | prompting | working | blocked | completed | failed | ambiguous`.

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
| `wake_orch` | `assignment_id`, `boundary` from `completed`/`failed`/`blocked`/`decision-request` | worker-sent doorbell to this run's recorded ORCH wake target |
| `wake_peer` | `to_worker_id` | doorbell to a registered peer lane after a plan-authorized channel append |
| `notify_run` | `to_track_id`, `to_run_id`, `kind`, one-line `note` ≤500 chars | bounded orch-to-orch note delivered to another run's ORCH |

The server composes every delivered text and resolves targets from run records; callers never supply prompt text, panes, or agent names. Delivery is a soft observation (`data.delivery`: `delivered`, `rejected_blocked`, `target_unresolved`, `failed`) — only invalid input is an error — and every attempt is appended to the sending run's `a2a/messages.jsonl`.

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

ORCH↔ORCH communication uses `herdr_message {action:"notify_run", to_track_id, to_run_id, kind, note}` — not only for handoff: a fact discovered in this track, a bottleneck observed in another, or a bounded request all qualify. `kind` is `fact | bottleneck | request | handoff` and `note` is one bounded line. The receiving ORCH treats the note as a pointer, verifies against that run's documents, and records anything durable in its own run. Delivery is a soft observation: a stalled channel is a silent failure, so every attempt lands in the sending run's `a2a/messages.jsonl` — check it when flow stops. A message never replaces `start_orchestrator`, inspection, or report judgment.

## Blocked, timeout, and ambiguous operations

Before a response, ORCH fresh-inspects the worker and pins the exact blocked `state_change_seq`. Use text only for free-form input and allowlisted keys only for an inspected dialog.

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

The built-in target ORCH role is `@default`; configuring a planning-grade role such as `@plan` with elevated thinking is recommended. Start it with `herdr_track {action:"start_orchestrator"}` and inspect before judgment or recovery. Complete `handoff.md` as state transfer; its situational appendices are used only when applicable.
