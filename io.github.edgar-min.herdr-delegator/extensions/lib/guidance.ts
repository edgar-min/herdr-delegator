/**
 * Advisory guidance delivery, and the historical run-materialized documents.
 *
 * A current run gets its role instructions from the installed packaged role
 * skills and its advisory criteria inline in the prompt (see the packaged
 * delivery section at the bottom of this file). The document renderers above it
 * remain the delivery for the two historical eras — `guidance.md` /
 * `guidance-<profile>.md` for unmarked runs, generated role skills for marked
 * ones — and the configuration-preview surface.
 *
 * Judgment criteria only reach an agent if they are delivered at the boundary
 * where the judgment happens, so this module renders two document kinds into the
 * run directory from the resolved configuration: `guidance.md` for the ORCH,
 * named by its first prompt, and `guidance-<profile>.md` for a worker lane,
 * named by the dispatch pointer. Everything here is advisory: the documents
 * carry selection criteria, execution directives, and routed-skill metadata, and
 * never scope, authority, ownership, or completion conditions.
 *
 * The renderer authors no judgment. Every content block maps 1:1 to a
 * configuration coordinate; the only renderer-owned strings are structural
 * chrome (headers, footers, section headings, moment labels, the fixed selection
 * axes line). There is no installed-presence detection of any kind — no
 * lockfile lookup and no SKILL.md disk walk. An uninstalled or unauthored skill
 * is a reader-side no-op, and a skill body resolves natively through `skill://`.
 *
 * Placement is deliberately asymmetric: `intent` renders only to the selector
 * (`guidance.md`), a worker profile's `directive` only to the selected lane,
 * and a skill's `trigger` only to the ORCH, because a worker's moment already
 * carries its timing. The orchestrator profile's own `directive` is the one
 * execution prose `guidance.md` carries, and it renders as that document's
 * first section. Absence is a no-op at every level: an unset orchestrator
 * directive renders no section, a moment with no routes renders no section,
 * and a profile with neither a directive nor routes renders no document.
 *
 * The module is non-blocking for advisory material: a render failure degrades to
 * a document that names what could not be rendered, and only a failed write is
 * reported back, as a warning, to a caller that continues regardless. The role
 * skills below are the one exception, and only in one direction: their required
 * role body is a contract, so a failed write of a marked role skill throws,
 * while the advisory half still degrades to a named warning.
 */
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_TEMPLATE_PATH, loadDelegatorConfig, readRunManifest, writeAtomic } from "./config";
import type { DelegatorConfig, SkillRoute, SkillRouteBoundary } from "./contracts";
import { ContractError, ORCH_MOMENTS, compactMessage } from "./contracts";
import { acceptProtocolDocument, packagedDelivery, roleSkillBody } from "./templates";

export const GUIDANCE_DOCUMENT_NAME = "guidance.md";

/** The per-lane document name. One profile, one document, named by the pointer. */
export function workerGuidanceDocumentName(profile: string): string {
  return `guidance-${profile}.md`;
}

/**
 * The renderer's whole fixed-string set, matching the settled golden samples.
 * These are structural chrome — document identity, section boundaries, and the
 * timing label of a moment. No judgment sentence lives here: everything a
 * reader is asked to weigh comes from configuration.
 */
const ORCH_HEADER = "# guidance.md — ORCH advisory (criteria only; changes no authority, scope, or completion condition)";
const ORCH_DIRECTIVE_SECTION = "## Orchestrator directive";
const ORCH_PROFILE_SECTION = "## Worker profile selection";
const ORCH_PROFILE_TABLE_HEAD = ["| profile | role | intent |", "| --- | --- | --- |"];
const ORCH_SELECTION_AXES = "Selection axes: specification maturity × cost of error. Bounded mechanical work goes to host OMP subagents without a lane.";
const ORCH_ROUTE_SECTION = "## Routed skills — by your judgment moment";
const ORCH_FOOTER = "An uninstalled skill is a no-op. A skill without an authored intent renders as `read skill://<name>`.";
const WORKER_HEADER_SUFFIX = "advisory for this lane's profile (criteria only; the immutable assignment is the sole contract)";
const WORKER_DIRECTIVE_SECTION = "## Directive";
const WORKER_ROUTE_SECTION = "## Skills";
const WORKER_FOOTER = "An uninstalled skill is a no-op. Read bodies via `read skill://<name>`.";
const ABSENT_CELL = "—";

