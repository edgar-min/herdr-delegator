import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ConfigSource, ThinkingLevel } from "./contracts";
import { ROLE_RE, SHA256_RE, compactMessage, isObject } from "./contracts";
import { isThinkingLevel, loadDelegatorConfig } from "./config";
import { observeRoleThinking } from "./role-thinking";

export const BOOTSTRAP_METADATA_SOURCE = "herdr-delegator:bootstrap";
// Freshness window a published pane-token set and fact nonce stay attestable for.
// Wide enough that a long turn which never reaches another lifecycle boundary
// still attests, and the MCP freshness gate (mcp/tools.ts) reads the same value
// so publication and verification can never disagree.
export const BOOTSTRAP_METADATA_TTL_MS = 300_000;
// Re-issued an order of magnitude more often than the TTL above, so a live
// session's published facts never sit near the edge of the freshness window.
export const BOOTSTRAP_REFRESH_INTERVAL_MS = 25_000;
// Longest a caller waits on one refresh attempt. Above the 15s an honest
// attempt can spend (10s pane convergence plus a 5s metadata report) and below
// both the refresh interval and OMP's per-handler event budget, so a stalled
// attempt can neither stack ticks nor hold a lifecycle handler open.
export const BOOTSTRAP_REFRESH_DEADLINE_MS = 20_000;
export const BOOTSTRAP_TOKEN_PREFIX = "herdr-delegator-";
export const BOOTSTRAP_TOKENS = {
  sessionId: `${BOOTSTRAP_TOKEN_PREFIX}session`,
  provider: `${BOOTSTRAP_TOKEN_PREFIX}provider`,
  model: `${BOOTSTRAP_TOKEN_PREFIX}model`,
  thinking: `${BOOTSTRAP_TOKEN_PREFIX}thinking`,
  attestation: `${BOOTSTRAP_TOKEN_PREFIX}attestation`,
} as const;

const MAX_PATH_BYTES = 4_096;
let lastBootstrapSequence = 0;
let activeBridgeRefresh: AbortController | undefined;
let activeBridgeLoop: AbortController | undefined;
// The context the pane's own session speaks through, plus the identity that
// proved itself by publishing. A subagent session runs inside this same process
// and OMP hands its context to the very lifecycle events this bridge listens
// to, so an ungated capture let a subagent become the publication identity for
// the rest of the turn: publication then failed the pane-convergence gate every
// tick, the pane's tokens aged past their TTL, and every guarded op in that
// window failed attest (friction 15ca828baf1b9d96, observed live on two panes).
let latestBridgeContext: ExtensionContext | undefined;
let paneBridgeSessionId: string | undefined;
// Newest context this bridge declined to adopt, and whether the pinned identity
// has since failed to publish. A declined context is never published from while
// the pin still works — that is the subagent case. It gets its turn only after
// an attempt under the pin fails, because that failure is the only evidence
// that the pin may no longer be the pane's session (an unannounced session
// change). A fallback still has to pass the same native convergence gate, so
// recovery costs one tick and never a human step.
let declinedBridgeContext: ExtensionContext | undefined;
let panePublishFailures = 0;

type ConcreteModel = { provider: string; model: string };

/**
 * A configured role as published. `thinking` is present only when the role is
 * bound to an explicit `:level` suffix, so a consumer reading no field reads
 * "this role imposes no level" — the same thing a pre-`thinking` bridge said.
 */
type RoleModel = ConcreteModel & { thinking?: ThinkingLevel };

export type OmpFactBridgeV1 = {
  version: 1;
  session_id: string;
  reported_session_path?: string;
  pane_id: string;
  cwd: string;
  current: ConcreteModel & { thinking: ThinkingLevel };
  roles: Record<`@${string}`, RoleModel>;
  config_sources: { scope: string; path: string; sha256: string }[];
  issued_at: string;
  nonce: string;
};

export type BootstrapSessionVerification = {
  session_id: string;
  reported_path: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  attestation: string;
  attested_at: string;
};

type HerdrResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string };

type SpawnedHerdrProcess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string | number): void;
};

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 80 &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)
  );
}

function assertBoundedPath(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    throw new Error(`${field} is not a bounded normalized absolute path.`);
  }
}

function concreteModel(value: ExtensionContext["model"], coordinate: string): ConcreteModel {
  const provider = value?.provider;
  const model = value?.id;
  if (!isBoundedToken(provider) || !isBoundedToken(model)) {
    throw new Error(`${coordinate} did not resolve to a bounded concrete provider/model.`);
  }
  return { provider, model };
}

