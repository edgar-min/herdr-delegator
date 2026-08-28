---
name: herdr-delegation
description: Delegate substantial independent work from OMP to persistent Herdr responsibility lanes with a born orchestrator, deterministic storage, immutable assignments, verified sessions, recovery, and guarded closure.
license: Apache-2.0
compatibility: Requires Oh My Pi 18.0.5 or later, Herdr 0.8.2, Bun, and an OMP-managed Herdr integration.
metadata:
  author: edgar-min
  version: "1.2.0"
---

# Herdr delegation

**ORCH is born, never appointed.** A track's orchestrator (**ORCH**) is the session `herdr_track open` spawns into the track's own pane, and the birth record it writes is that run's only command identity. The session reading this skill is therefore one of two roles: the *bootstrapper*, which distills the conversation into a bounded mandate, calls `open` once, and is retired for that track at birth; or a *born ORCH*, which owns decomposition, routing, judgment, verification, and recovery for its run. Herdr workers are persistent responsibility lanes: an assignment is work routed to a lane, not the worker's identity.

Official support is OMP-only. The Agent Plugins package contains a bridge-only OMP extension under `io.github.edgar-min.herdr-delegator/`, one Bun stdio MCP server declared by package-root `mcp.json`, and this bundled skill. Do not design or infer another agent adapter.

## 1. Choose the execution surface

Use the host OMP task/subagent mechanism for bounded mechanical work. It creates no Herdr worker, durable assignment, or plugin model-verification claim.

Use Herdr for substantial independent work that benefits from persistent context, explicit ownership, exact-session resume, blocked-state handling, or durable assignment routing.

Opening a track is neither free nor undoable in place: it moves the conversation gate into another pane and costs a session spin-up. Work that never needs ORCH command — bounded, already specified, mechanical — routes to host OMP task/subagents instead.

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

The built-ins deliberately name `@default` rather than `@task`/`@slow`: OMP recognizes those two names but resolves neither without a matching `modelRoles` entry, so naming them would pre-align a default-grade model under a distinct-looking name. Configuration may select another bounded OMP role alias or worker profile. It never stores a concrete model ID. The OMP bridge resolves configured roles to concrete provider/model facts and publishes the current session, model, thinking, configuration hashes, and nonce through a session-scoped mode-0600 fact file. MCP derives that file from the verified caller pane and active OMP agent directory; callers never supply its path.

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

