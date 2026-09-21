// bun protocols/inquire/scripts/scan.ts <mandate.json> [keepFrom=1]
// Runs the Jev scan over a structured mandate, applies the verdict to a fresh inquire state, and writes the
// record beside the input as <mandate>.scan-result.json. Prints a table for the human comparison.
import { readFileSync, writeFileSync } from "node:fs";
import { jevScan, passages, type ScanState } from "../adapters/jev-scan.js";
import { applyScan, start } from "../domain/transitions.js";

const [file, keepArg] = process.argv.slice(2);
if (!file) throw new Error("usage: scan.ts <mandate.json> [keepFrom=1]");
const state = JSON.parse(readFileSync(file, "utf8")) as ScanState;
const keepFrom = keepArg ? Number(keepArg) : 1;

const t0 = Date.now();
const run = await jevScan(state, keepFrom);
const elapsed = Date.now() - t0;
const out = file.replace(/\.json$/, "") + ".scan-result.json";
const inquiry = applyScan(start(JSON.stringify(state), file), passages(state), run.verdict);
writeFileSync(out, JSON.stringify({ ...run, elapsed_ms: elapsed, kept_ids: inquiry.uncertainties.map((u) => u.id), converged: inquiry.converged ?? null }, null, 2) + "\n");
console.log(`model=${run.model} elapsed=${elapsed}ms usage=${JSON.stringify(run.usage)} question_version=${run.version}`);

console.log(`P(sufficient)=${run.sufficient.toFixed(3)}  keepFrom=${keepFrom}  kept=${inquiry.uncertainties.length}/${run.passages.length}`);
console.log("id".padEnd(36) + "score  level             probabilities                 conf");
for (const r of run.passages) {
  const ps = ["0", "1", "2", "3"].map((k) => (r.probabilities[k] ?? 0).toFixed(2)).join("/");
  const mark = inquiry.uncertainties.some((u) => u.id === r.id) ? "*" : " ";
  console.log(`${mark}${r.id.padEnd(35)} ${r.score.toFixed(2)}   ${r.level.padEnd(17)} ${ps.padEnd(28)} ${r.confidence.toFixed(2)}`);
}
console.log(`written: ${out}`);
