/**
 * Run-materialized advisory guidance documents.
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
 * (`guidance.md`), `directive` only to the selected lane, and a skill's
 * `trigger` only to the ORCH, because a worker's moment already carries its
 * timing. Absence is a no-op at every level: a moment with no routes renders no
 * section, and a profile with neither a directive nor routes renders no
 * document.
 *
 * The module is non-blocking by construction. A render failure degrades to a
 * document that names what could not be rendered; only a failed write is
 * reported back, as a warning, to a caller that continues regardless.
 */
import path from "node:path";
import { loadDelegatorConfig, readRunManifest, writeAtomic } from "./config";
import type { DelegatorConfig, SkillRoute, SkillRouteBoundary } from "./contracts";
import { ORCH_MOMENTS, compactMessage } from "./contracts";

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
const ORCH_HEADER = "# guidance.md — ORCH 자문 (advisory: 기준일 뿐, 권한·범위·완료 조건을 바꾸지 않음)";
const ORCH_PROFILE_SECTION = "## 워커 프로필 선택";
const ORCH_PROFILE_TABLE_HEAD = ["| profile | role | intent |", "| --- | --- | --- |"];
const ORCH_SELECTION_AXES = "선택 축: 명세 성숙도 × 오류 비용. 한정된 기계적 작업은 레인 없이 host OMP 서브에이전트로 처리한다.";
const ORCH_ROUTE_SECTION = "## 라우트된 스킬 — 당신의 판단 시점별";
const ORCH_FOOTER = "미설치 스킬은 no-op. intent 미저작 스킬은 `read skill://<name>`로 렌더된다.";
const WORKER_DIRECTIVE_SECTION = "## 지시";
const WORKER_ROUTE_SECTION = "## 스킬";
const WORKER_FOOTER = "미설치 스킬은 no-op. `read skill://<name>`로 본문을 읽는다.";
const ABSENT_CELL = "—";

/** The judgment each ORCH moment sits in front of. */
const ORCH_MOMENT_GLOSS: Record<(typeof ORCH_MOMENTS)[number], string> = {
  plan: "plan.md를 굳히기 전",
  authoring: "어사인먼트를 확정하기 전",
  settlement: "완료를 판정하기 전",
  reset: "리셋/핸드오프를 결정할 때",
};

/**
 * Worker moments, in delivery order, with the timing label each renders under.
 * The internal boundary vocabulary is unchanged; the authored moment names
 * (`intake`, `report`) lower onto it at parse, and these labels are their
 * worker-facing display form.
 */
const WORKER_MOMENTS_IN_ORDER: ReadonlyArray<{ boundary: SkillRouteBoundary; label: string }> = [
  { boundary: "dispatch", label: "착수 전" },
  { boundary: "completion", label: "완료 보고 전" },
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
      const timing = trigger ? ` (시점: ${cell(trigger).replace(/\.$/, "")})` : "";
      sections.push(`- \`${skill}\` — ${skillIntent(config, skill)}${timing}`);
    }
    sections.push("");
  }
  return sections.length ? [ORCH_ROUTE_SECTION, "", ...sections] : [];
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

/** Renders the ORCH document from an already-resolved configuration. Never throws. */
export function renderGuidanceDocument(config: DelegatorConfig): string {
  return [ORCH_HEADER, "", ...renderProfileTable(config), ...renderOrchRoutes(config), ORCH_FOOTER, ""].join("\n");
}

/**
 * Renders one lane's document, or nothing when the profile has neither a
 * directive nor a route: an absent document is a declared no-op and the dispatch
 * pointer then names none. Never throws.
 */
export function renderWorkerGuidanceDocument(config: DelegatorConfig, profile: string): string | undefined {
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
    `# ${workerGuidanceDocumentName(profile)} — ${profile} 레인 자문 (advisory: 기준일 뿐, 어사인먼트가 유일한 계약)`,
    "",
    ...(directive ? [WORKER_DIRECTIVE_SECTION, "", cell(directive), ""] : []),
    ...(routeLines.length ? [WORKER_ROUTE_SECTION, "", ...routeLines, ""] : []),
    WORKER_FOOTER,
    "",
  ].join("\n");
}

/** The degrade rendering: the document exists and names what could not be rendered. */
export function renderGuidanceFailure(reason: string): string {
  return [
    ORCH_HEADER,
    "",
    "## 렌더 불가",
    "",
    `이 문서는 설정에서 렌더되지 못했다: ${compactMessage(reason, "unknown error")}`,
    "",
    "이 문서에 걸린 것은 없다. mandate, `plan.md`, `protocol-orch.md`로 작업하고, 프로필 기준이 필요하면 델리게이터 설정을 직접 읽어라.",
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
