---
name: build-your-own-jev
description: "How this plugin uses TypeSafe Jev (System One) to move reading out of the LLM context, and how to add a new Jev-backed judgment, hook, or moment without repeating the mistakes already paid for. Use when you are about to add a tool action, a hook, a fixed question set, or a skill that involves reading text to select or judge; when a Jev result looks useless; or when a new session inherits mcp/jev/ and needs the design rules and the evidence behind them."
---

Jev answers fixed questions about text with calibrated probabilities. It never generates. Everything below follows from one goal: **the agent sees the choice, not the text.** Code owns the workflow; Jev supplies the judgment; the calibration log says whether it was right.

## What exists (read these before adding anything)

| Piece | Purpose | Convention it fixes |
|---|---|---|
| `mcp/jev/client.ts` | one POST, two token budgets, type-specific answer validation, `secret()` for credentials | never bypass `assertBudget`; noul/choice/score are validated differently (a Score's `score` is a weighted mean, not an argmax) |
| `mcp/jev/chunk.ts` | markdown by frontmatter+heading, code by top-level declaration, anything else by blank-line blocks | ranges are 1-based inclusive lines; oversize chunks are re-split, never dropped |
| `mcp/jev/questions.ts` | fixed English phrases + `QUESTION_VERSION` | the only place question wording lives; bump the version when wording changes |
| `mcp/jev/rank.ts` | `rankPaths` / `rankChunks` / `rankText`, greedy batching under both budgets, `quality()` | results are complete and ordered; nothing is cut by a threshold inside the tool |
| `mcp/jev/log.ts` | append-only `calibration.jsonl`: `decision` rows per question, `outcome` rows from what happened next | rows carry identifiers (path, range, index) and never document text or keys |
| `mcp/jev/judge.ts`, `check.ts`, `config.ts` | moments `authoring` / `settlement` / `escalate` / `intake` / `plan`; sentence-vs-reference `check`; one config reader (`jev` block → env → defaults) | judge derives canonical run/assignment state where applicable; every judgment remains advisory |
| `mcp/server.ts` | `herdr_jev {action: rank\|judge\|check\|log}`; authoring/settlement response attachments include request IDs | attachments are non-fatal; strict public input and action-specific validation precede outcome mutation |
| `extensions/lib/jev-hooks.ts` | host hooks: long `read` → top ranges + menu; `glob` → ranked footer; `task` result → capped + pointer; other long outputs → ranked blocks | thresholds are env-overridable; every hook falls back to the untouched result on any error |
| `.scratch/jev-*` | throwaway experiments (friction scans, escalation gate, hook smoke) | copy the shape, not the code |

Credentials: `TYPESAFE_API_KEY` (or `JEV_API_KEY`) from the environment or `<agentDir>/herdr-delegator/.env`. There is no on/off switch: without a key the tool errors clearly and the hooks pass through.

## Rules that were paid for (with the evidence)

1. **Name the target by state path.** Question IDs are not sent to the model. A question that says "this item" over a state with 35 items judges nothing in particular. Write `` `items[3].summary` `` in the instructions. Evidence: the first friction scan (193 entries, abstract questions) returned 0.46–0.50 for every category — pure noise; the second (15 entries, path-anchored questions with concrete criteria) returned 0.9+ and matched the human labels.
2. **Criteria are concrete situations; never ask counterfactuals.** "A fixed-question classifier could have produced this decision" scored 0.5 everywhere. "The skill was routed at a moment where it did not apply" separated cleanly.
3. **One request, many independent questions.** Questions run in parallel and cannot see each other. Put the whole judgment set for one state in one call (speculative fan-out); code consumes the applicable answers. A second round trip is only justified when an answer is needed to build the next state.
4. **Two budgets, not one.** state + longest question ≤ 32k tokens and state + all questions ≤ 64k. Batch by items, split inside a file when a chunk is too large, and report `unevaluated` instead of silently truncating.
5. **Return the whole ranking; read it by gap, not by absolute value.** Inside one document unrelated sections still score 0.55–0.65. The top-versus-median gap tells you whether the intent separated anything: sharp ≈ top 0.98 / median 0.11; flat ≈ top 0.64 / median 0.50 (vague intent, or the wrong file).
6. **Intent quality is the lever.** The agent writes the intent freely; the tool tells it when the intent did not distinguish the candidates and asks for a rewrite (`quality()` → footer). Fix wording only for what this track verified: the shapes above. Do not build promotion machinery or presets ahead of evidence.
7. **Hook the host at the right event.** OMP `tool_call` may *revise the input* (not only block): a `read` of a long file becomes `path:start-end` with zero extra round trips; `tool_result` may replace content. Blocking costs a round trip; prefer revision. Everything the server already holds (assignment at `preflight`, report at `wait`) should be judged in the server response, not by a hook.
8. **Log decisions and outcomes separately, and get outcomes for free.** A later selector read of a narrowed file, or an intent change on the same target, is an outcome row without asking the agent anything.
9. **Advisory only.** No Jev result settles, blocks settlement, or changes registry state. It is a table the judging agent reads before deciding.
10. **Write ownership bullets as bare paths.** The first settlement judge on a real assignment returned reject 0.90 because every bullet ended in "(new)"; none classified, so no diff reached the state and three conditions had no evidence. The classifier now strips trailing annotations, and the ORCH writes bare paths. Read the judge's `changed_paths` counts before trusting its `next_action`.
11. **Treat judge-vs-ORCH disagreement as the calibration signal.** A-003: judge reject, ORCH accept after machine checks (cause above). A-004: judge requery, ORCH accept — one condition asked for "a commit removing" files that were never tracked. Log both; they are how thresholds and question wording get fixed with evidence instead of taste.
12. **A "why" sentence can move the authoring score; that is not a comprehension test.** A-004's goal scored purpose 1.57/3; adding one sentence on why the work exists raised it to 2.58/3 with the same completion conditions. This observed response sensitivity does not establish clearer understanding or replace an independent reader.
13. **Validation tolerance must scale.** The API rounds probabilities; a Choice over ~50 paragraph options summed to 0.990 and failed a fixed ±0.01 check. Tolerance is now 0.01 + 0.002 × options.
14. **Ownership still applies to you.** The ORCH once edited a lane-owned file while adding a footer; tsc caught it against the lane's in-progress code. A hook that checks `tool_call` on edit/write against active ownership is an open candidate.
15. **Separate floating-point roundoff from judgment tolerance.** Actual authoring errors printed weighted mean 2.490 versus score 2.47. In an independent deterministic `ask` fixture, JavaScript's mismatch was 0.020000000000000018: the old inclusive-0.02 validator rejected it after two fetches; a scale-aware machine-epsilon allowance accepted it after one. Both versions accepted a 0.01 control and rejected a 0.021 control. This repairs the numeric boundary without tuning the judgment tolerance. The fixture does not reconstruct unretained historical model responses (jev-internalize/2026-09-20, A-009).
16. **Verify validation through the caller's transport, not only the handler.** A-008's real MCP call carried an unknown `note`; the SDK stripped it before the strict handler, and the outcome was appended. A-013 exercised the repaired strict SDK registration: unknown keys were rejected with the log byte-for-byte unchanged, known but action-inappropriate fields also caused no append, and a valid outcome appended exactly once. Handler strictness alone did not prove the public boundary strict (jev-internalize/2026-09-20, A-008/A-013).

## Adding a new judgment — the shape

1. Name the **moment** (when the state exists and who is about to read it) and the **decision** the agent would otherwise make by reading. If the output is generated prose, Jev is not the tool; at most ask a Noul "does this moment need that work at all".
2. Build the state in code from files/registry: named JSON fields, items in a stable order (directory order, file order), text only where the question needs text (paths alone are often enough — `rankPaths` picked the right three of fifteen server files from names).
3. Write the questions in `questions.ts`: English; one narrow proposition each; target by state path; Choice gets a `none`/no-match key when nothing may fit; Score levels describe situations a reader could recognize.
4. Compose in code: max for two phrasings of the same proposition, min for independent requirements (a restatement must match **and** be complete — max let an incomplete restatement pass), thresholds only to choose a one-line `next_action`, never to drop results.
5. Log a `decision` row per question with an identifier target. Decide what later event is the `outcome` and log it from a hook or the next tool call.
6. Verify with real calls on this run's own artifacts and put the printed table, not a raw JSON dump, in the report. Record the actual input tokens and latency; do not reuse another payload's timing as a prediction.
7. Put judgment assistance at an existing response, hook or supported tool boundary. Mandatory role instructions stay whole in the installed packaged role skill; configured advice is delivered beside it, never in place of a missing duty, and a tiny pointer-only skill is not an operating contract. Delivery and actual consumption are separate observations.
8. Prefer no call at all where the answer is already held or deterministic: a known pointer, a short mandatory document, an attached judgment, or anything a parser, filter or hash settles. A judgment earns its place only by changing what a reader opens or decides, and that effect is what the outcome row must record.

## Where the judgments fire now

| moment | where | what the agent sees |
|---|---|---|
| authoring | `herdr_assignment preflight`/`add` → `data.jev`, or supported `herdr_jev judge` | 3 scores, per-condition observability, maturity, profile distribution, next action and request ID |
| settlement | terminal `herdr_assignment wait` / `herdr_worker inspect` → `data.jev`, or supported `herdr_jev judge` | per-condition p_met + independently selected evidence paragraph, ownership observations, next action and request ID; shared-worktree changes are not attribution |
| escalate | `herdr_jev {action:"judge", moment:"escalate", question, context?}` | ASK HUMAN / decide / observe with ladder distribution; advisory, not a replacement for reserved approval |
| intake | `herdr_jev {action:"judge", moment:"intake", track_id, run_id, assignment_id, restatement}` | canonical assignment comparison: goal, completion conditions and boundaries |
| plan | `herdr_jev {action:"judge", moment:"plan", track_id, run_id}` | canonical mandate/plan comparison: unresolved decisions, coverage and boundaries |
| outcome accounting | `herdr_jev {action:"log", op:"outcome", request_id, outcome}` / `op:"summary", request_ids` | identifier-only outcome append or recorded decision/outcome counts; no inferred accuracy or success |
| exploratory read | `herdr_jev rank`, existing read hook or CLI rank | ranked candidate paths/ranges and intent quality; exact named mandatory inputs need no artificial ranking call |

The added intake, plan and log operations are MCP surfaces; do not assume matching CLI commands or an arbitrary configured-moment executor.

Model selection is not a per-call decision: the `jev` block's resolved model (project layer, then user layer, then environment, then default) is what every configuration-aware caller passes to the client, and the portable client only falls back when nobody passed one. A new caller that skips that seam silently runs a different model than the one configured — that was a real defect, reproduced in six isolated processes before it was fixed.

## Numbers to remember

The saved 84-run CSV has a median ORCH peak context of 381,151 tokens. The corresponding conversation-text estimate (`chars / 4`) attributes 61.5% to tool results and 49.5% of tool-result text to reads, with 3,546 read calls. These text-share estimates are not token-meter attribution. The predecessor run's final-handoff cutoff measured peak context 363,499 and 47 read calls; its mutable CSV value 359,045 came from a different cutoff and is not the final close value.

In the independent generated-output fixture, complete role input shrank from 18,810 to 7,994 bytes for ORCH and from 10,215 to 5,665 bytes for the custom worker profile. Those are generated-byte comparisons, not observed savings in agent tokens, time or comprehension. Fresh worker A-014 subsequently reported reading its generated role skill and performing intake; the still-configured external `readchk` route also ran, so this does not establish route-free equivalence. Raw results and provenance live in the `jev-internalize/2026-09-20` verification reports; retain their cutoff and fixture qualifications when citing them.

**Dispositions from the controlled A-005 trial.** Retained: semantic selection of evidence within large or unclear text, explicit no-answer abstention, and the existing batching of independent questions over one state. Removed from mandatory guidance: filename ranking placed before a known authority or a direct symbol lookup — two real questions, two misses, found immediately by a deterministic comparator. Refined: composed `found`/completeness labels (four false-complete pointer labels; split atomic facts and preserve partial scope), parent diagnostics (a 39,103-byte exclusion array dwarfed all its selected evidence, so a parent gets bounded counts plus a pointer while the detail stays recoverable), and configured-model propagation. Deferred, not adopted: injecting track criteria into retrieval (+460/+610 tokens, zero coverage gain) and any generic purpose-retrieval tool or confidence-driven loop — the prototype did not beat the deterministic comparator. None of this measures total agent token or time savings, and none of it is evidence that a judgment improved an outcome; only the recorded outcome rows say that.
