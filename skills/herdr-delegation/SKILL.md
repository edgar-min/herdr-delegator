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

Use this skill only in the session that may create a track. The session created by
`herdr_track open` becomes the track's orchestrator (**ORCH**); this creator never
becomes ORCH and must not continue the track after birth.

Reply to the human in the language and tone they use. Follow their user-level
`AGENTS.md` throughout this creator exchange.

## Decide whether the work is track-worthy

Use the host OMP task/subagent mechanism for bounded, already-specified mechanical
work. It needs no persistent responsibility, durable routing, or separate user
conversation.

Open a Herdr track only when substantial independent work benefits from one or more
of these properties:

- persistent context across several assignments in the same responsibility;
- explicit, disjoint write ownership or dependency routing;
- durable evidence, decisions, and blocked-state handling;
- exact-session recovery under a separately born orchestrator.

A track moves the user's working conversation into another pane and starts another
session. Do not pay that cost for work that can finish cleanly here.

## Distill the bounded mandate

Distill the conversation already held with the user. Do not interview them again for
a specification you are about to hand away.

The mandate contains only **WHAT** and **WHY**:

- `intent`: why the track exists and what it must achieve, in the user's terms;
- `constraints`: boundaries the ORCH may not cross, including required approvals;
- `shape_of_success`: observable conditions that make the track complete.

Keep **HOW** out. Planning, decomposition, routing, and implementation belong to the
born ORCH in `plan.md` after it speaks with the user.

Preserve settled user language rather than translating it into internal jargon. For
the accepted call shape, limits, coordinate grammar, and recoverable failures, follow
the mounted `herdr_track` schema and its returned error text; do not reconstruct
those contracts from this prose.

## Open once

Call `herdr_track` with `action: "open"` once, using the current project working
directory and the distilled mandate. The operation atomically fixes the mandate,
creates the run surface, and births the ORCH in its named pane.

Do not lay out run files, start an orchestrator separately, edit tool-owned state, or
compensate for a failed open. Follow the operation's returned recovery exactly. An
identical retry is permitted only when that recovery directs it.

## Redirect, then die well

On success, relay the returned `next_step` to the user in their language and tone,
including any returned warning that affects where or how they continue.

Then stop all work for this track in the creator session. Do not plan, call guarded
track operations, inspect workers, or answer further track questions here. Direct the
user back to the born ORCH pane: that session owns the conversation, command identity,
and all subsequent work.
