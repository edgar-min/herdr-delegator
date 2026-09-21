# inquire — Phase 0 scan over a structured mandate

The scan reads a structured mandate (the JSON shape in
`skills/herdr-delegation/references/mandate-authoring.md`), asks one judgment per
passage, and reports which passages an ORCH could not act on from the mandate alone.
Each passage is placed on four ordered levels: `self_contained`, `lookup_named`,
`facts_unnamed`, `decision_missing`. Passages at or above `keepFrom` (default 1)
become the inquiry's uncertainties; when nothing is kept, the run converges with the
sufficiency reasoning instead.

Nothing here is wired into the MCP server, the OMP extension, or packaging: it is a
protocol workbench the creator runs by hand, and `protocols/` is deliberately outside
`tsconfig.json` and the published `files` list. `adapters/jev-client.ts` is a local
copy of the Jev client for exactly that reason — this directory imports nothing from
`mcp/`.

## Run it

```
bun protocols/inquire/scripts/scan.ts <mandate.json> [keepFrom=1]
bun protocols/inquire/scripts/mandate-to-open.ts <mandate.json>
```

`scan.ts` prints the per-passage table and writes `<mandate>.scan-result.json` beside
the input. It needs a Jev API key in `TYPESAFE_API_KEY` or `JEV_API_KEY`, in the
environment or in `<agent dir>/herdr-delegator/.env`. `mandate-to-open.ts` prints the
flattened `mandate` object for `herdr_track open`.

```
bun test protocols/inquire
npx tsc --noEmit --strict --target ESNext --module ESNext --moduleResolution Bundler --types bun --skipLibCheck protocols/inquire/**/*.ts
```

## Question version

`2026-09-21.3` — the approved `choice` strategy: one sufficiency noul over the whole
mandate, plus one four-option choice per passage, each framed with the verb its domain
takes (carry out / comply with / judge as met). The score, noul, and tie-break
variants the strategy was selected against are not ported here.

## Measured reproduction

On `fixtures/example-mandate.json` (53 passages) against the ORCH-adjudicated
reference in `fixtures/example-reference.json`, the selected strategy reproduced 47–48
of 53 exact levels. The judgment is not deterministic: a later run of the same
question set on the same fixture scored 45/53 exact and 48/53 on the coarser
keep-or-not decision, so treat the figure as a band, not a fixed point.
