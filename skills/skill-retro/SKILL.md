---
name: skill-retro
description: "Run-close worker retrospective for a herdr ORCH session. Before closing, handing off, or resetting a run, the ORCH — the session holding the most context — evaluates each worker lane it commanded (and itself) against expectations; where performance fell short, it questions that worker through its lane report plus a wake_worker doorbell, then files only the failure evidence as frictions. Success stays silent: no noise, negative evidence only. Use when closing or resetting a herdr run, or when the user asks to retrospect a run's workers."
---

The ORCH ends a run holding more context than anyone: every assignment, settlement, token bill, rework loop, and skill route that fired. This skill spends a little of that context once, at the end, to collect the only evidence worth keeping — what underperformed and why. Lanes that met expectations are passed over in silence; the friction log accumulates failures, not ceremony.

## When

At the run's close/handoff/reset boundary, before the closing operation. ORCH-only; workers never need herdr_* mounts (they may lack them — known open friction), because the ORCH transcribes.

## Workflow

1. **Evaluate each lane against expectation, from evidence you already hold.** For every worker lane (and yourself as one more row): settlement outcomes vs the assignment's completion conditions, token/time spent vs what the artifact justifies, rework or blocked loops, report quality, and which routed skills fired there. The question per lane is one sentence: *did this lane deliver what its spend predicts?*
2. **Silence for lanes that pass.** No friction, no note, no doorbell. Passing is the expected state, not evidence.
3. **Question the lanes that fall short.** When performance missed expectation and the report alone does not explain why, append one `[ORCH Response]` question block to that lane's report — name the shortfall concretely (e.g., "P-7 took three attempts and 40% of your spend; what got in the way?") — then ring `herdr_message {action:"wake_worker"}`. Candidate causes worth probing: a routed skill that consumed context without helping, overlapping skills doing the same work, a skill it reached for off-list, a skill it lacked, an ambiguous assignment, a tool contract obstacle. The worker answers in its own report prose.
4. **File only failure evidence, ORCH-authored.** One `herdr_friction report` per confirmed shortfall, citing the lane's answer and/or your own observation as evidence (`track_id`/`run_id` included; the worker never calls herdr_*):
   - Skill-caused → `summary: "skill-review: <skill> — <wasted-context|redundant-overlap|unrouted-but-used|trigger-mismatch|missing-wish>"`, `tool`: the skill name, `kind`: excessive-steps / papercut / doc-drift / doc-drift / contract-gap respectively. This fixed grammar is what lets routing refinement group findings by skill.
   - Other causes (assignment ambiguity, tool contract, profile mismatch) → ordinary friction grammar with the concrete symptom as summary.
   - Your own shortfalls as ORCH are filed the same way — self-evaluation is one more lane row.
5. **Do not block the close on answers.** A worker that cannot be woken (dead pane, closed lane) is judged from its durable report alone; note the unanswered question in the closing record instead of waiting.

## Mining (the purpose)

Refinement reads `herdr_friction {action:"list"}`: recurring `skill-review` fingerprints argue for pruning or adding routes in `skill_routing.rules` or rewriting a route's `trigger`; recurring non-skill shortfalls point at assignment templates, profiles, or tool contracts. Because only failures are filed, every group is actionable — there is no approval noise to filter out.

## Verification

Before finishing: every lane (including the ORCH row) has either a silent pass judgment or a filed friction; every filed friction cites evidence a later reader can re-check; no friction was filed for a lane that merely succeeded.
