import { isUtf8 } from "node:buffer";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  CLAIM_COLUMNS,
  CLAIM_DISPOSITIONS,
  CLAIM_SHA_RE,
  McpContractError,
  SUCCESSION_CLAIMS_HEADING,
  SUCCESSION_DOCUMENT_NAME,
  type ClaimDisposition,
  type InheritedClaim,
} from "./contracts";

// ---------------------------------------------------------------------------
// Succession claim gate (M5 Phase A, friction a421acd8c19127be). LIFE-008 says a
// reset copies planning context, not truth, and that inherited evidence must be
// revalidated — but nothing enforced it anywhere, because the machine could not
// even find the document: every succession so far wrote its handoff under a
// filename its author chose. This module supplies the two missing halves, and
// only those: the canonical coordinate, and a claim grammar a parser can judge.
//
// What is decidable is presentation, never truth. An author who writes a real
// coordinate, a real command, and the current HEAD still passes with a wrong
// conclusion; this gate is not prevention. What it buys is that a load-bearing
// claim either carries the coordinate and command that make re-measuring it
// cheap, or is published as `unverified` — the successor then reads that the
// claim was never checked instead of inheriting it as fact.
//
// The gate never executes the `command` column. Running author-supplied strings
// would turn a document into an arbitrary execution surface; the command is
// there so a human or a successor can re-run it, and P-4 pins the non-execution.
// ---------------------------------------------------------------------------

/** The canonical succession coordinate. Author-chosen filenames are not promoted. */
export function successionDocumentPath(runPath: string): string {
  return path.join(runPath, SUCCESSION_DOCUMENT_NAME);
}

// Bounds. The document is human-written, so every rejection names the observed
// size against the published bound rather than failing as "malformed".
const MAX_SUCCESSION_BYTES = 256 * 1024;
const MAX_CLAIM_ROWS = 256;
const MAX_CELL_BYTES = 1_024;
// Read-only HEAD observation, same shape of boundary as the OBS-004 git audit.
const HEAD_TIMEOUT_MS = 2_000;
const MAX_HEAD_OUTPUT_BYTES = 4_096;

const CLAIM_HEADING_RE = new RegExp(`^#{2,4}[ \\t]+${SUCCESSION_CLAIMS_HEADING}[ \\t]*$`);
const ANY_HEADING_RE = /^#{1,6}[ \t]/;
const DELIMITER_CELL_RE = /^:?-+:?$/;
// ISO-8601 with an explicit zone: a local-time stamp cannot be compared with
// anything, so the zone is part of the grammar rather than an assumption.
const OBSERVED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
// A repo-relative or run-relative path, optionally with `:<line>`. Absolute
// paths and `..` segments are refused: a coordinate a reader cannot resolve from
// the repository or the run is not a coordinate.
const COORDINATE_RE = /^[A-Za-z0-9._@~-][A-Za-z0-9._@~\-/ ]*(?::\d{1,9})?$/;
// Vocabulary that makes a claim a compatibility claim. A one-directional
// compatibility claim is exactly how this project shipped a label grammar that
// the previous version could not read (9facc09): "the new reader accepts it" was
// measured, "the old reader accepts it" was never asked.
const COMPATIBILITY_RE = /compat|version|backward|forward|legacy|older|newer|호환|버전/i;
export const CLAIM_DIRECTIONS = ["old->new", "new->old"] as const;
export type ClaimDirection = (typeof CLAIM_DIRECTIONS)[number];

export type ClaimRowResult = { ok: true; claim: InheritedClaim } | { ok: false; reason: string };
export type ClaimTableFailure = { reason: string; row?: number; claim?: string };
export type ClaimTableResult = {
  /** Whether the document carries the canonical claims section at all. */
  present: boolean;
  claims: InheritedClaim[];
  failures: ClaimTableFailure[];
};

/**
 * Splits one Markdown table row into its cells. `\|` is a literal pipe, so a
 * command column may carry a shell pipeline; a backticked cell is unwrapped, and
 * a lone `-` is the conventional blank rather than a value.
 */
function splitRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.at(-2) === "\\") return undefined;
  const inner = trimmed.slice(1, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === "\\" && inner[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => normalizeCell(cell));
}

function normalizeCell(cell: string): string {
  let value = cell.trim();
  if (value.length > 1 && value.startsWith("`") && value.endsWith("`")) value = value.slice(1, -1).trim();
  return value === "-" || value === "—" ? "" : value;
}

function oversized(cells: readonly string[]): string | undefined {
  for (let index = 0; index < cells.length; index += 1) {
    const bytes = Buffer.byteLength(cells[index]);
    if (bytes > MAX_CELL_BYTES) return `the ${CLAIM_COLUMNS[index]} cell is ${bytes} bytes; the bound is ${MAX_CELL_BYTES}`;
  }
  return undefined;
}

