// Generic text chunker: markdown by frontmatter/headings, code by top-level declarations, anything else by fixed blocks.
// Line ranges are 1-based inclusive. No repository conventions.
import { extname } from "node:path";

export type Chunk = { start: number; end: number; title: string; text: string };

const CODE_DECL: Record<string, RegExp> = {
  ts: /^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|namespace|declare|abstract)\b|^(import|export)\b/,
  js: /^(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var)\b|^(import|export|module\.exports)\b/,
  py: /^(async\s+)?(def|class)\b|^(import|from)\b|^@\w|^[A-Za-z_][A-Za-z0-9_]*\s*(:|=)/,
  go: /^(func|type|var|const|package|import)\b/,
  rs: /^(pub(\([^)]*\))?\s+)?(fn|struct|enum|trait|impl|mod|use|const|static|type|macro_rules!)\b|^#\[/,
  sh: /^(function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{?|^[A-Z_][A-Z0-9_]*=/,
  json: /^\s{0,2}"[^"]+"\s*:/,
};
const ALIASES: Record<string, string> = { tsx: "ts", mts: "ts", cts: "ts", jsx: "js", mjs: "js", cjs: "js", bash: "sh", zsh: "sh", yml: "yaml" };

export const DEFAULT_BLOCK_LINES = 60;

export function chunk(text: string, path: string, maxChars = 12_000): Chunk[] {
  const lines = text.split("\n");
  const ext = ALIASES[extname(path).slice(1)] ?? extname(path).slice(1);
  let chunks: Chunk[];
  if (ext === "md" || ext === "mdx" || ext === "markdown") chunks = markdown(lines);
  else if (CODE_DECL[ext]) chunks = code(lines, CODE_DECL[ext]);
  else chunks = blocks(lines, 1, DEFAULT_BLOCK_LINES);
  return chunks.flatMap((c) => split(c, lines, maxChars)).filter((c) => c.text.trim().length > 0);
}

function markdown(lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) {
      out.push(make(lines, 1, close + 1, "frontmatter"));
      i = close + 1;
    }
  }
  let start = i;
  let title = "(preamble)";
  let fence = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^#{1,6}\s/.test(line) && i > start) {
      out.push(make(lines, start + 1, i, title));
      start = i;
      title = line.replace(/^#+\s*/, "");
    } else if (!fence && /^#{1,6}\s/.test(line) && i === start) {
      title = line.replace(/^#+\s*/, "");
    }
  }
  out.push(make(lines, start + 1, lines.length, title));
  return out;
}

function code(lines: string[], decl: RegExp): Chunk[] {
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (decl.test(lines[i]) && !/^\s/.test(lines[i])) starts.push(i);
  if (starts.length === 0) return blocks(lines, 1, DEFAULT_BLOCK_LINES);
  const out: Chunk[] = [];
  if (starts[0] > 0) out.push(make(lines, 1, starts[0], "(preamble)"));
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    out.push(make(lines, from + 1, to, lines[from].slice(0, 80)));
  }
  return out;
}

function blocks(lines: string[], from: number, size: number): Chunk[] {
  const out: Chunk[] = [];
  for (let s = from; s <= lines.length; s += size) {
    const end = Math.min(lines.length, s + size - 1);
    out.push(make(lines, s, end, `lines ${s}-${end}`));
  }
  return out;
}

function make(lines: string[], start: number, end: number, title: string): Chunk {
  return { start, end, title, text: lines.slice(start - 1, end).join("\n") };
}

function split(c: Chunk, lines: string[], maxChars: number): Chunk[] {
  if (c.text.length <= maxChars) return [c];
  const total = c.end - c.start + 1;
  const parts = Math.ceil(c.text.length / maxChars);
  const per = Math.max(1, Math.ceil(total / parts));
  return blocks(lines.slice(0, c.end), c.start, per).map((b, i) => ({ ...b, title: `${c.title} (${i + 1}/${parts})` }));
}

/** Split arbitrary tool output into blocks at blank lines (falling back to fixed blocks), for ranking in memory. */
export function blocksOfText(text: string, fallbackLines = 30, maxChars = 6_000): Chunk[] {
  const lines = text.split("\n");
  const out: Chunk[] = [];
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    const boundary = i === lines.length || lines[i].trim() === "";
    if (!boundary) continue;
    if (i > start) out.push(make(lines, start + 1, i, lines[start].slice(0, 80)));
    start = i + 1;
  }
  const useFallback = out.length < 2 || out.some((c) => c.text.length > maxChars);
  const base = useFallback ? blocks(lines, 1, fallbackLines) : out;
  return base.flatMap((c) => split(c, lines, maxChars)).filter((c) => c.text.trim().length > 0);
}
