import { describe, expect, test } from "bun:test";
import {
  accumulate, answerCoherenceGate, applyAnswer, applyClassification, applyContextResolution, applyReadOnlyVerify, applyScan,
  attachEvidence, checkPartition, declareSufficient, markContradiction, nextPhase, questionCandidates, recordObservation, skipObservation,
  start, surface, trace,
} from "../domain/transitions.js";
import { InquireError } from "../domain/types.js";

const c = (id: string, description = id) => ({ id, domain: "d", description });
const ev = (source: string, content = "x") => ({ source, content });

function classified(verifiability: "read_only" | "empirical" | "user_dependent", id = "u1") {
  let s = applyScan(start("goal"), [c(id)], { kept: [{ id }] });
  s = applyClassification(s, id, { dimension: "factual", verifiability });
  return s;
}

describe("Phase 0", () => {
  test("zero-signal scan converges only with its reasoning", () => {
    expect(() => applyScan(start("goal"), [c("u1")], { kept: [] })).toThrow(InquireError);
    const s = applyScan(start("goal"), [c("u1")], { kept: [], sufficiency_reasoning: "the mandate fixes everything" });
    expect(s.converged?.kind).toBe("sufficient_at_scan");
    expect(s.active).toBe(false);
  });

  test("kept candidates land in remaining, unclassified, awaiting Phase 1; relevance is classify's call", () => {
    let s = applyScan(start("goal"), [c("f"), c("r")], { kept: [{ id: "f" }, { id: "r" }] });
    expect(s.uncertainties.map((u) => [u.bucket, u.classification, u.needs_phase1])).toEqual([["remaining", undefined, true], ["remaining", undefined, true]]);
    s = applyClassification(s, "r", { dimension: "relevance" });
    expect(s.uncertainties.find((u) => u.id === "r")?.bucket).toBe("non_factual_detected");
    expect(s.phase).toBe(1);
    checkPartition(s);
  });

  test("a dismissed (domain, description) pair stays skipped on re-scan", () => {
    let s = classified("user_dependent");
    s = surface(s, [{ id: "u1", priority: "critical", gain_rationale: "r" }], { ids: ["u1"] }).state;
    s = applyAnswer(s, "u1", { kind: "dismiss" }, "user");
    expect(s.converged?.kind).toBe("informed");
  });
});

