import { lstat, open, readFile, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isObject } from "../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";
import { McpContractError, sha256, type DelegationRegistry } from "./contracts";

// ---------------------------------------------------------------------------
// Revival (identity/comms redesign, decision 9). Default is resume: the recorded
// birth session comes back with its context, and no generation is created, so
// nothing about command identity changes. Escalation is a clean rebirth at
// generation+1, and because that destroys context it is gated on three things
// the machine can check by itself:
//   1. an explicit human approval file naming the exact next generation;
//   2. run documents sufficient to reconstruct command — a live test of
//      documents-as-authority, not a formality;
//   3. an ORCH that is not live, since no tool here kills a running session.
// ---------------------------------------------------------------------------

export function rebirthApprovalPath(runPath: string): string { return path.join(runPath, "rebirth-approval.json"); }

/**
 * Reads a human-owned approval file as the exact bytes that were validated.
 *
 * Validation and read go through one open descriptor rather than the path twice:
 * a path validated by `lstat` and then re-opened by name is a different file if
 * anything swapped it in between, and this file is the whole authority for an
 * operation the machine would otherwise refuse. The descriptor is also what
 * proves the target is a regular file rather than a symlink or a device.
 */
async function readApprovalBytes(approvalPath: string, refusal: (detail: string) => McpContractError): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    if ((await lstat(approvalPath)).isSymbolicLink()) throw refusal("the approval path is a symlink");
    handle = await open(approvalPath, "r");
    const opened = await handle.stat();
    if (!opened.isFile()) throw refusal("the approval path is not a regular file");
    if (opened.size > 8_192) throw refusal(`the approval file is ${opened.size} bytes`);
    return await handle.readFile();
  } catch (error: unknown) {
    if (error instanceof McpContractError) throw error;
    throw refusal(isObject(error) && error.code === "ENOENT" ? `no file at ${approvalPath}` : "the approval file cannot be read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// A human-edited file, so it is parsed once at the boundary with a strict schema
// and every rejection names its own reason.
const approvalSchema = z.object({
  version: z.literal(1),
  approve_generation: z.number().int().positive(),
  acknowledge_context_loss: z.literal(true),
  reason: z.string().min(1).max(500).optional(),
}).strict();

/**
 * Reads the human's rebirth approval. It must name the exact generation about to
 * be born, which makes a leftover file replay-proof: it authorizes one rebirth
 * and no later one.
 */
export async function readRebirthApproval(runPath: string, nextGeneration: number): Promise<{ sha256: string; reason?: string }> {
  const approvalPath = rebirthApprovalPath(runPath);
  const refusal = (detail: string): McpContractError => new McpContractError(
    "rebirth_not_approved",
    `Clean rebirth needs the human-owned approval file: ${detail}.`,
    "resume",
    `Ask the user to write ${approvalPath} as {"version":1,"approve_generation":${nextGeneration},"acknowledge_context_loss":true,"reason":"..."} — destroying an ORCH's context is the user's call, not yours. Resume keeps the context and needs no approval.`,
  );
  const bytes = await readApprovalBytes(approvalPath, refusal);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw refusal("the approval file is not valid JSON"); }
  const result = approvalSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw refusal(`${issue.path.join(".") || "approval"}: ${issue.message}`);
  }
  if (result.data.approve_generation !== nextGeneration) {
    throw refusal(`the file approves generation ${result.data.approve_generation} but the next generation is ${nextGeneration}`);
  }
  return { sha256: sha256(bytes), ...(result.data.reason ? { reason: result.data.reason } : {}) };
}

/**
 * The documents-as-authority test. A clean rebirth throws away the ORCH's
 * context, so the run documents are all the new generation will have: the
 * mandate that fixes what the track must achieve, and the plan the previous
 * generation wrote. If they cannot reconstruct command, the rebirth is refused
 * rather than performed and discovered empty.
 */