/** The judgment each ORCH moment sits in front of. */
const ORCH_MOMENT_GLOSS: Record<(typeof ORCH_MOMENTS)[number], string> = {
  plan: "before freezing plan.md",
  authoring: "before finalizing an assignment",
  settlement: "before judging completion",
  reset: "when deciding a reset/handoff",
};

/**
 * Worker moments, in delivery order, with the timing label each renders under.
 * The internal boundary vocabulary is unchanged; the authored moment names
 * (`intake`, `report`) lower onto it at parse, and these labels are their
 * worker-facing display form.
 */
const WORKER_MOMENTS_IN_ORDER: ReadonlyArray<{ boundary: SkillRouteBoundary; label: string }> = [
  { boundary: "dispatch", label: "Before starting" },
  { boundary: "completion", label: "Before your completion report" },
];

/** Table- and prompt-safe single-line text. Configured prose is already bounded. */
function cell(value: string): string {
  return compactMessage(value.replace(/\|/g, "/"), ABSENT_CELL);
}

/**
 * What a routed skill does, as the documents name it. The absent-intent case is
 * the specified fallback rather than an empty cell: the reading session resolves
 * a skill body natively, so the pointer completes delivery where authored
 * metadata is missing — and no disk or lockfile is consulted to decide it.
 */
function skillIntent(config: DelegatorConfig, skill: string): string {
  const intent = config.skill_routing?.skills?.[skill]?.intent;
  return intent ? cell(intent) : `\`read skill://${skill}\``;
}

/** The skills of one moment, in rule order, each skill named once. */
function momentSkills(rules: readonly SkillRoute[], matches: (rule: SkillRoute) => boolean): string[] {
  const skills: string[] = [];
  for (const rule of rules) {
    if (!matches(rule)) continue;
    for (const skill of rule.skills) {
      if (!skills.includes(skill)) skills.push(skill);
    }
  }
  return skills;
}

/**
 * The ORCH's own moment routes. A profile-scoped rule is skipped: this reader
 * carries no worker profile, exactly as `resolveSkillRoutes` without one, so a
 * scoped route can never leak to the selector.
 */
function renderOrchRoutes(config: DelegatorConfig): string[] {
  const rules = config.skill_routing?.rules ?? [];
  const sections: string[] = [];
  for (const moment of ORCH_MOMENTS) {
    const skills = momentSkills(rules, (rule) => rule.surface === "orch" && rule.boundary === moment && !rule.profiles);
    if (!skills.length) continue;
    sections.push(`### ${moment} — ${ORCH_MOMENT_GLOSS[moment]}`, "");
    for (const skill of skills) {
      // The trigger is the ORCH's own timing criterion, so it renders only here;
      // a worker's moment label already carries the timing it needs.
      const trigger = config.skill_routing?.skills?.[skill]?.trigger;
      // A trigger is authored as its own sentence but renders as a clause, so
      // the terminal period goes and ordinary sentence capitalization is folded
      // back down. An acronym or proper noun opening (`OMP`, `ORCH`) is left
      // alone: only a capital followed by a lowercase letter is sentence case.
      const clause = cell(trigger ?? "").replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, (head) => head.toLowerCase());
      const timing = trigger ? ` (when: ${clause})` : "";
      sections.push(`- \`${skill}\` — ${skillIntent(config, skill)}${timing}`);
    }
    sections.push("");
  }
  return sections.length ? [ORCH_ROUTE_SECTION, "", ...sections] : [];
}

