---
name: herdr-create
description: Create a Herdr track from a session outside it, distilling a bounded mandate and handing it to the born orchestrator. Creator-only; not an ORCH or worker operating guide.
license: Apache-2.0
compatibility: Requires Oh My Pi 18.0.5 or later, Herdr 0.8.2, Bun, and an OMP-managed Herdr integration.
metadata:
  author: edgar-min
  version: "3.11.0"
---

# Herdr track creation

Use this skill only in a session that may create a track. The session `herdr_track
open` creates becomes the track's orchestrator (**ORCH**); this creator never becomes
ORCH and must not continue the track after birth.

This document is complete for the creator role. It includes no other role's operating
duties, and no other document supplies a duty missing from it.

Reply in the human's language and tone. Follow their user-level `AGENTS.md`
throughout this creator exchange.

## Decide whether a track helps

Keep bounded work here when it needs no persistent responsibility. Use host
subagents only when the user's boundaries permit them. Open a track when the work
needs persistent lane context, disjoint ownership or dependencies, durable evidence,
or recovery in a separately born ORCH. Do not create a track merely to add ceremony.

## Read before you rank

Read the conversation, the user's stated boundaries and any named document directly:
a known pointer, a short mandatory file and a deterministic check (grep, parser,
hash, schema read) are cheaper and more reliable than a model call, and ranking them
adds cost without changing what you open.

Use `herdr_jev rank` only when the useful range is genuinely unknown and the
candidate set is large or opaque. Prefer content ranking there; rank on filenames
alone only when the names actually encode the answer, because a filename-only score
hides content (an authoritative procedure can sit in a file whose name scores low).
Read required contracts in full. Use `check` for a specific claim against named
references, not as proof that those references are true or that the mandate is
complete. Scores are advisory ordering, never acceptance.

Before asking the human to resolve a genuinely uncertain decision, use `herdr_jev
judge` with `moment: "escalate"`, `question`, and the relevant known `context`.
It needs no existing run. Observe what tools can answer, decide what the evidence
already fixes, and ask for genuine human judgment or reserved approval. The verdict
is advisory: it cannot waive approval, and a failed call grants no permission. Do not
escalate a decision the user's boundaries already settle.

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

Every success condition must name something a worker can actually produce or observe.
A condition nobody can reach — a state the work cannot create, or evidence no
authorized surface exposes — produces false completion warnings later; fix the
wording now rather than tuning anything downstream.

Preserve settled user language. For call shape, limits, grammar, and recoverable
failures, follow the mounted `herdr_track` schema and its error text, not this prose.

Do not author assignments, worker topology, or an implementation plan before birth.

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

Keep secrets and document bodies out of tool inputs, calibration and terminal output.
During the creator exchange, end each visible turn with a short Jev note: the action,
purpose and effect on your reading or decision, or why it was unused. Do not make
calls just to fill the note.
