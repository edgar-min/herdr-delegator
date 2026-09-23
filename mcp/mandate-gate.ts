// The mandate check, as the server runs it: the deterministic half (schema,
// pinned protocol, structural gate conjuncts, judged-unit style, substrate
// paths) and the judged half (routing, consistency, coverage, noise) asked of a
// Jev judge. `herdr_track check` returns its lines; `herdr_track open` refuses
// on a FAILED verdict. The judged half is skipped, never failed, without a key.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiKey, ask, assertBudget, estimateTokens, type AskOptions, type ChoiceAnswer, type ChoiceQuestion, type JevResponse } from "./jev/client";

export type CheckLine = { ok: boolean; rule: string; detail: string };
export type MandateCheckResult = { lines: CheckLine[]; verdict: "PASSED" | "FAILED" };
export type MandateCheckOptions = {
  /** The project directory the track will run in; substrate paths resolve against it. */
  cwd?: string;
  packageRoot?: string;
  upstreamPath?: string;
  /** Skip the judged half outright (the deterministic verdict is unchanged). */
  semantic?: boolean;
  /** Passed to the Jev client; a test supplies `fetchImpl` here. */
  ask?: AskOptions;
};

export type UniversalContract = { line: CheckLine; universalReservations: string };

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const QUESTION_VERSION = "mandate-gate-2026-09-23.1";
/** Ctx-pass rule recorded in inquire-align/r1/plan.md: at or below this, the judge decided nothing. */
const UNDECIDED_CONFIDENCE = 0.35;
const DEFINITION_FIELDS = ["purpose", "language", "settled", "substrate", "open", "done_when", "forbidden"] as const;
const BIND_RE = /^open\[([0-9]+)\]$/;
const UTTERANCE_BIND_RE = /open\[[0-9]+\]/;

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function reservedSection(markdown: string, contractPath: string): string {
  const heading = /^## Reserved to the user[ \t]*$/m.exec(markdown);
  if (!heading || heading.index === undefined) {
    throw new Error(`${contractPath} has no H2 section named Reserved to the user`);
  }
  const afterHeading = heading.index + heading[0].length;
  const nextHeading = /^## /m.exec(markdown.slice(afterHeading));
  const end = nextHeading?.index === undefined ? markdown.length : afterHeading + nextHeading.index;
  return markdown.slice(heading.index, end).trimEnd();
}

/** Verify the package's common contract pin and return the exact reserved section sent to Jev. */
export function readUniversalContract(packageRoot: string): UniversalContract {
  const contractPath = path.join(packageRoot, "protocols", "contract.md");
  const manifestPath = path.join(packageRoot, "protocols", "CONTRACT.json");
  let bytes: Buffer;
  try {
    bytes = readFileSync(contractPath);
  } catch (error: unknown) {
    return {
      line: { ok: false, rule: "contract", detail: `${contractPath} is not readable: ${error instanceof Error ? error.message : String(error)}` },
      universalReservations: "",
    };
  }

  let expected: unknown;
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    expected = isRecord(manifest) ? manifest["contract.md"] : undefined;
  } catch (error: unknown) {
    return {
      line: { ok: false, rule: "contract", detail: `${manifestPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}` },
      universalReservations: "",
    };
  }
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
    return {
      line: { ok: false, rule: "contract", detail: `${manifestPath} must contain {"contract.md":"<sha256>"}` },
      universalReservations: "",
    };
  }

  const actual = sha256(bytes);
  if (actual !== expected) {
    return {
      line: { ok: false, rule: "contract", detail: `${contractPath} hashes ${actual}, but ${manifestPath} pins ${expected}` },
      universalReservations: "",
    };
  }

  try {
    return {
      line: { ok: true, rule: "contract", detail: `sha256 ${actual}` },
      universalReservations: reservedSection(bytes.toString("utf8"), contractPath),
    };
  } catch (error: unknown) {
    return {
      line: { ok: false, rule: "contract", detail: error instanceof Error ? error.message : String(error) },
      universalReservations: "",
    };
  }
}

