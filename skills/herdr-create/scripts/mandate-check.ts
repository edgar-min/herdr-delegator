// bun skills/herdr-create/scripts/mandate-check.ts <mandate.json> [--upstream <UPSTREAM.json>] [--cwd <project dir>] [--no-semantic | --semantic-only]
//
// The deterministic half of the mandate check: everything about a mandate that
// can be decided without a judge. It validates the document against
// references/mandate.schema.json, refuses an entry protocol this package does
// not pin, enforces the structural conjuncts of the routing gates, and flags
// judged units that break the one-unit rule the schema states in prose.
//
// Every check prints one `ok <rule>: <detail>` or `FAIL <rule>: <detail>` line
// and any FAIL exits 1, so it is usable both by a creator reading the output and
// by a script reading the exit code. The judged half — routing, consistency,
// coverage and noise, asked of a Jev judge — lives in `semanticChecks()` below;
// it needs a Jev key and prints its own skip line when there is none.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChoiceAnswer, ChoiceQuestion, JevResponse } from "../../../mcp/jev/client";
import { buildJudgedState, readInstalledSkillSha, readUniversalContract } from "./mandate-contract";

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
  console.error("usage: bun skills/herdr-create/scripts/mandate-check.ts <mandate.json> [--upstream <UPSTREAM.json>] [--cwd <project dir>] [--no-semantic | --semantic-only]");
  process.exit(2);
}

const argv = process.argv.slice(2);
let mandatePath: string | undefined;
let upstreamPath = DEFAULT_UPSTREAM_PATH;
let projectDir = process.cwd();
let skipSemantic = false;
let semanticOnly = false;
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
  if (argument === "--no-semantic") { skipSemantic = true; continue; }
  if (argument === "--semantic-only") { semanticOnly = true; continue; }
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
const universalContract = readUniversalContract(PACKAGE_ROOT);
lines.push(universalContract.line);
lines.push(readInstalledSkillSha(PACKAGE_ROOT, path.join("skills", "herdr-orch", "SKILL.md")));

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

// --- the semantic gate ------------------------------------------------------
/**
 * The Jev semantic gate — the four judgments a judge must make and the
 * deterministic rules above cannot:
 *   1. routing: on a state that OMITS `entry`, which protocol's gate holds;
 *      disagreement with entry.protocol is a FAIL showing both readings, and a
 *      judge under the undecided threshold leaves the creator's choice standing.
 *   2. consistency: for every done_when item, whether a settled decision or a
 *      forbidden item contradicts it.
 *   3. coverage: for every substrate item, whether its sentence describes what
 *      its coordinate holds as far as the mandate itself shows.
 *   4. noise: for every judged unit, whether it would be true of another track.
 *
 * The gate never changes a deterministic verdict; it adds lines of its own. A
 * creator without a Jev key still gets the deterministic verdict, and the skip
 * is printed rather than silent.
 */
const QUESTION_VERSION = "mandate-gate-2026-09-22.1";
/** Ctx-pass rule recorded in inquire-align/r1/plan.md: at or below this, the judge decided nothing. */
const UNDECIDED_CONFIDENCE = 0.35;
const DEFINITION_FIELDS = ["purpose", "language", "settled", "substrate", "open", "done_when", "forbidden"] as const;

/** The gate asks only `choice` questions; `Choice` is the client's own question type narrowed to that. */
type Choice = ChoiceQuestion;

/** The five gate sentences, split out of entry.protocol's own description. */
function protocolGates(): { gates: Record<string, string>; precedence: string } {
  const entrySchema = isRecord(schema.properties) && isRecord(schema.properties.entry) ? schema.properties.entry : {};
  const protocolSchema = isRecord(entrySchema.properties) && isRecord(entrySchema.properties.protocol) ? entrySchema.properties.protocol : {};
  const description = typeof protocolSchema.description === "string" ? protocolSchema.description : "";
  const names = Array.isArray(protocolSchema.enum) ? protocolSchema.enum.filter((value): value is string => typeof value === "string") : [];
  const marks = names
    .map((name) => ({ name, at: description.indexOf(`${name} (`) }))
    .filter((mark) => mark.at >= 0)
    .sort((left, right) => left.at - right.at);
  const precedenceAt = description.indexOf("Routing precedence");
  const gates: Record<string, string> = {};
  for (const [index, mark] of marks.entries()) {
    const end = index + 1 < marks.length ? marks[index + 1].at : (precedenceAt >= 0 ? precedenceAt : description.length);
    gates[mark.name] = description.slice(mark.at, end).trim();
  }
  return { gates, precedence: precedenceAt >= 0 ? description.slice(precedenceAt).trim() : "" };
}

function probabilityText(answer: ChoiceAnswer): string {
  const ordered = Object.entries(answer.probabilities).sort((left, right) => right[1] - left[1]);
  return `${ordered.map(([label, value]) => `${label}=${value.toFixed(2)}`).join(" ")}, confidence ${answer.confidence.toFixed(2)}`;
}

const quote = (text: string): string => `"${text.length > 110 ? `${text.slice(0, 107)}…` : text}"`;

