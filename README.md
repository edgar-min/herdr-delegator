# herdr-delegator

`herdr-delegator` routes substantial independent OMP work to persistent Herdr responsibility lanes. A worker keeps one official OMP session across sequential assignments with the same responsibility. Deterministic files remain the audit record; MCP supplies bounded control; Herdr supplies live observation.

- Package/plugin: `herdr-delegator` 3.11.0 (Unreleased)
- Role skills: `herdr-create`, `herdr-orch`, `herdr-default-worker`, `herdr-task-worker`, `herdr-slow-worker` 3.11.0; separate configuration and Jev-development skills are also packaged
- Delegation tools: `herdr_track`, `herdr_assignment`, `herdr_worker`, `herdr_message`, `herdr_friction`; advisory tool: `herdr_jev`
- Official runtime: OMP only
- License: Apache-2.0

The plugin does not replace ORCH planning or review, choose responsibility boundaries, expose raw Herdr management, manage host task/subagents, close retained workspaces, or make overlapping edits in a shared directory safe.

## Package

The package follows Agent Plugins 1.0.0:

- `plugin.json` is the portable package manifest;
- `mcp.json` declares one Bun stdio MCP server;
- `skills/herdr-create/SKILL.md` opens a track and retires; `herdr-orch` and the three worker skills are the complete installed operating contracts a born session is pointed at, while `herdr-config` and `build-your-own-jev` serve configuration and development;
- `io.github.edgar-min.herdr-delegator/extensions/herdr-delegator.ts` is the bridge-only OMP client extension;
- `package.json#omp.extensions` retains the namespaced entry solely for current OMP extension-module compatibility.

The MCP server has direct runtime dependencies on `@modelcontextprotocol/sdk` and `zod`. For OMP 18.0.5 compatibility, `mcp.json` launches bare `sh` with `${PLUGIN_ROOT}/bin/herdr-delegator-mcp` as its sole argument and `${PLUGIN_ROOT}` as `cwd`; OMP validates plugin-relative commands but does not resolve them before `posix_spawn`. The quiet bundled launcher prefers `bun` on `PATH`, then checks `${BUN_INSTALL}/bin/bun` and `${HOME}/.bun/bin/bun`, and otherwise exits 127 with one stderr diagnostic. `plugin.json`, the fixed `skills/` directory, and `mcp.json` are the portable manifest authority; `package.json` remains npm and current-OMP compatibility metadata.

## Prerequisites

