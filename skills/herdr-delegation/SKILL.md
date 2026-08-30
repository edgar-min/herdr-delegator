---
name: herdr-delegation
description: Delegate substantial independent work from OMP to persistent Herdr responsibility lanes with a born orchestrator, deterministic storage, immutable assignments, verified sessions, recovery, and guarded closure.
license: Apache-2.0
compatibility: Requires Oh My Pi 18.0.5 or later, Herdr 0.8.2, Bun, and an OMP-managed Herdr integration.
metadata:
  author: edgar-min
  version: "2.0.0"
---

# Herdr delegation

Use this skill only in a session that may create a track. The session `herdr_track
open` creates becomes the track's orchestrator (**ORCH**); this creator never becomes
ORCH and must not continue the track after birth.

Reply in the human's language and tone. Follow their user-level `AGENTS.md`
throughout this creator exchange.

## Decide whether the work is track-worthy

Use host OMP task/subagents for bounded, already-specified mechanical work: it needs
no persistent responsibility, durable routing, or separate conversation.

Open a track only when substantial independent work benefits from one or more of:

- persistent context across several assignments in the same responsibility;
- explicit, disjoint write ownership or dependency routing;
- durable evidence, decisions, and blocked-state handling;
- exact-session recovery under a separately born orchestrator.

A track moves the user's conversation into another pane and session. Do not pay that
cost for work that can finish cleanly here.

## Distill the bounded mandate

Distill the conversation already held. Do not interview the user again for a
specification you are about to hand away.

The mandate contains only **WHAT** and **WHY**:

- `intent`: why the track exists and what it must achieve, in the user's terms;
- `constraints`: boundaries the ORCH may not cross, including required approvals;
- `shape_of_success`: observable conditions that make the track complete;
- `budget`: your estimate of the tokens and minutes this scope should take. Declare
  it; an undeclared seed falls back to tight defaults that park a nontrivial run early.

Keep **HOW** out: planning, decomposition, routing, and implementation belong to the
born ORCH in `plan.md`.

Preserve settled user language. For call shape, limits, grammar, and recoverable
failures, follow the mounted `herdr_track` schema and its error text, not this prose.

## Open once

Call `herdr_track` with `action: "open"` once, using the current project working
directory and the distilled mandate. The operation atomically fixes the mandate,
creates the run surface, and births the ORCH in its named pane, which also receives a
configuration-rendered `guidance.md`: advisory criteria for its routed skills and
profiles — configure it, never author it here.

Do not lay out run files, start an orchestrator separately, edit tool-owned state, or
compensate for a failed open. Follow the returned recovery exactly; an identical retry
is permitted only when it directs one.

## Redirect, then die well

On success, relay the returned `next_step` and any warning affecting where or how they
continue, in the user's language and tone.

Then stop all work for this track here: do not plan, call guarded operations, inspect
workers, or answer further track questions. Direct the user back to the born ORCH pane,
which owns the conversation, command identity, and all subsequent work.
