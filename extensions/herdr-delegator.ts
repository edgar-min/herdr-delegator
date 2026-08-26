// Custom Herdr orchestration companion for OMP.
// Keeps run files as the audit source of truth; Herdr only transports prompts and state.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolParams, TrackOperation, TrackParams, TrackResult, WorkerResult } from "./lib/contracts";
import { ALLOWED_KEYS, COORDINATE_RE, ContractError, MAX_TEXT_RESPONSE, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, PROFILE_RE } from "./lib/contracts";
import { isThinkingLevel } from "./lib/config";
import { isOperation, reportBootstrapAttestation } from "./lib/runtime";
import { initializeRun, inspectOrchestrator, startOrchestrator, trackFailureResult, trackResultSummary } from "./lib/track";
import { closeWorker, ensureWorker, failureResult, inspectWorker, promptWait, resolveBlock, resultSummary } from "./lib/worker";

export default function (pi: ExtensionAPI) {
  const z = pi.zod;
  const attestSession = async (_event: unknown, ctx: ExtensionContext) => {
    await reportBootstrapAttestation(pi, ctx);
  };
  pi.on("session_start", attestSession);
  pi.on("session_switch", attestSession);

  pi.registerTool({
    name: "herdr_worker",
    label: "Herdr Worker Delegator",
    description:
      "Manage one registry-owned OMP worker by deterministic track_id and run_id. ensure_worker requires cwd and an explicit configured profile, verifies the resolved run manifest and model, and returns the canonical run path in bounded details. Sequence calls as ensure_worker, prompt_wait, then inspect_worker. Never retry an ambiguous prompt, response, or close effect without inspecting first.",
    parameters: z.union([
      z.object({
        operation: z.literal("ensure_worker"),
        track_id: z.string().regex(COORDINATE_RE),
        run_id: z.string().regex(COORDINATE_RE),
        worker_id: z.string(),
        timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
        cwd: z.string(),
        profile: z.string().regex(PROFILE_RE),
      }),
      z.object({
        operation: z.literal("prompt_wait"),
        track_id: z.string().regex(COORDINATE_RE),
        run_id: z.string().regex(COORDINATE_RE),
        worker_id: z.string(),
        timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
        instruction_path: z.string(),
      }),
      z.object({
        operation: z.literal("inspect_worker"),
        track_id: z.string().regex(COORDINATE_RE),
        run_id: z.string().regex(COORDINATE_RE),
        worker_id: z.string(),
        timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
        output_lines: z.number().int().min(1).max(200).optional(),
      }),
      z.object({
        operation: z.literal("resolve_block"),
        track_id: z.string().regex(COORDINATE_RE),
        run_id: z.string().regex(COORDINATE_RE),
        worker_id: z.string(),
        timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
        expected_state_change_seq: z.number().int().nonnegative(),
        response: z.union([
          z.object({ kind: z.literal("text"), text: z.string().min(1).max(MAX_TEXT_RESPONSE) }),
          z.object({ kind: z.literal("keys"), keys: z.array(z.enum(ALLOWED_KEYS)).min(1).max(20) }),
        ]),
      }),
      z.object({
        operation: z.literal("close_worker"),
        track_id: z.string().regex(COORDINATE_RE),
        run_id: z.string().regex(COORDINATE_RE),
        worker_id: z.string(),
        timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
      }),
    ]),
    strict: true,
    async execute(
      _toolCallId: string,
      params: ToolParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const operation = isOperation(params.operation) ? params.operation : "inspect_worker";
      let result: WorkerResult;
      try {
        if (params?.operation === "ensure_worker") {
          const currentThinking = pi.getThinkingLevel();
          if (!isThinkingLevel(currentThinking)) {
            throw new ContractError(
              "thinking_level_unavailable",
              "The current ORCH thinking level is unavailable or unsupported.",
              "model_verify",
            );
          }
          result = await ensureWorker(params, ctx, currentThinking, signal);
        } else if (params?.operation === "prompt_wait") result = await promptWait(params, signal);
        else if (params?.operation === "inspect_worker") result = await inspectWorker(params, signal);
        else if (params?.operation === "resolve_block") result = await resolveBlock(params, signal);
        else if (params?.operation === "close_worker") result = await closeWorker(params, signal);
        else throw new ContractError("invalid_operation", "Unsupported operation.", "validate");
      } catch (error) {
        result = await failureResult(operation, params, error);
      }
      return {
        content: [{ type: "text", text: resultSummary(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "herdr_track",
    label: "Herdr Track Orchestrator",
    description:
      "Initialize deterministic configured run storage, or start and inspect one model-verified OMP ORCH by track_id and run_id. init_run writes only the manifest, bundled protocol, a2a directory, index row, and settled reset artifacts. start_orch always fingerprints the resolved run's orchestrator-instructions.md.",
    parameters: z.union([
      z.object({
        operation: z.literal("init_run"),
        track_id: z.string().regex(COORDINATE_RE),
        run_id: z.string().regex(COORDINATE_RE),
        cwd: z.string(),
        reset_of: z.object({
          track_id: z.string().regex(COORDINATE_RE),
          run_id: z.string().regex(COORDINATE_RE),
        }).optional(),
        timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
      }),
      z.object({
        operation: z.literal("start_orch"),
        track_id: z.string().regex(COORDINATE_RE),
        run_id: z.string().regex(COORDINATE_RE),
        timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
      }),
      z.object({
        operation: z.literal("inspect_orch"),
        track_id: z.string().regex(COORDINATE_RE),
        run_id: z.string().regex(COORDINATE_RE),
        timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
      }),
    ]),
    strict: true,
    async execute(
      _toolCallId: string,
      params: TrackParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const operation: TrackOperation =
        params.operation === "init_run"
          ? "init_run"
          : params.operation === "start_orch"
            ? "start_orch"
            : "inspect_orch";
      let result: TrackResult;
      try {
        if (params.operation === "init_run") {
          result = await initializeRun(params);
        } else if (params.operation === "start_orch") {
          const currentThinking = pi.getThinkingLevel();
          if (!isThinkingLevel(currentThinking)) {
            throw new ContractError(
              "thinking_level_unavailable",
              "The current caller ORCH thinking level is unavailable or unsupported.",
              "model_verify",
            );
          }
          result = await startOrchestrator(params, ctx, currentThinking, signal);
        } else if (params.operation === "inspect_orch") {
          result = await inspectOrchestrator(params, ctx, signal);
        } else {
          throw new ContractError("invalid_operation", "Unsupported operation.", "validate");
        }
      } catch (error) {
        result = await trackFailureResult(operation, params, error);
      }
      return {
        content: [{ type: "text", text: trackResultSummary(result) }],
        details: result,
      };
    },
  });
}
