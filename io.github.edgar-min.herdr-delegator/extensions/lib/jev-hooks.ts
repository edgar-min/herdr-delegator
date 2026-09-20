// Jev reads before the host does. A `read` of a long file without a line selector is revised, at arg-prep time,
// to the ranges Jev ranks highest for the call's stated intent (`i`); the result gets a footer listing the other
// ranges so the agent can open them by selector. Generic: no run-directory or repository knowledge.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { jevConfig } from "../../../mcp/jev/config";
import { append } from "../../../mcp/jev/log";
import { quality, rankChunks, rankPaths, rankText, type RankResult } from "../../../mcp/jev/rank";

// Thresholds come from the `jev` configuration block, then the environment overrides, then the defaults —
// all resolved by the one config module, so a hook and a tool never disagree about what "long" means.
const JEV = jevConfig();
/** Files at or above this many lines are narrowed. */
const THRESHOLD_LINES = JEV.read_threshold_lines;
/** Line budget for the narrowed view; ranges are added in probability order until it is spent. */
const VIEW_LINES = JEV.read_view_lines;
/** Ranges within this much of the top probability are treated as equally relevant. */
const GAP = 0.1;
const SELECTOR = /:(raw|conflicts|img|-?\d+(?:[-+]\d*)?(?:,\d+-\d+)*)$/;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|pdf|zip|tar|gz|db|sqlite3?|mp4|mov|ico|woff2?)$/i;

type Narrowed = { path: string; total: number; shown: RankResult[]; rest: RankResult[]; request: string; quality: ReturnType<typeof quality>; intent: string };
const narrowedByCall = new Map<string, Narrowed>();
const narrowedByPath = new Map<string, Narrowed>();

function countLines(path: string): number {
  return readFileSync(path, "utf8").split("\n").length;
}

function selectRanges(results: RankResult[], budget = VIEW_LINES): { shown: RankResult[]; rest: RankResult[] } {
  const shown: RankResult[] = [];
  const rest: RankResult[] = [];
  let lines = 0;
  const top = results[0]?.p ?? 0;
  for (const r of results) {
    const size = r.range ? r.range.end - r.range.start + 1 : 0;
    const relevant = r.p >= top - GAP || shown.length === 0;
    if (relevant && lines + size <= budget) {
      shown.push(r);
      lines += size;
    } else rest.push(r);
  }
  return { shown, rest };
}

const fmt = (r: RankResult) => `${r.range?.start}-${r.range?.end} p=${r.p.toFixed(2)} ${r.title ?? ""}`.trim();

export function registerJevHooks(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "read") return;
    const input = event.input as { path?: string; i?: string };
    const raw = input.path;
    const intent = input.i;
    if (!raw || !intent || SELECTOR.test(raw) || /^[a-z]+:\/\//.test(raw) || SKIP_EXT.test(raw)) return;
    const abs = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
    if (!existsSync(abs) || !statSync(abs).isFile()) return;
    let total: number;
    try {
      total = countLines(abs);
    } catch {
      return;
    }
    if (total < THRESHOLD_LINES) return;
    let out;
    try {
      out = await rankChunks(intent, [abs]);
    } catch {
      return; // no key, budget, or network: the plain read proceeds untouched
    }
    if (out.results.length < 2) return;
    const { shown, rest } = selectRanges(out.results);
    const selector = shown.map((r) => `${r.range?.start}-${r.range?.end}`).sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0])).join(",");
    const prior = narrowedByPath.get(abs);
    if (prior && prior.intent !== intent) append([{ ts: new Date().toISOString(), event: "outcome", request_id: prior.request, action: "rewrote_intent", note: prior.quality.verdict }]);
    const record: Narrowed = { path: abs, total, shown, rest, request: out.request_ids.join("+"), quality: quality(out.results), intent };
    narrowedByCall.set(event.toolCallId, record);
    narrowedByPath.set(abs, record);
    return { input: { ...input, path: `${raw}:${selector}` } };
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "task") {
      const capped = capTaskResult(event.content);
      return capped === undefined ? undefined : { content: [{ type: "text", text: capped }] };
    }
    if (event.toolName === "glob") {
      const footer = await rankGlobResult(event.input as { i?: string }, event.content);
      return footer === undefined ? undefined : { content: [...event.content, { type: "text", text: footer }] };
    }
    if (event.toolName !== "read") {
      const filtered = await filterLargeOutput(event.toolName, event.input as { i?: string; path?: string }, event.content);
      return filtered === undefined ? undefined : { content: [{ type: "text", text: filtered }] };
    }
    const rec = narrowedByCall.get(event.toolCallId);
    if (rec) {
      narrowedByCall.delete(event.toolCallId);
      const shownLines = rec.shown.reduce((n, r) => n + (r.range ? r.range.end - r.range.start + 1 : 0), 0);
      const footer = [
        "",
        `[jev] ${shownLines} of ${rec.total} lines shown for intent; ranked by relevance.${rec.quality.hint ? ` Intent ${rec.quality.verdict} — ${rec.quality.hint}.` : ""} Other ranges (open with path:start-end):`,
        ...rec.rest.slice(0, 12).map((r) => `  ${fmt(r)}`),
        rec.rest.length > 12 ? `  … ${rec.rest.length - 12} more` : "",
      ].filter((l) => l !== "").join("\n");
      return { content: [...event.content, { type: "text", text: footer }] };
    }
    // Calibration outcome: a later selector read of a narrowed file means the agent needed more than the top ranges.
    const input = event.input as { path?: string };
    const raw = input.path ?? "";
    const m = raw.match(SELECTOR);
    if (!m) return;
    const bare = raw.slice(0, -m[0].length);
    const abs = isAbsolute(bare) ? bare : resolve(process.cwd(), bare);
    const prior = narrowedByPath.get(abs);
    if (prior) append([{ ts: new Date().toISOString(), event: "outcome", request_id: prior.request, action: `opened_more:${m[1]}` }]);
  });
}

