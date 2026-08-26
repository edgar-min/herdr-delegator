# Track handoff — <source track_id/run_id> to <target track_id/run_id>

Written by the source run's ORCH on <date>. This document is the startup substrate for the target ORCH. It must be sufficient with its cited deterministic coordinates; conversation memory is not authority.

## 1. Review and closure status

- Source track/run IDs: `<track_id>` / `<run_id>`
- Target track/run IDs: `<track_id>` / `<run_id>`
- Source resolved canonical path (audit observation): `<absolute path returned by verified tool details>`
- Target resolved canonical path (audit observation): `<absolute path returned by verified tool details>`
- Source `run.json`: `<coordinate and verified SHA-256>`
- Target `run.json`: `<coordinate and verified SHA-256>`
- Source plan: `<coordinate and SHA-256>`
- Target copied/revised plan: `<coordinate and SHA-256>`
- Review status: `<implementation review; slice verification; integration verification; closure judgment; open findings>`
- Permanent source/deployment state: `<revision, deployment/release state, or not applicable>`
- Final independently verified evidence: `<source evidence/report coordinates>`
- Completed slices and ORCH judgments:
  - `<worker/phase>: <outcome>; <report and [ORCH Response] coordinate>`
- Promoted durable artifacts:
  - `<permanent coordinate>: <what and why>`
- Unpromoted audit-only artifacts:
  - `<run coordinate>: <reason retained only as audit evidence>`

## 2. Storage configuration and deterministic identity

Record source fingerprints from bounded tool details; never include secret values.

| Layer | Config coordinate | Scope | SHA-256 | `storage.root` effect | Model/profile effect | Status |
|---|---|---|---|---|---|---|
| User | `${PI_CODING_AGENT_DIR}/herdr-delegator.json` or `~/.omp/agent/herdr-delegator.json` | user | `<hash/absent>` | `<resolved/none>` | `<summary>` | `<verified/conflict>` |
| Project | `<cwd>/.omp/herdr-delegator.json` | project | `<hash/absent>` | `<resolved/none>` | `<summary>` | `<verified/conflict>` |
| Source run | `<source resolved run>/herdr-delegator.json` | run | `<hash/absent>` | `<must not relocate>` | `<summary>` | `<verified/conflict>` |
| Target run | `<target resolved run>/herdr-delegator.json` | run | `<hash/absent>` | `<must not relocate>` | `<summary>` | `<verified/conflict>` |

- Resolved canonical storage root: `<absolute path observation>`
- Plugin-owned index: `<storage-root>/index.json; version/row observations; never hand-edit>`
- Project canonical `cwd`: `<absolute path>`
- Coordinate validation: `<lowercase bounded IDs verified>`
- Source registry: `<source resolved run>/a2a/herdr-workers.json` (version 3, tool-owned)
- Source registry lock: `<source resolved run>/a2a/.herdr-workers.lock` (tool-owned)
- Target registry/lock: `<coordinates or not yet created>`

Tool calls continue to use track/run IDs. Resolved paths above are audit observations, not replacements for those IDs.
Configuration records OMP role aliases only, never concrete model IDs. For each ORCH or worker launch, preserve launch pinning and both session gates: the caller-resolved exact provider/model plus effective thinking used to launch the child; the child's pre-prompt in-process bootstrap attestation from Herdr pane metadata (official session ID/reported path, provider/model, thinking, nonce, timestamp, target pane/session proof); and post-prompt persisted JSONL verification of session/model/thinking/fallback. A reported path that precedes JSONL creation is not resume-eligible, and attestation/report failure is fail-closed without a synthetic prompt.

## 3. Reset lineage and policy