/**
 * Judges one claim row. The disposition vocabulary is closed at three values, so
 * a claim that is neither measured nor explicitly unverified has no legal cell to
 * hide in: that third state is what let quantitative claims travel as facts.
 */
export function parseClaimRow(line: string): ClaimRowResult {
  const cells = splitRow(line);
  if (!cells) return { ok: false, reason: "the row is not a `|`-delimited table row" };
  if (cells.length !== CLAIM_COLUMNS.length) {
    return { ok: false, reason: `the row has ${cells.length} cells; the grammar is exactly ${CLAIM_COLUMNS.length}: | ${CLAIM_COLUMNS.join(" | ")} |` };
  }
  const bound = oversized(cells);
  if (bound) return { ok: false, reason: bound };
  const [claim, coordinate, command, observed, disposition] = cells;
  const resolved = CLAIM_DISPOSITIONS.find((value) => value === disposition);
  if (!resolved) {
    return { ok: false, reason: `disposition ${disposition ? `"${disposition}"` : "is empty and"} is outside the closed vocabulary ${CLAIM_DISPOSITIONS.join(" | ")}` };
  }
  if (!claim) return { ok: false, reason: "the claim cell is empty; every row states one load-bearing claim" };
  if (coordinate && !COORDINATE_RE.test(coordinate)) {
    return { ok: false, reason: `coordinate "${coordinate}" is not a repo-relative or run-relative path, optionally with :<line>` };
  }
  if (resolved === "measured") {
    if (!coordinate) return { ok: false, reason: "a measured claim needs the coordinate a reader can open" };
    if (!command) return { ok: false, reason: "a measured claim needs the command that produced its observation" };
    if (!observed) return { ok: false, reason: "a measured claim needs observed as `<40-hex sha> <ISO-8601>`" };
  }
  // The one lie the grammar forecloses: an unverified claim cannot carry a
  // command, so "I did not run this" cannot be written as if something ran.
  if (resolved === "unverified" && command) {
    return { ok: false, reason: "an unverified claim must leave command empty; a claim with a command is measured or withdrawn" };
  }
  let parsedObserved: { sha: string; at: string } | undefined;
  if (observed) {
    const parts = observed.split(/[ \t]+/);
    if (parts.length !== 2) return { ok: false, reason: `observed "${observed}" is not exactly \`<40-hex sha> <ISO-8601>\`` };
    const [sha, at] = parts;
    if (!CLAIM_SHA_RE.test(sha)) return { ok: false, reason: `observed sha "${sha}" is not a 40-hex Git object name` };
    if (!OBSERVED_AT_RE.test(at) || Number.isNaN(Date.parse(at))) {
      return { ok: false, reason: `observed timestamp "${at}" is not an ISO-8601 instant with an explicit zone` };
    }
    parsedObserved = { sha, at };
  }
  return {
    ok: true,
    claim: {
      claim,
      disposition: resolved,
      ...(coordinate ? { coordinate } : {}),
      ...(command ? { command } : {}),
      ...(parsedObserved ? { observed: parsedObserved } : {}),
    },
  };
}

/** Direction tokens a compatibility claim carries, `→` read as `->`. */
function directionsIn(claim: string): ClaimDirection[] {
  const normalized = claim.replace(/→/g, "->").toLowerCase();
  const found: ClaimDirection[] = [];
  for (const direction of CLAIM_DIRECTIONS) {
    let index = normalized.indexOf(direction);
    while (index !== -1) {
      found.push(direction);
      index = normalized.indexOf(direction, index + 1);
    }
  }
  return found;
}

/**
 * Parses the canonical section. A document without it is not a claim-bearing
 * succession document — the section, not the file, is what the gate judges, so
 * every handoff written before this grammar existed keeps its old behavior
 * exactly. A declared section with no table is the half-written case and fails.
 */