/** Subagent results enter the parent's context in full by default. Keep the head; point at the artifact for the rest. */
const TASK_RESULT_CHARS = JEV.task_result_chars;
function capTaskResult(content: ReadonlyArray<{ type: string; text?: string }>): string | undefined {
  const text = content.map((c) => c.text ?? "").join("\n");
  if (text.length <= TASK_RESULT_CHARS) return;
  const ids = [...text.matchAll(/<task-result id="([^"]+)"/g)].map((m) => m[1]);
  const pointer = ids.length ? ids.map((id) => `agent://${id}`).join(", ") : "the agent:// artifact named in the result";
  const head = text.slice(0, TASK_RESULT_CHARS);
  return `${head}\n\n[jev] ${text.length - TASK_RESULT_CHARS} more characters withheld. Full result at ${pointer}; rank it with \`bun mcp/jev/cli.ts rank --intent "<need>" <file>\` or read a field with ?q= instead of opening it whole.`;
}

/** Many glob hits: append the paths Jev ranks highest for the call's intent. Nothing is removed or reordered. */
const GLOB_MIN_HITS = Number(process.env.JEV_GLOB_MIN_HITS ?? 20);
async function rankGlobResult(input: { i?: string }, content: ReadonlyArray<{ type: string; text?: string }>): Promise<string | undefined> {
  if (!input.i) return;
  const text = content.map((c) => c.text ?? "").join("\n");
  const paths = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.endsWith("/") && !l.includes(" "));
  if (paths.length < GLOB_MIN_HITS) return;
  try {
    const out = await rankPaths(input.i, paths.slice(0, 400));
    const top = out.results.slice(0, 10).map((r) => `  ${r.p.toFixed(2)} ${r.path}`).join("\n");
    return `\n[jev] top paths for intent (${out.results.length} judged):\n${top}`;
  } catch {
    return;
  }
}

/**
 * Any other tool whose output is long (grep, bash, MCP responses via write xd://, custom tools): keep the blocks Jev
 * ranks highest for the call's intent, in original order, and say what was withheld. Tools whose output must stay
 * exact (edit echoes, todo, ask) are excluded. Images pass through untouched.
 */
const OUTPUT_MIN_LINES = JEV.output_min_lines;
const OUTPUT_VIEW_LINES = Number(process.env.JEV_OUTPUT_VIEW_LINES ?? 60);
const EXACT_TOOLS = new Set(["edit", "todo", "ask", "hub", "eval"]);
async function filterLargeOutput(tool: string, input: { i?: string; path?: string }, content: ReadonlyArray<{ type: string; text?: string }>): Promise<string | undefined> {
  if (!input.i || EXACT_TOOLS.has(tool) || content.some((c) => c.type !== "text")) return;
  if (tool === "write" && !(input.path ?? "").startsWith("xd://")) return;
  const text = content.map((c) => c.text ?? "").join("\n");
  const lines = text.split("\n");
  if (lines.length < OUTPUT_MIN_LINES) return;
  let out;
  try {
    out = await rankText(input.i, text, `${tool}-output`);
  } catch {
    return;
  }
  if (out.results.length < 2) return;
  const { shown, rest } = selectRanges(out.results.map((r) => ({ ...r })), OUTPUT_VIEW_LINES);
  const keep = [...shown].sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0));
  const body = keep.map((r) => lines.slice((r.range?.start ?? 1) - 1, r.range?.end ?? 0).join("\n")).join("\n…\n");
  const withheld = rest.reduce((n, r) => n + (r.range ? r.range.end - r.range.start + 1 : 0), 0);
  const q = quality(out.results);
  return `${body}\n\n[jev] ${tool}: ${withheld} of ${lines.length} lines withheld as less relevant to the intent (${rest.length} blocks; best withheld p=${rest[0]?.p.toFixed(2) ?? "-"}).${q.hint ? ` Intent ${q.verdict} — ${q.hint}.` : ""} Re-run with a narrower query or read the artifact if something is missing.`;
}
