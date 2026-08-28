---
name: herdr-delegation
description: Delegate substantial independent work from OMP to persistent Herdr responsibility lanes with deterministic storage, immutable assignments, verified sessions, recovery, and guarded closure.
license: Apache-2.0
compatibility: Requires Oh My Pi 18.0.5 or later, Herdr 0.8.2, Bun, and an OMP-managed Herdr integration.
metadata:
  author: edgar-min
  version: "1.2.0"
---

# Herdr delegation

The session using this skill is the orchestrator (**ORCH**). ORCH owns decomposition, routing, judgment, verification, and recovery. Herdr workers are persistent responsibility lanes: an assignment is work routed to a lane, not the worker's identity.

Official support is OMP-only. The Agent Plugins package contains a bridge-only OMP extension under `io.github.edgar-min.herdr-delegator/`, one Bun stdio MCP server declared by package-root `mcp.json`, and this bundled skill. Do not design or infer another agent adapter.

## 1. Choose the execution surface

Use the host OMP task/subagent mechanism for bounded mechanical work. It creates no Herdr worker, durable assignment, or plugin model-verification claim.

Use Herdr for substantial independent work that benefits from persistent context, explicit ownership, exact-session resume, blocked-state handling, or durable assignment routing.

Worker tabs share the configured project `cwd`. Parallelize only disjoint ownership. Serialize overlapping code edits in one shared working directory.

### Optional skill discovery and routing

At planning, assignment-authoring, dispatch, pre-completion, verification, reset, and handoff boundaries, scan the runtime's already available skill catalog for a directly applicable skill from any installed skill pack. Read and invoke only a skill whose own description matches the present work. Missing skills are a no-op: never install, update, emulate, or block on them during a run.

Configuration may declare deterministic advisory skill routes (see section 2). Matching routes appear as `skill_routes` (with an imperative `skill_routes_note`) in tool results and inside the worker dispatch prompt. When a result carries routes, read each installed routed skill — resolve the name via `skill://<name>` or the runtime's skill catalog — and apply it before proceeding at that boundary. Routes raise discovery reliability only; a route never proves a skill ran and is never a settlement or lifecycle condition.

An optional skill remains subordinate to this protocol. It may improve reasoning or an owned artifact, but it never changes scope, authority, write ownership, immutable or tool-owned files, completion grammar, lifecycle state, settlement, or recovery. Preserve user-invoked-only semantics declared by the skill.

## 2. Configure the plugin

At least one `herdr-delegator.json` layer must set an absolute `storage.root`:

- user: `${PI_CODING_AGENT_DIR}/herdr-delegator.json`, or `~/.omp/agent/herdr-delegator.json` when unset;
- project: `<cwd>/.omp/herdr-delegator.json`.

Project values override user values. A run-local `<run>/herdr-delegator.json` may override model-profile and skill-routing leaves but may not relocate the run.

The built-in profiles are:

- orchestrator: role `@default`, thinking `inherit`;
- worker `default`: role `@default`, thinking `inherit`;
- worker `task`: role `@default`, thinking `inherit`;
- worker `slow`: role `@default`, thinking `inherit`.

`@task` and `@slow` are recognized OMP role names but do not resolve without a corresponding `modelRoles` setting, so the built-ins fail safely to `@default`. Configuration may select another bounded OMP role alias or worker profile. It never stores a concrete model ID. The OMP bridge resolves configured roles to concrete provider/model facts and publishes the current session, model, thinking, configuration hashes, and nonce through a session-scoped mode-0600 fact file. MCP derives that file from the verified caller pane and active OMP agent directory; callers never supply its path.

### Profile selection

ORCH picks `profile` for each assignment from the assignment's work characteristics:

| Surface | Selection criterion |
|---|---|
| orchestrator | Top-tier planning and judgment intelligence; decision quality over cost |
| `default` | Dialogue-faithful and meticulous; turns observations into language |
| `task` | Best artifact under a clear specification; language quality is secondary |
| `slow` | Deepest, most careful reasoning for hard problems where cost is secondary |

