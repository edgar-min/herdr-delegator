// ---------------------------------------------------------------------------
// Protocol resources.
//
// The ORCH's first action is to execute its mandate's `entry.protocol` from the
// pinned upstream document. Telling it to resolve that document as a path
// inside the plugin package failed the first time it was tried: the rt-test/r1
// ORCH could not reach `protocols/sketch/upstream/SKILL.md` from its cwd and
// halted. The server already owns those bytes and their pins, so it serves them
// as MCP resources and the birth prompt names a URI instead of a path.
//
// A resource is served only when the file still matches its pin in
// `protocols/UPSTREAM.json`: a drifted document is an unannounced protocol
// change, and serving it silently is worse than refusing to serve it.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sha256 } from "./contracts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const UPSTREAM_MANIFEST_PATH = path.join(PACKAGE_ROOT, "protocols", "UPSTREAM.json");
/** The shared contract document and its pin, resolved from the same package root. */
export const CONTRACT_MANIFEST_PATH = path.join(PACKAGE_ROOT, "protocols", "CONTRACT.json");
/** The scheme and shape the birth prompt hard-codes; `mcp://herdr://protocol/<name>` is its OMP read form. */
export const PROTOCOL_RESOURCE_PREFIX = "herdr://protocol";
export const CONTRACT_RESOURCE_URI = "herdr://contract";

/**
 * The one shared contract every session reads: the authority index, the
 * reservations the user keeps in every track, and the assignment and settlement
 * grammar. It is served exactly like a pinned protocol document — bytes from
 * `protocols/contract.md`, digest from `protocols/CONTRACT.json` — because a
 * drifted contract is an unannounced rule change and refusing it is the only
 * safe reading.
 */
export function contractResource(manifestPath: string = CONTRACT_MANIFEST_PATH): ProtocolResource {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const digest = manifest["contract.md"];
  if (typeof digest !== "string") {
    throw new Error(`${manifestPath} does not pin "contract.md", so ${CONTRACT_RESOURCE_URI} cannot be served.`);
  }
  return {
    uri: CONTRACT_RESOURCE_URI,
    name: "contract",
    title: "herdr contract",
    description: `The shared Herdr contract — authority index, reservations kept to the user, and assignment and settlement grammar — served verbatim from protocols/contract.md. Pinned sha256 ${digest}; the server refuses to serve bytes that do not match it.`,
    mimeType: "text/markdown",
    filePath: path.join(path.dirname(manifestPath), "contract.md"),
    sha256: digest,
    manifestPath,
  };
}

export type ProtocolPin = {
  source: string;
  plugin_version: string;
  files: Record<string, string>;
};

export type ProtocolResource = {
  uri: string;
  /** Resource name: the protocol for its SKILL.md, `<protocol>/<file>` for a reference. */
  name: string;
  title: string;
  description: string;
  mimeType: string;
  filePath: string;
  sha256: string;
  /** The manifest that pins this document, named in every refusal. */
  manifestPath: string;
};

/** Every resource this build serves, derived from the manifest — the manifest IS the registry. */
export function protocolResources(manifestPath: string = UPSTREAM_MANIFEST_PATH): ProtocolResource[] {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { commit?: string; protocols?: Record<string, ProtocolPin> };
  const commit = typeof manifest.commit === "string" ? manifest.commit : "unpinned";
  const resources: ProtocolResource[] = [];
  for (const [protocol, pin] of Object.entries(manifest.protocols ?? {})) {
    const upstream = pin.source.split("/")[0];
    for (const [file, digest] of Object.entries(pin.files)) {
      const isEntry = file === "SKILL.md";
      resources.push({
        uri: isEntry ? `${PROTOCOL_RESOURCE_PREFIX}/${protocol}` : `${PROTOCOL_RESOURCE_PREFIX}/${protocol}/${file}`,
        name: isEntry ? protocol : `${protocol}/${file}`,
        title: `${protocol} — ${upstream} ${pin.plugin_version} @ ${commit.slice(0, 8)}`,
        description: `${isEntry ? "The protocol document" : `Reference ${file}`} for ${protocol}, imported verbatim from ${pin.source} (${upstream} ${pin.plugin_version}) at commit ${commit}. Pinned sha256 ${digest}; the server refuses to serve bytes that do not match it.`,
        mimeType: "text/markdown",
        filePath: path.join(PACKAGE_ROOT, "protocols", protocol, "upstream", file),
        sha256: digest,
        manifestPath,
      });
    }
  }
  return resources;
}

/** Reads one pinned document, refusing drift rather than serving an unannounced protocol change. */
export async function readPinnedProtocolFile(resource: ProtocolResource): Promise<string> {
  let bytes: Buffer;
  try { bytes = await readFile(resource.filePath); }
  catch {
    throw new Error(`${resource.uri} is pinned in ${resource.manifestPath} but ${resource.filePath} cannot be read; reinstall or re-sync the package.`);
  }
  const digest = sha256(bytes);
  if (digest !== resource.sha256) {
    throw new Error(`${resource.uri} has drifted from its pin: ${resource.filePath} hashes ${digest}, ${resource.manifestPath} pins ${resource.sha256}. Re-pin the document deliberately; the server never serves an unpinned document.`);
  }
  return bytes.toString("utf8");
}

/**
 * Registers every pinned document as a read-only MCP resource. An unreadable
 * manifest leaves the server tool-complete and that manifest's resources absent
 * rather than failing to start, and the warning names the manifest.
 */
export function registerProtocolResources(server: McpServer): ProtocolResource[] {
  const resources: ProtocolResource[] = [];
  try { resources.push(...protocolResources()); }
  catch (error: unknown) {
    console.error(`[herdr-delegator] no protocol resources: ${UPSTREAM_MANIFEST_PATH} is unreadable (${error instanceof Error ? error.message : String(error)})`);
  }
  try { resources.push(contractResource()); }
  catch (error: unknown) {
    console.error(`[herdr-delegator] no ${CONTRACT_RESOURCE_URI} resource: ${CONTRACT_MANIFEST_PATH} is unusable (${error instanceof Error ? error.message : String(error)})`);
  }
  for (const resource of resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: resource.mimeType },
      async (uri: URL) => ({
        contents: [{ uri: uri.href, mimeType: resource.mimeType, text: await readPinnedProtocolFile(resource) }],
      }),
    );
  }
  return resources;
}