- Reset initialization result: `<herdr_track.init_run evidence>`
- `reset_of`: `<source track_id/run_id and canonical path observation>`
- Target `run.json.reset_of`: `<coordinate and exact value>`
- Target `reset.json`: `<coordinate; version; SHA-256>`
- Source plan hash recorded by reset: `<SHA-256>`
- Target initial plan copy equality: `<byte/SHA proof>`
- Target plan revisions after initialization: `<coordinates and reasons>`
- Worker policy: `close-settled-preserve-active`
- Evidence policy: `revalidate-before-import`
- Old evidence revalidation status: `<each cited claim: revalidated/withdrawn/pending>`
- Source mutation check: `<what was proved untouched by init_run>`
- Active preserved source workers: `<worker IDs, states, and coordinates; or none>`

The reset never destroys source workers, workspace, reports, registry, or evidence. It copies the source plan, not truth. No source evidence may be cited by the target until revalidated.

## 4. Workspace, anchor, ORCH, and focus

### Source run

- Dedicated workspace: `<workspace id; deterministic label hint; ownership proof>`
- Anchor: `<tab id; pane id; canonical cwd; topology proof>`
- Workspace state: `<ready/missing/conflict/exact state>`
- Source ORCH official OMP session: `<canonical path; session id; role; provider/model; thinking; observed coordinate/time>`
- Native-restore status: `<eligible/succeeded/failed/not attempted; evidence>`
- Resume conflict: `<none/missing/corrupt/known duplicate/credible ambiguity/exact conflict>`
- Focus-restoration observations: `<operation; unchanged/restored/partial/skipped-concurrent-user-focus; evidence>`

### Target run

- Dedicated workspace: `<workspace id; deterministic label hint; ownership proof>`
- Anchor: `<tab id; pane id; canonical cwd; topology proof>`
- Workspace state: `<initialized/not started/ready/conflict/exact state>`
- Target ORCH official OMP session: `<canonical path; session id; @plan; provider/model; thinking; observed coordinate/time>`
- Caller-resolved launch identity: `<configured @plan; exact provider/model; effective thinking; config source hashes>`
- Bootstrap attestation: `<nonce; attested timestamp; official session ID/reported path; provider/model/thinking; target pane/session proof; verified timestamp>`
- Persisted JSONL verification: `<file existence; session/model/thinking/fallback match; verified_at; persisted-verified or exact gap>`
- `orchestrator-instructions.md`: `<coordinate and prompt SHA-256>`
- Prompt state: `<absent/unprompted/prompting/prompted and evidence; if prompting is a recovered permanent never-replay fingerprint, record that verified_at plus persisted fallback/model facts establish settlement without rewriting it>`
- Latest state and `state_change_seq`: `<state; number; inspection time>`
- Native/manual resume eligibility: `<exact registry path, JSONL existence and persisted identity, duplicate/ownership checks, or ineligible reason>`
- Focus-restoration observations: `<operation; status; evidence>`
- `orchestrator-report.md`: `<coordinate; present/absent; review status>`

`focus_restoration: partial` is a warning, not proof of operation failure. Never override unrelated current user focus. A dead ORCH cannot start or resume itself; recovery requires native restoration or a live predecessor/control surface.

## 5. Worker registry snapshot

Record every source and target registry worker, including closed workers and selected profiles/models.

| Run | Worker | Registry identity/key | Profile | Requested role | Verified provider/model | Thinking/fallback observation | Workspace/tab/root pane | Verified Sidebar panes | Official OMP session | Latest state | `state_change_seq` | Prompt fingerprint/state | Report | Resume eligibility/conflict | Focus warning | Ownership/topology proof | Close status |
|---|---|---|---|---|---|---|---|---|---|---|---:|---|---|---|---|---|---|
| `<source/target>` | `w<N>` | `<identity>` | `<explicit profile>` | `<role>` | `<provider/model>` | `<thinking; fallback>` | `<ids>` | `<ids/proof or none>` | `<path; session id>` | `<state>` | `<number>` | `<hash/status>` | `<coordinate/status>` | `<eligible/conflict>` | `<status/evidence>` | `<proof/conflict>` | `<closed/preserved/not safe>` |

