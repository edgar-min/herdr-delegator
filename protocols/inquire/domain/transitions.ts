// Aitesis transitions. Every function takes a state and returns a new state; judgments arrive as arguments
// (the driver asked the judge first). Rejections throw InquireError with a code. Nothing here reads files,
// runs anything, or talks to a model — that is the driver's work, and the protocol's own "Evidence over
// Inference over Detection" is what these guards enforce.
import type { AdmissibilityVerdict, Candidate, ClassifyVerdict, ClusterVerdict, ContextResolutionVerdict, PriorityVerdict, ScanVerdict } from "./judgments.js";
import {
  type Answer, type Bucket, type Classification, type CoherenceType, type EscapeCondition, type Evidence, type EvidenceSource,
  InquireError, type InquireState, type ObservationSpec, type Priority, type Uncertainty, type Verifiability, SOURCE_COST, isEmergent, offDiagonal, sameSource, validSources,
} from "./types.js";

// ------------------------------------------------------------------ helpers

const now = (): number => Date.now();

function clone(state: InquireState): InquireState {
  return structuredClone(state);
}

function find(state: InquireState, id: string): Uncertainty {
  const u = state.uncertainties.find((x) => x.id === id);
  if (!u) throw new InquireError("unknown_item", `No uncertainty ${id}`);
  return u;
}

function log(state: InquireState, event: string, id?: string, detail?: unknown): void {
  state.history.push({ at: now(), event, id, detail });
}

function requireActive(state: InquireState): void {
  if (!state.active || state.converged) throw new InquireError("inactive", "The inquiry has converged or was never activated");
}

const factual = (u: Uncertainty) => (u.classification?.dimension === "factual" ? u.classification : undefined);

/** Phase 2 candidates: user-dependent items, cited UserTacit overrides, emergent channels, all still remaining. */
export function questionCandidates(state: InquireState): Uncertainty[] {
  return state.uncertainties.filter((u) => {
    if (u.bucket !== "remaining" || u.needs_phase1) return false;
    const f = factual(u);
    if (!f) return false;
    return f.verifiability === "user_dependent" || f.source === "user_tacit" || isEmergent(f.source);
  });
}

/** Items that still need a Phase 1 pass: unclassified, pending coherence gate, pointed, or promoted. */
export function phase1Pending(state: InquireState): Uncertainty[] {
  return state.uncertainties.filter((u) => u.bucket === "remaining" && (u.needs_phase1 || !u.classification || (u.classification.dimension === "coherence" && !u.classification.type)));
}

/** LOOP: where the protocol goes next, read off the partition. */
export function nextPhase(state: InquireState): InquireState {
  const s = clone(state);
  if (s.converged) return s;
  const remaining = s.uncertainties.filter((u) => u.bucket === "remaining");
  if (remaining.length === 0) {
    s.converged = { kind: "informed" };
    s.active = false;
    log(s, "converge", undefined, s.converged);
    return s;
  }
  if (phase1Pending(s).length > 0) s.phase = 1;
  else if (questionCandidates(s).length > 0) s.phase = 2;
  else s.phase = 1; // read-only / empirical items still to verify or observe
  return s;
}

// -------------------------------------------------------------------- Phase 0

export function start(prospect: string, source?: string): InquireState {
  if (!prospect.trim()) throw new InquireError("empty_prospect", "A prospect is required");
  return {
    version: 1, prospect: { text: prospect, source }, phase: 0, uncertainties: [], history: [{ at: now(), event: "start" }],
    observation_history: [], observation_skips: [], source_choice_overrides: [], channel_validations: [], dismissed_pairs: [], active: true,
  };
}