export async function assertRevivalDocuments(runPath: string): Promise<{ path: string; bytes: number; sha256: string }[]> {
  const required = ["orchestrator-instructions.md", "plan.md"];
  const proofs: { path: string; bytes: number; sha256: string }[] = [];
  const missing: string[] = [];
  for (const name of required) {
    const documentPath = path.join(runPath, name);
    try {
      const file = await lstat(documentPath);
      if (!file.isFile() || file.isSymbolicLink() || (await realpath(documentPath)) !== documentPath) {
        missing.push(`${name} is not a canonical regular file`);
        continue;
      }
      const bytes = await readFile(documentPath);
      if (!bytes.toString("utf8").trim()) {
        missing.push(`${name} is empty`);
        continue;
      }
      proofs.push({ path: documentPath, bytes: bytes.byteLength, sha256: sha256(bytes) });
    } catch {
      missing.push(`${name} is missing`);
    }
  }
  if (missing.length) {
    throw new McpContractError(
      "rebirth_documents_insufficient",
      `The run documents cannot reconstruct command: ${missing.join("; ")}.`,
      "resume",
      "Write the missing document before destroying the ORCH's context. A rebirth inherits nothing else, so this check is the live test of documents-as-authority — resume instead if the context is still worth keeping.",
    );
  }
  return proofs;
}

/**
 * Ambiguity must be inspected before recovery, so a rebirth is refused while any
 * assignment sits in the single ambiguous state: the new generation would have
 * neither the context nor the observation needed to resolve it.
 */
export function assertNoAmbiguousWork(registry: DelegationRegistry): void {
  const ambiguous = Object.values(registry.assignments).filter((assignment) => assignment.state === "ambiguous");
  if (!ambiguous.length) return;
  throw new McpContractError(
    "revival_blocked_ambiguous",
    `${ambiguous.length} assignment(s) are ambiguous: ${ambiguous.map((assignment) => `${assignment.assignment_id} (${assignment.ambiguous_operation ?? "unknown operation"})`).join(", ")}.`,
    "resume",
    "Inspect and resolve the ambiguous effect first: a reborn ORCH inherits no context and could only guess. Resume the existing session instead — it still holds what it did.",
  );
}

// ---------------------------------------------------------------------------
// Approval-file force close (plan U3, friction 5a95bb71e1a73d73). `close` is
// ORCH-only, which leaves a run whose ORCH is gone unclosable forever: its pane
// no longer exists, resume refuses on identity, and a rebirth needs documents a
// disposable fixture never wrote. The exit is the same shape as rebirth — a
// human-owned file the machine can verify — because the authority that a dead
// ORCH can no longer exercise belongs to the human, not to whichever session
// happens to be attested.
// ---------------------------------------------------------------------------

export function closeApprovalPath(runPath: string): string { return path.join(runPath, "close-approval.json"); }

const closeApprovalSchema = z.object({
  version: z.literal(1),
  track_id: z.string().min(1).max(80),
  run_id: z.string().min(1).max(80),
  approve_close_generation: z.number().int().positive(),
  reason: z.string().min(1).max(500),
}).strict();

/**
 * Reads the human's force-close approval. It names the exact run and the exact
 * generation being closed, so a leftover file authorizes one closure of one run
 * and never a later one or a neighbour's.
 *
 * The machine verifies contents, never authorship: no agent may write this file,
 * and an agent that writes it is forging the human's approval rather than
 * obtaining it. The refusal says so, because the only correct response to a
 * missing approval is to stop and ask the human.
 */
export async function readCloseApproval(
  runPath: string,
  run: { track_id: string; run_id: string },
  generation: number,
): Promise<{ path: string; sha256: string; reason: string }> {
  const approvalPath = closeApprovalPath(runPath);
  const refusal = (detail: string): McpContractError => new McpContractError(
    "close_not_approved",
    `Closing a run whose ORCH is gone needs the human-owned approval file: ${detail}.`,
    "close",
    `Ask the user to write ${approvalPath} as {"version":1,"track_id":"${run.track_id}","run_id":"${run.run_id}","approve_close_generation":${generation},"reason":"..."} — and do not write it yourself: this file is the human's approval, so an agent writing it forges the one authority this path rests on. A run whose ORCH is still live is closed by that ORCH and needs no file.`,
  );
  const bytes = await readApprovalBytes(approvalPath, refusal);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw refusal("the approval file is not valid JSON"); }
  const result = closeApprovalSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw refusal(`${issue.path.join(".") || "approval"}: ${issue.message}`);
  }
  if (result.data.track_id !== run.track_id || result.data.run_id !== run.run_id) {
    throw refusal(`the file approves ${result.data.track_id}/${result.data.run_id} but this run is ${run.track_id}/${run.run_id}`);
  }
  if (result.data.approve_close_generation !== generation) {
    throw refusal(`the file approves closing generation ${result.data.approve_close_generation} but the latest recorded ORCH generation is ${generation}`);
  }
  return { path: approvalPath, sha256: sha256(bytes), reason: result.data.reason };
}
