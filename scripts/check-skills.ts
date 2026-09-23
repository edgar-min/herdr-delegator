// Every bundled skill must survive the OMP Agent Plugins loader, which parses
// SKILL.md frontmatter as STRICT YAML (no repair) and silently skips a skill
// that fails — the session then answers `Unknown skill` to the dispatch
// pointer. 4.0.0 shipped the three worker profile skills with an unquoted
// `: ` inside `description`, so no born worker could read its own skill
// (patch-4-0-1/r1 C-7). This runs the loader's own validator over skills/.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { validateAgentSkillFrontmatter } from "@oh-my-pi/pi-coding-agent/discovery/agent-plugin-format";

const root = process.argv[2] ?? path.resolve(import.meta.dir, "..");
const skillsDir = path.join(root, "skills");
const problems: string[] = [];
let checked = 0;
for (const entry of readdirSync(skillsDir)) {
  const skillPath = path.join(skillsDir, entry, "SKILL.md");
  try { if (!statSync(skillPath).isFile()) continue; } catch { continue; }
  checked += 1;
  let frontmatter: Record<string, unknown>;
  try {
    ({ frontmatter } = parseFrontmatter(readFileSync(skillPath, "utf8"), { source: skillPath, level: "fatal", repair: false, rawKeys: true }));
  } catch (error) {
    problems.push(`${entry}: malformed YAML frontmatter (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  const violation = validateAgentSkillFrontmatter(frontmatter, entry);
  if (violation !== null) problems.push(`${entry}: ${violation}`);
}
if (problems.length > 0) {
  console.error(`check-skills: ${problems.length} skill(s) the OMP loader would skip`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-skills: ${checked} bundled skill(s) pass the Agent Plugins loader`);