1. [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi).
2. [Herdr](https://github.com/edgar-min/herdr).
3. [Bun](https://bun.sh/) on `PATH`, under `BUN_INSTALL/bin`, or at `~/.bun/bin/bun`.
4. The official OMP integration:

```sh
herdr integration install omp
```

Launch mutations require an OMP session inside a verified Herdr-owned pane. Missing configuration, bridge facts, model/session identity, run ownership, or safe topology fails closed.

## Installation

From GitHub:

```sh
omp plugin install https://github.com/edgar-min/herdr-delegator
```

OMP 18.0.5 discovers the Agent Plugins `plugin.json`, skill, and `mcp.json`; its compatibility package metadata loads the namespaced OMP bridge entry.

For local development:

```sh
bun install
omp plugin link .
```

`/reload-plugins` refreshes the bundled skill and MCP server. A changed extension module requires a new OMP session for cutover verification.

## Configuration

At least one `herdr-delegator.json` layer must set an absolute `storage.root`:

- user: `${PI_CODING_AGENT_DIR}/herdr-delegator.json`;
- user fallback: `~/.omp/agent/herdr-delegator.json`;
- project: `<project>/.omp/herdr-delegator.json`.

Project values override user values. A run-local configuration may override profile leaves but may not relocate the run.

```json
{
  "version": 1,
  "storage": {
    "root": "/absolute/path/to/herdr-runs"
  },
  "orchestrator": {
    "role": "@plan",
    "thinking": "high"
  },
  "worker_profiles": {
    "default": {
      "role": "@default",
      "thinking": "inherit",
      "guidance": "meticulous language work, documents, and review passes"
    },
    "task": {
      "role": "@task",
      "thinking": "inherit",
      "guidance": "code implementation under a clear specification"
    },
    "slow": {
      "role": "@slow",
      "thinking": "inherit",
      "guidance": "long deliberate reasoning; also the profile budget auditors run on"
    }
  },
  "skill_routing": {
    "rules": [
      {
        "boundary": "authoring",
        "surface": "orch",
        "skills": ["readchk", "shower"],
        "trigger": "when an assignment must execute without chat history"
      },
      {
        "boundary": "completion",
        "surface": "worker",
        "skills": ["sip"],
        "profiles": ["task"]
      }
    ]
  }
}
```

Configure a planning-grade orchestrator role — decision quality matters more than cost for the session that plans, routes, and judges. Without an `orchestrator` entry the plugin falls back to `@default` so a vanilla install still resolves, but that fallback is not a recommendation. The worker profiles are `default`, `task`, and `slow`: those three, and only those three, have a packaged worker role skill, so a new run can only dispatch an assignment declaring one of them. The configuration parser and older run records still accept other profile names — permissive parsing and historical compatibility, not new role support — and on a current run an assignment naming one is refused at preflight and at `add`, before the ID is consumed or a lane is started, rather than silently borrowing another role's instructions. The layer that first defines a profile name must give it a `role`; a profile never inherits another profile's identity, so a misspelled name fails the layer instead of silently running on `@default`. Profiles select bounded OMP role aliases rather than concrete model IDs. Cost-efficient small mechanical work routes to host OMP task/subagents, not persistent responsibility lanes.

Each profile may carry ORCH-facing selection `intent` (with legacy `guidance` as fallback) and a worker-facing `directive`. Selection criteria help choose a profile; only the selected profile's directive reaches that worker. Neither is a role or model identity.

`herdr_track open` spawns the ORCH with its configured unresolved role alias; the spawned session resolves it from its own OMP settings. There is no alignment command. Dispatch identity verification concerns the recorded session and pane, not an ORCH-predicted model.

Role resolution happens in the spawned session, from configuration: spawns pass the unresolved role alias (`--model @task`), and the `default` profile passes no `--model` at all, so the child expands the role against the user's persisted OMP settings. Runtime model overrides are process-local — a creator or ORCH launched with an explicit `--model` cannot leak its override into anything it spawns. The caller therefore predicts no model: each lane's `expected_provider`/`expected_model` is recorded post-spawn from the child's own report, as an observation. Registries written by older versions may carry a `pinned_roles` table; it is still read-tolerated but no longer written or consulted (friction 221abf10d2280b47). Tradeoff: a misconfigured role fails in the spawned session rather than before the spawn.

### Advisory skill routing

Optional `skill_routing.rules` (at most 16) route installed skills to protocol boundaries. `boundary` is one of `plan`, `authoring`, `dispatch`, `completion`, `settlement`, `reset`; `surface` is `orch` or `worker`; each rule names 1–8 skills. The plugin ships no skill names — rules live in user, project, or run configuration, so any skill pack plugs in without touching the plugin. Matching routes are delivered deterministically as `skill_routes` plus an imperative `skill_routes_note` in tool results (`init`, `preflight`, terminal assignment results) and inside the worker dispatch prompt; the note names the `skill://<name>` resolution scheme. Routes are advisory only: they raise discovery reliability, never gate settlement or lifecycle, and never prove a skill ran.

A rule may add two optional fields. `trigger` is one line saying when the route applies — the criterion the reading session judges against, not just the skill's name. `profiles` narrows a rule to named worker profiles: a rule listing `["slow"]` reaches a slow lane's dispatch and no other, while a rule without `profiles` reaches every lane. Unknown profile names are tolerated rather than rejected, because rules and profiles may live in different layers; such a rule simply never matches. A delivery point that holds no profile — every orchestrator-surface result — receives only unscoped rules.

### Complete role skills, separate advisory configuration

Every role learns its whole job from one installed packaged skill. The creator uses `herdr-create` to clarify the mandate, open the track and retire after a confirmed handoff. A new run points its ORCH at the installed `skills/herdr-orch/SKILL.md`, and each dispatched lane at the packaged skill its assignment profile selects — `default` → `herdr-default-worker`, `task` → `herdr-task-worker`, `slow` → `herdr-slow-worker`. Nothing is generated into the run: no role artifact, no guidance document, no reading chain.

Configured advisory criteria ride inline in the same prompt, and the audience split is unchanged: the ORCH sees its own directive, the worker-profile selection table and its own routes; a lane sees only its own profile's directive and matching routes. Empty or failed advice never removes a required duty — the packaged skill is complete on its own — while a missing or unreadable required skill, or a profile with no packaged skill, fails visibly before the prompt instead of silently borrowing another role's instructions.

Required role instructions are resolved from the installed package by an explicit package-relative path, never from a run artifact and never from a catalog name lookup, so nothing inside a run can drift from the contract its role is executing and no run file is rewritten to deliver one. Pointing at a document is still not proof that a session read it.

Optional routes remain supported configuration, not mandatory dependencies of the packaged role skills. Review and approve configuration changes at their actual layer: changing a user-layer rule can affect other projects. No file-size comparison or model score alone establishes improved quality, time savings or reduced agent context.

## Start (first run)

1. Install the plugin, then `/reload-plugins` (or start a new OMP session).
2. Create a user-layer `herdr-delegator.json` with an absolute `storage.root`, and map `orchestrator.role` and each worker profile to OMP roles you actually have configured (`@plan`, `@default`, ...).
3. Open Herdr and start OMP inside a Herdr pane — every guarded mutation requires the pane bridge and fails closed outside it.
4. Invoke the bundled skill and let ORCH drive:

```text
/skill:herdr-create
```

5. Optionally wire `skill_routing` rules to your trusted skills before the first real track — see above.

The session you invoke the skill in distills the conversation into a bounded mandate and calls `herdr_track open` once; that call creates the track's Herdr space and run, spawns the ORCH into its own pane pre-aligned, records the birth that is the run's only command identity, and retires the opening session for that track. From there the ORCH — not you — writes `plan.md`, chooses responsibilities, authors immutable assignments, dispatches them through MCP, verifies results, and performs recovery, budget justification, or closure. The user converses with the ORCH pane.

## Responsibility lanes

A worker is a persistent responsibility lane. An assignment is one unit of work routed to that lane.

Routing rules:

1. Reuse an exact responsibility whenever compatible.
2. Keep at most one active assignment per lane.
3. Queue same-responsibility assignments FIFO while the lane is active.
4. Create another lane only for a real `direction`, `ownership`, or `dependency` separation with a short reason and conflicting worker ID.
5. Do not impose a fixed worker ceiling or use scoring.
6. Do not create a worker because the matching lane is merely busy.

Bounded mechanical work belongs to host OMP task/subagents. The plugin does not verify their models.

## Immutable assignments

ORCH writes one file:

```text
<run>/a2a/assignments/A-NNN.md
```

The strict Markdown contains `assignment_id`, `responsibility_key`, and `profile` frontmatter — optionally followed by one more field, `label` — then `Goal`, `Completion conditions`, `Write ownership`, `Dependencies`, and `User boundaries` sections, optionally followed by one trailing `References` section. `Goal` is prose of at most 4096 characters; the four bullet sections take at most 64 lines each, every line a `- <text>` bullet of 1 to 1000 characters. The whole file is at most 64 KiB with LF line endings. Watch one trap: a line starting `# ` at column 1 begins a new section wherever it appears, including inside a fenced code block, so indent such a fence. Every refusal names the section, the bound, and the exact text that would satisfy it. After dispatch the file is immutable, and `add` makes it read-only (`0444`) to say so.

`assignment_id` is `A-` plus three or more digits that are not all zero, and the published tool schema enforces exactly that. The ID is ORCH-chosen and carries no meaning. A human-readable name goes in `label`: 1 to 48 characters of letters, digits, `-` or `_`, beginning and ending with a letter or digit — so `id-grammar` is a label and `_draft` is not. It is shown on the dispatch pointer, the `preflight` result, and the worker pane title, and two runs that both hold `A-001` are told apart by `<track_id>/<run_id>/<assignment_id>`. A label is never copied into `delegation.json`, never queued on, and never part of settlement, and nothing enforces that labels are unique — the coordinate disambiguates, the label only reads well.

One compatibility note: the artifact grammar is not versioned, so a server older than the `label` field rejects a label-bearing artifact as invalid. Reload mounted servers (`/reload-plugins`) before first using `label` on a working tree that older server processes may still read.

`References` pins the documents an assignment is written against, so "read the plan" names bytes rather than a filename:

```text
# References

- plan-contract.md sha256:f2a73ac32d27d0f3db1d15e0acc46da9cf5d0ad56ab9433bd87eb3ec9367b977
```

At most 16 bullets; each path is relative to the run directory and must resolve to a plain file inside it — no `..`, no symlink, no hardlink, no duplicate, at most 256 KiB. `preflight` and `add` verify every hash and refuse a mismatch before the assignment ID is consumed, so the fix is a one-line edit rather than a new ID. After dispatch a mismatch is reported as `reference_drift` on `wait`, `herdr_worker inspect`, and `herdr_track close`: the dispatch is never recalled, because the worker already holds the pinned hashes and can check for itself. Correct a drifted document with a new assignment. `References` is also a one-way relaxation — a server older than 3.9.0 rejects an artifact carrying it for section count, so reload mounted servers first.

Workers append results to `a2a/w<N>-report.md` and settle an assignment with an exact completion block — two literal lines at column 1:

```text
[Assignment Completion: A-001]
status: completed
```

No heading marker before the header, lowercase `status:`, lowercase value, exactly one recognized status line in the block. Blank lines around it are allowed and never required. The four near-misses this grammar used to swallow in silence now each name themselves — `## [Assignment Completion: …]`, `Status: completed`, `status: Completed`, two status lines in one block — with the cause, the report line, and the two lines that would have settled it, reported on `wait`, `herdr_worker inspect`, and the `herdr_track close` refusal. "No completion block at all" is a distinct observation from "a block that does not parse".

`status: blocked` is recognized too. It records a reported boundary on the assignment and settles nothing: state, lane state, `wait.until` and doorbell boundaries are untouched, and a later `completed` or `failed` block is what settles. When a report carries several valid blocks for one assignment, the latest one is acted on — so a correction appended under a malformed attempt is what decides. A block appended after the assignment already settled changes nothing and says so.

MCP stores the report SHA-256 and completion timestamp in `a2a/delegation.json`. There is no separate assignment contract or receipt file.

Completion returns the lane to `idle`, promotes its FIFO head exactly once, and leaves the worker tab/session open.

## MCP tools

### `herdr_track`

- `open`: run coordinates, canonical project `cwd`, and a bounded `mandate` (`intent`, `constraints`, `shape_of_success`, optional `budget`). The single atomic birth; the opening session is retired for that track.
- `init`: run coordinates, canonical project `cwd`, optional sibling `reset_of` — legacy layout for reset siblings and handoff targets.
- `inspect`: bounded run, registry, ORCH, and budget observation. "Read-only" covers the budget and only the budget: the budget view neither judges nor unparks anything and writes no budget field. The call itself runs the settlement sweep first, like `wait` and `herdr_worker inspect`, so whoever looks learns the truth — a lane that reported completion settles here, and a report whose block does not parse says so in `data.settlement_sweep`. That sweep may persist: a settlement, a first `blocked` observation, and, riding the same write, the materialization of a legacy registry at the current schema. So the result says which happened rather than leaving it to be inferred — `effect: "confirmed"` with a new revision when the call wrote something, `effect: "none"` with an unchanged revision when it only observed. Either way the returned revision is the current one, so a `close` can be issued from it directly.
- `start_orchestrator`: legacy spawn; refused on a run `open` manages.
- `budget_extend`: a bounded justification (`done`, `remaining`, `why_more`), optional `requested_tokens` and `requested_minutes`.
- `revive`: optional `mode` — `resume` reconnects the recorded birth session, `rebirth` starts generation+1 with the user's written approval.
- `close`: requires a fresh registry revision and safely closes a fully settled track. It sweeps settlements after checking that revision, and refuses a lane whose active assignment is still non-terminal even when the lane itself is idle — closing that lane would strand the assignment with no live lane left to settle it. The refusal names, per lane, why it is unsettled, and the revision to retry from.

Declare the `budget` seed rather than leaving it out: `tokens` and `minutes` are your estimate of what this mandate's scope should take, not a ceiling to wish for, and crossing the estimate parks the run until the ORCH justifies an extension — it never kills a session. An undeclared seed falls back to 500,000 tokens and 30 minutes, which is deliberately tight: the fallback exists so the audit cadence still means something, not so a real track fits inside it, and a nontrivial run that declares nothing will park early. A park is not a dead end for the repair of whatever broke the run: one `add` may carry an `emergency` claim, which passes the park once and buys that one registration — dispatched as usual, which is the point — and nothing else: no cap moves, the park stands, and a queued head already waiting is still not promoted. It owes a post-hoc audit that a clean session judges before the next extension (`docs/SPEC.md` BUD-016).

A grant is a decision, not automatically a ceiling. `budget_extend` and `inspect` report the same per-axis block: the audit `verdict`, `granted`, `effective_cap`, `usage`, `applied`, and `usable`. `applied` says whether the granted figure became that axis's ceiling at settlement and, when it did not, why — `awaiting-clamp` (a human has to raise the clamp — where a `full`-policy clamp does not already carry the granted figure, and wherever the clamp is unreadable), `pinned` (a human ceiling sits below the figure), `write-owed` (the server's own clamp write has not landed and is retried), or `none` (nothing was granted on that axis). `usable` is a different question — usage against the axis ceiling right now — so a grant can be `awaiting-clamp` on an axis that is still usable because your clamp was already high enough. `applied` is history, not permission: on a settled extension it records how that grant landed, and lowering your clamp afterwards does not rewrite it — so read `effective_cap`, `usable` and `park_reason` for what the run may do now. When a park is waiting on you, the response names `required_clamp`: the field and value that APPLY the recorded approval, and `releases_at`, the lowest ceiling on that axis that would also clear the current judgment — an observation of the arithmetic, not a number the server is choosing for you. The two differ whenever spend has already passed the approved figure, and there `release_condition` says so: writing the approval applies it and the park stands, and releasing needs a further extension (same interval and half-step covenant) or a ceiling above the usage judged at that moment. Release is a conjunction — both axes strictly under their effective caps at the same judgment. A `denied` park has one route only: a human changing the clamp file. And no observation performs the transition; the park lifts at the next guarded op that judges the budget, and `budget_extend` re-judges before its own gates so the call you make right after editing the file is enough.

Either axis can be extended. `requested_minutes` exists because the wall clock is what a coordination-heavy run exhausts first, and it used to have no extension path at all. Each axis is capped at half of what it has already been granted; an ask above that is truncated to the step rather than refused, and an axis you omit still moves by its own step, because a grant moves both dimensions. Under `full` a verdict raises neither axis on its own: tokens are held at the seed and wall clock at the run's minutes floor until you write the clamp.

The auditor answers per axis as well. A `grant` approves the whole request and a `deny` approves nothing; a `partial` names the axes it cuts — `granted_tokens`, and optionally `granted_minutes` — and approves in full any axis it leaves out, so trimming the spend while leaving the wall clock alone is exactly what writing only `granted_tokens` means. A figure above the request is truncated to it; a zero or repeated figure leaves the audit document unparsed rather than reading as a grant of nothing, because `deny` is how nothing is approved. Both figures are ignored on `grant` and `deny`, where the disposition already fixes both axes.

### `herdr_assignment`

- `preflight`: assignment/responsibility IDs; validates the canonical draft's grammar before immutability, returns its server-computed SHA-256 and `authoring` skill routes, and never mutates state.
- `add`: assignment/responsibility IDs, immutable artifact SHA-256, optional separation, wait, `urgent`, and `emergency` (`failure`, `why_now`) — the budget carve-out above, never a priority.
- `wait`: assignment ID and optional wait.

There is no response action: a worker is answered by appending an `[ORCH Response]` block to its lane report and ringing `herdr_message wake_worker`.

`wait` is a single short state probe for a boundary already expected to have occurred, or explicit recovery after a missing or inconsistent doorbell. `wait.timeout_ms` accepts up to 300,000 ms, but the server clamps one call's effective wait below the common 30 s MCP transport limit. Do not compose a longer vigil from repeated calls: an elapsed window returns a successful observation with `timed_out: true` and the fresh lane state, after which the ORCH ends its turn and relies on the next doorbell. Terminal results carry a bounded `settlement` observation (elapsed wall time, a cumulative session token snapshot from the official OMP JSONL, and an advisory unowned-changes list); `herdr_worker inspect` and `herdr_track inspect` expose bounded staleness and totals. Observations are advisory, never authority.

Dispatch is self-healing: a settlement that promotes the lane's queue head also dispatches it in the same guarded call, and a `wait` on a queued head of an idle lane dispatches it too. Re-adding an assignment whose lane closed or failed before any prompt rebinds it to a live or fresh lane.

`urgent: true` inserts an add at the head of its lane's queue instead of appending it. That is all it does: an idle lane dispatches immediately either way, nothing already running is interrupted or recalled, a parked run still refuses to promote a head, and the choice is never written to the artifact, the ID, the label, or any record — so there is no priority to read back later. Read the placement from `data.queue_position` in the same response (the 0-based queue index, `"active"`, or `"none"` for a duplicate add naming an already-terminal record). A mounted server older than this field drops it silently and appends, so an absent `data.queue_position` means the placement did not happen; reload the plugin before relying on it.

Assignment state is exactly:

```text
queued | prompting | working | blocked | completed | failed | ambiguous
```

### `herdr_worker`

- `list`: optional responsibility filter.
- `inspect`: worker ID and optional bounded output lines.
- `resume`: worker ID and exact expected official session ID.
- `close`: worker ID, expected session ID, and fresh state sequence.

### `herdr_message`

- `wake_orch`: assignment ID and boundary; worker doorbell to the run's born ORCH.
- `wake_orch_audit`: run coordinates only; the clean auditor's doorbell after it appends a verdict block, refused for this run's ORCH and for any registered lane.
- `wake_peer`: peer lane ID; doorbell after a plan-authorized channel append.
- `wake_worker`: own-lane ID; ORCH-to-own-worker doorbell after appending an `[ORCH Response]` to the lane report.
- `notify_run`: target run coordinates only; ORCH-to-ORCH bell, refused unless this run's inter-run channel document for that target already exists.

Every doorbell points at a document and carries no content of its own. The server composes every delivered text, resolves targets from birth records and the worker registry, and transports messages as Herdr pane input. Delivery is a soft observation (`delivered`, `rejected_blocked`, `target_unresolved`, `failed`) and every attempt is logged to the sending run's `a2a/messages.jsonl`; only invalid input hard-errors, including a bell whose document does not exist yet.

### `herdr_friction`

- `report`: standardized `kind` (`contract-gap`, `false-block`, `ambiguous-outcome`, `excessive-steps`, `doc-drift`, `defect`, `papercut`), `reporter` (`agent`/`human`), one-line `summary`, optional `tool`, `error_code`, bounded `evidence`, and run coordinates.
- `list`: optional `kind`/`fingerprint` filter and `limit`; returns newest entries plus per-fingerprint counts.

Dogfooding friction accumulates in a global append-only local log at `<agent-dir>/herdr-delegator/friction/friction.jsonl` (mode 600) — never in an external tracker; promoting curated reports to issues is a separate human-gated triage pass. The action skips the OMP fact bridge so a broken bridge stays reportable, and duplicate symptoms group by a digit-insensitive fingerprint. When the same non-retryable error code recurs in one server session, the failing result carries a one-line `friction_hint` inviting a single report — the nudge is the trigger; reporting every error is explicitly out of contract.

To promote friction upstream, open a [friction issue](https://github.com/edgar-min/herdr-delegator/issues/new?template=friction.yml): copy `kind`, `summary`, `fingerprint`, and `evidence` from `herdr_friction {action: "list"}`, and review them for private paths first — the local log is unsanitized by design. A PR fixing dogfooded friction cites the same record in its template, so the tracker stays greppable by the exact taxonomy the tool records.

### `herdr_jev`

- `rank`: an `intent` plus candidate `paths`; returns every candidate ordered by the probability that it serves the intent, as file names only (`path_only`) or as chunk ranges. Nothing is dropped by a threshold. `top` bounds the input — how many of the given paths, in the order given, are read and chunked — and every path beyond it comes back in `unevaluated` with that reason; it is not an output top-K, and `path_only` ignores it because no file is read.
- `judge`: fixed moments. `authoring` evaluates assignment wording; `settlement` compares completion claims with the report and available change evidence; `escalate` distinguishes human approval from autonomous decisions or further observation; `intake` compares a restatement with the canonical assignment; `plan` compares the canonical mandate and plan. Judgments are advisory, not acceptance or attribution.
- `check`: `sentences` against `reference_paths`; per sentence the probability that some chunk supports it, plus the chunk or `none`.
- `log`: `outcome` records a supported identifier-only outcome for a `request_id`; `summary` reports recorded decision/outcome counts for `request_ids`. Counts do not imply accuracy, approval or success.

Delegation calls except `herdr_friction` include `track_id` and `run_id`. Jev rank/check/escalate and log operations have their own schemas and need no run coordinate; canonical assignment/plan moments do. Read the mounted action schema instead of adding unrelated fields: unknown keys and invalid action-specific fields are rejected before mutation.

## Jev (System One) — reading moved out of the context

In a saved 84-run baseline, median ORCH peak context was 381,151 tokens. A separate conversation-text estimate (`chars / 4`) attributed 61.5% to tool results and 49.5% of tool-result text to reads; these percentages are not shares of metered peak context.

[TypeSafe Jev](https://docs.typesafe.ai) supplies structured answers to fixed questions so the agent can select candidate files, ranges or claims before reading everything. The agent still checks the selected evidence and owns the decision. Generated role-file bytes, delivered instruction pointers, actual reads and measured context are distinct evidence.

There is no on/off flag. With a credential Jev answers; without one the tool returns a clear error and the hooks
pass the untouched result through.

**Credentials.** `TYPESAFE_API_KEY` (or `JEV_API_KEY`) from the environment, or `NAME=value` in
`<agent-dir>/herdr-delegator/.env` (mode 600, never logged, never echoed in a result).

**Model.** The `jev.model` block value is resolved project layer > user layer > environment (`JEV_MODEL`) > built-in default, and that resolved model is what the MCP tool, the CLI, the host hooks and the judgments attached to server responses all send. An explicit per-call model option still wins where the API exposes one.

**Actions** — the MCP interface above includes intake, plan and log. The existing CLI provides rank, check and the following judge commands; do not assume parity for the added MCP operations:

```sh
bun mcp/jev/cli.ts rank --intent "where the settlement sweep runs" mcp/tools.ts
bun mcp/jev/cli.ts judge --moment authoring --file <run>/a2a/assignments/A-007.md
bun mcp/jev/cli.ts judge --moment settlement --track <id> --run <id> --assignment A-007
bun mcp/jev/cli.ts judge --moment escalate --question "<what you would ask the human>" --context "<what is already decided>"
bun mcp/jev/cli.ts check --sentence "<claim>" --ref docs/SPEC.md
```

**Hooks.** The host is narrowed where the reading happens, and every hook falls back to the untouched result on
any error: a `read` of a file at or above `read_threshold_lines` is revised to the ranked ranges that fit
`read_view_lines`, with the remaining ranges listed as selectors; a `glob` with many hits gets a ranked footer;
a subagent result is capped at `task_result_chars` and pointed at its artifact; any other output at or above
`output_min_lines` keeps its ranked blocks and reports what was withheld.

**Server responses carry the judgment.** What the server already holds is judged where it is held, not by a hook
that would read it again: `herdr_assignment preflight` and `add` attach `data.jev` with the `authoring` table
(three scores, per-condition observability, specification maturity, the profile the questions favor against the
declared one); a `wait` on a terminal assignment and a `herdr_worker inspect` of a lane whose last assignment
settled attach the `settlement` table (per condition a probability and the supporting report paragraph, claims
versus evidence, out-of-ownership change, changed-path counts, next action). Attachments are advisory and never
fail the call: a judgment that cannot run attaches `data.jev.error` instead.

**Calibration log.** Every call appends to `<agent-dir>/herdr-delegator/jev/calibration.jsonl`: a `decision` row
per question (`tool`, `stage`, `question_id`, `question_version`, `model`, probability or score, and an
identifier target such as `A-007:conditions[3]`) and later an `outcome` row for what actually happened
(`opened:path:40-58`, `rewrote_intent`, `accepted`). Rows never carry document text or credentials, so the log
can be read to calibrate thresholds without leaking what was judged.

**What the dogfooding actually showed.** Semantic evidence selection and explicit abstention are the two behaviors that earned their cost in controlled use: a content-chunk judgment that removed a large read, and a no-answer that correctly rejected a false lead. Filename-only ranking ahead of a known authority or a direct symbol lookup did not: in a fixed comparison it missed the authoritative file twice while a deterministic comparator found it, so it is navigation, not content evidence. Composed `found`/complete labels overstated completeness and are read as partial until the actual sources are inspected. A purpose-retrieval wrapper and injecting track criteria into every retrieval were both prototyped and **not adopted**: the criteria arm cost +460/+610 tokens for zero coverage gain, and the wrapper did not beat the deterministic comparator. No total-agent token or time saving is measured or claimed anywhere in this project; costs here are per-call input tokens and visible bytes.

**Define your own moment.** Built-in moments and yours share one shape, declared in the `jev` block:

```json
{
  "jev": {
    "read_threshold_lines": 200,
    "hint_min_p": 0.6,
    "moments": [
      {
        "name": "release_notes",
        "when": { "tool_call": "edit", "path": "CHANGELOG.md" },
        "state": { "file": "CHANGELOG.md" },
        "questions": {
          "entry_observable": {
            "type": "noul",
            "instructions": "The topmost entry in `state.text` names a change a reader could verify in the repository, not an intention."
          }
        }
      }
    ]
  }
}
```

The rules that make a question work — name the target by a backticked state path, concrete criteria, a `none`
option where nothing may fit, never a counterfactual — and the evidence behind them are in
[`skills/build-your-own-jev/SKILL.md`](skills/build-your-own-jev/SKILL.md). What each previously routed skill
became is in [`docs/SKILL-DISPOSITION.md`](docs/SKILL-DISPOSITION.md).

**Re-import.** `mcp/jev/` is generic apart from `judge.ts`, which is the only file that knows this plugin's run
structure. Copying the folder into another project gives you `client`, `chunk`, `questions`, `rank`, `check`,
`log`, and `config` with no import of anything outside the folder — `config.ts` only looks for a `jev` block in a
`herdr-delegator.json` layer, so rename that lookup to your own configuration file when you re-import.

## Safety

The OMP bridge writes a session-scoped, owner-only runtime fact. MCP derives its location from the verified caller pane and active OMP agent directory.

Launch pinning has two gates:

1. bridge facts and Herdr bootstrap metadata exact-match session and pane identity, any reported session path, the session and attestation tokens, nonce, and freshness before prompt — provider, model, and thinking take no part in either pre-prompt verifier;
2. official JSONL exact-matches session identity after the first prompt boundary and before resume; the provider/model, fallback, and thinking it reports are recorded as observations rather than matched against a caller expectation, and a session whose thinking selector resolves on its first turn simply reports no thinking level.

Resume rejects missing, unsafe, mismatched, or credibly duplicated sessions. A wait timeout has no effect and returns a `timed_out` observation. A mutating timeout may have had an effect and must be inspected before retry.

Focus restoration never overrides unrelated user focus. Safe close requires the registry root pane plus only verified Herdr Sidebar panes. Assignment completion is never a close signal.

## Channel boundaries

Communication is uniform across every relationship: a document append carries the authority, and a doorbell carries a pointer to it and nothing else.

| Relationship | Conversations | Document (authority) | Doorbell |
|---|---|---|---|
| user → ORCH | delegate, intervene, stop | mandate, `budget-clamp.json`, `rebirth-approval.json` | direct pane chat |
| ORCH → user | report, decision request | `budget-ledger.md`, `plan.md`, reports | pane-name status marker |
| ORCH → worker | direct, respond, nudge | assignment, `[ORCH Response]` in the lane report | dispatch delivery, `wake_worker` |
| worker → ORCH | completion, blocked, decision request | report append | `wake_orch` |
| worker ↔ worker | adjacent coordination (plan-authorized) | `a2a/w<N>-to-w<M>.md` | `wake_peer` |
| ORCH ↔ ORCH | negotiate, notify, handoff | `a2a/orch-to-<to_track_id>_<to_run_id>.md` | `notify_run` |
| server ↔ auditor | budget audit, emergency post-hoc audit | `budget-audit-<n>.md`, `emergency-audit-<n>.md`, and the ledger verdict | internal spawn; the auditor's own `wake_orch_audit`, once, after its verdict block |
| forbidden | cross-organization worker messaging (escalate instead), ORCH→auditor contact of any kind, any auditor content beyond that one content-free bell, shadow channels | — | — |

- Documents: contract, ownership, decisions, durable results, completion, evidence, budget trail, and handoff.
- MCP prompt/control: canonical coordinates and hashes, waits, lifecycle actions, budget justification, revival.
- Herdr metadata: display-only responsibility, assignment, assignment state, session/model attestation, pane status markers, and live status.

Metadata and terminal output are not contract or settlement authority.

## Development

```sh
bun install
bun run check
```

## Reference

- [Architecture](docs/ARCHITECTURE.md)
- [Configuration schema](config.schema.json)
- [Configuration example](config.example.json)
- [Track creation skill](skills/herdr-create/SKILL.md)
- [Orchestrator skill](skills/herdr-orch/SKILL.md)
- [Build your own Jev judgment](skills/build-your-own-jev/SKILL.md)
- [Skill disposition](docs/SKILL-DISPOSITION.md)
