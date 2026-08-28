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

## Optional skill discovery and routing

At planning, assignment-authoring, dispatch, pre-completion, verification, reset, and handoff boundaries, scan the runtime's already available skill catalog for a directly applicable skill from any installed skill pack. Read and invoke only a skill whose own description matches the present work. Missing skills are a no-op: never install, update, emulate, or block on them during a run.

Configured advisory skill routes may appear as `skill_routes` (with an imperative `skill_routes_note`) in tool results and inside the worker dispatch prompt. When a result carries routes, read each installed routed skill — resolve the name via `skill://<name>` or the runtime's skill catalog — and apply it before proceeding at that boundary. A route raises discovery reliability only; it never proves a skill ran and is never contract, settlement, lifecycle, or session authority.

An optional skill remains subordinate to this protocol. It may improve reasoning or an owned artifact, but it never changes scope, authority, write ownership, immutable or tool-owned files, completion grammar, lifecycle state, settlement, or recovery. Preserve user-invoked-only semantics declared by the skill.
