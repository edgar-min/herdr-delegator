#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodError, type ZodType } from "zod";
import { HerdrAdapter } from "./herdr-adapter";
import { mountedBuild } from "./registry";
import { ASSIGNMENT_ID_GUIDANCE, ASSIGNMENT_RE, COORDINATE_RE, herdrAssignmentInputShape, herdrAssignmentSchema, herdrFrictionInputShape, herdrFrictionSchema, herdrMessageInputShape, herdrMessageSchema, herdrTrackInputShape, herdrTrackSchema, herdrWorkerInputShape, herdrWorkerSchema, type McpResult, type ToolName } from "./contracts";
import { CompositeTools } from "./tools";
import { check } from "./jev/check";
import { jevConfig } from "./jev/config";
import { judgeAuthoring, judgeEscalation, judgeIntake, judgePlan, judgeSettlement } from "./jev/judge";
import { rankChunks, rankPaths } from "./jev/rank";
import { appendOutcome, LOG_IDENTIFIER_RE, summarize } from "./jev/log";

// A tool result echoes the action it was asked for, so a rejected one may only
// echo a bounded token — never an arbitrary caller string.
const ACTION_RE = /^[a-z_]{1,32}$/;

/**
 * A schema rejection is a contract answer, not a transport accident.
 *
 * `<schema>.parse(input)` used to throw straight out of the handler, and the
 * SDK turned that escape into a bare text result carrying no code, no phase and
 * no recovery — the shape that made a refused assignment ID read as a naming
 * problem instead of a grammar one, so it was renamed rather than corrected
 * (friction 87ef22382241e18f).
 *
 * Two gates now share the refusal work, and only one of them is ours. The
 * published input shape is validated by the SDK before any handler runs, so a
 * per-field grammar violation (an `A-R1`) is refused there as the SDK's plain
 * `isError` text — carrying the same authored sentence the schema publishes,
 * but not an `McpResult`, because no handler exists yet to build one. This
 * function is the second gate, for what a per-field shape cannot express — the
 * fields one action requires, keys no action accepts, and the discriminator —
 * and everything it refuses is an ordinary `McpResult`. Recovery is authored
 * contract text: a zod message is never reused as guidance, only its stable
 * issue codes are reported.
 */
function invalidToolInput(tool: ToolName, input: unknown, error: ZodError): McpResult {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const coordinate = (value: unknown): string => (typeof value === "string" && COORDINATE_RE.test(value) ? value : "unknown");
  const issues = [...new Set(error.issues.map((issue) => `${issue.path.join(".") || "(root)"} (${issue.code})`))].slice(0, 8);
  const assignmentIdRejected = error.issues.some((issue) => issue.path[0] === "assignment_id");
  return {
    ok: false,
    tool,
    action: typeof raw.action === "string" && ACTION_RE.test(raw.action) ? raw.action : "unknown",
    run: { track_id: coordinate(raw.track_id), run_id: coordinate(raw.run_id) },
    effect: "none",
    retryable: false,
    error: {
      code: "invalid_tool_input",
      phase: "validate",
      message: `${tool} rejected its input at ${issues.join("; ")}.`,
      recovery: `Send exactly the fields the requested action declares in the published input schema: each action is a closed set, so a missing field and an extra one are both refusals rather than hints.${assignmentIdRejected ? ` ${ASSIGNMENT_ID_GUIDANCE}` : ""}`,
      ambiguous_effect: false,
    },
    data: { build: mountedBuild() },
  };
}

/**
 * herdr_jev publishes the Jev module's four actions. It is not a delegation tool: it holds no run state and
 * settles nothing, so it answers with the action's own compact JSON instead of an McpResult and its refusals
 * carry that same shape. The only thing it writes is the append-only calibration log — never the registry, a
 * lane, or an assignment. Validation is still the same two-gate arrangement the other five use — the SDK
 * refuses a published-shape violation before the handler, and the discriminated union below refuses the field
 * combinations one action forbids.
 */
