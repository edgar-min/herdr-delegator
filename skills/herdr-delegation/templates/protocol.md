# a2a communication protocol — <track_id>/<run_id>

This run is the durable coordination surface between its born OMP orchestrator
(**ORCH**) and persistent Herdr responsibility workers. The user does not relay
messages, wake workers, or perform recovery.

## Authority index

| Surface | Authority |
|---|---|
| Run documents | mandates, plans, assignments, ownership, decisions, evidence, reports, budget records, and handoff state |
| MCP | canonical coordinates and hashes, guarded mutation, observation, and lifecycle actions |
| Herdr metadata/UI | attributable live observations and human-visible supervision labels only |
| Doorbells | a server-composed pointer to an already-written document; never content or authority |

Terminal output and metadata are observations, not reports, decisions, settlement,
or identity authority. Only the named document carries a doorbell's facts.

Tool-owned manifests, indexes, registries, and locks are never edited, moved, copied,
unlocked, or treated as role documents. Protocol documents are immutable within a
run; read the copies materialized for this run.

For MCP actions, fields, limits, machine states, and recoverable failures, follow the
mounted tool's published schema and returned error text. Do not derive a competing
contract from protocol prose.

## Role index

- **ORCH:** read `protocol-orch.md` before planning, routing, dispatch, judgment,
  recovery, reset, or handoff.
- **Responsibility worker:** read `protocol-worker.md` before acting on an assignment
  or writing a report or peer channel.

Optional skill routes are advisory. Read an installed routed skill at the named
boundary, but never let it change scope, authority, ownership, immutable files,
completion conditions, settlement, or recovery. A missing skill is a no-op. A
`guidance.md` rendered into a run carries the same weight: selection criteria, never
authority.

Never place secrets, credentials, authentication material, account data, or sensitive
values in run documents, tool inputs, terminal output, metadata, or doorbells.
