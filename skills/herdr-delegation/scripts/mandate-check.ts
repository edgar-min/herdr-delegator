// bun skills/herdr-delegation/scripts/mandate-check.ts <mandate.json> [--upstream <UPSTREAM.json>] [--cwd <project dir>]
//
// The deterministic half of the mandate check: everything about a mandate that
// can be decided without a judge. It validates the document against
// references/mandate.schema.json, refuses an entry protocol this package does
// not pin, enforces the structural conjuncts of the routing gates, and flags
// judged units that break the one-unit rule the schema states in prose.
//
// Every check prints one `ok <rule>: <detail>` or `FAIL <rule>: <detail>` line
// and any FAIL exits 1, so it is usable both by a creator reading the output and
// by a script reading the exit code. The semantic/routing check that asks a
// judge the same question lives behind `semanticChecks()` and is not installed.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = path.resolve(SKILL_DIR, "../..");
const SCHEMA_PATH = path.join(SKILL_DIR, "references", "mandate.schema.json");
const DEFAULT_UPSTREAM_PATH = path.join(PACKAGE_ROOT, "protocols", "UPSTREAM.json");

type Line = { ok: boolean; rule: string; detail: string };
const lines: Line[] = [];
const ok = (rule: string, detail: string): void => { lines.push({ ok: true, rule, detail }); };
const fail = (rule: string, detail: string): void => { lines.push({ ok: false, rule, detail }); };

// The one canonical guard for this standalone script: a creator runs it on a
// draft before any server exists, so it imports nothing from mcp/.
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function usage(message: string): never {
  console.error(`mandate-check: ${message}`);
  console.error("usage: bun skills/herdr-delegation/scripts/mandate-check.ts <mandate.json> [--upstream <UPSTREAM.json>] [--cwd <project dir>]");
  process.exit(2);
}

const argv = process.argv.slice(2);
let mandatePath: string | undefined;
let upstreamPath = DEFAULT_UPSTREAM_PATH;
let projectDir = process.cwd();
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === "--upstream") {
    const value = argv[index + 1];
    if (!value) usage("--upstream needs a path");
    upstreamPath = path.resolve(value);
    index += 1;
    continue;
  }
  if (argument === "--cwd") {
    const value = argv[index + 1];
    if (!value) usage("--cwd needs a path");
    projectDir = path.resolve(value);
    index += 1;
    continue;
  }
  if (argument.startsWith("-")) usage(`unknown option ${argument}`);
  if (mandatePath) usage("pass exactly one mandate file");
  mandatePath = path.resolve(argument);
}
if (!mandatePath) usage("pass the mandate file to check");

let mandate: unknown;
try { mandate = JSON.parse(readFileSync(mandatePath, "utf8")); }
catch (error: unknown) { usage(`${mandatePath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`); }

let schema: Record<string, unknown>;
try { schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>; }
catch (error: unknown) { usage(`${SCHEMA_PATH} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`); }

// --- (a) schema -------------------------------------------------------------
// ajv resolves from the plugin tree in a normal install; the hand-written
// subset below is the same judgment for a tree where it does not, so the check
// never silently passes for want of a validator.
async function schemaErrors(value: unknown): Promise<string[]> {
  try {
    // Dynamic by necessity: ajv is not a declared dependency of this package,
    // so a static import would break the script wherever the tree lacks it.
    const { default: Ajv2020 } = await import("ajv/dist/2020.js");
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (validate(value)) return [];
    return (validate.errors ?? []).map((issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`);
  } catch {
    return subsetErrors(value, schema, "");
  }
}

/** The schema subset this document actually uses, evaluated against the schema file itself. */
function subsetErrors(value: unknown, node: Record<string, unknown>, at: string): string[] {
  const errors: string[] = [];
  const where = at || "/";
  if ("const" in node && value !== node.const) errors.push(`${where} must be ${JSON.stringify(node.const)}`);
  if (Array.isArray(node.enum) && !node.enum.includes(value as never)) errors.push(`${where} must be one of ${node.enum.join(", ")}`);
  if (node.type === "object") {
    if (!isRecord(value)) return [...errors, `${where} must be an object`];
    const properties = isRecord(node.properties) ? node.properties : {};
    for (const key of Array.isArray(node.required) ? node.required : []) {
      if (!(key as string in value)) errors.push(`${where} is missing required property ${String(key)}`);
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${where} has an unknown property ${key}`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in value) || !isRecord(child)) continue;
      errors.push(...subsetErrors(value[key], child, `${at}/${key}`));
    }
    return errors;
  }
  if (node.type === "array") {
    if (!Array.isArray(value)) return [...errors, `${where} must be an array`];
    if (typeof node.minItems === "number" && value.length < node.minItems) errors.push(`${where} needs at least ${node.minItems} item(s)`);
    if (typeof node.maxItems === "number" && value.length > node.maxItems) errors.push(`${where} allows at most ${node.maxItems} item(s)`);
    if (isRecord(node.items)) value.forEach((item, index) => errors.push(...subsetErrors(item, node.items as Record<string, unknown>, `${at}/${index}`)));
    return errors;
  }
  if (node.type === "string") {
    if (typeof value !== "string") return [...errors, `${where} must be a string`];
    if (typeof node.minLength === "number" && value.length < node.minLength) errors.push(`${where} must be at least ${node.minLength} character(s)`);
    if (typeof node.maxLength === "number" && value.length > node.maxLength) errors.push(`${where} is ${value.length} characters; the limit is ${node.maxLength}`);
    return errors;
  }
  if (node.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return [...errors, `${where} must be an integer`];
    if (typeof node.minimum === "number" && value < node.minimum) errors.push(`${where} must be at least ${node.minimum}`);
    return errors;
  }
  return errors;
}

