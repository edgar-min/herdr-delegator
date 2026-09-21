// bun protocols/inquire/scripts/scan-experiment.ts <scan-state.json> [keepFrom] [strategy]
// Runs the Jev scan over a fixed state, applies the verdict to a fresh inquire state, and writes the record
// beside the fixture as <name>.<strategy>.scan-result.json. Prints a table for the human comparison.
import { readFileSync, writeFileSync } from "node:fs";
import { jevScan, passages, type ScanState, type Strategy } from "../adapters/jev-scan.js";
import { applyScan, start } from "../domain/transitions.js";

const [file, keepArg, strategyArg, domainsArg, sliceArg] = process.argv.slice(2);
if (!file) throw new Error("usage: scan-experiment.ts <scan-state.json> [keepFrom] [strategy] [domains,csv] [slice]");
const full = JSON.parse(readFileSync(file, "utf8")) as ScanState;
const keepFrom = keepArg ? Number(keepArg) : 1;
const strategy = (strategyArg ?? "score") as Strategy;
const domains = domainsArg ? domainsArg.split(",") : undefined;
/** slice: keep only the targeted mandate domains and the definitions that speak about them (plus level definitions). */
function sliced(state: ScanState): ScanState {
  if (!domains || sliceArg !== "slice") return state;
  const mandate = Object.fromEntries(Object.entries(state.mandate as Record<string, unknown>).filter(([k]) => domains.includes(k)));
  const defs = Object.fromEntries(Object.entries((state.definitions as Record<string, string>) ?? {}).filter(([k]) => k.includes("level") || domains.some((d) => k === `mandate.${d}` || k.startsWith(`mandate.${d}.`))));
  return { definitions: defs, mandate };
}
const state = sliced(full);
const tag = (domains ? `.${domains.join("+")}` : "") + (sliceArg === "slice" ? ".slice" : "");

const t0 = Date.now();
const run = await jevScan(state, keepFrom, { strategy, domains });
const elapsed = Date.now() - t0;
const out = file.replace(/\.scan-state\.json$/, "") + (strategy === "score" ? "" : `.${strategy}`) + tag + ".scan-result.json";
const inquiry = applyScan(start(JSON.stringify(state), file), passages(state), run.verdict);
writeFileSync(out, JSON.stringify({ ...run, elapsed_ms: elapsed, kept_ids: inquiry.uncertainties.map((u) => u.id), converged: inquiry.converged ?? null }, null, 2) + "\n");
console.log(`strategy=${strategy} model=${run.model} elapsed=${elapsed}ms usage=${JSON.stringify(run.usage)} question_version=${run.version}`);

console.log(`P(sufficient)=${run.sufficient.toFixed(3)}  keepFrom=${keepFrom}  kept=${inquiry.uncertainties.length}/${run.passages.length}`);
console.log("id".padEnd(36) + "score  level             probabilities                 conf");
for (const r of run.passages) {
  const ps = strategy === "nouls"
    ? `L${r.probabilities.lookup.toFixed(2)} F${r.probabilities.fact.toFixed(2)} D${r.probabilities.decision.toFixed(2)}`
    : ["0", "1", "2", "3"].map((k) => (r.probabilities[k] ?? 0).toFixed(2)).join("/");
  const mark = inquiry.uncertainties.some((u) => u.id === r.id) ? "*" : " ";
  console.log(`${mark}${r.id.padEnd(35)} ${r.score.toFixed(2)}   ${r.level.padEnd(17)} ${ps.padEnd(28)} ${r.confidence.toFixed(2)}`);
}
console.log(`written: ${out}`);
