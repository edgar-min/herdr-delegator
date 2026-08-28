#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HerdrAdapter } from "./herdr-adapter";
import { herdrAssignmentInputShape, herdrAssignmentSchema, herdrMessageInputShape, herdrMessageSchema, herdrTrackInputShape, herdrTrackSchema, herdrWorkerInputShape, herdrWorkerSchema, type McpResult } from "./contracts";
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

  server.registerTool("herdr_track", { description: "Initialize, inspect, start the orchestrator for, or safely close a deterministic Herdr track.", inputSchema: herdrTrackInputShape }, async (input) => response(await tools.track(herdrTrackSchema.parse(input))));
  server.registerTool("herdr_assignment", { description: "Preflight, add, wait for, or respond to a canonical assignment on a persistent responsibility lane.", inputSchema: herdrAssignmentInputShape }, async (input) => response(await tools.assignment(herdrAssignmentSchema.parse(input))));
  server.registerTool("herdr_worker", { description: "List, inspect, resume, or safely close registry-owned responsibility workers.", inputSchema: herdrWorkerInputShape }, async (input) => response(await tools.worker(herdrWorkerSchema.parse(input))));
  server.registerTool("herdr_message", { description: "Send a bounded non-authoritative doorbell: wake ORCH after a completion block or decision request, wake a peer lane after a channel append, or send a bounded orch-to-orch note to another run. Delivery is a soft observation; documents stay the only authority.", inputSchema: herdrMessageInputShape }, async (input) => response(await tools.message(herdrMessageSchema.parse(input))));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(`[herdr-delegator] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