const issues = await schemaErrors(mandate);
if (issues.length) fail("schema", `${issues.length} violation(s) of ${path.relative(PACKAGE_ROOT, SCHEMA_PATH)}: ${issues.slice(0, 8).join("; ")}${issues.length > 8 ? "; …" : ""}`);
else ok("schema", `valid against ${path.relative(PACKAGE_ROOT, SCHEMA_PATH)}`);

// Everything below reads the document defensively, so a mandate that already
// failed the schema still gets every other rule reported in one pass.
const document = isRecord(mandate) ? mandate : {};
const entry = isRecord(document.entry) ? document.entry : {};
const protocol = typeof entry.protocol === "string" ? entry.protocol : undefined;
const substrate = Array.isArray(document.substrate) ? document.substrate.filter((item): item is string => typeof item === "string") : [];
const openItems = Array.isArray(document.open) ? document.open.filter(isRecord) : [];
const settled = Array.isArray(document.settled) ? document.settled.filter(isRecord) : [];
const doneWhen = Array.isArray(document.done_when) ? document.done_when.filter((item): item is string => typeof item === "string") : [];
const forbidden = Array.isArray(document.forbidden) ? document.forbidden.filter((item): item is string => typeof item === "string") : [];
const purpose = typeof document.purpose === "string" ? document.purpose : "";

