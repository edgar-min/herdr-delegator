---
name: herdr-delegation
description: Delegate substantial independent work from OMP to persistent Herdr responsibility lanes with deterministic storage, immutable assignments, verified sessions, recovery, and guarded closure.
version: 4.0.0
---

# Herdr delegation

The session using this skill is the orchestrator (**ORCH**). ORCH owns decomposition, routing, judgment, verification, and recovery. Herdr workers are persistent responsibility lanes: an assignment is work routed to a lane, not the worker's identity.

Official support is OMP-only. The plugin package contains a bridge-only OMP extension, a Bun stdio MCP server advertised by the package-root `.mcp.json`, and this bundled skill. Do not design or infer another agent adapter.

## 1. Choose the execution surface

Use the host OMP task/subagent mechanism for bounded mechanical work. It creates no Herdr worker, durable assignment, or plugin model-verification claim.

Use Herdr for substantial independent work that benefits from persistent context, explicit ownership, exact-session resume, blocked-state handling, or durable assignment routing.

Worker tabs share the configured project `cwd`. Parallelize only disjoint ownership. Serialize overlapping code edits in one shared working directory.

## 2. Configure the plugin

At least one `herdr-delegator.json` layer must set an absolute `storage.root`:

- user: `${PI_CODING_AGENT_DIR}/herdr-delegator.json`, or `~/.omp/agent/herdr-delegator.json` when unset;
- project: `<cwd>/.omp/herdr-delegator.json`.

Project values override user values. A run-local `<run>/herdr-delegator.json` may override model-profile leaves but may not relocate the run.

The built-in profiles are:

- orchestrator: role `@default`, thinking `inherit`;
- worker `default`: role `@default`, thinking `inherit`;
- worker `slow`: role `@slow`, thinking `inherit`.

Configuration may select another bounded OMP role alias or worker profile. It never stores a concrete model ID. The OMP bridge resolves configured roles to concrete provider/model facts and publishes the current session, model, thinking, configuration hashes, and nonce through a session-scoped mode-0600 fact file. MCP derives that file from the verified caller pane and active OMP agent directory; callers never supply its path.

Launches remain fail-closed behind two gates:

1. **Bootstrap gate:** the bridge and Herdr pane metadata must agree on official session, pane, provider/model, thinking, nonce, and freshness before prompting.
2. **Persisted gate:** after the first prompt boundary, the official JSONL must agree on session, provider/model, thinking, and fallback before success or later resume.

Never send a synthetic prompt to create JSONL. Never accept a model-supplied session path, launch argv, pane, tab, or workspace target.

## 3. Initialize a deterministic run

Run identity is `(track_id, run_id)`. Both coordinates match:

```text
^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$
```

Call:

```json
{"track_id":"example-track","run_id":"implementation","action":"init","cwd":"/absolute/project/path"}
```

`herdr_track` resolves `<storage.root>/<track_id>/<run_id>` and initializes:

```text
<run>/
  run.json
  protocol.md
  a2a/
```

It also updates the tool-owned storage index. ORCH authors `plan.md` and work artifacts afterward. A sibling reset adds `reset_of: {track_id, run_id}` and copies the source plan under the fixed `close-settled-preserve-active` and `revalidate-before-import` policies.

Never edit tool-owned manifests, indexes, `a2a/herdr-workers.json`, `a2a/delegation.json`, or their locks.

## 4. Plan responsibilities and assignments

`plan.md` states:

- goal and observable completion conditions;
- prohibitions and user-confirmed boundaries;
- responsibility keys and exact write ownership;
- dependencies, readiness signals, peer channels, and quiet windows;
- ORCH-owned integration verification;
- reset lineage when present.

A responsibility key names durable context and ownership. Reuse an existing exact responsibility before creating another lane. There is no fixed worker ceiling.

A new lane for the same responsibility is valid only when `direction`, `ownership`, or `dependency` requires separation. Supply:

```json
{
  "kind": "ownership",
  "reason": "short bounded reason",
  "conflicts_with_worker_id": "w1"
}
```

Do not use scoring, automatic decomposition, lane proliferation because a worker is busy, or a new worker number to bypass identity uncertainty. One lane has at most one active assignment and a FIFO queue.

## 5. Write the immutable assignment

Each assignment is one ORCH-owned Markdown file:

```text
<run>/a2a/assignments/A-NNN.md
```

Assignment IDs match `^A-(?!0+$)[0-9]{3,}$`. The file is UTF-8 with LF line endings, at most 64 KiB, and uses this exact order:

```markdown
---
assignment_id: A-001
responsibility_key: documentation
profile: default
---
# Goal

Describe the complete assignment.
# Completion conditions

- Observable result
# Write ownership

- /absolute/or/project-relative/path
# Dependencies

- Dependency and readiness, or none
# User boundaries

- User-confirmed decision, or none
```

