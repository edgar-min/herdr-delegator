---
name: herdr-config
description: Observe, understand, and modify the herdr-delegator config of the current project. Query which config layers this cwd resolves and which file each effective value comes from, explain which document each field lands in and when, and change it safely through validation and preview. Use when the user asks to "check delegator config", "add a skill route", "edit profile directives", "check orchestrator directives", "why does the ORCH behave this way", or "why does it behave this way".
---

# herdr-config (v0)

This skill covers configuration resolved for the current project. Installation belongs to the README, track creation to herdr-create, and run operation to the packaged ORCH or worker role skill.

## Where — layer observation (the first act is a query, not a document read)

1. Read the layers this cwd actually resolves: `herdr-delegator.json` under `$PI_CODING_AGENT_DIR` when set, otherwise user `~/.omp/agent/herdr-delegator.json` ← project `<repo>/.omp/herdr-delegator.json` ← an optional run layer `<run>/herdr-delegator.json`.
2. Compose the effective config and attribute sources per merge coordinate: `orchestrator` by field, `worker_profiles` by field within each profile name, `skill_routing` and `storage` as whole objects.
3. Merge semantics differ per coordinate: `orchestrator` merges field-wise; `worker_profiles` maps by profile name and merges field-wise within the same name, so fields a later layer does not declare survive and differently named profiles survive; `skill_routing` and `storage` are replaced as whole objects when a later layer declares them.
4. Therefore a project layer declaring `skill_routing` replaces the user layer's entire routing for that cwd. Never assume missing user rules are preserved automatically.
5. Report an absent layer as absent. When a layer fails reading, JSON parsing, or schema validation, report the error verbatim and stop composition, preview, and writes.

## What — fields and where they land

Config supplies advisory content, not the required role contract. It rides inline in the prompt that delivers the installed role skill. Edit config, never its projection:

| config coordinate | lands in | render timing |
| --- | --- | --- |
| `skill_routing.skills.<name>` (`intent`, `trigger`) | the routed skill line's description text | next delivery of that projection |
| `skill_routing.rules` | ORCH rules in the orchestrator's inline advisory block; selected-profile rules in that lane's inline advisory block | ORCH at open·revive; worker at dispatch |
| `orchestrator.directive` | the ORCH advisory `Orchestrator directive` section | at open·revive |
| `worker_profiles.<p>.intent` | the ORCH's profile-selection table, not other workers' execution guidance | at open·revive |
| `worker_profiles.<p>.directive` | that profile's lane advisory section, and no other profile's | at dispatch, including FIFO |
| `orchestrator.role`, `worker_profiles.<p>.role` | role resolution at spawn | next spawn |
| `storage.root` | run storage location `<root>/<track>/<run>` | new tracks onward |

Directive and route text is advisory: it changes no scope, authority, ownership or completion condition; an uninstalled routed skill is a reader-side no-op. Required role instructions are not optional and are never configured: they are the installed packaged role skills. Advisory failure leaves those instructions intact with a warning, while an unresolvable required role skill or profile fails the call before any prompt effect. Delivering a pointer does not mean an already-prompted live session read it.

## How — the two scripts (observe, attribute, edit)

Every procedure below runs from the repository root with `bun`. The scripts import the extension
library directly, so they judge with the same parser and renderer a run uses; never re-implement a
predicate by hand.

| command | answers |
| --- | --- |
| `bun skills/herdr-config/scripts/routes.ts <cwd> [run-path]` | What is in effect and which layer set it? Prints the orchestrator directive, every worker profile's `intent`/`directive`, every effective route with its authored shape, and every per-skill `intent`/`trigger`, each attributed to the layer that declared it. |
| `bun skills/herdr-config/scripts/directive.ts <cwd> --set "<text>" [--layer project\|user] [--apply]` | Validates the directive through the real loader in a throwaway root and previews the ORCH advisory blocks a prompt carries, not a complete role skill. Without `--apply` nothing is written; rejected values retain the parser's `invalid_config` message. |

Common procedure (mandatory before any write):

1. The default edit target is project `<repo>/.omp/herdr-delegator.json`. Observe the user and run layers, but do not write them unless the user explicitly names that layer.
2. Attribute first: run `routes.ts` and read which layer currently sets the coordinate you are about to change. A value you did not author usually comes from the user layer, and editing the project layer will not remove it.
3. Validate and preview before writing. `directive.ts` without `--apply` validates a proposed directive and previews its advisory text. For other coordinates use the real `loadDelegatorConfig` from `io.github.edgar-min.herdr-delegator/extensions/lib/config.ts` in an isolated proposed-config root; an unknown key fails under `assertExactKeys`. The advisory blocks a prompt carries are exactly what `renderGuidance(config)` (ORCH) and `renderWorkerGuidance(config, profile)` (lane) return, and an absent return means that reader's prompt carries no advisory block at all.
4. If approved and clean, write the intended layer, re-load and compare the intended effective change. `directive.ts --apply` performs its directive write/reload/advisory preview. Advice reaches a session at the next ORCH open·revive or worker dispatch. Required role instructions are the installed packaged skills and are never produced by configuration. Do not claim active-session consumption without observing it.

Scenario A — adding a skill route:

1. Litmus first: what characteristic risk of that agent at that moment does this skill compensate? If you cannot answer in one sentence, do not add it (empty slots are design).
2. Check whether the project layer already declares `skill_routing`. Declaring it anew replaces the user layer's routing entirely, so write the complete intended effective rule set inside the object.
3. Author `intent` (why reach for it at this moment) and `trigger` (when) under `skill_routing.skills.<name>`. Do not probe installation state.
4. Wire the rule into `skill_routing.rules`. Two shapes are accepted: the current `{ agent, moment, skills }` — orch moments `plan|authoring|settlement|reset`, worker moments `intake|report` — and the legacy `{ boundary, surface, skills, trigger?, profiles? }`, with boundaries `plan|authoring|dispatch|completion|settlement|reset` and surface `orch|worker`. Authored `intake`/`report` lower to `dispatch`/`completion` scoped to that profile at parse, so both shapes end up in the same effective vocabulary; `routes.ts` prints which shape each rule was authored in. Prefer the current shape for new rules, and keep a rule-level `trigger` or a `profiles` scope in the legacy shape when you need one.
5. Validate, preview, then write per the common procedure.

Scenario B — correcting a profile's intent/directive:

Keep the selection don'ts ("do not assign: …") in `intent` and the execution don'ts plus the named signature failure mode in `directive`. Polish the sentences freely, but preserve those two structures, then validate and write per the common procedure.

Scenario C — setting the orchestrator directive:

The orchestrator profile carries `role`, `thinking`, and `directive`, and nothing else: `intent` and
`guidance` are worker-profile selection criteria and are rejected here. Keep the directive to one
bounded line of execution guidance — how this ORCH should spend its own judgment — never scope,
authority, or a completion condition. Preview with `directive.ts <cwd> --set "<text>"`, read the
rendered section, then repeat with `--apply`. A rejected value prints the parser's own message and
writes nothing.

## Out of scope for v0 (add when needed)

Run-layer override procedure, route removal/audit procedure, storage migration.