/** State and questions: the mandate WITHOUT `entry`, plus definitions and universal reservations. */
function gateRequest(): { state: unknown; questions: Record<string, Choice>; targets: Record<string, string> } {
  const { gates, precedence } = protocolGates();
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const definitions: Record<string, string> = {};
  for (const field of DEFINITION_FIELDS) {
    const node = isRecord(properties[field]) ? properties[field] : undefined;
    if (node && typeof node.description === "string") definitions[field] = node.description;
  }
  for (const [name, sentence] of Object.entries(gates)) definitions[`protocol.${name}`] = sentence;
  // The judge routes the invocation, not the whole document: it must see what
  // the first turn is asked to do (entry.utterance) and must not see the
  // creator's answer (entry.protocol, entry.reason). The first measurement
  // over the example, with the utterance removed too, routed "none" over
  // "sketch" twice: the form to be made lived only in the utterance.
  const state = buildJudgedState(document, definitions, universalContract.universalReservations);

  const questions: Record<string, Choice> = {};
  const targets: Record<string, string> = {};
  questions.routing = {
    type: "choice",
    instructions: {
      ask: "Which protocol's gate holds for what mandate.invocation asks of the first turn, given the mandate's open items, settled decisions and substrate? Judge only from the state: the creator's chosen protocol and reason have been removed from it.",
      precedence,
      answer_with: "the protocol whose gate description matches the deficit this mandate carries, or none when no gate holds",
    },
    criteria: { ...gates, none: "No gate holds: the mandate is not ready for any planning protocol as it stands." },
  };
  targets.routing = "entry.protocol (removed from the state; entry.utterance kept as mandate.invocation)";
  doneWhen.forEach((item, index) => {
    questions[`consistency[${index}]`] = {
      type: "choice",
      instructions: {
        ask: `Does any settled decision or forbidden item in this mandate contradict done_when[${index}]?`,
        item,
        answer_with: "contradicted when reaching this condition would require an act the mandate settles against or forbids, otherwise consistent",
      },
      criteria: {
        consistent: "No settled decision and no forbidden item stands in the way of reaching this condition.",
        contradicted: "A settled decision or a forbidden item makes this condition unreachable as written.",
      },
    };
    targets[`consistency[${index}]`] = `done_when[${index}] ${quote(item)}`;
  });
  substrate.forEach((item, index) => {
    questions[`coverage[${index}]`] = {
      type: "choice",
      instructions: {
        ask: `Does substrate[${index}]'s sentence describe what its coordinate holds, as far as this mandate itself shows?`,
        item,
        answer_with: "stale only when another part of the mandate shows the description is out of date; unknowable when the mandate cannot show either way",
      },
      criteria: {
        accurate: "The sentence describes what the named coordinate holds, consistently with the rest of the mandate.",
        stale: "The rest of the mandate shows this description is out of date for that coordinate.",
        unknowable: "Nothing in the mandate settles whether the description still fits; only opening the coordinate would.",
      },
    };
    targets[`coverage[${index}]`] = `substrate[${index}] ${quote(item)}`;
  });
  const noiseUnits = [
    ...settled.flatMap((item, index) => (typeof item.decision === "string" ? [{ where: `settled[${index}].decision`, unit: item.decision }] : [])),
    ...forbidden.map((unit, index) => ({ where: `forbidden[${index}]`, unit })),
    ...doneWhen.map((unit, index) => ({ where: `done_when[${index}]`, unit })),
  ];
  noiseUnits.forEach(({ where, unit }, index) => {
    questions[`noise[${index}]`] = {
      type: "choice",
      instructions: {
        ask: "Would this sentence be true of any other track in this project?",
        sentence: unit,
        answer_with: "universal when it states a rule that holds for every track, track-specific when it only holds for this mandate's own work",
      },
      criteria: {
        "track-specific": "The sentence names something true of this track's own work and false or vacuous elsewhere.",
        universal: "The sentence states a rule that would hold in any other track of this project; it belongs in the ORCH skill, not in a mandate.",
      },
    };
    targets[`noise[${index}]`] = `${where} ${quote(unit)}`;
  });
  return { state, questions, targets };
}

/** Groups in request order; a group too large for one request is split further, never dropped. */
function planRequests(
  state: unknown,
  questions: Record<string, Choice>,
  fits: (batch: Record<string, Choice>) => boolean,
): Record<string, Choice>[] {
  if (fits(questions)) return [questions];
  const groups = ["routing", "consistency", "coverage", "noise"];
  const batches: Record<string, Choice>[] = [];
  for (const group of groups) {
    const entries = Object.entries(questions).filter(([id]) => id === group || id.startsWith(`${group}[`));
    if (!entries.length) continue;
    let pending = entries;
    while (pending.length) {
      let size = pending.length;
      while (size > 1 && !fits(Object.fromEntries(pending.slice(0, size)))) size -= 1;
      batches.push(Object.fromEntries(pending.slice(0, size)));
      pending = pending.slice(size);
    }
  }
  return batches;
}

