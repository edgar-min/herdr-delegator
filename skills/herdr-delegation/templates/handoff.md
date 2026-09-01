# Track handoff — <source track_id/run_id> to <target track_id/run_id>

Written by the source run's ORCH on <date>. This document transfers state to the target ORCH; conversation memory is not authority. ORCH rules are in `protocol-orch.md`.

# Required core

## 1. Outcome and review

- Source run: `<track_id>` / `<run_id>`
- Target sibling run: `<track_id>` / `<run_id>`
- Source canonical path observation: `<path returned by verified tool output>`
- Target canonical path observation: `<path returned by verified tool output>`
- Source and target `run.json`: `<coordinates and SHA-256>`
- Source and target plan: `<coordinates and SHA-256>`
- Implementation review: `<status and findings>`
- Slice verification: `<status and evidence coordinates>`
- Integration verification: `<status and evidence coordinates>`
- Closure judgment: `<status and open conditions>`
- Permanent release/deployment state: `<state or not applicable>`
- Promoted durable artifacts: `<coordinates and reason>`
- Audit-only artifacts: `<coordinates and reason retained>`

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
- Environment observation: `<plugin/package version and discovery; bridge status; public MCP surface; reload/new-session boundary status>`

## 3. ORCH identity

### Source ORCH — source-completed

- Configured OMP role alias: `<role>`
- Verified provider/model/thinking: `<facts and timestamp>`
- Official session ID/path: `<verified coordinate>`
- Workspace/anchor/root pane: `<IDs and ownership proof>`
- Latest live state and sequence: `<state; state_change_seq; inspection>`
- Focus observation: `<unchanged/restored/partial/skipped>`
- Resume conflict: `<none or exact conflict>`
- Report: `<coordinate and review status>`

### Target ORCH expectations — source-completed before startup

- Configured OMP role alias: `<role; built-in @default unless overridden>`
- Orchestrator instruction coordinate and SHA-256: `<coordinate and SHA-256>`

### Target ORCH identity verification — target-completed after startup

- Configured role alias and thinking opinion: `<alias; explicit level or inherit; config hashes>` — the caller resolves no model on the child's behalf
- Bootstrap bridge/metadata gate: `<session; pane; nonce; timestamp; exact-match proof>`
- Persisted JSONL gate: `<path; session identity proof; observed provider/model/fallback, and thinking only when the session recorded one>`
- Official session ID/path: `<verified coordinate>`
- Workspace/anchor/root pane: `<IDs and ownership proof>`
- Latest live state and sequence: `<state; state_change_seq; inspection>`
- Prompt ambiguity/recovery: `<none or fingerprint and legal next action>`
- Focus observation: `<status>`
- Report: `<coordinate and review status>`

## 4. Responsibility lanes

State only; routing, separation, reuse, inspection, and lifecycle rules are in `protocol-orch.md`.

