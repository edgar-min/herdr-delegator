---
name: skill-retro
description: "Run-close worker retrospective for herdr sessions. The ORCH — the session holding the most context — evaluates each worker lane it commanded (and itself) against expectations before closing, handing off, or resetting a run; where performance fell short it questions that worker via its lane report plus a wake_worker doorbell, and the questioned worker reads this skill and files its own failure evidence as frictions. Success stays silent: no noise, negative evidence only. Use when closing or resetting a herdr run, when asked to retrospect a run's workers, or as a worker answering a retrospective question."
---

The ORCH ends a run holding more context than anyone: every assignment, settlement, token bill, rework loop, and skill route that fired. This skill spends that context on the cheap act — judgment — and distributes the expensive act — writing the evidence — to the lanes that own it. Lanes that met expectations are passed over in silence; the friction log accumulates failures, not ceremony.

## Division of labor

- **ORCH judges, workers record.** Evaluation needs the run-wide view only the ORCH has; recording needs the lane-local detail only the worker has, and the ORCH's context is at its heaviest exactly when the retrospective runs. Do not centralize the writing.
- The ORCH files frictions only for **its own** shortfalls (self-evaluation is one more lane row) and, as a fallback, transcribes for a worker that cannot file (no herdr_* mount — known open friction; the worker then leaves its finding in its report prose instead).

## ORCH workflow (close/handoff/reset boundary, before the closing operation)

1. **Evaluate each lane against expectation, from evidence already held.** For every worker lane (and yourself as one more row): settlement outcomes vs the assignment's completion conditions, token/time spent vs what the artifact justifies, rework or blocked loops, report quality, and which routed skills fired there. One sentence per lane: *did this lane deliver what its spend predicts?*
2. **Silence for lanes that pass.** No friction, no note, no doorbell. Passing is the expected state, not evidence.
3. **Question the lanes that fall short.** Append one `[ORCH Response]` block to that lane's report that (a) names the shortfall concretely (e.g., "P-7 took three attempts and 40% of your spend; what got in the way?"), (b) points the worker at this skill file, and (c) asks it to file its own frictions per the worker workflow below — then ring `herdr_message {action:"wake_worker"}`.
4. **File your own row.** Your shortfalls as ORCH go through the same worker workflow, authored by you.
5. **Verify cheaply, do not re-author.** After answers land, confirm each questioned lane either filed frictions (`herdr_friction {action:"list"}`) or left prose findings you must transcribe (fallback only). Do not block the close on a worker that cannot be woken (dead pane, closed lane) — judge it from its durable report, note the unanswered question in the closing record.

## Worker workflow (on receiving a retrospective question)

1. Read the `[ORCH Response]` question in your lane report; answer it there in prose first — what actually got in the way, with citations into your own work.
2. For each concrete cause, file one `herdr_friction report` yourself (include `track_id`/`run_id`):
   - A skill that consumed context without helping, overlapped another, was used off-route, or was missing → `summary: "skill-review: <skill> — <wasted-context|redundant-overlap|unrouted-but-used|trigger-mismatch|missing-wish>"`, `tool`: the skill name, `kind`: excessive-steps / papercut / doc-drift / doc-drift / contract-gap respectively. This fixed grammar is what lets routing refinement group findings by skill — do not vary it.
   - Other causes (ambiguous assignment, tool contract obstacle, profile mismatch) → ordinary friction grammar with the concrete symptom as summary and verbatim evidence.
3. No herdr_friction tool mounted? Say so in your report and leave the findings there in the same grammar; the ORCH transcribes them verbatim.
4. File failures only. Do not file "the skill was fine" — silence is the positive signal.

## Mining (the purpose)

Refinement reads `herdr_friction {action:"list"}`: recurring `skill-review` fingerprints argue for pruning or adding routes in `skill_routing.rules` or rewriting a route's `trigger`; recurring non-skill shortfalls point at assignment templates, profiles, or tool contracts. Because only failures are filed, every group is actionable — there is no approval noise to filter out.

## Verification

Before the ORCH finishes: every lane (including the ORCH row) has a silent pass judgment, self-filed frictions, or a named skipped-lane note; transcription happened only where a worker demonstrably could not file; no friction exists for a lane that merely succeeded.
