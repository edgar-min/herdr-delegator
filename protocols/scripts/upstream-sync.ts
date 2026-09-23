// bun protocols/scripts/upstream-sync.ts [--check] [--update] [--commit <sha>]
// Tracks the upstream protocol skills vendored under protocols/<name>/upstream/ against jongwony/epistemic-protocols.
// The protocol set and each one's upstream path come from protocols/UPSTREAM.json, so adding a protocol is a manifest
// edit. --check (the default) fetches the pinned commit into a temp dir and prints every file whose sha256 drifts from
// the manifest or from the vendored copy, exiting 1 when anything differs.
// --update re-copies the upstream files over the vendored dirs and rewrites UPSTREAM.json at the resolved commit.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const REPO = "https://github.com/jongwony/epistemic-protocols";
type Entry = { source: string; plugin_version: string; files: Record<string, string> };
type Manifest = { repo: string; commit: string; license: string; fetched_at: string; protocols: Record<string, Entry> };

const ROOT = join(import.meta.dir, "..");
/** The manifest is the protocol registry: which skills are vendored, and where each one comes from upstream. */
const MANIFEST = join(ROOT, "UPSTREAM.json");
const local = (name: string) => join(ROOT, name, "upstream");

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Every file under `dir` as a slash-joined path relative to it, sorted. */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out = readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? walk(path, base) : [relative(base, path)];
  });
  return out.sort();
}

const hashes = (dir: string): Record<string, string> => Object.fromEntries(walk(dir).map((f) => [f, sha256(join(dir, f))]));

/** Materializes `commit` (a sha, tag, branch, or HEAD; default the default branch) in `dir`, shallow and blobless
 *  where the server allows it. A depth-1 fetch leaves the tip only at FETCH_HEAD, so the fast path checks that out;
 *  servers that refuse a bare-sha want (and short shas) fall back to a full blobless fetch addressed by name. */
