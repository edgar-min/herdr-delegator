# Skill disposition

The plugin combines Jev judgments with role-specific operating skills. A judgment selects evidence or answers a fixed question; the agent still owns decomposition, interpretation, verification and approval boundaries. Supporting text is not factual truth, and agreement with a model is not independent verification.

## Operating surfaces

| Reader | Instructions | Delivery |
|---|---|---|
| Creator outside the new run | `skills/herdr-create/SKILL.md` | Explicitly loaded. Decide whether to create a track; use run-independent rank/check/escalate, distill WHAT/WHY, make one initial open, then retire to the born ORCH. |
| Born ORCH | `skills/herdr-orch/SKILL.md` | The spawn resolves this installed path and names it in the first prompt, with configured ORCH advice and profile-selection metadata inline. |
| Responsibility worker | `skills/herdr-default-worker/SKILL.md`, `skills/herdr-task-worker/SKILL.md`, `skills/herdr-slow-worker/SKILL.md` | Dispatch, including FIFO promotion, resolves the installed skill the assignment's profile selects and names it in the lane's prompt, with only that profile's advice inline. |
| Configuration operator | `skills/herdr-config/SKILL.md` | Query effective layers and provenance, preview and validate changes, then apply only approved configuration edits. |
| Jev developer | `skills/build-your-own-jev/SKILL.md` | Implement fixed judgments through existing client/budgets/logging and retain lessons supported by actual observations. |

Each packaged role skill is complete on its own: no mandatory include, no generated artifact and no other role's document supplies a duty. Mandates and assignments remain separate real inputs. A run materializes no role or guidance artifact at all; role instructions are the installed packaged skills and configured advice rides inline in the prompt.

A-012 rejected the earlier unshipped hint-only worker pilot; that behavior is retained.

Advisory absence or failure never removes a required duty. A missing or unreadable packaged skill, or an assignment profile with no packaged skill, is refused as a capability at `preflight` and again in `add` before the assignment is registered or sealed, with the dispatch-time recheck kept for a later loss; when that late recheck fires, the result names the retained registered assignment instead of reporting no effect. Pointing at a document is not evidence that a session read it. The actual 3.11.0 package includes the separate configuration/development skills and their scripts; A-015 exercised the packaged configuration read/preview path and passed the fixed-source repository check.

## External routes and retained responsibilities

The pilot began with eight user-layer rules containing twelve distinct external skills and thirteen metadata entries. After initially reserving individual approvals, the user expressly authorized removing all routes and metadata; exact pre-edit backups and effective-config validation were retained. The later clarification distinguished those referenced skills from the broader catalog, and the user chose to keep all automatic skill listing off for an experiment. This is local user configuration, not a new shipped default: explicit skill loading/commands remain enabled, and other users may still configure optional routes. The rows below describe retained responsibilities, not complete equivalence to every original skill.

| External skill | Internal role responsibility | Jev support and boundary |
|---|---|---|
| `inquire` | ORCH resolves missing information from evidence and asks only for a surviving human decision. | Plan questions expose unresolved inputs; rank locates evidence; escalation distinguishes observe/decide/ask. The agent generates the actual question. |
| `apportion` | ORCH decomposes by durable responsibility, observable conditions, dependencies and disjoint write ownership. | Authoring checks condition observability/profile fit; plan checks coverage and boundaries. Neither chooses the decomposition. |
| `readchk` | Worker restates goal, conditions and boundaries before execution and corrects mismatches. | Intake compares that restatement with the canonical assignment. A-008 exposed an actual omission and a seven-versus-eight condition count error. |
| `modelchk` | ORCH selects profile and reasoning effort for actual risk using profile descriptions. | Authoring returns a profile distribution; profile fit alone does not select reasoning effort. |
| `hate` | ORCH identifies load-bearing assumptions and tries to falsify them, retaining independent adversarial review where required. | Rank/check locate and compare evidence; the agent generates criticism. |
| `gap` | ORCH compares completion with its conditions and notices missing assumptions; worker names unverified work. | Settlement provides per-condition support, not proof that the condition set was complete. |
| `contextualize` | ORCH judges the result in its actual application context and considers alternatives. | Evidence selection supports this judgment but does not perform it. |
| `sip` | Both roles check applicable clarity, evidence, independence and contextual fit before acceptance. | Authoring, settlement and check cover parts; remaining review is explicit agent work rather than recursive external-skill loading. |
| `factchk` | ORCH obtains direct observations or original sources and judges reliability/currentness. | Check evaluates support in supplied references, not whether the references are true. |
| `skill-retro` | ORCH evaluates lanes and itself, questions shortfalls, and has workers report their own concrete causes; success stays quiet. | Selected-request log summary supplies decision/outcome identifiers. Both role bodies retain the five cause-token/kind mappings and tool-unavailable reporting fallback. |
| `re0-memo` | ORCH preserves verified lessons, contracts and failure examples, separating observation from explanation. | Rank/check retrieve evidence; log summary does not infer accuracy or invent lessons. |
| `re0-work` | ORCH names evidence-backed preserve/discard boundaries and the first end-to-end verification gate on restart. | No probability authorizes a restart. New run/birth, inherited-evidence revalidation and human approval requirements remain explicit. |