For every worker not proved closed, include latest `inspect_worker` evidence and exact unsafe-close reason. Reconcile only the same track/run/worker identity. Never create a replacement number to bypass unknown ownership, identity conflict, or duplicate ambiguity.
For every worker, also record the configured role alias, caller-resolved exact launch provider/model and effective thinking, pre-prompt bootstrap nonce/timestamp/session/path/pane proof, and post-prompt persisted JSONL session/model/thinking/fallback verification. A bootstrap-reported path without an existing verified JSONL is never resume-eligible.

Safe close requires every pane to be the exact registry root pane or a verified Herdr Sidebar pane. For each Sidebar, preserve proof of same workspace/tab/canonical run `cwd`, exact `Sidebar` label, no non-null `agent`/`agent_session`, and non-empty `tokens` whose keys all start `herdr-sidebar-`.

## 6. Blocked states and ambiguous effects

Create one subsection per unresolved control-state item.

### `<run/worker or target ORCH>: <blocked or ambiguous operation>`

- Latest inspection time/evidence: `<coordinate>`
- Live identity, state, and exact `state_change_seq`: `<values>`
- Official session/model verification: `<path/id/profile or @plan/concrete model/thinking/time>`
- Pending request/report coordinate: `<coordinate>`
- Grounds checked: `<plan/instruction/project source/code coordinates>`
- User-confirmed boundary: `<yes/no; plan coordinate/category>`
- Last operation and recovery guidance: `<operation; exact summary>`
- Ambiguous effect: `<what may have happened; proved effect/absence; remaining unknown>`
- Prompt fingerprint/state: `<hash/status>`
- Focus warning: `<status/evidence>`
- Prohibited next action: `<do not resend/respond/close/create replacement/resume, as applicable>`
- Legal next action: `<fresh inspect; verify; resolve pinned sequence; ask user; preserve>`

A timeout never proves failure. Do not carry a stale blocked sequence forward.
For a blocked input, record whether inspection proves free-form text input or an interactive option dialog. Use `resolve_block` text only for free-form input; use bounded allowlisted keys for a dialog, such as `enter` for a preauthorized recommended selection. An unchanged state and sequence after a response is a no-effect observation, not permission to replay blindly.

After `close_worker`, `inspect_worker` may return `agent_not_found`. Record the registry's authoritative `closed` state and verify that the retained run anchor remains; do not treat the missing closed agent as registry loss.

## 7. Remaining work and acceptance decisions

Each item includes complete substrate, prerequisites, ownership, and observable completion.

| Item | Remaining work/reason | Inputs | Prerequisites | Proposed owner/routing | Completion condition | Target ORCH decision |
|---|---|---|---|---|---|---|
| `<id>` | `<work/reason>` | `<coordinates>` | `<dependencies>` | `<ORCH, host task, or Herdr worker/profile>` | `<observable condition>` | `<accept/defer/reject plus ground>` |

All target worker instructions must be newly written under the target plan and copied protocol. Source instructions and addenda may be cited as evidence but never replayed.

## 8. Pending user decisions and promotion

For each open user-only decision:

- Decision: `<question only the user can settle>`
- Escalation category and plan coordinate: `<ground>`
- Options/tradeoffs/recommendation: `<concise set>`
- Safe work completed while waiting: `<coordinates>`

Also list:

- irreversible/destructive actions outside registry-owned workers;
- shared governance changes;
- secrets/auth/account input (names or approved references only, never values);
- dirty or unmerged worktree disposition;
- formal issue publication/closure;
- permanent project-rule/document promotion;
- deployment/release promotion.

Pending durable promotion is the target ORCH's first accepted work item. The source ORCH does not silently perform it after handoff.

## 9. Inherited constraints and procedure evidence