Every list section contains bounded `- ` bullets. After dispatch, the file is immutable. The SHA-256 passed to MCP is named `instructions_sha256` because the single artifact is the worker's durable instruction contract.

Workers append durable evidence and results only to `a2a/w<N>-report.md`. Completion requires:

```markdown
[Assignment Completion: A-001]

status: completed
```

or exactly one `status: failed` line in that block. MCP stores the full report hash and completion time in `a2a/delegation.json`; there is no separate contract or receipt file.

## 6. Use the three MCP tools

The public MCP surface is exactly:

- `herdr_track`
- `herdr_assignment`
- `herdr_worker`

### `herdr_track`

- `init`: `track_id`, `run_id`, `cwd`, optional `reset_of`.
- `inspect`: `track_id`, `run_id`.
- `start_orchestrator`: `track_id`, `run_id`.
- `close`: `track_id`, `run_id`, fresh `expected_registry_revision`.

Track close is all-or-nothing. It rejects active or blocked lanes and fresh-inspects every close candidate before guarded closure.

### `herdr_assignment`

- `add`: run coordinates, `assignment_id`, `responsibility_key`, exact `instructions_sha256`, optional `separation`, optional `wait`.
- `wait`: run coordinates, `assignment_id`, optional `wait`.
- `respond`: run coordinates, `assignment_id`, fresh `expected_state_change_seq`, and either bounded text or allowlisted keys.

`wait` accepts optional `until` values from `idle`, `done`, `blocked` and `timeout_ms` from 1,000 through 300,000.

`add` selects or creates the responsibility lane, verifies the configured worker profile and session gates, records prompt intent, sends only a pointer to the canonical assignment, waits, verifies persisted identity, and attempts settlement. An exact-responsibility assignment queues instead of spawning when its lane is active.

Assignment state is exactly:

```text
queued | prompting | working | blocked | completed | failed | ambiguous
```

A wait timeout is a no-effect observation. A potentially effected prompt, response, or resume converges on `ambiguous` and must be inspected before any recovery.

### `herdr_worker`

- `list`: run coordinates, optional `responsibility_key`.
- `inspect`: run coordinates, `worker_id`, optional `output_lines` from 1 through 200.
- `resume`: run coordinates, `worker_id`, exact `expected_session_id`.
- `close`: run coordinates, `worker_id`, exact `expected_session_id`, fresh `expected_state_change_seq`.

Use worker operations for lane observation and lifecycle only. Assignment delivery and blocked responses belong to `herdr_assignment`.

## 7. Completion is not closure

When MCP verifies a report completion block, it stores `report_sha256`, marks the assignment `completed` or `failed`, returns the lane to `idle`, and promotes the FIFO head. The worker tab and official OMP session remain open for the next assignment.

Close only when the responsibility lane or track is finished. Fresh inspection must prove registry identity, official session, state sequence, and safe topology. A worker tab may contain only its registry root pane and verified Herdr Sidebar panes. An ambiguous close is never replayed blindly.

Focus restoration is guarded: restore only displacement onto registry-owned coordinates, never unrelated user focus. Record partial restoration as a warning, not operation failure.

## 8. Communication boundaries

- **Documents:** contract, decisions, ownership, durable results, completion, evidence, and handoff.
- **MCP prompt/control:** canonical coordinates and hashes, wait requests, fresh blocked responses, and lifecycle actions.
- **Herdr metadata:** display-only responsibility, assignment, assignment state, session/model attestation, and live status.

Metadata is not contract, settlement, or session authority. Terminal output is not a report.

Workers self-resolve from their assignment, `plan.md`, canonical project documents, and code. They request ORCH judgment only when evidence is absent or conflicting. ORCH escalates to the user only for plan-marked user decisions, irreversible external actions, governance, secrets/account access, or judgment only the user can supply.

## 9. Verify and hand off

ORCH independently reproduces material worker claims and runs integration verification once at the integration boundary. Record acceptance or recovery in `[ORCH Response]` and `evidence.md` when used.

For a handoff, create a sibling run, preserve active or unsafe source lanes, revalidate inherited evidence, complete `templates/handoff.md`, and start the target with `herdr_track {action:"start_orchestrator"}`. The configured orchestrator role is resolved through the same OMP bridge; it is not fixed to `@plan`.

`/reload-plugins` refreshes the skill and MCP server. Validate a changed extension module in a new OMP session.

Do not close this worker merely because its current assignment completed. Keep its tab/session available for the same responsibility unless ORCH explicitly closes the lane or track through the guarded MCP action.
