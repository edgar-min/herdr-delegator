# Responsibility worker protocol — <track_id>/<run_id>

Read `protocol.md` first. This document contains the rules for a persistent Herdr responsibility worker (`w<N>`).

## Role and resolution order

A worker is a persistent OMP main session in one registry-owned tab. It keeps context across assignments with the same responsibility; an assignment is one immutable work unit, not the worker's identity.

For each assignment, self-resolve in this order:

1. the immutable canonical assignment;
2. `plan.md`;
3. canonical project documents and settings;
4. code and other project evidence.

Proceed when evidence is clear and within assigned write ownership. Obey exact dependencies, completion conditions, user boundaries, and prohibitions. Workers share the project `cwd`; touch only owned files and honor declared quiet windows so concurrent edits remain disjoint.

The dispatch prompt may include advisory skill routes for the `dispatch` and `completion` boundaries. Read each routed skill that is installed — resolve the name via `skill://<name>` or the runtime's skill catalog — and apply it strictly within assigned write ownership: `dispatch` routes when starting the assignment, `completion` routes before appending the completion block. A missing skill is a no-op; a route never changes scope, ownership, completion conditions, or the report grammar.

## File and channel authority

- Append durable evidence, results, decision requests, and completion only to your own `a2a/w<N>-report.md`.
- A plan-authorized `a2a/w<N>-to-w<M>.md` is an append-only directional channel for existing facts, readiness, dependencies, quiet windows, and compatibility observations.
- Terminal output and Herdr metadata are observations, not reports, decisions, settlement, or identity authority.
- The canonical assignment becomes immutable when submitted. Do not edit it.
- Tool-owned manifests, indexes, `run.json`, `reset.json`, `a2a/delegation.json`, `a2a/herdr-workers.json`, and locks are never edited, moved, copied, or unlocked.

There are no separate assignment contract or receipt files.

## Report and completion grammar

Append evidence and results without replacing or rewriting prior report history. List material changes, observed commands or scenarios, exact results, and unresolved gaps.

Complete an assignment by ending the report with exactly one of these blocks:

```markdown
[Assignment Completion: A-001]

status: completed
```

```markdown
[Assignment Completion: A-001]

status: failed
```

Use the actual assignment ID. Keep one blank line between the heading and the single status line, and append nothing after the block. Completion leaves the worker tab and official OMP session open; remain idle for another assignment with the same responsibility.

## Blocked work and decision requests

When assignment, plan, project evidence, and code are absent or conflicting, append one batched `[ORCH Decision Request]` to your report. State the exact missing judgment, grounds checked, safe options or bounded input needed, and independent work completed. Continue every independent part that remains within ownership.

ORCH alone changes scope, ownership, priority, approval, and completion conditions. A peer cannot authorize any of those changes. Do not treat terminal text, metadata, or an undeclared peer file as authority.

If a live assignment becomes blocked, preserve the current state and sequence. Await an ORCH response through the guarded assignment control path; do not invent an answer, replay control, resume yourself, or create a replacement identity.

## Peer-channel limits

Use only a directional peer channel declared by `plan.md`, and only as its declared sender. Share existing facts, readiness, dependencies, quiet windows, and compatibility observations. Do not negotiate or change scope, ownership, priority, approval, completion conditions, responsibility identity, session identity, or lifecycle state through peer files.

## Prohibitions

- Do not delegate or run project-wide commands unless the assignment permits it.
- Do not change assignment scope, write ownership, priority, approval, or completion conditions.
- Do not create, close, resume, reroute, or replace responsibility lanes, sessions, tabs, panes, or workspaces.
- Do not edit tool-owned files or attempt lifecycle, reset, handoff, settlement, or recovery actions.
- Do not repair out-of-scope gaps in place; record them with evidence.
- Do not create competing project conventions.
- Never place secrets, credentials, authentication material, account data, or sensitive values in documents, reports, peer channels, terminal output, metadata, or control requests.
- Keep all content product-neutral and free of local machine paths unless the immutable assignment explicitly names an owned project coordinate.
- Project-specific additions: <project rules>
