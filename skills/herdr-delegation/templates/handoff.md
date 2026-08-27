# Track handoff — <source track_id/run_id> to <target track_id/run_id>

Written by the source run's ORCH on <date>. This document is the startup substrate for the target ORCH. Conversation memory is not authority.

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

Tool calls continue to use track/run IDs. Resolved paths are audit observations only.

## 2. Storage, package, and configuration

| Layer | Coordinate | SHA-256/status | Storage effect | Role/profile effect |
|---|---|---|---|---|
| User | `${PI_CODING_AGENT_DIR}/herdr-delegator.json` or `~/.omp/agent/herdr-delegator.json` | `<hash/absent/conflict>` | `<resolved/none>` | `<summary>` |
| Project | `<cwd>/.omp/herdr-delegator.json` | `<hash/absent/conflict>` | `<resolved/none>` | `<summary>` |
| Source run | `<source run>/herdr-delegator.json` | `<hash/absent/conflict>` | `<must not relocate>` | `<summary>` |
| Target run | `<target run>/herdr-delegator.json` | `<hash/absent/conflict>` | `<must not relocate>` | `<summary>` |

- Canonical project `cwd`: `<absolute path>`
- Resolved storage root: `<absolute path observation>`
- Storage index observation: `<version/row; never hand-edit>`
- Plugin version and discovery: `<plugin.json/package version; package-root mcp.json status>`
- OMP bridge status: `<bridge-only extension; session fact path derivation/status>`
- Public MCP surface: `<exactly herdr_track, herdr_assignment, herdr_worker>`
- Reload boundary: `<skill/MCP reloaded; extension verified in a new OMP session or pending>`

Configuration stores OMP role aliases only. Record the configured orchestrator role and each worker profile alias; record concrete provider/model/thinking only as verified launch observations.

## 3. Reset lineage

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

A reset copies planning context, not truth. Revalidate each inherited claim before target use.

## 4. ORCH session identity

### Source

- Configured OMP role alias: `<role>`
- Verified provider/model/thinking: `<facts and timestamp>`
- Official session ID/path: `<verified coordinate>`
- Workspace/anchor/root pane: `<IDs and ownership proof>`
- Latest live state and sequence: `<state; state_change_seq; inspection>`
- Focus observation: `<unchanged/restored/partial/skipped>`
- Resume conflict: `<none or exact conflict>`
- Report: `<coordinate and review status>`

### Target

- Configured OMP role alias: `<role; built-in @default unless overridden>`
- Caller-resolved provider/model/thinking: `<facts and config hashes>`
- Bootstrap bridge/metadata gate: `<session; pane; nonce; timestamp; exact-match proof>`
- Persisted JSONL gate: `<path; session/model/thinking/fallback proof>`
- Official session ID/path: `<verified coordinate>`
- Workspace/anchor/root pane: `<IDs and ownership proof>`
- Orchestrator instruction hash: `<coordinate and SHA-256>`
- Latest live state and sequence: `<state; state_change_seq; inspection>`
- Prompt ambiguity/recovery: `<none or fingerprint and legal next action>`
- Focus observation: `<status>`
- Report: `<coordinate and review status>`

The target role is configuration-selected; it is not fixed to `@plan`. A dead ORCH cannot start or resume itself.

## 5. Responsibility lanes

Record every source and target lane, including closed and preserved lanes.