export function parseClaimTable(document: string): ClaimTableResult {
  const lines = document.replace(/\r\n?/g, "\n").split("\n");
  const headings = lines.map((line, index) => (CLAIM_HEADING_RE.test(line) ? index : -1)).filter((index) => index !== -1);
  if (!headings.length) return { present: false, claims: [], failures: [] };
  if (headings.length > 1) {
    return {
      present: true,
      claims: [],
      failures: [{ reason: `the document carries ${headings.length} "${SUCCESSION_CLAIMS_HEADING}" headings (lines ${headings.map((index) => index + 1).join(", ")}); exactly one section is canonical` }],
    };
  }
  const start = headings[0] + 1;
  let tableStart = -1;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (ANY_HEADING_RE.test(line)) break;
    if (line.trim().startsWith("|")) {
      tableStart = index;
      break;
    }
  }
  if (tableStart === -1) {
    return {
      present: true,
      claims: [],
      failures: [{ reason: `the "${SUCCESSION_CLAIMS_HEADING}" section declares no table; it needs the header row | ${CLAIM_COLUMNS.join(" | ")} |` }],
    };
  }
  const table: string[] = [];
  for (let index = tableStart; index < lines.length && lines[index].trim().startsWith("|"); index += 1) table.push(lines[index]);
  const failures: ClaimTableFailure[] = [];
  const header = splitRow(table[0]);
  if (!header || header.length !== CLAIM_COLUMNS.length || header.some((cell, index) => cell.toLowerCase() !== CLAIM_COLUMNS[index])) {
    failures.push({ reason: `the header row is not exactly | ${CLAIM_COLUMNS.join(" | ")} |` });
  }
  const delimiter = table.length > 1 ? splitRow(table[1]) : undefined;
  if (!delimiter || delimiter.length !== CLAIM_COLUMNS.length || delimiter.some((cell) => !DELIMITER_CELL_RE.test(cell))) {
    failures.push({ reason: `the header row must be followed by a ${CLAIM_COLUMNS.length}-cell delimiter row such as |---|---|---|---|---|` });
  }
  if (failures.length) return { present: true, claims: [], failures };
  const rows = table.slice(2);
  if (rows.length > MAX_CLAIM_ROWS) {
    return { present: true, claims: [], failures: [{ reason: `the table carries ${rows.length} claim rows; the bound is ${MAX_CLAIM_ROWS}` }] };
  }
  const claims: InheritedClaim[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const parsed = parseClaimRow(rows[index]);
    if (parsed.ok) {
      claims.push(parsed.claim);
      continue;
    }
    const cells = splitRow(rows[index]);
    failures.push({ row: index + 1, ...(cells?.[0] ? { claim: cells[0] } : {}), reason: parsed.reason });
  }
  // Direction completeness. A withdrawn claim carries no weight, so it is not
  // asked for its counter-direction. A claim that names a direction at all is
  // directional whether or not it uses the vocabulary: "readable old->new" is
  // the exact shape of the failure this rule exists for, and it happens to
  // contain none of the words below.
  const compatibility = claims.filter((claim) => claim.disposition !== "withdrawn" && (COMPATIBILITY_RE.test(claim.claim) || directionsIn(claim.claim).length > 0));
  const covered = new Set<ClaimDirection>();
  let malformedDirection = false;
  for (const claim of compatibility) {
    const directions = directionsIn(claim.claim);
    if (directions.length !== 1) {
      failures.push({
        claim: claim.claim,
        reason: directions.length
          ? `a compatibility claim names ${directions.length} direction tokens; one row states exactly one of ${CLAIM_DIRECTIONS.join(" or ")}`
          : `a compatibility or version claim must state its direction as ${CLAIM_DIRECTIONS.join(" or ")}; this row states none`,
      });
      malformedDirection = true;
      continue;
    }
    covered.add(directions[0]);
  }
  // A row that could not state its own direction has already been named; adding
  // "both directions are missing" on top of it would bury the actionable line.
  if (compatibility.length && !malformedDirection) {
    for (const direction of CLAIM_DIRECTIONS) {
      if (!covered.has(direction)) {
        failures.push({ reason: `no row carries the ${direction} direction; a compatibility claim is only complete when both directions are stated` });
      }
    }
  }
  return { present: true, claims, failures };
}

export type SuccessionObservation = {
  document: string;
  rows: number;
  dispositions: Record<ClaimDisposition, number>;
  head_sha?: string;
  freshness_skipped?: string;
};

export type HeadObservation = { sha: string } | { skip: string };

/**
 * Observes HEAD with read-only Git in the run's project directory. Freshness is
 * the one check that needs the world outside the document, so its absence is
 * fail-open in the OBS-004 sense: a directory outside any work tree, a Git that
 * errors, or unreadable output skips the sha comparison under a named warning
 * while every syntactic check above still refuses. A run whose project directory
 * is not a repository must not become unable to dispatch work.
 */
