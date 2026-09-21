# Structured mandate authoring

The creator writes the mandate once, as one JSON file, before calling `herdr_track
open`. The JSON is the canonical structured mandate; `orchestrator-instructions.md`
stays what `open` renders. The `open` arguments are derived from the JSON
mechanically, never retyped by hand.

This shape exists because it is measurable: the Phase 0 scan in `protocols/inquire`
reads a mandate in exactly this shape, judges every passage, and reports which ones an
ORCH could not act on without a lookup, an observation, or a decision nobody has made.
The authoring rules below are the ones that scan was calibrated against.

## File

The project working directory is the user's project, so the mandate is not written
there. Write it to a temporary path, call `herdr_track open`, and after `open` returns
`run_path`, copy the file to `<run_path>/inputs/mandate.json`. The `inputs/` directory
is creator/ORCH-owned and already exists as a convention.

## Shape

Exactly these keys, in this order:

```json
{
  "definitions": { "...": "fixed block, copied verbatim from the section below" },
  "mandate": {
    "intent": {
      "background":     ["<fact about the starting situation>"],
      "first_activity": "<the one action performed first>",
      "purpose":        "<why this track exists, one sentence>",
      "work_items":     ["<outcome the track must produce>"],
      "settled":        ["<decision already made; not reopened>"]
    },
    "boundaries": {
      "user":    ["<class of decision or action only the user takes>"],
      "orch":    ["<class of decision the ORCH makes alone>"],
      "workers": ["<delegated execution and its coordination rule>"]
    },
    "constraints": {
      "prohibitions": ["<thing the ORCH must not do>"],
      "procedures":   ["<how work is done: tools, locations, commands, logging, verification>"],
      "invariants":   ["<condition that must stay true throughout>"]
    },
    "shape_of_success": ["<one observable condition>"]
  }
}
```

`protocols/inquire/fixtures/example-mandate.json` is a full example of this shape.

## Rules

Each rule is load-bearing; the scan was calibrated against them.

- **R1** One sentence per array item. Never bundle a prohibition with a procedure or a
  gate in one item. Split at sentence boundaries; do not reword.
- **R2** `shape_of_success`: one observable condition per item. A conditional decision
  ("...or, with a deferral decision, ...") is its own item.
- **R3** `boundaries` name CLASSES of decisions ("rule wording changes are the user's
  decision"). The specific matters currently open in this track go in
  `intent.work_items` and only there. Do not restate an open matter as a boundary.
- **R4** `constraints.invariants` state the duty to keep a condition true ("keep exit 0
  throughout"). The claim that it is true NOW belongs in `intent.background` with its
  source; the re-check cadence belongs in `constraints.procedures`.
- **R5** Everything in `constraints` and `boundaries` is an obligation or an authority
  assignment, never a task: complying needs no plan step, no lookup, no decision now.
- **R6** Empty arrays are allowed (e.g. `settled: []` for a first track). Keys are
  never omitted.
- **R7** Budget, cwd, track ids, `reset_of`, lineage, and handoff contents are NOT in
  this file; they were measured as noise, or they belong to the Ctx stage.

## `definitions` block (fixed, verbatim)

Copy this block byte-for-byte. It is the same text as `definitions` in
`protocols/inquire/fixtures/example-mandate.json`, which is authoritative if the two
ever differ.

```json
{
  "mandate.boundaries": "Who holds which authority during the track. A boundary assigns a class of decisions or actions to an actor; it is applied when such a decision actually arises. A boundary is not an open decision: reading it requires no lookup and leaves nothing to decide now. A boundary names a class of decisions; the specific matters currently open in this track are listed in intent.work_items, and only there.",
  "mandate.boundaries.user": "Decisions and actions only the user may take. When one arises, the ORCH routes it to the user and waits; until then the ORCH proceeds with everything else.",
  "mandate.boundaries.orch": "Decisions the ORCH makes on its own from the plan, the mandate, and evidence, and records.",
  "mandate.boundaries.workers": "Execution delegated to workers and the coordination rules that delegation carries.",
  "mandate.constraints": "Obligations the ORCH complies with while working, grouped by kind. None of them is a task: complying needs no plan step, no lookup, and no decision now.",
  "mandate.constraints.prohibitions": "Things the ORCH must not do. Complying is refraining; nothing has to be read, checked, or decided.",
  "mandate.constraints.procedures": "How work is done: tools, locations, commands, logging, verification steps. A procedure that names a document or command tells the ORCH what to use, not what to look up before it may comply.",
  "mandate.constraints.invariants": "Conditions that must stay true throughout the track. An invariant states the duty to keep the condition true; whether it is true now is a fact carried by intent.background or verified by intent.first_activity, not by this item.",
  "mandate.shape_of_success": "Observable conditions that make the track done. Judging one as met may require reading named sources, observing results, or a user decision the mandate explicitly reserves; that reserved decision is a dependency of the outcome, not of the ORCH's next action. Each item states one condition.",
  "lookup_named (level 1)": "The ORCH must read material the mandate names before acting, and that material settles the matter.",
  "facts_unnamed (level 2)": "The ORCH must search or observe for facts the mandate neither states nor names a source for.",
  "decision_missing (level 3)": "Nothing the ORCH can read or observe settles the passage; someone must choose."
}
```

## Flattening into `herdr_track open`

The `open` tool schema is unchanged. Derive its `mandate` argument from the JSON
deterministically:

- `mandate.intent` (string) = join with a single space, in order: `background[*]`,
  `first_activity`, `purpose`, `work_items[*]`, `settled[*]`.
- `mandate.constraints` (string[]) = `boundaries.user[*]`, `boundaries.orch[*]`,
  `boundaries.workers[*]`, `constraints.prohibitions[*]`, `constraints.procedures[*]`,
  `constraints.invariants[*]`, in that order.
- `mandate.shape_of_success` (string[]) = `shape_of_success[*]`.

Never do this by hand:

```
bun protocols/inquire/scripts/mandate-to-open.ts <mandate.json>
```

It prints the `mandate` object for the `open` call as JSON and exits non-zero naming
the offending limit if the result would be rejected. The limits `open` enforces
(`mcp/contracts.ts`, applied in `mcp/tools.ts`) are:

- `MAX_MANDATE_ITEMS` = 32 entries, counted per field: the flattened `constraints` and
  `shape_of_success` each have their own ceiling.
- `MAX_MANDATE_INTENT` = 4096 characters for the joined intent.
- `MAX_MANDATE_BYTES` = 16384 bytes, measured by the server on the RENDERED mandate
  document, so the script adds the template and coordinate overhead before comparing.
- `MAX_MANDATE_ITEM` = 500 characters per entry, enforced by the server; the script
  does not check it.

Budget stays out of the JSON (R7) and is passed to `open` separately.
