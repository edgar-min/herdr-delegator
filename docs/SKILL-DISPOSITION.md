# Skill disposition — what the moments absorbed

The plugin used to route thirteen external skills to protocol boundaries through `skill_routing`. A routed skill is
advisory text: it fires whether or not the moment needs it, and a scan of this track's own runs found ten of the
fifteen observed frictions came from a route firing where it did not apply. A Jev moment is the same judgment
made by a fixed question set over state the server already holds, so the judgment happens once, costs a
probability instead of a context window, and leaves a calibration row behind.

This table is the disposition of each routed skill. "Absorbed" means the moment below asks the same question with
fixed wording; "deleted" means the skill's output is generated prose, which Jev never produces and which the
moment therefore cannot replace — the work stays with the agent.

| Skill | Disposition | Moment | Question that absorbs it |
|---|---|---|---|
| `inquire` | absorbed | `plan` | Noul: the plan leaves a point undecided that the work depends on |
| `apportion` | absorbed (trigger only) | `plan` | Noul: the completion conditions are observable, so the split can be judged |
| `shower` | absorbed | `authoring` | Score: the purpose of `assignment.goal` is understandable without prior context |
| `modelchk` | absorbed | `authoring` | Choice over the configured worker profiles, criteria being their `intent` strings |
| `factchk` | absorbed | `authoring`, and `check` | `check`: the sentence is supported by a chunk of the reference documents, or `none` |
| `readchk` | absorbed | `intake` | Noul (combined by min): the restatement matches the instruction and is complete |
| `gap` | absorbed | `settlement` | Noul per condition: the condition is met according to the report and the owned diff |
| `contextualize` | absorbed | `settlement` | Choice over `report.paragraphs` with a `none` sentinel: which paragraph is the evidence |
| `sip` | absorbed | `settlement` | Noul: the report separates what it claims from the evidence it cites |
| `skill-retro` | absorbed | `close` | the calibration log aggregate: decision rows against outcome rows |
| `re0-memo` | absorbed | `close` | same aggregate, read as what the next cycle should learn |
| `hate` | deleted (generative) | — | its output is authored criticism, not a selection among known options |
| `re0-work` | deleted (generative) | — | restarting an artifact is authoring work; no probability decides it |

`herdr-delegation` was also routed as a skill. It is not in the table because it was never a judgment: it is the
protocol, and it now lives in the tool descriptions and `skills/herdr-delegation/SKILL.md`.

Two moments beyond the table exist because they are judgments no external skill covered:

| Moment | What it decides |
|---|---|
| `settlement` next action | Score over `[reject, requery, accept]` — what the ORCH should do with the reported boundary |
| `escalate` | Choice over `{autonomous, machine_check, human}` plus blocking and reversibility — whether a question is worth a human's attention |

Adding one is described in [`skills/build-your-own-jev/SKILL.md`](../skills/build-your-own-jev/SKILL.md); a moment
you define yourself goes in the `jev.moments` array of your configuration, in the same shape the built-in ones use.
