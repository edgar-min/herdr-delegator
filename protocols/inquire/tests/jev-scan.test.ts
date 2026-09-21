import { describe, expect, test } from "bun:test";
import { CHOICE_CRITERIA, DEPENDENCE_LEVELS, passages, SCAN_QUESTION_VERSION, scanQuestions, type ScanState } from "../adapters/jev-scan.js";
import example from "../fixtures/example-mandate.json" with { type: "json" };

const fixture = example as ScanState;

describe("scan questions", () => {
  test("one sufficiency noul plus one choice per passage, over the four levels", () => {
    const ps = passages(fixture);
    const q = scanQuestions(fixture);
    expect(Object.keys(q).length).toBe(ps.length + 1);
    expect(Object.values(q).filter((x) => x.type === "noul").length).toBe(1);
    expect(q.sufficient.type).toBe("noul");
    const choices = Object.entries(q).filter(([id]) => id !== "sufficient");
    expect(choices.map(([id]) => id)).toEqual(ps.map((p) => `dep:${p.id}`));
    for (const [, question] of choices) {
      expect(question.type).toBe("choice");
      expect(Object.keys((question as { criteria: Record<string, string> }).criteria)).toEqual([...DEPENDENCE_LEVELS]);
    }
    expect(Object.keys(CHOICE_CRITERIA)).toEqual([...DEPENDENCE_LEVELS]);
    expect(SCAN_QUESTION_VERSION).toBe("2026-09-21.3");
  });

  test("the question names its own passage path and the domain's verb", () => {
    const q = scanQuestions(fixture);
    const constraint = q["dep:mandate.constraints.prohibitions[0]"];
    expect(constraint.instructions).toBe(
      "Consider `mandate.constraints.prohibitions[0]` in the context of the whole mandate. To comply with this constraint, what is the next thing the ORCH must do because of this passage?",
    );
    expect(q["dep:mandate.shape_of_success[0]"].instructions).toContain("To judge this outcome as met,");
    expect(q["dep:mandate.intent.purpose"].instructions).toContain("To carry out this item,");
  });
});

describe("passages", () => {
  test("context keys are state the questions read, never targets", () => {
    const ids = passages(fixture).map((p) => p.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => /(^|\.)definitions?($|[.[])/.test(id))).toBe(false);
    expect(ids.every((id) => id.startsWith("mandate."))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a `text` leaf takes its parent's path and `items` keeps the key, both with the per-passage definition dropped", () => {
    const annotated: ScanState = {
      definitions: { "mandate.intent": "context, never a target" },
      mandate: {
        intent: {
          definition: "context, never a target",
          purpose: { definition: "context", text: "why the track exists" },
          work_items: { definition: "context", items: ["first outcome", "second outcome"] },
        },
        shape_of_success: ["one observable condition"],
      },
    };
    expect(passages(annotated)).toEqual([
      { id: "mandate.intent.purpose", domain: "intent", description: "why the track exists" },
      { id: "mandate.intent.work_items.items[0]", domain: "intent", description: "first outcome" },
      { id: "mandate.intent.work_items.items[1]", domain: "intent", description: "second outcome" },
      { id: "mandate.shape_of_success[0]", domain: "shape_of_success", description: "one observable condition" },
    ]);
  });
});
