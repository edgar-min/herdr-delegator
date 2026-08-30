// Guards the release bookkeeping that prose alone already failed to protect once:
// v2.0.0 was tagged and pushed while its CHANGELOG header still read "Unreleased",
// so two later tracks appended shipped work into an already-released section and
// the split had to be reconstructed by hand at the next release.
//
// Rules, all local and dependency-free:
//   1. A `## [X.Y.Z] - Unreleased` header MUST NOT coexist with an existing git
//      tag `vX.Y.Z` — tagging is releasing, so stamp the date in the same commit.
//   2. The topmost CHANGELOG version MUST equal package.json's version, so a bump
//      cannot ship without its section (or a section without its bump).
// A missing `git` binary or a non-repo checkout skips rule 1 rather than failing:
// tarball consumers have no tags to check.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? path.resolve(import.meta.dir, "..");
const problems: string[] = [];

const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const headers = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (Unreleased|\d{4}-\d{2}-\d{2})$/gm)]
  .map((m) => ({ version: m[1], stamp: m[2] }));
if (headers.length === 0) problems.push("CHANGELOG.md: no `## [X.Y.Z] - <date|Unreleased>` headers found.");

let tags: Set<string> | undefined;
try {
  tags = new Set(
    execSync("git tag -l 'v*'", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .split("\n")
      .filter(Boolean),
  );
} catch {
  // No git or not a repo: rule 1 is unverifiable here, never a failure.
}

if (tags) {
  for (const { version, stamp } of headers) {
    if (stamp === "Unreleased" && tags.has(`v${version}`)) {
      problems.push(
        `CHANGELOG.md: [${version}] reads Unreleased but tag v${version} exists. ` +
          "Tagging is releasing: stamp the date in the release commit, and open the next version's section for new work.",
      );
    }
  }
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
if (headers.length > 0 && pkg.version !== headers[0].version) {
  problems.push(
    `package.json version ${pkg.version} does not match the topmost CHANGELOG section [${headers[0].version}]. ` +
      "Bump both together, or new entries land in a section that already shipped.",
  );
}

if (problems.length > 0) {
  console.error(`check-changelog: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-changelog: ${headers.length} version header(s), release bookkeeping consistent`);
