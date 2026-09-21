/**
 * Packaged role-skill self-check.
 *
 * Role instructions are installed package files: delivery resolves
 * `skills/herdr-<role>/SKILL.md` by an explicit package-relative path and fails
 * closed when that path is missing or unreadable, so a renamed or unshipped
 * skill directory breaks every ORCH spawn and every worker dispatch while
 * nothing about the rename itself fails. This check is that missing failure:
 * every packaged skill must exist and declare a frontmatter `name` equal to its
 * directory, because an explicit load resolves nothing when the two disagree.
 *
 * Dependency-free by design: it runs inside `bun run check` before anything else
 * is installed. Pass a directory to check a copy of the tree instead of the
 * repository itself.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGED_ROLE_SKILLS = ["herdr-create", "herdr-orch", "herdr-default-worker", "herdr-task-worker", "herdr-slow-worker"] as const;

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const failures: string[] = [];

for (const skill of PACKAGED_ROLE_SKILLS) {
  const target = path.join(root, "skills", skill, "SKILL.md");
  let body: string;
  try {
    body = await readFile(target, "utf8");
  } catch (error: unknown) {
    failures.push(`skills/${skill}/SKILL.md: cannot read the packaged role skill: ${error instanceof Error ? error.message : String(error)}. Delivery resolves this exact path and fails closed without it.`);
    continue;
  }
  const declared = /^---\n([\s\S]*?)\n---\n/.exec(body)?.[1];
  const declaredName = declared ? /^name:[ \t]*(\S+)[ \t]*$/m.exec(declared)?.[1] : undefined;
  if (declaredName !== skill) {
    failures.push(`skills/${skill}/SKILL.md: frontmatter name is ${declaredName ?? "absent"}, expected ${skill}. Directory and skill name must match or an explicit load resolves nothing.`);
  }
}

if (failures.length) {
  console.error(`check-skills: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`check-skills: ${PACKAGED_ROLE_SKILLS.length} packaged role skills present, each declaring its own directory name`);
