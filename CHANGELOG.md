# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 2.0.0 predate this file; their history lives in the Git log and tags.

Vocabulary used below — a **track** is one delegation subject, a **run** is one attempt
at it, a **responsibility lane** (`w<N>`) is a persistent worker session, and **ORCH** is
the single orchestrator session that commands a run. Herdr **spaces**, **tabs**, and
**panes** are the live supervision surface. See the
[README](README.md) and [specification](docs/SPEC.md) for the full model.

## [3.8.0] - 2026-09-02

### Changed

- The ORCH protocol's supervision section is now "Supervise by judgment, delegate
  evidence": the orchestrator keeps thought, direction, and authority — run
  decomposition, design judgment, every assignment's text, `plan.md`,
  `[ORCH Response]` blocks, acceptance and rejection, guarded MCP operations, the
  user conversation, budget justification — and delegates evidence production:
  harness execution and pass/fail tables to a host subagent, compression of a long
  lane report into a per-completion-condition table to a read-only scout,
  coordinate re-measurement likewise. Two rules replace the old "spend the
  interval on your own work": the ORCH never reads a lane report in full, and
  independent reproduction means independence of input — worker outputs taken by
  hash into a separate temporary root and exercised there by a delegate — never
  that the ORCH runs the check itself. The settlement paragraph says the same.
  Runs materialized on the previous text keep loading under the historical-digest
  warning; the new digests are appended to the allowlist, nothing removed. (SPEC
  STO-006, RUN-012; friction `1aa1a55b985bb28c`, `666384aa0ebfd67d`)

### Added

- `orchestrator.directive`: one bounded single-line prose field on the
  orchestrator profile, validated exactly like a worker directive and overriding
  by layer like `role` and `thinking`. It renders as the first section of a run's
  `guidance.md` (`## Orchestrator directive`) at open and revive, and is omitted
  when unset. `guidance` and `intent` remain worker-profile fields and are
  rejected on the orchestrator. (SPEC CFG-005b, GDE-002)
- `herdr-config` gains three scripts under `skills/herdr-config/scripts/`:
  `drift.ts <run>` reports each of a run's three protocol documents as current,
  historical, or unknown against the installed templates; `routes.ts <cwd>
  [run]` lists the orchestrator directive, every worker profile's intent and
  directive, every skill route (both rule shapes), and every skill's intent and
  trigger with the config layer each came from; `directive.ts <cwd> --set
  "<text>" [--layer] [--apply]` validates through the real parser, previews the
  rendered `guidance.md`, and writes only with `--apply`. The scripts are
  typechecked by `bun run check`. The skill description now also answers "check
  orchestrator directives" and "why does the ORCH behave this way".

### Fixed

- `config.schema.json` matches the parser again: worker and orchestrator profiles
  are separate definitions with exactly the keys each parser accepts, both
  `skill_routing.rules` shapes and `skill_routing.skills` metadata are expressed,
  and prose fields reject whitespace-only strings as the parser does. (friction
  `8321e109eeb07083`)
- `herdr-config` documentation no longer says lane guidance delivery is pending;
  it has been live since dispatch-time materialization landed. The route authoring
  guidance names both the current `{agent, moment, skills}` shape and the legacy
  `{boundary, surface, …}` shape.
- The `ModelProfile.directive` documentation comment no longer claims the field
  renders only to a worker lane.

## [3.7.0] - 2026-09-02

### Fixed

- A queue head that was promoted but never dispatched can be settled again. A
  settlement promotes the next head into the lane record while the assignment
  itself stays `queued` with no dispatch timestamp; if the worker then starts
  that work on its own the lane is live, the dispatch gate stays shut for good,
  and the settlement sweep skipped the record as inactive — so a head that had
  already written its completion block could never settle and track close
  refused the run. The sweep's eligibility now also admits the `queued` record
  a lane currently holds active. This corrects the predicate's scope, not the
  state vocabulary: the shared active-state set is unchanged, and settlement
  still requires an idle-or-failed lane plus that assignment's own completion
  block, so nothing settles without evidence. Such a settlement claims no
  elapsed time and says so — `settled without a recorded dispatch`. (SPEC
  ASN-013a; friction `9a62576dbbaeaf70`)

### Added

- `herdr_assignment add` accepts an optional `urgent: true`, which inserts the
  assignment at the head of its lane's queue instead of appending it. That is
  its whole effect: an idle lane dispatches immediately either way, nothing
  already running is interrupted or recalled, a parked run still refuses to
  promote a head, and it is orthogonal to the `emergency` claim, which buys
  registration past a budget park rather than queue order. The choice is
  call-time only — never written to the artifact, the identifier, the label, or
  any registry record — so every successful `add` now echoes
  `data.queue_position` (the 0-based queue index, `"active"`, or `"none"` for a
  duplicate add naming an already-terminal record) merged into the same `data`
  object as that call's gate observations. No registry schema change. (SPEC
  RSP-003, ASN-015; friction `8917760a9545c642` item ②)
- The `wake_worker` doorbell names the lane's queue head. Its server-composed
  subject now appends `; queue head <id>` whenever the queue is not empty, so a
  worker whose queue was just reordered can observe that from a bell about the
  assignment it is already running; the `queued` / `orch-response` /
  `completion` reason tokens keep their exact prior meaning. The action also
  accepts an optional `assignment_id` that selects which assignment the bell is
  about. It must be one the lane holds active or queued — a terminal
  assignment, another lane's, or an unregistered identifier is reported as
  `target_unresolved` with one journal row and no bell rather than quietly
  answering a different question — and `boundary` stays refused outside
  `wake_orch`, which the published field description now states. (SPEC
  MSG-001; friction `2ca2674d47036a3e`)