/** Scan: candidates are the mandate's passages; the judge keeps the ones execution depends on. Nothing kept → sufficiency relay. */
export function applyScan(state: InquireState, candidates: Candidate[], verdict: ScanVerdict): InquireState {
  requireActive(state);
  if (state.phase !== 0) throw new InquireError("wrong_phase", "Scan runs in Phase 0 only");
  const s = clone(state);
  const ids = new Set(candidates.map((c) => c.id));
  if (ids.size !== candidates.length) throw new InquireError("duplicate_candidate", "Candidate ids must be unique");
  for (const k of verdict.kept) if (!ids.has(k.id)) throw new InquireError("unknown_candidate", `Verdict names ${k.id}, not a candidate`);
  const kept = verdict.kept.filter((k) => {
    const c = candidates.find((x) => x.id === k.id)!;
    return !s.dismissed_pairs.some((d) => d.domain === c.domain && d.description === c.description);
  });
  if (kept.length === 0) {
    if (!verdict.sufficiency_reasoning) throw new InquireError("missing_reasoning", "Zero-signal scan must present its sufficiency reasoning");
    s.converged = { kind: "sufficient_at_scan", reasoning: verdict.sufficiency_reasoning };
    s.active = false;
    log(s, "sufficiency_relay", undefined, verdict.sufficiency_reasoning);
    return s;
  }
  for (const k of kept) {
    const c = candidates.find((x) => x.id === k.id)!;
    s.uncertainties.push({
      id: c.id, domain: c.domain, description: c.description, claim: c.claim, evidence: [], classification: undefined, priority: undefined,
      bucket: "remaining", tags: [], tried_sources: [], spent: false, needs_phase1: true,
    });
    log(s, "scan_keep", c.id, k);
  }
  s.phase = 1;
  return s;
}

/** LOOP re-scan: new uncertainties accumulate; they never replace existing ones. */
export function accumulate(state: InquireState, candidates: Candidate[], verdict: ScanVerdict): InquireState {
  requireActive(state);
  const s = clone(state);
  for (const c of candidates) if (s.uncertainties.some((u) => u.id === c.id)) throw new InquireError("duplicate_item", `${c.id} already exists`);
  const scanned = applyScan({ ...s, phase: 0 }, candidates, { kept: verdict.kept, sufficiency_reasoning: verdict.sufficiency_reasoning ?? "no new uncertainty" });
  if (scanned.converged?.kind === "sufficient_at_scan") { // nothing new: keep going from where we were
    const back = clone(s);
    log(back, "rescan_empty");
    return nextPhase(back);
  }
  return nextPhase(scanned);
}

// -------------------------------------------------------------------- Phase 1

/** Step 1 Ctx: attach collected evidence. Attaching never resolves by itself. */
export function attachEvidence(state: InquireState, id: string, evidence: Evidence[]): InquireState {
  requireActive(state);
  if (evidence.length === 0) throw new InquireError("no_evidence", "attachEvidence needs at least one piece of evidence");
  const s = clone(state);
  const u = find(s, id);
  if (u.bucket !== "remaining") throw new InquireError("not_remaining", `${id} is ${u.bucket}`);
  for (const e of evidence) {
    if (!e.source || !e.content) throw new InquireError("bad_evidence", "Evidence needs source and content");
    u.evidence.push(e);
  }
  log(s, "collect", id, evidence.map((e) => e.source));
  return s;
}

/** Ctx may resolve an item outright (Uᵣ) — only with evidence attached, and only by a judgment over it. */
export function applyContextResolution(state: InquireState, id: string, verdict: ContextResolutionVerdict): InquireState {
  requireActive(state);
  const s = clone(state);
  const u = find(s, id);
  if (u.bucket !== "remaining") throw new InquireError("not_remaining", `${id} is ${u.bucket}`);
  if (u.evidence.length === 0) throw new InquireError("no_evidence", "Nothing can be context-resolved without evidence");
  if (verdict.resolved) {
    u.bucket = "context_resolved";
    u.needs_phase1 = false;
    log(s, "context_resolved", id, verdict);
  } else log(s, "context_enriched", id, verdict);
  return s;
}

function defaultSource(u: Uncertainty, verifiability: Verifiability): EvidenceSource {
  const untried = validSources(verifiability).filter((src) => !u.tried_sources.some((t) => sameSource(t, src)));
  const pool = untried.length > 0 ? untried : validSources(verifiability);
  return pool.sort((a, b) => SOURCE_COST[a] - SOURCE_COST[b])[0];
}

