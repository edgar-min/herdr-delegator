import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { MAX_EFFECTIVE_WAIT_MS, McpContractError, OBSERVATION_SOURCE, type AssignmentState } from "./contracts";

export type HerdrCommandResult = { data: unknown; stdout: string; warning?: string; timedOut?: boolean };
const MAX_OUTPUT_BYTES = 1024 * 1024;
const REQUIRED_CAPABILITIES = ["agent.prompt", "agent.wait", "agent.start", "pane.wait_for_output", "pane.report_metadata"] as const;
// Ordered most specific first: `agent get` reports the lifecycle state under one of these.
const AGENT_STATUS_KEYS = ["agent_status", "state", "status"] as const;
// A bounded read used only to prove an already-satisfied wait or a delivered prompt.
const STATUS_READ_TIMEOUT_MS = 5_000;

function bounded(value: string): string { return value.length <= 500 ? value : `${value.slice(0, 497)}...`; }
function valuesForKey(value: unknown, key: string, out: unknown[] = []): unknown[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) { for (const item of value) valuesForKey(item, key, out); return out; }
  for (const [candidate, child] of Object.entries(value as Record<string, unknown>)) {
    if (candidate === key) out.push(child);
    valuesForKey(child, key, out);
  }
  return out;
}

function agentStatusOf(data: unknown): string | undefined {
  for (const key of AGENT_STATUS_KEYS) {
    const found = valuesForKey(data, key).find((value) => typeof value === "string" && value.length > 0 && value.length <= 64);
    if (typeof found === "string") return found;
  }
  return undefined;
}

/**
 * True only for a failure that proves Herdr accepted the prompt and then failed
 * while observing the status stream. Delivery failures and our own mutation
 * timeout stay ambiguous and are never recovered here.
 */
function isStatusWaitFailure(error: unknown): boolean {
  if (!(error instanceof McpContractError) || error.ambiguousEffect) return false;
  return /waiting for agent status|agent_wait_timeout|status_wait_timeout/i.test(`${error.code} ${error.message}`);
}

/**
 * True only for a non-ambiguous read-path failure that proves the wait window
 * elapsed without the requested state: the Herdr CLI's own `timeout` error or
 * this adapter's read-side abort. Mutation timeouts stay ambiguous elsewhere.
 */
function isWaitWindowTimeout(error: unknown): boolean {
  if (!(error instanceof McpContractError) || error.ambiguousEffect) return false;
  return error.code === "timeout" || error.code === "wait_timeout" || isStatusWaitFailure(error);
}

export class HerdrAdapter {
  private constructor(readonly binary: string) {}

  static async create(configuredBinary?: string): Promise<HerdrAdapter> {
    const candidates = [process.env.HERDR_BIN_PATH, configuredBinary, "herdr"].filter((v): v is string => !!v);
    let selected: string | undefined;
    for (const candidate of candidates) {
      if (candidate === "herdr") { selected = candidate; break; }
      try {
        const canonical = await realpath(candidate);
        await access(canonical, constants.X_OK);
        selected = canonical;
        break;
      } catch { /* try the next bounded source */ }
    }
    if (!selected) throw new McpContractError("herdr_not_found", "No executable Herdr binary was found.", "attest", "Set HERDR_BIN_PATH or the verified configured binary.");
    const adapter = new HerdrAdapter(selected);
    await adapter.verifySchema();
    return adapter;
  }