`inquire`, `apportion`, `gap` and `contextualize` were unavailable in the pilot. Their configured purposes and proposed replacements were reviewed, but equivalence to their unavailable original texts was not established. `shower` had metadata but no active routing rule.

## Additionally consulted skills

| Skill | Disposition |
|---|---|
| `shower` | Retain independent reading for consequential uncertainty. An authoring-score change is not a fresh reader's comprehension report. |
| `mandela` | Preserve independent-ground-truth checks. Worker self-rating, model agreement and designer-written fixtures have distinct evidentiary limits. |
| `re0` | Keep the plan and final documents current rather than retaining contradictory amendments. This run consolidated its plan; that is not a measured efficiency claim. |
| `arch-mentor` | Preserve understandable explanations of design decisions in the human's language. A personal concept-wiki tutoring workflow is not introduced as a mandatory delegation dependency. |
| `herdr-create` | Retain as the plugin's creator skill, not an operating guide for already-born ORCH/workers. |
| `herdr-config` | Retain actual loader/query/preview operations; configuration provenance cannot be replaced by semantic inference. |
| `build-your-own-jev` | Retain for development, with actual-use lessons rather than user directions recast as measured principles. |

## Executed evidence and limits

Evidence below comes from the `jev-internalize/2026-09-20` assignments. Source handoff, function execution, live model calls and live session consumption are different claims.

- **A-004:** supported MCP escalation returned ASK HUMAN for reserved approval and observe for evidence retrieval. Existing operations and a pinned-root `bun run check` passed. One earlier authoring error body was lost; its cause remains unknown.
- **A-007:** creator wording review and a real supported escalation call passed. No fresh creator birth/retirement or timing improvement was demonstrated.
- **A-008:** real intake corrected an observed misunderstanding; actual plan returned unresolved/coverage warnings; identifier-only outcome and selected-ID accounting worked; the pinned-root check passed. Compact settlement was not exercised through an ORCH identity in that fixture. An unknown `note` key was stripped by the SDK before the strict handler; A-013 subsequently verified the narrow transport repair.
- **A-009:** an independent deterministic validator fixture rejected the mathematically inclusive 0.02 boundary before the repair and accepted it afterward; both versions accepted the smaller control and rejected 0.021. This verifies numeric roundoff handling, not model calibration or the cause of all historical errors.
- **A-010:** direct role-specific review found a worker pre-edit overlap-agreement obligation missing despite its presence in the ORCH body. That omission, restart-gate responsibility and retrospective classification grammar were corrected. A selected ORCH paragraph did not prove a worker obligation.
- **A-012:** real implementation calls generated marked role skills, verified custom-profile isolation and empty advice, preserved historical/unknown digest behavior, distinguished advisory failure from required-output failure, constructed role pointers, and passed one pinned-root check. Generated text retained A-010's corrections.
- **A-013:** real MCP transport rejected unknown keys before handler invocation, left the log byte-for-byte unchanged on rejected calls, accepted one valid outcome append, preserved all five delegation registrations, and passed the pinned-root check.
- **A-014/A-015:** the fresh worker's reported role consumption was independently confirmed in its canonical session: the generated role skill was read and reopened, intake ran twice, and summary/outcome operations succeeded. External `readchk` also ran, so this observation is not route-free. A-015 inspected the actual package, exercised its configuration scripts, passed one fixed-source check, and identified the stale SPEC registration count, which was corrected.

Under A-012's fixture configuration, the ORCH role artifact was **7,994 bytes**, versus **18,810 bytes** for its corresponding old common/role/guidance inputs. The `audit.v2` worker artifact was **5,665 bytes**, versus **10,215 bytes**. These are file-byte comparisons, not measured tokens, runtime savings or quality improvement. Configured external-route pointers still appeared as expected.

A-012 stopped the shared prompt function at a controlled delivery adapter. A-015 independently establishes A-014's actual worker reads, not live FIFO delivery or ORCH duplicate-prompt suppression. The earlier hint pilot also required rank in its assignments, so observed use cannot isolate the protocol hint's causal effect.

At A-015's explicit cutoff (2026-09-20T11:21:24.790Z), the current ORCH measured peak prompt context **231,877** and **128** read calls; the predecessor final-handoff cutoff measured **363,499** and **47**. The fixed 84-run median peak was **381,151**; its **3,546** reads were an aggregate, not a median. Work, models and durations differ, so these are observations, not causal savings.

User-defined `jev.moments` still has configuration storage without a verified generic executor. Named implemented moments do not make that surface executable. No fresh creator birth/retirement, live ORCH duplicate suppression, live FIFO delivery, broad judgment equivalence or publication is claimed. Route-free fresh-worker evidence is tracked separately from the earlier routed pilot.