async function semanticChecks(): Promise<Line[]> {
  if (skipSemantic) return [{ ok: true, rule: "semantic", detail: "skipped (--no-semantic)" }];
  // Optional dependency, loaded late on purpose: the deterministic half of this
  // check must keep working in a tree that carries the skill without the
  // server's mcp/jev client, and a creator without a Jev key must still get a
  // verdict. A static import would make both cases a crash.
  let jev: typeof import("../../../mcp/jev/client");
  try { jev = await import("../../../mcp/jev/client"); }
  catch { return [{ ok: true, rule: "semantic", detail: "skipped (jev client not installed)" }]; }
  try { jev.apiKey(); }
  catch { return [{ ok: true, rule: "semantic", detail: "skipped (no Jev key)" }]; }

  const { state, questions, targets } = gateRequest();
  const fits = (batch: Record<string, Choice>): boolean => {
    try { jev.assertBudget(state, batch); return true; }
    catch { return false; }
  };
  const batches = planRequests(state, questions, fits);
  const answers: Record<string, ChoiceAnswer> = {};
  const usage: string[] = [];
  let model = "";
  for (const batch of batches) {
    let response: JevResponse;
    try { response = await jev.ask(state, batch); }
    catch (error: unknown) {
      return [{ ok: false, rule: "semantic", detail: `the judge could not be asked: ${error instanceof Error ? error.message : String(error)}` }];
    }
    model = response.model;
    usage.push(`${response.usage ? `${response.usage.input_tokens} in / ${response.usage.output_tokens} out` : "usage not reported"}`);
    for (const [id, answer] of Object.entries(response.answers)) {
      if (answer.type === "choice") answers[id] = answer;
    }
  }

  const results: Line[] = [{
    ok: true,
    rule: "semantic",
    detail: `${model || "jev"}, question version ${QUESTION_VERSION}, state ≈${jev.estimateTokens(state)} tokens, ${batches.length} request(s) [${usage.join("; ")}]`,
  }];

  const routing = answers.routing;
  if (!routing) results.push({ ok: false, rule: "routing", detail: "the judge returned no routing answer" });
  else if (routing.confidence <= UNDECIDED_CONFIDENCE) {
    results.push({ ok: true, rule: "routing", detail: `judge undecided (${probabilityText(routing)}), creator's choice ${protocol ?? "(none)"} stands` });
  } else if (protocol && routing.choice !== protocol) {
    results.push({ ok: false, rule: "routing", detail: `judge routes to ${routing.choice}, the mandate names ${protocol} (${probabilityText(routing)}); ${targets.routing}` });
  } else {
    results.push({ ok: true, rule: "routing", detail: `judge routes to ${routing.choice}, the mandate names ${protocol ?? "(none)"} (${probabilityText(routing)})` });
  }

  // A passing group still reports what the judge actually said per item: an
  // `accurate` and an `unknowable` are different answers, and a creator reading
  // only "ok" would not see which items the judge could not settle.
  // The same undecided rule as routing: a verdict at or below the threshold is
  // reported, never failed on. Measured on the example, half of the noise flags
  // sat at 0.00-0.28 confidence and would otherwise block a creator on noise.
  const group = (name: string, failOn: string[], okDetail: (count: number) => string): void => {
    const entries = Object.entries(answers).filter(([id]) => id.startsWith(`${name}[`));
    const failing = entries.filter(([, answer]) => failOn.includes(answer.choice) && answer.confidence > UNDECIDED_CONFIDENCE);
    const undecided = entries.filter(([, answer]) => failOn.includes(answer.choice) && answer.confidence <= UNDECIDED_CONFIDENCE);
    for (const [id, answer] of failing) {
      results.push({ ok: false, rule: name, detail: `${targets[id] ?? id} is ${answer.choice} (${probabilityText(answer)})` });
    }
    for (const [id, answer] of undecided) {
      results.push({ ok: true, rule: name, detail: `judge undecided on ${targets[id] ?? id} (${probabilityText(answer)}); not failed` });
    }
    if (failing.length || undecided.length) return;
    const perItem = entries.map(([id, answer]) => `${id.slice(name.length)} ${answer.choice} ${answer.confidence.toFixed(2)}`).join("; ");
    results.push({ ok: true, rule: name, detail: `${okDetail(entries.length)} [${perItem}]` });
  };
  group("consistency", ["contradicted"], (count) => `${count} done_when item(s) are consistent with settled and forbidden`);
  group("coverage", ["stale"], (count) => `${count} substrate item(s) are accurate or unknowable from the mandate alone`);
  group("noise", ["universal"], (count) => `${count} judged unit(s) are track-specific`);
  return results;
}

// `--semantic-only` reports the judged half alone; the deterministic lines are
// dropped rather than re-judged, so its exit code answers only the gate.
if (semanticOnly) lines.length = 0;
lines.push(...(await semanticChecks()));

for (const line of lines) console.log(`${line.ok ? "ok" : "FAIL"} ${line.rule}: ${line.detail}`);
const failures = lines.filter((line) => !line.ok).length;
console.log(`${failures ? "FAILED" : "PASSED"}: ${lines.length - failures} ok, ${failures} failed (${path.basename(mandatePath)})`);
process.exit(failures ? 1 : 0);
