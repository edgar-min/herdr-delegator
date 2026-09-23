// herdr-delegator://contract is served exactly like a pinned protocol document: bytes
// from protocols/contract.md, digest from protocols/CONTRACT.json, and a
// refusal rather than an unannounced rule change when the two disagree.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";
import { CONTRACT_MANIFEST_PATH, CONTRACT_RESOURCE_URI, contractResource, readPinnedProtocolFile } from "../mcp/resources";

async function fixtureContract(body: string, pinned: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-contract-"));
  await writeFile(path.join(root, "contract.md"), body);
  await writeFile(path.join(root, "CONTRACT.json"), `${JSON.stringify({ "contract.md": pinned }, null, 2)}\n`);
  return path.join(root, "CONTRACT.json");
}

describe("contractResource", () => {
  test("serves the pinned bytes of contract.md", async () => {
    const body = "# Authority\n\nThe user decides.\n";
    const manifestPath = await fixtureContract(body, sha256(Buffer.from(body)));
    const resource = contractResource(manifestPath);
    expect(resource.uri).toBe(CONTRACT_RESOURCE_URI);
    expect(resource.mimeType).toBe("text/markdown");
    expect(await readPinnedProtocolFile(resource)).toBe(body);
  });

  test("refuses a pin mismatch and names both digests and the manifest", async () => {
    const manifestPath = await fixtureContract("# Authority\n", "c".repeat(64));
    const resource = contractResource(manifestPath);
    expect(readPinnedProtocolFile(resource)).rejects.toThrow(/has drifted from its pin/);
    expect(readPinnedProtocolFile(resource)).rejects.toThrow(manifestPath);
  });

  test("refuses a manifest that pins no contract.md", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "herdr-contract-"));
    const manifestPath = path.join(root, "CONTRACT.json");
    await writeFile(manifestPath, "{}\n");
    expect(() => contractResource(manifestPath)).toThrow(manifestPath);
  });

  test("the installed contract matches its shipped pin", async () => {
    const resource = contractResource();
    expect(resource.manifestPath).toBe(CONTRACT_MANIFEST_PATH);
    expect(sha256(await readFile(resource.filePath))).toBe(resource.sha256);
  });
});
