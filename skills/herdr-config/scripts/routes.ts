/**
 * Provenance report for the advisory surface of the effective configuration.
 *
 * "Why does the ORCH behave this way" is a provenance question: the effective
 * value is one thing, the layer that set it is another, and only the second one
 * tells you which file to edit. The effective side comes from the real loader;
 * the attribution side re-reads each consumed layer and reports the last layer
 * that declared each coordinate, following the merge semantics — `orchestrator`
 * and `worker_profiles` merge field-wise, `skill_routing` is replaced whole.
 *
 *   bun skills/herdr-config/scripts/routes.ts <cwd> [run-path]
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadDelegatorConfig } from "../../../io.github.edgar-min.herdr-delegator/extensions/lib/config";
import type { ConfigSource } from "../../../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";

const ABSENT = "absent";
const NONE = "—";

/**
 * A rule as authored, before parse-time lowering: exactly one of the two shapes
 * is present, which is how this report names the shape the author wrote.
 */
type AuthoredRule = {
  agent?: string;
  moment?: string;
  boundary?: string;
  surface?: string;
  skills?: string[];
  trigger?: string;
  profiles?: string[];
};

/**
 * A layer as authored. Every layer named in `sources` was already consumed by
 * `loadDelegatorConfig`, so it has passed the strict layer parser: this shape is
 * the loader's invariant, not a second validation of the same bytes.
 */
type AuthoredLayer = {
  orchestrator?: { role?: string; thinking?: string; directive?: string };
  worker_profiles?: Record<string, { role?: string; thinking?: string; guidance?: string; intent?: string; directive?: string }>;
  skill_routing?: { rules?: AuthoredRule[]; skills?: Record<string, { intent?: string; trigger?: string }> };
};

type RawLayer = { scope: ConfigSource["scope"]; value: AuthoredLayer };

/** The layer that decided a coordinate: the last consumed layer that declared it. */
function declaredBy(layers: readonly RawLayer[], pick: (layer: AuthoredLayer) => unknown): RawLayer | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer && pick(layer.value) !== undefined) return layer;
  }
  return undefined;
}

const cwd = process.argv[2];
const runPath = process.argv[3];
if (!cwd || cwd.startsWith("-")) {
  console.error("usage: bun skills/herdr-config/scripts/routes.ts <cwd> [run-path]");
  process.exit(2);
}

const { config, sources } = await loadDelegatorConfig(runPath, path.resolve(cwd));

const layers: RawLayer[] = [];
for (const source of sources) {
  // Guaranteed to parse: the loader read and validated these exact bytes.
  layers.push({ scope: source.scope, value: JSON.parse(await readFile(source.path, "utf8")) as AuthoredLayer });
}

console.log(`Layers consumed: ${sources.length ? sources.map((source) => source.scope).join(" <- ") : "none (built-in defaults only)"}`);
console.log("");

console.log("## orchestrator");
console.log("");
console.log("| field | value | layer |");
console.log("| --- | --- | --- |");
const directiveLayer = declaredBy(layers, (layer) => layer.orchestrator?.directive);
console.log(`| directive | ${config.orchestrator.directive ?? ABSENT} | ${directiveLayer?.scope ?? NONE} |`);
console.log("");

console.log("## worker profiles");
console.log("");
console.log("| profile | field | value | layer |");
console.log("| --- | --- | --- | --- |");
for (const [name, profile] of Object.entries(config.worker_profiles)) {
  for (const field of ["intent", "directive"] as const) {
    const layer = declaredBy(layers, (raw) => raw.worker_profiles?.[name]?.[field]);
    console.log(`| \`${name}\` | ${field} | ${profile[field] ?? ABSENT} | ${layer?.scope ?? NONE} |`);
  }
}
console.log("");

const routingLayer = declaredBy(layers, (layer) => layer.skill_routing);
const authoredRules = routingLayer?.value.skill_routing?.rules ?? [];
const routingScope = routingLayer?.scope ?? NONE;

console.log("## skill_routing.rules");
console.log("");
console.log("| # | layer | shape | boundary | surface | profiles | trigger | skills |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
const rules = config.skill_routing?.rules ?? [];
if (!rules.length) console.log(`| ${NONE} | ${routingScope} | ${NONE} | ${NONE} | ${NONE} | ${NONE} | ${NONE} | ${NONE} |`);
for (const [index, rule] of rules.entries()) {
  const shape = authoredRules[index]?.agent === undefined ? "legacy boundary/surface" : "agent/moment";
  console.log(
    `| ${index} | ${routingScope} | ${shape} | ${rule.boundary} | ${rule.surface} | ${rule.profiles?.join(", ") ?? NONE} | ${rule.trigger ?? NONE} | ${rule.skills.join(", ")} |`,
  );
}
console.log("");

console.log("## skill_routing.skills");
console.log("");
console.log("| skill | intent | trigger | layer |");
console.log("| --- | --- | --- | --- |");
const metadata = Object.entries(config.skill_routing?.skills ?? {});
if (!metadata.length) console.log(`| ${NONE} | ${NONE} | ${NONE} | ${routingScope} |`);
for (const [name, entry] of metadata) {
  console.log(`| \`${name}\` | ${entry.intent ?? ABSENT} | ${entry.trigger ?? ABSENT} | ${routingScope} |`);
}