function validatedConfigSources(sources: ConfigSource[]): OmpFactBridgeV1["config_sources"] {
  return sources.map((source) => {
    assertBoundedPath(source.path, `config source ${source.scope}`);
    if (!isBoundedToken(source.scope) || !SHA256_RE.test(source.sha256)) {
      throw new Error("A config source is not bounded or hash-verified.");
    }
    return { scope: source.scope, path: source.path, sha256: source.sha256 };
  });
}

function sessionValueIdentifiesId(value: string, sessionId: string): boolean {
  if (value === sessionId) return true;
  const filename = path.basename(value);
  const stem = filename.endsWith(".jsonl") ? filename.slice(0, -".jsonl".length) : filename;
  return stem === sessionId || stem.endsWith(`_${sessionId}`);
}

function officialOmpSessionValue(candidate: Record<string, unknown>): string | undefined {
  const session = candidate.agent_session;
  if (
    !isObject(session) ||
    session.source !== "herdr:omp" ||
    session.agent !== "omp" ||
    typeof session.value !== "string"
  ) {
    return undefined;
  }
  return session.value;
}

function collectMatchingObjects(
  value: unknown,
  predicate: (candidate: Record<string, unknown>) => boolean,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectMatchingObjects(item, predicate, out);
  } else if (isObject(value)) {
    if (predicate(value)) out.push(value);
    for (const item of Object.values(value)) collectMatchingObjects(item, predicate, out);
  }
  return out;
}

function matchingOfficialOmpPaneIds(
  data: unknown,
  sessionId: string,
  expectedPaneId?: string,
): string[] {
  return [
    ...new Set(
      collectMatchingObjects(data, (candidate) => {
        const paneId = candidate.pane_id;
        const sessionValue = officialOmpSessionValue(candidate);
        return (
          candidate.agent === "omp" &&
          typeof paneId === "string" &&
          (expectedPaneId === undefined || paneId === expectedPaneId) &&
          sessionValue !== undefined &&
          sessionValueIdentifiesId(sessionValue, sessionId)
        );
      }).map((candidate) => candidate.pane_id as string),
    ),
  ];
}

async function abortSafeDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("OMP bridge refresh was superseded.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", abort, { once: true });
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(new Error("OMP bridge refresh was superseded."));
    }
  });
}

async function findHerdrBinary(): Promise<string> {
  const bunWhich = Bun.which("herdr");
  if (bunWhich) return bunWhich;
  const entries = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, process.platform === "win32" ? "herdr.exe" : "herdr");
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  throw new Error("The Herdr binary was not found in PATH.");
}

async function runHerdr(
  binary: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HerdrResult> {
  let proc: SpawnedHerdrProcess;
  try {
    proc = Bun.spawn([binary, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    }) as SpawnedHerdrProcess;
  } catch {
    return { ok: false, code: "herdr_spawn_failed" };
  }

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let failureCode: string | undefined;
  const terminate = (code: string) => {
    failureCode = code;
    try {
      proc.kill("SIGKILL");
    } catch {}
  };
  const onAbort = () => terminate("operation_aborted");
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => terminate("herdr_timeout"), timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);
  const [stdout] = await Promise.all([stdoutPromise, stderrPromise]);
  if (failureCode) return { ok: false, code: failureCode };
  if (exitCode !== 0) return { ok: false, code: exitCode === 2 ? "herdr_cli_usage" : "herdr_error" };
  try {
    return { ok: true, data: stdout.trim() ? JSON.parse(stdout) : undefined };
  } catch {
    return { ok: false, code: "invalid_herdr_response" };
  }
}