const JEV_ACTION_DESCRIPTION = `rank: order candidate paths (path_only) or the chunks of those files by the probability that each serves \`intent\`; every candidate comes back in probability order and nothing is dropped by a threshold. \`top\` is an INPUT bound, not an output top-K: it is how many of the given paths, in the order given, are read and chunked, every path beyond it is returned in \`unevaluated\` with that reason, and \`path_only\` ignores it because no file is read.
judge with moment "authoring": judge a draft or registered assignment before dispatch — three Score questions (purpose understandable without prior context, terms defined or self-evident, next action unambiguous), one Noul per "# Completion conditions" bullet asking whether the condition is observable rather than self-asserted, one Noul for specification maturity, and one Choice over the configured worker profiles whose criteria are their intent strings. Takes track_id+run_id+assignment_id, or file for a draft.
judge with moment "settlement": judge a reported boundary — per condition one Noul that it is met according to this assignment's segment of the lane report and the diff of its owned paths, plus one Choice over the report paragraphs with a \`none\` sentinel naming the supporting paragraph; one Noul that the report separates claims from evidence; one Noul that the unowned changed paths indicate a change outside declared write ownership; one Score over [reject, requery, accept]. The change set is base..HEAD plus staged, unstaged and untracked paths, base being the last commit before the assignment was dispatched unless base is given; attribution is always "ambiguous" because the working directory is shared.
judge with moment "escalate": judge whether a question should interrupt a human — one Choice over the ladder [autonomous, machine_check, human] and two Nouls (work cannot safely continue until the question is answered; a wrong autonomous answer could be undone cheaply), combined into one line of ASK HUMAN, decide or observe. Takes a required question and an optional context of what the mandate, plan or evidence already say; it reads no run state, and an approval the human reserved stays mandatory whatever it returns.
judge with moment "intake": judge a worker's own restatement against the canonical assignment at its coordinate — three Nouls (the restatement describes the same work the goal assigns; every "# Completion conditions" bullet is accounted for; the planned work stays inside write ownership, dependencies and user boundaries). Coverage is asked separately from alignment, so a restatement that echoes one condition well is not read as a complete one. Takes track_id+run_id+assignment_id and restatement.
judge with moment "plan": judge this run's own two documents against each other — three Nouls (work the plan proposes still depends on information neither document resolves; every outcome the mandate requires appears as work in the plan; each proposed item names its owner and what it waits on). An item recorded as a decision the user already made is settled information, not an unresolved question. Takes track_id+run_id only, and generates no decomposition and no approval.
check: per sentence one Noul that some chunk of reference_paths supports it and one Choice naming that chunk or \`none\`.
log with op "outcome": append one calibration outcome row for a request_id, recording what actually happened next as a short identifier; no note and no body are accepted. log with op "summary": read the configured calibration log and report, per requested request_id, its decision counts by stage and question, the outcome identifiers already recorded, and whether any decision row exists at all, plus the number of malformed rows skipped. log makes no model call, infers no accuracy, labels no outcome for you, and returns no row body.
Every judged call appends one calibration row per question, carrying identifiers only and never document text, and returns the request_id those rows carry. All four actions are read-only for the registry and advisory: they change no registry, lane, or assignment, and the ORCH judges.`;