function fetchUpstream(dir: string, commit?: string): string {
  git("init", "-q", dir);
  git("-C", dir, "remote", "add", "origin", REPO);
  try {
    git("-C", dir, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", commit ?? "HEAD");
    git("-C", dir, "checkout", "-q", "FETCH_HEAD");
  } catch {
    git("-C", dir, "fetch", "-q", "--filter=blob:none", "origin");
    git("-C", dir, "checkout", "-q", commit ?? "FETCH_HEAD");
  }
  return git("-C", dir, "rev-parse", "HEAD").trim();
}

function buildManifest(clone: string, commit: string, sources: Record<string, string>): Manifest {
  const protocols: Record<string, Entry> = {};
  for (const [name, source] of Object.entries(sources)) {
    const plugin = JSON.parse(readFileSync(join(clone, source.split("/")[0], ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    protocols[name] = { source, plugin_version: plugin.version, files: hashes(join(clone, source)) };
  }
  return { repo: REPO, commit, license: "MIT", fetched_at: new Date().toISOString(), protocols };
}

/** One row per file that is not byte-identical across upstream, the manifest and the vendored copy.
 *  Labels are what upstream did to the file: `added` (upstream has it, this side does not), `removed` (this side
 *  has it, upstream does not), `changed` (both have it, bytes differ). */
function compare(upstream: Record<string, string>, manifest: Record<string, string>, vendored: Record<string, string>) {
  const files = [...new Set([...Object.keys(upstream), ...Object.keys(manifest), ...Object.keys(vendored)])].sort();
  const rows: { file: string; manifest: string; local: string }[] = [];
  for (const file of files) {
    const want = upstream[file];
    const sides = [manifest[file], vendored[file]].map((got) =>
      got === want ? "ok" : got === undefined ? "added" : want === undefined ? "removed" : "changed",
    );
    if (sides[0] !== "ok" || sides[1] !== "ok") rows.push({ file, manifest: sides[0], local: sides[1] });
  }
  return rows;
}

function check(commit?: string): number {
  if (!existsSync(MANIFEST)) throw new Error(`missing ${MANIFEST}; it lists the protocols to sync`);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  const entries = Object.entries(manifest.protocols);
  const dir = mkdtempSync(join(tmpdir(), "upstream-sync-"));
  try {
    const resolved = fetchUpstream(dir, commit ?? manifest.commit);
    console.log(`${REPO} @ ${resolved}${resolved === manifest.commit ? "" : ` (manifest pins ${manifest.commit})`}`);
    const rows = entries.flatMap(([name, entry]) =>
      compare(hashes(join(dir, entry.source)), entry.files, hashes(local(name))).map((row) => ({ protocol: name, ...row })),
    );
    const licenseOk = existsSync(join(ROOT, "LICENSE-upstream")) && sha256(join(dir, "LICENSE")) === sha256(join(ROOT, "LICENSE-upstream"));
    const width = Math.max(7, ...rows.map((r) => r.file.length));
    if (rows.length || !licenseOk) console.log(["protocol".padEnd(9), "file".padEnd(width), "manifest".padEnd(9), "local"].join(" "));
    for (const r of rows) console.log([r.protocol.padEnd(9), r.file.padEnd(width), r.manifest.padEnd(9), r.local].join(" "));
    if (!licenseOk) console.log(["-".padEnd(9), "LICENSE".padEnd(width), "-".padEnd(9), "changed"].join(" "));
    for (const [name, entry] of entries) {
      console.log(`${name.padEnd(9)} ${Object.keys(entry.files).length} file(s), plugin ${entry.plugin_version}, source ${entry.source}`);
    }
    // An explicit --commit is a deliberate comparison against another revision, so its sha differing from the pin is
    // reported in the header, not counted as drift; the file rows carry that verdict. Without it, the pin must hold.
    const pinned = commit !== undefined || resolved === manifest.commit;
    if (rows.length === 0 && licenseOk && pinned) {
      console.log("no differences");
      return 0;
    }
    const drift = rows.length + (licenseOk ? 0 : 1);
    console.log(pinned ? `${drift} difference(s)` : `${drift} difference(s); upstream resolved to ${resolved}, manifest pins ${manifest.commit}`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function update(commit?: string): number {
  if (!existsSync(MANIFEST)) throw new Error(`missing ${MANIFEST}; it lists the protocols to sync`);
  const previous = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  const sources = Object.fromEntries(Object.entries(previous.protocols).map(([name, entry]) => [name, entry.source]));
  const dir = mkdtempSync(join(tmpdir(), "upstream-sync-"));
  try {
    const resolved = fetchUpstream(dir, commit);
    for (const [name, source] of Object.entries(sources)) {
      rmSync(local(name), { recursive: true, force: true });
      cpSync(join(dir, source), local(name), { recursive: true });
    }
    cpSync(join(dir, "LICENSE"), join(ROOT, "LICENSE-upstream"));
    writeFileSync(MANIFEST, `${JSON.stringify(buildManifest(dir, resolved, sources), null, 2)}\n`);
    const counts = Object.keys(sources).map((name) => `${name}(${walk(local(name)).length})`);
    console.log(`updated ${counts.join(" ")} to ${resolved}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
const commitFlag = argv.indexOf("--commit");
if (commitFlag !== -1 && !argv[commitFlag + 1]) throw new Error("--commit needs a sha");
const commit = commitFlag === -1 ? undefined : argv[commitFlag + 1];
const unknown = argv.filter((a, i) => a.startsWith("--") && !["--check", "--update", "--commit"].includes(a) && !(commitFlag !== -1 && i === commitFlag + 1));
if (unknown.length) throw new Error(`usage: upstream-sync.ts [--check] [--update] [--commit <sha>] (got ${unknown.join(" ")})`);
process.exit(argv.includes("--update") ? update(commit) : check(commit));
