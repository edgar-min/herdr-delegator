---
name: jev-delegation
description: "When an orchestrator or worker is about to read a document and judge it item by item, hand the judgment to Jev instead: what to delegate, what never to, and how to build the state, definitions and questions so the answers reproduce a careful reader's. Measured on the inquire Phase 0 scan (skills-jev-dialogue-review/r2, 2026-09-21): same judgments as slow/default workers in ~1 s and ~9k tokens instead of 80–120 s and 30k+ tokens."
---

Jev (TypeSafe System One) answers a fixed set of questions about one JSON state with calibrated probabilities. It never generates text, it holds no priors about your domain, and it runs in about a second. Everything below is what it took to make its per-passage judgments match a careful reader's on a real mandate. Evidence: `protocols/inquire/fixtures/hexddd-rules-8.*` on branch `review/orch-routing-jev`.

## What to delegate

| Delegate | Because |
|---|---|
| Classifying every item of a fixed document into a small named vocabulary (`self_contained` / `lookup_named` / `facts_unnamed` / `decision_missing`) | 53 passages judged in one 0.9 s request; two workers needed 83 s and 122 s and 30k+ input tokens each for the same table |
| "Is this document sufficient to act on" and other existence checks over the whole state | one `noul`, stable across runs (0.11–0.14) |
| Anything a worker would do by re-reading the same text with the same rubric | workers agreed with each other on 23/27; Jev reached 47–48/53 against an adjudicated reference |

Cost is not the reason: a million tokens is cents. The reason is time and that the orchestrator's context never holds the text.

## What never to delegate

- **Generation.** Candidate lists, rationales, claim extraction, restatements. Jev picks among options you supply; the passages of the document are the options.
- **Judgments whose frame is not in the state.** Jev does not know that "a constraint is obeyed, not executed". Without that sentence in the state it scored constraints 1–3 where every reader said 0 (13/23 → 21/23 once defined). If you cannot write the frame down, a worker still has to judge.
- **Acts of authority.** A user's answer, an approval, a settlement, a lane's completion. A probability is evidence the deciding agent reads; the domain code must refuse to accept a Jev verdict where a `by: "user"` event is required.
- **Facts a parser or hash settles.** Reference existence, counts, hash drift, cycle detection. Asking a model is slower and worse.
- **Items whose probability sits near the threshold.** At p 0.25–0.45 the argmax flips between identical runs. Route those to a worker or the human; do not average them away.

## How to delegate

### 1. Fix the state per stage; move everything that varies into the questions

The state Jev sees for one stage is one document, byte-identical for every question and every run of that stage. The passages to judge are addressed by JSON path (`mandate.constraints.prohibitions[3]`) inside the questions. Never put candidates, evidence or previous answers into the state of a stage that is meant to be fixed; open a new stage with its own fixed state instead. Calibration only accumulates on a fixed state.

### 2. Define every vocabulary key, in a separate `definitions` block

The single largest gain came from adding definitions of the document's own keys (what a constraint is, what a boundary is, what `settled` means), not from rewording questions. Measured on the same questions: no definitions 12–13/23; definitions 17–21/23. Rules:

- Define every key the document uses. Undefined keys are where flat 0.30/0.30/0.20/0.20 distributions come from.
- Keep definitions in one top-level block, not adjacent to each key: adjacent placement cost 2 points and raised P(sufficient) from 0.12 to 0.20 on the same content.
- Remove definitions that do not move the result. Five individually neutral definitions removed together raised agreement 20 → 21 and stabilized a borderline item; a definition can overfit exactly like a question.
- Keep the level definitions in the state as well as in the criteria: removing them dropped three constraints.

### 3. Shape the input document so each item has one nature

Most residual disagreements were sentences that mixed a prohibition with a procedure, a duty with a fact claim, or an outcome with a conditional decision. Splitting at sentence boundaries (never rewording) resolved them; the creator must write items that way from the start. The measured rules:

- One sentence per item. A bundled item gets one label for all its parts.
- Group obligations by kind (`prohibitions` / `procedures` / `invariants`) and separate authority (`boundaries.user` / `orch` / `workers`) from obligations. Pure prohibitions and procedures then reproduce at 9/10 and 11/13.
- A boundary names a class of decisions; the specific open matter lives in the work items only. Jev reads a boundary that repeats an open matter as an open decision — and is not wrong to.
- An invariant states the duty; the claim that it holds now belongs with the background facts and their source.
- Completion conditions: one observable condition per item; a conditional decision is its own item.

