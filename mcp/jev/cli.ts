#!/usr/bin/env bun
// CLI for the Jev actions. Output is a compact table so that what enters an agent's context is the choice, not the text.
//   bun mcp/jev/cli.ts rank --intent "<intent>" [--paths] <path>...        rank file names only
//   bun mcp/jev/cli.ts rank --intent "<intent>" [--top N] <path>...          rank chunks of the files (default)
//   bun mcp/jev/cli.ts rank --intent "<intent>" --glob "<pattern>" [--root dir]
//   bun mcp/jev/cli.ts judge --moment authoring --file <assignment.md>
//   bun mcp/jev/cli.ts judge --moment authoring --track <id> --run <id> --assignment <A-nnn>
//   bun mcp/jev/cli.ts judge --moment settlement --track <id> --run <id> --assignment <A-nnn> [--base <rev>]
//   bun mcp/jev/cli.ts check --sentence "<text>" [--sentence "<text>"...] --ref <path> [--ref <path>...]
//   flags: --json  --min <p> (display filter only; nothing is dropped from --json)
import { check, type CheckOutput } from "./check.js";
import { judgeAuthoring, judgeSettlement, type AuthoringOutput, type SettlementOutput } from "./judge.js";
import { SETTLEMENT_ACTIONS } from "./questions.js";
import { rankChunks, rankPaths, type RankOutput } from "./rank.js";

const USAGE = [
  "usage:",
  "  cli.ts rank --intent <text> [--paths | --top N] [--glob <pattern> --root <dir>] [--json] [--min p] <path>...",
  "  cli.ts judge --moment authoring|settlement (--file <path> | --track <id> --run <id> --assignment <A-nnn>) [--base <rev>] [--json]",
  "  cli.ts check --sentence <text> [--sentence <text>...] --ref <path> [--ref <path>...] [--json]",
].join("\n");

const prefix = `${process.cwd()}/`;
const rel = (p: string): string => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
const distribution = (probabilities: Record<string, number>): string =>
  Object.entries(probabilities).sort((a, b) => b[1] - a[1]).map(([key, p]) => `${key} ${p.toFixed(2)}`).join(", ");
const cell = (text: string, width: number): string => text.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, width);
/** Display bound only: the counts above it are the full set, and --json carries every path. */
const pathList = (paths: string[], shown = 20): string =>
  paths.length === 0 ? "(none)" : `${paths.slice(0, shown).join(", ")}${paths.length > shown ? ` (+${paths.length - shown} more)` : ""}`;

// ------------------------------------------------------------------- rank

type RankFlags = { intent?: string; paths: boolean; top?: number; glob?: string; root: string; json: boolean; min: number; limit: number; files: string[] };