describe("Phase 1 guards", () => {
  test("nothing resolves without evidence", () => {
    const s = classified("read_only");
    expect(() => applyContextResolution(s, "u1", { resolved: true })).toThrow("without evidence");
    expect(() => applyReadOnlyVerify(s, "u1", [])).toThrow("needs evidence");
  });

  test("source must be valid for the verifiability; user_tacit over a cheaper source needs a basis", () => {
    const s = applyScan(start("goal"), [c("u1")], { kept: [{ id: "u1" }] });
    expect(() => applyClassification(s, "u1", { dimension: "factual", verifiability: "read_only", source: "instrumentation" })).toThrow("not valid");
    expect(() => applyClassification(s, "u1", { dimension: "factual", verifiability: "read_only", source: "user_tacit" })).toThrow("cited basis");
    const o = applyClassification(s, "u1", { dimension: "factual", verifiability: "read_only", source: "user_tacit", override_basis: "only the author knows" });
    expect(o.source_choice_overrides).toHaveLength(1);
    expect(questionCandidates(o).map((u) => u.id)).toEqual(["u1"]);
  });

  test("default source is the cheapest valid one", () => {
    const s = classified("read_only");
    expect(s.uncertainties[0].classification).toEqual({ dimension: "factual", verifiability: "read_only", source: "code_derivable" });
  });

  test("ReadOnlyVerify needs one witness carrying both axes; otherwise the T4 back-edge to empirical", () => {
    let s = attachEvidence(classified("read_only"), "u1", [ev("a.ts:1"), ev("b.md:9")]);
    const failed = applyReadOnlyVerify(s, "u1", [
      { index: 0, coverage: true, support_integrity: false },
      { index: 1, coverage: false, support_integrity: true, staleness_unverified: true },
    ]);
    const u = failed.uncertainties[0];
    expect(u.bucket).toBe("remaining");
    expect(u.classification).toEqual({ dimension: "factual", verifiability: "empirical", source: "instrumentation" });
    expect(u.tags).toEqual(expect.arrayContaining(["coverage_gap", "support_integrity:unverified", "staleness:unverified"]));
    expect(u.tried_sources).toEqual(["code_derivable"]);

    const ok = applyReadOnlyVerify(s, "u1", [{ index: 0, coverage: true, support_integrity: true }]);
    expect(ok.uncertainties[0].bucket).toBe("read_only_resolved");
  });

  test("off-diagonal coherence waits for the user's Qc; memory_internal re-enters the factual path", () => {
    let s = applyScan(start("goal"), [c("k")], { kept: [{ id: "k" }] });
    s = applyClassification(s, "k", { dimension: "coherence", scope: "same", resolution: "structure" });
    expect(s.uncertainties[0].classification).toEqual({ dimension: "coherence", scope: "same", resolution: "structure" });
    expect(() => surface(s, [], { ids: ["k"] })).toThrow("Phase 1");
    const mi = answerCoherenceGate(s, "k", "memory_internal", "user");
    expect(mi.uncertainties[0].classification).toBeUndefined();
    expect(mi.uncertainties[0].tags).toContain("reclassified_from_memory_internal");
    const cd = answerCoherenceGate(s, "k", "cross_domain", "user");
    expect(cd.uncertainties[0].bucket).toBe("non_factual_detected");
  });

  test("diagonal coherence settles without a gate", () => {
    let s = applyScan(start("goal"), [c("k")], { kept: [{ id: "k" }] });
    s = applyClassification(s, "k", { dimension: "coherence", scope: "cross", resolution: "structure" });
    expect(s.uncertainties[0].bucket).toBe("non_factual_detected");
  });

  test("observation outcome is evidence; an escape reclassifies to user-dependent and is audited", () => {
    const s = classified("empirical");
    const observed = recordObservation(s, "u1", { setup: "", execute: "run", observe: "exit 0", cleanup: "" }, ev("observation:1", "exit 1"));
    expect(observed.uncertainties[0].bucket).toBe("empirically_observed");
    expect(observed.observation_history).toHaveLength(1);
    const skipped = skipObservation(s, "u1", "risk_elevated", "would mutate prod");
    expect(skipped.uncertainties[0].classification).toEqual({ dimension: "factual", verifiability: "user_dependent", source: "user_tacit" });
    expect(skipped.observation_skips[0].escape).toBe("risk_elevated");
  });
});