| Run | Worker | Responsibility | Separation | Profile/role | Verified model/thinking | Active assignment | FIFO queue | Last completed | Official session | Lane state/seq | Workspace/tab/root pane | Resume status | Close status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<source/target>` | `w<N>` | `<key>` | `<primary or kind/reason/conflict>` | `<profile/role>` | `<provider/model/thinking>` | `<A-NNN/none>` | `<IDs>` | `<A-NNN/none>` | `<ID/path>` | `<state/number>` | `<IDs/proof>` | `<eligible/conflict>` | `<open/closed/unsafe>` |

- Fresh inspection evidence for every open lane: `<worker IDs, timestamps, and coordinates>`
- Identity, ownership, session, or topology conflicts: `<none or exact conflicts>`

## 5. Assignment ledger

State only; assignment vocabulary, authoring, dispatch, settlement, and control rules are in `protocol-orch.md`.

| Assignment | Label | Responsibility/worker | Immutable artifact/hash | Goal summary | Dependencies | State | Report hash/status | Next legal action |
|---|---|---|---|---|---|---|---|---|
| `A-NNN` | `<label/none>` | `<key/wN>` | `<a2a/assignments/A-NNN.md; SHA-256>` | `<summary>` | `<readiness>` | `<state>` | `<hash/pending>` | `<action>` |

Label is the artifact's optional display-only frontmatter field, quoted here so a reader can tell apart two assignments whose IDs look alike. It is not identity and is not unique: cite the assignment ID — `A-` plus three or more digits — for every action, and its `<track_id>/<run_id>/<assignment_id>` coordinate when another track holds the same ID.

## 6. Remaining work

| Item | Work and reason | Inputs | Prerequisites | Proposed responsibility/routing | Completion condition | Target decision |
|---|---|---|---|---|---|---|
| `<id>` | `<work>` | `<coordinates>` | `<readiness>` | `<ORCH, host task, or responsibility/profile>` | `<observable result>` | `<accept/defer/reject and ground>` |

## 7. Target startup state

Startup, inspection, revalidation, assignment, and source-lane lifecycle rules are in `protocol-orch.md`. Record effects and evidence here rather than restating the procedure.

- Target initialization request/result: `<coordinates; init/reset request; result>`
- Target manifest, protocol set, reset lineage, plan hash, and storage-index verification: `<coordinates and proof>`
- Target plan revisions: `<coordinates and reasons>`
- `orchestrator-instructions.md`: `<coordinate and SHA-256>`
- `herdr_track start_orchestrator` observation: `<result/effect/ambiguity>`
- First target `herdr_track inspect`: `<coordinate and state>`
- Inherited evidence dispositions: `<claim -> accept/defer/reject and ground>`
- Preserved source-worker inspections and dispositions: `<worker -> evidence and disposition>`
- Accepted work assignment artifacts and dispatch observations: `<IDs/hashes/results>`
- Assignment-control and lane-lifecycle observations: `<wait/list/inspect/resume/close effects; [ORCH Response] appends and wakes>`
- Target acceptance, report, and relay ownership: `<coordinates and status>`
- Budget state carried across: `<seed/granted cap, park state and reason, extension verdicts, ledger coordinate>`
- Birth chain and revival history: `<generations with origin; any rebirth approval hash>`

## 8. Source closure record

- Fresh ORCH and worker inspections: `<coordinates>`
- Completed assignments: `<IDs and report hashes>`
- Responsibility lanes retained for follow-up: `<IDs/reasons>`
- Settled lanes safely closed: `<IDs/evidence>`
- Active/ambiguous/unsafe lanes preserved: `<IDs/reasons/recovery coordinates>`
- Unresolved ambiguous effects: `<items or none>`
- Durable promotion: `<completed/pending coordinates>`
- Worktree hygiene: `<state and disposition>`
- Scratch deletion: `<non-audit coordinates or none>`
- Source judgment: `<closed/partially preserved/not closable>`
- Retained deterministic audit record: `<coordinate and status>`

# Situational appendices

Use only the appendices that apply. Remove unused appendices from the completed handoff.

## Appendix A. Reset lineage — when the target is a reset sibling

- Reset initialization evidence: `<herdr_track init result>`
- `reset_of`: `<source coordinates>`
- Target `reset.json`: `<coordinate and SHA-256>`
- Source plan hash recorded by reset: `<SHA-256>`
- Initial plan-copy equality: `<byte/hash proof>`
- Target plan revisions: `<coordinates and reasons>`
- Worker policy: `close-settled-preserve-active`
- Evidence policy: `revalidate-before-import`
- Source mutation check: `<proof initialization did not mutate source>`
- Preserved source lanes: `<worker IDs/states or none>`
- Inherited claim revalidation: `<claim -> evidence and disposition>`

## Appendix B. Blocked or ambiguous operations — when unresolved operations exist

Create one subsection per unresolved item.

### `<run / assignment / worker>: <operation>`

- Latest inspection: `<timestamp and evidence>`
- Responsibility, assignment, worker: `<coordinates>`
- Live state and exact `state_change_seq`: `<values>`
- Official session/model verification: `<facts>`
- Request/report coordinate: `<coordinate>`
- Grounds checked: `<assignment/plan/project/code coordinates>`
- User boundary: `<yes/no and plan ground>`
- Last operation: `<action and effect observation>`
- Possible effect: `<what may already have happened>`
- Prohibited next action: `<operation that must not be replayed or bypassed>`
- Legal next action: `<inspect/verify/pinned response/preserve/escalate>`
- Timeout classification: `<no-effect wait or potentially effected mutation>`

## Appendix C. User decisions and promotion — when user-only judgment or promotion remains

For every user-only decision:

- Decision: `<question>`
- Escalation ground: `<plan coordinate/category>`
- Options/tradeoffs/recommendation: `<bounded set>`
- Safe work completed while waiting: `<coordinates>`

- Pending irreversible external actions: `<items or none>`
- Governance changes: `<items or none>`
- Secret/account input by approved reference: `<references or none>`
- Dirty worktree disposition: `<state and decision>`
- Release promotion: `<state and decision>`
- Permanent documentation/rule promotion: `<state and decision>`

## Appendix D. Interfaces and quiet windows — when another run or system participates

| Other run/system | Contract | Producer | Consumer | Readiness | Quiet window | Verification | Channel | Successor owner |
|---|---|---|---|---|---|---|---|---|
| `<coordinate>` | `<contract>` | `<owner>` | `<owner>` | `<signal>` | `<boundary>` | `<check>` | `<file/tool>` | `<owner after acceptance>` |

- Peer fact confirmations: `<coordinates>`
- ORCH-owned scope, ownership, priority, approval, or completion changes: `<coordinates or none>`
