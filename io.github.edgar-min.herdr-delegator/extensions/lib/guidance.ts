/**
 * Run-materialized advisory guidance document.
 *
 * Judgment criteria only reach a born ORCH if they are delivered at the
 * boundary where the judgment happens, so `guidance.md` is rendered into the
 * run directory from the resolved configuration and named by the ORCH's first
 * prompt. Everything here is advisory: the document carries selection criteria
 * for routed skills and worker profiles and never scope, authority, ownership,
 * or completion conditions.
 *
 * The renderer is non-blocking by construction. Any failure — unreadable
 * configuration, an unreadable skill, a broken layer — degrades to a document
 * that names what could not be rendered; only a failed write is reported back,
 * as a warning, to a caller that continues regardless.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loadDelegatorConfig, ompAgentDir, readRunManifest, writeAtomic } from "./config";
import type { DelegatorConfig, SkillRoute, SkillRouteBoundary } from "./contracts";
import { compactMessage } from "./contracts";

export const GUIDANCE_DOCUMENT_NAME = "guidance.md";

/** Boundaries an ORCH itself acts at; worker-surface routes reach workers through dispatch. */
const ORCH_GUIDANCE_BOUNDARIES: readonly SkillRouteBoundary[] = ["plan", "authoring"];

/** A SKILL.md is a small document; a larger file is not read into a prompt-adjacent surface. */
const MAX_SKILL_FILE_BYTES = 64_000;

/** Descriptions come from disk, not from the bounded config, so they are bounded here. */
const MAX_DESCRIPTION_LENGTH = 500;

const NONE_CONFIGURED = "None configured";

/**
 * Ordered skill roots, mirroring how the runtime lays installed skills out:
 * project-level roots first (`.omp/skills`, agent dirs, Claude and GitHub
 * layouts under the run's project directory), then user-level roots (the agent
 * dir's own `skills` and `managed-skills`, then home agent dirs). First hit
 * wins, so a project skill shadows a user one exactly as discovery does.
 */
