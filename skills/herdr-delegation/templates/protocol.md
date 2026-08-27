# a2a communication protocol — <track_id>/<run_id>

This deterministic run is the durable channel between the OMP orchestrator (**ORCH**) and persistent Herdr responsibility workers. Documents carry contracts, decisions, and results. MCP carries live control pointers. Herdr exposes responsibility, assignment, session, and live-state observations. None substitutes for another.

The user does not relay messages, wake workers, or perform recovery.

## Identity and storage

- Official support is OMP-only.
- Run identity is `(track_id, run_id)`. Tool calls use those coordinates, never a model-supplied run path.
- `storage.root` comes from strict user or project `herdr-delegator.json` configuration and must be absolute.
- `herdr_track {action:"init"}` resolves `<storage.root>/<track_id>/<run_id>`, writes the strict run manifest and this protocol, creates `a2a/`, and updates the tool-owned index.
- ORCH authors `plan.md` and assignment artifacts after initialization.
- Tool-owned manifests, indexes, `a2a/herdr-workers.json`, `a2a/delegation.json`, and locks are never edited, moved, copied, or unlocked by ORCH or workers.

Configuration stores bounded OMP role aliases, never concrete model IDs. The built-in orchestrator role is `@default`; worker profiles `default` and `slow` select `@default` and `@slow`. A configured role may replace any built-in role.

The bridge-only OMP extension publishes session-scoped runtime facts. The stdio MCP server derives those facts from the verified Herdr caller pane and active OMP agent directory. Before mutation, bridge facts and Herdr bootstrap metadata must agree on session, pane, provider/model, thinking, nonce, and freshness. After the first prompt boundary, persisted JSONL must also agree on session, provider/model, thinking, and fallback. Missing, stale, unsafe, duplicated, or conflicting identity fails closed.

## Actors

- **ORCH:** decomposes work, chooses responsibility routing, writes plans and assignments, resolves judgment, verifies results independently, and performs recovery.
- **Responsibility worker (`w1`, `w2`, ...):** a persistent OMP main session in one registry-owned tab. It keeps context across assignments with the same responsibility.
- **Assignment (`A-NNN`):** one immutable unit of work routed to a responsibility lane.
- **Host OMP task/subagent:** bounded mechanical work outside the Herdr registry and model-verification contract.
- **User:** supplies only decisions that cross the declared escalation boundary.

Workers share the project `cwd`. Concurrent code-editing workers require disjoint write ownership. Serialize overlapping edits.

## Durable file authority

| Coordinate | Writer | Authority |
|---|---|---|
| `run.json`, `reset.json`, `<storage.root>/index.json` | `herdr_track` | Deterministic run identity, reset lineage, and storage index |
| `protocol.md` | `herdr_track` | Byte-for-byte bundled protocol |
| `plan.md`, `evidence.md` | ORCH | Goal, routing, decisions, and independent verification |
| `a2a/assignments/A-NNN.md` | ORCH | One immutable assignment contract and instruction source |
| `a2a/w<N>-report.md` | Worker `w<N>` | Append-only evidence, result, decision request, and completion block |
| `[ORCH Response]` report blocks | ORCH | Decision, acceptance, or recovery judgment |
| `a2a/w<N>-to-w<M>.md` | Declared sender | Append-only peer facts for a plan-authorized directional channel |
| `a2a/delegation.json` | MCP | Minimal responsibility routing, lane state, assignment state, hashes, and timestamps |
| `a2a/herdr-workers.json` | Lifecycle authority | Workspace, tab, pane, official session, model verification, and guarded close state |
| `orchestrator-instructions.md`, `orchestrator-report.md` | Source ORCH, target ORCH | Optional target-ORCH startup and result |

There are no separate assignment contract or receipt files. MCP stores the verified worker-report hash in `delegation.json`.

Terminal output and Herdr metadata are observations, not reports or decisions. Never place secrets in any audit or control channel.

## Responsibility routing

A responsibility key names durable direction, ownership, and context. Exact responsibility reuse is the default. There is no fixed worker count ceiling.

Each lane has at most one active assignment and a FIFO queue. A busy lane queues a same-responsibility assignment; busyness is not a reason to create another worker.

An additional lane for the same responsibility requires one bounded separation witness:

- `direction`
- `ownership`
- `dependency`

The witness contains a short `reason` and an existing `conflicts_with_worker_id`. No scoring or automatic decomposition applies. Never allocate a new worker number to bypass ambiguous responsibility, identity, topology, or session ownership.

## Canonical assignment

Assignment IDs match `^A-(?!0+$)[0-9]{3,}$`. ORCH writes exactly:

```text
<run>/a2a/assignments/<assignment_id>.md
```

The file is bounded UTF-8 with LF line endings. Frontmatter contains, in order:

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

The public surface contains exactly three composite tools.

### `herdr_track`

| Action | Required action-specific fields | Effect |
|---|---|---|
| `init` | `cwd`; optional `reset_of` | Initializes or reconciles deterministic storage |
| `inspect` | none | Returns bounded delegation and ORCH observations |
| `start_orchestrator` | none | Starts or reconciles the configured OMP ORCH |
| `close` | fresh `expected_registry_revision` | Fresh-inspects and safely closes every settled lane, all-or-nothing |

