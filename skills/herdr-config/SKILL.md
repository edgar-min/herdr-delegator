---
name: herdr-config
description: Observe, understand, and modify the herdr-delegator config of the current project. Query which config layers this cwd resolves and which file each effective value comes from, explain which document each field lands in and when, and change it safely through validation and preview. Use when the user asks to "check delegator config", "add a skill route", "edit profile directives", or "why does it behave this way".
---

# herdr-config (v0)

This skill covers only the current project's config. Installation belongs to the README, track operation to herdr-delegation, and design rationale to ARCHITECTURE.

## Where — layer observation (the first act is a query, not a document read)

1. Read the layers this cwd actually resolves: `herdr-delegator.json` under `$PI_CODING_AGENT_DIR` when set, otherwise user `~/.omp/agent/herdr-delegator.json` ← project `<repo>/.omp/herdr-delegator.json` ← an optional run layer `<run>/herdr-delegator.json`.
2. Compose the effective config and attribute sources per merge coordinate: `orchestrator` by field, `worker_profiles` by field within each profile name, `skill_routing` and `storage` as whole objects.
3. Merge semantics differ per coordinate: `orchestrator` merges field-wise; `worker_profiles` maps by profile name and merges field-wise within the same name, so fields a later layer does not declare survive and differently named profiles survive; `skill_routing` and `storage` are replaced as whole objects when a later layer declares them.
4. Therefore a project layer declaring `skill_routing` replaces the user layer's entire routing for that cwd. Never assume missing user rules are preserved automatically.
5. Report an absent layer as absent. When a layer fails reading, JSON parsing, or schema validation, report the error verbatim and stop composition, preview, and writes.

## What — fields and where they land

Config is the source of the advisory documents; documents are projections of config. The edit target is always config. Which field changes what:

| config coordinate | lands in | render timing |
| --- | --- | --- |
| `skill_routing.skills.<name>` (`intent`, `trigger`) | the routed skill line's description text | next render of that document |
| `skill_routing.rules` (`agent` × `moment`) | orch rules → the run's `guidance.md` / profile rules → `guidance-<profile>.md` | orch document at open·revive / profile document designed at dispatch; delivery pending until the sibling run's `tools.ts` change lands |
| `worker_profiles.<p>.intent` | the profile selection table in `guidance.md` (read by the ORCH only) | at open·revive |
| `worker_profiles.<p>.directive` | the directive section of `guidance-<p>.md` (read by that profile's workers only) | designed at dispatch; delivery pending until the sibling run's `tools.ts` change lands |
| `orchestrator.role`, `worker_profiles.<p>.role` | role resolution at spawn | next spawn |
| `storage.root` | run storage location `<root>/<track>/<run>` | new tracks onward |

All of it is advisory: scope, authority, ownership, and completion conditions never change; an uninstalled skill is a reader-side no-op; a missing document is simply absent.

## How — validate, preview, write

Common procedure (mandatory before any write):

1. The default edit target is project `<repo>/.omp/herdr-delegator.json`. Observe the user and run layers, but do not write them unless the user explicitly names that layer.
2. Schema validation: import `loadDelegatorConfig` from the repo's `io.github.edgar-min.herdr-delegator/extensions/lib/config.ts` and call `loadDelegatorConfig(undefined, cwd)` directly to confirm the target layer parses with zero errors. The `undefined` first argument means only the user and project layers are read, without a run layer. Under the `assertExactKeys` contract an unknown key fails immediately, and live runs in the same cwd read this file — never write a broken one.
3. Render preview: import `renderGuidanceDocument` and `renderWorkerGuidanceDocument` from the repo's `io.github.edgar-min.herdr-delegator/extensions/lib/guidance.ts`, then call `renderGuidanceDocument(config)` and `renderWorkerGuidanceDocument(config, profile)` for each profile in `Object.keys(config.worker_profiles)` and confirm the output matches intent.
4. If clean, write the project file and call `loadDelegatorConfig(undefined, cwd)` again directly. Already-open runs pick the change up at the next open·revive (orch document) and dispatch (profile documents), noting that profile-document delivery at dispatch operates only after the corresponding `tools.ts` change lands.

Scenario A — adding a skill route:

1. Litmus first: what characteristic risk of that agent at that moment does this skill compensate? If you cannot answer in one sentence, do not add it (empty slots are design).
2. Check whether the project layer already declares `skill_routing`. Declaring it anew replaces the user layer's routing entirely, so write the complete intended effective rule set inside the object.
3. Author `intent` (why reach for it at this moment) and `trigger` (when) under `skill_routing.skills.<name>`. Do not probe installation state.
4. Wire `{ agent, moment, skills }` into `skill_routing.rules`. Moments: orch = `plan|authoring|settlement|reset`, worker = `intake|report`.
5. Validate, preview, then write per the common procedure.

Scenario B — correcting a profile's intent/directive:

Keep the selection don'ts ("do not assign: …") in `intent` and the execution don'ts plus the named signature failure mode in `directive`. Polish the sentences freely, but preserve those two structures, then validate and write per the common procedure.

## Out of scope for v0 (add when needed)

Run-layer override procedure, route removal/audit procedure, storage migration.