function skillRoots(cwd: string): string[] {
  const agentDir = ompAgentDir();
  const home = homedir();
  const roots = [
    path.join(cwd, ".omp", "skills"),
    path.join(cwd, ".agent", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".github", "skills"),
    path.join(agentDir, "skills"),
    path.join(agentDir, "managed-skills"),
    path.join(home, ".agent", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
  ];
  return roots.filter((root, index) => roots.indexOf(root) === index);
}

/** One line of table- and prompt-safe text. */
function boundedLine(value: string, limit: number): string {
  return compactMessage(value.replace(/\|/g, "/"), "").slice(0, limit).trim();
}

/**
 * The `description` field of a SKILL.md frontmatter block. Supports the plain
 * and quoted single-line forms plus folded/literal block scalars, which is the
 * whole shape the Agent Skills frontmatter schema allows for this field.
 */
export function skillDescriptionFromDocument(document: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
  if (!frontmatter) return undefined;
  const lines = frontmatter[1].split(/\r?\n/);
  const index = lines.findIndex((line) => /^description:/.test(line));
  if (index < 0) return undefined;
  const head = lines[index].slice("description:".length).trim();
  if (head && head !== "|" && head !== ">" && head !== "|-" && head !== ">-") {
    const unquoted = /^(["'])([\s\S]*)\1$/.exec(head);
    const text = boundedLine(unquoted ? unquoted[2] : head, MAX_DESCRIPTION_LENGTH);
    return text || undefined;
  }
  const folded: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!/^\s/.test(line)) break;
    if (!line.trim()) continue;
    folded.push(line.trim());
  }
  const text = boundedLine(folded.join(" "), MAX_DESCRIPTION_LENGTH);
  return text || undefined;
}

/** Reads one installed skill's description, or nothing when it is absent or unreadable. */
async function readSkillDescription(name: string, roots: readonly string[]): Promise<string | undefined> {
  for (const root of roots) {
    let raw: Buffer;
    try {
      raw = await readFile(path.join(root, name, "SKILL.md"));
    } catch {
      continue;
    }
    if (raw.byteLength > MAX_SKILL_FILE_BYTES) return undefined;
    return skillDescriptionFromDocument(raw.toString("utf8"));
  }
  return undefined;
}

/**
 * The orchestrator-surface routes this document delivers. A profile-scoped rule
 * is skipped: this document's reader is the ORCH, which carries no worker
 * profile, so the same rule is already absent from every other
 * orchestrator-surface delivery point (`resolveSkillRoutes` without a profile).
 */
function orchRoutes(config: DelegatorConfig): SkillRoute[] {
  const rules = config.skill_routing?.rules ?? [];
  return ORCH_GUIDANCE_BOUNDARIES.flatMap((boundary) =>
    rules.filter((rule) => rule.surface === "orch" && rule.boundary === boundary && !rule.profiles),
  );
}

function renderRouteSection(routes: readonly SkillRoute[], descriptions: ReadonlyMap<string, string>): string[] {
  const lines = ["## Routed skills — orchestrator surface (plan, authoring)", ""];
  if (!routes.length) {
    lines.push(`${NONE_CONFIGURED}. No orchestrator-surface plan or authoring route is declared in any configuration layer.`, "");
    return lines;
  }
  for (const route of routes) {
    lines.push(`### ${route.boundary}`, "");
    for (const skill of route.skills) {
      const description = descriptions.get(skill);
      const parts = [`- \`${skill}\``];
      if (route.trigger) parts.push(`when: ${route.trigger}`);
      // File resolution stays primary — it inlines the real description. The
      // pointer is the degrade, and it completes delivery where a file walk
      // cannot: a runtime-managed skill exists on no disk root, but the session
      // reading this document resolves `skill://` natively.
      parts.push(description ?? `read \`skill://${skill}\` for its description`);
      lines.push(parts.join(" — "));
    }
    lines.push("");
  }
  return lines;
}

function renderProfileSection(config: DelegatorConfig): string[] {
  const entries = Object.entries(config.worker_profiles);
  const lines = [
    "## Worker profile selection",
    "",
    "| profile | configured role | selection criteria |",
    "| --- | --- | --- |",
  ];
  for (const [name, profile] of entries) {
    const criteria = profile.guidance ? boundedLine(profile.guidance, MAX_DESCRIPTION_LENGTH) : NONE_CONFIGURED;
    lines.push(`| \`${name}\` | \`${profile.role}\` | ${criteria} |`);
  }
  lines.push("");
  if (!entries.some(([, profile]) => profile.guidance)) {
    lines.push(
      `Selection criteria: ${NONE_CONFIGURED}. No profile declares \`guidance\` in any configuration layer, so profile choice is your judgment against the mandate and this run's plan.`,
      "",
    );
  }
  lines.push(
    "Roles are configured OMP role aliases, not resolved providers or models. Shipped fact: `slow` is also the profile this server spawns budget auditors on.",
    "",
  );
  return lines;
}

const HEADER = [
  "# guidance.md — advisory judgment criteria",
  "",
  "Rendered into this run from the resolved delegator configuration at ORCH birth.",
  "It carries selection criteria only: which routed skills apply at your own plan and",
  "authoring boundaries, and what each worker profile is for. It is advisory and",
  "changes no scope, authority, ownership, or completion condition.",
  "",
];

/** Renders the document from an already-resolved configuration. Never throws. */
export function renderGuidanceDocument(config: DelegatorConfig, descriptions: ReadonlyMap<string, string>): string {
  return [...HEADER, ...renderRouteSection(orchRoutes(config), descriptions), ...renderProfileSection(config)].join("\n");
}

/** The degrade rendering: the document exists and names what could not be rendered. */
export function renderGuidanceFailure(reason: string): string {
  return [
    ...HEADER,
    "## Unavailable",
    "",
    `This document could not be rendered from configuration: ${compactMessage(reason, "unknown error")}`,
    "",
    "Nothing is gated by this. Work from the mandate, `plan.md`, and `protocol-orch.md`,",
    "and read the delegator configuration directly if profile criteria matter.",
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
    const roots = skillRoots(manifest.cwd);
    const names = [...new Set(orchRoutes(config).flatMap((route) => route.skills))];
    const resolved = await Promise.all(names.map(async (name) => [name, await readSkillDescription(name, roots)] as const));
    const descriptions = new Map<string, string>();
    for (const [name, description] of resolved) {
      if (description) descriptions.set(name, description);
    }
    document = renderGuidanceDocument(config, descriptions);
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
