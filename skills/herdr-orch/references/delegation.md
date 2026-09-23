# Delegation

This is the only place that decides who does a piece of work: you, a responsibility lane, or a host subagent. Other references assume these rules and never restate them. The two obligations in `../SKILL.md` — keep the context boundary deliberate; delegate by default but never as an excuse — are what every rule here serves.

Delegation keeps evidence, output, and transcripts out of your window first, and runs work in parallel second. Some work cannot be delegated: a problem may need the judgment, context, or capability the cheaper minds lack, and for a complex piece of work doing it yourself, or running the smallest experiment and then giving direction from what you learned, can cost less than an assignment plus the failed attempts, decision requests, and verification it would generate. Judge total cost, not the cost of the first attempt. When you take work yourself on that ground, record in `plan.md` what you did and why the total cost favoured it; when you delegate something you would otherwise have judged yourself, record what evidence will let you judge it from outside.

## Context boundary

| Enters this window | Stays out |
|---|---|
| The mandate, `plan.md`, decisions, and the sections of a document a decision turns on | Evidence bodies: harness output, test logs, measurement tables beyond the pass/fail row |
| The summary immediately before a lane report's completion block and the delegated completion-condition table | The rest of a lane report; a worker's transcript; a subagent's working notes |
| Cited lines requested when a summary and its evidence table disagree | Whole files read in the hope of finding something |
| Tool results that establish state (settlement, drift, budget) | Metadata, pane text, doorbell prose |
| Your own minimal experiment under rule 2 and its result | Anything a subagent can measure and report as a table |

Never read a lane report in full. If the summary and the evidence table disagree, request the cited lines only.

## Three routes

Decide the route from signals that are visible in the work itself, in this order; the first row whose signal is present wins.

| Signal in the work | Route | Because |
|---|---|---|
| The result is a decision, a direction, a rejected alternative, an assignment, `plan.md`, an `[ORCH Response]`, an acceptance, a guarded MCP call, or a reply to the user | **Yourself** | These are command; handing them down loses the context that makes them right |
| The problem needs a capability the cheaper minds lack, or a small experiment would settle direction more cheaply than an assignment plus its failed attempts and verification | **Yourself** | Rule 2 of `SKILL.md`; record the ground in `plan.md` |
| The work is one call's worth of measurement or transcription with a table as its result: run a harness and return pass/fail, compress a report into a completion-condition table, re-measure coordinates, cross-check code against a claim, reproduce a worker's claim in a separate temporary root | **Host subagent** | Nothing has to be remembered after the table is returned |
| The work produces or changes project artifacts, or reviews them, under a specification mature enough for a profile, inside ownership that is clear, and a later assignment on the same responsibility is plausible | **Responsibility lane** | Persistent context and write ownership are what a lane provides and a subagent cannot |
| The work is mechanical and bounded but you want it on a lane for parallelism, or to avoid settling who owns the files | **Host subagent** or **Yourself**, never a lane | A lane manufactured for parallelism or to bypass ownership is the failure mode this table exists to stop |

Independent reproduction is always the host-subagent row: an executor other than the worker takes the worker's outputs by hash into a separate temporary root and exercises them there. Do not run the check yourself merely to change executor identity.

## Cost gate

Before an assignment is registered or a review lane re-engaged, answer in one sentence why this profile and this many rounds are worth their cost against the cost of the error they prevent. If you cannot, reduce the scale, do it yourself under rule 2, or stop. The sentence goes into `plan.md` with the dispatch record.

## Profile selection

| profile | role | intent |
| --- | --- | --- |
| `default` | `@default` | Meticulous and linguistically strong general-purpose default. Assign dialogue-faithful execution, precise language/document work, and work where verification budget must stay thin. Do not assign: wide-discretion design work — meticulousness inverts into over-engineering; narrow the specification first if you must. |
| `task` | `@task` | Highest output ceiling on concrete code implementation. Assign implementation, refactors, and integration with a mature specification. Do not assign: immature specifications — they yield high-quality-looking wrong answers. Verify this profile's completions more deeply than other lanes. |
| `slow` | `@slow` | Deepest reasoning. Assign work where judgment quality dominates: plan rebuttal and verification, design-fork research, audits — right before judgments whose failure is expensive. Do not assign: artifact implementation — this lane is delegated thinking, not execution. |

Selection axes: specification maturity × cost of error. Each profile has its own worker skill; the dispatch pointer names it, and the worker reads there what to read at each moment of its work, so no routing configuration decides which skills a worker sees.
