// One place the Jev module and the host hooks read their settings from: the `jev` block of the delegator
// configuration (user layer, then project layer), then the environment overrides, then the defaults in code.
// There is no on/off flag — Jev is how this plugin reads — so a missing block only means "defaults".
// The file layers are read once per process: a configuration change takes effect the next time the host starts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./client.js";

/** A user-defined moment, passed through as declared; the built-in moments use the same shape. */
export type JevMoment = {
  name: string;
  when: { tool_result?: string; tool_call?: string; server?: string; path?: string };
  state: { file?: string; paths?: string[] };
  questions: Record<string, unknown>;
};

export type JevConfig = {
  /** Model name sent with every request. */
  model: string;
  /** A `read` of at least this many lines is narrowed to ranked ranges. */
  read_threshold_lines: number;
  /** Line budget of a narrowed read view. */
  read_view_lines: number;
  /** Tool output of at least this many lines is filtered to ranked blocks. */
  output_min_lines: number;
  /** Character cap applied to a subagent result before it enters the parent context. */
  task_result_chars: number;
  /** Probability below which a judgment is reported as weak; it only picks a one-line next action. */
  hint_min_p: number;
  /** User-defined moments, declared in configuration rather than in code. */
  moments: JevMoment[];
};

export const JEV_DEFAULTS: JevConfig = {
  model: "jev-latest",
  read_threshold_lines: 200,
  read_view_lines: 120,
  output_min_lines: 80,
  task_result_chars: 1200,
  hint_min_p: 0.6,
  moments: [],
};

/** Environment overrides, applied when the configuration block does not name the value. */
const ENV_KEYS: Record<string, string> = {
  model: "JEV_MODEL",
  read_threshold_lines: "JEV_READ_THRESHOLD",
  read_view_lines: "JEV_READ_VIEW_LINES",
  output_min_lines: "JEV_OUTPUT_MIN_LINES",
  task_result_chars: "JEV_TASK_RESULT_CHARS",
  hint_min_p: "JEV_HINT_MIN_P",
};

const cache = new Map<string, JevConfig>();

/** The merged `jev` block for a working directory. Malformed or absent layers fall back, never throw. */
export function jevConfig(cwd: string = process.cwd()): JevConfig {
  const cached = cache.get(cwd);
  if (cached) return cached;
  const merged: Record<string, unknown> = {};
  for (const file of [join(agentDir(), "herdr-delegator.json"), join(cwd, ".omp", "herdr-delegator.json")]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && "jev" in parsed && parsed.jev && typeof parsed.jev === "object") {
      Object.assign(merged, parsed.jev);
    }
  }
  const value: JevConfig = { ...JEV_DEFAULTS };
  for (const key of ["read_threshold_lines", "read_view_lines", "output_min_lines", "task_result_chars", "hint_min_p"] as const) {
    const configured = merged[key];
    const fromEnv = process.env[ENV_KEYS[key]];
    const candidate = typeof configured === "number" ? configured : fromEnv === undefined ? undefined : Number(fromEnv);
    if (candidate !== undefined && Number.isFinite(candidate) && candidate >= 0) value[key] = candidate;
  }
  if (!(value.hint_min_p >= 0 && value.hint_min_p <= 1)) value.hint_min_p = JEV_DEFAULTS.hint_min_p;
  const model = typeof merged.model === "string" && merged.model ? merged.model : process.env[ENV_KEYS.model];
  if (model) value.model = model;
  if (Array.isArray(merged.moments)) value.moments = merged.moments as JevMoment[];
  cache.set(cwd, value);
  return value;
}
