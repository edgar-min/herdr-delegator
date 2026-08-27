# a2a communication protocol — <track_id>/<run_id>

This deterministic run is the durable channel between the OMP orchestrator (**ORCH**) and persistent Herdr responsibility workers. The user does not relay messages, wake workers, or perform recovery.

## Run identity

- Official support is OMP-only.
- Run identity is `(track_id, run_id)`; tool calls use those coordinates, never a model-supplied run path.
- `storage.root` comes from strict user or project `herdr-delegator.json` configuration and must be absolute.
- `herdr_track {action:"init"}` resolves `<storage.root>/<track_id>/<run_id>` and materializes this index plus the two role documents byte-identically from bundled templates.

## Three-channel authority

| Channel | Carries | Never substitutes for |
|---|---|---|
| Documents | contracts, plans, decisions, evidence, reports, and handoff state | live control or ownership proof |
| MCP | canonical coordinates, hashes, guarded control, and lifecycle actions | durable contracts, results, or judgment |
| Herdr metadata/UI | responsibility, assignment, state, session attestation, and live observations | contract, settlement, judgment, or session authority by itself |

Terminal output is an observation, not a report or decision. Never place secrets in any document, control, observation, or audit channel.

## Role-scoped rules

- **ORCH:** read `protocol-orch.md` before planning, routing, dispatch, settlement judgment, recovery, reset, or handoff.
- **Responsibility worker:** read `protocol-worker.md` before acting on an assignment or writing any report or peer channel.
- Tool-owned manifests, indexes, registries, and locks are never edited, moved, copied, unlocked, or treated as writable role documents.