export async function observeHeadSha(cwd: string): Promise<HeadObservation> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, HEAD_TIMEOUT_MS);
  try {
    const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
    if (timedOut) return { skip: `succession_head_timeout: git rev-parse did not finish within the ${HEAD_TIMEOUT_MS} ms abort boundary` };
    if (exitCode !== 0) {
      return { skip: `succession_head_command_failed: git rev-parse HEAD exited ${exitCode} in ${cwd}, which is also what a directory outside any Git work tree reports` };
    }
    if (stdout.byteLength > MAX_HEAD_OUTPUT_BYTES) {
      return { skip: `succession_head_output_invalid: git rev-parse produced ${stdout.byteLength} bytes, above the ${MAX_HEAD_OUTPUT_BYTES}-byte bound` };
    }
    const bytes = Buffer.from(stdout);
    const sha = isUtf8(bytes) ? bytes.toString("utf8").trim() : "";
    if (!CLAIM_SHA_RE.test(sha)) return { skip: "succession_head_output_invalid: git rev-parse HEAD did not print a 40-hex object name" };
    return { sha };
  } catch (error) {
    return timedOut
      ? { skip: `succession_head_timeout: git rev-parse was aborted at the ${HEAD_TIMEOUT_MS} ms boundary` }
      : { skip: `succession_head_exception: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the canonical document, or nothing when the trigger is absent. */
async function readSuccessionDocument(documentPath: string): Promise<string | undefined> {
  let size: number;
  try {
    const file = await lstat(documentPath);
    if (!file.isFile() || file.isSymbolicLink() || (await realpath(documentPath)) !== documentPath) return undefined;
    size = file.size;
  } catch {
    return undefined;
  }
  if (size > MAX_SUCCESSION_BYTES) {
    throw new McpContractError(
      "succession_claims_unparsable",
      `${documentPath} is ${size} bytes, above the ${MAX_SUCCESSION_BYTES}-byte bound, so its claims cannot be read.`,
      "validate",
      `Split the succession document until it fits ${MAX_SUCCESSION_BYTES} bytes; the claims section is what must stay readable.`,
    );
  }
  const bytes = await readFile(documentPath);
  if (!isUtf8(bytes)) {
    throw new McpContractError(
      "succession_claims_unparsable",
      `${documentPath} is not valid UTF-8, so its claims cannot be read.`,
      "validate",
      "Rewrite the succession document as UTF-8 with LF line endings, then retry the identical add.",
    );
  }
  return bytes.toString("utf8");
}

/**
 * The gate. It fires only when the canonical document exists as a regular file
 * and carries the canonical section, and it persists nothing: a passed gate is
 * returned as an observation and deliberately not written into the registry,
 * because "the gate passed" recorded as state is the same category SRT-004 and
 * COM-004 forbid — a route, or a check, replayed later as proof.
 */
export async function assertSuccessionClaims(runPath: string, cwd: string): Promise<SuccessionObservation | undefined> {
  const documentPath = successionDocumentPath(runPath);
  const document = await readSuccessionDocument(documentPath);
  if (document === undefined) return undefined;
  const table = parseClaimTable(document);
  if (!table.present) return undefined;
  if (table.failures.length) {
    const named = table.failures
      .map((failure) => `${failure.row ? `row ${failure.row}` : "table"}${failure.claim ? ` ("${failure.claim.slice(0, 120)}")` : ""}: ${failure.reason}`)
      .join("; ");
    throw new McpContractError(
      "succession_claims_unparsable",
      `The inherited claims in ${documentPath} cannot be judged: ${named}.`,
      "validate",
      `Fix the named rows in the "${SUCCESSION_CLAIMS_HEADING}" section of ${documentPath}. The table is exactly | ${CLAIM_COLUMNS.join(" | ")} | with a delimiter row; disposition is one of ${CLAIM_DISPOSITIONS.join(", ")}. A measured row states coordinate, command, and observed as \`<40-hex sha> <ISO-8601>\`; an unverified row leaves command empty and says so honestly; a withdrawn row needs only the claim. A compatibility or version claim needs one row per direction (${CLAIM_DIRECTIONS.join(", ")}). Nothing in the command column is ever executed by this tool — re-run it yourself and record what you saw.`,
    );
  }
  const dispositions: Record<ClaimDisposition, number> = { measured: 0, unverified: 0, withdrawn: 0 };
  for (const claim of table.claims) dispositions[claim.disposition] += 1;
  const measured = table.claims.filter((claim) => claim.disposition === "measured" && claim.observed);
  if (!measured.length) return { document: documentPath, rows: table.claims.length, dispositions };
  const head = await observeHeadSha(cwd);
  if ("skip" in head) {
    return { document: documentPath, rows: table.claims.length, dispositions, freshness_skipped: head.skip };
  }
  const stale = measured.filter((claim) => claim.observed?.sha !== head.sha);
  if (stale.length) {
    throw new McpContractError(
      "succession_claim_stale",
      `${stale.length} measured claim(s) in ${documentPath} were observed at a different commit than HEAD ${head.sha}: ${stale.map((claim) => `"${claim.claim.slice(0, 120)}" observed at ${claim.observed?.sha}`).join("; ")}.`,
      "validate",
      `Re-run each named claim's command at HEAD ${head.sha} and update its observed cell to \`${head.sha} <ISO-8601>\`, or downgrade the row to unverified with an empty command — inherited evidence is revalidated, not carried (LIFE-008). Editing the sha without re-running the command is the one repair this gate cannot see.`,
    );
  }
  return { document: documentPath, rows: table.claims.length, dispositions, head_sha: head.sha };
}