### Notice

- A mounted server older than this release drops the unknown `urgent` key
  silently and appends. After updating, run `/reload-plugins` in the active
  pane and let the **next** turn republish attestation before relying on the
  field; if the first `add` afterwards returns no `data.queue_position`, the
  placement did not happen and further urgent adds should stop until the mount
  is current.
- This release closes the machine half of re-direction: queue order and the
  composed signal. The half a worker feels — the bell actually waking its pane
  — still depends on the delivery-layer repair tracked as friction
  `024a02386ec9dd9d`, so friction `8917760a9545c642` item ② stays in progress.

## [3.6.0] - 2026-09-01

### Added

- Emergency registrations can now cross a cadence budget park. `herdr_assignment
  add` accepts an optional `emergency` claim (`failure`, `why_now` — bounded
  single lines); on an `over-cap` park it admits the registration, records the
  claim in the ledger, and opens a post-hoc audit debt as a run document
  (`emergency-audit-<n>.md`) that a clean auditor judges at the next
  `budget_extend`. One unjudged registration at a time; every other park reason
  still refuses (`emergency_not_admissible`). An `unjustified` verdict closes
  the carve-out for the run permanently (`emergency_carve_out_closed`) and
  routes the next budget decision to the human. The sanction is prospective
  only — nothing recalls a dispatched assignment, closes a working lane, or
  un-spends tokens — and an admitted registration queued behind an active lane
  is not promoted while parked (preemption is out of scope for this release).
  No registry schema change: old servers read the new state untouched and keep
  refusing parked adds. (SPEC BUD-016; friction 8917760a9545c642 items ① and ③)
- Audit verdicts now arrive by doorbell instead of polling. A budget or
  emergency auditor may ring the ORCH pane once through the new
  `herdr_message` action `wake_orch_audit` after appending its verdict; the
  bell carries no content and no authority — the audit document alone holds
  the verdict, and the ORCH still lands it with the ordinary `budget_extend`
  call. (SPEC BUD-009)
- `skill-retro`, a bundled skill: a run-close worker retrospective where the
  ORCH judges each lane (and itself) against expectation, questions
  underperforming workers through their lane report plus a `wake_worker`
  doorbell, and the questioned workers file their own failure evidence in a
  fixed `skill-review` grammar — success stays silent.

### Fixed

- Doorbell sender attribution: a bell rung by a non-lane session (an auditor)
  is now recorded as `auditor` in `messages.jsonl` instead of being
  mislabelled `orch`.

## [3.5.5] - 2026-09-01

### Added

- Inherited succession claims are now gated at implementation dispatch. A run
  whose canonical `handoff.md` carries an `Inherited claims` section must
  present each claim in a five-column table (`claim | coordinate | command |
  observed | disposition`); the first `herdr_assignment add` refuses malformed
  presentation, a closed disposition vocabulary violation, a `measured` claim
  observed at a commit other than the current HEAD, or an incomplete
  compatibility-direction pair. The gate executes no commands, persists
  nothing, and changes nothing for runs without the document — it buys forced
  disclosure of load-bearing unverified claims, not truth checking.
  (a421acd8c19127be)
- Budget seeds now carry their judgment criteria: the `mandate.budget` schema
  explains that the two axes are independent ceilings whose narrower side
  parks the run, and a successful `close` appends one `metered:` line to the
  budget ledger so finished runs leave the same cost record as parked ones
  (BUD-015). Measured calibration data lives in `docs/ARCHITECTURE.md`.


## [3.5.4] - 2026-09-01

### Added

- The published `assignment_id` schema now IS the enforced grammar
  (`A-` plus three or more digits, not all zero), with the full judgment
  criteria in its `describe`, so the advertised contract can no longer accept
  an ID the handler refuses. Schema rejections that reach a tool handler
  return a stable-coded structured result with authored recovery instead of a
  raw validator dump; grammar violations are refused at the published boundary
  itself, carrying the same authored sentence as plain text.
  (87ef22382241e18f)
- Assignment artifacts may carry one optional display-only `label` frontmatter
  field: 1–48 characters, shown on the dispatch pointer, `preflight` result,
  and worker pane title. A label is never persisted, queued on, or read by
  settlement, priority, or completion. The artifact grammar is unversioned, so
  servers older than this release reject label-bearing artifacts — reload
  mounted servers before first using `label` on a shared working tree
  (ASN-003b; 9facc09bdd08e951).


## [3.5.3] - 2026-09-01

### Added

- Assignment preflight now reports bounded path overlap with active assignments
  from other live runs sharing the repository. Ownership declarations use a
  strict path/backtick grammar; declarations that cannot be classified surface
  as response-scoped warnings instead of disappearing silently. The advisory
  does not refuse work, persist warnings, or serialize sub-file hunks.
  (588687ae4317fd72)


## [3.5.2] - 2026-09-01

### Added

- Runs now discover durable inter-run channel documents that were addressed to
  them before their ORCH existed. The bounded, content-free observation appears
  in `herdr_track inspect` and, for at most eight documents, the newborn ORCH's
  first prompt. Failed `notify_run` calls now preserve the original delivery
  result while naming the durable document and explicitly declining a redelivery
  guarantee. No queue, persistent state, registry field, or delivery value was
  added. (ef27dbff9f8d30ac)

### Changed

- Architecture documentation now distinguishes the root `plugin.json` manifest
  from the reverse-domain OMP extension directory and its matching
  `plugin.json` extension key.