async function resolveBootstrapPane(
  binary: string,
  sessionId: string,
  environmentPaneId: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("OMP bridge refresh was superseded.");
    const commandTimeout = Math.max(1, Math.min(1_000, deadline - Date.now()));
    if (environmentPaneId) {
      const environmentPane = await runHerdr(
        binary,
        ["pane", "get", environmentPaneId],
        commandTimeout,
        signal,
      );
      if (
        environmentPane.ok &&
        matchingOfficialOmpPaneIds(environmentPane.data, sessionId, environmentPaneId).length === 1
      ) {
        const confirmed = await runHerdr(
          binary,
          ["pane", "get", environmentPaneId],
          Math.max(1, Math.min(1_000, deadline - Date.now())),
          signal,
        );
        if (
          confirmed.ok &&
          matchingOfficialOmpPaneIds(confirmed.data, sessionId, environmentPaneId).length === 1
        ) {
          return environmentPaneId;
        }
      }
    }

    const agents = await runHerdr(binary, ["agent", "list"], commandTimeout, signal);
    const candidatePaneIds = agents.ok ? matchingOfficialOmpPaneIds(agents.data, sessionId) : [];
    const [candidatePaneId] = candidatePaneIds;
    if (candidatePaneIds.length === 1 && candidatePaneId) {
      const confirmed = await runHerdr(
        binary,
        ["pane", "get", candidatePaneId],
        Math.max(1, Math.min(1_000, deadline - Date.now())),
        signal,
      );
      if (
        confirmed.ok &&
        matchingOfficialOmpPaneIds(confirmed.data, sessionId, candidatePaneId).length === 1
      ) {
        return candidatePaneId;
      }
    }

    const delayMs = Math.min(100, deadline - Date.now());
    if (delayMs > 0) await abortSafeDelay(delayMs, signal);
  }
  throw new Error("No unique Herdr pane converged on this official OMP session within 10 seconds.");
}

function nextBootstrapSequence(): number {
  const clockSequence = Date.now() * 1_000;
  lastBootstrapSequence = Math.max(lastBootstrapSequence + 1, clockSequence);
  return lastBootstrapSequence;
}

function activeAgentDirectory(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agentDirectory = configured ? path.resolve(configured) : path.join(homedir(), ".omp", "agent");
  assertBoundedPath(agentDirectory, "active agent directory");
  return agentDirectory;
}