/** Step 2 classify (the core act). Off-diagonal coherence waits for the Qc gate; detect-only fibers leave scope. */
export function applyClassification(state: InquireState, id: string, verdict: ClassifyVerdict): InquireState {
  requireActive(state);
  const s = clone(state);
  const u = find(s, id);
  if (u.bucket !== "remaining") throw new InquireError("not_remaining", `${id} is ${u.bucket}`);
  switch (verdict.dimension) {
    case "factual": {
      const valid = validSources(verdict.verifiability);
      let source: EvidenceSource = verdict.source ?? defaultSource(u, verdict.verifiability);
      if (isEmergent(source)) {
        u.tags.push("channel_unvalidated");
      } else {
        if (!valid.includes(source)) throw new InquireError("invalid_source", `${source} is not valid for ${verdict.verifiability}`);
        const cheapest = defaultSource(u, verdict.verifiability);
        if (source === "user_tacit" && cheapest !== "user_tacit") {
          if (!verdict.override_basis) throw new InquireError("override_needs_basis", "Choosing user_tacit over a cheaper source requires a cited basis (Cite-or-observe)");
          s.source_choice_overrides.push({ id, source, basis: verdict.override_basis });
        }
      }
      u.classification = { dimension: "factual", verifiability: verdict.verifiability, source };
      u.needs_phase1 = false;
      log(s, "classify", id, u.classification);
      return s;
    }
    case "coherence": {
      u.classification = { dimension: "coherence", scope: verdict.scope, resolution: verdict.resolution };
      if (!offDiagonal(verdict.scope, verdict.resolution)) {
        const type: CoherenceType = verdict.scope === "same" ? "memory_internal" : "cross_domain";
        return settleCoherence(s, id, type);
      }
      log(s, "coherence_gate_pending", id, u.classification);
      return s; // Qc must fire
    }
    case "relevance":
    default: {
      u.classification = { dimension: verdict.dimension } as Classification;
      u.bucket = "non_factual_detected";
      u.needs_phase1 = false;
      u.tags.push("out_of_scope");
      log(s, "detect_only", id, verdict.dimension);
      return s;
    }
  }
}

function settleCoherence(s: InquireState, id: string, type: CoherenceType): InquireState {
  const u = find(s, id);
  if (u.classification?.dimension !== "coherence") throw new InquireError("not_coherence", `${id} is not a coherence item`);
  u.classification.type = type;
  if (type === "cross_domain") {
    u.bucket = "non_factual_detected";
    u.needs_phase1 = false;
    u.tags.push("out_of_scope");
    log(s, "coherence_cross_domain", id);
  } else {
    // MemoryInternal enters the Factual resolution path: it must be classified again as factual.
    u.tags.push("reclassified_from_memory_internal");
    u.classification = undefined;
    u.needs_phase1 = true;
    log(s, "coherence_memory_internal", id);
  }
  return s;
}

/** Qc gate: the user classifies an off-diagonal coherence item. */
export function answerCoherenceGate(state: InquireState, id: string, type: CoherenceType, by: "user"): InquireState {
  requireActive(state);
  if (by !== "user") throw new InquireError("not_user", "Only the user answers a Constitution gate");
  const s = clone(state);
  const u = find(s, id);
  if (u.classification?.dimension !== "coherence" || u.classification.type) throw new InquireError("no_pending_gate", `${id} has no pending coherence gate`);
  return settleCoherence(s, id, type);
}

/** A MemoryInternal item that contradicts itself or the context and that no evidence can settle. */
export function markContradiction(state: InquireState, id: string, quote: string): InquireState {
  requireActive(state);
  const s = clone(state);
  const u = find(s, id);
  if (!u.tags.includes("reclassified_from_memory_internal")) throw new InquireError("not_memory_internal", "Only a MemoryInternal item can be a contradiction");
  u.contradiction = quote;
  log(s, "contradiction", id, quote);
  return s;
}