- Worker and handoff documentation now describe the live identity verification
  gates rather than stale provider/model/thinking checks, and friction evidence
  guidance asks for the full error message needed to identify its boundary.

### Removed

- Removed the uncalled `promptWait` path, its obsolete `prompt_wait` operation,
  and the instruction-path field and imports that only supported it. The live
  prompt-and-verify path remains unchanged. (7c8ee1442073b02c)

## [3.5.1] - 2026-09-01

A worker spawned under the default `inherit` thinking profile could not be
verified at all, and the dispatch that failed on it reported having done
nothing. Both were found by dogfooding one run — resume-verify-false-block/2026-09-01
— whose own first assignment was delivered through the very defect it then fixed.

### Fixed

- Session verification no longer requires a `thinking_level_change` record
  before the first user message. OMP defers that record whenever the session's
  thinking selector is `auto` — the normal shape of a lane spawned under the
  default `inherit` profile — so the predicate was unsatisfiable and every such
  worker failed `session_verification_incomplete` permanently. `thinking` is now
  an optional observation, and its absence is reported as absence rather than
  filled with a default. (4c4c29eba567dfac)
- `herdr_assignment add` no longer reports a delivered prompt as
  `effect: "none"`. Only the prompt call itself was guarded, so a failure in the
  post-prompt verification surfaced a fully dispatched assignment as a no-effect
  error while the registry kept `prompting` with `prompted_at` set — inviting a
  duplicate re-add. That boundary now marks the assignment `ambiguous` with
  `ambiguous_operation: "prompt"` and reports `effect: "ambiguous"`, the shape
  the resume path already had. (66d45887c8bfec74)

### Changed

- SPEC MOD-002, its release checklist item, the README safety gates, and the
  architecture's verification steps described the post-prompt JSONL gate as an
  exact match on provider/model and thinking. It never matched provider/model,
  and it must not require thinking; all four now state the semantics the source
  implements — session identity is verified, while provider/model, fallback, and
  thinking are returned as observations.

## [3.5.0] - 2026-09-01

Settlement now reaches the registry at the machine's own observation points, so
the ORCH no longer has to poll `wait` to make the recorded state true. The whole
release was cut in one run — orch-context-friction/2026-09-01 — which triaged the
eleven frictions accumulated on 2026-08-31 and fixed the seven that reduce ORCH
round trips and restore trust in machine state.

### Added

- `herdr_assignment preflight` returns the lane coordinate `add` will bind —
  `worker_id`, `report_path`, `lane_reuse` — computed by the same selection rule
  (`predictLane`/`nextWorkerId`), so an assignment can state exact write
  ownership before dispatch. (20b26d0a60e14ab6)
- Shared `wait` input accepts an optional server-issued `cursor` echoed back as
  `data.wait_cursor` (`v1.r<revision>.s<seq>.b<bytes>.t<ms>`); resending the
  returned cursor makes each repeated wait a distinct call, so the host's
  loop-detector no longer forces argument jitter, and a timed-out wait's
  `next_step` recommends doorbell reliance. (3b7947a6750ee7db)
- `herdr_worker inspect` accepts `compact: true` to omit invariant lane metadata
  and return only what changes. Bell texts carry a 1-based line anchor for the
  newest entry of the append-only document they point at. (588687ae4317fd72)
- A verdictless budget audit ends visibly instead of pending forever: one
  auditor re-prompt, then after 4 landing attempts the extension settles as
  `abandoned` (registry schema v4, additive) with an `audit-unavailable` park,
  ledger entry, and doorbell; a fresh justification is accepted afterwards.
  (183b6d4102ddfbfa)
- Protocol templates teach wait discipline (size waits as short probes, hand the
  cursor back), incoming-ring interpretation (a ring may announce a queued
  assignment — read the bell's assignment and reason before judging it a
  repeat), and an experimental abdication paragraph: a self-judged
  context-polluted ORCH settles what it can, prepares handoff documents, and
  asks the user for written rebirth approval. (a421acd8c19127be lineage)

### Fixed

- Tool-recognized settlement lands in `delegation.json` without the ORCH asking:
  the report-based settle sweep now also runs at the observation and consumption
  points — `herdr_worker inspect`, budget machine-facts assembly, and `add`'s
  FIFO decision — with the settle predicate unchanged, FIFO promotion following,
  and a named `completion_block_unparsable` warning replacing the silent no-op
  when a completion block carries the wrong number of status lines.
  (bbc360a158e3a3bf)
- A bell points only at what the server can verify: `wake_peer` composes the
  channel path from the two lanes' responsibility keys, falls back to the
  `w<N>-to-w<M>` form, and omits the path with a named warning when neither
  file exists, instead of naming a nonexistent document. (ad32fc202a939bf7)
- `wake_worker` bells carry the target `assignment <ID>` and a reason token
  (`queued` | `orch-response` | `completion`) derived from the settled registry,
  so an idle worker can tell a queue-promotion ring from a completion echo.
  (a776403dd44aa2af)

## [3.4.0] - 2026-08-31

An approved budget extension now reaches the file the human actually reads, and a
ceiling the human typed is permanent. Both halves were forged in one live run —
budget-clamp-max-tokens/run-20260831 — which reproduced the symptom on itself:
two audits granted +175,000 and +260,000 tokens while its own
`budget-clamp.json` still carried no `max_tokens` at all.

### Added

- Under the default `notify` policy, a grant of more than zero tokens writes the
  new granted figure into `budget-clamp.json` as `max_tokens`, so an approved
  ceiling is visible in the human-owned file instead of living only in the
  registry. The registry records the value the server intended to write and then
  the value it confirmed as written (`budget.server_clamp_tokens`, additive and
  optional), which is also how it later notices a write that crashed and
  completes it at the next guarded op. Normative clauses: SPEC BUD-010, BUD-012,
  BUD-013.
