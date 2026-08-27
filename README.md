# herdr-delegator

`herdr-delegator` routes substantial independent OMP work to persistent Herdr responsibility lanes. A worker keeps one official OMP session across sequential assignments with the same responsibility. Deterministic files remain the audit record; MCP supplies bounded control; Herdr supplies live observation.

- Package/plugin: `herdr-delegator` 0.5.0
- Skill: `herdr-delegation` 4.0.0
- Public tools: `herdr_track`, `herdr_assignment`, `herdr_worker`
- Official runtime: OMP only
- License: Apache-2.0

The plugin does not replace ORCH planning or review, choose responsibility boundaries, expose raw Herdr management, manage host task/subagents, close retained workspaces, or make overlapping edits in a shared directory safe.

## Package

Plugin 0.5.0 contains:

- a bridge-only OMP extension for current session/model/thinking facts and bootstrap pane attestation;
- a package-root `.mcp.json` advertising one Bun stdio MCP server;
- three composite MCP tools;
- the bundled `herdr-delegation` skill and protocol templates.

The MCP server has direct runtime dependencies on `@modelcontextprotocol/sdk` and `zod`. `.mcp.json` starts `bun run mcp/server.ts` with the package root as `cwd`.

## Prerequisites

1. [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi).
2. [Herdr](https://github.com/edgar-min/herdr).
3. The official OMP integration:

```sh
herdr integration install omp
```

Launch mutations require an OMP session inside a verified Herdr-owned pane. Missing configuration, bridge facts, model/session identity, run ownership, or safe topology fails closed.

## Installation

From GitHub:

```sh
omp plugin install https://github.com/edgar-min/herdr-delegator
```

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
    "role": "@default",
    "thinking": "inherit"
  },
  "worker_profiles": {
    "default": {
      "role": "@default",
      "thinking": "inherit"
    },
    "slow": {
      "role": "@slow",
      "thinking": "inherit"
    }
  }
}
```

The orchestrator role is configuration-selected; it is not fixed to `@plan`. Configuration accepts bounded OMP role aliases, never concrete model IDs.

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

- `add`: assignment/responsibility IDs, immutable artifact SHA-256, optional separation and wait.
- `wait`: assignment ID and optional wait.
- `respond`: assignment ID, fresh blocked sequence, and bounded text or allowlisted keys.

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