/** Step 3 ReadOnlyVerify: admissible(u) needs ONE witness carrying both axes; otherwise the T4 back-edge. */
export function applyReadOnlyVerify(state: InquireState, id: string, verdict: AdmissibilityVerdict): InquireState {
  requireActive(state);
  const s = clone(state);
  const u = find(s, id);
  const f = factual(u);
  if (u.bucket !== "remaining" || !f || f.verifiability !== "read_only") throw new InquireError("not_read_only", `${id} is not a read-only candidate`);
  if (f.source === "user_tacit" || isEmergent(f.source)) throw new InquireError("not_read_only", `${id} routes through ${JSON.stringify(f.source)}, not ReadOnlyVerify`);
  if (u.evidence.length === 0) throw new InquireError("no_evidence", "ReadOnlyVerify needs evidence to judge");
  for (const v of verdict) {
    const e = u.evidence[v.index];
    if (!e) throw new InquireError("bad_index", `No evidence at ${v.index}`);
    e.coverage = v.coverage;
    e.support_integrity = v.support_integrity;
    if (v.staleness_unverified) e.staleness_unverified = true;
  }
  const admissible = u.evidence.some((e) => e.coverage && e.support_integrity);
  if (admissible) {
    u.bucket = "read_only_resolved";
    log(s, "read_only_resolved", id);
    return s;
  }
  const anyCoverage = u.evidence.some((e) => e.coverage);
  const anySupport = u.evidence.some((e) => e.support_integrity);
  if (!anyCoverage) u.tags.push("coverage_gap");
  if (!anySupport) u.tags.push("support_integrity:unverified");
  if (anyCoverage && anySupport) u.tags.push("coverage_gap", "support_integrity:unverified"); // each axis has a witness, no single e carries both
  if (u.evidence.some((e) => e.staleness_unverified)) u.tags.push("staleness:unverified");
  u.tried_sources.push(f.source);
  u.classification = { dimension: "factual", verifiability: "empirical", source: defaultSource(u, "empirical") };
  log(s, "reclassify_empirical", id, u.tags);
  return s;
}

/** Step 4 EmpiricalObservation: the outcome is evidence whether positive, negative, or budget-exhausted. */
export function recordObservation(state: InquireState, id: string, spec: ObservationSpec, evidence: Evidence): InquireState {
  requireActive(state);
  const s = clone(state);
  const u = find(s, id);
  const f = factual(u);
  if (u.bucket !== "remaining" || !f || f.verifiability !== "empirical") throw new InquireError("not_empirical", `${id} is not an observation candidate`);
  if (f.source === "user_tacit") throw new InquireError("not_empirical", `${id} routes through user_tacit`);
  u.evidence.push(evidence);
  u.bucket = "empirically_observed";
  s.observation_history.push({ id, spec, evidence });
  log(s, "observed", id, evidence.source);
  return s;
}

/** Cite-or-observe escape: the observation MUST NOT run; the item becomes user-dependent and the skip is audited. */
export function skipObservation(state: InquireState, id: string, escape: EscapeCondition, rationale: string): InquireState {
  requireActive(state);
  const s = clone(state);
  const u = find(s, id);
  const f = factual(u);
  if (u.bucket !== "remaining" || !f || f.verifiability !== "empirical") throw new InquireError("not_empirical", `${id} is not an observation candidate`);
  if (!rationale) throw new InquireError("missing_rationale", "An escape needs its rationale");
  s.observation_skips.push({ id, escape, rationale });
  u.tried_sources.push(f.source);
  u.classification = { dimension: "factual", verifiability: "user_dependent", source: "user_tacit" };
  log(s, "observation_skipped", id, escape);
  return s;
}

// -------------------------------------------------------------------- Phase 2

export type Round = {
  cluster: { id: string; description: string; priority?: Priority; gain_rationale?: string; evidence: Evidence[]; tags: string[]; spent: boolean; contradiction?: string }[];
  observed: { id: string; evidence: Evidence[] }[];
  out_of_scope: string[];
  gates: { emergent_channel: string[]; staleness: string[] };
  exhausted: boolean;
  options: Answer["kind"][];
  basis?: string;
};