  private async execute(args: readonly string[], timeoutMs: number, mutating: boolean, tolerateNonJson = false): Promise<HerdrCommandResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const proc = Bun.spawn([this.binary, ...args], { stdout: "pipe", stderr: "pipe", signal: controller.signal, env: process.env });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (stdout.length > MAX_OUTPUT_BYTES || stderr.length > MAX_OUTPUT_BYTES) throw new McpContractError("herdr_output_too_large", "Herdr returned output beyond the bounded adapter limit.", mutating ? "prompt" : "wait", "Inspect Herdr directly; do not retry a mutation.", mutating, !mutating);
      if (exitCode !== 0) {
        let code = "herdr_command_failed";
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          const nested = parsed.error;
          const found = typeof parsed.code === "string" ? parsed.code : (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).code === "string" ? (nested as Record<string, unknown>).code as string : undefined);
          if (found) code = found;
        } catch { /* normalized below */ }
        throw new McpContractError(code, bounded(stderr || stdout || `Herdr exited ${exitCode}.`), mutating ? "prompt" : "wait", mutating ? "Inspect the exact target and registry journal before any replay." : "Retry the read-only observation.", false, !mutating);
      }
      let data: unknown;
      try { data = JSON.parse(stdout); }
      catch {
        // Some bounded Herdr commands (e.g. `pane report-metadata`) report success
        // with a zero exit code and no JSON body; accept that shape explicitly.
        if (!tolerateNonJson) throw new McpContractError("invalid_herdr_response", "Herdr stdout was not JSON.", mutating ? "prompt" : "wait", "Verify the installed Herdr 0.8.2 schema and binary selection.", mutating, false);
        return { data: undefined, stdout, warning: stdout.trim() ? `Herdr returned a non-JSON success body: ${bounded(stdout.trim())}` : undefined };
      }
      return { data, stdout };
    } catch (error: unknown) {
      if (controller.signal.aborted) throw new McpContractError(mutating ? "herdr_mutation_timeout" : "wait_timeout", `Herdr ${mutating ? "mutation" : "observation"} timed out.`, mutating ? "prompt" : "wait", mutating ? "Treat the effect as ambiguous and inspect before replay." : "The observation had no effect and may be retried.", mutating, !mutating);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async verifySchema(): Promise<void> {
    let result: HerdrCommandResult;
    try { result = await this.execute(["api", "schema", "--json"], 10_000, false); }
    catch (error) { throw new McpContractError("herdr_schema_incompatible", `Unable to read Herdr API schema: ${error instanceof Error ? error.message : String(error)}`, "attest", "Install Herdr 0.8.2 with protocol 20 and schema version 1."); }
    const protocol = valuesForKey(result.data, "protocol").find((v) => typeof v === "number");
    const version = valuesForKey(result.data, "schema_version").find((v) => typeof v === "number");
    const serialized = JSON.stringify(result.data);
    const missing = REQUIRED_CAPABILITIES.filter((capability) => !serialized.includes(capability));
    if (protocol !== 20 || version !== 1 || missing.length) throw new McpContractError("herdr_schema_incompatible", `Herdr schema mismatch${missing.length ? `; missing ${missing.join(", ")}` : ""}.`, "attest", "Install the supported Herdr 0.8.2 capability set.");
  }

  getAgent(target: string, timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["agent", "get", target], timeoutMs, false); }
  listAgents(timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["agent", "list"], timeoutMs, false); }
  /**
   * Prompts and waits for a requested terminal state. A failure that proves only
   * the status observation broke resolves against a bounded fresh inspection: the
   * prompt already landed, so it is reported as the effective mutation it is.
   */
  async prompt(target: string, text: string, until: string[], timeoutMs: number): Promise<HerdrCommandResult> {
    const waitMs = Math.min(timeoutMs, MAX_EFFECTIVE_WAIT_MS);
    const args = ["agent", "prompt", target, text, "--wait", ...until.flatMap((state) => ["--until", state]), "--timeout", String(waitMs)];
    try { return await this.execute(args, waitMs + 1_000, true); }
    catch (error) {
      if (!isStatusWaitFailure(error)) throw error;
      const observed = await this.getAgent(target, STATUS_READ_TIMEOUT_MS);
      const status = agentStatusOf(observed.data);
      if (!status) throw error;
      return { data: observed.data, stdout: observed.stdout, warning: `Prompt landed but the status wait did not settle; the agent was freshly observed as ${bounded(status)}.` };
    }
  }
  /**
   * Fire-and-forget non-authoritative doorbell. Submits one prompt without a
   * settled-state wait; delivery failures are mapped by the caller into soft
   * observations, never contract errors.
   */
  notify(target: string, text: string, timeoutMs: number): Promise<HerdrCommandResult> {
    return this.execute(["agent", "prompt", target, text], timeoutMs, true);
  }
  /**
   * Waits for one of `until`. An already-satisfied state is proved by a fresh read
   * before subscribing, so a current state never times out. A wait window that
   * elapses is a no-effect observation, never an error: the agent is freshly read
   * and returned with `timedOut` so callers surface it as a normal result.
   */
  async wait(target: string, until: string[], timeoutMs: number): Promise<HerdrCommandResult> {
    const waitMs = Math.min(timeoutMs, MAX_EFFECTIVE_WAIT_MS);
    const current = await this.getAgent(target, Math.min(waitMs, STATUS_READ_TIMEOUT_MS));
    const status = agentStatusOf(current.data);
    if (status !== undefined && until.includes(status)) return current;
    try {
      return await this.execute(["agent", "wait", target, ...until.flatMap((state) => ["--until", state]), "--timeout", String(waitMs)], waitMs + 1_000, false);
    } catch (error) {
      if (!isWaitWindowTimeout(error)) throw error;
      const observed = await this.getAgent(target, STATUS_READ_TIMEOUT_MS);
      const observedStatus = agentStatusOf(observed.data);
      if (observedStatus !== undefined && until.includes(observedStatus)) return observed;
      return { data: observed.data, stdout: observed.stdout, timedOut: true, warning: `Wait window elapsed without reaching ${until.join("/")}; the agent was freshly observed as ${bounded(observedStatus ?? "unknown")}.` };
    }
  }
  startAgent(name: string, paneId: string, args: readonly string[], timeoutMs: number): Promise<HerdrCommandResult> {
    return this.execute(["agent", "start", name, "--kind", "omp", "--pane", paneId, "--", ...args], timeoutMs, true);
  }
  sendText(paneId: string, text: string, timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["pane", "send-text", paneId, text], timeoutMs, true); }
  sendKeys(paneId: string, keys: readonly string[], timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["pane", "send-keys", paneId, ...keys], timeoutMs, true); }
  closeTab(tabId: string, timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["tab", "close", tabId], timeoutMs, true); }
  getPane(paneId: string, timeoutMs: number): Promise<HerdrCommandResult> { return this.execute(["pane", "get", paneId], timeoutMs, false); }
  /**
   * Terminal/progress observation. `pane report-metadata` is bounded and may emit
   * no JSON on success, so the parse is tolerant; callers degrade any residual
   * failure to a warning rather than ambiguating a committed mutation.
   */
  reportObservation(paneId: string, responsibility: string, assignment: string, state: AssignmentState, sequence: number, timeoutMs: number): Promise<HerdrCommandResult> {
    const title = `${responsibility} · ${assignment}`.slice(0, 80);
    const visibleState = state === "completed" || state === "failed" || state === "blocked" || state === "queued" ? state : "working";
    return this.execute(["pane", "report-metadata", paneId, "--source", OBSERVATION_SOURCE, "--title", title, "--seq", String(sequence), "--token", `responsibility=${responsibility}`, "--token", `assignment=${assignment}`, "--token", `assignment-state=${visibleState}`], timeoutMs, true, true);
  }
}
