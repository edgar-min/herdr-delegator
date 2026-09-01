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
const FOCUS_READ_TIMEOUT_MS = 5_000;
export const NOTIFY_TICK_PLAN = { first_delay_ms: 60_000, second_delay_ms: 90_000, max_delay_ms: 150_000 } as const;
export type NotifyDispatch =
  | { delivery: "delivered" }
  | { delivery: "deferred"; pane_id: string; tick_plan: typeof NOTIFY_TICK_PLAN; completion: Promise<HerdrCommandResult> };

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

function records(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) records(item, out);
    return out;
  }
  const record = value as Record<string, unknown>;
  out.push(record);
  for (const child of Object.values(record)) records(child, out);
  return out;
}

function targetPaneId(snapshot: unknown, target: string): string | undefined {
  const candidates = records(snapshot);
  const direct = candidates.find((candidate) => candidate.pane_id === target);
  if (direct) return target;
  const agent = candidates.find((candidate) =>
    (candidate.name === target || candidate.agent_name === target) &&
    typeof candidate.pane_id === "string");
  return typeof agent?.pane_id === "string" ? agent.pane_id : undefined;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  timer.unref();
  return promise;
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
  private async targetFocus(target: string): Promise<{ pane_id: string; focused: boolean } | undefined> {
    const snapshot = await this.execute(["api", "snapshot"], FOCUS_READ_TIMEOUT_MS, false);
    const focusedPaneId = valuesForKey(snapshot.data, "focused_pane_id")
      .find((value) => typeof value === "string" && value.length > 0 && value.length <= 80);
    if (typeof focusedPaneId !== "string") return undefined;
    const paneId = targetPaneId(snapshot.data, target);
    return paneId ? { pane_id: paneId, focused: paneId === focusedPaneId } : undefined;
  }

  /**
   * Fire-and-forget non-authoritative doorbell. A focused target is deferred in
   * the server process: 60s, one re-probe, then an optional final 90s delay.
   * Every path reaches one guarded send. Probe uncertainty fails open.
   */
  async notify(target: string, text: string, timeoutMs: number): Promise<NotifyDispatch> {
    let firstProbe: { pane_id: string; focused: boolean } | undefined;
    try { firstProbe = await this.targetFocus(target); }
    catch {
      await this.execute(["agent", "prompt", target, text], timeoutMs, true);
      return { delivery: "delivered" };
    }
    if (!firstProbe?.focused) {
      await this.execute(["agent", "prompt", target, text], timeoutMs, true);
      return { delivery: "delivered" };
    }

    let sent = false;
    const sendOnce = async (): Promise<HerdrCommandResult> => {
      if (sent) throw new McpContractError("duplicate_doorbell_send", "A deferred doorbell attempted to send twice.", "prompt", "Preserve the durable document and inspect messages.jsonl; never replay this bell.");
      sent = true;
      return this.execute(["agent", "prompt", target, text], timeoutMs, true);
    };
    // Timers are deliberately unref'ed: server shutdown may drop this soft bell,
    // which is acceptable only because the report/channel document already holds
    // the authoritative content. A missing final messages.jsonl line exposes it.
    const completion = (async () => {
      await delay(NOTIFY_TICK_PLAN.first_delay_ms);
      let secondProbe: { pane_id: string; focused: boolean } | undefined;
      try { secondProbe = await this.targetFocus(target); }
      catch { return sendOnce(); }
      if (secondProbe?.focused) await delay(NOTIFY_TICK_PLAN.second_delay_ms);
      return sendOnce();
    })();
    return { delivery: "deferred", pane_id: firstProbe.pane_id, tick_plan: NOTIFY_TICK_PLAN, completion };
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
  reportObservation(paneId: string, responsibility: string, assignment: string, state: AssignmentState, sequence: number, timeoutMs: number, label?: string): Promise<HerdrCommandResult> {
    // Identity first, decoration last. The title is bounded, so appending the
    // display-only label lets a long responsibility truncate the label and
    // never the coordinate that identifies the lane. The `assignment` token
    // stays the bare ID: a metadata identity token is never a label, and the
    // label grammar excludes `=` and whitespace so it cannot split one either.
    const title = `${responsibility} · ${assignment}${label ? ` · ${label}` : ""}`.slice(0, 80);
    const visibleState = state === "completed" || state === "failed" || state === "blocked" || state === "queued" ? state : "working";
    return this.execute(["pane", "report-metadata", paneId, "--source", OBSERVATION_SOURCE, "--title", title, "--seq", String(sequence), "--token", `responsibility=${responsibility}`, "--token", `assignment=${assignment}`, "--token", `assignment-state=${visibleState}`], timeoutMs, true, true);
  }
}
