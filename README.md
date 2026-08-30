# herdr-delegator

`herdr-delegator` routes substantial independent OMP work to persistent Herdr responsibility lanes. A worker keeps one official OMP session across sequential assignments with the same responsibility. Deterministic files remain the audit record; MCP supplies bounded control; Herdr supplies live observation.

- Package/plugin: `herdr-delegator` 2.0.0
- Skill: `herdr-delegation` 2.0.0
- Public tools: `herdr_track`, `herdr_assignment`, `herdr_worker`, `herdr_message`, `herdr_friction`
- Official runtime: OMP only
- License: Apache-2.0

The plugin does not replace ORCH planning or review, choose responsibility boundaries, expose raw Herdr management, manage host task/subagents, close retained workspaces, or make overlapping edits in a shared directory safe.

## Package

The package follows Agent Plugins 1.0.0:

- `plugin.json` is the portable package manifest;
- `mcp.json` declares one Bun stdio MCP server;
- `skills/herdr-delegation/SKILL.md` is the portable Agent Skill;
- `io.github.edgar-min.herdr-delegator/extensions/herdr-delegator.ts` is the bridge-only OMP client extension;
- `package.json#omp.extensions` retains the namespaced entry solely for current OMP extension-module compatibility.

The MCP server has direct runtime dependencies on `@modelcontextprotocol/sdk` and `zod`. For OMP 18.0.5 compatibility, `mcp.json` launches bare `sh` with `${PLUGIN_ROOT}/bin/herdr-delegator-mcp` as its sole argument and `${PLUGIN_ROOT}` as `cwd`; OMP validates plugin-relative commands but does not resolve them before `posix_spawn`. The quiet bundled launcher prefers `bun` on `PATH`, then checks `${BUN_INSTALL}/bin/bun` and `${HOME}/.bun/bin/bun`, and otherwise exits 127 with one stderr diagnostic. `plugin.json`, the fixed `skills/` directory, and `mcp.json` are the portable manifest authority; `package.json` remains npm and current-OMP compatibility metadata.

## Prerequisites