/** Qs: surface one coherent cluster (<= 4) ordered by information gain. Judgments supply priority and cluster. */
export function surface(state: InquireState, priorities: PriorityVerdict, cluster: ClusterVerdict): { state: InquireState; round: Round } {
  requireActive(state);
  const s = clone(state);
  if (phase1Pending(s).length > 0) throw new InquireError("phase1_pending", "Items still need Phase 1 before a question round");
  const candidates = questionCandidates(s);
  if (candidates.length === 0) throw new InquireError("nothing_to_ask", "No user-dependent uncertainty remains");
  for (const p of priorities) {
    const u = candidates.find((c) => c.id === p.id);
    if (!u) throw new InquireError("unknown_candidate", `${p.id} is not a question candidate`);
    u.priority = p.priority;
    u.gain_rationale = p.gain_rationale;
  }
  if (cluster.ids.length === 0 || cluster.ids.length > 4) throw new InquireError("bad_cluster", "A cluster holds 1 to 4 items");
  if (cluster.ids.length > 1 && !cluster.basis) throw new InquireError("cluster_needs_basis", "A multi-item cluster cites its clustering basis");
  const items = cluster.ids.map((id) => {
    const u = candidates.find((c) => c.id === id);
    if (!u) throw new InquireError("unknown_candidate", `${id} is not a question candidate`);
    if (!u.priority) throw new InquireError("missing_priority", `${id} has no priority`);
    return u;
  });
  s.phase = 2;
  const exhausted = items.every((u) => u.spent) || items.some((u) => !!u.contradiction);
  const round: Round = {
    cluster: items.map((u) => ({ id: u.id, description: u.description, priority: u.priority, gain_rationale: u.gain_rationale, evidence: u.evidence, tags: u.tags, spent: u.spent, contradiction: u.contradiction })),
    observed: s.uncertainties.filter((u) => u.bucket === "empirically_observed").map((u) => ({ id: u.id, evidence: u.evidence })),
    out_of_scope: s.uncertainties.filter((u) => u.bucket === "non_factual_detected").map((u) => u.id),
    gates: {
      emergent_channel: items.filter((u) => u.tags.includes("channel_unvalidated")).map((u) => u.id),
      staleness: items.filter((u) => u.tags.includes("staleness:unverified")).map((u) => u.id),
    },
    exhausted,
    options: ["provide", "point", "dismiss", "unknown"],
    basis: cluster.basis,
  };
  log(s, "surface", undefined, { ids: cluster.ids, exhausted });
  return { state: s, round };
}

// -------------------------------------------------------------------- Phase 3

/** integrate(A, X): only the user's own answer moves an item. A judgment can never stand in for one. */
export function applyAnswer(state: InquireState, id: string, answer: Answer, by: "user"): InquireState {
  requireActive(state);
  if (by !== "user") throw new InquireError("not_user", "Only the user answers a question");
  if (state.phase !== 2) throw new InquireError("wrong_phase", "Answers are integrated after a Phase 2 round");
  const s = clone(state);
  const u = find(s, id);
  if (u.bucket !== "remaining") throw new InquireError("not_remaining", `${id} is ${u.bucket}`);
  const f = factual(u);
  if (!f) throw new InquireError("not_factual", `${id} is not on the question path`);
  s.phase = 3;
  u.answer = answer;
  if (u.tags.includes("channel_unvalidated")) {
    s.channel_validations.push({ id, channel: f.source, answer });
    u.tags = u.tags.filter((t) => t !== "channel_unvalidated");
    if (answer.kind === "point") { u.tags.push("channel_validated"); u.needs_phase1 = true; log(s, "channel_validated", id, answer.location); return nextPhase(s); }
    if (answer.kind === "dismiss") { u.bucket = "dismissed"; u.dismiss_reason = "channel declined"; log(s, "channel_declined", id); return nextPhase(s); }
    if (answer.kind === "unknown") { log(s, "channel_unresolved", id); return nextPhase(s); }
    // provide supersedes the channel: falls through as a normal Provide
  }
  switch (answer.kind) {
    case "provide":
      u.evidence.push({ source: "user", content: answer.content, ref: { source_kind: "user_tacit", referent: u.claim?.referent ?? u.description, scope: u.claim?.scope ?? "" } });
      u.bucket = "user_responded";
      log(s, "user_responded", id);
      break;
    case "point":
      u.evidence.push({ source: answer.location, content: `pointed by user: ${answer.location}` });
      u.tried_sources.push(f.source);
      u.classification = undefined;
      u.needs_phase1 = true;
      log(s, "pointed", id, answer.location);
      break;
    case "dismiss":
      u.bucket = "dismissed";
      u.dismiss_reason = "user dismissed";
      s.dismissed_pairs.push({ domain: u.domain, description: u.description });
      log(s, "dismissed", id);
      break;
    case "unknown": {
      u.evidence.push({ source: "user", content: `partial: ${answer.partial}` });
      u.tried_sources.push(f.source);
      const untried = validSources(f.verifiability).filter((src) => !u.tried_sources.some((t) => sameSource(t, src))).sort((a, b) => SOURCE_COST[a] - SOURCE_COST[b]);
      if (untried.length > 0) {
        const promoted = untried[0];
        u.classification = { dimension: "factual", verifiability: f.verifiability, source: promoted };
        u.needs_phase1 = true;
        log(s, "auto_promote", id, promoted);
      } else {
        u.spent = true;
        log(s, "spent", id);
      }
      break;
    }
  }
  return nextPhase(s);
}

