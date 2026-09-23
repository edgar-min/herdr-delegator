# Plan and route responsibilities

A responsibility key names durable direction, ownership, and context. Reuse an exact
responsibility lane by default. Busyness alone never justifies another lane. Separate
the same responsibility only when direction, ownership, or dependency genuinely
requires isolation, and record that witness in the plan and assignment.

Use host OMP task/subagents for bounded mechanical work that needs no persistent
responsibility. Do not create Herdr lanes to manufacture parallelism or bypass
uncertain ownership, identity, or topology.

By default, after writing the draft `plan.md` with the user and before freezing it,
dispatch a slow-profile lane charged as its adversary: it attacks omissions, unstated
assumptions, and vulnerabilities and returns evidence-cited findings through its lane
report. Answer each round with an `[ORCH Response]`, fold accepted findings into the
plan, and re-engage the lane for the next round until one yields no blocking findings or
you record acceptance with grounds. Record the review lane and every finding's
disposition in `plan.md`; route items requiring user authority through the judgment
ladder. A trivially fixed plan may skip this review when `plan.md` records that judgment.

Before dispatch, ensure the assignment states the complete goal, observable completion
conditions, exact write ownership, dependencies, and user boundaries in language the
worker can execute without chat history. Run the tool's preflight and accept its
canonical hash; after dispatch, never rewrite the assignment — a successful add makes
the file read-only, and a correction is a NEW assignment.

The assignment file and settlement block grammar is in
`mcp://herdr://contract` §Assignment and settlement grammar.

## Profile selection

| profile | role | intent |
| --- | --- | --- |
| `default` | `@default` | Meticulous and linguistically strong general-purpose default. Assign dialogue-faithful execution, precise language/document work, and work where verification budget must stay thin. Do not assign: wide-discretion design work — meticulousness inverts into over-engineering; narrow the specification first if you must. |
| `task` | `@task` | Highest output ceiling on concrete code implementation. Assign implementation, refactors, and integration with a mature specification. Do not assign: immature specifications — they yield high-quality-looking wrong answers. Verify this profile's completions more deeply than other lanes. |
| `slow` | `@slow` | Deepest reasoning. Assign work where judgment quality dominates: plan rebuttal and verification, design-fork research, audits — right before judgments whose failure is expensive. Do not assign: artifact implementation — this lane is delegated thinking, not execution. |

Selection axes: specification maturity × cost of error. Bounded mechanical work goes to
host OMP subagents without a lane.

An uninstalled optional skill is a no-op. A skill without an authored intent is read at
`skill://<name>`.