function parseRank(argv: string[]): RankFlags {
  const f: RankFlags = { paths: false, root: process.cwd(), json: false, min: 0, limit: 12, files: [] };
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

function rankTable(out: RankOutput, min: number, limit: number): string {
  const shown = out.results.filter((r) => r.p >= min).slice(0, limit);
  const lines = [
    `rank: ${out.results.length} candidates, ${out.requests} request(s), ${out.input_tokens} input tokens, model ${out.model ?? "?"}, showing ${shown.length}${min ? ` with p>=${min}` : ""}`,
    "| p | a | b | target | title |",
    "|---|---|---|---|---|",
    ...shown.map((r) => `| ${r.p.toFixed(2)} | ${r.a.toFixed(2)} | ${r.b.toFixed(2)} | ${rel(r.path)}${r.range ? `:${r.range.start}-${r.range.end}` : ""} | ${cell(r.title ?? "", 60)} |`),
  ];
  if (out.unevaluated.length) lines.push(`unevaluated: ${out.unevaluated.map((u) => `${rel(u.path)}${u.range ? `:${u.range.start}-${u.range.end}` : ""} (${u.reason})`).join("; ")}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ judge

type JudgeFlags = { moment?: string; track?: string; run?: string; assignment?: string; file?: string; base?: string; json: boolean };

function parseJudge(argv: string[]): JudgeFlags {
  const f: JudgeFlags = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--moment") f.moment = argv[++i];
    else if (a === "--track") f.track = argv[++i];
    else if (a === "--run") f.run = argv[++i];
    else if (a === "--assignment") f.assignment = argv[++i];
    else if (a === "--file") f.file = argv[++i];
    else if (a === "--base") f.base = argv[++i];
    else if (a === "--json") f.json = true;
  }
  return f;
}

function authoringTable(out: AuthoringOutput): string {
  const a = out.assignment;
  const lines = [
    `judge authoring: ${a.assignment_id} (${a.responsibility_key}, profile ${a.profile}${a.label ? `, label ${a.label}` : ""})`,
    `source: ${rel(out.source)} — ${out.requests} request, ${out.input_tokens} input tokens, model ${out.model}`,
    "| score | /3 | question |",
    "|---|---|---|",
    ...out.scores.map((s) => `| ${s.id} | ${s.score.toFixed(2)} | ${s.label} |`),
    "",
    "| # | p_observable | completion condition |",
    "|---|---|---|",
    ...out.conditions.map((c) => `| ${c.index} | ${c.p_observable.toFixed(2)} | ${cell(c.text, 90)} |`),
    "",
    `maturity: ${out.maturity.toFixed(2)} (specification implementable without an open design decision)`,
    `profile: choice ${out.profile.choice} | declared: ${out.profile.declared} | agrees: ${out.profile.agrees ? "yes" : "no"} | ${distribution(out.profile.probabilities)}`,
    `next_action: ${out.next_action}`,
    `thresholds: hint_min_p ${out.thresholds.hint_min_p}, score_min ${out.thresholds.score_min}`,
    out.advisory,
  ];
  return lines.join("\n");
}

function settlementTable(out: SettlementOutput): string {
  const a = out.assignment;
  const excerpts = out.conditions
    .filter((c) => c.evidence.paragraph !== null)
    .map((c) => `- conditions[${c.index}] <- report.paragraphs[${c.evidence.paragraph}]:\n${c.evidence.excerpt.split("\n").map((line) => `    ${line}`).join("\n")}`);
  const lines = [
    `judge settlement: ${a.assignment_id} (${a.worker_id}, ${a.responsibility_key}, profile ${a.profile}, registry state ${a.state})`,
    `report: ${rel(out.report.path)} — ${out.report.paragraphs} paragraph(s), segment from ${out.report.segment_from}`,
    `base: ${out.base} — ${out.requests} request, ${out.input_tokens} input tokens, model ${out.model}`,
    "| # | p_met | evidence | completion condition |",
    "|---|---|---|---|",
    ...out.conditions.map((c) => `| ${c.index} | ${c.p_met.toFixed(2)} | ${c.evidence.paragraph === null ? "none" : `report.paragraphs[${c.evidence.paragraph}]`} | ${cell(c.text, 80)} |`),
    "",
    `evidence excerpts (${out.evidence_note})`,
    ...(excerpts.length ? excerpts : ["- none"]),
    "",
    `p_claims_evidence_separated: ${out.p_claims_evidence_separated.toFixed(2)}`,
    `p_out_of_scope_change: ${out.p_out_of_scope_change.toFixed(2)}`,
    `changed_paths: owned ${out.changed_paths.owned.length}, unowned ${out.changed_paths.unowned.length}, unclassified ${out.changed_paths.unclassified.length} (ownership declarations: ${out.ownership.classified} classified, ${out.ownership.unclassified} unclassified)`,
    `  owned: ${pathList(out.changed_paths.owned)}`,
    `  unowned: ${pathList(out.changed_paths.unowned)}`,
    `  unclassified: ${pathList(out.changed_paths.unclassified)}`,
    `next_action: ${out.next_action.label} (score ${out.next_action.score.toFixed(2)}; ${distribution(Object.fromEntries(Object.entries(out.next_action.probabilities).map(([level, p]) => [SETTLEMENT_ACTIONS[Number(level)] ?? level, p])))})`,
    `attribution: ${out.attribution}`,
    out.advisory,
  ];
  if (out.unevaluated.length) lines.push(`unevaluated: ${out.unevaluated.map((u) => `${rel(u.path)}${u.range ? `:${u.range.start}-${u.range.end}` : ""} (${u.reason})`).join("; ")}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ check

function parseCheck(argv: string[]): { sentences: string[]; refs: string[]; json: boolean } {
  const f = { sentences: [] as string[], refs: [] as string[], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sentence") f.sentences.push(argv[++i]);
    else if (a === "--ref") f.refs.push(argv[++i]);
    else if (a === "--json") f.json = true;
  }
  return f;
}

function checkTable(out: CheckOutput): string {
  const lines = [
    `check: ${out.sentences.length} sentence(s) against ${out.chunks} chunk(s), ${out.requests} request, ${out.input_tokens} input tokens, model ${out.model}`,
    "| # | p_supported | support | title | sentence |",
    "|---|---|---|---|---|",
    ...out.sentences.map((s) => `| ${s.index} | ${s.p_supported.toFixed(2)} | ${s.chunk ? `${rel(s.chunk.path)}:${s.chunk.range.start}-${s.chunk.range.end}` : "none"} | ${cell(s.chunk?.title ?? "", 40)} | ${cell(s.sentence, 60)} |`),
  ];
  if (out.unevaluated.length) lines.push(`unevaluated: ${out.unevaluated.map((u) => `${rel(u.path)}${u.range ? `:${u.range.start}-${u.range.end}` : ""} (${u.reason})`).join("; ")}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------- main

const [action, ...rest] = process.argv.slice(2);

if (action === "rank") {
  const flags = parseRank(rest);
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
  console.log(flags.json ? JSON.stringify(out, null, 1) : rankTable(out, flags.min, flags.limit));
} else if (action === "judge") {
  const flags = parseJudge(rest);
  const coordinates = flags.track && flags.run && flags.assignment ? { track_id: flags.track, run_id: flags.run, assignment_id: flags.assignment } : undefined;
  if (flags.moment === "authoring") {
    if (!coordinates && !flags.file) {
      console.error("judge --moment authoring takes --file <path> or --track/--run/--assignment");
      process.exit(2);
    }
    const out = await judgeAuthoring(coordinates ?? { file: flags.file as string });
    console.log(flags.json ? JSON.stringify(out, null, 1) : authoringTable(out));
  } else if (flags.moment === "settlement") {
    if (!coordinates) {
      console.error("judge --moment settlement takes --track/--run/--assignment: the change set and the lane report are read from the registry");
      process.exit(2);
    }
    const out = await judgeSettlement({ ...coordinates, ...(flags.base ? { base: flags.base } : {}) });
    console.log(flags.json ? JSON.stringify(out, null, 1) : settlementTable(out));
  } else {
    console.error("--moment is authoring or settlement");
    process.exit(2);
  }
} else if (action === "check") {
  const flags = parseCheck(rest);
  if (flags.sentences.length === 0 || flags.refs.length === 0) {
    console.error("check needs at least one --sentence and one --ref");
    process.exit(2);
  }
  const out = await check(flags.sentences, flags.refs);
  console.log(flags.json ? JSON.stringify(out, null, 1) : checkTable(out));
} else {
  console.error(USAGE);
  process.exit(2);
}