describe("Phase 2 / 3", () => {
  test("cluster is bounded to 4 and a multi-item cluster cites its basis", () => {
    let s = start("goal");
    const ids = ["a", "b", "c", "d", "e"];
    s = applyScan(s, ids.map((id) => c(id)), { kept: ids.map((id) => ({ id, p: 1 })) });
    for (const id of ids) s = applyClassification(s, id, { dimension: "factual", verifiability: "user_dependent" });
    const priorities = ids.map((id) => ({ id, priority: "significant" as const, gain_rationale: "g" }));
    expect(() => surface(s, priorities, { ids, basis: "b" })).toThrow("1 to 4");
    expect(() => surface(s, priorities, { ids: ["a", "b"] })).toThrow("basis");
    const { round } = surface(s, priorities, { ids: ["a", "b"], basis: "same decision frame" });
    expect(round.cluster.map((x) => x.id)).toEqual(["a", "b"]);
    expect(round.exhausted).toBe(false);
  });

  test("only the user answers; provide resolves, point returns the item to Phase 1", () => {
    let s = classified("user_dependent");
    s = surface(s, [{ id: "u1", priority: "critical", gain_rationale: "r" }], { ids: ["u1"] }).state;
    expect(() => applyAnswer(s, "u1", { kind: "provide", content: "x" }, "judge" as never)).toThrow("Only the user");
    const provided = applyAnswer(s, "u1", { kind: "provide", content: "the API is v2" }, "user");
    expect(provided.uncertainties[0].bucket).toBe("user_responded");
    expect(provided.converged?.kind).toBe("informed");
    const pointed = applyAnswer(s, "u1", { kind: "point", location: "docs/api.md" }, "user");
    expect(pointed.uncertainties[0].needs_phase1).toBe(true);
    expect(pointed.phase).toBe(1);
  });

  test("Unknown promotes to the next untried source; with none left the item is spent and the round is exhausted", () => {
    let s = applyScan(start("goal"), [c("u1")], { kept: [{ id: "u1" }] });
    s = applyClassification(s, "u1", { dimension: "factual", verifiability: "read_only", source: "user_tacit", override_basis: "author-only" });
    s = surface(s, [{ id: "u1", priority: "critical", gain_rationale: "r" }], { ids: ["u1"] }).state;
    s = applyAnswer(s, "u1", { kind: "unknown", partial: "maybe" }, "user");
    expect(s.uncertainties[0].classification).toEqual({ dimension: "factual", verifiability: "read_only", source: "code_derivable" });
    expect(s.phase).toBe(1);

    let t = classified("user_dependent");
    t = surface(t, [{ id: "u1", priority: "critical", gain_rationale: "r" }], { ids: ["u1"] }).state;
    t = applyAnswer(t, "u1", { kind: "unknown", partial: "no idea" }, "user");
    expect(t.uncertainties[0].spent).toBe(true);
    expect(t.phase).toBe(2);
    const { round } = surface(t, [], { ids: ["u1"] });
    expect(round.exhausted).toBe(true);
  });

  test("a contradiction marks the cluster exhausted", () => {
    let s = applyScan(start("goal"), [c("k")], { kept: [{ id: "k" }] });
    s = applyClassification(s, "k", { dimension: "coherence", scope: "same", resolution: "structure" });
    s = answerCoherenceGate(s, "k", "memory_internal", "user");
    s = applyClassification(s, "k", { dimension: "factual", verifiability: "user_dependent" });
    s = markContradiction(s, "k", "'never touch X' vs 'rewrite X'");
    const { round } = surface(s, [{ id: "k", priority: "critical", gain_rationale: "r" }], { ids: ["k"] });
    expect(round.exhausted).toBe(true);
  });

  test("an emergent channel is gated: point validates, dismiss declines", () => {
    let s = applyScan(start("goal"), [c("u1")], { kept: [{ id: "u1" }] });
    s = applyClassification(s, "u1", { dimension: "factual", verifiability: "read_only", source: { emergent: "async-comms" } });
    expect(s.uncertainties[0].tags).toContain("channel_unvalidated");
    s = surface(s, [{ id: "u1", priority: "marginal", gain_rationale: "r" }], { ids: ["u1"] }).state;
    const validated = applyAnswer(s, "u1", { kind: "point", location: "slack#ops" }, "user");
    expect(validated.channel_validations).toHaveLength(1);
    expect(validated.uncertainties[0].needs_phase1).toBe(true);
    const declined = applyAnswer(s, "u1", { kind: "dismiss" }, "user");
    expect(declined.uncertainties[0].bucket).toBe("dismissed");
  });

  test("sufficiency declaration dismisses the remainder with the declaration recorded", () => {
    let s = classified("user_dependent");
    expect(() => declareSufficient(s, "", "user")).toThrow();
    s = declareSufficient(s, "enough to start", "user");
    expect(s.uncertainties[0].dismiss_reason).toContain("enough to start");
    const t = trace(s);
    expect(t.dismissed).toHaveLength(1);
    expect(t.rows).toHaveLength(0);
  });

  test("new uncertainties accumulate and never replace", () => {
    let s = classified("user_dependent");
    s = accumulate(s, [c("u2")], { kept: [{ id: "u2" }] });
    expect(s.uncertainties.map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(() => accumulate(s, [c("u2")], { kept: [] })).toThrow("already exists");
    checkPartition(s);
  });

  test("trace is available only at convergence and separates transformed from declared", () => {
    let s = attachEvidence(classified("read_only"), "u1", [ev("a.ts:1")]);
    expect(() => trace(s)).toThrow("convergence");
    s = applyReadOnlyVerify(s, "u1", [{ index: 0, coverage: true, support_integrity: true }]);
    s = nextPhase(s);
    expect(s.converged?.kind).toBe("informed");
    expect(trace(s).rows).toEqual([{ id: "u1", from: "ContextInsufficient", to: "read_only_resolved", detail: "a.ts:1" }]);
  });
});