/** The user's free-response sufficiency declaration: every remaining item is dismissed with the declaration recorded. */
export function declareSufficient(state: InquireState, declaration: string, by: "user"): InquireState {
  requireActive(state);
  if (by !== "user") throw new InquireError("not_user", "Only the user declares sufficiency");
  if (!declaration.trim()) throw new InquireError("missing_declaration", "The declaration is recorded against each dismissed item");
  const s = clone(state);
  for (const u of s.uncertainties) if (u.bucket === "remaining") { u.bucket = "dismissed"; u.dismiss_reason = `declared sufficient: ${declaration}`; }
  s.converged = { kind: "declared", declaration };
  s.active = false;
  log(s, "sufficiency_declared", undefined, declaration);
  return s;
}

// ------------------------------------------------------------ invariants / trace

const BUCKETS: Bucket[] = ["remaining", "context_resolved", "read_only_resolved", "empirically_observed", "non_factual_detected", "user_responded", "dismissed"];

/** MODE STATE invariant: the buckets partition the uncertainty set. */
export function checkPartition(state: InquireState): void {
  const ids = new Set<string>();
  for (const u of state.uncertainties) {
    if (!BUCKETS.includes(u.bucket)) throw new InquireError("invariant", `${u.id} in unknown bucket ${u.bucket}`);
    if (ids.has(u.id)) throw new InquireError("invariant", `${u.id} appears twice`);
    ids.add(u.id);
  }
}

export type TraceRow = { id: string; from: "ContextInsufficient"; to: string; detail?: string };

/** Convergence evidence: demonstrated, not asserted. Non-factual detections are declared, not transformed. */
export function trace(state: InquireState): { rows: TraceRow[]; out_of_scope: string[]; dismissed: { id: string; reason?: string }[]; exhausted: { id: string; tried: EvidenceSource[]; contradiction?: string }[] } {
  if (!state.converged) throw new InquireError("not_converged", "Trace is presented at convergence");
  const rows: TraceRow[] = [];
  for (const u of state.uncertainties) {
    if (u.bucket === "context_resolved" || u.bucket === "read_only_resolved" || u.bucket === "empirically_observed" || u.bucket === "user_responded") {
      rows.push({ id: u.id, from: "ContextInsufficient", to: u.bucket, detail: u.evidence.at(-1)?.source });
    }
  }
  return {
    rows,
    out_of_scope: state.uncertainties.filter((u) => u.bucket === "non_factual_detected").map((u) => u.id),
    dismissed: state.uncertainties.filter((u) => u.bucket === "dismissed").map((u) => ({ id: u.id, reason: u.dismiss_reason })),
    exhausted: state.uncertainties.filter((u) => u.spent || u.contradiction).map((u) => ({ id: u.id, tried: u.tried_sources, contradiction: u.contradiction })),
  };
}
