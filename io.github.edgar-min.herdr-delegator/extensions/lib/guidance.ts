/**
 * Advisory guidance and packaged role-skill delivery.
 *
 * A run's role instructions are the installed packaged skill of the running
 * package, and its configured advisory criteria ride inline in the same prompt.
 * Nothing is written into the run directory: there is one delivery path, so no
 * generated artifact can drift from the configuration it was rendered at, and
 * the same renderer serves the prompt and the configuration preview.
 *
 * Judgment criteria only reach an agent if they are delivered at the boundary
 * where the judgment happens, so these blocks are rendered from the resolved
 * configuration into the prompt itself, with the audience split intact: the
 * ORCH sees its own directive, the worker-profile table and its own routes; a
 * lane sees only its own profile's directive and matching routes. Everything
 * here is advisory — selection criteria, execution directives, and routed-skill
 * metadata — and never scope, authority, ownership, or completion conditions.
 *
 * The renderer authors no judgment. Every content block maps 1:1 to a
 * configuration coordinate; the only renderer-owned strings are structural
 * chrome (the advisory lead, section headings, moment labels, the fixed
 * selection axes line, the footers). There is no installed-presence detection
 * of any kind — no lockfile lookup and no SKILL.md disk walk for a routed
 * skill. An uninstalled or unauthored skill is a reader-side no-op, and a skill
 * body resolves natively through `skill://`.
 *
 * Placement is deliberately asymmetric: `intent` renders only to the selector,
 * a worker profile's `directive` only to the selected lane, and a skill's
 * `trigger` only to the ORCH, because a worker's moment already carries its
 * timing. Absence is a no-op at every level: an unset orchestrator directive
 * renders no section, a moment with no routes renders no section, and a role
 * with neither a directive nor a route renders no advisory block at all.
 *
 * Required and advisory fail differently. The role document is required
 * instructions, so its resolution fails closed: a missing or unreadable
 * packaged skill, or a profile that names none, throws before any prompt-side
 * effect. Only the advisory half degrades, to a named warning on a prompt that
 * still goes out.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDelegatorConfig, readRunManifest } from "./config";
import type { DelegatorConfig, SkillRoute, SkillRouteBoundary } from "./contracts";
import { ContractError, ORCH_MOMENTS, compactMessage } from "./contracts";

/**
 * The renderer's whole fixed-string set. These are structural chrome — section
 * boundaries and the timing label of a moment. No judgment sentence lives here:
 * everything a reader is asked to weigh comes from configuration.
 */
const ORCH_DIRECTIVE_SECTION = "## Orchestrator directive";
const ORCH_PROFILE_SECTION = "## Worker profile selection";
const ORCH_PROFILE_TABLE_HEAD = ["| profile | role | intent |", "| --- | --- | --- |"];
const ORCH_SELECTION_AXES = "Selection axes: specification maturity × cost of error. Bounded mechanical work goes to host OMP subagents without a lane.";
const ORCH_ROUTE_SECTION = "## Routed skills — by your judgment moment";
const ORCH_FOOTER = "An uninstalled skill is a no-op. A skill without an authored intent renders as `read skill://<name>`.";
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
 * What a routed skill does, as the prompt names it. The absent-intent case is
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
 * The ORCH's own execution directive, as the advisory's first section. The
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

/** The ORCH's advisory blocks, in order. */
function orchAdvisorySections(config: DelegatorConfig): string[] {
  return [...renderOrchestratorDirective(config), ...renderProfileTable(config), ...renderOrchRoutes(config)];
}

/**
 * One lane's advisory blocks, or nothing when the profile has neither a
 * directive nor a route: the lane is then prompted with its required skill and
 * no advisory at all.
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

const INLINE_ADVISORY_LEAD = "Advisory configuration, criteria only — it changes no authority, scope, ownership, or completion condition:";

/** One prompt-embedded advisory block, or nothing when configuration authored none. */
function advisoryBlock(sections: string[] | undefined, footer: string): string | undefined {
  if (!sections || !sections.length) return undefined;
  return [INLINE_ADVISORY_LEAD, "", ...sections, footer].join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The ORCH's advisory block, exactly as a first prompt carries it, or nothing
 * when configuration authored none. Pure: it takes an already-resolved
 * configuration, reads nothing, writes nothing, and never throws, so a
 * configuration surface can preview the bytes a spawn would deliver.
 */
export function renderGuidance(config: DelegatorConfig): string | undefined {
  return advisoryBlock(orchAdvisorySections(config), ORCH_FOOTER);
}

/**
 * One lane's advisory block, exactly as its dispatch prompt carries it, or
 * nothing when that profile has neither a directive nor a route. Pure, on the
 * same terms as `renderGuidance`.
 */
export function renderWorkerGuidance(config: DelegatorConfig, profile: string): string | undefined {
  return advisoryBlock(workerAdvisorySections(config, profile), WORKER_FOOTER);
}

// ---------------------------------------------------------------------------
// Packaged role-skill delivery.
//
// Sessions are pointed at the installed packaged skill of the running package,
// and the configured advisory criteria ride inline in the same prompt. Nothing
// is materialized into the run.
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
 * The ORCH's delivery: the installed packaged ORCH skill, resolved before any
 * prompt-side effect, plus this run's inline advisory criteria when
 * configuration authored any.
 */
export async function orchPackagedDelivery(runPath: string): Promise<PackagedDelivery> {
  const skillPath = await requirePackagedSkill(ORCH_PACKAGED_SKILL, "orchestrator");
  const { advisory, warning } = await inlineAdvisoryFor(runPath, renderGuidance, "The orchestrator prompt");
  return { skillPath, ...(advisory ? { advisory } : {}), ...(warning ? { warning } : {}) };
}

/**
 * One lane's delivery. The profile is required input here: it must select an
 * installed packaged skill, and either failure is closed, so no caller reaches a
 * prompt on a guessed contract.
 */
export async function workerPackagedDelivery(
  runPath: string,
  profile: string | undefined,
): Promise<PackagedDelivery> {
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
    (config) => renderWorkerGuidance(config, profile as string),
    "The assignment prompt",
  );
  return { skillPath, ...(advisory ? { advisory } : {}), ...(warning ? { warning } : {}) };
}