/**
 * The ORCH's own execution directive, as the document's first section. The
 * value is already a bounded, control-free single line from parse, and a
 * paragraph body is not a table cell, so it renders verbatim rather than
 * through `cell()`, which would rewrite an authored `|`.
 */
function renderOrchestratorDirective(config: DelegatorConfig): string[] {
  const directive = config.orchestrator.directive;
  return directive ? [ORCH_DIRECTIVE_SECTION, "", directive, ""] : [];
}

function renderProfileTable(config: DelegatorConfig): string[] {
  const rows = Object.entries(config.worker_profiles).map(([name, profile]) => {
    // `intent` is the authored field; `guidance` is the single field it
    // supersedes, rendered in its place while a layer still carries that shape.
    const intent = profile.intent ?? profile.guidance;
    return `| \`${name}\` | \`${profile.role}\` | ${intent ? cell(intent) : ABSENT_CELL} |`;
  });
  if (!rows.length) return [];
  return [ORCH_PROFILE_SECTION, "", ...ORCH_PROFILE_TABLE_HEAD, ...rows, "", ORCH_SELECTION_AXES, ""];
}

/** The ORCH's advisory blocks, in document order, shared by `guidance.md` and the ORCH role skill. */
function orchAdvisorySections(config: DelegatorConfig): string[] {
  return [...renderOrchestratorDirective(config), ...renderProfileTable(config), ...renderOrchRoutes(config)];
}

/** Renders the ORCH document from an already-resolved configuration. Never throws. */
export function renderGuidanceDocument(config: DelegatorConfig): string {
  return [ORCH_HEADER, "", ...orchAdvisorySections(config), ORCH_FOOTER, ""].join("\n");
}

/**
 * Renders one lane's document, or nothing when the profile has neither a
 * directive nor a route: an absent document is a declared no-op and the dispatch
 * pointer then names none. Never throws.
 */
export function renderWorkerGuidanceDocument(config: DelegatorConfig, profile: string): string | undefined {
  const sections = workerAdvisorySections(config, profile);
  if (!sections) return undefined;
  return [`# ${workerGuidanceDocumentName(profile)} — ${WORKER_HEADER_SUFFIX}`, "", ...sections, WORKER_FOOTER, ""].join("\n");
}

/**
 * One lane's advisory blocks, or nothing when the profile has neither a
 * directive nor a route. The caller decides what absence means: a standalone
 * document is then not written at all, while a role skill still ships its
 * required body.
 */
function workerAdvisorySections(config: DelegatorConfig, profile: string): string[] | undefined {
  const rules = config.skill_routing?.rules ?? [];
  const directive = config.worker_profiles[profile]?.directive;
  const routeLines: string[] = [];
  for (const { boundary, label } of WORKER_MOMENTS_IN_ORDER) {
    const skills = momentSkills(
      rules,
      (rule) => rule.surface === "worker" && rule.boundary === boundary && (!rule.profiles || rule.profiles.includes(profile)),
    );
    for (const skill of skills) routeLines.push(`- ${label}: \`${skill}\` — ${skillIntent(config, skill)}`);
  }
  if (!directive && !routeLines.length) return undefined;
  return [
    ...(directive ? [WORKER_DIRECTIVE_SECTION, "", cell(directive), ""] : []),
    ...(routeLines.length ? [WORKER_ROUTE_SECTION, "", ...routeLines, ""] : []),
  ];
}

/** The degrade rendering: the document exists and names what could not be rendered. */
export function renderGuidanceFailure(reason: string): string {
  return [
    ORCH_HEADER,
    "",
    "## Unavailable",
    "",
    `This document could not be rendered from configuration: ${compactMessage(reason, "unknown error")}`,
    "",
    "Nothing is gated by this. Work from the mandate, `plan.md`, and `protocol-orch.md`, and read the delegator configuration directly if profile criteria matter.",
    "",
  ].join("\n");
}