| Run | Worker | Responsibility | Separation | Profile/role | Verified model/thinking | Active assignment | FIFO queue | Last completed | Official session | Lane state/seq | Workspace/tab/root pane | Resume status | Close status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<source/target>` | `w<N>` | `<key>` | `<primary or kind/reason/conflict>` | `<profile/role>` | `<provider/model/thinking>` | `<A-NNN/none>` | `<IDs>` | `<A-NNN/none>` | `<ID/path>` | `<state/number>` | `<IDs/proof>` | `<eligible/conflict>` | `<open/closed/unsafe>` |

For every open lane, cite a fresh `herdr_worker inspect` observation. Exact responsibility reuse is the default. A busy lane queues FIFO; it does not justify another lane. An additional lane requires a recorded `direction`, `ownership`, or `dependency` separation witness.

Do not use a new worker number to bypass ambiguous identity, ownership, session, or topology.

## 6. Assignment ledger

Record every nonterminal or materially relevant assignment.

| Assignment | Responsibility/worker | Immutable artifact/hash | Goal summary | Dependencies | State | Report hash/status | Next legal action |
|---|---|---|---|---|---|---|---|
| `A-NNN` | `<key/wN>` | `<a2a/assignments/A-NNN.md; SHA-256>` | `<summary>` | `<readiness>` | `<queued/prompting/working/blocked/completed/failed/ambiguous>` | `<hash/pending>` | `<action>` |

The assignment state vocabulary is exactly:

```text
queued | prompting | working | blocked | completed | failed | ambiguous
```

There are no assignment contract or receipt files. Settlement is the exact completion block in `w<N>-report.md` plus the report hash and timestamp stored in `a2a/delegation.json`.

Completion returns the lane to `idle` and keeps its tab/session open. Record closure separately.

## 7. Blocked and ambiguous operations

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
- Prohibited action: `<do not replay/respond/resume/close/create replacement>`
- Legal next action: `<inspect/verify/pinned response/preserve/escalate>`

A timeout is not failure. `herdr_assignment.wait` timeout has no effect; a mutating timeout may have an effect. Do not carry stale blocked sequences forward.

## 8. Remaining work

| Item | Work and reason | Inputs | Prerequisites | Proposed responsibility/routing | Completion condition | Target decision |
|---|---|---|---|---|---|---|
| `<id>` | `<work>` | `<coordinates>` | `<readiness>` | `<ORCH, host task, or responsibility/profile>` | `<observable result>` | `<accept/defer/reject and ground>` |

The target writes a new immutable assignment for accepted worker work. Never replay a source prompt or overwrite a submitted assignment.

## 9. User decisions and promotion

For every user-only decision:

- Decision: `<question>`
- Escalation ground: `<plan coordinate/category>`
- Options/tradeoffs/recommendation: `<bounded set>`
- Safe work completed while waiting: `<coordinates>`

Also record pending irreversible external actions, governance changes, secret/account input by approved reference only, dirty worktree disposition, release promotion, and permanent documentation/rule promotion.

## 10. Interfaces and quiet windows

| Other run/system | Contract | Producer | Consumer | Readiness | Quiet window | Verification | Channel | Successor owner |
|---|---|---|---|---|---|---|---|---|
| `<coordinate>` | `<contract>` | `<owner>` | `<owner>` | `<signal>` | `<boundary>` | `<check>` | `<file/tool>` | `<owner after acceptance>` |

Peers confirm existing facts. ORCH alone changes scope, ownership, priority, approval, or completion conditions.

## 11. Target startup procedure

1. Initialize a different sibling coordinate with `herdr_track {action:"init", reset_of:{...}}`.
2. Verify target manifest, copied protocol, reset lineage, plan hash, and storage-index observation.
3. Revise target `plan.md`; write `orchestrator-instructions.md` using this handoff and cited coordinates.
4. Start with `herdr_track {action:"start_orchestrator"}`. The OMP bridge resolves the configured orchestrator role.
5. Inspect with `herdr_track {action:"inspect"}` before judgment or recovery.
6. Revalidate inherited evidence and record accept/defer/reject for every carried item.
7. Fresh-inspect preserved source workers. Close only safe settled lanes; keep active, ambiguous, or unsafe lanes and their sessions intact.
8. For accepted worker work, create a new canonical `a2a/assignments/A-NNN.md`, hash it, and call `herdr_assignment {action:"add"}`.
9. Use `herdr_assignment wait/respond` for assignment control and `herdr_worker list/inspect/resume/close` for lane lifecycle.
10. Record target acceptance and relay ownership in the target plan/report.

## 12. Source closure record

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

The deterministic source run remains in configured storage as the audit record. Never close a worker merely because an assignment completed, and never manually remove the retained workspace or anchor.