`herdr_track open` needs attestation but not alignment: the opening session commands nothing, so its own model is irrelevant, and the ORCH it spawns launches pre-aligned to the configured `orchestrator.role`. Alignment binds only a session that commands a run itself, which is the legacy `init` + `start_orchestrator` path. There, guarded mutations fail closed with `orchestrator_model_mismatch` when the caller's model or thinking does not match the configured role — a fresh OMP session rarely starts on that role's model. On that error, ask the user to run `/herdr-align` once (a user-invoked OMP command from this plugin: it switches only this session's model/thinking to the configured role and refreshes bridge attestation), or to relaunch with the `omp --model`/`--thinking` values the error names.

A configured role name that OMP recognizes but no `modelRoles` entry resolves inherits the default chain silently — a planning-grade name pre-aligning a default-grade model. The `open`/spawn preflight warns without blocking and returns the warning in `data.warnings`; report it to the user instead of dropping it.

Command singularity: a run's ORCH identity is its birth-record chain in tool-owned `a2a/delegation.json`. `herdr_track open` is the only path that births an ORCH for a new track; legacy `start_orchestrator` records a birth for an `init` run, and on a legacy run with no birth yet the first attested guarded command (assignment `add`/`wait`, worker `resume`/`close`, track `close`) claims generation 1. Guarded commands from any other session fail with `orch_identity_mismatch`, a session from a retired generation fails with `stale_orch_generation`, and the session that opened the track fails with `creator_session_retired`. One run has exactly one commanding ORCH — never command a run another session already commands.

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

`boundary` is one of `plan`, `authoring`, `dispatch`, `completion`, `settlement`, `reset`. `surface` is `orch` or `worker`. Each rule names 1–8 bounded skill names; the shipped configuration names none. Delivery is deterministic: `herdr_track init` returns `plan`/`authoring` (plus `reset` for a sibling reset) routes, `herdr_assignment preflight` returns `authoring` routes, the dispatch prompt carries `dispatch`/`completion` routes to the worker, and terminal assignment results carry `settlement` routes. `herdr_track open` deliberately carries none: its result is read by the retiring creator, not by the ORCH that will plan. A born ORCH meets its own `authoring` routes at `herdr_assignment preflight`. Routes are advisory text only — never invocation proof, settlement gate, or authority.

Route only trusted skills: routed names become instructions executed inside ORCH and worker sessions, so treat a routing rule like a dependency declaration. Prefer a vetted skill pack or skills the user wrote themselves, matched to the boundary they improve (context inquiry at `plan`, review at `settlement`). When no rules are configured, suggest this once during planning rather than silently proceeding forever without them.

Launches remain fail-closed behind two gates:

1. **Bootstrap gate:** the bridge and Herdr pane metadata must agree on official session, pane, provider/model, thinking, nonce, and freshness before prompting.
2. **Persisted gate:** after the first prompt boundary, the official JSONL must agree on session, provider/model, thinking, and fallback before success or later resume.

Never send a synthetic prompt to create JSONL. Never accept a model-supplied session path, launch argv, pane, tab, or workspace target.

## 3. Open the track

Run identity is `(track_id, run_id)`. Both coordinates match:

```text
^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$
```

`herdr_track open` is the single entry, and one call is one atomic birth:

```json
{
  "action": "open",
  "track_id": "example-track",
  "run_id": "implementation",
  "cwd": "/absolute/project/path",
  "mandate": {
    "intent": "Why this track exists and what it must achieve, in the user's terms.",
    "constraints": ["Boundary the ORCH may not cross"],
    "shape_of_success": ["Observable condition that makes the track done"]
  }
}
```

It ensures the track's Herdr space, lays out the run and its protocol documents, fixes the mandate as `orchestrator-instructions.md`, stamps the creating session, spawns the ORCH pane pre-aligned to the configured orchestrator role, and records the ORCH birth. No part of that sequence is a step you perform yourself.

### Author the mandate

The mandate carries WHAT and WHY. HOW is forbidden: `plan.md` is the born ORCH's own document, written after birth in clean context with the user. Distill the conversation you already had into bounded lines; do not interview the user for a specification you are about to hand away.

| Field | Content | Published limit |
|---|---|---|
| `intent` | Why the track exists and what it must achieve, in the user's terms | 4096 characters |
| `constraints` | Boundaries the ORCH may not cross: budgets, forbidden surfaces, required approvals. May be empty — the document then records that none were recorded | 32 entries, 500 characters each |
| `shape_of_success` | Observable conditions that make the track done. At least one entry | 32 entries, 500 characters each |
| `budget` | Optional seed: `tokens`, `minutes`, `doorbell_policy` (`notify` default, or `full`). Omit it to accept the documented defaults | see section 7 |
| rendered document | The whole `orchestrator-instructions.md` | 16384 bytes |

`constraints` and `shape_of_success` entries are normalized to single lines; `intent` keeps its paragraphs. Every oversize rejection is `mandate_too_large` and names the actual count against the limit, so trimming is arithmetic rather than trial and error. The mandate is fingerprinted at the ORCH's first prompt and never rewritten behind a live ORCH. Its identity is the SHA-256 of the rendered document, returned as `data.mandate.sha256`: any edit that changes those bytes is a different mandate, and presenting one on an already-opened coordinate fails with `mandate_conflict` — open a sibling run instead.

### Redirect the user, then stop

A successful `open` returns the pointer the user needs: `data.space`, `data.orch_pane`, `data.orch_pane_id`, `data.orch_birth`, `data.mandate` (path, sha256, bytes), `data.creator_retired`, optional `data.warnings`, and `data.next_step` — a ready sentence naming the pane to continue in. Deliver `data.next_step` to the user, then stop working this track.

That stop is contract, not courtesy. The opening session is retired for the run at birth: every guarded call it makes now fails with `creator_session_retired`, and accumulating more track context in it re-creates the dual-command failure this design exists to prevent. Refuse further work on the track here; the work happens in the ORCH pane, where the user now converses.

Re-opening a born track with the same mandate bytes is a safe idempotent lookup: `effect: "none"` with `data.already_open` and the same pointer. Use it to answer "where is my ORCH".

### Read the creator and birth state before recovering

`open` stamps the creator before it spawns anything, so the creator record doubles as the "this run is open-managed" marker. It is three-valued — creator with a birth, creator alone, or no creator at all — and the birth chain refines the last case. Read both before recovering anything; each combination permits exactly one move:

| Creator | Birth | Meaning | Legal move |
|---|---|---|---|
| present | present | live open-managed track | converse in the ORCH pane; the creator is retired for this run |
| present | absent | an `open` that did not finish | only that creator, re-running the identical `open`, completes the birth; a second opener gets `track_open_in_progress`, a guarded command gets `orch_birth_missing`, and the attempt that failed reported `orch_birth_incomplete` |
| absent | present | a legacy `init` run whose ORCH was spawned by `start_orchestrator` | the latest birth generation commands it; the session that spawned it is not the ORCH and is rejected as a stranger (`orch_identity_mismatch`), or as a zombie (`stale_orch_generation`) if it once held an earlier generation |
| absent | absent | a legacy `init` run with no ORCH yet | the first attested guarded command claims generation 1 |

Failure is fail-closed, never compensating. A failed `open` may leave the run directory, the mandate, the track space, and even the started ORCH pane in place; each is named in the failure's recovery text and reused by the identical retry. Never delete that residue by hand. `start_orchestrator` on a run that carries a creator record is refused with `track_opened_atomically`.

### Names are the supervision surface

| Coordinate | Name |
|---|---|
| Herdr space | `herdr/<track_id>` — one space per track |
| Run anchor tab | `ORCH <track_id>/<run_id>` — one per run, inside the track space |
| ORCH pane | `ORCH <track_id>/<run_id>` — the pane inside that anchor tab, where the user converses |
| Worker tab | the deterministic registry agent name, never a human name |
| Worker pane | `w<N> <responsibility_key>` |

Runs are generations inside their track's space: a sibling run at the same `track_id` — reset or handoff — shares that space and gets its own anchor tab, while a handoff to a new `track_id` gets its own space. The ORCH's anchor tab and the pane inside it deliberately carry one name; worker tabs are the exception, keeping the deterministic agent name so that only the worker pane carries a human one. Labelling is display-only and degrades to a warning, never a failed operation. Runs created before this scheme carry the old `herdr-run-<hash>` space label and fail `identity_conflict` on their next lifecycle call; their leftover spaces are inert, and since no tool operation closes a retained space, the user closes them in Herdr.

### Run layout

`open` — and legacy `init` — resolves `<storage.root>/<track_id>/<run_id>` and materializes the protocol documents byte-identically from their bundled templates:

```text
<run>/
  run.json
  protocol.md
  protocol-orch.md
  protocol-worker.md
  orchestrator-instructions.md   (the mandate; written by open)
  a2a/
```

It also updates the tool-owned storage index. The born ORCH authors `plan.md` and every work artifact afterward. Never edit tool-owned manifests, indexes, `a2a/herdr-workers.json`, `a2a/delegation.json`, or their locks.

### Legacy init path

`herdr_track init` plus `start_orchestrator` remains for exactly two cases: a sibling reset (`reset_of: {track_id, run_id}`, which copies the source plan under the fixed `close-settled-preserve-active` and `revalidate-before-import` policies and requires `plan.md` before start) and a handoff target (section 10). Both write `orchestrator-instructions.md` as an ordinary file instead of passing a mandate, and both are refused on a run that carries a creator record.

## 4. Plan responsibilities and assignments

`plan.md` is the ORCH's own document, written after birth in conversation with the user — never by the bootstrapper, and never a transcription of the mandate. It is the only place HOW belongs.

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

- `open`: `track_id`, `run_id`, `cwd`, `mandate` — the single atomic birth (section 3).
- `init`: `track_id`, `run_id`, `cwd`, optional `reset_of` — legacy layout for reset siblings and handoff targets.
- `inspect`: `track_id`, `run_id` — adds `data.budget` (record, fresh metering, ledger and clamp paths).
- `start_orchestrator`: `track_id`, `run_id` — legacy spawn, refused on an open-managed run.
- `budget_extend`: `track_id`, `run_id`, `justification` (`done`, `remaining`, `why_more`), optional `requested_tokens` and `wait` — section 7.
- `close`: `track_id`, `run_id`, fresh `expected_registry_revision`.

Track close is all-or-nothing. It rejects active or blocked lanes and fresh-inspects every close candidate before guarded closure.

### `herdr_assignment`

- `preflight`: run coordinates, `assignment_id`, `responsibility_key`.
- `add`: run coordinates, `assignment_id`, `responsibility_key`, exact `instructions_sha256`, optional `separation`, optional `wait`.
- `wait`: run coordinates, `assignment_id`, optional `wait`.

There is no response action. Answering a worker — a decision request, a ruling, or a worker genuinely blocked on input — is always the same two steps: append an `[ORCH Response]` block to `a2a/w<N>-report.md`, then ring `herdr_message {action:"wake_worker"}`. The wake is delivered as pane input, so it reaches an idle worker and a truly input-waiting one alike. The report append is the authority; the wake is only the pointer.

`wait` accepts optional `until` values from `idle`, `done`, `blocked` and `timeout_ms` from 1,000 through 300,000. An elapsed wait window returns a successful observation with `timed_out: true` and the fresh lane state, never an error; compose longer logical waits by repeating bounded calls, and prefer settling on worker wake signals over long polling loops.

`add` selects or creates the responsibility lane, verifies the configured worker profile and session gates, records prompt intent, sends pointers to the canonical assignment and `protocol-worker.md`, waits, verifies persisted identity, and attempts settlement. An exact-responsibility assignment queues instead of spawning when its lane is active. Re-adding an assignment whose lane closed or failed before any prompt rebinds it to a live or fresh lane instead of failing it. When a settlement promotes the FIFO head, the same guarded call dispatches the promoted assignment; a queued head on an idle lane is also dispatched by the next `wait` on it.

`preflight` validates the canonical draft's grammar before immutability and returns the server-computed `instructions_sha256` of the exact validated bytes, bounded section counts, and any configured `authoring` skill routes. It never mutates the registry or any lane; an already-registered assignment returns its immutable state instead.

Assignment state is exactly:

```text
queued | prompting | working | blocked | completed | failed | ambiguous
```

A wait timeout is a no-effect observation surfaced as a `timed_out` result. A potentially effected prompt or resume converges on `ambiguous` and must be inspected before any recovery.

### `herdr_worker`

- `list`: run coordinates, optional `responsibility_key`.
- `inspect`: run coordinates, `worker_id`, optional `output_lines` from 1 through 200.
- `resume`: run coordinates, `worker_id`, exact `expected_session_id`.
- `close`: run coordinates, `worker_id`, exact `expected_session_id`, fresh `expected_state_change_seq`.

Use worker operations for lane observation and lifecycle only. Assignment delivery belongs to `herdr_assignment`; answering a worker belongs to its report plus `wake_worker`.

### `herdr_message`

- `wake_orch`: run coordinates, `assignment_id`, `boundary` from `completed`/`failed`/`blocked`/`decision-request` — worker doorbell to the run's born ORCH (latest birth record).
- `wake_peer`: run coordinates, `to_worker_id` — doorbell to a registered peer lane after a plan-authorized channel append.
- `wake_worker`: run coordinates, `to_worker_id` — ORCH-to-own-worker doorbell after appending an `[ORCH Response]` to the lane report; for decision-request workers that idled without a formal blocked state.
- `notify_run`: run coordinates, `to_track_id`, `to_run_id` — ORCH-to-ORCH bell, refused unless this run's inter-run channel document for that target already exists.

Every doorbell points at a document and carries no content of its own. The server composes the delivered text, resolves targets from ORCH birth records and the worker registry, and transports each message as Herdr pane input — the pane input is what triggers the receiving session. Delivery is a soft observation (`data.delivery`: `delivered`, `rejected_blocked`, `target_unresolved`, `failed`); a transport outcome is never an error, and every attempt is appended to the sending run's `a2a/messages.jsonl`. Only invalid input hard-errors — including a bell whose document does not exist yet, which is the caller skipping the append, not a broken channel. A stalled flow is a silent failure — check that log. Messages carry no authority: settle only through guarded actions and documents.

#### The inter-run channel document

ORCH-to-ORCH conversation lives in one append-only document per direction, owned by the run that writes it:

```text
<run>/a2a/orch-to-<to_track_id>_<to_run_id>.md
```

It is the peer channel file's isomorph across runs: the conversation is never written into another run's directory, so the counterpart answers by appending to its own reverse channel and ringing its own bell. `_` cannot occur in a run coordinate, so the two coordinates in the file name always parse back. The one write into another run's directory is birth-time, before that run has an ORCH to own it: a handoff or reset source lays out the target run and writes its `orchestrator-instructions.md` (section 10). Once the target ORCH is born, every cross-run word travels through the channel documents.

Append one entry per conversational turn. Each entry carries the kind and the note that used to ride on `notify_run`:

```markdown
## 2026-08-28T09:15:00Z fact from example-track/implementation

One bounded line stating the fact, bottleneck, request, or handoff.

Optional bounded body: coordinates, hashes, and the exact document to read.
```

`kind` is one of `fact`, `bottleneck`, `request`, or `handoff`. A handoff is simply the channel's first conversation, and the counterpart's append — one `handoff` entry naming what it revalidated and accepted — is the ack that signs it. Resource contention between runs is negotiated in the same two documents, and each side records the agreement it accepted in its own channel document; on failed negotiation both sides stop and raise decision requests to their own users.

`notify_run` reads the document, hashes it, and rings the target ORCH with the path, SHA-256, and byte count; the result returns the same in `data.channel`. A missing or empty document fails with `channel_document_missing` or `channel_document_empty` before anything is delivered, so a bell can never point at nothing. A bell to a run whose ORCH is not born yet cannot be delivered either — `data.delivery` is `target_unresolved` and the warning names the missing birth record — which is why the handoff's first entry needs no bell: `start_orchestrator`'s own first prompt is what delivers it. A worker lane may not ring `notify_run` — cross-organization worker messaging is forbidden; escalate to your own ORCH instead.

### `herdr_friction`

- `report`: `kind` from `contract-gap`/`false-block`/`ambiguous-outcome`/`excessive-steps`/`doc-drift`/`defect`/`papercut`, `reporter` from `agent`/`human`, one-line `summary` ≤500 chars, optional `tool`, `error_code`, `evidence` ≤2000 chars, and run coordinates.
- `list`: optional `kind`, `fingerprint`, `limit` — grouped inspection of prior reports.

Reports append to a global local log (`<agent-dir>/herdr-delegator/friction/friction.jsonl`), never to an external tracker; promotion to issues is a separate human-gated triage pass. Report as `agent` only after resolving or abandoning a difficulty where the contract itself — not the call's input — was the obstacle; a `friction_hint` on a repeated error result marks such a moment. Never report every error. Transcribe a user-observed issue verbatim with `reporter: "human"`. Duplicate symptoms share a `fingerprint`; a report result's `prior_reports` shows how often the same symptom has already been recorded.

## 7. Spend against a justification cadence

A budget here is not a wall. It is the point at which spending must be justified, and every guarded op judges it: `add`, `wait`, worker `resume`/`close`, and track `close`.

Metering is a run-level aggregate over every session the registry knows — each ORCH generation's own session plus every lane session, read from the official OMP JSONL — plus wall clock since the track was opened. Precise accounting is a non-goal, so the figure is deliberately conservative *relative to zero*: a session whose snapshot cannot be read is charged 50,000 tokens rather than nothing. Read it with `herdr_track {action:"inspect"}`, which returns `data.budget` with the record, a fresh `metering` (`measured_tokens`, `assumed_tokens`, and the `judged_tokens` the gate actually uses), and both file paths; a refused guarded op also names the figures in its message.

| Coordinate | Owner | Contents |
|---|---|---|
| `budget-ledger.md` | server, append-only | every seed, request, justification, verdict, park, and resume — the trail a human is handed on a deny |
| `budget-clamp.json` | the human | `{"version":1,"max_tokens":N,"max_minutes":M}` — an absolute ceiling; clamping to 0 is the kill switch |
| `budget-audit-<n>.md` | server, then the auditor | the request plus the machine facts, then the auditor's reasoning and verdict block |
| `a2a/delegation.json` `budget` | tool-owned | seed, granted cap, extensions, verdicts, park reason |

Defaults when the mandate declares no seed: 2,000,000 tokens and 480 minutes, policy `notify`. Under `notify` the machine audit decides each extension and the human is informed only by the ledger and the pane marker; under `full` the human approves every extension by raising the clamp, so a granted cap above the clamp does not exist yet and the run parks with `approval-required`. The effective ceiling is always the lower of what is granted and what the clamp allows. Never hand-edit the ledger or the registry; the clamp file is the human's, not yours.

### When the run parks

Crossing the cap parks the run explicitly: `data.budget.record.state` becomes `parked` with a `park_reason`, the ledger records it, and the ORCH pane name gains a `budget-parked:<reason>` marker so a human notices by name. Nothing is killed — a parked run waits.

While parked, only the landing allowlist runs: `herdr_assignment wait`, `herdr_worker close`, `herdr_track close`, `herdr_track budget_extend`, every `herdr_message` doorbell, and every read-only action. Work already in flight therefore settles and lanes can be cleaned up, but a queued head is *not* dispatched, because that would be new work; `herdr_assignment add` and `herdr_worker resume` fail with `budget_parked`, and the error names the way out. Park reasons are exactly: `over-cap`, `audit-unavailable`, `clamp-unreadable`, `approval-required`, `denied`.

A parked run resumes by itself: the next guarded op re-meters, and when the judgment is no longer over the ceiling the state returns to `active`, the ledger records the resume, and the pane marker clears. There is nothing to call — a park is a wait, never a death, and the run is never killed while it waits.

### Extending the cap

```json
{
  "action": "budget_extend",
  "track_id": "example-track",
  "run_id": "implementation",
  "justification": {
    "done": "One bounded line of observable delivery.",
    "remaining": "One bounded line naming the concrete remaining work.",
    "why_more": "One bounded line: why that work needs more than the current cap."
  }
}
```

Each line is at most 500 characters and is appended verbatim to the ledger. `requested_tokens` is optional and defaults to the full step cap; either way it is clamped to that cap. The covenants: one extension may raise the cap by at most half of what is already granted, and extensions may not arrive within 15 minutes of the previous one (`budget_extension_too_soon`). A grant moves both dimensions — the granted tokens and the same 50% step of wall clock — because the clock keeps running while a run is parked. Runaway is therefore slow and visible, not impossible.

The escalation ladder is self-justification, then machine audit, then the human — never the ORCH's own word. The server (never you) spawns a clean auditor session on the `slow` worker profile, seeds `budget-audit-<n>.md` with your justification and the machine facts, and prompts it. The auditor is not a responsibility lane: it has no assignment, `wake_worker` cannot address it, and it may not call any tool. It judges your run documents against the registry's facts and appends a verdict block.

An audit that has not produced a verdict yet returns `audit.state: "pending"` with the run parked; re-send the **identical** justification to land it. A different justification while one audit is open fails with `budget_audit_in_flight` — one ORCH cannot shop for a verdict. An audit that cannot run at all parks with `audit-unavailable` and is retried; silence never becomes budget.

Verdicts are recorded server-side: `grant` raises the cap by the requested amount, `partial` by the auditor's stated number, `deny` by nothing and parks the run with reason `denied`. A deny ends the ladder at the human: the next attempt is refused with `budget_denied` until a human has changed the clamp file, so re-wording the justification buys nothing. Escalate with the ledger and the audit document. No tool op raises what a human lowered.

Keep `plan.md`, the lane reports, and your evidence current. The auditor reads them against the machine facts, so stale run documents cost budget. Documentation freshness is enforced here by money, not by rules.

## 8. Completion is not closure

When MCP verifies a report completion block, it stores `report_sha256`, marks the assignment `completed` or `failed`, returns the lane to `idle`, and promotes the FIFO head. The worker tab and official OMP session remain open for the next assignment.

Terminal `herdr_assignment` results may include `assignment.settlement` with elapsed time, cumulative session token usage, and advisory unowned-change paths. `herdr_worker inspect` reports activity timing and queue depth; `herdr_track inspect` reports lane/state totals and cumulative settled observations. Treat these as bounded signals for possible over- or under-spend and scope drift. ORCH judges them against the assignment and verified evidence; they never enforce a threshold, attribute work automatically, authorize mutation, or replace settlement and correctness checks.

Close only when the responsibility lane or track is finished. Fresh inspection must prove registry identity, official session, state sequence, and safe topology. A worker tab may contain only its registry root pane and verified Herdr Sidebar panes. An ambiguous close is never replayed blindly.

Focus restoration is guarded: restore only displacement onto registry-owned coordinates, never unrelated user focus. Record partial restoration as a warning, not operation failure.

## 9. Communication boundaries

- **Documents:** contract, decisions, ownership, durable results, completion, evidence, and handoff.
- **MCP prompt/control:** canonical coordinates and hashes, wait requests, and lifecycle actions.
- **Herdr metadata:** display-only responsibility, assignment, assignment state, session/model attestation, and live status.
- **`herdr_message` doorbells:** one bounded server-composed pointer after a document append — workers wake ORCH after a completion block or decision request, ORCH wakes its own worker after appending an `[ORCH Response]`, plan-authorized peers wake each other after channel appends, and orchestrators ring each other after appending to the inter-run channel document. Never authority: the named file alone carries facts.

Metadata is not contract, settlement, or session authority. Terminal output is not a report.

Workers self-resolve from their assignment, `plan.md`, canonical project documents, and code. They request ORCH judgment only when evidence is absent or conflicting. ORCH escalates to the user only for plan-marked user decisions, irreversible external actions, governance, secrets/account access, or judgment only the user can supply.

## 10. Verify and hand off

ORCH independently reproduces material worker claims and runs integration verification once at the integration boundary. Record acceptance or recovery in `[ORCH Response]` and `evidence.md` when used.

A handoff needs no human intervention: the whole bootstrap is four tool-drivable steps run by the source ORCH.

1. `herdr_track {action:"init"}` with the target `track_id`/`run_id` and the same canonical `cwd` (add `reset_of` for a reset sibling). Init lays out the deterministic run and its protocol documents.
2. Write the handoff as the first entry of the source's inter-run channel document for the target — `a2a/orch-to-<target_track>_<target_run>.md`, `kind: handoff`, using `templates/handoff.md` as the entry body — and write the target run's `orchestrator-instructions.md` pointing at that channel document by absolute path. Both are ordinary file writes. `orchestrator-instructions.md` must exist before start (it is fingerprinted at first prompt and never replayed after a change) and it is the handoff's mandate analogue: the target ORCH writes its own `plan.md` after start. A reset sibling is the exception, because `init` copied the source plan and that `plan.md` must be present before start.
3. `herdr_track {action:"start_orchestrator"}` on the target run. The server itself ensures the run workspace with its anchor tab/pane, starts the target ORCH agent pre-aligned with the configured orchestrator role's model and thinking, and delivers the first prompt: read `orchestrator-instructions.md` plus `protocol-orch.md`, and reach another run only by appending to this run's channel document for it and then ringing `notify_run`. No separate Herdr CLI or `/herdr-align` step is needed for the target.
4. Preserve active or unsafe source lanes, revalidate inherited evidence from the target side, and settle source closure per section 8.

The built-in orchestrator role is `@default`; configuring a planning-grade role such as `@plan` with elevated thinking is recommended — give that alias a `modelRoles` entry, or the spawn silently inherits the default chain and only the preflight warning names it.

The target acks by appending to its own reverse channel — `a2a/orch-to-<source_track>_<source_run>.md` in the target run — and ringing `notify_run` back; that counterpart append is the handoff's signature. Every later cross-run turn is the same shape in whichever direction it travels: append to the channel you own, then ring. Both bells are bounded non-authoritative pointers — the channel documents stay the only authority.

`/reload-plugins` refreshes the skill and MCP server. Validate a changed extension module in a new OMP session.

Do not close this worker merely because its current assignment completed. Keep its tab/session available for the same responsibility unless ORCH explicitly closes the lane or track through the guarded MCP action.