/**
 * Writes `guidance.md` into the run directory. Best-effort by contract: a render
 * failure becomes a degraded document, and a write failure becomes the returned
 * warning. The caller's control flow never depends on either.
 */
export async function materializeGuidance(runPath: string): Promise<{ path: string; warning?: string }> {
  const target = path.join(runPath, GUIDANCE_DOCUMENT_NAME);
  let document: string;
  try {
    const manifest = await readRunManifest(runPath);
    const { config } = await loadDelegatorConfig(runPath, manifest.cwd);
    document = renderGuidanceDocument(config);
  } catch (error: unknown) {
    document = renderGuidanceFailure(error instanceof Error ? error.message : String(error));
  }
  try {
    await writeAtomic(target, document);
  } catch (error: unknown) {
    return {
      path: target,
      warning: compactMessage(
        `guidance.md could not be written (${error instanceof Error ? error.message : String(error)}); the ORCH is born without the advisory guidance document.`,
        "guidance.md could not be written.",
      ),
    };
  }
  return { path: target };
}

/**
 * Writes `guidance-<profile>.md` into the run directory and returns its path for
 * the dispatch pointer. Absence is a no-op: a profile the configuration gives
 * neither a directive nor a route yields no document and no path, and any
 * failure yields a warning instead of a thrown error, so a dispatch is never
 * gated on advisory material.
 */
export async function materializeWorkerGuidance(
  runPath: string,
  profile: string,
): Promise<{ path?: string; warning?: string }> {
  let document: string | undefined;
  try {
    const manifest = await readRunManifest(runPath);
    const { config } = await loadDelegatorConfig(runPath, manifest.cwd);
    document = renderWorkerGuidanceDocument(config, profile);
  } catch (error: unknown) {
    return {
      warning: compactMessage(
        `${workerGuidanceDocumentName(profile)} could not be rendered (${error instanceof Error ? error.message : String(error)}); the lane is dispatched without its advisory document.`,
        "The lane advisory document could not be rendered.",
      ),
    };
  }
  if (!document) return {};
  const target = path.join(runPath, workerGuidanceDocumentName(profile));
  try {
    await writeAtomic(target, document);
  } catch (error: unknown) {
    return {
      warning: compactMessage(
        `${workerGuidanceDocumentName(profile)} could not be written (${error instanceof Error ? error.message : String(error)}); the lane is dispatched without its advisory document.`,
        "The lane advisory document could not be written.",
      ),
    };
  }
  return { path: target };
}

// ---------------------------------------------------------------------------
// Role skills.
//
// A marked role template is a complete role skill on its own, so a supported
// session reads ONE run-local document instead of a common protocol, a role
// protocol and an advisory document. The generated artifact is that template's
// body with this run's advisory configuration appended beneath it: same
// criteria, same asymmetry, same authority limits as the standalone documents,
// delivered where the reading already happens rather than behind a second
// pointer. These are explicit paths under the run, not globally discovered
// skill names, so nothing here registers a name or scans a directory.
// ---------------------------------------------------------------------------

export const ROLE_SKILL_ROOT = "role-skills";
export const ORCH_ROLE_SKILL_PATH = path.join(ROLE_SKILL_ROOT, "orchestrator", "SKILL.md");

/** One lane, one generated skill. The worker id is the registry's own lane identity, never a new one. */
export function workerRoleSkillPath(workerId: string): string {
  return path.join(ROLE_SKILL_ROOT, "workers", workerId, "SKILL.md");
}

const ROLE_ADVISORY_SECTION = "## Advisory configuration";
const ROLE_ADVISORY_NOTE = "Rendered from the delegator configuration when this document was generated. Criteria only: it changes no authority, scope, ownership, or completion condition.";
const ROLE_ADVISORY_ABSENT = "No directive or skill route is configured for this role. The instructions above are the whole contract.";

