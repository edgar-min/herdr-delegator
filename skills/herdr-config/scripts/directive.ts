/**
 * Edit the orchestrator directive through validation and preview.
 *
 * The value is judged by the real loader, never by a copy of its predicate: the
 * candidate layer is written into a throwaway root, `loadDelegatorConfig` runs
 * there, and only a layer that loads is previewed or written. Without `--apply`
 * nothing on disk changes, so the preview is the whole output.
 *
 *   bun skills/herdr-config/scripts/directive.ts <cwd> --set "<text>" [--layer project|user] [--apply]
 */
import path from "node:path";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadDelegatorConfig, ompAgentDir, writeAtomic } from "../../../io.github.edgar-min.herdr-delegator/extensions/lib/config";
import { renderGuidanceDocument } from "../../../io.github.edgar-min.herdr-delegator/extensions/lib/guidance";

const USAGE = 'usage: bun skills/herdr-config/scripts/directive.ts <cwd> --set "<text>" [--layer project|user] [--apply]';
const LAYER_FILE = "herdr-delegator.json";

/**
 * A layer as authored. Both layer files this script reads were written by this
 * project's own schema, and an unreadable or unparsable one is refused below
 * rather than coerced.
 */
type AuthoredLayer = { orchestrator?: { role?: string; thinking?: string; directive?: string } } & Record<string, unknown>;

function refuse(message: string): never {
  console.error(`refused: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const positional = argv.filter((token) => !token.startsWith("--"));
const cwd = positional[0];
const setIndex = argv.indexOf("--set");
const layerIndex = argv.indexOf("--layer");
const text = setIndex === -1 ? undefined : argv[setIndex + 1];
const layerName = layerIndex === -1 ? "project" : argv[layerIndex + 1];
const apply = argv.includes("--apply");

if (!cwd || text === undefined || text.startsWith("--")) {
  console.error(USAGE);
  process.exit(2);
}
if (layerName !== "project" && layerName !== "user") {
  console.error(USAGE);
  process.exit(2);
}

const projectCwd = path.resolve(cwd);
const userLayerPath = path.join(ompAgentDir(), LAYER_FILE);
const projectLayerPath = path.join(projectCwd, ".omp", LAYER_FILE);
const targetPath = layerName === "user" ? userLayerPath : projectLayerPath;

async function readLayer(layerPath: string): Promise<AuthoredLayer | undefined> {
  let raw: string;
  try {
    raw = await readFile(layerPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as AuthoredLayer;
  } catch (error: unknown) {
    refuse(`${layerPath} is not readable as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const userLayer = await readLayer(userLayerPath);
const projectLayer = await readLayer(projectLayerPath);
const targetLayer = layerName === "user" ? userLayer : projectLayer;
const candidate: AuthoredLayer = {
  version: 1,
  ...targetLayer,
  orchestrator: { ...targetLayer?.orchestrator, directive: text },
};

// Validation root: the same two layers, with the candidate substituted for the
// target, loaded by the real parser under a throwaway agent directory and cwd.
// Canonical, because the loader reports errors at the canonicalized layer path
// and this script rewrites those coordinates back onto the real target.
const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "herdr-config-directive-")));
const sandboxAgentDir = path.join(sandbox, "agent");
const sandboxCwd = path.join(sandbox, "cwd");
const sandboxUserPath = path.join(sandboxAgentDir, LAYER_FILE);
const sandboxProjectPath = path.join(sandboxCwd, ".omp", LAYER_FILE);
await mkdir(sandboxAgentDir, { recursive: true });
await mkdir(path.dirname(sandboxProjectPath), { recursive: true });

const sandboxUser = layerName === "user" ? candidate : userLayer;
const sandboxProject = layerName === "project" ? candidate : projectLayer;
if (sandboxUser) await writeFile(sandboxUserPath, `${JSON.stringify(sandboxUser, null, 2)}\n`);
if (sandboxProject) await writeFile(sandboxProjectPath, `${JSON.stringify(sandboxProject, null, 2)}\n`);

const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandboxAgentDir;
let preview: string;
try {
  const { config } = await loadDelegatorConfig(undefined, sandboxCwd);
  preview = renderGuidanceDocument(config);
} catch (error: unknown) {
  const code = error instanceof Error && "code" in error ? `${String(error.code)}: ` : "";
  const message = error instanceof Error ? error.message : String(error);
  await rm(sandbox, { recursive: true, force: true });
  refuse(`${code}${message.replaceAll(sandboxUserPath, userLayerPath).replaceAll(sandboxProjectPath, projectLayerPath)}`);
} finally {
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
}
await rm(sandbox, { recursive: true, force: true });

console.log(`target layer: ${layerName} (${targetPath})`);
console.log(`directive: ${JSON.stringify(text)}`);
console.log("");
console.log("--- guidance.md preview ---");
console.log(preview);

if (!apply) {
  console.log("--- not applied (no --apply); nothing was written ---");
  process.exit(0);
}

await mkdir(path.dirname(targetPath), { recursive: true });
await writeAtomic(targetPath, `${JSON.stringify(candidate, null, 2)}\n`);
const { config: reloaded } = await loadDelegatorConfig(undefined, projectCwd);
console.log(`--- applied to ${targetPath}; re-rendered from disk ---`);
console.log(renderGuidanceDocument(reloaded));
