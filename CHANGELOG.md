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

## [2.0.0] - Unreleased

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

[2.0.0]: https://github.com/edgar-min/herdr-delegator/compare/v1.1.1...v2.0.0