/** Body first, advisory beneath: the required half never moves, whatever configuration says. */
function roleSkillDocument(body: string, advisory: string[]): string {
  return [body.replace(/\s+$/, ""), "", ROLE_ADVISORY_SECTION, "", ROLE_ADVISORY_NOTE, "", ...advisory].join("\n");
}

export function renderOrchRoleSkill(body: string, config: DelegatorConfig): string {
  const sections = orchAdvisorySections(config);
  return roleSkillDocument(body, sections.length ? [...sections, ORCH_FOOTER, ""] : [ROLE_ADVISORY_ABSENT, ""]);
}

/**
 * The lane's own profile text and nothing else — an unknown profile and an
 * advisory-free one both still get the required worker contract, which is the
 * difference between this and the standalone `guidance-<profile>.md`.
 */
export function renderWorkerRoleSkill(body: string, config: DelegatorConfig, profile: string | undefined): string {
  const sections = profile ? workerAdvisorySections(config, profile) : undefined;
  return roleSkillDocument(body, sections ? [...sections, WORKER_FOOTER, ""] : [ROLE_ADVISORY_ABSENT, ""]);
}

/** The degrade rendering: the role contract is intact and the document says what configuration could not be read. */
export function renderRoleSkillAdvisoryFailure(body: string, reason: string): string {
  return roleSkillDocument(body, [
    `The advisory configuration could not be rendered: ${compactMessage(reason, "unknown error")}`,
    "",
    "Nothing above is gated by it. Read the delegator configuration directly if profile criteria or skill routes matter.",
    "",
  ]);
}

/**
 * Generates one role skill from the run's own backing protocol document, or
 * reports that this run has none: an unmarked historical document yields no
 * path, and its caller keeps the pointers that run was created with. A marked
 * document is a contract, so only its advisory half may degrade — a failed
 * write throws the same storage error shape the rest of the run layout uses.
 */
async function materializeRoleSkill(
  runPath: string,
  templateName: string,
  relativePath: string,
  render: (body: string, config: DelegatorConfig) => string,
): Promise<{ path?: string; warning?: string }> {
  let body: string | undefined;
  try {
    body = roleSkillBody(templateName, await readFile(path.join(runPath, templateName)));
  } catch {
    return {};
  }
  if (!body) return {};
  let document: string;
  let warning: string | undefined;
  try {
    const manifest = await readRunManifest(runPath);
    const { config } = await loadDelegatorConfig(runPath, manifest.cwd);
    document = render(body, config);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    document = renderRoleSkillAdvisoryFailure(body, reason);
    warning = compactMessage(
      `${relativePath} was generated without its advisory configuration (${reason}); the required role instructions are complete.`,
      "The role skill was generated without its advisory configuration.",
    );
  }
  const target = path.join(runPath, relativePath);
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeAtomic(target, document);
  } catch (error: unknown) {
    throw new ContractError(
      "role_skill_write_failed",
      `${relativePath} could not be written (${error instanceof Error ? error.message : String(error)}); the session would be started without its role instructions.`,
      "storage",
      { recovery: "Preserve the run and fix the storage failure, then retry the identical call: the role skill is required instructions, not advisory material." },
    );
  }
  return { path: target, ...(warning ? { warning } : {}) };
}

/** The ORCH's generated role skill, refreshed at every spawn so a revived session gets the current configuration. */
export async function materializeOrchRoleSkill(runPath: string): Promise<{ path?: string; warning?: string }> {
  return await materializeRoleSkill(runPath, "protocol-orch.md", ORCH_ROLE_SKILL_PATH, renderOrchRoleSkill);
}

/** The lane's generated role skill, refreshed at every dispatch, including FIFO promotion. */
export async function materializeWorkerRoleSkill(
  runPath: string,
  workerId: string,
  profile: string | undefined,
): Promise<{ path?: string; warning?: string }> {
  return await materializeRoleSkill(
    runPath,
    "protocol-worker.md",
    workerRoleSkillPath(workerId),
    (body, config) => renderWorkerRoleSkill(body, config, profile),
  );
}