/** The log surface counts rows; it never claims a judgment was right. */
const JEV_LOG_ADVISORY = "Counts of recorded rows only: no accuracy is inferred, no outcome is labeled for you, and no row body is returned.";
const jevPath = z.string().min(1).max(4096);
const herdrJevInputShape = {
  action: z.enum(["rank", "judge", "check", "log"]).describe(JEV_ACTION_DESCRIPTION),
  intent: z.string().min(1).max(2000).optional(),
  paths: z.array(jevPath).min(1).max(500).optional(),
  path_only: z.boolean().optional(),
  top: z.number().int().min(1).max(100).optional(),
  moment: z.enum(["authoring", "settlement", "escalate", "intake", "plan"]).optional(),
  track_id: z.string().regex(COORDINATE_RE).optional(),
  run_id: z.string().regex(COORDINATE_RE).optional(),
  assignment_id: z.string().regex(ASSIGNMENT_RE).optional(),
  file: jevPath.optional(),
  base: z.string().min(1).max(256).optional(),
  question: z.string().min(1).max(2000).optional(),
  context: z.string().min(1).max(16000).optional(),
  sentences: z.array(z.string().min(1).max(2000)).min(1).max(32).optional(),
  reference_paths: z.array(jevPath).min(1).max(32).optional(),
  restatement: z.string().min(1).max(16000).optional(),
  op: z.enum(["outcome", "summary"]).optional(),
  request_id: z.string().regex(LOG_IDENTIFIER_RE).optional(),
  outcome: z.string().regex(LOG_IDENTIFIER_RE).optional(),
  request_ids: z.array(z.string().regex(LOG_IDENTIFIER_RE)).min(1).max(500).optional(),
};
const herdrJevSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("rank"), intent: z.string().min(1).max(2000), paths: z.array(jevPath).min(1).max(500), path_only: z.boolean().optional(), top: z.number().int().min(1).max(100).optional() }).strict(),
  // `judge` carries a second discriminator. The artifact moments keep exactly the fields they
  // already accept, and `escalate` is its own closed set: it reads no registry state, so a
  // coordinate, file or base sent with it is a refusal rather than a silently ignored field.
  z.discriminatedUnion("moment", [
    z.object({ action: z.literal("judge"), moment: z.enum(["authoring", "settlement"]), track_id: z.string().regex(COORDINATE_RE).optional(), run_id: z.string().regex(COORDINATE_RE).optional(), assignment_id: z.string().regex(ASSIGNMENT_RE).optional(), file: jevPath.optional(), base: z.string().min(1).max(256).optional() }).strict(),
    z.object({ action: z.literal("judge"), moment: z.literal("escalate"), question: z.string().min(1).max(2000), context: z.string().min(1).max(16000).optional() }).strict(),
    z.object({ action: z.literal("judge"), moment: z.literal("intake"), track_id: z.string().regex(COORDINATE_RE), run_id: z.string().regex(COORDINATE_RE), assignment_id: z.string().regex(ASSIGNMENT_RE), restatement: z.string().min(1).max(16000) }).strict(),
    z.object({ action: z.literal("judge"), moment: z.literal("plan"), track_id: z.string().regex(COORDINATE_RE), run_id: z.string().regex(COORDINATE_RE) }).strict(),
  ]),
  z.object({ action: z.literal("check"), sentences: z.array(z.string().min(1).max(2000)).min(1).max(32), reference_paths: z.array(jevPath).min(1).max(32) }).strict(),
  // `log` is the only action that writes, and it writes one identifier row to the calibration
  // log — never the registry. Its two operations are disjoint closed sets, so the second
  // discriminator is `op` for the same reason `judge` discriminates on `moment`.
  z.discriminatedUnion("op", [
    z.object({ action: z.literal("log"), op: z.literal("outcome"), request_id: z.string().regex(LOG_IDENTIFIER_RE), outcome: z.string().regex(LOG_IDENTIFIER_RE) }).strict(),
    z.object({ action: z.literal("log"), op: z.literal("summary"), request_ids: z.array(z.string().regex(LOG_IDENTIFIER_RE)).min(1).max(500) }).strict(),
  ]),
]);
type HerdrJevInput = z.infer<typeof herdrJevSchema>;

