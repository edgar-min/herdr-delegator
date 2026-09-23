# Track handoff — <source track_id/run_id> to <target track_id/run_id>

Written by the source run's ORCH on <date>. This document transfers durable state to the target ORCH; conversation memory is not authority. ORCH rules are in `skill://herdr-orch`; worker rules are in `herdr-delegator://contract`, `herdr-delegator://worker`, and the profile skill named by each dispatch pointer: `skill://herdr-worker-default`, `skill://herdr-worker-slow`, or `skill://herdr-worker-task`.

## 1. Outcome and review

- Source run: `<track_id>/<run_id>`
- Target run: `<track_id>/<run_id>`
- Source and target `run.json`: `<coordinates and SHA-256>`
- Source and target `plan.md`: `<coordinates and SHA-256>`
- Implementation review: `<status and findings>`
- Verification: `<status and evidence coordinates>`
- Closure judgment: `<status and open conditions>`
- Promoted durable artifacts: `<coordinates and reason>`

## 2. Configuration and environment

| Layer | Coordinate | SHA-256/status | Storage effect | Role/profile effect |
|---|---|---|---|---|
| User | `${PI_CODING_AGENT_DIR}/herdr-delegator.json` or `~/.omp/agent/herdr-delegator.json` | `<hash/absent/conflict>` | `<resolved/none>` | `<summary>` |
| Project | `<cwd>/.omp/herdr-delegator.json` | `<hash/absent/conflict>` | `<resolved/none>` | `<summary>` |
| Source run | `<source run>/herdr-delegator.json` | `<hash/absent/conflict>` | `<must not relocate>` | `<summary>` |
| Target run | `<target run>/herdr-delegator.json` | `<hash/absent/conflict>` | `<must not relocate>` | `<summary>` |

- Canonical project `cwd`: `<absolute path>`
- Resolved storage root: `<absolute path observation>`
- Storage index observation: `<version/row/status>`
- Configured ORCH and worker role aliases: `<role/profile mappings>`
- Verified launch observations: `<provider/model/thinking facts and coordinates>`

## 3. ORCH identities

### Source ORCH

- Configured OMP role alias: `<role>`
- Verified provider/model/thinking: `<facts and timestamp>`
- Official session ID/path: `<verified coordinate>`
- Latest live state and sequence: `<state; state_change_seq; inspection>`
- Report: `<coordinate and review status>`

### Target ORCH

- Installed role skill: `skill://herdr-orch`
- Configured role alias and thinking: `<alias; explicit level or inherit; config hashes>`
- Official session ID/path: `<verified coordinate>`
- Latest live state and sequence: `<state; state_change_seq; inspection>`
- Report: `<coordinate and review status>`

## 4. Responsibility lanes

State only; routing, separation, reuse, inspection, and lifecycle rules are in `skill://herdr-orch` and its references.

| Run | Worker | Responsibility | Separation | Profile skill | Active assignment | FIFO queue | Last completed | Lane state/seq | Resume status |
|---|---|---|---|---|---|---|---|---|---|
| `<source/target>` | `w<N>` | `<key>` | `<primary or kind/reason/conflict>` | `skill://herdr-worker-<profile>` | `<A-NNN/none>` | `<IDs>` | `<A-NNN/none>` | `<state/number>` | `<eligible/conflict>` |

- Fresh inspection evidence for every open lane: `<worker IDs, timestamps, and coordinates>`
- Identity, ownership, session, or topology conflicts: `<none or exact conflicts>`

## 5. Assignment ledger

| Assignment | Label | Responsibility/worker | Immutable artifact/hash | Goal summary | Dependencies | State | Report hash/status | Next legal action |
|---|---|---|---|---|---|---|---|---|
| `A-NNN` | `<label/none>` | `<key/wN>` | `<a2a/assignments/A-NNN.md; SHA-256>` | `<summary>` | `<readiness>` | `<state>` | `<hash/pending>` | `<action>` |

The optional label is display-only. Use the assignment ID for actions and the full `<track_id>/<run_id>/<assignment_id>` coordinate when another run may hold the same ID.

## 6. Remaining work

| Item | Work and reason | Inputs | Prerequisites | Proposed responsibility/profile | Completion condition | Target decision |
|---|---|---|---|---|---|---|
| `<id>` | `<work>` | `<coordinates>` | `<readiness>` | `<ORCH, host task, or responsibility/profile>` | `<observable result>` | `<accept/defer/reject and ground>` |

## 7. Target startup and acceptance

- Target initialization request/result: `<tool action, coordinates, and result>`
- Target manifest, reset lineage, plan hash, and storage-index verification: `<coordinates and proof>`
- `mandate.json`: `<coordinate and SHA-256>`
- First target inspection: `<tool observation and state>`
- Preserved source-worker inspections and dispositions: `<worker -> evidence and disposition>`
- Accepted assignments and dispatch observations: `<IDs, hashes, and results>`
- Target acceptance and report ownership: `<coordinates and status>`
- Budget state carried across: `<seed/granted cap, park state and reason, extension verdicts, ledger coordinate>`

## Inherited claims

This is the canonical inherited-claims section of `<run>/handoff.md`. On every `herdr_assignment add`, `mcp/tools.ts:3263-3272` invokes the claims gate before budget judgment; those lines state that it acts only when the canonical succession document and canonical claims section exist, refuses malformed presentation and stale measured SHA observations, executes nothing, and persists nothing. Run each command yourself and record the observation.

| claim | coordinate | command | observed | disposition |
|---|---|---|---|---|
| `<claim re-measured at the target HEAD>` | `<repo-relative or run-relative path, optionally :line>` | `<command actually run>` | `<40-hex HEAD sha> <ISO-8601>` | measured |
| `<claim carried without verification>` | `<coordinate if one exists>` | | | unverified |
| `<claim withdrawn at handoff>` | | | | withdrawn |

A measured row requires coordinate, command, and `<40-hex sha> <ISO-8601>` observed at the target HEAD. An unverified row has an empty command; a withdrawn row needs only its claim. A compatibility or version claim needs separate `old->new` and `new->old` rows. If HEAD freshness cannot be observed, the tool reports that skip rather than inventing proof.

## 8. Source closure record

- Fresh ORCH and worker inspections: `<coordinates>`
- Completed assignments: `<IDs and report hashes>`
- Responsibility lanes retained for follow-up: `<IDs and reasons>`
- Settled lanes safely closed: `<IDs and evidence>`
- Active, ambiguous, or unsafe lanes preserved: `<IDs and reasons>`
- Durable promotion: `<completed/pending coordinates>`
- Worktree hygiene: `<state and disposition>`
- Source judgment: `<closed/partially preserved/not closable>`

## Situational appendices

Keep only appendices that apply: reset lineage, blocked or ambiguous operations, user decisions and promotion, and interfaces or quiet windows involving another run or system.