- A `max_tokens` the human typed is a permanent pin on the token ceiling. The
  machine recognizes it by value — never by a fingerprint of the file, so editing
  `max_minutes` or `note` says nothing about the token ceiling — and under a pin
  it stops raising `max_tokens`, parks an over-cap token axis as
  `approval-required` naming the pinned file and the human decision, refuses
  `budget_extend` with `budget_clamp_pinned` unless the run is over on wall clock
  with no `max_minutes` set, and tells the auditor in its own input document that
  the token ceiling cannot move. `0` remains the kill switch. Raising
  `max_tokens` above the judged spend resumes the run directly; deleting it hands
  the ceiling back and the next approved grant resumes automatic raises. A value
  equal to a ceiling the machine recorded reads as machine-written; both clamp
  notes disclose that exception. Normative clauses: SPEC BUD-012, BUD-012a.

### Changed

- Budget recovery prose and the SPEC's budget requirements no longer promise that
  any edit to the clamp releases the next attempt: raising the ceiling above the
  judged spend resumes directly, an edit at or below it pins and routes to the
  human, and deleting `max_tokens` hands it back. A `denied` park under a pin
  keeps its `denied` reason while `budget_extend` returns the pinned refusal —
  both route to the same human.

## [3.3.0] - 2026-08-31

Draft plans now default to adversarial review, and a subagent can no longer
starve its pane's attestation heartbeat. Both changes were forged in one live
run — orch-plan-adversarial-review/minimal-policy-path — whose own plan went
through nine review rounds of the very policy this release ships.

### Added

- `protocol-orch.md` gained a default pre-freeze step: after drafting `plan.md`
  with the user, ORCH dispatches a slow-profile lane charged as the draft's
  adversary and folds its evidence-cited findings into the plan until a round
  yields no blocking findings or acceptance is recorded with grounds; the plan
  records the review lane and every disposition. User-authority items keep
  their judgment-ladder route, and a trivially fixed plan may skip the review
  by recording that judgment. Normative clause: SPEC RTE-009. The adversarial
  charge is repository-owned; the review's reasoning depth follows the
  installation's role mapping for `slow`. (c9227d8)

### Fixed

- The OMP bridge no longer loses a pane's attestation heartbeat when an
  in-process subagent session starts. OMP re-invokes the extension entry per
  session, so a subagent's `session_start` reached `claimBridgeOwnership` over
  the shared module with a fresh owner symbol and wiped the pane attribution;
  entry events are now pin-gated, and `session_switch` adopts a successor by
  owner-tested adopt-then-prove with the pin retained until publication
  re-pins it. Frictions 94d55e7e7d802eb5, 5f732d5481a720a3; lineage
  15ca828baf1b9d96 / 783b0c4c4cb5e1dc. (0845add)

## [3.2.0] - 2026-08-31

Bridge resilience and identity-only attestation. A resumed session regains its
publishing bridge, attestation carries identity and nothing else, a bridge
outage no longer blocks opening fresh tracks, the human budget lever is
scaffolded where the deny text points, doorbells stop interrupting a focused
human, and a stranded run whose anchor pane died can actually be revived —
proven live by resuming attest-tail/2026-08-31 with its context intact.

### Changed

- Bridge publication is identity-only: the fact file carries
  `{version, session_id, reported_session_path?, pane_id, issued_at, nonce}`
  and the pane carries exactly the session and attestation tokens. Provider,
  model, thinking, role, cwd, and config payloads are gone from publication,
  both verifiers, and the caller model facade (`assertOrchestratorAligned`,
  `modelIdentity`, `role-thinking.ts` deleted; spawn paths take no caller
  model context). Consistent with spawn-by-alias role inheritance: identity
  is attested, models are post-spawn observations. SPEC CFG-017..019,
  MOD-001/007 updated.
- The worker dispatch pointer names the lane's materialized
  `guidance-<profile>.md` as advisory (guidance-routing RELAY,
  d260b9a57421779e lineage); ARCHITECTURE/SPEC describe the config-only
  guidance projection and the additive `{ agent, moment, skills }` rule shape
  (SRT-001/003, CFG-005a).

### Fixed

- A resumed OMP session never republished its bridge: module-scoped cleanup is
  now ownership-guarded so a prior session's shutdown cannot tear down a
  resumed publisher, and the `omp_fact_bridge_mismatch` recovery text names
  recoveries that work (next-turn republish or process restart) instead of
  `/reload-plugins`, which never re-runs extensions. (783b0c4c4cb5e1dc)
- `herdr_track open` proceeds during a bridge outage: only a fresh coordinate
  may cross `omp_fact_bridge_mismatch`, the creator is recorded explicitly
  unverified (`verified:false`, no session id), every existing-run operation
  stays fail-closed, and a recovered attestation upgrades the record without
  ever downgrading one. SPEC RUN-001 family updated. (4a23ebaf4d4e8a4f)
- `budget-clamp.json` is scaffolded — inert, self-describing, mode 0600,
  create-exclusive, never overwriting a human value — at open and lazily on
  every park path, and every park/deny recovery text and ledger entry names
  the exact schema `{version:1, max_tokens?, max_minutes?, note?}`.
  (0b04293ebcb97c2f)
- Doorbells defer for a focused pane: one snapshot probe, a 60s tick, a
  re-probe, at most one more 90s tick, then exactly one send — fail-open on
  probe uncertainty, background-deferred past the MCP deadline, journaled as
  a deferred row plus a final outcome row in `messages.jsonl`.
  `MessageDelivery` gains `deferred`. (daedc5975efa2264)