// ---------------------------------------------------------------------------
// Packaged role-skill delivery.
//
// A run whose backing record carries the packaged marker materializes no role
// or guidance artifact at all. Its sessions are pointed at the installed
// packaged skill of the running package, and the configured advisory criteria
// ride inline in the same prompt — the audience split is unchanged: the ORCH
// sees its own directive, the profile table and its own routes, a lane sees
// only its own profile's directive and matching routes.
//
// The role document is required instructions, so its resolution fails closed:
// a missing or unreadable packaged skill, or a profile with no packaged skill,
// throws before any prompt-side effect. Only the advisory half degrades.
// ---------------------------------------------------------------------------

/** The installed package's `skills/` directory, resolved from this module, never from a name lookup. */
export const PACKAGED_SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills");

export const ORCH_PACKAGED_SKILL = "herdr-orch";

/**
 * The three real worker profiles and the packaged skill each receives. There is
 * no default base for an unrecognized name: the configuration parser still
 * accepts arbitrary profile keys, and a run that reaches dispatch with one gets
 * a visible failure rather than silently borrowing another role's instructions.
 */
export const WORKER_PACKAGED_SKILLS: Record<string, string> = {
  default: "herdr-default-worker",
  task: "herdr-task-worker",
  slow: "herdr-slow-worker",
};

export type PackagedDelivery = { skillPath: string; advisory?: string; warning?: string };

const INLINE_ADVISORY_LEAD = "Advisory configuration, criteria only — it changes no authority, scope, ownership, or completion condition:";

/** One prompt-embedded advisory block, or nothing when configuration authored none. */
function inlineAdvisory(sections: string[] | undefined, footer: string): string | undefined {
  if (!sections || !sections.length) return undefined;
  return [INLINE_ADVISORY_LEAD, "", ...sections, footer].join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The one required-input boundary every delivery decision goes through.
 *
 * Classification is only meaningful over bytes this project has actually
 * shipped, so the record is read as a canonical regular file and validated by
 * the existing installed/historical acceptance rule BEFORE it is classified.
 * A missing, unreadable, non-canonical or unknown record is therefore a closed
 * failure, never "historical": the previous shape returned `false` on any read
 * error and let a tampered or absent record select the legacy renderer.
 *
 * Historical acceptance is unchanged: an older shipped digest is accepted and
 * its named drift warning returned for the caller to surface.
 */
export async function requireBackingRecord(runPath: string, templateName: string): Promise<{ packaged: boolean; warning?: string }> {
  const target = path.join(runPath, templateName);
  let existing: Buffer;
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(target)) !== target) throw new Error("not a canonical regular file");
    existing = await readFile(target);
  } catch (error: unknown) {
    throw new ContractError(
      "backing_record_unavailable",
      `${templateName} is missing or not a canonical readable regular file in this run (${error instanceof Error ? error.message : String(error)}); which role instructions this run delivers cannot be decided.`,
      "storage",
      { recovery: `Restore the run's own ${templateName} — it is the accepted record that selects delivery — and retry the identical call. A run is never dispatched on a guessed delivery contract.` },
    );
  }
  const acceptance = acceptProtocolDocument(templateName, existing, await readFile(path.join(path.dirname(PROTOCOL_TEMPLATE_PATH), templateName)));
  return { packaged: packagedDelivery(templateName, existing), ...(acceptance.warning ? { warning: acceptance.warning } : {}) };
}

/** The installed packaged skill path, proved readable, or a closed failure. */
async function requirePackagedSkill(skill: string, role: string): Promise<string> {
  const target = path.join(PACKAGED_SKILL_DIR, skill, "SKILL.md");
  try {
    await readFile(target);
  } catch (error: unknown) {
    throw new ContractError(
      "role_skill_unavailable",
      `The installed ${role} skill ${skill} could not be read at ${target} (${error instanceof Error ? error.message : String(error)}); the session would be started without its role instructions.`,
      "storage",
      { recovery: "Reinstall or repair the herdr-delegator package so its skills/ directory is complete, then retry the identical call. Role instructions are required, not advisory." },
    );
  }
  return target;
}

