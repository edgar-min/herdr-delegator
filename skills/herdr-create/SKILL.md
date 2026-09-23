---
name: herdr-create
description: Create a Herdr track from a session outside it by writing a mandate — the invocation of one planning protocol — and handing it to the born orchestrator. Creator-only; not an ORCH or worker operating guide.
license: Apache-2.0
compatibility: Requires Oh My Pi 18.0.5 or later, Herdr 0.8.2, Bun, and an OMP-managed Herdr integration.
metadata:
  author: edgar-min
  version: "4.0.1"
---

# Herdr track creation

Use this skill only in a session that may create a track. The session `herdr_track open` creates becomes the track's orchestrator (**ORCH**); this creator never becomes ORCH and must not continue the track after birth.

This document is complete for the creator role. Reply in the human's language and tone. Follow their user-level `AGENTS.md` throughout.

## What a mandate is

A mandate is the **invocation of one planning protocol** in a new track. It is JSON, written in English, validated by `references/mandate.schema.json`, and it carries only what the protocol needs and what the new track cannot learn on its own:

| Field | Carries |
| --- | --- |
| `purpose` | Why the track exists, one sentence in the user's terms |
| `language` | BCP-47 tag of the creator conversation's language; the ORCH speaks it from its first turn |
| `entry` | The protocol the ORCH runs first, the exact `utterance` it receives, and the deficit that chose it |
| `settled` | Decisions the user already made — `decision`, `source`, `reason` or `"unstated"` |
| `substrate` | Where the user's externalized thinking lives, one coordinate per item |
| `open` | What is not settled, kept open on purpose, with any candidates already named |
| `done_when` | Observable conditions, each verifiable from a durable record |
| `forbidden` | Track-specific prohibitions and every action the user reserves in this track |
| `budget` | Tokens, minutes, doorbell policy |

Everything true of every track belongs in the common contract (`herdr-delegator://contract`) or in the role skills (`herdr-orch`, `herdr-worker-default`, `herdr-worker-slow`, `herdr-worker-task`), not in the mandate. The one test for every sentence: **would it be true in another track?** If yes, leave it out. `references/mandate.example.json` is a complete mandate written under this rule.

## How the ORCH receives it

The born ORCH's first prompt names its `mandate.json` and the skill `herdr-orch`; that skill's `skill://herdr-orch/references/first-turn.md` makes it execute `entry.protocol` verbatim from `herdr-delegator://protocol/<protocol>` with `entry.utterance` as its input and stops it at the continuation guard. The interview with the user happens **in the new track**, through the protocol — never here.

## Distill, do not interview

Distill the conversation already held. Do not ask the user to specify what you are about to hand away; an interview held here leaves its context here.

1. **Never close an open matter by guessing.** Anything the conversation did not settle goes into `open[]` as the user would phrase it, with candidates already named. A reading of your own — what you think the user wants, why they decided something — is not a decision: it goes into `open[]` too, or is dropped.
2. **`settled` holds only the user's decisions.** Each with its `source` (a run document and section, or `user, creator conversation <date>`) and the reason the user gave, or exactly `"unstated"`. Never supply a reason yourself.
3. **Reconcile every reservation.** Every approval, lifecycle, remote-change and acceptance authority the user reserved in the conversation appears in `forbidden` unless the MCP resource `herdr-delegator://contract` §Reserved to the user already names it. Read that section from the server the track will be opened on. Deleting a reservation is not migrating it.
4. **One unit per item, coordinate inline.** Each judged string is one English sentence that stands on its own: no pronoun pointing outside it, no "above", one place or one claim, and every reference carries its path, section, commit, URL or run document. Original wording the user cares about is kept inside the item.
5. **Route by the gates, not by convenience.** Choose `entry.protocol` from the gate descriptions in the schema, in their precedence. Write `entry.utterance` as the text the protocol will actually receive, naming the bound `substrate` items by their coordinates and the bound open items by their role ("the bound open item"); `entry.binds` carries those open coordinates, and `preview` and `elicit` require it. If no gate holds, the mandate is not ready: record why in `open[]` and do not open.
6. **Self-contained for the judge.** Every decision the mandate depends on is carried in `settled[].decision` as the user made it; `source` is provenance, never a substitute for the text. `done_when` and `forbidden` may only rely on what the mandate itself carries, because the check judges the mandate alone and cannot open the documents it points at. Refresh the draft every time a decision lands: a mandate written before a decision and opened after it is how a track inherits a contradiction no check can see.

## Check before you open

Check the draft through the server, inline — never by writing a draft file into the user's project:

    herdr_track {action:"check", track_id, run_id, cwd: "<project dir>", mandate: {…}}

It returns `data.lines[]` of `{ok, rule, detail}` and `data.verdict`. Its deterministic half validates the schema, refuses an `entry.protocol` that `protocols/UPSTREAM.json` does not pin, verifies `protocols/contract.md` against `protocols/CONTRACT.json`, reports that contract's sha256 and the sha256 of the installed `skills/herdr-orch/SKILL.md`, resolves every `entry.binds` coordinate against `open[]`, enforces the structural gate conjuncts (`preview` needs every bound open item to carry at least two candidates, `elicit` needs at least one substrate item), flags judged units that break the one-unit rule — including an `open[N]` coordinate left in the utterance — and refuses a substrate path that does not exist where the track will run. Its judged half asks a Jev judge four questions on a state that omits `entry.protocol` and `entry.reason` and carries the exact `herdr-delegator://contract` §Reserved to the user text as `universal_reservations`: which protocol's gate holds (a disagreement is shown with both readings and never resolved silently, `not-track-worthy` says the work needs no track at all, and a judge at or under 0.35 confidence leaves your choice standing), whether a settled decision or forbidden item contradicts each `done_when`, whether each substrate sentence still describes what its coordinate holds, and whether any judged unit is universal rather than track-specific. Without a Jev key the judged half reports `skipped (no Jev key)` and the deterministic verdict stands. Fix and re-check until `data.verdict` is `PASSED`; `open` runs the same check and refuses a FAILED verdict as `mandate_check_failed`.

## Show, then open once

Show the user the complete JSON exactly as it will be sent and ask for "open". Say what that word authorizes: the birth of the ORCH and its execution of `entry.protocol` on `entry.utterance` — not implementation, not dispatch, not any action listed in `forbidden`. Do not open on a partial reading of approval.

Then make exactly one `herdr_track` call with `action: "open"`, the project working directory, and the same mandate object inline — the draft lives in this conversation and in that call, never as a file in the user's project. The server re-runs the check, writes `<run>/mandate.json`, fingerprints it, and births the ORCH. Do not lay out run files, start an orchestrator separately, edit tool-owned state, or compensate for a failed open; follow the returned recovery exactly.

## Redirect, then die well

Relay the returned `next_step` and any warning, in the user's language. Then stop all work for this track: do not plan, call guarded operations, inspect workers, or answer further track questions. Direct the user to the born ORCH pane, which owns the conversation from here.

Keep secrets and document bodies out of tool inputs and terminal output.
