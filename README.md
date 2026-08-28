# herdr-delegator

`herdr-delegator` routes substantial independent OMP work to persistent Herdr responsibility lanes. A worker keeps one official OMP session across sequential assignments with the same responsibility. Deterministic files remain the audit record; MCP supplies bounded control; Herdr supplies live observation.

- Package/plugin: `herdr-delegator` 1.1.0
- Skill: `herdr-delegation` 1.1.0
- Public tools: `herdr_track`, `herdr_assignment`, `herdr_worker`
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

If the live session does not match the configured orchestrator role, mutations fail closed with `orchestrator_model_mismatch`; the error names the expected identity and the remedies. Run `/herdr-align` in the session to switch it (session-only) to the configured role and refresh bridge attestation in one step.

### Advisory skill routing

Optional `skill_routing.rules` (at most 16) route installed skills to protocol boundaries. `boundary` is one of `plan`, `authoring`, `dispatch`, `completion`, `settlement`, `reset`; `surface` is `orch` or `worker`; each rule names 1–8 skills. The plugin ships no skill names — rules live in user, project, or run configuration, so any skill pack plugs in without touching the plugin. Matching routes are delivered deterministically as `skill_routes` in tool results (`init`, `preflight`, terminal assignment results) and inside the worker dispatch prompt. Routes are advisory only: they raise discovery reliability, never gate settlement or lifecycle, and never prove a skill ran.

## Start

Invoke the bundled skill from an OMP session:

```text
/skill:herdr-delegation
```

The ORCH chooses responsibilities, initializes a deterministic run, writes immutable assignment artifacts, dispatches them through MCP, verifies results, and performs recovery or closure.

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

- `init`: run coordinates, canonical project `cwd`, optional sibling `reset_of`.
- `inspect`: bounded run, registry, and ORCH observation.
- `start_orchestrator`: starts or reconciles the configured OMP orchestrator.
- `close`: requires a fresh registry revision and safely closes a fully settled track.

### `herdr_assignment`

- `preflight`: assignment/responsibility IDs; validates the canonical draft's grammar before immutability, returns its server-computed SHA-256 and `authoring` skill routes, and never mutates state.
- `add`: assignment/responsibility IDs, immutable artifact SHA-256, optional separation and wait.
- `wait`: assignment ID and optional wait.
- `respond`: assignment ID, fresh blocked sequence, and bounded text or allowlisted keys.

`wait.timeout_ms` accepts up to 300,000 ms, but the server clamps one call's effective wait below the common 30 s MCP transport limit; compose longer logical waits by repeating bounded `wait` calls. Terminal results carry a bounded `settlement` observation (elapsed wall time, a cumulative session token snapshot from the official OMP JSONL, and an advisory unowned-changes list); `herdr_worker inspect` and `herdr_track inspect` expose bounded staleness and totals. Observations are advisory, never authority.

Assignment state is exactly:

```text
queued | prompting | working | blocked | completed | failed | ambiguous
```

### `herdr_worker`

- `list`: optional responsibility filter.
- `inspect`: worker ID and optional bounded output lines.
- `resume`: worker ID and exact expected official session ID.
- `close`: worker ID, expected session ID, and fresh state sequence.

All calls include `track_id` and `run_id`. The server does not accept arbitrary run paths, Herdr targets, session paths, argv, commands, or generic close operations.

## Safety

The OMP bridge writes a session-scoped, owner-only runtime fact. MCP derives its location from the verified caller pane and active OMP agent directory.

Launch pinning has two gates:

1. bridge facts and Herdr bootstrap metadata exact-match session, pane, provider/model, thinking, nonce, and freshness before prompt;
2. official JSONL exact-matches session, provider/model, thinking, and fallback after the first prompt boundary and before resume.

Resume rejects missing, unsafe, mismatched, or credibly duplicated sessions. A wait timeout has no effect. A mutating timeout may have had an effect and must be inspected before retry.

Focus restoration never overrides unrelated user focus. Safe close requires the registry root pane plus only verified Herdr Sidebar panes. Assignment completion is never a close signal.

## Channel boundaries

- Documents: contract, ownership, decisions, durable results, completion, evidence, and handoff.
- MCP prompt/control: canonical coordinates and hashes, waits, blocked responses, resume, and close.
- Herdr metadata: display-only responsibility, assignment, assignment state, session/model attestation, and live status.

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
