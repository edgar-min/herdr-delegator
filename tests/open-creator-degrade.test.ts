// A Herdr shell pane with no agent (the CLI opener) answers `agent get <pane>`
// with `agent_not_found`. On a fresh coordinate `open` degrades that caller to
// an unverified creator stamped by pane, exactly as it does for
// `omp_fact_bridge_mismatch`; on an initialized coordinate, and for any other
// Herdr failure, it stays fail-closed with the original error.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeRun } from "../io.github.edgar-min.herdr-delegator/extensions/lib/track";
import { herdrTrackSchema, McpContractError, type Mandate } from "../mcp/contracts";
import type { HerdrAdapter } from "../mcp/herdr-adapter";
import { CompositeTools } from "../mcp/tools";

const TRACK = "degrade-track";
const RUN = "r1";
const SHELL_PANE = "w9:p1";
const ENV_KEYS = ["HERDR_ENV", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR", "TYPESAFE_API_KEY", "JEV_API_KEY"] as const;
let savedEnv: (string | undefined)[];
let root: string;
let cwd: string;
let storageRoot: string;

beforeEach(async () => {
  savedEnv = ENV_KEYS.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(path.join(tmpdir(), "open-creator-degrade-")));
  cwd = path.join(root, "project");
  storageRoot = path.join(root, "store");
  await Promise.all([mkdir(path.join(cwd, ".omp"), { recursive: true }), mkdir(storageRoot), mkdir(path.join(root, "agent"))]);
  await writeFile(path.join(cwd, ".omp", "herdr-delegator.json"), `${JSON.stringify({ version: 1, storage: { root: storageRoot } })}\n`);
  await writeFile(path.join(cwd, "notes.md"), "# Prior opening decisions\n");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.HERDR_PANE_ID = SHELL_PANE;
  // The spawn is not under test: without HERDR_ENV it refuses `not_in_herdr`
  // after the creator stamp, which is exactly how far this test needs `open` to go.
  delete process.env.HERDR_ENV;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_API_KEY;
});

afterEach(async () => {
  ENV_KEYS.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; });
  await rm(root, { recursive: true, force: true });
});

/** Herdr as an agentless shell pane sees it: the pane exists, `agent get` fails as the adapter surfaces it. */
function shellPane(agentGetFailure: McpContractError): HerdrAdapter {
  return {
    getAgent: async () => { throw agentGetFailure; },
    getPane: async () => ({ data: { pane: { pane_id: SHELL_PANE, cwd } }, stdout: "" }),
  } as unknown as HerdrAdapter;
}

const agentNotFound = new McpContractError("herdr_command_failed", JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${SHELL_PANE} not found` } }), "wait", "Retry the read-only observation.", false, true);

function open(adapter: HerdrAdapter) {
  const mandate = {
    mandate_version: 2,
    purpose: "Settle where the opening contract's rules live.",
    language: "en",
    entry: { protocol: "sketch", utterance: "Make variants of the opening contract for the bound open item.", reason: "A form must be made that the user would recognize on sight." },
    settled: [{ decision: "The creator never becomes the ORCH.", source: "user, creator conversation 2026-09-23", reason: "unstated" }],
    substrate: ["notes.md records the prior opening decisions."],
    open: [{ item: "Where should the first-turn rules live?", candidates: ["In a run document", "In the role skill"] }],
    done_when: ["plan.md records the user's recognized version as a D-numbered entry."],
    forbidden: ["Do not modify the main branch in this track."],
    budget: { tokens: 500000, minutes: 60, doorbell_policy: "notify" },
  } as Mandate;
  return new CompositeTools(adapter).track(herdrTrackSchema.parse({ action: "open", track_id: TRACK, run_id: RUN, cwd, mandate }));
}

describe("open from an agentless Herdr shell pane", () => {
  test("a fresh coordinate stamps an unverified creator by pane and proceeds past the stamp", async () => {
    const result = await open(shellPane(agentNotFound));
    // Past initializeRun and the stamp, the spawn itself is what refuses here.
    expect(result.error?.code).toBe("not_in_herdr");
    const registry = JSON.parse(await readFile(path.join(storageRoot, TRACK, RUN, "a2a", "delegation.json"), "utf8")) as { orch_creator?: Record<string, unknown> };
    expect(registry.orch_creator).toMatchObject({ pane_id: SHELL_PANE, verified: false });
    expect(registry.orch_creator?.session_id).toBeUndefined();
  });

  test("an already-initialized coordinate refuses with the original error", async () => {
    await initializeRun({ operation: "init_run", track_id: TRACK, run_id: RUN, cwd });
    const result = await open(shellPane(agentNotFound));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("herdr_command_failed");
    expect(result.error?.message).toBe(agentNotFound.message);
  });

  test("any other Herdr failure on a fresh coordinate stays fail-closed and writes nothing", async () => {
    const other = new McpContractError("herdr_command_failed", JSON.stringify({ error: { code: "server_unavailable", message: "socket closed" } }), "wait", "Retry the read-only observation.", false, true);
    const result = await open(shellPane(other));
    expect(result.error?.code).toBe("herdr_command_failed");
    expect(result.error?.message).toBe(other.message);
    await expect(readFile(path.join(storageRoot, TRACK, RUN, "a2a", "delegation.json"))).rejects.toThrow();
  });
});
