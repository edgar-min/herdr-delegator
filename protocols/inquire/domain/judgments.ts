// The judgments the protocol delegates to a judge (Jev, a human, or a fixture). The domain builds the state
// slice each judgment sees and validates the verdict it gets back; the wording of the questions belongs to the
// adapter and is designed per moment. Every verdict is a decided value; `p` is kept for calibration only.
import type { Claim, Dimension, Evidence, EvidenceSource, InquireState, Priority, Resolution, Scope, Uncertainty, Verifiability } from "./types.js";

export type Candidate = { id: string; domain: string; description: string; claim?: Claim };

// ------------------------------------------------------------------ requests
// A request carries only the slice of state the judgment needs. This is the surface we tune per step.

/** Scan state is the fixed mandate; candidates ride in the questions, one per passage. */
export type ScanRequest = { moment: "scan"; state: unknown; candidates: Candidate[] };
export type ContextResolutionRequest = { moment: "context_resolution"; prospect: string; item: ItemSlice };
export type ClassifyRequest = { moment: "classify"; prospect: string; item: ItemSlice };
export type AdmissibilityRequest = { moment: "admissibility"; item: ItemSlice; evidence: { index: number; evidence: Evidence }[] };
export type PriorityRequest = { moment: "priority"; prospect: string; items: ItemSlice[] };
export type ClusterRequest = { moment: "cluster"; prospect: string; items: ItemSlice[] };
export type JudgmentRequest = ScanRequest | ContextResolutionRequest | ClassifyRequest | AdmissibilityRequest | PriorityRequest | ClusterRequest;

export type ItemSlice = Pick<Uncertainty, "id" | "domain" | "description" | "claim" | "evidence" | "classification" | "tags">;

export const slice = (u: Uncertainty): ItemSlice => ({
  id: u.id, domain: u.domain, description: u.description, claim: u.claim, evidence: u.evidence, classification: u.classification, tags: u.tags,
});

export function scanRequest(fixedState: unknown, candidates: Candidate[]): ScanRequest {
  return { moment: "scan", state: fixedState, candidates };
}
export function contextResolutionRequest(state: InquireState, u: Uncertainty): ContextResolutionRequest {
  return { moment: "context_resolution", prospect: state.prospect.text, item: slice(u) };
}
export function classifyRequest(state: InquireState, u: Uncertainty): ClassifyRequest {
  return { moment: "classify", prospect: state.prospect.text, item: slice(u) };
}
export function admissibilityRequest(u: Uncertainty): AdmissibilityRequest {
  return { moment: "admissibility", item: slice(u), evidence: u.evidence.map((evidence, index) => ({ index, evidence })) };
}
export function priorityRequest(state: InquireState, items: Uncertainty[]): PriorityRequest {
  return { moment: "priority", prospect: state.prospect.text, items: items.map(slice) };
}
export function clusterRequest(state: InquireState, items: Uncertainty[]): ClusterRequest {
  return { moment: "cluster", prospect: state.prospect.text, items: items.map(slice) };
}

// ------------------------------------------------------------------ verdicts

export type ScanVerdict = {
  /** Candidates the judge keeps as real uncertainties (dimension is classify's act, not scan's). */
  kept: { id: string; p?: number; score?: number }[];
  /** Required when nothing is kept: the sufficiency finding presented as relay text. */
  sufficiency_reasoning?: string;
};

export type ContextResolutionVerdict = { resolved: boolean; p?: number };

export type ClassifyVerdict =
  | { dimension: "factual"; verifiability: Verifiability; source?: EvidenceSource; override_basis?: string; p?: number }
  | { dimension: "coherence"; scope: Scope; resolution: Resolution; p?: number }
  | { dimension: "relevance"; p?: number }
  | { dimension: { emergent: string }; p?: number };

/** Both axes judged on the SAME witness; a broad but unrelated e and a well-sourced but narrow e never combine. */
export type AdmissibilityVerdict = { index: number; coverage: boolean; support_integrity: boolean; staleness_unverified?: boolean; p?: number }[];

export type PriorityVerdict = { id: string; priority: Priority; gain_rationale: string; p?: number }[];

/** One coherent cluster (size <= 4): shared decision frame, non-overlapping gain, independently answerable. */
export type ClusterVerdict = { ids: string[]; basis?: string };
