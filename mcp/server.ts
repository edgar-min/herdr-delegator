#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodError, ZodType } from "zod";
import { HerdrAdapter } from "./herdr-adapter";
import { mountedBuild } from "./registry";
import { ASSIGNMENT_ID_GUIDANCE, COORDINATE_RE, herdrAssignmentInputShape, herdrAssignmentSchema, herdrFrictionInputShape, herdrFrictionSchema, herdrMessageInputShape, herdrMessageSchema, herdrTrackInputShape, herdrTrackSchema, herdrWorkerInputShape, herdrWorkerSchema, type McpResult, type ToolName } from "./contracts";
import { CompositeTools } from "./tools";

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
 * (friction 87ef22382241e18f). Every tool now refuses through the same
 * `McpResult` its handlers return.
 *
 * The published input shape is the first gate and now states every field's
 * grammar itself; this is the second, for what a per-field shape cannot
 * express — the fields one action requires, keys no action accepts, and the
 * discriminator. Recovery is authored contract text: a zod message is never
 * reused as guidance, only its stable issue codes are reported.
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
  // Every tool is registered through the same gate, so no handler can reach a
  // caller with an unvalidated input or a rejection that is not an McpResult.
  const guarded = <T>(tool: ToolName, schema: ZodType<T>, handler: (input: T) => Promise<McpResult>) => async (input: unknown): Promise<CallToolResult> => {
    const parsed = schema.safeParse(input);
    return response(parsed.success ? await handler(parsed.data) : invalidToolInput(tool, input, parsed.error));
  };

  server.registerTool("herdr_track", { description: "Open a track — the single atomic op that creates its Herdr space and run, fixes the bounded mandate, spawns the ORCH pane pre-aligned to the configured orchestrator role, and records the ORCH birth that is the run's only command identity. The opening session is retired for that track at birth: direct the user to the named ORCH pane. Also inspects a track (including its budget), extends its budget against a bounded justification judged by a server-spawned clean auditor, revives a run by resuming its birth session or — with the user's written approval — reborn at generation+1, safely closes it, and keeps the legacy init plus start_orchestrator pair for runs created before open.", inputSchema: herdrTrackInputShape }, guarded("herdr_track", herdrTrackSchema, (parsed) => tools.track(parsed)));
  server.registerTool("herdr_assignment", { description: "Preflight or add a canonical assignment on a persistent responsibility lane, or wait on its active assignment. There is no response action: answer a worker by appending an [ORCH Response] block to its lane report and ringing herdr_message wake_worker.", inputSchema: herdrAssignmentInputShape }, guarded("herdr_assignment", herdrAssignmentSchema, (parsed) => tools.assignment(parsed)));
  server.registerTool("herdr_worker", { description: "List, inspect, resume, or safely close registry-owned responsibility workers.", inputSchema: herdrWorkerInputShape }, guarded("herdr_worker", herdrWorkerSchema, (parsed) => tools.worker(parsed)));
  server.registerTool("herdr_message", { description: "Ring a bounded non-authoritative doorbell. Every action points at a document and carries no content: wake ORCH after a completion block or decision request, wake a peer lane after a channel append, wake your own worker after appending an [ORCH Response] to its report, or ring another run's ORCH after appending an entry to this run's inter-run channel document (a2a/orch-to-<to_track_id>_<to_run_id>.md, which notify_run requires to exist). Delivery is a soft observation; documents stay the only authority.", inputSchema: herdrMessageInputShape }, guarded("herdr_message", herdrMessageSchema, (parsed) => tools.message(parsed)));
  server.registerTool("herdr_friction", { description: "Record a standardized dogfooding friction observation to the global append-only local log (never an external tracker), or list/group prior reports. Report when the contract itself — not your input — proved the obstacle: after resolving or abandoning a difficulty, not on every error; also transcribe user-observed issues with reporter:'human'. Duplicate symptoms group by fingerprint; a report result returns prior_reports for the same fingerprint.", inputSchema: herdrFrictionInputShape }, guarded("herdr_friction", herdrFrictionSchema, (parsed) => tools.friction(parsed)));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(`[herdr-delegator] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