Cost-efficient small mechanical work routes to host OMP task/subagents, so no persistent lane profile exists for it.

### Session alignment

Guarded mutations fail closed with `orchestrator_model_mismatch` when this session's model or thinking does not match the configured `orchestrator.role` — a fresh OMP session rarely starts on that role's model. At track start, or on that error, ask the user to run `/herdr-align` once (a user-invoked OMP command from this plugin: it switches only this session's model/thinking to the configured role and refreshes bridge attestation), or to relaunch with the `omp --model`/`--thinking` values the error names. Target orchestrators started via `herdr_track start_orchestrator` launch pre-aligned and never need this.

### Skill routing

An optional `skill_routing.rules` array (at most 16 rules) routes installed skills to protocol boundaries:

```json
{
  "skill_routing": {
    "rules": [
      { "boundary": "authoring", "surface": "orch", "skills": ["readchk", "shower"] },
      { "boundary": "completion", "surface": "worker", "skills": ["sip"] }
    ]
  }
}
```

`boundary` is one of `plan`, `authoring`, `dispatch`, `completion`, `settlement`, `reset`. `surface` is `orch` or `worker`. Each rule names 1–8 bounded skill names; the shipped configuration names none. Delivery is deterministic: `herdr_track init` returns `plan`/`authoring` (plus `reset` for a sibling reset) routes, `herdr_assignment preflight` returns `authoring` routes, the dispatch prompt carries `dispatch`/`completion` routes to the worker, and terminal assignment results carry `settlement` routes. Routes are advisory text only — never invocation proof, settlement gate, or authority.

Route only trusted skills: routed names become instructions executed inside ORCH and worker sessions, so treat a routing rule like a dependency declaration. Prefer a vetted skill pack or skills the user wrote themselves, matched to the boundary they improve (context inquiry at `plan`, review at `settlement`). When no rules are configured, suggest this once during planning rather than silently proceeding forever without them.

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

`herdr_track` resolves `<storage.root>/<track_id>/<run_id>` and materializes the three protocol documents byte-identically from their bundled templates:

```text
<run>/
  run.json
  protocol.md
  protocol-orch.md
  protocol-worker.md
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

Every list section contains bounded `- ` bullets. The goal is one Markdown section of at most 4096 characters with no nested H1 heading; put detail into completion conditions or referenced documents. After dispatch, the file is immutable. The SHA-256 passed to MCP is named `instructions_sha256` because the single artifact is the worker's durable instruction contract.

Workers append durable evidence and results only to `a2a/w<N>-report.md`. Completion requires:

```markdown
[Assignment Completion: A-001]

status: completed
```

or exactly one `status: failed` line in that block. MCP stores the full report hash and completion time in `a2a/delegation.json`; there is no separate contract or receipt file.

## 6. Use the five MCP tools

The public MCP surface is exactly:

- `herdr_track`
- `herdr_assignment`
- `herdr_worker`
- `herdr_message`
- `herdr_friction`

### `herdr_track`

- `init`: `track_id`, `run_id`, `cwd`, optional `reset_of`.
- `inspect`: `track_id`, `run_id`.
- `start_orchestrator`: `track_id`, `run_id`.
- `close`: `track_id`, `run_id`, fresh `expected_registry_revision`.

Track close is all-or-nothing. It rejects active or blocked lanes and fresh-inspects every close candidate before guarded closure.

### `herdr_assignment`

- `preflight`: run coordinates, `assignment_id`, `responsibility_key`.
- `add`: run coordinates, `assignment_id`, `responsibility_key`, exact `instructions_sha256`, optional `separation`, optional `wait`.
- `wait`: run coordinates, `assignment_id`, optional `wait`.
- `respond`: run coordinates, `assignment_id`, fresh `expected_state_change_seq`, and either bounded text or allowlisted keys.

`respond` requires a freshly proved blocked worker; responding to a `queued` assignment errors with `assignment_not_prompted` instead of silently succeeding. For a worker that posted an `[ORCH Decision Request]` and idled without blocking, append the ruling to its report and send `herdr_message {action:"wake_worker"}`.

`wait` accepts optional `until` values from `idle`, `done`, `blocked` and `timeout_ms` from 1,000 through 300,000. An elapsed wait window returns a successful observation with `timed_out: true` and the fresh lane state, never an error; compose longer logical waits by repeating bounded calls, and prefer settling on worker wake signals over long polling loops.

`add` selects or creates the responsibility lane, verifies the configured worker profile and session gates, records prompt intent, sends pointers to the canonical assignment and `protocol-worker.md`, waits, verifies persisted identity, and attempts settlement. An exact-responsibility assignment queues instead of spawning when its lane is active. Re-adding an assignment whose lane closed or failed before any prompt rebinds it to a live or fresh lane instead of failing it. When a settlement promotes the FIFO head, the same guarded call dispatches the promoted assignment; a queued head on an idle lane is also dispatched by the next `wait` on it.

`preflight` validates the canonical draft's grammar before immutability and returns the server-computed `instructions_sha256` of the exact validated bytes, bounded section counts, and any configured `authoring` skill routes. It never mutates the registry or any lane; an already-registered assignment returns its immutable state instead.

Assignment state is exactly:

```text
queued | prompting | working | blocked | completed | failed | ambiguous
```

A wait timeout is a no-effect observation surfaced as a `timed_out` result. A potentially effected prompt, response, or resume converges on `ambiguous` and must be inspected before any recovery.

### `herdr_worker`

- `list`: run coordinates, optional `responsibility_key`.
- `inspect`: run coordinates, `worker_id`, optional `output_lines` from 1 through 200.
- `resume`: run coordinates, `worker_id`, exact `expected_session_id`.
- `close`: run coordinates, `worker_id`, exact `expected_session_id`, fresh `expected_state_change_seq`.

Use worker operations for lane observation and lifecycle only. Assignment delivery and blocked responses belong to `herdr_assignment`.

### `herdr_message`

- `wake_orch`: run coordinates, `assignment_id`, `boundary` from `completed`/`failed`/`blocked`/`decision-request` — worker doorbell to the run's recorded ORCH wake target.
- `wake_peer`: run coordinates, `to_worker_id` — doorbell to a registered peer lane after a plan-authorized channel append.
- `wake_worker`: run coordinates, `to_worker_id` — ORCH-to-own-worker doorbell after appending an `[ORCH Response]` to the lane report; for decision-request workers that idled without a formal blocked state.
- `notify_run`: run coordinates, `to_track_id`, `to_run_id`, `kind` from `fact`/`bottleneck`/`request`/`handoff`, one-line `note` ≤500 chars — orch-to-orch note for any cross-run need, not only handoff.

The server composes every delivered text, resolves targets from run records, and transports each message as Herdr pane input — the pane input is what triggers the receiving session. Delivery is a soft observation (`data.delivery`: `delivered`, `rejected_blocked`, `target_unresolved`, `failed`); only invalid input errors, and every attempt is appended to the sending run's `a2a/messages.jsonl`. A stalled flow is a silent failure — check that log. Messages carry no authority: settle only through guarded actions and documents.

### `herdr_friction`

- `report`: `kind` from `contract-gap`/`false-block`/`ambiguous-outcome`/`excessive-steps`/`doc-drift`/`defect`/`papercut`, `reporter` from `agent`/`human`, one-line `summary` ≤500 chars, optional `tool`, `error_code`, `evidence` ≤2000 chars, and run coordinates.
- `list`: optional `kind`, `fingerprint`, `limit` — grouped inspection of prior reports.

Reports append to a global local log (`<agent-dir>/herdr-delegator/friction/friction.jsonl`), never to an external tracker; promotion to issues is a separate human-gated triage pass. Report as `agent` only after resolving or abandoning a difficulty where the contract itself — not the call's input — was the obstacle; a `friction_hint` on a repeated error result marks such a moment. Never report every error. Transcribe a user-observed issue verbatim with `reporter: "human"`. Duplicate symptoms share a `fingerprint`; a report result's `prior_reports` shows how often the same symptom has already been recorded.

## 7. Completion is not closure

When MCP verifies a report completion block, it stores `report_sha256`, marks the assignment `completed` or `failed`, returns the lane to `idle`, and promotes the FIFO head. The worker tab and official OMP session remain open for the next assignment.

Terminal `herdr_assignment` results may include `assignment.settlement` with elapsed time, cumulative session token usage, and advisory unowned-change paths. `herdr_worker inspect` reports activity timing and queue depth; `herdr_track inspect` reports lane/state totals and cumulative settled observations. Treat these as bounded signals for possible over- or under-spend and scope drift. ORCH judges them against the assignment and verified evidence; they never enforce a threshold, attribute work automatically, authorize mutation, or replace settlement and correctness checks.

Close only when the responsibility lane or track is finished. Fresh inspection must prove registry identity, official session, state sequence, and safe topology. A worker tab may contain only its registry root pane and verified Herdr Sidebar panes. An ambiguous close is never replayed blindly.

Focus restoration is guarded: restore only displacement onto registry-owned coordinates, never unrelated user focus. Record partial restoration as a warning, not operation failure.

## 8. Communication boundaries

- **Documents:** contract, decisions, ownership, durable results, completion, evidence, and handoff.
- **MCP prompt/control:** canonical coordinates and hashes, wait requests, fresh blocked responses, and lifecycle actions.
- **Herdr metadata:** display-only responsibility, assignment, assignment state, session/model attestation, and live status.
- **`herdr_message` doorbells:** one bounded server-composed signal after a boundary — workers wake ORCH after a completion block or decision request, plan-authorized peers wake each other after channel appends, and orchestrators exchange bounded cross-run notes. Never authority: the named file alone carries facts.

Metadata is not contract, settlement, or session authority. Terminal output is not a report.

Workers self-resolve from their assignment, `plan.md`, canonical project documents, and code. They request ORCH judgment only when evidence is absent or conflicting. ORCH escalates to the user only for plan-marked user decisions, irreversible external actions, governance, secrets/account access, or judgment only the user can supply.

## 9. Verify and hand off

ORCH independently reproduces material worker claims and runs integration verification once at the integration boundary. Record acceptance or recovery in `[ORCH Response]` and `evidence.md` when used.

A handoff needs no human intervention: the whole bootstrap is four tool-drivable steps run by the source ORCH.

1. `herdr_track {action:"init"}` with the target `track_id`/`run_id` and the same canonical `cwd` (add `reset_of` for a reset sibling). Init lays out the deterministic run and its protocol documents.
2. Write the target's `plan.md`, complete `templates/handoff.md` into the target run, and write `orchestrator-instructions.md` pointing at the handoff document. These are ordinary file writes; both `plan.md` and `orchestrator-instructions.md` must exist before start, and the instruction file is fingerprinted at first prompt and never replayed after change.
3. `herdr_track {action:"start_orchestrator"}` on the target run. The server itself ensures the run workspace with its anchor tab/pane, starts the target ORCH agent pre-aligned with the configured orchestrator role's model and thinking, and delivers the first prompt: read `orchestrator-instructions.md` plus `protocol-orch.md` and wake the source run via `notify_run`. No separate Herdr CLI or `/herdr-align` step is needed for the target.
4. Preserve active or unsafe source lanes, revalidate inherited evidence from the target side, and settle source closure per section 7.

The built-in orchestrator role is `@default`; configuring a planning-grade role such as `@plan` with elevated thinking is recommended.

The target's start prompt names the source ORCH wake target: the target wakes the source after handoff revalidation, a terminal boundary, or a decision request, and the source may wake the target via its registry `agent_name`. Both directions are the same bounded non-authoritative doorbell — run documents stay the only authority.

`/reload-plugins` refreshes the skill and MCP server. Validate a changed extension module in a new OMP session.

Do not close this worker merely because its current assignment completed. Keep its tab/session available for the same responsibility unless ORCH explicitly closes the lane or track through the guarded MCP action.