async function jevAction(input: HerdrJevInput): Promise<object> {
  if (input.action === "rank") {
    return input.path_only ? await rankPaths(input.intent, input.paths) : await rankChunks(input.intent, input.paths, { topK: input.top });
  }
  // `check` lives in the portable low-level half, so its caller supplies the
  // resolved model rather than the module reading configuration itself.
  if (input.action === "check") return await check(input.sentences, input.reference_paths, { model: jevConfig().model });
  if (input.action === "log") {
    if (input.op === "outcome") return { op: "outcome", recorded: appendOutcome(input.request_id, input.outcome), advisory: JEV_LOG_ADVISORY };
    return { op: "summary", ...summarize(input.request_ids), advisory: JEV_LOG_ADVISORY };
  }
  if (input.moment === "escalate") return await judgeEscalation({ question: input.question, ...(input.context ? { context: input.context } : {}) });
  if (input.moment === "intake") return await judgeIntake({ track_id: input.track_id, run_id: input.run_id, assignment_id: input.assignment_id, restatement: input.restatement });
  if (input.moment === "plan") return await judgePlan({ track_id: input.track_id, run_id: input.run_id });
  const coordinates = input.track_id && input.run_id && input.assignment_id
    ? { track_id: input.track_id, run_id: input.run_id, assignment_id: input.assignment_id }
    : undefined;
  if (input.moment === "settlement") {
    if (!coordinates) throw new Error("judge moment settlement needs track_id, run_id and assignment_id: the lane report and the change set are read from the registry.");
    return await judgeSettlement({ ...coordinates, ...(input.base ? { base: input.base } : {}) });
  }
  if (!coordinates && !input.file) throw new Error("judge moment authoring needs either track_id, run_id and assignment_id, or file naming a draft assignment.");
  return await judgeAuthoring(coordinates ?? { file: input.file as string });
}