- `revive mode:resume` recreates a dead anchor pane or tab inside an
  identity-sound workspace — registry coordinates move in one transaction,
  live agents are never respawned, workers and dead workspaces keep strict
  failures (e0940d14a4008677) — and accepts legitimate config drift for a
  gone agent with a grounded session, refreshing `config_sources` while
  keeping the recorded role immutable (567a804ec1ee05cc). SPEC REV-002a.

## [3.1.0] - 2026-08-31

Spawn-by-alias and attest lifecycle repairs. Spawned sessions now resolve their
own model from the user's persisted configuration — the creator-side role-table
pollution class is gone with the pinning machinery itself — and a born session
can attest from birth, a stale mounted build names itself, a run whose ORCH is
gone can be closed with human approval, and the supervision surface stops lying
about blocked or empty panes.

### Changed

- Spawn-by-alias replaces open-time role pinning: ORCH and worker spawns pass
  the configured role alias itself (`--model @role`), and the `default` profile
  passes no `--model` at all, so the child session expands the role against
  persisted OMP settings. Runtime model overrides are process-local, so an
  overridden creator or ORCH can no longer bake its own launch model into
  anything it spawns — the successor class of 681839bff914479c, where the
  v3.0.0 pin observation itself recorded the creator's live override as if it
  were the user's configured default. `pinned_roles` is no longer written or
  consulted; registries carrying it stay readable (no schema bump). The
  pre-spawn model-expectation gate is replaced by a post-spawn observation:
  `expected_provider`/`expected_model` are optional and record what the child
  actually reported. Structural identity attestation (MOD-001/MOD-002) is
  unchanged. SPEC RUN-001d inverted, RUN-004 updated, MOD-007 replaced.
  Tradeoff by design: a misconfigured role now fails in the spawned session
  rather than before the spawn, and there is no silent-fallback warning.
  (friction 221abf10d2280b47)
- MCP server launch survives stripped spawn environments: `mcp.json` invokes
  the launcher through `sh -c` with a guaranteed `PATH`, and the launcher
  prepends `~/.local/bin`, `~/.bun/bin`, and `/usr/local/bin` so both its Bun
  lookup and the server's `herdr` binary discovery resolve regardless of how
  the host spawned it. `/reload-plugins` no longer dies with
  `posix_spawn 'sh'` or strands the reloaded server unable to find Herdr.
  (friction 9072a9da598edd89)
- `protocol-worker.md` names the general ring rule — ring ORCH once after any report
  block that changes boundary state (completed, failed, blocked, decision-request) —
  and carries the shared-worktree conventions (stage by hunk, own write window only,
  serialize overlapping windows through channel documents). New digest appended to the
  template allowlist. (frictions b209cc47454ae65f, f7ed8df03ca92882)
- SPEC ARC-003 and ARCHITECTURE registration counts corrected to the five actual tool
  registrations, consistent with ACC-002.

### Fixed