/** Report the digest of an installed role skill without importing it. */
export function readInstalledSkillSha(packageRoot: string, relativePath: string): CheckLine {
  const skillPath = path.join(packageRoot, relativePath);
  try {
    return { ok: true, rule: "orch-skill", detail: `sha256 ${sha256(readFileSync(skillPath))}` };
  } catch (error: unknown) {
    return { ok: false, rule: "orch-skill", detail: `${skillPath} is not readable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The worker contract served at `herdr-delegator://worker`, verified exactly as
 * `contract.md` is: bytes from `protocols/worker.md`, digest from the
 * `worker.md` key of `protocols/CONTRACT.json`. A manifest that pins no
 * `worker.md` claims nothing, so nothing is verified and the line says so; once
 * the pin exists, an unreadable or drifted document fails.
 */
export function readWorkerContract(packageRoot: string): CheckLine {
  const documentPath = path.join(packageRoot, "protocols", "worker.md");
  const manifestPath = path.join(packageRoot, "protocols", "CONTRACT.json");
  let expected: unknown;
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    expected = isRecord(manifest) ? manifest["worker.md"] : undefined;
  } catch (error: unknown) {
    return { ok: false, rule: "worker-contract", detail: `${manifestPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (expected === undefined) {
    return { ok: true, rule: "worker-contract", detail: `not pinned: ${manifestPath} carries no "worker.md" key, so no worker contract is claimed` };
  }
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
    return { ok: false, rule: "worker-contract", detail: `${manifestPath} must pin "worker.md" as a sha256 string` };
  }
  let bytes: Buffer;
  try { bytes = readFileSync(documentPath); }
  catch (error: unknown) {
    return { ok: false, rule: "worker-contract", detail: `${manifestPath} pins "worker.md" but ${documentPath} is not readable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const actual = sha256(bytes);
  if (actual !== expected) {
    return { ok: false, rule: "worker-contract", detail: `${documentPath} hashes ${actual}, but ${manifestPath} pins ${expected}` };
  }
  return { ok: true, rule: "worker-contract", detail: `sha256 ${actual}` };
}

/**
 * The judged state: the mandate WITHOUT `entry`, plus the invocation and the
 * bound open coordinates. The creator's own answers — `entry.protocol` and
 * `entry.reason` — stay out, because the judge is asked the routing question
 * they answer; `binds` is state, since the utterance no longer names its bound
 * items by coordinate (plan decision D-01).
 */
export function buildJudgedState(
  document: Record<string, unknown>,
  definitions: Record<string, string>,
  universalReservations: string,
): unknown {
  const { entry: creatorEntry, ...withoutEntry } = document;
  const entry = isRecord(creatorEntry) ? creatorEntry : {};
  const utterance = typeof entry.utterance === "string" ? entry.utterance : "";
  const binds = strings(entry.binds);
  return {
    definitions,
    universal_reservations: universalReservations,
    mandate: { ...withoutEntry, invocation: utterance, ...(binds.length ? { binds } : {}) },
  };
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
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) errors.push(`${where} must match ${node.pattern}`);
    return errors;
  }
  if (node.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return [...errors, `${where} must be an integer`];
    if (typeof node.minimum === "number" && value < node.minimum) errors.push(`${where} must be at least ${node.minimum}`);
    return errors;
  }
  return errors;
}

/**
 * ajv when the tree carries it, the hand-written subset above when it does not:
 * the check must never silently pass for want of a validator, and ajv is a dev
 * dependency of this package rather than a runtime one.
 */
async function schemaErrors(value: unknown, schema: Record<string, unknown>): Promise<string[]> {
  try {
    const { default: Ajv2020 } = await import("ajv/dist/2020.js");
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (validate(value)) return [];
    return (validate.errors ?? []).map((issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`);
  } catch {
    return subsetErrors(value, schema, "");
  }
}

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
// The first token of a substrate item that looks like a path: absolute, or
// relative and containing a `/` or a file extension.
const PATH_TOKEN = /(?:^|[\s(`'"])((?:\/|~\/|\.{1,2}\/)?[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+|[A-Za-z0-9_\-]+\.[a-z]{1,5})(?=[\s)`'",;:]|$)/;

type Choice = ChoiceQuestion;
type GateRequest = { state: unknown; questions: Record<string, Choice>; targets: Record<string, string> };

/** The five gate sentences, split out of entry.protocol's own description. */
function protocolGates(schema: Record<string, unknown>): { gates: Record<string, string>; precedence: string } {
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

/** Groups in request order; a group too large for one request is split further, never dropped. */
function planRequests(questions: Record<string, Choice>, fits: (batch: Record<string, Choice>) => boolean): Record<string, Choice>[] {
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

/**
 * The mandate check. Every rule reports one line, so a document that already
 * failed the schema still gets every other rule in one pass, and the verdict is
 * FAILED exactly when a line failed.
 */
export async function checkMandate(mandate: unknown, options: MandateCheckOptions = {}): Promise<MandateCheckResult> {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const projectDir = options.cwd ?? process.cwd();
  const schemaPath = path.join(packageRoot, "skills", "herdr-create", "references", "mandate.schema.json");
  const upstreamPath = options.upstreamPath ?? path.join(packageRoot, "protocols", "UPSTREAM.json");
  const lines: CheckLine[] = [];
  const ok = (rule: string, detail: string): void => { lines.push({ ok: true, rule, detail }); };
  const fail = (rule: string, detail: string): void => { lines.push({ ok: false, rule, detail }); };

  const universalContract = readUniversalContract(packageRoot);
  lines.push(universalContract.line);
  lines.push(readWorkerContract(packageRoot));
  lines.push(readInstalledSkillSha(packageRoot, path.join("skills", "herdr-orch", "SKILL.md")));

  let schema: Record<string, unknown> = {};
  let schemaReadable = true;
  try { schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>; }
  catch (error: unknown) {
    schemaReadable = false;
    fail("schema", `${schemaPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (schemaReadable) {
    const issues = await schemaErrors(mandate, schema);
    if (issues.length) fail("schema", `${issues.length} violation(s) of ${path.relative(packageRoot, schemaPath)}: ${issues.slice(0, 8).join("; ")}${issues.length > 8 ? "; …" : ""}`);
    else ok("schema", `valid against ${path.relative(packageRoot, schemaPath)}`);
  }

  const document = isRecord(mandate) ? mandate : {};
  const entry = isRecord(document.entry) ? document.entry : {};
  const protocol = typeof entry.protocol === "string" ? entry.protocol : undefined;
  const utterance = typeof entry.utterance === "string" ? entry.utterance : undefined;
  const binds = strings(entry.binds);
  const substrate = strings(document.substrate);
  const openItems = Array.isArray(document.open) ? document.open.filter(isRecord) : [];
  const settled = Array.isArray(document.settled) ? document.settled.filter(isRecord) : [];
  const doneWhen = strings(document.done_when);
  const forbidden = strings(document.forbidden);
  const purpose = typeof document.purpose === "string" ? document.purpose : "";

  // --- protocol availability -------------------------------------------------
  let pinned: string[] | undefined;
  try {
    const manifest: unknown = JSON.parse(readFileSync(upstreamPath, "utf8"));
    pinned = isRecord(manifest) && isRecord(manifest.protocols) ? Object.keys(manifest.protocols) : [];
  } catch (error: unknown) {
    fail("protocol-available", `${upstreamPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (pinned) {
    if (!protocol) fail("protocol-available", "entry.protocol is missing, so no protocol can be shown to be available");
    else if (!pinned.includes(protocol)) fail("protocol-available", `entry.protocol "${protocol}" is not pinned in ${path.relative(packageRoot, upstreamPath)}; pinned: ${pinned.join(", ") || "none"}`);
    else ok("protocol-available", `entry.protocol "${protocol}" is pinned in ${path.relative(packageRoot, upstreamPath)}`);
  }

  // --- structural gate conjuncts --------------------------------------------
  // Only the conjuncts a machine can decide. Which gate holds is a judgment;
  // that a bound open item exists and carries two candidates is a fact.
  const bindDefects = binds.flatMap((bind) => {
    const match = BIND_RE.exec(bind);
    if (!match) return [`entry.binds names ${bind}, which is not an open[N] coordinate`];
    const index = Number(match[1]);
    return index < openItems.length ? [] : [`entry.binds names ${bind}, which open[] does not carry (${openItems.length} item(s))`];
  });
  const boundItems = binds.flatMap((bind) => {
    const match = BIND_RE.exec(bind);
    const index = match ? Number(match[1]) : -1;
    const item = openItems[index];
    return item ? [{ bind, item }] : [];
  });
  if (bindDefects.length) fail("gate", bindDefects.slice(0, 8).join("; "));
  else if (protocol === "preview") {
    const thin = boundItems.filter(({ item }) => !(Array.isArray(item.candidates) && item.candidates.length >= 2));
    if (!binds.length) fail("gate", "preview needs entry.binds naming at least one open item; probes exist to compare named alternatives");
    else if (thin.length) fail("gate", `preview needs every bound open item to carry two or more candidates; ${thin.map(({ bind, item }) => `${bind} carries ${Array.isArray(item.candidates) ? item.candidates.length : 0}`).join("; ")}`);
    else ok("gate", `preview: ${binds.length} bound open item(s) carry at least two candidates`);
  } else if (protocol === "elicit") {
    if (!binds.length) fail("gate", "elicit needs entry.binds naming at least one open item");
    else if (substrate.length) ok("gate", `elicit: ${binds.length} bound open item(s), ${substrate.length} substrate item(s) named`);
    else fail("gate", "elicit needs at least one substrate item; it reads the user's externalized thinking rather than interviewing");
  } else if (protocol) {
    ok("gate", `${protocol} has no deterministic structural conjunct${binds.length ? `; ${binds.length} bound open item(s) resolve` : ""}`);
  }

  // --- one unit per item -----------------------------------------------------
  const judged: { unit: string; where: string }[] = [
    ...(purpose ? [{ unit: purpose, where: "purpose" }] : []),
    ...(utterance ? [{ unit: utterance, where: "entry.utterance" }] : []),
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
  // The binding lives in entry.binds (plan decision D-01), so a coordinate in
  // the utterance is a second source of truth the ORCH would have to reconcile.
  if (utterance && UTTERANCE_BIND_RE.test(utterance)) {
    unitDefects.push("entry.utterance names a bound open item by coordinate; entry.binds carries the binding and the utterance refers to it by role");
  }
  if (unitDefects.length) fail("one-unit", `${unitDefects.length} defect(s): ${unitDefects.slice(0, 8).join("; ")}${unitDefects.length > 8 ? "; …" : ""}`);
  else ok("one-unit", `${judged.length} judged unit(s) are self-contained single sentences`);

  // --- done_when is not purpose restated -------------------------------------
  const restated = doneWhen.filter((item) => item.trim().toLowerCase() === purpose.trim().toLowerCase() && purpose.trim());
  if (restated.length) fail("done-when-distinct", `${restated.length} done_when item(s) restate purpose verbatim; a completion condition is verifiable from a record, a purpose is not`);
  else ok("done-when-distinct", `${doneWhen.length} done_when item(s) are distinct from purpose`);

  // --- settled reasons -------------------------------------------------------
  const reasonDefects = settled.flatMap((item, index) => {
    const reason = typeof item.reason === "string" ? item.reason.trim() : "";
    return reason ? [] : [`settled[${index}].reason is empty; write the reason the user stated or exactly "unstated"`];
  });
  if (reasonDefects.length) fail("settled-reason", reasonDefects.slice(0, 8).join("; "));
  else ok("settled-reason", `${settled.length} settled decision(s) carry a stated reason or "unstated"`);

  // --- substrate paths exist -------------------------------------------------
  // A substrate item is a channel the born ORCH will read; a path that does not
  // exist where the track will run is a channel that yields nothing. URLs and
  // commit-qualified coordinates (`branch:path`) are not checked.
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

  // --- the judged half -------------------------------------------------------
  const gateRequest = (): GateRequest => {
    const { gates, precedence } = protocolGates(schema);
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const definitions: Record<string, string> = {};
    for (const field of DEFINITION_FIELDS) {
      const node = isRecord(properties[field]) ? properties[field] : undefined;
      if (node && typeof node.description === "string") definitions[field] = node.description;
    }
    for (const [name, sentence] of Object.entries(gates)) definitions[`protocol.${name}`] = sentence;
    const state = buildJudgedState(document, definitions, universalContract.universalReservations);

    const questions: Record<string, Choice> = {};
    const targets: Record<string, string> = {};
    questions.routing = {
      type: "choice",
      instructions: {
        ask: "Which protocol's gate holds for what mandate.invocation asks of the first turn, given the mandate's open items, settled decisions and substrate? Judge only from the state: the creator's chosen protocol and reason have been removed from it.",
        precedence,
        answer_with: "the protocol whose gate description matches the deficit this mandate carries, none when no gate holds, or not-track-worthy when the work needs no track at all",
      },
      criteria: {
        ...gates,
        none: "No gate holds: the mandate is not ready for any planning protocol as it stands.",
        "not-track-worthy": "The work would finish inside the creator's own session as a host subagent task; a track's persistent lanes, ownership, evidence, and recovery buy nothing here.",
      },
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
  };

  const semanticLines = async (): Promise<CheckLine[]> => {
    if (options.semantic === false) return [{ ok: true, rule: "semantic", detail: "skipped (semantic half disabled)" }];
    try { apiKey(); }
    catch { return [{ ok: true, rule: "semantic", detail: "skipped (no Jev key)" }]; }

    const { state, questions, targets } = gateRequest();
    const fits = (batch: Record<string, Choice>): boolean => {
      try { assertBudget(state, batch); return true; }
      catch { return false; }
    };
    const batches = planRequests(questions, fits);
    const answers: Record<string, ChoiceAnswer> = {};
    const usage: string[] = [];
    let model = "";
    for (const batch of batches) {
      let response: JevResponse;
      try { response = await ask(state, batch, options.ask); }
      catch (error: unknown) {
        return [{ ok: false, rule: "semantic", detail: `the judge could not be asked: ${error instanceof Error ? error.message : String(error)}` }];
      }
      model = response.model;
      usage.push(response.usage ? `${response.usage.input_tokens} in / ${response.usage.output_tokens} out` : "usage not reported");
      for (const [id, answer] of Object.entries(response.answers)) {
        if (answer.type === "choice") answers[id] = answer;
      }
    }

    const results: CheckLine[] = [{
      ok: true,
      rule: "semantic",
      detail: `${model || "jev"}, question version ${QUESTION_VERSION}, state ≈${estimateTokens(state)} tokens, ${batches.length} request(s) [${usage.join("; ")}]`,
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

    // A passing group still reports what the judge actually said per item, and
    // an answer at or below the undecided threshold is reported, never failed.
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
  };

  lines.push(...(await semanticLines()));
  return { lines, verdict: lines.some((line) => !line.ok) ? "FAILED" : "PASSED" };
}