/** The advisory half: never blocking, and a failed configuration read is a named warning. */
async function inlineAdvisoryFor(
  runPath: string,
  render: (config: DelegatorConfig) => string | undefined,
  subject: string,
): Promise<{ advisory?: string; warning?: string }> {
  try {
    const manifest = await readRunManifest(runPath);
    const { config } = await loadDelegatorConfig(runPath, manifest.cwd);
    return { advisory: render(config) };
  } catch (error: unknown) {
    return {
      warning: compactMessage(
        `${subject} was delivered without its advisory configuration (${error instanceof Error ? error.message : String(error)}); the required role instructions are complete.`,
        "The prompt was delivered without its advisory configuration.",
      ),
    };
  }
}

/**
 * The ORCH's packaged delivery, or `undefined` when this run's accepted backing
 * record belongs to a historical era and its existing delivery stands. An
 * unreadable or unaccepted record throws instead of choosing an era.
 */
export async function orchPackagedDelivery(runPath: string): Promise<PackagedDelivery | undefined> {
  const backing = await requireBackingRecord(runPath, "protocol-orch.md");
  if (!backing.packaged) return undefined;
  const skillPath = await requirePackagedSkill(ORCH_PACKAGED_SKILL, "orchestrator");
  const { advisory, warning } = await inlineAdvisoryFor(
    runPath,
    (config) => inlineAdvisory(orchAdvisorySections(config), ORCH_FOOTER),
    "The orchestrator prompt",
  );
  // The record's own drift warning is the spawn's `template_drift_warning`,
  // raised by the caller that already read it; only the advisory warning is new here.
  return { skillPath, ...(advisory ? { advisory } : {}), ...(warning ? { warning } : {}) };
}

/**
 * One lane's packaged delivery, or `undefined` for an accepted historical run.
 * Both inputs are required instructions here: the backing record must be
 * readable and accepted before it is classified, and the profile must select an
 * installed packaged skill. Either failure is closed, so no caller can reach a
 * prompt on a guessed contract.
 */
export async function workerPackagedDelivery(
  runPath: string,
  profile: string | undefined,
): Promise<(PackagedDelivery & { backingWarning?: string }) | undefined> {
  const backing = await requireBackingRecord(runPath, "protocol-worker.md");
  if (!backing.packaged) return undefined;
  const skill = profile ? WORKER_PACKAGED_SKILLS[profile] : undefined;
  if (!skill) {
    throw new ContractError(
      "worker_profile_unsupported",
      profile
        ? `Worker profile ${profile} has no packaged role skill; the packaged worker skills are ${Object.keys(WORKER_PACKAGED_SKILLS).join(", ")}.`
        : "The lane's assignment profile could not be resolved, so no packaged worker skill can be selected.",
      "select",
      {
        recovery: profile
          ? `Register the assignment with one of ${Object.keys(WORKER_PACKAGED_SKILLS).join(", ")}. An unrecognized profile is never silently given another role's instructions.`
          : "Repair or re-read the assignment artifact so its profile resolves, then retry the dispatch.",
      },
    );
  }
  const skillPath = await requirePackagedSkill(skill, "worker");
  const { advisory, warning } = await inlineAdvisoryFor(
    runPath,
    (config) => inlineAdvisory(workerAdvisorySections(config, profile as string), WORKER_FOOTER),
    "The assignment prompt",
  );
  return {
    skillPath,
    ...(advisory ? { advisory } : {}),
    ...(warning ? { warning } : {}),
    ...(backing.warning ? { backingWarning: backing.warning } : {}),
  };
}