1. [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi).
2. [Herdr](https://github.com/edgar-min/herdr).
3. [Bun](https://bun.sh/) on `PATH`, under `BUN_INSTALL/bin`, or at `~/.bun/bin/bun`.
4. The official OMP integration:

```sh
herdr integration install omp
```

Launch mutations require an OMP session inside a verified Herdr-owned pane. Missing configuration, bridge facts, model/session identity, run ownership, or safe topology fails closed.

## Installation

From GitHub:

```sh
omp plugin install https://github.com/edgar-min/herdr-delegator
```

OMP 18.0.5 discovers the Agent Plugins `plugin.json`, skill, and `mcp.json`; its compatibility package metadata loads the namespaced OMP bridge entry.

For local development:

```sh
bun install
omp plugin link .
```

`/reload-plugins` refreshes the bundled skill and MCP server. A changed extension module requires a new OMP session for cutover verification.

## Configuration

At least one `herdr-delegator.json` layer must set an absolute `storage.root`:

- user: `${PI_CODING_AGENT_DIR}/herdr-delegator.json`;
- user fallback: `~/.omp/agent/herdr-delegator.json`;
- project: `<project>/.omp/herdr-delegator.json`.

Project values override user values. A run-local configuration may override profile leaves but may not relocate the run.

```json
{
  "version": 1,
  "storage": {
    "root": "/absolute/path/to/herdr-runs"
  },
  "orchestrator": {
    "role": "@plan",
    "thinking": "high"
  },
  "worker_profiles": {
    "default": {
      "role": "@default",
      "thinking": "inherit"
    },
    "task": {
      "role": "@task",
      "thinking": "inherit"
    },
    "slow": {
      "role": "@slow",
      "thinking": "inherit"
    }
  },
  "skill_routing": {
    "rules": [
      { "boundary": "authoring", "surface": "orch", "skills": ["readchk", "shower"] },
      { "boundary": "completion", "surface": "worker", "skills": ["sip"] }
    ]
  }
}
```

Configure a planning-grade orchestrator role — decision quality matters more than cost for the session that plans, routes, and judges. Without an `orchestrator` entry the plugin falls back to `@default` so a vanilla install still resolves, but that fallback is not a recommendation. Worker lane profiles are exactly `default`, `task`, and `slow`, and select bounded OMP role aliases rather than concrete model IDs. Cost-efficient small mechanical work routes to host OMP task/subagents, not persistent responsibility lanes.

Every ORCH is born pre-aligned: `herdr_track open` spawns it with the configured role's `--model`/`--thinking`, so no session ever has to align itself and there is no alignment command. `orchestrator_model_mismatch` therefore fires only if the session dispatching work has drifted off that role, and the error names both sides plus the remedies.

Role resolution is pinned at open: `herdr_track open` records the opening session's entire observed role table (each role's provider/model and bound thinking) into the run registry, and every later spawn in that run — ORCH and worker lanes alike — resolves configured roles from that pinned table instead of the live session's role view. This keeps spawned sessions honest: from inside a spawned session every configured role appears as that session's own concrete model, so without the pin a worker spawned from a born ORCH would resolve `@default` to the ORCH's model rather than the configured default. A role absent from the pinned table (or a run opened before pinning existed) resolves live with a warning. Tradeoff: OMP model-configuration changes made mid-run are not reflected in that run; open a new run to pick them up.

### Advisory skill routing

Optional `skill_routing.rules` (at most 16) route installed skills to protocol boundaries. `boundary` is one of `plan`, `authoring`, `dispatch`, `completion`, `settlement`, `reset`; `surface` is `orch` or `worker`; each rule names 1–8 skills. The plugin ships no skill names — rules live in user, project, or run configuration, so any skill pack plugs in without touching the plugin. Matching routes are delivered deterministically as `skill_routes` plus an imperative `skill_routes_note` in tool results (`init`, `preflight`, terminal assignment results) and inside the worker dispatch prompt; the note names the `skill://<name>` resolution scheme. Routes are advisory only: they raise discovery reliability, never gate settlement or lifecycle, and never prove a skill ran.

Treat a routing rule like a dependency declaration: routed skill names become instructions executed inside your ORCH and worker sessions, so route only a skill pack you trust — or better, skills you wrote and vetted yourself. The routing layer is where this plugin compounds: a small set of boundary-matched skills (context inquiry at `plan`, review passes at `settlement`) measurably tightens delegation quality without touching the plugin.

## Start (first run)

1. Install the plugin, then `/reload-plugins` (or start a new OMP session).
2. Create a user-layer `herdr-delegator.json` with an absolute `storage.root`, and map `orchestrator.role` and each worker profile to OMP roles you actually have configured (`@plan`, `@default`, ...).
3. Open Herdr and start OMP inside a Herdr pane — every guarded mutation requires the pane bridge and fails closed outside it.
4. Invoke the bundled skill and let ORCH drive:

```text
/skill:herdr-delegation
```

5. Optionally wire `skill_routing` rules to your trusted skills before the first real track — see above.

The session you invoke the skill in distills the conversation into a bounded mandate and calls `herdr_track open` once; that call creates the track's Herdr space and run, spawns the ORCH into its own pane pre-aligned, records the birth that is the run's only command identity, and retires the opening session for that track. From there the ORCH — not you — writes `plan.md`, chooses responsibilities, authors immutable assignments, dispatches them through MCP, verifies results, and performs recovery, budget justification, or closure. The user converses with the ORCH pane.

## Responsibility lanes

A worker is a persistent responsibility lane. An assignment is one unit of work routed to that lane.

Routing rules:

1. Reuse an exact responsibility whenever compatible.
2. Keep at most one active assignment per lane.
3. Queue same-responsibility assignments FIFO while the lane is active.
4. Create another lane only for a real `direction`, `ownership`, or `dependency` separation with a short reason and conflicting worker ID.
5. Do not impose a fixed worker ceiling or use scoring.
6. Do not create a worker because the matching lane is merely busy.

Bounded mechanical work belongs to host OMP task/subagents. The plugin does not verify their models.

## Immutable assignments

ORCH writes one file:

```text
<run>/a2a/assignments/A-NNN.md
```

The strict Markdown contains `assignment_id`, `responsibility_key`, and `profile` frontmatter, followed by `Goal`, `Completion conditions`, `Write ownership`, `Dependencies`, and `User boundaries` sections. After dispatch it is immutable.

Workers append results to `a2a/w<N>-report.md` and settle an assignment with an exact completion block:

```text
[Assignment Completion: A-001]

status: completed
```

MCP stores the report SHA-256 and completion timestamp in `a2a/delegation.json`. There is no separate assignment contract or receipt file.

Completion returns the lane to `idle`, promotes its FIFO head, and leaves the worker tab/session open.

## MCP tools

### `herdr_track`

- `open`: run coordinates, canonical project `cwd`, and a bounded `mandate` (`intent`, `constraints`, `shape_of_success`, optional `budget`). The single atomic birth; the opening session is retired for that track.
- `init`: run coordinates, canonical project `cwd`, optional sibling `reset_of` — legacy layout for reset siblings and handoff targets.
- `inspect`: bounded run, registry, ORCH, and budget observation.
- `start_orchestrator`: legacy spawn; refused on a run `open` manages.
- `budget_extend`: a bounded justification (`done`, `remaining`, `why_more`), optional `requested_tokens`.
- `revive`: optional `mode` — `resume` reconnects the recorded birth session, `rebirth` starts generation+1 with the user's written approval.
- `close`: requires a fresh registry revision and safely closes a fully settled track.

### `herdr_assignment`

- `preflight`: assignment/responsibility IDs; validates the canonical draft's grammar before immutability, returns its server-computed SHA-256 and `authoring` skill routes, and never mutates state.
- `add`: assignment/responsibility IDs, immutable artifact SHA-256, optional separation and wait.
- `wait`: assignment ID and optional wait.

There is no response action: a worker is answered by appending an `[ORCH Response]` block to its lane report and ringing `herdr_message wake_worker`.

`wait.timeout_ms` accepts up to 300,000 ms, but the server clamps one call's effective wait below the common 30 s MCP transport limit; compose longer logical waits by repeating bounded `wait` calls. An elapsed wait window returns a successful observation with `timed_out: true` and the fresh lane state, never an error. Terminal results carry a bounded `settlement` observation (elapsed wall time, a cumulative session token snapshot from the official OMP JSONL, and an advisory unowned-changes list); `herdr_worker inspect` and `herdr_track inspect` expose bounded staleness and totals. Observations are advisory, never authority.

Dispatch is self-healing: a settlement that promotes the lane's FIFO head also dispatches it in the same guarded call, and a `wait` on a queued head of an idle lane dispatches it too. Re-adding an assignment whose lane closed or failed before any prompt rebinds it to a live or fresh lane.

Assignment state is exactly:

```text
queued | prompting | working | blocked | completed | failed | ambiguous
```

### `herdr_worker`

- `list`: optional responsibility filter.
- `inspect`: worker ID and optional bounded output lines.
- `resume`: worker ID and exact expected official session ID.
- `close`: worker ID, expected session ID, and fresh state sequence.

### `herdr_message`

- `wake_orch`: assignment ID and boundary; worker doorbell to the run's born ORCH.
- `wake_peer`: peer lane ID; doorbell after a plan-authorized channel append.
- `wake_worker`: own-lane ID; ORCH-to-own-worker doorbell after appending an `[ORCH Response]` to the lane report.
- `notify_run`: target run coordinates only; ORCH-to-ORCH bell, refused unless this run's inter-run channel document for that target already exists.

Every doorbell points at a document and carries no content of its own. The server composes every delivered text, resolves targets from birth records and the worker registry, and transports messages as Herdr pane input. Delivery is a soft observation (`delivered`, `rejected_blocked`, `target_unresolved`, `failed`) and every attempt is logged to the sending run's `a2a/messages.jsonl`; only invalid input hard-errors, including a bell whose document does not exist yet.

### `herdr_friction`

- `report`: standardized `kind` (`contract-gap`, `false-block`, `ambiguous-outcome`, `excessive-steps`, `doc-drift`, `defect`, `papercut`), `reporter` (`agent`/`human`), one-line `summary`, optional `tool`, `error_code`, bounded `evidence`, and run coordinates.
- `list`: optional `kind`/`fingerprint` filter and `limit`; returns newest entries plus per-fingerprint counts.

Dogfooding friction accumulates in a global append-only local log at `<agent-dir>/herdr-delegator/friction/friction.jsonl` (mode 600) — never in an external tracker; promoting curated reports to issues is a separate human-gated triage pass. The action skips the OMP fact bridge so a broken bridge stays reportable, and duplicate symptoms group by a digit-insensitive fingerprint. When the same non-retryable error code recurs in one server session, the failing result carries a one-line `friction_hint` inviting a single report — the nudge is the trigger; reporting every error is explicitly out of contract.

To promote friction upstream, open a [friction issue](https://github.com/edgar-min/herdr-delegator/issues/new?template=friction.yml): copy `kind`, `summary`, `fingerprint`, and `evidence` from `herdr_friction {action: "list"}`, and review them for private paths first — the local log is unsanitized by design. A PR fixing dogfooded friction cites the same record in its template, so the tracker stays greppable by the exact taxonomy the tool records.

All calls except `herdr_friction` include `track_id` and `run_id`. The server does not accept arbitrary run paths, Herdr targets, session paths, argv, commands, or generic close operations.

## Safety

The OMP bridge writes a session-scoped, owner-only runtime fact. MCP derives its location from the verified caller pane and active OMP agent directory.

Launch pinning has two gates:

1. bridge facts and Herdr bootstrap metadata exact-match session, pane, provider/model, thinking, nonce, and freshness before prompt;
2. official JSONL exact-matches session, provider/model, thinking, and fallback after the first prompt boundary and before resume.

Resume rejects missing, unsafe, mismatched, or credibly duplicated sessions. A wait timeout has no effect and returns a `timed_out` observation. A mutating timeout may have had an effect and must be inspected before retry.

Focus restoration never overrides unrelated user focus. Safe close requires the registry root pane plus only verified Herdr Sidebar panes. Assignment completion is never a close signal.

## Channel boundaries

Communication is uniform across every relationship: a document append carries the authority, and a doorbell carries a pointer to it and nothing else.

| Relationship | Conversations | Document (authority) | Doorbell |
|---|---|---|---|
| user → ORCH | delegate, intervene, stop | mandate, `budget-clamp.json`, `rebirth-approval.json` | direct pane chat |
| ORCH → user | report, decision request | `budget-ledger.md`, `plan.md`, reports | pane-name status marker |
| ORCH → worker | direct, respond, nudge | assignment, `[ORCH Response]` in the lane report | dispatch delivery, `wake_worker` |
| worker → ORCH | completion, blocked, decision request | report append | `wake_orch` |
| worker ↔ worker | adjacent coordination (plan-authorized) | `a2a/w<N>-to-w<M>.md` | `wake_peer` |
| ORCH ↔ ORCH | negotiate, notify, handoff | `a2a/orch-to-<to_track_id>_<to_run_id>.md` | `notify_run` |
| server ↔ auditor | budget audit | `budget-audit-<n>.md` and the ledger verdict | internal |
| forbidden | cross-organization worker messaging (escalate instead), ORCH↔auditor contact, shadow channels | — | — |

- Documents: contract, ownership, decisions, durable results, completion, evidence, budget trail, and handoff.
- MCP prompt/control: canonical coordinates and hashes, waits, lifecycle actions, budget justification, revival.
- Herdr metadata: display-only responsibility, assignment, assignment state, session/model attestation, pane status markers, and live status.

Metadata and terminal output are not contract or settlement authority.

## Development

```sh
bun install
bun run check
```

## Reference

- [Architecture](docs/ARCHITECTURE.md)
- [Configuration schema](config.schema.json)
- [Configuration example](config.example.json)
- [Delegation skill](skills/herdr-delegation/SKILL.md)