// Server identity and every failing result name the same mounted build.
async function main(): Promise<void> {
  const adapter = await HerdrAdapter.create(process.env.HERDR_CONFIGURED_BIN_PATH);
  const tools = new CompositeTools(adapter);
  const server = new McpServer({ name: "herdr-delegator", version: mountedBuild().version });
  const response = (value: McpResult): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { ...value },
    isError: !value.ok,
  });
  // Every tool is registered through the same gate: no handler sees an
  // unvalidated input, and every rejection the gate itself issues is an
  // McpResult. (A published-shape violation never gets here — the SDK refuses
  // it before the handler, as authored plain text; see invalidToolInput.)
  const guarded = <T>(tool: ToolName, schema: ZodType<T>, handler: (input: T) => Promise<McpResult>) => async (input: unknown): Promise<CallToolResult> => {
    const parsed = schema.safeParse(input);
    return response(parsed.success ? await handler(parsed.data) : invalidToolInput(tool, input, parsed.error));
  };

  server.registerTool("herdr_track", { description: "Open a track — the single atomic op that creates its Herdr space and run, fixes the bounded mandate, spawns the ORCH pane pre-aligned to the configured orchestrator role, and records the ORCH birth that is the run's only command identity. The opening session is retired for that track at birth: direct the user to the named ORCH pane. Also inspects a track (including its budget), extends its budget on either axis — requested_tokens, requested_minutes, or both — against a bounded justification judged by a server-spawned clean auditor, revives a run by resuming its birth session or — with the user's written approval — reborn at generation+1, safely closes it, and keeps the legacy init plus start_orchestrator pair for runs created before open. A verdict is the decision, not its application: budget_extend and inspect both report per-axis granted, effective_cap, applied, usable, the park reason, one release_condition, and the exact clamp field and value a human must write.", inputSchema: herdrTrackInputShape }, guarded("herdr_track", herdrTrackSchema, (parsed) => tools.track(parsed)));
  server.registerTool("herdr_assignment", { description: "Preflight or add a canonical assignment on a persistent responsibility lane, or wait on its active assignment. The `action` field publishes the whole authoring contract: the artifact's frontmatter and section grammar with its bounds, the optional trailing `# References` section that pins documents by hash, the 0444 seal `add` applies, and the exact completion block that settles. Read it before writing an assignment file rather than after a preflight refuses one. There is no response action: answer a worker by appending an [ORCH Response] block to its lane report and ringing herdr_message wake_worker.", inputSchema: herdrAssignmentInputShape }, guarded("herdr_assignment", herdrAssignmentSchema, (parsed) => tools.assignment(parsed)));
  server.registerTool("herdr_worker", { description: "List, inspect, resume, or safely close registry-owned responsibility workers.", inputSchema: herdrWorkerInputShape }, guarded("herdr_worker", herdrWorkerSchema, (parsed) => tools.worker(parsed)));
  server.registerTool("herdr_message", { description: "Ring a bounded non-authoritative doorbell. Every action points at a document and carries no content: wake ORCH after a completion block or decision request, wake a peer lane after a channel append, wake your own worker after appending an [ORCH Response] to its report, or ring another run's ORCH after appending an entry to this run's inter-run channel document (a2a/orch-to-<to_track_id>_<to_run_id>.md, which notify_run requires to exist). Delivery is a soft observation; documents stay the only authority.", inputSchema: herdrMessageInputShape }, guarded("herdr_message", herdrMessageSchema, (parsed) => tools.message(parsed)));
  server.registerTool("herdr_friction", { description: "Record a standardized dogfooding friction observation to the global append-only local log (never an external tracker), or list/group prior reports. Report when the contract itself — not your input — proved the obstacle: after resolving or abandoning a difficulty, not on every error; also transcribe user-observed issues with reporter:'human'. Duplicate symptoms group by fingerprint; a report result returns prior_reports for the same fingerprint.", inputSchema: herdrFrictionInputShape }, guarded("herdr_friction", herdrFrictionSchema, (parsed) => tools.friction(parsed)));
  // The sixth tool is the Jev module, not a delegation surface: same safeParse gate, its own compact JSON body.
  server.registerTool("herdr_jev", { description: "Model-judged selection over text, by probability instead of by reading everything: rank orders candidate files or chunks against an intent, judge answers a fixed question set for a moment (authoring or settlement of an assignment, intake of a worker's restatement, plan of this run's mandate and plan, escalate of a question that would interrupt a human), check tests sentences against reference documents, and log records or counts calibration outcomes by request_id. Advisory — nothing here settles a boundary, mutates a registry, or truncates a result by a threshold; the ORCH judges. The action field publishes the question sets, the state each one reads, and the change-set rule settlement uses.", inputSchema: z.object(herdrJevInputShape).strict() }, async (input: unknown): Promise<CallToolResult> => {
    const parsed = herdrJevSchema.safeParse(input);
    if (!parsed.success) {
      const issues = [...new Set(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} (${issue.code})`))].slice(0, 8);
      // A rejected call may only echo a bounded token back, so the action is narrowed rather than asserted.
      const requested = typeof input === "object" && input !== null && "action" in input && typeof input.action === "string" && ACTION_RE.test(input.action) ? input.action : "unknown";
      const refusal = { ok: false, tool: "herdr_jev", action: requested, error: { code: "invalid_tool_input", phase: "validate", message: `herdr_jev rejected its input at ${issues.join("; ")}.`, recovery: "Each action is a closed set: rank takes intent and paths; judge takes moment — authoring or settlement with either the run coordinates or file, intake with the run coordinates plus assignment_id and restatement, plan with track_id and run_id only, escalate with question and optional context; check takes sentences and reference_paths; log takes op outcome with request_id and outcome, or op summary with request_ids." } };
      return { content: [{ type: "text", text: JSON.stringify(refusal) }], structuredContent: { ...refusal }, isError: true };
    }
    try {
      const data = await jevAction(parsed.data);
      const result = { ok: true, tool: "herdr_jev", action: parsed.data.action, data };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { ...result }, isError: false };
    } catch (error: unknown) {
      const failure = { ok: false, tool: "herdr_jev", action: parsed.data.action, error: { code: "jev_action_failed", phase: "execute", message: error instanceof Error ? error.message : String(error), recovery: "Fix the named cause and call again; the action changed nothing." } };
      return { content: [{ type: "text", text: JSON.stringify(failure) }], structuredContent: { ...failure }, isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(`[herdr-delegator] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
