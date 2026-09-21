/**
 * Protocol-template allowlist self-check.
 *
 * A run materializes its protocol documents byte-identically from the bundled
 * templates, and both init reconcile and the ORCH spawn re-verify those bytes
 * against the shipped-digest allowlist in `extensions/lib/templates.ts`. Editing
 * a template without appending its digest therefore breaks every run created on
 * the previous text — it stops loading *and* stops reviving — and nothing about
 * the edit itself fails. This check is that missing failure: every installed
 * template's own digest must appear in its own list, and each list must be
 * sorted and duplicate-free so the header's regeneration command reproduces it.
 *
 * Dependency-free by design: it runs inside `bun run check` before anything else
 * is installed. Pass a directory to check a copy of the tree instead of the
 * repository itself.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_NAMES = ["protocol.md", "protocol-orch.md", "protocol-worker.md"] as const;
const ALLOWLIST_PATH = "io.github.edgar-min.herdr-delegator/extensions/lib/templates.ts";
const TEMPLATE_DIR = "skills/herdr-delegation/templates";

/** Parses `HISTORICAL_TEMPLATE_SHA256` without importing it, so this stays a pure text check. */
function parseAllowlist(source: string): Map<string, string[]> {
  const lists = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of source.split("\n")) {
    const opening = /^\s{2}"([^"]+)":\s*\[\s*$/.exec(line);
    if (opening) {
      current = opening[1];
      lists.set(current, []);
      continue;
    }
    if (/^\s{2}\],\s*$/.test(line)) {
      current = undefined;
      continue;
    }
    const digest = /^\s{4}"([0-9a-f]{64})",\s*$/.exec(line);
    if (digest && current) lists.get(current)?.push(digest[1]);
  }
  return lists;
}

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const failures: string[] = [];
let source: string;
try {
  source = await readFile(path.join(root, ALLOWLIST_PATH), "utf8");
} catch (error: unknown) {
  console.error(`check-templates: cannot read ${ALLOWLIST_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const lists = parseAllowlist(source);

for (const name of TEMPLATE_NAMES) {
  const digests = lists.get(name);
  if (!digests || digests.length === 0) {
    failures.push(`${name}: no digest list found in ${ALLOWLIST_PATH}`);
    continue;
  }
  const sorted = [...digests].sort();
  if (digests.join() !== sorted.join()) failures.push(`${name}: allowlist is not sorted`);
  if (new Set(digests).size !== digests.length) failures.push(`${name}: allowlist contains duplicates`);
  let installed: Buffer;
  try {
    installed = await readFile(path.join(root, TEMPLATE_DIR, name));
  } catch (error: unknown) {
    failures.push(`${name}: cannot read installed template: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const digest = createHash("sha256").update(installed).digest("hex");
  if (!digests.includes(digest)) {
    failures.push(
      `${name}: installed template digest ${digest} is missing from its allowlist. Append it — and the digest the previous commit shipped — never replace the list, or every run created on an earlier version stops loading and reviving.`,
    );
  }
}

if (failures.length) {
  console.error(`check-templates: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`check-templates: ${TEMPLATE_NAMES.length} templates, every installed digest present, lists sorted and unique`);