async function writeFactAtomic(fact: OmpFactBridgeV1): Promise<void> {
  const runtimeDirectory = path.join(
    activeAgentDirectory(),
    "herdr-delegator",
    "runtime",
    "omp-facts",
  );
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(runtimeDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("OMP fact runtime path is not a private directory.");
  }
  await chmod(runtimeDirectory, 0o700);

  const targetPath = path.join(runtimeDirectory, `${fact.session_id}.json`);
  const tempPath = path.join(
    runtimeDirectory,
    `.${fact.session_id}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const payload = `${JSON.stringify(fact, null, 2)}\n`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, targetPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
  }
}

async function reportBootstrapMetadata(
  binary: string,
  paneId: string,
  fact: OmpFactBridgeV1,
  signal: AbortSignal,
): Promise<void> {
  const tokenValues = [
    [BOOTSTRAP_TOKENS.sessionId, fact.session_id],
    [BOOTSTRAP_TOKENS.provider, fact.current.provider],
    [BOOTSTRAP_TOKENS.model, fact.current.model],
    [BOOTSTRAP_TOKENS.thinking, fact.current.thinking],
    [BOOTSTRAP_TOKENS.attestation, fact.nonce],
  ] as const;
  const args = [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    BOOTSTRAP_METADATA_SOURCE,
    "--agent",
    "omp",
    "--applies-to-source",
    "herdr:omp",
    ...tokenValues.flatMap(([name]) => ["--clear-token", name]),
    ...tokenValues.flatMap(([name, value]) => ["--token", `${name}=${value}`]),
    "--seq",
    String(nextBootstrapSequence()),
    "--ttl-ms",
    String(BOOTSTRAP_METADATA_TTL_MS),
  ];
  const result = await runHerdr(binary, args, 5_000, signal);
  if (!result.ok) throw new Error(`Bootstrap metadata report failed: ${result.code}.`);
}

async function refreshOmpBridge(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  activeBridgeRefresh?.abort();
  activeBridgeRefresh = undefined;
  const aborter = new AbortController();
  activeBridgeRefresh = aborter;
  let targetPaneId: string | undefined;
  let attemptSessionId: string | undefined;
  try {
    if (process.env.HERDR_ENV !== "1") {
      throw new Error("The current OMP session is not running in Herdr.");
    }
    const environmentPaneId = process.env.HERDR_PANE_ID;
    if (environmentPaneId !== undefined && !isBoundedToken(environmentPaneId)) {
      throw new Error("The current OMP session exposed an unbounded Herdr pane identity.");
    }
    const sessionId = ctx.sessionManager.getSessionId();
    attemptSessionId = isBoundedToken(sessionId) ? sessionId : undefined;
    const reportedSessionPath = ctx.sessionManager.getSessionFile();
    const cwd = ctx.cwd;
    const thinking = pi.getThinkingLevel();
    if (!isBoundedToken(sessionId) || !isThinkingLevel(thinking)) {
      throw new Error("OMP did not expose a bounded session/thinking identity.");
    }
    assertBoundedPath(cwd, "cwd");
    // `reported_session_path` is an OPTIONAL corroborating field, so a value
    // that does not identify this session may not cost the session its whole
    // publication. A spawned pane's `getSessionFile()` does not name the live
    // session id until the pane has been driven, so aborting here left a born
    // pane with no bootstrap tokens and no fact for its entire pre-drive window:
    // every guarded op failed attest with "Caller pane has no bootstrap metadata
    // tokens" and only human input healed it (friction 4ff52b2d863b8532,
    // d7e9a5e774b89a4f). Omitting the field keeps identity exactly as strict:
    // `session_id` still comes from OMP, publication still requires a unique
    // Herdr pane whose native `agent_session` identifies that id
    // (`resolveBootstrapPane`), and the verifier cross-checks this field only
    // when it is present (mcp/tools.ts loadFacts).
    let publishedSessionPath: string | undefined;
    if (reportedSessionPath !== undefined) {
      assertBoundedPath(reportedSessionPath, "reported session path");
      if (sessionValueIdentifiesId(reportedSessionPath, sessionId)) {
        publishedSessionPath = reportedSessionPath;
      } else {
        pi.logger.warn(
          "herdr-delegator OMP bridge omitted a reported session path that does not identify the active session",
          { session_id: sessionId, reported_session_path: reportedSessionPath },
        );
      }
    }

    const current = concreteModel(ctx.models.current(), "current model");
    const { config, sources } = await loadDelegatorConfig(undefined, cwd);
    const roleAliases = new Set([
      config.orchestrator.role,
      ...Object.values(config.worker_profiles).map((profile) => profile.role),
    ]);
    const roles = {} as Record<`@${string}`, RoleModel>;
    for (const role of roleAliases) {
      if (role.length > 80 || !ROLE_RE.test(role)) {
        throw new Error(`Configured role ${JSON.stringify(role)} is not bounded.`);
      }
      const model = concreteModel(ctx.models.resolve(role), `role ${role}`);
      const roleThinking = await observeRoleThinking(role);
      roles[role as `@${string}`] = roleThinking === undefined ? model : { ...model, thinking: roleThinking };
    }

    const binary = await findHerdrBinary();
    targetPaneId = await resolveBootstrapPane(
      binary,
      sessionId,
      environmentPaneId,
      aborter.signal,
    );
    if (!isBoundedToken(targetPaneId)) throw new Error("Resolved Herdr pane ID is not bounded.");
    const issuedAtMs = Date.now();
    const fact: OmpFactBridgeV1 = {
      version: 1,
      session_id: sessionId,
      ...(publishedSessionPath === undefined ? {} : { reported_session_path: publishedSessionPath }),
      pane_id: targetPaneId,
      cwd,
      current: { ...current, thinking },
      roles,
      config_sources: validatedConfigSources(sources),
      issued_at: new Date(issuedAtMs).toISOString(),
      nonce: `${issuedAtMs}.${randomBytes(8).toString("hex")}`,
    };
    await reportBootstrapMetadata(binary, targetPaneId, fact, aborter.signal);
    await writeFactAtomic(fact);
    // Publication is the only proof of pane ownership: it required a unique
    // Herdr pane whose native `agent_session` identifies this session id. So the
    // identity that just published becomes the one this bridge speaks as, and
    // the context that carried it becomes the context later ticks reuse.
    paneBridgeSessionId = sessionId;
    panePublishFailures = 0;
    latestBridgeContext = ctx;
    if (declinedBridgeContext === ctx) declinedBridgeContext = undefined;
  } catch (error) {
    if (!aborter.signal.aborted) {
      pi.logger.warn("herdr-delegator OMP bridge refresh failed", {
        error: compactMessage(error instanceof Error ? error.message : error, "OMP bridge refresh failed."),
        pane_id: targetPaneId,
      });
      // Attribution decides who publishes next. A failure under the pinned
      // identity is the only evidence that the pin may have stopped being the
      // pane's session, so it opens the door to the declined context; a failure
      // by the declined context proves it is not the pane either, so it is
      // dropped and the pin keeps the heartbeat.
      if (attemptSessionId !== undefined && attemptSessionId === paneBridgeSessionId) panePublishFailures += 1;
      else if (paneBridgeSessionId !== undefined) declinedBridgeContext = undefined;
    }
  } finally {
    if (activeBridgeRefresh === aborter) activeBridgeRefresh = undefined;
  }
}

function loopDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }
    function abort(): void {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/**
 * One refresh attempt, bounded for the caller. `refreshOmpBridge` awaits a
 * config read, per-role observation and up to three Herdr subprocesses, and
 * only the subprocess waits honor the abort signal — so an attempt can outlive
 * its usefulness. The deadline bounds what the caller waits for, never the
 * attempt itself: the next attempt supersedes a straggler through
 * `activeBridgeRefresh.abort()`. Unbounded, a single stalled attempt froze the
 * heartbeat for the rest of the session (friction bb2aec9368fa7a59).
 */
async function refreshWithinDeadline(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  let cancelDeadline = (): void => {};
  try {
    await Promise.race([
      refreshOmpBridge(pi, ctx),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, BOOTSTRAP_REFRESH_DEADLINE_MS);
        timer.unref();
        cancelDeadline = () => clearTimeout(timer);
      }),
    ]);
  } finally {
    cancelDeadline();
  }
}

function stopBridgeRefreshLoop(): void {
  activeBridgeLoop?.abort();
  activeBridgeLoop = undefined;
}

/**
 * Idempotent heartbeat, owned by the session rather than by any one event.
 * Registration used to stop the loop and rebuild it inside every lifecycle
 * handler, so publication liveness depended on that handler reaching its last
 * line: one stall between the stop and the restart left the session with no
 * publisher, and nothing inside the session could start one again — the shape of
 * the entry-gate outage in friction bb2aec9368fa7a59. The loop now starts once,
 * reads whichever context is current, and stops only at session shutdown.
 */
function ensureBridgeRefreshLoop(pi: ExtensionAPI): void {
  if (activeBridgeLoop) return;
  const aborter = new AbortController();
  activeBridgeLoop = aborter;
  void (async () => {
    while (await loopDelay(BOOTSTRAP_REFRESH_INTERVAL_MS, aborter.signal)) {
      if (activeBridgeLoop !== aborter) return;
      const ctx = selectBridgeContext(pi);
      if (ctx) await refreshWithinDeadline(pi, ctx);
    }
  })();
}

/**
 * Adopts a lifecycle context only when it can be the pane's own session, and
 * answers which context the next publication attempt should use.
 *
 * Before any identity has published, every context is a candidate: publication
 * itself is the gate, and it fails safe under a foreign identity. Once an
 * identity has published, a context carrying a different session id is a
 * different session inside this process — a subagent — and it is remembered
 * without displacing the pane. It becomes the publisher only after an attempt
 * under the pin has failed, since that failure is the only evidence that the pin
 * may have stopped being the pane's session.
 */
function selectBridgeContext(pi: ExtensionAPI, ctx?: ExtensionContext): ExtensionContext | undefined {
  let eventSessionId: string | undefined;
  if (ctx) {
    const sessionId = ctx.sessionManager.getSessionId();
    eventSessionId = isBoundedToken(sessionId) ? sessionId : undefined;
    if (paneBridgeSessionId === undefined || sessionId === paneBridgeSessionId) {
      latestBridgeContext = ctx;
      declinedBridgeContext = undefined;
    } else {
      declinedBridgeContext = ctx;
    }
  }
  const publisher =
    panePublishFailures > 0 && declinedBridgeContext ? declinedBridgeContext : latestBridgeContext ?? declinedBridgeContext;
  if (ctx && publisher !== ctx) {
    pi.logger.debug("herdr-delegator OMP bridge kept the pane session as its publication identity", {
      pane_session_id: paneBridgeSessionId,
      event_session_id: eventSessionId,
    });
  }
  return publisher;
}

export function registerOmpBridge(pi: ExtensionAPI): void {
  const refresh = async (_event: unknown, ctx: ExtensionContext) => {
    const publisher = selectBridgeContext(pi, ctx);
    // Heartbeat before the attempt, never after it: the attempt below can fail
    // or stall, and a session that publishes nothing has no in-session way
    // back. `/reload-plugins` reloads skills, commands, agents and MCP servers
    // but never re-runs an extension, so a silent bridge stays silent for the
    // life of the session (friction bb2aec9368fa7a59).
    ensureBridgeRefreshLoop(pi);
    if (publisher) await refreshWithinDeadline(pi, publisher);
  };
  pi.on("session_start", refresh);
  pi.on("session_switch", refresh);
  pi.on("before_agent_start", refresh);

  pi.on("session_shutdown", async () => {
    stopBridgeRefreshLoop();
    activeBridgeRefresh?.abort();
    activeBridgeRefresh = undefined;
    latestBridgeContext = undefined;
    declinedBridgeContext = undefined;
    paneBridgeSessionId = undefined;
    panePublishFailures = 0;
  });
}
