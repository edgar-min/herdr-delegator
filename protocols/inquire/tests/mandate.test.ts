import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMandate, passages, sentences } from "../adapters/mandate.js";
import { applyScan, start } from "../domain/transitions.js";

const fixture = readFileSync(join(import.meta.dir, "../fixtures/hexddd-rules-3.md"), "utf8");

describe("scan state from a mandate", () => {
  test("the fixed state has stable passage paths and excludes the budget section", () => {
    const state = parseMandate(fixture);
    expect(state.constraints).toHaveLength(8);
    expect(state.shape_of_success).toHaveLength(6);
    expect(state.intent.length).toBeGreaterThan(1);
    expect(JSON.stringify(state)).not.toContain("seed:");
    const paths = passages(state).map((p) => p.path);
    expect(paths[0]).toBe("intent[0]");
    expect(paths).toContain("constraints[7]");
    expect(paths.at(-1)).toBe("shape_of_success[5]");
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("parsing is deterministic and sentence split keeps every character of the prose", () => {
    expect(parseMandate(fixture)).toEqual(parseMandate(fixture));
    const prose = "첫 문장이다. 둘째 문장이다! Third sentence? 마지막.";
    expect(sentences(prose)).toEqual(["첫 문장이다.", "둘째 문장이다!", "Third sentence?", "마지막."]);
  });

  test("passages feed scan as candidates whose ids are the state paths", () => {
    const state = parseMandate(fixture);
    const candidates = passages(state).map((p) => ({ id: p.path, domain: p.domain, description: p.text }));
    const s = applyScan(start(fixture), candidates, { kept: [{ id: "constraints[3]", score: 3 }] });
    expect(s.uncertainties).toHaveLength(1);
    expect(s.uncertainties[0].domain).toBe("constraints");
    expect(s.uncertainties[0].description).toBe(state.constraints[3]);
  });
});
