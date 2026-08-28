#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HerdrAdapter } from "./herdr-adapter";
import { herdrAssignmentInputShape, herdrAssignmentSchema, herdrFrictionInputShape, herdrFrictionSchema, herdrMessageInputShape, herdrMessageSchema, herdrTrackInputShape, herdrTrackSchema, herdrWorkerInputShape, herdrWorkerSchema, type McpResult } from "./contracts";
import { CompositeTools } from "./tools";

async function packageVersion(): Promise<string> {
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !parsed.version) throw new Error("package.json has no valid version");
  return parsed.version;
}

async function main(): Promise<void> {
  const adapter = await HerdrAdapter.create(process.env.HERDR_CONFIGURED_BIN_PATH);
  const tools = new CompositeTools(adapter);
  const server = new McpServer({ name: "herdr-delegator", version: await packageVersion() });
  const response = (value: McpResult): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { ...value },
    isError: !value.ok,
  });

  server.registerTool("herdr_track", { description: "Open a track — the single atomic op that creates its Herdr space and run, fixes the bounded mandate, spawns the ORCH pane pre-aligned to the configured orchestrator role, and records the ORCH birth that is the run's only command identity. The opening session is retired for that track at birth: direct the user to the named ORCH pane. Also inspects or safely closes a track, and keeps the legacy init plus start_orchestrator pair for runs created before open.", inputSchema: herdrTrackInputShape }, async (input) => response(await tools.track(herdrTrackSchema.parse(input))));
  server.registerTool("herdr_assignment", { description: "Preflight or add a canonical assignment on a persistent responsibility lane, or wait on its active assignment. There is no response action: answer a worker by appending an [ORCH Response] block to its lane report and ringing herdr_message wake_worker.", inputSchema: herdrAssignmentInputShape }, async (input) => response(await tools.assignment(herdrAssignmentSchema.parse(input))));
  server.registerTool("herdr_worker", { description: "List, inspect, resume, or safely close registry-owned responsibility workers.", inputSchema: herdrWorkerInputShape }, async (input) => response(await tools.worker(herdrWorkerSchema.parse(input))));
  server.registerTool("herdr_message", { description: "Ring a bounded non-authoritative doorbell. Every action points at a document and carries no content: wake ORCH after a completion block or decision request, wake a peer lane after a channel append, wake your own worker after appending an [ORCH Response] to its report, or ring another run's ORCH after appending an entry to this run's inter-run channel document (a2a/orch-to-<track>_<run>.md, which notify_run requires to exist). Delivery is a soft observation; documents stay the only authority.", inputSchema: herdrMessageInputShape }, async (input) => response(await tools.message(herdrMessageSchema.parse(input))));
  server.registerTool("herdr_friction", { description: "Record a standardized dogfooding friction observation to the global append-only local log (never an external tracker), or list/group prior reports. Report when the contract itself — not your input — proved the obstacle: after resolving or abandoning a difficulty, not on every error; also transcribe user-observed issues with reporter:'human'. Duplicate symptoms group by fingerprint; a report result returns prior_reports for the same fingerprint.", inputSchema: herdrFrictionInputShape }, async (input) => response(await tools.friction(herdrFrictionSchema.parse(input))));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(`[herdr-delegator] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
