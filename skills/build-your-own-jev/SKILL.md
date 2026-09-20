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
| `mcp/jev/judge.ts`, `check.ts`, `config.ts` | moments `authoring` / `settlement` / `escalate`; sentence-vs-reference `check`; one config reader (`jev` block → env → defaults) | judge builds its own state from files and the registry, read-only; every result ends with `advisory` |
| `mcp/server.ts` | `herdr_jev {action: rank\|judge\|check}`; `preflight`/`add` responses carry `data.jev` authoring, terminal `wait`/`inspect` carry `data.jev` settlement | attachments are non-fatal: a Jev failure becomes `data.jev.error`, never a refused call |
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
12. **One "why" sentence moves the authoring score.** A-004's goal scored purpose 1.57/3; adding a single sentence on why the work exists raised it to 2.58/3 with the same completion conditions. That is the shower replacement in practice: 0.7 s, 3k tokens, no sub-session.
13. **Validation tolerance must scale.** The API rounds probabilities; a Choice over ~50 paragraph options summed to 0.990 and failed a fixed ±0.01 check. Tolerance is now 0.01 + 0.002 × options.
14. **Ownership still applies to you.** The ORCH once edited a lane-owned file while adding a footer; tsc caught it against the lane's in-progress code. A hook that checks `tool_call` on edit/write against active ownership is an open candidate.

## Adding a new judgment — the shape

1. Name the **moment** (when the state exists and who is about to read it) and the **decision** the agent would otherwise make by reading. If the output is generated prose, Jev is not the tool; at most ask a Noul "does this moment need that work at all".
2. Build the state in code from files/registry: named JSON fields, items in a stable order (directory order, file order), text only where the question needs text (paths alone are often enough — `rankPaths` picked the right three of fifteen server files from names).
3. Write the questions in `questions.ts`: English; one narrow proposition each; target by state path; Choice gets a `none`/no-match key when nothing may fit; Score levels describe situations a reader could recognize.
4. Compose in code: max for two phrasings of the same proposition, min for independent requirements (a restatement must match **and** be complete — max let an incomplete restatement pass), thresholds only to choose a one-line `next_action`, never to drop results.
5. Log a `decision` row per question with an identifier target. Decide what later event is the `outcome` and log it from a hook or the next tool call.
6. Verify with real calls on this run's own artifacts and paste the printed table, not JSON, into the report. Note the token count and latency (a 12k-token rank of a 674-line file takes about one second).
7. Surface it where the agent already is: a server response field, a hook footer, or a CLI subcommand — a new skill document is the last resort, and it is five lines that name the action and the branch.

## Where the judgments fire now

| moment | where | what the agent sees |
|---|---|---|
| authoring | `herdr_assignment preflight`/`add` → `data.jev`, or `cli judge --moment authoring --file` | 3 scores, per-condition observability, maturity, profile distribution vs declared, one-line next action |
| settlement | terminal `herdr_assignment wait` / `herdr_worker inspect` → `data.jev`, or `cli judge --moment settlement` | per-condition p_met + evidence paragraph, claims/evidence separation, out-of-scope probability, changed paths by ownership, next action |
| escalate | `cli judge --moment escalate --question … --context …` | ASK HUMAN / decide / observe with the ladder distribution — used before interrupting the user |
| any read | `read` hook, `cli rank` | top ranges + menu + intent quality |

## Numbers to remember

Baseline over 84 runs: ORCH peak context median 381k tokens; 62% of it tool results, half of those `read`. A rank call costs 1–13k Jev input tokens ($0.042 per million) and returns in 0.3–1.6 s. Pilot scans: 176 KB of friction log → 60 lines read by the ORCH. In the run that built this (jev-tools/2026-09-20, hooks not yet live, CLI used by hand), the ORCH settled two implementation assignments without opening a lane report, and its peak context was 359k tokens at close against a baseline median of 381k — a modest peak difference, because most of that session was design conversation; the per-read savings are in the run's observations.md §F.