// --- (b) availability -------------------------------------------------------
let pinned: string[] | undefined;
try {
  const manifest: unknown = JSON.parse(readFileSync(upstreamPath, "utf8"));
  pinned = isRecord(manifest) && isRecord(manifest.protocols) ? Object.keys(manifest.protocols) : [];
} catch (error: unknown) {
  fail("protocol-available", `${upstreamPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
}
if (pinned) {
  if (!protocol) fail("protocol-available", "entry.protocol is missing, so no protocol can be shown to be available");
  else if (!pinned.includes(protocol)) fail("protocol-available", `entry.protocol "${protocol}" is not pinned in ${path.relative(PACKAGE_ROOT, upstreamPath)}; pinned: ${pinned.join(", ") || "none"}`);
  else ok("protocol-available", `entry.protocol "${protocol}" is pinned in ${path.relative(PACKAGE_ROOT, upstreamPath)}`);
}

// --- (c) structural gate conjuncts -----------------------------------------
// Only the conjuncts a machine can decide. Which gate holds is a judgment; that
// two candidates exist, or that a substrate was named, is a fact.
if (protocol === "preview") {
  const bound = openItems.filter((item) => Array.isArray(item.candidates) && item.candidates.length >= 2);
  if (bound.length) ok("gate", `preview: ${bound.length} open item(s) carry at least two candidates`);
  else fail("gate", "preview needs at least one open item with two or more candidates; probes exist to compare named alternatives");
} else if (protocol === "elicit") {
  if (substrate.length) ok("gate", `elicit: ${substrate.length} substrate item(s) named`);
  else fail("gate", "elicit needs at least one substrate item; it reads the user's externalized thinking rather than interviewing");
} else if (protocol) {
  ok("gate", `${protocol} has no deterministic structural conjunct`);
}

// --- (d) one unit per item --------------------------------------------------
// The schema's prose rule, made mechanical: a judged unit is one sentence that
// stands on its own, so a pointer outside itself or a second sentence is a
// defect a judge would otherwise have to guess through.
const POINTERS: { pattern: RegExp; name: string }[] = [
  { pattern: / above\b/i, name: "\" above\"" },
  { pattern: / below\b/i, name: "\" below\"" },
  { pattern: /the same /i, name: "\"the same \"" },
  { pattern: /(^|[.!?]\s+)it\s/i, name: "sentence-initial \"it\"" },
];
// Terminal punctuation counted only where a sentence can actually end — before
// whitespace or at the end — so `plan.md` or `entry.protocol` inside a unit is
// not a second sentence.
const TERMINATOR = /[.!?](?=\s|$)/g;
const judged: { unit: string; where: string }[] = [
  ...(purpose ? [{ unit: purpose, where: "purpose" }] : []),
  ...(typeof entry.utterance === "string" ? [{ unit: entry.utterance, where: "entry.utterance" }] : []),
  ...settled.flatMap((item, index) => (typeof item.decision === "string" ? [{ unit: item.decision, where: `settled[${index}].decision` }] : [])),
  ...substrate.map((unit, index) => ({ unit, where: `substrate[${index}]` })),
  ...openItems.flatMap((item, index) => (typeof item.item === "string" ? [{ unit: item.item, where: `open[${index}].item` }] : [])),
  ...doneWhen.map((unit, index) => ({ unit, where: `done_when[${index}]` })),
  ...forbidden.map((unit, index) => ({ unit, where: `forbidden[${index}]` })),
];
const unitDefects: string[] = [];
for (const { unit, where } of judged) {
  for (const pointer of POINTERS) {
    if (pointer.pattern.test(unit)) unitDefects.push(`${where} points outside itself with ${pointer.name}`);
  }
  const count = (unit.trim().match(TERMINATOR) ?? []).length;
  if (count > 1) unitDefects.push(`${where} carries ${count} sentences`);
}
if (unitDefects.length) fail("one-unit", `${unitDefects.length} defect(s): ${unitDefects.slice(0, 8).join("; ")}${unitDefects.length > 8 ? "; …" : ""}`);
else ok("one-unit", `${judged.length} judged unit(s) are self-contained single sentences`);

// --- (e) done_when is not purpose restated ---------------------------------
const restated = doneWhen.filter((item) => item.trim().toLowerCase() === purpose.trim().toLowerCase() && purpose.trim());
if (restated.length) fail("done-when-distinct", `${restated.length} done_when item(s) restate purpose verbatim; a completion condition is verifiable from a record, a purpose is not`);
else ok("done-when-distinct", `${doneWhen.length} done_when item(s) are distinct from purpose`);

// --- (f) settled reasons ----------------------------------------------------
const reasonDefects = settled.flatMap((item, index) => {
  const reason = typeof item.reason === "string" ? item.reason.trim() : "";
  return reason ? [] : [`settled[${index}].reason is empty; write the reason the user stated or exactly "unstated"`];
});
if (reasonDefects.length) fail("settled-reason", reasonDefects.slice(0, 8).join("; "));
else ok("settled-reason", `${settled.length} settled decision(s) carry a stated reason or "unstated"`);

// --- (g) substrate paths exist ---------------------------------------------
// A substrate item is a channel the born ORCH will read. A path that does not
// exist where the track will run is a channel that yields nothing, and the
// first sandbox track found two such items the creator check had let through.
// The path is the first token of the item that looks like one: absolute, or
// relative and containing a `/` or a file extension. URLs and commit-qualified
// coordinates (`branch:path`) are not checked; the project dir defaults to the
// cwd and is the directory the track will be opened in.
const PATH_TOKEN = /(?:^|[\s(`'"])((?:\/|~\/|\.{1,2}\/)?[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+|[A-Za-z0-9_\-]+\.[a-z]{1,5})(?=[\s)`'",;:]|$)/;
const missingPaths = substrate.flatMap((item, index) => {
  if (/https?:\/\//.test(item) || /\b[a-z0-9._\/-]+:[a-z0-9._\/-]+\/[a-z0-9._\/-]+/i.test(item)) return [];
  const match = PATH_TOKEN.exec(item);
  if (!match) return [];
  const token = match[1].replace(/^~\//, `${process.env.HOME ?? ""}/`);
  const resolved = path.isAbsolute(token) ? token : path.resolve(projectDir, token);
  try { statSync(resolved); return []; }
  catch { return [`substrate[${index}] names ${token}, which does not exist at ${resolved}`]; }
});
if (missingPaths.length) fail("substrate-path", missingPaths.slice(0, 8).join("; "));
else ok("substrate-path", `${substrate.length} substrate item(s) name paths that exist under ${projectDir} or absolutely`);

// --- semantic seam ----------------------------------------------------------
/**
 * The Jev semantic gate — the checks a judge must make and this script cannot.
 * Not installed here; the next track implements it behind this seam so the
 * exit code stays deterministic until then. Its contract:
 *   1. routing: on a state that omits `entry`, ask which protocol's gate holds
 *      (choice over the pinned protocols plus "none"); disagreement with
 *      entry.protocol is a FAIL that shows both readings.
 *   2. consistency: for every done_when item, ask whether any settled decision
 *      or forbidden item contradicts it (the first sandbox track found
 *      done_when items requiring an edit a settled decision forbade).
 *   3. coverage: for every substrate item, ask whether the sentence names what
 *      the coordinate actually holds (a stale "D-01 to D-07" against a document
 *      that carries D-15 is the observed case).
 *   4. noise: for every judged unit, ask whether it would be true in another
 *      track; a "yes" is a FAIL naming the unit.
 */
function semanticChecks(): Line[] {
  return [];
}
lines.push(...semanticChecks());

for (const line of lines) console.log(`${line.ok ? "ok" : "FAIL"} ${line.rule}: ${line.detail}`);
const failures = lines.filter((line) => !line.ok).length;
console.log(`${failures ? "FAILED" : "PASSED"}: ${lines.length - failures} ok, ${failures} failed (${path.basename(mandatePath)})`);
process.exit(failures ? 1 : 0);
