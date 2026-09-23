// herdr-delegator://worker is served exactly like the contract resource: bytes
// from protocols/worker.md, digest from the "worker.md" key of CONTRACT.json,
// and a refusal rather than an unannounced rule change when the two disagree.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";
import { CONTRACT_MANIFEST_PATH, WORKER_RESOURCE_URI, contractResource, readPinnedProtocolFile, workerResource } from "../mcp/resources";

/** A package root carrying both pinned documents, so neither resource reads the live protocols/. */
async function fixtureManifest(pins: Record<string, string>, documents: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-worker-resource-"));
  for (const [name, body] of Object.entries(documents)) await writeFile(path.join(root, name), body);
  await writeFile(path.join(root, "CONTRACT.json"), `${JSON.stringify(pins, null, 2)}\n`);
  return path.join(root, "CONTRACT.json");
}

describe("workerResource", () => {
  test("serves the pinned bytes of worker.md", async () => {
    const body = "# Worker contract\n\nEvery lane reads this.\n";
    const manifestPath = await fixtureManifest(
      { "contract.md": sha256(Buffer.from("# Authority\n")), "worker.md": sha256(Buffer.from(body)) },
      { "contract.md": "# Authority\n", "worker.md": body },
    );
    const resource = workerResource(manifestPath);
    expect(resource.uri).toBe(WORKER_RESOURCE_URI);
    expect(resource.name).toBe("worker");
    expect(resource.title).toBe("herdr worker contract");
    expect(resource.mimeType).toBe("text/markdown");
    expect(await readPinnedProtocolFile(resource)).toBe(body);
    // The contract resource keeps its own pin in the same manifest.
    expect(contractResource(manifestPath).sha256).toBe(sha256(Buffer.from("# Authority\n")));
  });

  test("refuses a drifted document and names both digests and the manifest", async () => {
    const manifestPath = await fixtureManifest(
      { "contract.md": "a".repeat(64), "worker.md": "c".repeat(64) },
      { "contract.md": "# Authority\n", "worker.md": "# Worker contract\n" },
    );
    const resource = workerResource(manifestPath);
    expect(readPinnedProtocolFile(resource)).rejects.toThrow(/has drifted from its pin/);
    expect(readPinnedProtocolFile(resource)).rejects.toThrow(manifestPath);
    expect(readPinnedProtocolFile(resource)).rejects.toThrow("c".repeat(64));
  });

  test("refuses a manifest that pins no worker.md, leaving the contract resource intact", async () => {
    const manifestPath = await fixtureManifest(
      { "contract.md": sha256(Buffer.from("# Authority\n")) },
      { "contract.md": "# Authority\n" },
    );
    expect(() => workerResource(manifestPath)).toThrow(manifestPath);
    expect(() => workerResource(manifestPath)).toThrow('does not pin "worker.md"');
    expect(contractResource(manifestPath).uri).toBe("herdr-delegator://contract");
  });

  test("a pinned worker document in this package matches its pin", async () => {
    const manifest = JSON.parse(await readFile(CONTRACT_MANIFEST_PATH, "utf8")) as Record<string, unknown>;
    if (typeof manifest["worker.md"] !== "string") {
      // protocols/worker.md and its pin are another lane's to land; until they
      // do, the fixture cases above are the whole contract.
      expect(() => workerResource()).toThrow('does not pin "worker.md"');
      return;
    }
    const resource = workerResource();
    expect(sha256(await readFile(resource.filePath))).toBe(resource.sha256);
  });
});
