// bun protocols/inquire/scripts/scan-compare.ts <scan-result.json> [path-map.json]
// Scores a Jev scan result against the frozen slow∩default baseline (23 agreed passages). A path map translates
// result paths (v3 shapes) to baseline paths (v2 shape); without one, paths are compared as-is.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [resultFile, mapFile] = process.argv.slice(2);
if (!resultFile) throw new Error("usage: scan-compare.ts <scan-result.json> [path-map.json]");
const result = JSON.parse(readFileSync(resultFile, "utf8")) as { passages: { id: string; level: string; probabilities: Record<string, number>; confidence: number }[]; sufficient: number };
const baseline = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/hexddd-rules-8.baseline.json"), "utf8")) as { levels: string[]; sufficient: boolean; agreed: Record<string, number> };
const map: Record<string, string> = mapFile ? JSON.parse(readFileSync(mapFile, "utf8")) : {};

let hit = 0, n = 0, hitConfident = 0, nConfident = 0, offByOne = 0;
const rows: string[] = [];
for (const p of result.passages) {
  const key = map[p.id] ?? p.id;
  if (!(key in baseline.agreed)) continue;
  n++;
  const want = baseline.agreed[key];
  const got = baseline.levels.indexOf(p.level);
  const ok = got === want;
  if (ok) hit++;
  if (Math.abs(got - want) === 1) offByOne++;
  if (p.confidence >= 0.35) { nConfident++; if (ok) hitConfident++; }
  const pWant = p.probabilities[String(want)] ?? 0;
  rows.push(`${ok ? " " : "x"} ${p.id.padEnd(34)} want=${want} got=${got} p(want)=${pWant.toFixed(2)} conf=${p.confidence.toFixed(2)}`);
}
console.log(rows.join("\n"));
console.log(`\nagreement: ${hit}/${n}  (off-by-one: ${offByOne})   confident(>=0.35): ${hitConfident}/${nConfident}   sufficient: P=${result.sufficient.toFixed(2)} baseline=${baseline.sufficient}`);