- Born-pane attestation: the bridge no longer aborts its whole publication when the
  reported session path does not yet identify the live session (a spawned headless
  session's state until its first user input). The optional `reported_session_path`
  field is omitted and the mismatched value logged; tokens and the fact publish from
  birth, so a born ORCH's or worker's first guarded mutation passes attest with no
  human step. (frictions 4ff52b2d863b8532, d7e9a5e774b89a4f)
- Publication identity under subagents: the bridge heartbeat keeps the pane-owned
  session as its publication identity instead of adopting whatever session context the
  last `before_agent_start` carried; a declined context is adopted only when the pinned
  identity provably stops publishing (evidence-driven fallback, one-tick self-heal on a
  real session swap). Long turns with subagents no longer starve pane tokens past the
  TTL. (friction 15ca828baf1b9d96)
- First-prompt delivery no longer counts a `blocked` pane as delivered: birth still
  succeeds, but the open result carries a blocked-on-permission warning with the pane
  id, and `prompt_state` stays honest. (friction 66a5184e15deff47)
- Legacy `init` runs label their empty anchor pane as a non-ORCH placeholder so a bare
  shell under an `ORCH <track>/<run>` tab no longer reads as a dead orchestrator.
  (friction 1ffc55fca1b7bd9e)

### Added

- Human-approved force close: `herdr_track close` stays ORCH-only while the recorded
  ORCH is live, and additionally accepts a non-ORCH attested caller when the target
  run carries a strict human-owned `close-approval.json` (exact run and latest
  generation), a fresh Herdr observation proves the recorded ORCH gone (with the
  caller's own pane required in the census), and the registry revision matches.
  Closure attribution lands in the run's ledger and message log. No agent may write
  the approval file. (friction 5a95bb71e1a73d73)
- Stale-build self-naming: guarded-op failures carry `data.build` (mounted version,
  process start, newest source mtime, and a proven `source_newer_than_process` flag),
  and `registry_version_unsupported` names both the registry's and the mounted build's
  schema versions. The rebind itself remains OMP-core (`/reload-plugins`); that gap is
  tracked upstream. (frictions f53892758a860acf, 7b95cffa6d3cb7e5)

## [3.0.0] - 2026-08-30

Boundary judgment delivery and creator role-table pinning. Curated judgment criteria —
which routed skill to read, which worker profile fits, how much budget to declare — now
reach the ORCH at the boundary where each judgment is made, and a born session's polluted
`@default` no longer decides worker models.

### Added

- Creator role-table pinning: `herdr_track open` records the creator session's observed
  role table (each role's provider/model and bound thinking, with provenance) as
  `pinned_roles` in `a2a/delegation.json` (schema v3; v1/v2 reads stay valid), and
  ORCH/worker spawn resolution plus the silent-fallback judgment prefer that table over
  the live session's roles. A born session's polluted `@default` no longer decides
  worker models; a role absent from the table degrades to live resolution with a named
  warning. Tradeoff by design: OMP model-config changes mid-run are not reflected in
  that run. (friction 681839bff914479c)
- Boundary judgment delivery: a run born by `open` (or revived by either mode) now
  carries `guidance.md`, rendered from resolved configuration before the spawn and named
  by the ORCH's first prompt as an explicitly advisory third document. It states the
  orchestrator-surface `plan`/`authoring` routes as skill name + configured `trigger` +
  the description read from the installed `SKILL.md`, and a worker-profile table of
  configured name, role alias, and `guidance` criteria. Historical profile picks
  collapsed onto `default` because nothing ever told an ORCH what the other profiles
  were for; this is that missing sentence, delivered where the choice is made.
  Rendering is best-effort: an unreachable skill degrades to a `skill://<name>` pointer
  the reading session resolves itself (the only path to a runtime-managed skill, which
  exists on no filesystem root), an empty configuration renders explicit "None
  configured" sections, a render failure produces a document naming the failure, and a
  write failure is only a result warning. The document adds no `run.json` key and no
  open-result field.
- Two optional configuration fields carrying that judgment: `worker_profiles.<name>.guidance`
  (bounded single-line profile-selection criteria) and `skill_routing.rules[].trigger`
  (bounded single-line prose naming when a route applies). Both override by same-name
  layer and are advisory only; the shipped configuration still names no skill and ships
  no guidance text.
- `skill_routing.rules[].profiles`: an optional list of 1–8 worker profile names that
  narrows a rule to matching lanes. A scoped rule reaches only a lane whose assignment
  profile it names, an unscoped rule reaches every profile as before, and a delivery
  point holding no profile — every orchestrator-surface point — receives only unscoped
  rules, so a scoped route can never reach a target whose profile is unknown. A name no
  profile defines is tolerated and simply never matches, because rules and profiles may
  be authored in different layers.
- `scripts/check-templates.ts`, wired into `bun run check`: it fails when an installed
  protocol template's digest is absent from its own shipped-digest allowlist, or when a
  list is unsorted or duplicated. The allowlist rule was previously documented only in
  prose and had already been missed once — all three installed digests were absent when
  this check was written — which would have broken loading *and* revival for every run
  created since that edit.

### Changed

- **BREAKING for undeclared runs** — the budget seed fallbacks drop from 2,000,000 tokens
  and 480 minutes to 500,000 tokens and 30 minutes, calibrated at roughly the generative
  throughput of an ORCH plus one lane over half an hour of focused work. They exist so
  the audit cadence is meaningful on a run that declares nothing, not so real runs fit
  inside them: a nontrivial undeclared run now parks early and justifies itself. Declare
  `mandate.budget` calibrated to the mandate's scope instead.
- Worker-profile inheritance is same-name only. A profile inherits from the same name in
  an earlier layer, never from the resolved `default`, and the layer that first defines a
  name must declare its `role` or fail closed with `invalid_config` naming the profile and
  the layer file. A misspelled profile name used to resolve silently onto `@default`'s
  identity; that silent-failure path no longer exists.
- Schema `describe` text states its constants as facts and leads with the judgment
  criterion for the field. A 263-call audit found that fields publishing a constant
  collapse onto it — `timeout_ms` to its ceiling, `mandate.budget` left undeclared in
  4 of 4 opens — while fields whose meaning is situational diversify. `mandate.budget`
  no longer invites omission; `wait.timeout_ms` keeps the 25000 ms client clamp as a fact
  and asks for a size fitting the awaited boundary; `wait.until`, `doorbell_policy`,
  `revive mode`, `requested_tokens`, `output_lines`, and `limit` each carry their
  criterion, and a published maximum now reads as a ceiling rather than a value to use.
- `protocol-orch.md` points at the run's guidance document, and `protocol.md`'s advisory
  paragraph states that a rendered `guidance.md` carries the same advisory weight as a
  routed skill: selection criteria, never authority. Both digests are appended to the
  template allowlist alongside the versions they replace.

## [2.0.0] - 2026-08-29

Identity, communication, budget, and revival redesign. ORCH is born, never appointed;
answering a worker is a document append plus a bell; a run meters and justifies its own
spend; a run whose ORCH pane died is recoverable.

### Added

- `herdr_track open`: the single atomic entry behind a track — validate and render the
  bounded mandate, lay out the run, write `orchestrator-instructions.md`, stamp the
  creator, spawn the ORCH pane pre-aligned to the configured orchestrator role, and
  record the spawn birth. Partial failure is fail-closed and re-entrant, never
  compensating: only the same creator re-running the identical `open` can finish a birth.
  The session that calls `open` is retired for that track and never becomes its ORCH.
- Birth-based ORCH identity with a command-singularity gate: guarded run-command ops
  accept only the latest-generation birth session. A stranger fails
  `orch_identity_mismatch`, a replaced generation `stale_orch_generation`, and the opening
  session `creator_session_retired`.
- A bounded mandate with published limits — intent at most 4096 characters, at most 32
  entries of 500 characters each, rendered document at most 16384 bytes — whose identity
  is the SHA-256 of the rendered bytes.
- A budget machine on every guarded op (assignment add/wait, worker resume/close, track
  close). Metering is a run-level aggregate over the ORCH session and every lane session
  plus wall clock, reporting measured, assumed, and judged totals separately. Four
  artifacts carry it with authority split so neither side can forge the other's part:
  server-appended `budget-ledger.md`, human-owned `budget-clamp.json` that applies as
  `min(granted, clamp)` and can therefore only lower a cap (0 is the kill switch),
  server-seeded `budget-audit-<n>.md`, and the tool-owned record in `a2a/delegation.json`.
- `herdr_track budget_extend`: a bounded justification — done, remaining, and why more, at
  most 500 characters each, appended verbatim to the ledger — that buys nothing by itself.
  One extension raises the cap by at most half of the currently granted cap, a further
  extension is refused within 15 minutes of the last, and the server, never the ORCH,
  spawns an auditor session to judge it. The auditor holds a reserved worker ordinal but
  is not a responsibility lane, so no ORCH op can address, coach, or reuse it. Silence
  never becomes budget.
- Explicit parking instead of death when a cap is crossed: a reason in the registry, an
  entry in the ledger, a `budget-parked:<reason>` pane marker, and a landing allowlist —
  `wait` and `close` still settle work already in flight, while `add` and `resume` fail
  `budget_parked` with the way out named.
- `herdr_track revive`, so a birth record outlives the session it names. `resume` (the
  default) reconnects the recorded birth session by its exact official path and keeps the
  context, refusing identity drift with `revival_session_changed`. `rebirth` starts
  generation+1 in the same pane with nothing inherited, behind four checks the server
  makes for itself: the user's written `rebirth-approval.json` naming exactly the next
  generation, run documents sufficient to reconstruct command, no assignment in the
  `ambiguous` state, and an ORCH that is not live. A rebirth records `origin: "rebirth"`
  and the approval's SHA-256, so the generation chain states both that context was
  destroyed and which human act allowed it.
- `herdr_friction`: a standardized dogfooding taxonomy with a global append-only local
  log, fingerprint grouping, and a session-local `friction_hint` on repeated
  non-retryable errors, plus GitHub friction issue and PR templates for human-gated
  promotion.
- `herdr_message` as the fourth public tool: the `wake_orch`, `wake_peer`, and
  `notify_run` doorbells. The server composes the text, resolves targets from run records,
  transports them as Herdr pane input, and logs every attempt to `a2a/messages.jsonl`.
  Delivery is a soft observation, never an authority.
- Names as the supervision surface: one Herdr space `herdr/<track>`, one anchor tab per
  run, and panes labelled `ORCH <track>/<run>` for the orchestrator and
  `w<N> <responsibility_key>` for each lane. The anchor tab carries the run's ORCH pane;
  labelling is display only and degrades to a warning.
- Protocol-template compatibility: a run's protocol documents are accepted against every
  digest this project has shipped for them, so a byte-identical document passes silently,
  a previously shipped version passes with a named `template_drift_warning` instead of
  bricking an existing run, and anything else fails closed quoting its digest.

### Changed

- `SKILL.md` addresses the creator only — whether the work is track-worthy, how to distill
  a mandate, `open`, and how the creator dies well. ORCH and worker duties moved into the
  `protocol-orch.md` and `protocol-worker.md` templates, each holding only its own
  reader's obligations, and contracts the tools already enforce and name in their error
  messages are no longer restated in prose. Every session answers in the user's language.
- `plan.md` is no longer a precondition for a fresh run — the ORCH writes it with the user
  in clean context — and remains required for a reset sibling.
- `wait` on an elapsed window returns `ok: true` with `timed_out` and the fresh lane state
  instead of `herdr_command_failed` with `retryable`.
- The registry is validated before it is written, not only when the next reader loads it,
  so a malformed record is attributed to the call that produced it.
- The registry schema is versioned: the current version is 2 with a supported set of
  `{1, 2}`. Reads accept version 1, writes upgrade it in place, unknown-key rejection
  stays exact within a version, and a version outside the set fails
  `registry_version_unsupported` naming the `/reload-plugins` respawn.
- The in-session bridge heartbeat is idempotent and session-owned: it starts once, before
  the first refresh attempt is awaited, and only `session_shutdown` stops it. A caller
  waits at most 20 seconds for a refresh, and a straggler is superseded by the next
  attempt instead of blocking the tick.
- Non-goals restated: money units and precise cost accounting remain out of scope; a
  budget-parked ORCH opening a different track is documented rather than blocked — the
  opener becomes that track's retired creator and commands nothing there, and cross-track
  aggregation stays deferred; and the clamp and rebirth-approval gates check file
  contents, never authorship, so the guarantee is attributability, not prevention.
- `docs/SPEC.md`, `docs/ARCHITECTURE.md`, and `README.md` caught up with the five-tool
  boundary, atomic birth and creator retirement, the mandate limits, command singularity
  and naming, the template-compatibility rule, budget and revival, the response-free
  answering path, and the inter-run channel.

### Removed

- **BREAKING** — `herdr_assignment respond`, and with it the response guards, the
  `resolve_block` operation, and the text/keys response grammar. There is now exactly one
  way to answer a worker — a decision request, a ruling, and genuine blocked input alike:
  append an `[ORCH Response]` block to that worker's lane report, then ring
  `herdr_message wake_worker`. The wake is pane input, so it reaches an idle worker and an
  input-waiting one alike; the document is the authority and the bell is only a pointer.
- **BREAKING** — `notify_run` payloads. The message kind and note now live in an entry of
  the sender-owned inter-run channel document
  `a2a/orch-to-<to_track_id>_<to_run_id>.md` — directional, append-only, named after the
  destination, and written only inside the sending run's own directory. Append the entry
  first: the bell reads that document and refuses with `channel_document_missing` or
  `channel_document_empty` before delivering anything, so a bell pointing at nothing is
  impossible by construction. The counterpart answers by appending to its own reverse
  channel and ringing back.
- **BREAKING** — the `/herdr-align` command, together with its session-alignment helper
  and the caller-alignment parameter. Every ORCH is born pre-aligned by its own spawn, so
  a caller's model was never a precondition of `open`; no replacement is needed. The OMP
  extension now registers no command and is bridge-only. `orchestrator_model_mismatch`
  survives for the one remaining case — a dispatching session that has drifted off its
  role — and its recovery no longer names a command that does not exist.
- **BREAKING** — `a2a/orch-target.json` and last-writer-wins ORCH targeting. ORCH identity
  is a birth-record chain in `a2a/delegation.json`, and every wake resolution reads birth
  records. No migration is possible or needed for a live run: the file is simply gone, and
  a run created by the legacy path is claimed by its recorded spawn birth.
- **BREAKING** — ORCH identity from `herdr_track init`. The legacy `init` plus
  `start_orchestrator` path still exists, but only for the two cases that need it: a
  sibling run created by a reset, and the target of a handoff. Both must carry `plan.md`
  before `start_orchestrator`. That path is refused on a run created by `open`, because
  such a run already has a creator record and an ORCH; use `herdr_track revive` to recover
  that run's ORCH instead of starting a second one.

### Fixed

- Two ORCH sessions could concurrently command one run; the start-caller session performed
  orchestrator duties (`1164424bae116c41`).
- `notify_run` addressed to another run delivered to the sender's own ORCH pane, ignoring
  the target coordinates (`8a9dc4d27da3e3f4`).
- `add` created lane and assignment records on a model-verify failure, leaving
  `failed`/`starting` residue with no cleanup path. The ORCH identity comparison now runs
  before anything is allocated, a lane that never reached a live session is recorded
  terminally `failed` rather than left `starting`, and `close` treats a worker-less
  `starting` lane as never-born
  (`cf7c4a8eb2bdb9c1`, `cc4ef243af1e26fa`, `61cb585dfdc1c134`).
- Re-adding an assignment bound to a closed lane failed it terminally with zero work done,
  and a failed-before-prompt assignment stayed bound to a ghost `starting` lane; both now
  rebind (`8ff57d8dfb8afe35`, `a8411ae028b3148f`).
- FIFO promotion set the lane's active assignment but never prompted the worker, so an
  assignment stayed queued while its lane idled (`173f1e497f2f0ea0`).
- `respond` returned ok on a queued assignment while delivering nothing, and an idled
  decision-request worker had no ORCH-to-own-worker channel; both are closed by concept
  removal (`208774fb7255929b`, `d48c359302e0cb5d`).
- An OMP `modelRoles` thinking suffix on the orchestrator role was silently dropped, and
  `start_orchestrator` launched an ORCH at a thinking level the guarded path did not
  expect (`1c9d39e7354a45cb`, `4965907d4b165dbe`).
- The bridge published role-bound thinking that the server's facts schema then rejected,
  failing every attested op at model-verify (`59457ca435b3fce7`).
- A bridge-mismatch attestation error was reported as non-retryable though an identical
  retry succeeded after `/reload-plugins` (`160eafef69b5a19d`).
- The bridge refresh loop died permanently after one silent failure, leaving the fact file
  stale for hours, and a fresh session in a pane whose previous bridge had died published
  no fact at all (`ae4be6c9eff4ffc0`, `bb2aec9368fa7a59`). A session already running under
  a build whose bridge stays silent is still recoverable only by restart: `/reload-plugins`
  cannot replace in-session extension code.
- The assignment goal's own 4096-character limit was absent from both the rejection message
  and the skill, leaving a caller to find it by trial (`29239ed8e5929e59`).
- Budget metering charged cumulative per-turn totals including cache reads, so judged spend
  grew superlinearly in turns; it now charges input, output, cache writes, and reasoning
  tokens on a generative basis, and dedupes cumulative settlement snapshots per session
  (`d5dc8d0ebf17472a`).
- The `budget_denied` recovery text claimed the human's clamp file could raise the ceiling;
  touching the clamp only releases the next audited attempt (`7ba3fb06e21c486c`).
- The auditor session lingered after its verdict landed, leaking one live pane per audit.
  The close now waits for the auditor's own idle/done boundary and is ledgered, and every
  guarded budget op sweeps settled-but-unclosed auditors first (`fa85b38000c4e118`).
- A long-lived server pinning an older registry validator reported a healthy registry as
  malformed and told the reader to repair it, which would have had an agent hand-edit a
  tool-owned file (`8c1e0ea5c3e5439b`).

[3.5.5]: https://github.com/edgar-min/herdr-delegator/compare/v3.5.4...v3.5.5
[3.5.4]: https://github.com/edgar-min/herdr-delegator/compare/v3.5.3...v3.5.4
[3.5.3]: https://github.com/edgar-min/herdr-delegator/compare/v3.5.2...v3.5.3
[3.5.2]: https://github.com/edgar-min/herdr-delegator/compare/v3.5.1...v3.5.2
[3.5.1]: https://github.com/edgar-min/herdr-delegator/compare/v3.5.0...v3.5.1
[3.5.0]: https://github.com/edgar-min/herdr-delegator/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/edgar-min/herdr-delegator/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/edgar-min/herdr-delegator/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/edgar-min/herdr-delegator/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/edgar-min/herdr-delegator/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/edgar-min/herdr-delegator/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/edgar-min/herdr-delegator/compare/v1.1.1...v2.0.0