- Prohibitions still active: `<list and plan coordinates>`
- Shared-`cwd` serialization boundary: `<slices that may not overlap>`
- Quiet windows: `<owner, path/system, start/end signal>`
- Proven commands/procedures: `<coordinate, expected result, recovery>`
- Fail-closed friction: `<exact observation and legal next action>`
- Secret handling: `<approved names/references only>`
- Worktrees retained: `<path, branch, dirty/ahead state, required disposition>`
- Host task/subagent results adopted by ORCH: `<result, ORCH verification, no plugin model claim>`

## 10. Interfaces with other tracks

| Other track/run | Contract | Producer | Consumer | Readiness signal | Quiet window | Verification agreement | File/relay channel | Successor owner |
|---|---|---|---|---|---|---|---|---|
| `<track/run>` | `<existing contract>` | `<owner>` | `<owner>` | `<report/state>` | `<boundary>` | `<check>` | `<coordinate>` | `<target ORCH after acceptance>` |

Peers confirm existing facts; only ORCH changes contracts. The target ORCH assumes relay after accepting the handoff.

## 11. Target startup and recovery procedure

1. From the live source ORCH or another valid `@plan` control surface, configure/verify the same absolute storage root and call `herdr_track.init_run` for the sibling target with source `reset_of` coordinates.
2. Verify target `run.json`, copied `protocol.md`, `a2a/`, `reset.json`, copied plan hash, and plugin-owned index observation. Do not hand-edit tool-owned files.
3. Revise the copied target `plan.md` as needed; write target `orchestrator-instructions.md` with this handoff and cited coordinates as its startup substrate.
4. Call `herdr_track.start_orch` with target track/run IDs. The caller resolves configured `@plan`; the child launches with the captured exact provider/model and effective thinking. Never supply or infer a concrete model ID through configuration or a session path through model input.
5. Call `herdr_track.inspect_orch`. Do not judge, retry, or recover until target pane/session identity, pre-prompt bootstrap attestation, official session, persisted JSONL model/thinking/fallback verification after the prompt boundary, live state/sequence, prompt fingerprint/state, focus observation, and report presence are proved.
6. If start/prompt effect is ambiguous, inspect first. A retained `prompt_state: prompting` may be the permanent never-replay fingerprint; `verified_at` plus persisted fallback/model facts can prove settled recovery without rewriting it to `prompted`. Continue from proved effect, retry only from proved absence when guidance permits, otherwise preserve coordinates.
7. The target ORCH reads target `plan.md`, this handoff, target registry, and cited sources. It records explicit accept/defer/reject decisions for every item in sections 6–10.
8. Freshly inspect preserved source workers by their source track/run IDs. Close only safe settled workers; preserve active, blocked, unknown, conflicted, or unsafe-topology workers and source workspace.
9. Rewrite accepted worker instructions and compare them with target `protocol.md`. Select `default`, `slow`, or another configured profile explicitly.
10. For each new worker, use `ensure_worker` → required post-reconciliation inspection → `prompt_wait` → `inspect_worker`. Never replay source instructions or prompts.
11. Revalidate every inherited evidence claim before citation. Record target acceptance and relay ownership in the target plan/report.

## 12. Source closure record

- Fresh inspections completed: `<ORCH and every registry worker; coordinates>`
- Settled workers safely closed: `<IDs and close evidence>`
- Active/unsafe workers preserved: `<IDs, exact reason, recovery coordinate>`
- Ambiguous effects unresolved: `<items or none>`
- Durable promotion completed/pending: `<coordinates>`
- Worktree hygiene: `<state and disposition>`
- Non-audit scratch deletion: `<coordinates or none>`
- Source closure judgment: `<closed/partially preserved/not closable; evidence>`
- Plugin storage-index observation: `<row/state as observed; never hand-edited>`

The deterministic source run remains in configured storage as an audit record. Do not manually move it into a temporary archive or remove its workspace/anchor; no public workspace-close operation exists.
