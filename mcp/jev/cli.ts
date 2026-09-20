#!/usr/bin/env bun
// CLI for the Jev actions. Output is a compact table so that what enters an agent's context is the choice, not the text.
//   bun mcp/jev/cli.ts rank --intent "<intent>" [--paths] <path>...        rank file names only
//   bun mcp/jev/cli.ts rank --intent "<intent>" [--top N] <path>...          rank chunks of the files (default)
//   bun mcp/jev/cli.ts rank --intent "<intent>" --glob "<pattern>" [--root dir]
//   flags: --json  --min <p> (display filter only; nothing is dropped from --json)
import { rankChunks, rankPaths, type RankOutput } from "./rank.js";

type Flags = { intent?: string; paths: boolean; top?: number; glob?: string; root: string; json: boolean; min: number; limit: number; files: string[] };

function parse(argv: string[]): Flags {
  const f: Flags = { paths: false, root: process.cwd(), json: false, min: 0, limit: 12, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--intent") f.intent = argv[++i];
    else if (a === "--paths") f.paths = true;
    else if (a === "--top") f.top = Number(argv[++i]);
    else if (a === "--glob") f.glob = argv[++i];
    else if (a === "--root") f.root = argv[++i];
    else if (a === "--json") f.json = true;
    else if (a === "--min") f.min = Number(argv[++i]);
    else if (a === "--limit") f.limit = Number(argv[++i]);
    else f.files.push(a);
  }
  return f;
}

function table(out: RankOutput, min: number, limit: number): string {
  const shown = out.results.filter((r) => r.p >= min).slice(0, limit);
  const prefix = process.cwd() + "/";
  const rel = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const lines = [
    `rank: ${out.results.length} candidates, ${out.requests} request(s), ${out.input_tokens} input tokens, model ${out.model ?? "?"}, showing ${shown.length}${min ? ` with p>=${min}` : ""}`,
    "| p | a | b | target | title |",
    "|---|---|---|---|---|",
    ...shown.map((r) => `| ${r.p.toFixed(2)} | ${r.a.toFixed(2)} | ${r.b.toFixed(2)} | ${rel(r.path)}${r.range ? `:${r.range.start}-${r.range.end}` : ""} | ${(r.title ?? "").replace(/\|/g, "/").slice(0, 60)} |`),
  ];
  if (out.unevaluated.length) lines.push(`unevaluated: ${out.unevaluated.map((u) => `${rel(u.path)}${u.range ? `:${u.range.start}-${u.range.end}` : ""} (${u.reason})`).join("; ")}`);
  return lines.join("\n");
}

const [action, ...rest] = process.argv.slice(2);
if (action !== "rank") {
  console.error("usage: cli.ts rank --intent <text> [--paths | --top N] [--glob <pattern> --root <dir>] [--json] [--min p] <path>...");
  process.exit(2);
}
const flags = parse(rest);
if (!flags.intent) {
  console.error("--intent is required: the question set judges every candidate against it");
  process.exit(2);
}
let files = flags.files;
if (flags.glob) {
  const glob = new Bun.Glob(flags.glob);
  files = [...files, ...[...glob.scanSync({ cwd: flags.root, onlyFiles: true, dot: false })].map((p) => `${flags.root}/${p}`)];
}
if (files.length === 0) {
  console.error("no candidates");
  process.exit(2);
}
const out = flags.paths || flags.glob ? await rankPaths(flags.intent, files) : await rankChunks(flags.intent, files, { topK: flags.top });
console.log(flags.json ? JSON.stringify(out, null, 1) : table(out, flags.min, flags.limit));