### 4. Choose the question type by the shape of the answer

- `choice` with the option names as the vocabulary and the definitions as the criteria. Equivalent to an ordered `score` on the same state (19/23 each) and it puts the definitions where the user reads them.
- `noul` for existence and sufficiency.
- Do **not** decompose an ordered level into independent `noul`s (lookup? fact? decision?). Every aspect scored above 0.5 on almost every passage; the fold-by-threshold produced 12/23 with no confidence signal.
- Address each question by path and use the domain's verb ("to comply with this constraint", "to judge this outcome as met", "to carry out this item"). The verb alone moved nothing; it is hygiene, not a lever.

### 5. Send the whole document in one request

- Isolating the state per domain (constraints alone, intent alone) dropped agreement 46 → 40/53: procedures need the intent beside them to read as "already decided", outcomes need the work items to know which decisions are open.
- Judging fewer domains did not improve the ones kept (E3: 76% vs 86% on the same items).
- One request, all questions: 53 questions, ~9.6k input tokens, under the 32k/64k budgets by a wide margin.

### 6. Do not add meta-instructions to the questions

"Judge what this passage itself requires; matters another passage opens are counted there" fixed one item and zeroed the user-approval outcomes (3 → 0). "If more than one option applies choose the last" pushed every boundary that mentions a decision to 3. Both dropped agreement by 3–4. Fix the document and the definitions; leave the question a plain question.

### 7. Build the reference before tuning, then ablate

1. Have two workers of different profiles answer the same questions in natural language (same state, same rubric, timestamps required). Their agreement (23/27 here) is the first baseline; their disagreements are the first list of ambiguous items.
2. Adjudicate the disputed items yourself and freeze a reference over every passage. Jev was right on 6 of the 11 disputed fragments; the workers' bundled labels were inherited wrongly by fragments.
3. Score every change against the reference, per domain, twice. Runs are deterministic except items with p 0.25–0.45 (±1 across runs). Report agreement, off-by-one count, and agreement restricted to confidence ≥ 0.35.
4. Ablate one element at a time, then remove the neutral ones together; interactions exist (neutral singly, load-bearing jointly for constraint stability).
5. Stop when the residual disagreements are ones you cannot adjudicate yourself. Two remained here; both are authoring-rule violations in the input, not model error.

### 8. Read the answers as evidence, not as a decision

- Keep the probabilities beside the argmax in the record; the `p(want)` column is what tells you a change helped.
- Treat P(sufficient) drift as a noise indicator: adding handoff prose raised it 0.14 → 0.23 without improving any item.
- A confident wrong answer (p 0.95 on a fragment the reference labeled by its bundle) is usually the reference being wrong.

## Numbers from the scan track

| what | value |
|---|---|
| Jev per request | jev-1.13.0, 0.7–1.0 s, 8–12k input / 0.6–2.2k output tokens |
| slow worker (same rubric) | 122 s judging, 33k input + 174k cache read, 4.9k output |
| default worker | 83 s judging, 31k input + 204k cache read, 3.6k output |
| worker–worker agreement | 23/27 |
| Jev vs workers, no definitions | 11–13/23 |
| Jev vs workers, definitions block | 21/23 (×3 identical runs) |
| Jev vs adjudicated reference, final state | 47–48/53; 2 stable disagreements, 4 borderline |

## Known pitfalls

- The client validates a `score` against its weighted mean with ±0.02 tolerance; the API occasionally returns 0.03 off and the request fails after two fetches. Retry once; do not loosen the check blindly.
- `score` answers give a weighted mean, `choice` answers give an argmax; compare them by argmax only.
- Keep API keys in `TYPESAFE_API_KEY`/`JEV_API_KEY` or `<agentDir>/herdr-delegator/.env`; never in the state, a fixture, or a report.

## Where the code is

- Pure protocol logic: `protocols/inquire/domain/` (phase transitions that refuse resolution without evidence and answers not from the user).
- Scan adapter and runner: `protocols/inquire/adapters/jev-scan.ts`, `scripts/scan-experiment.ts`, `scripts/scan-compare.ts`; the approved question version is `2026-09-21.3` (`choice`).
- States, results, baselines: `protocols/inquire/fixtures/hexddd-rules-8.*` (v2 → v9 is the full ablation history).
- The generic client: `mcp/jev/client.ts` (portable by copying).
