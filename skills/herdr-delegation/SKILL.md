---
name: herdr-delegation
description: Create a Herdr track from a session outside it, using Jev to focus reading and resolve escalation before handing a bounded mandate to the born orchestrator. Creator-only; not an ORCH or worker operating guide.
license: Apache-2.0
compatibility: Requires Oh My Pi 18.0.5 or later, Herdr 0.8.2, Bun, and an OMP-managed Herdr integration.
metadata:
  author: edgar-min
  version: "3.11.0"
---

# Herdr delegation

Use this skill only in a session that may create a track. The session `herdr_track
open` creates becomes the track's orchestrator (**ORCH**); this creator never becomes
ORCH and must not continue the track after birth.

Reply in the human's language and tone. Follow their user-level `AGENTS.md`
throughout this creator exchange.

## Decide whether a track helps

Keep bounded work here when it needs no persistent responsibility. Use host
subagents only when the user's boundaries permit them. Open a track when the work
needs persistent lane context, disjoint ownership or dependencies, durable evidence,
or recovery in a separately born ORCH. Do not create a track merely to add ceremony.

Before exploratory reading, use `herdr_jev rank` with the question you need answered
and candidate paths; read the useful ranges. Read required contracts in full.
Use `check` for a specific claim against named references, not as proof that those
references are true or that the mandate is complete.

Before asking the human to resolve an uncertain decision, use `herdr_jev judge`
with `moment: "escalate"`, `question`, and the relevant known `context`.
It needs no existing run. Observe what tools can answer, decide what the evidence
already fixes, and ask for genuine human judgment or reserved approval. The verdict
is advisory: it cannot waive approval, and a failed call grants no permission.

## Distill the bounded mandate

Distill the conversation already held. Do not re-interview the user for a
specification you are about to hand away.

The mandate contains only **WHAT** and **WHY**:

- `intent`: why the track exists and what it must achieve, in the user's terms;
- `constraints`: boundaries the ORCH may not cross, including required approvals;
- `shape_of_success`: observable conditions that make the track complete;
- `budget`: declare both estimated tokens and minutes; they are separate ceilings.
  Choose the extension policy from the user's approval requirements. Follow the
  mounted schema for defaults, limits and human-owned controls.

Keep **HOW** out: planning, decomposition, routing, and implementation belong to the
born ORCH in `plan.md`.

Preserve settled user language. For call shape, limits, grammar, and recoverable
failures, follow the mounted `herdr_track` schema and its error text, not this prose.

Do not author assignments, worker topology, or an implementation plan before birth.
Make success conditions observable and bounded enough for the born ORCH to decompose.

## Open once

Make one initial `herdr_track` call with `action: "open"`, using the project working directory
and the distilled mandate. It creates the run and the separately born ORCH with
its operating instructions; the creator does not write those instructions.

Do not lay out run files, start an orchestrator separately, edit tool-owned state, or
compensate for a failed open. Follow the returned recovery exactly; an identical retry
is permitted only when it directs one.

## Redirect, then die well

On success, relay the returned `next_step` and any warning affecting where or how they
continue, in the user's language and tone.

Then stop all work for this track here: do not plan, call guarded operations, inspect
workers, or answer further track questions. Direct the user back to the born ORCH pane,
which owns the conversation, command identity, and all subsequent work.

During the creator exchange, end each visible turn with a short Jev note: the action,
purpose and effect on your reading or decision, or why it was unused. Do not make
calls just to fill the note. Keep credentials and document bodies out of calibration.