Every action also receives `track_id` and `run_id`.

### `herdr_assignment`

| Action | Required action-specific fields | Effect |
|---|---|---|
| `add` | `assignment_id`, `responsibility_key`, `instructions_sha256`; optional `separation`, `wait` | Reuses, queues, or creates a lane and dispatches the canonical assignment |
| `wait` | `assignment_id`; optional `wait` | Waits on the active assignment without mutation on timeout |
| `respond` | `assignment_id`, fresh `expected_state_change_seq`, bounded `response` | Answers only a freshly proved blocked assignment |

`wait.until` values are `idle`, `done`, and `blocked`; `timeout_ms` is 1,000–300,000. A text response is bounded. A key response uses only the MCP allowlist.

Assignment state is exactly:

```text
queued | prompting | working | blocked | completed | failed | ambiguous
```

### `herdr_worker`

| Action | Required action-specific fields | Effect |
|---|---|---|
| `list` | optional `responsibility_key` | Lists bounded responsibility lanes |
| `inspect` | `worker_id`; optional `output_lines` 1–200 | Freshly observes one registry-owned worker |
| `resume` | `worker_id`, exact `expected_session_id` | Reconciles only the verified official session |
| `close` | `worker_id`, exact `expected_session_id`, fresh `expected_state_change_seq` | Safely closes a settled responsibility lane |

Every action also receives `track_id` and `run_id`. Callers never supply raw Herdr targets, arbitrary paths, argv, terminal commands, or generic close operations.

## Dispatch and settlement

`herdr_assignment.add`:

1. verifies the immutable assignment path, grammar, and hash;
2. selects exact responsibility reuse, FIFO queueing, or a justified separated lane;
3. ensures the lane with the assignment's configured profile;
4. verifies bootstrap identity before prompt;
5. records prompt intent before sending a pointer to the canonical artifact;
6. waits for a natural boundary;
7. verifies persisted session/model identity after prompt;
8. checks the worker report for settlement.

A worker completes by appending:

```markdown
[Assignment Completion: A-001]

status: completed
```

or exactly one `status: failed` line in that block. Settlement stores the full report SHA-256 and completion timestamp, transitions the assignment to its terminal state, returns the lane to `idle`, and promotes the FIFO head.

Assignment completion never closes the tab or official OMP session. The worker remains available for another assignment with the same responsibility.

## Blocked, timeout, and ambiguous state

Before a response, ORCH fresh-inspects the worker and pins the exact blocked `state_change_seq`. Use text only for free-form input and allowlisted keys only for an inspected dialog.

A wait timeout has no effect and may be repeated. A prompt, response, resume, or close timeout may have changed external state. Never replay it blindly.

Recovery order:

1. inspect the assignment and worker;
2. verify responsibility routing, registry ownership, official session, workspace/tab/root-pane identity, and live sequence;
3. verify the operation fingerprint, report, and bounded observation;
4. continue from a proved effect or retry only after proved absence;
5. preserve all coordinates when effect or ownership remains ambiguous.

Potentially effected assignment operations converge on the single `ambiguous` state with bounded replay facts. Do not invent additional public states.

## Observation, focus, resume, and close

Herdr observation metadata is display-only:

- `responsibility`
- `assignment`
- `assignment-state`

It never changes Herdr semantic agent state and is not contract, settlement, or identity authority.

Resume uses only the exact registry-recorded official OMP JSONL after persisted model/session verification and duplicate checks. Focus restoration only reverses displacement onto registry-owned coordinates; unrelated current focus wins.

Safe worker close requires the exact registry root pane plus only structurally verified Herdr Sidebar panes. Track close rejects the entire operation if any lane is active, blocked, ambiguous, identity-conflicted, or unsafe. No public operation closes the retained workspace.

## Decisions and escalation

Workers first read their assignment, `plan.md`, canonical project documents/settings, and code. They proceed when evidence is clear and within ownership. Otherwise they append one batched `[ORCH Decision Request]` and continue independent work.

ORCH changes scope, ownership, priority, approval, and completion conditions. Peer files carry only existing facts, readiness, dependencies, quiet windows, and compatibility observations.

Escalate to the user only for plan-marked user decisions, irreversible actions outside registry-owned workers, shared governance, secrets/authentication/account access, or judgment only the user can supply.

## Verification, reset, and handoff

ORCH independently reproduces material claims and runs integration verification once at the integration boundary.

A sibling reset uses `herdr_track {action:"init", reset_of:{...}}` at a different coordinate. It copies planning context, not truth. Revalidate inherited evidence; close only freshly proved safe settled source lanes; preserve active or unsafe source lanes.

The target ORCH uses the configured orchestrator role, not a fixed `@plan` role. Start it with `herdr_track {action:"start_orchestrator"}` and inspect before judgment or recovery.

## Common worker rules

- Obey exact write ownership and prohibitions.
- Do not delegate or run project-wide commands unless the assignment permits it.
- Record out-of-scope gaps; do not repair them in place.
- Append durable results only to your own report.
- Keep the assignment completion block exact.
- After completion, remain idle and keep the tab/session open.
- Do not create competing project conventions.
- Keep secrets out of all channels.
- Project-specific additions: <project rules>
