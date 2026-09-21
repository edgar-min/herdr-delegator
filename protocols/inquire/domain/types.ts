// Aitesis (/inquire) domain types. Pure: no I/O, no model, no Herdr knowledge.
// Source of the vocabulary: epistemic-protocols/aitesis/skills/inquire/SKILL.md (TYPES / MODE STATE).

export type Emergent = { emergent: string };

/** Layer 1 dimension of an uncertainty. `relevance` and emergent dimensions are detect-only. */
export type Dimension = "factual" | "coherence" | "relevance" | Emergent;

/** Layer 2, Factual fiber only. */
export type Verifiability = "read_only" | "empirical" | "user_dependent";

export type BaseSource = "code_derivable" | "canonical_external" | "instrumentation" | "user_tacit";
export type EvidenceSource = BaseSource | Emergent;

/** Cost ordering tiebreaker, ascending: the default picks the cheapest valid source. */
export const SOURCE_COST: Record<BaseSource, number> = { code_derivable: 0, canonical_external: 1, instrumentation: 2, user_tacit: 3 };

export function validSources(v: Verifiability): BaseSource[] {
  switch (v) {
    case "read_only": return ["code_derivable", "canonical_external", "user_tacit"];
    case "empirical": return ["instrumentation", "user_tacit"];
    case "user_dependent": return ["user_tacit"];
  }
}

export const isEmergent = (x: unknown): x is Emergent => typeof x === "object" && x !== null && "emergent" in x;
export const sameSource = (a: EvidenceSource, b: EvidenceSource): boolean =>
  isEmergent(a) ? isEmergent(b) && a.emergent === b.emergent : a === b;

export type Scope = "same" | "cross";
export type Resolution = "evidence" | "structure";
export type CoherenceType = "memory_internal" | "cross_domain";
export const offDiagonal = (s: Scope, r: Resolution): boolean => !((s === "same" && r === "evidence") || (s === "cross" && r === "structure"));

/** What an uncertainty claims, so evidence can be judged against it (provenance coupling). */
export type Claim = { referent: string; scope: string; expected_source_kind: EvidenceSource };

/** Interpretive extraction over a piece of evidence; inferred, never deterministic. */
export type EvidenceRef = { source_kind: EvidenceSource; referent: string; scope: string; observed_at?: string };

export type Evidence = {
  source: string;   // e.g. "path:line", "web:{url}", "history:{ref}", "observation:{id}", "user"
  content: string;
  ref?: EvidenceRef;
  /** Written by ReadOnlyVerify: the two admissibility axes judged on THIS witness. */
  coverage?: boolean;
  support_integrity?: boolean;
  staleness_unverified?: boolean;
};

export type Priority = "critical" | "significant" | "marginal";

export type Classification =
  | { dimension: "factual"; verifiability: Verifiability; source: EvidenceSource }
  | { dimension: "coherence"; scope: Scope; resolution: Resolution; type?: CoherenceType }
  | { dimension: "relevance" }
  | { dimension: Emergent };

/** The partition every uncertainty sits in exactly one cell of (MODE STATE invariant). */
export type Bucket =
  | "remaining"
  | "context_resolved"
  | "read_only_resolved"
  | "empirically_observed"
  | "non_factual_detected"
  | "user_responded"
  | "dismissed";

export type Answer =
  | { kind: "provide"; content: string }
  | { kind: "point"; location: string }
  | { kind: "dismiss" }
  | { kind: "unknown"; partial: string };

export type Uncertainty = {
  id: string;
  domain: string;
  description: string;
  claim?: Claim;
  evidence: Evidence[];
  classification?: Classification;
  priority?: Priority;
  gain_rationale?: string;
  bucket: Bucket;
  tags: string[];
  tried_sources: EvidenceSource[];
  /** Unknown(Partial) with no untried valid source: promotion has no target. */
  spent: boolean;
  /** Coherence/MemoryInternal that no evidence settles: the utterance contradicts itself or the context. */
  contradiction?: string;
  /** A Phase 2 answer moves the item; the record keeps the user's exact answer. */
  answer?: Answer;
  dismiss_reason?: string;
  /** Point(location) or auto-promotion: the item must pass Phase 1 again before Phase 2 may show it. */
  needs_phase1: boolean;
};

export type ObservationSpec = { setup: string; execute: string; observe: string; cleanup: string };
export type EscapeCondition = "environment_mutation" | "risk_elevated";

export type Phase = 0 | 1 | 2 | 3;

export type Convergence =
  | { kind: "sufficient_at_scan"; reasoning: string }
  | { kind: "informed" }
  | { kind: "declared"; declaration: string };

export type HistoryEvent = { at: number; event: string; id?: string; detail?: unknown };

export type InquireState = {
  version: 1;
  prospect: { text: string; source?: string };
  phase: Phase;
  uncertainties: Uncertainty[];
  history: HistoryEvent[];
  observation_history: { id: string; spec: ObservationSpec; evidence: Evidence }[];
  observation_skips: { id: string; escape: EscapeCondition; rationale: string }[];
  source_choice_overrides: { id: string; source: EvidenceSource; basis: string }[];
  channel_validations: { id: string; channel: EvidenceSource; answer: Answer }[];
  /** A dismissed (domain, description) pair stays skipped for the session. */
  dismissed_pairs: { domain: string; description: string }[];
  active: boolean;
  converged?: Convergence;
};

export class InquireError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
