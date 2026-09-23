---
name: herdr-config
description: Observe, understand, and modify the herdr-delegator config of the current project. Query which config layers this cwd resolves and which file each effective value comes from, explain which spawn each field reaches, and change it safely through validation. Use when the user asks to "check delegator config", "change the ORCH role", "change a worker profile's model or thinking level", "where does the delegator store runs", or "which layer set this value".
---

# herdr-config (v0)

This skill covers only the current project's config. Installation belongs to the README, track operation to herdr-delegation, and design rationale to ARCHITECTURE.

## Where — layer observation (the first act is a query, not a document read)

1. Read the layers this cwd actually resolves: `herdr-delegator.json` under `$PI_CODING_AGENT_DIR` when set, otherwise user `~/.omp/agent/herdr-delegator.json` ← project `<repo>/.omp/herdr-delegator.json` ← an optional run layer `<run>/herdr-delegator.json`.
2. Compose the effective config and attribute sources per merge coordinate: `orchestrator` by field, `worker_profiles` by field within each profile name, `storage` as a whole object.
3. Merge semantics differ per coordinate: `orchestrator` merges field-wise; `worker_profiles` maps by profile name and merges field-wise within the same name, so fields a later layer does not declare survive and differently named profiles survive; `storage` is replaced as a whole object when a later layer declares it.
4. A worker profile name a layer defines for the first time must declare its own `role`; it never inherits another profile's identity, so a misspelled name fails loudly instead of silently running on someone else's model.
5. Report an absent layer as absent. When a layer fails reading, JSON parsing, or schema validation, report the error verbatim and stop composition and writes.

## What — fields and where they land

Config decides how sessions are launched and where runs are stored. It renders no document: a run directory holds `mandate.json`, `run.json` and `a2a/` only, and the rules an ORCH or worker works by live in the role skills `herdr-orch` and `herdr-worker` and in the `herdr://contract` resource.

| config coordinate | lands in | timing |
| --- | --- | --- |
| `orchestrator.role`, `orchestrator.thinking` | the ORCH session's role alias and thinking level | next ORCH spawn (open·revive) |
| `worker_profiles.<p>.role`, `worker_profiles.<p>.thinking` | a lane session's role alias and thinking level | next worker spawn for that profile |
| `storage.root` | run storage location `<root>/<track>/<run>` | new tracks onward |

`role` is an OMP role alias such as `@default`; the born session expands it against its own settings, so a caller's runtime model override never decides a child's model. `thinking` may be `inherit`, in which case the spawn passes no level and the role's own `:level` suffix governs.

A layer may still carry keys this build no longer reads. They are ignored, not rejected: the loader returns one warning naming each retired coordinate and its layer file. Delete the key from the layer when you see the warning.

## How — validate before every write

There is no preview document to render and no script to run: the loader itself is the judgment.

1. The default edit target is project `<repo>/.omp/herdr-delegator.json`. Observe the user and run layers, but do not write them unless the user explicitly names that layer.
2. Attribute first. Import `loadDelegatorConfig` from `io.github.edgar-min.herdr-delegator/extensions/lib/config.ts` and call `loadDelegatorConfig(undefined, cwd)` from the repository root with `bun`. It returns the effective `config`, the `sources` that produced it (scope, canonical path, sha256), and `warnings`. A value you did not author usually comes from the user layer, and editing the project layer will not remove it.
3. Validate the candidate layer by writing it and re-loading: an unknown key fails immediately under `assertExactKeys`, and live runs in the same cwd read this file, so never leave a broken one behind. A rejected value prints the loader's own `invalid_config` message — report it verbatim rather than paraphrasing.
4. Re-load after the write and report the new effective value with its source. An already-open run picks the change up at its next spawn, not retroactively.

Scenario A — changing the ORCH's role or thinking level:

The orchestrator profile carries `role` and `thinking` and nothing else. Change it, re-load, and tell the user the change reaches the ORCH only at the next open or revive — a live ORCH keeps the identity it was born with.

Scenario B — adding or correcting a worker profile:

Declare `role` on any profile name the earlier layers do not already define. Keep the three shipped names (`default`, `task`, `slow`) unless the user asks for another; a profile name is what an assignment's `profile` field selects, so renaming one silently orphans assignments that name the old one.

Scenario C — moving the storage root:

`storage.root` must be an absolute path. A run layer may not relocate its own storage root, and moving the root for a cwd does not move existing runs: the index and the run directories stay where they were written.

## Out of scope for v0 (add when needed)

Run-layer override procedure, storage migration, role catalogue discovery.
