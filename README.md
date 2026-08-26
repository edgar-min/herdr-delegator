# herdr-delegator

`herdr-delegator` is an OMP extension and skill for running substantial, independent work in persistent Herdr worker tabs. It gives an OMP planning session (the **ORCH**) deterministic run storage, explicit worker ownership, model-verified routing, prompt deduplication, resumable sessions, blocked-state handling, and guarded closure.

It does **not** replace the ORCH's planning or review judgment, choose workers automatically, manage ordinary OMP task/subagents, provide a general process supervisor, close a Herdr workspace, or make shared-directory concurrent edits safe. The run files are the audit record; Herdr transports prompts and live state.

- Package/plugin: `herdr-delegator` 0.4.0
- Skill: `herdr-delegation` 3.0.0
- Public tools: `herdr_track`, `herdr_worker`
- License: Apache-2.0

## Prerequisites

1. A current [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) installation.
2. [Herdr](https://github.com/edgar-min/herdr) installed and available to OMP.
3. The official Herdr integration installed for OMP:

```sh
herdr integration install omp
```

The extension must run inside a Herdr-owned pane. Launch operations fail closed when Herdr, the current pane, configuration, run identity, role, model, session, or ownership cannot be proved.

## Installation

### From GitHub

Install the published GitHub repository with:

```sh
omp plugin install https://github.com/edgar-min/herdr-delegator
```

This command was release-validated against OMP 18.0.5: the installed artifact loaded skill `herdr-delegation` 3.0.0, registered both tools, and completed an idempotent deterministic run initialization.

### Local development link

From the repository root:

```sh
bun install
omp plugin link .
```

A local path passed to `omp plugin install .` is also linked by current OMP, but `plugin link` states the development intent explicitly.

Restart or reload OMP as required by the current OMP plugin workflow so it discovers the extension and bundled skill.

## Configuration

At least one user or project configuration file named `herdr-delegator.json` must set an absolute `storage.root`:

- User: `${PI_CODING_AGENT_DIR}/herdr-delegator.json`
- User fallback when that variable is unset: `~/.omp/agent/herdr-delegator.json`
- Project: `<project>/.omp/herdr-delegator.json`

Project values override user values. An optional run-local `<resolved-run>/herdr-delegator.json` may override model-profile leaves, but cannot relocate that run's storage root.

```json
{
  "version": 1,
  "storage": {
    "root": "/absolute/path/to/herdr-runs"
  },
  "orchestrator": {
    "role": "@plan",
    "thinking": "inherit"
  },
  "worker_profiles": {
    "default": {
      "role": "@default",
      "thinking": "inherit"
    },
    "slow": {
      "role": "@slow",
      "thinking": "inherit"
    }
  }
}
```

`@plan` is fixed for the ORCH. Every `ensure_worker` call must name an existing profile explicitly; there is no implicit worker fallback. Configuration accepts OMP role aliases, not concrete model IDs. See [`config.schema.json`](config.schema.json) and [`config.example.json`](config.example.json).

## Start

Open an OMP session under role `@plan`, then invoke:

```text
/skill:herdr-delegation
```

The ORCH decides routing, initializes a run, writes the condition-bearing plan and worker instructions, launches workers, verifies their results, and performs recovery and closure.

### Deterministic run identity

A run is identified by the pair `(track_id, run_id)`. Both are lowercase coordinates matching:

```text
^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$
```

`herdr_track.init_run` resolves the configured location `<storage.root>/<track_id>/<run_id>` and creates or reconciles only the tool-owned initialization set:

```text
<storage.root>/
  index.json
  <track_id>/<run_id>/
    run.json
    protocol.md
    a2a/
```

For a sibling reset, it also copies the source `plan.md` byte-for-byte and writes `reset.json`. The ORCH, not the tool, authors work-specific files such as `plan.md`, `evidence.md`, `orchestrator-instructions.md`, `orchestrator-report.md`, worker instructions, reports, and declared peer channels. The tool owns `index.json`, `a2a/herdr-workers.json`, and its lock files; never edit them manually.

## Routing work

Use OMP task/subagents for bounded, mechanical, or light work. They create no Herdr workspace, worker tab, registry record, or deterministic `a2a` worker file set, and this plugin does not select or verify their models.

Use a persistent Herdr worker when a substantial independent slice needs durable context, explicit file ownership, exact-session resume, blocked-state handling, or peer coordination. Worker tabs share the configured project working directory. Parallel workers therefore require disjoint write ownership; serialize overlapping edits.

## Lifecycle

The safe worker sequence is:

1. `ensure_worker` with track/run/worker IDs, canonical project `cwd`, and an explicit profile.
2. If the result indicates resume, reconciliation, or ambiguity, `inspect_worker` before prompting.
3. `prompt_wait` with the exact deterministic worker instruction path.
4. `inspect_worker` after the wait and before judgment, recovery, response, or close.
5. `resolve_block` only against the freshly observed blocked `state_change_seq` and only when the ORCH has a grounded non-user answer.
6. `close_worker` only after a fresh inspection proves a settled state and safe ownership/topology.

Prompt fingerprints prevent duplicate delivery. A timeout may have had an effect: inspect first, continue from a proved effect, and retry only after proving absence. Resume uses only the registry-recorded official OMP session and refuses missing, corrupt, duplicated, or ambiguous sessions.
Launch pinning precedes a two-stage session gate. The calling OMP process first resolves the configured role to the exact concrete provider/model and effective thinking, then launches the child with those captured values so role aliases cannot drift across processes. At the pre-prompt gate, the child extension reports session-bound in-process bootstrap attestation through Herdr pane metadata—official session ID/reported path, provider/model, thinking, nonce, and timestamp—and the controller proves the target pane/session and exact fact match.

At the persisted gate, the reported session path may exist before its JSONL file and cannot yet be resumed. After the first prompt boundary, persisted JSONL must match the bootstrap/session/model/thinking/fallback facts before success or resume. Attestation or report failure is fail-closed; the controller never sends a synthetic prompt merely to create JSONL.

Use `resolve_block` text only for free-form text input. For an interactive option dialog, inspect it and use bounded allowlisted keys, such as `enter` for a preauthorized recommended selection. A response that leaves state and sequence unchanged is a no-effect observation, not permission to replay blindly.

A target ORCH recovered after an ambiguous first return may keep `prompt_state: prompting` permanently as its never-replay fingerprint. It does not need to be rewritten to `prompted`; `verified_at` plus persisted fallback/model facts establishes persisted verification and settled state.

Focus restoration is guarded. Automation restores only focus displaced onto registry-owned coordinates and does not override focus that moved elsewhere. `partial` restoration is a warning to record, not evidence that the operation failed.

A worker tab can close only when it contains the exact registry-owned root pane plus optional verified Herdr Sidebar panes. A Sidebar must share the owned workspace/tab and canonical run `cwd`, have the exact `Sidebar` label, expose no agent/session evidence, and carry only `herdr-sidebar-` token keys. Mixed, extra, or unproved panes fail closed. After close, `inspect_worker` may return `agent_not_found`; the registry's `closed` record is authoritative and the retained run anchor remains. No public operation closes the retained workspace.

A sibling reset creates a different track/run coordinate, preserves active or unsafe source workers, closes only freshly inspected safe settled workers, and requires old evidence to be revalidated before import.

## Security boundaries

- Run coordinates, canonical paths, configuration sources, and registry ownership are verified before mutation.
- Configuration and manifests use strict schemas; malformed or unreadable layers are not ignored or rewritten.
- Configuration selects roles; the caller resolves each role and pins the exact concrete provider/model plus effective thinking into the child launch.
- Pre-prompt pane-bound bootstrap attestation and post-prompt persisted JSONL verification prove official session, model, thinking, and fallback identity. A reported path alone is not resume authority.
- Instructions are constrained to the initialized run and expected worker filename.
- Registry and index writes are atomic and lock-guarded; their files are tool authority.
- Prompt, response, and close operations treat timeouts as potentially ambiguous effects.
- Tool outputs are bounded observations; reports and independently reproduced checks are the review record.
- Do not put secrets, credentials, tokens, personal data, or private source excerpts in plans, instructions, reports, peer channels, or tool responses. The plugin does not provide secret storage or redaction.

## Development

```sh
bun install
bun run check
```

## Reference

- [Architecture](docs/ARCHITECTURE.md)
- [Normative specification and review checklist](docs/SPEC.md)
- [Configuration schema](config.schema.json)
- [Run manifest schema](run.schema.json)
- [Reset schema](reset.schema.json)
- [Configuration example](config.example.json)
- [Reset example](reset.example.json)
- [Delegation skill](skills/herdr-delegation/SKILL.md)
