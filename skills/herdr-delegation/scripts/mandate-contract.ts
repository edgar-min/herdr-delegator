import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export type CheckLine = { ok: boolean; rule: string; detail: string };

export type UniversalContract = {
  line: CheckLine;
  universalReservations: string;
};

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function reservedSection(markdown: string, contractPath: string): string {
  const heading = /^## Reserved to the user[ \t]*$/m.exec(markdown);
  if (!heading || heading.index === undefined) {
    throw new Error(`${contractPath} has no H2 section named Reserved to the user`);
  }
  const afterHeading = heading.index + heading[0].length;
  const nextHeading = /^## /m.exec(markdown.slice(afterHeading));
  const end = nextHeading?.index === undefined ? markdown.length : afterHeading + nextHeading.index;
  return markdown.slice(heading.index, end).trimEnd();
}

/** Verify the package's common contract pin and return the exact reserved section sent to Jev. */
export function readUniversalContract(packageRoot: string): UniversalContract {
  const contractPath = path.join(packageRoot, "protocols", "contract.md");
  const manifestPath = path.join(packageRoot, "protocols", "CONTRACT.json");
  let bytes: Buffer;
  try {
    bytes = readFileSync(contractPath);
  } catch (error: unknown) {
    return {
      line: { ok: false, rule: "contract", detail: `${contractPath} is not readable: ${error instanceof Error ? error.message : String(error)}` },
      universalReservations: "",
    };
  }

  let expected: unknown;
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    expected = typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)["contract.md"]
      : undefined;
  } catch (error: unknown) {
    return {
      line: { ok: false, rule: "contract", detail: `${manifestPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}` },
      universalReservations: "",
    };
  }
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
    return {
      line: { ok: false, rule: "contract", detail: `${manifestPath} must contain {"contract.md":"<sha256>"}` },
      universalReservations: "",
    };
  }

  const actual = sha256(bytes);
  if (actual !== expected) {
    return {
      line: { ok: false, rule: "contract", detail: `${contractPath} hashes ${actual}, but ${manifestPath} pins ${expected}` },
      universalReservations: "",
    };
  }

  try {
    return {
      line: { ok: true, rule: "contract", detail: `sha256 ${actual}` },
      universalReservations: reservedSection(bytes.toString("utf8"), contractPath),
    };
  } catch (error: unknown) {
    return {
      line: { ok: false, rule: "contract", detail: error instanceof Error ? error.message : String(error) },
      universalReservations: "",
    };
  }
}

/** Build the shared judged state; every noise question sees universal reservations beside the mandate. */
export function buildJudgedState(
  document: Record<string, unknown>,
  definitions: Record<string, string>,
  universalReservations: string,
): unknown {
  const { entry: creatorEntry, ...withoutEntry } = document;
  const utterance = typeof creatorEntry === "object" && creatorEntry !== null && !Array.isArray(creatorEntry)
    && typeof (creatorEntry as Record<string, unknown>).utterance === "string"
    ? (creatorEntry as Record<string, unknown>).utterance
    : "";
  return {
    definitions,
    universal_reservations: universalReservations,
    mandate: { ...withoutEntry, invocation: utterance },
  };
}

/** Print the digest of an installed role skill without importing it. */
export function readInstalledSkillSha(packageRoot: string, relativePath: string): CheckLine {
  const skillPath = path.join(packageRoot, relativePath);
  try {
    return { ok: true, rule: "orch-skill", detail: `sha256 ${sha256(readFileSync(skillPath))}` };
  } catch (error: unknown) {
    return { ok: false, rule: "orch-skill", detail: `${skillPath} is not readable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
