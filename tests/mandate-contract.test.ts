import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildJudgedState, readUniversalContract } from "../mcp/mandate-gate";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "contract.md");
const fixture = readFileSync(fixturePath);
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "mandate-contract-"));
  roots.push(value);
  mkdirSync(path.join(value, "protocols"));
  return value;
}

function writeContract(packageRoot: string): void {
  writeFileSync(path.join(packageRoot, "protocols", "contract.md"), fixture);
}

function writeManifest(packageRoot: string, digest: string): void {
  writeFileSync(path.join(packageRoot, "protocols", "CONTRACT.json"), `${JSON.stringify({ "contract.md": digest })}\n`);
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("universal contract verification", () => {
  test("refuses each missing path by name", () => {
    const missingContract = root();
    const contractResult = readUniversalContract(missingContract);
    expect(contractResult.line.ok).toBe(false);
    expect(contractResult.line.detail).toContain(path.join(missingContract, "protocols", "contract.md"));

    const missingManifest = root();
    writeContract(missingManifest);
    const manifestResult = readUniversalContract(missingManifest);
    expect(manifestResult.line.ok).toBe(false);
    expect(manifestResult.line.detail).toContain(path.join(missingManifest, "protocols", "CONTRACT.json"));
  });

  test("refuses a mismatched pin and prints the matching contract sha256", () => {
    const packageRoot = root();
    writeContract(packageRoot);
    writeManifest(packageRoot, "0".repeat(64));
    const mismatch = readUniversalContract(packageRoot);
    expect(mismatch.line.ok).toBe(false);
    expect(mismatch.line.detail).toContain(path.join(packageRoot, "protocols", "contract.md"));
    expect(mismatch.line.detail).toContain(path.join(packageRoot, "protocols", "CONTRACT.json"));

    const digest = createHash("sha256").update(fixture).digest("hex");
    writeManifest(packageRoot, digest);
    const match = readUniversalContract(packageRoot);
    expect(match.line).toEqual({ ok: true, rule: "contract", detail: `sha256 ${digest}` });
    expect(match.universalReservations).toBe("## Reserved to the user\n\n- Opening and closing tracks.\n- Final acceptance.");
  });

  test("puts universal reservations in the state seen by noise questions", () => {
    const state = buildJudgedState(
      { purpose: "Track purpose.", entry: { protocol: "sketch", utterance: "Make a form." } },
      { purpose: "Why the track exists." },
      "## Reserved to the user\n\n- Final acceptance.",
    ) as Record<string, unknown>;
    expect(state.universal_reservations).toBe("## Reserved to the user\n\n- Final acceptance.");
    expect(state).not.toHaveProperty("entry");
    expect(state.mandate).toEqual({ purpose: "Track purpose.", invocation: "Make a form." });
  });

  test("carries the bound open coordinates and still drops the creator's own answers", () => {
    const state = buildJudgedState(
      {
        purpose: "Track purpose.",
        open: [{ item: "Where do the rules live?" }],
        entry: { protocol: "preview", utterance: "Probe the bound open item.", reason: "A direction commitment is imminent.", binds: ["open[0]"] },
      },
      {},
      "",
    );
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("preview");
    expect(serialized).not.toContain("A direction commitment is imminent.");
    expect(JSON.parse(serialized).mandate.binds).toEqual(["open[0]"]);
  });
});
