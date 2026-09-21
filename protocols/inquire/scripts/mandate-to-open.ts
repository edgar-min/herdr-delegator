// bun protocols/inquire/scripts/mandate-to-open.ts <mandate.json>
// Flattens a structured mandate (skills/herdr-delegation/references/mandate-authoring.md) into the `mandate`
// object `herdr_track open` takes, deterministically and in the fixed order, so nobody does it by hand.
// Exits non-zero naming the offending server limit when the flattened result would be rejected at open.
import { readFileSync } from "node:fs";

/** The limits `herdr_track open` enforces (mcp/contracts.ts, applied in mcp/tools.ts). */
const MAX_MANDATE_INTENT = 4_096;
const MAX_MANDATE_ITEMS = 32;
const MAX_MANDATE_BYTES = 16_384;
/** `open` measures MAX_MANDATE_BYTES on the RENDERED mandate document, not on this payload: 1057 bytes of fixed
 * template (measured against renderMandate with an undeclared budget, which renders the longest budget section)
 * plus the track_id and run_id, each at most 64 characters and each rendered twice. Worst case, so the script
 * refuses slightly earlier than the server rather than later. */
const RENDER_OVERHEAD_BYTES = 1_057 + 4 * 64;

type Mandate = {
  mandate: {
    intent: { background: string[]; first_activity: string; purpose: string; work_items: string[]; settled: string[] };
    boundaries: { user: string[]; orch: string[]; workers: string[] };
    constraints: { prohibitions: string[]; procedures: string[]; invariants: string[] };
    shape_of_success: string[];
  };
};

const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: mandate-to-open.ts <mandate.json>");
const doc = JSON.parse(readFileSync(file, "utf8")) as Mandate;
const m = doc.mandate;
if (!m) throw new Error(`${file} has no \`mandate\` key`);

const missing: string[] = [];
const strings = (value: unknown, path: string): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  missing.push(path);
  return [];
};

const intentParts = [
  ...strings(m.intent?.background, "intent.background"),
  ...strings(m.intent?.first_activity, "intent.first_activity"),
  ...strings(m.intent?.purpose, "intent.purpose"),
  ...strings(m.intent?.work_items, "intent.work_items"),
  ...strings(m.intent?.settled, "intent.settled"),
];
const constraints = [
  ...strings(m.boundaries?.user, "boundaries.user"),
  ...strings(m.boundaries?.orch, "boundaries.orch"),
  ...strings(m.boundaries?.workers, "boundaries.workers"),
  ...strings(m.constraints?.prohibitions, "constraints.prohibitions"),
  ...strings(m.constraints?.procedures, "constraints.procedures"),
  ...strings(m.constraints?.invariants, "constraints.invariants"),
];
const shape_of_success = strings(m.shape_of_success, "shape_of_success");
if (missing.length > 0) {
  console.error(`${file}: missing or non-string keys (every key is required; empty arrays are allowed): ${missing.join(", ")}`);
  process.exit(2);
}

const intent = intentParts.join(" ");
const open = { intent, constraints, shape_of_success };

const violations: string[] = [];
if (intent.length > MAX_MANDATE_INTENT) violations.push(`MAX_MANDATE_INTENT: intent is ${intent.length} characters, limit ${MAX_MANDATE_INTENT}`);
if (constraints.length > MAX_MANDATE_ITEMS) violations.push(`MAX_MANDATE_ITEMS: constraints has ${constraints.length} entries, limit ${MAX_MANDATE_ITEMS}`);
if (shape_of_success.length > MAX_MANDATE_ITEMS) violations.push(`MAX_MANDATE_ITEMS: shape_of_success has ${shape_of_success.length} entries, limit ${MAX_MANDATE_ITEMS}`);
const rendered = RENDER_OVERHEAD_BYTES + Buffer.byteLength(intent) + [...constraints, ...shape_of_success].reduce((sum, item) => sum + Buffer.byteLength(`- ${item}\n`), 0);
if (rendered > MAX_MANDATE_BYTES) violations.push(`MAX_MANDATE_BYTES: the rendered mandate would be about ${rendered} bytes, limit ${MAX_MANDATE_BYTES}`);
if (violations.length > 0) {
  for (const v of violations) console.error(`${file}: ${v}`);
  process.exit(1);
}

console.log(JSON.stringify(open, null, 2));
