// The mandate check as the server runs it: `herdr_track check` reports lines and
// a verdict, `herdr_track open` refuses a FAILED verdict, and the entry.binds
// rules are decided by the schema and the deterministic gate together.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkMandate, PACKAGE_ROOT, readWorkerContract, type CheckLine } from "../mcp/mandate-gate";
import type { AskOptions, ChoiceQuestion } from "../mcp/jev/client";
import { herdrTrackSchema, type Mandate } from "../mcp/contracts";
import { CompositeTools } from "../mcp/tools";
import type { HerdrAdapter } from "../mcp/herdr-adapter";
import { sha256 } from "../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";

const example = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "skills/herdr-create/references/mandate.example.json"), "utf8")) as Mandate;
const schema = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "skills/herdr-create/references/mandate.schema.json"), "utf8")) as Record<string, unknown>;
const validate: ValidateFunction = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const envKeys = ["TYPESAFE_API_KEY", "JEV_API_KEY", "PI_CODING_AGENT_DIR"] as const;
let savedEnv: (string | undefined)[];
let agentDir: string;

/** A minimal mandate whose deterministic half passes; each test bends one field. */
function draft(overrides: Partial<Mandate> = {}): Mandate {
  return {
    mandate_version: 2,
    purpose: "Settle where the opening contract's rules live.",
    language: "en",
    entry: {
      protocol: "sketch",
      utterance: "Make variants of the opening contract for the bound open item.",
      reason: "A form must be made that the user would recognize on sight.",
    },
    settled: [{ decision: "The creator never becomes the ORCH.", source: "user, creator conversation 2026-09-23", reason: "unstated" }],
    substrate: ["skills/herdr-create/SKILL.md is the current creator contract."],
    open: [{ item: "Where should the first-turn rules live?", candidates: ["In a run document", "In the role skill"] }],
    done_when: ["plan.md records the user's recognized version as a D-numbered entry."],
    forbidden: ["Do not modify the main branch in this track."],
    budget: { tokens: 500000, minutes: 60, doorbell_policy: "notify" },
    ...overrides,
  } as Mandate;
}

function line(lines: CheckLine[], rule: string): CheckLine {
  const found = lines.find((candidate) => candidate.rule === rule);
  if (!found) throw new Error(`no ${rule} line in ${lines.map((candidate) => candidate.rule).join(", ")}`);
  return found;
}

/** A judge that answers every question with the named choice, or the first criterion. */
function fakeJudge(choices: Record<string, string>): NonNullable<AskOptions["fetchImpl"]> {
  return (async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { questions: Record<string, ChoiceQuestion> };
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const keys = Object.keys(question.criteria);
      const choice = choices[id] ?? keys[0];
      const probabilities = Object.fromEntries(keys.map((key) => [key, keys.length === 1 ? 1 : key === choice ? 0.9 : 0.1 / (keys.length - 1)]));
      return [id, { type: "choice", choice, confidence: 0.9, probabilities }];
    }));
    return Response.json({ model: "offline-jev", answers });
  }) as NonNullable<AskOptions["fetchImpl"]>;
}

beforeEach(async () => {
  savedEnv = envKeys.map((key) => process.env[key]);
  agentDir = await mkdtemp(path.join(tmpdir(), "mandate-check-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_API_KEY;
});

afterEach(async () => {
  envKeys.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; });
  await rm(agentDir, { recursive: true, force: true });
});

describe("herdr_track check", () => {
  test("passes the shipped example mandate and reports one line per rule", async () => {
    const input = herdrTrackSchema.parse({ action: "check", track_id: "t1", run_id: "r1", cwd: PACKAGE_ROOT, mandate: example });
    const result = await new CompositeTools({} as HerdrAdapter).track(input);
    expect(result.ok).toBe(true);
    expect(result.effect).toBe("none");
    const data = result.data;
    if (!data || typeof data !== "object" || !("lines" in data) || !("verdict" in data)) throw new Error("no check data");
    const lines = data.lines as CheckLine[];
    expect(data.verdict).toBe("PASSED");
    expect(lines.map((entry) => entry.rule)).toEqual([
      "contract", "worker-contract", "orch-skill", "schema", "protocol-available", "gate", "one-unit", "done-when-distinct", "settled-reason", "substrate-path", "semantic",
    ]);
    expect(lines.every((entry) => entry.ok)).toBe(true);
    expect(line(lines, "semantic").detail).toBe("skipped (no Jev key)");
  });

  test("reports a FAILED verdict as data rather than as an error", async () => {
    const mandate = draft({ done_when: ["Settle where the opening contract's rules live."] });
    const result = await new CompositeTools({} as HerdrAdapter).track(
      herdrTrackSchema.parse({ action: "check", track_id: "t1", run_id: "r1", cwd: PACKAGE_ROOT, mandate }),
    );
    expect(result.ok).toBe(true);
    const data = result.data;
    if (!data || typeof data !== "object" || !("lines" in data)) throw new Error("no check data");
    expect(line(data.lines as CheckLine[], "done-when-distinct").ok).toBe(false);
    expect(data).toMatchObject({ verdict: "FAILED" });
  });
});

describe("the worker-contract line", () => {
  /** A package root carrying only the two pinned documents the line reads. */
  async function fixtureRoot(pins: Record<string, string>, documents: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "worker-contract-"));
    await mkdir(path.join(root, "protocols"));
    for (const [name, body] of Object.entries(documents)) await writeFile(path.join(root, "protocols", name), body);
    await writeFile(path.join(root, "protocols", "CONTRACT.json"), `${JSON.stringify(pins, null, 2)}\n`);
    return root;
  }

  test("passes on a matching pin and fails on a mismatched one", async () => {
    const body = "# Worker contract\n";
    const matching = await fixtureRoot({ "worker.md": sha256(Buffer.from(body)) }, { "worker.md": body });
    expect(readWorkerContract(matching)).toEqual({ ok: true, rule: "worker-contract", detail: `sha256 ${sha256(Buffer.from(body))}` });

    const drifted = await fixtureRoot({ "worker.md": "d".repeat(64) }, { "worker.md": body });
    const failing = readWorkerContract(drifted);
    expect(failing.ok).toBe(false);
    expect(failing.detail).toContain("d".repeat(64));
    expect(failing.detail).toContain(path.join(drifted, "protocols", "worker.md"));
  });

  test("fails a pinned document that cannot be read and claims nothing when unpinned", async () => {
    const missing = await fixtureRoot({ "worker.md": "e".repeat(64) }, {});
    expect(readWorkerContract(missing).ok).toBe(false);
    expect(readWorkerContract(missing).detail).toContain("is not readable");

    const unpinned = await fixtureRoot({ "contract.md": "f".repeat(64) }, { "contract.md": "# Authority\n" });
    const line = readWorkerContract(unpinned);
    expect(line.ok).toBe(true);
    expect(line.detail).toContain("not pinned");
  });
});

describe("herdr_track open", () => {
  test("refuses a mandate whose done_when restates purpose, naming the failing line", async () => {
    const mandate = draft({ done_when: ["Settle where the opening contract's rules live."] });
    const result = await new CompositeTools({} as HerdrAdapter).track(
      herdrTrackSchema.parse({ action: "open", track_id: "t1", run_id: "r1", cwd: PACKAGE_ROOT, mandate }),
    );
    expect(result.ok).toBe(false);
    expect(result.effect).toBe("none");
    expect(result.error?.code).toBe("mandate_check_failed");
    expect(result.error?.phase).toBe("validate");
    expect(result.error?.message).toContain("done-when-distinct");
    expect(result.error?.message).toContain("restate purpose verbatim");
  });
});

describe("entry.binds", () => {
  test("the schema takes an open coordinate and refuses anything else", () => {
    expect(validate({ ...example, entry: { ...example.entry, binds: ["open[0]"] } })).toBe(true);
    expect(validate({ ...example, entry: { ...example.entry, binds: ["substrate[0]"] } })).toBe(false);
    expect(validate({ ...example, entry: { ...example.entry, binds: [] } })).toBe(false);
    const { binds: _binds, ...unbound } = example.entry;
    expect(validate({ ...example, entry: { ...unbound, protocol: "preview" } })).toBe(false);
    expect(validate({ ...example, entry: { ...unbound, protocol: "preview", binds: ["open[0]"] } })).toBe(true);
  });

  test("the gate resolves each bound index and refuses a thin preview candidate field", async () => {
    const thin = draft({
      entry: { protocol: "preview", utterance: "Compare the candidates of the bound open item.", reason: "A direction commitment is imminent.", binds: ["open[0]"] },
      open: [{ item: "Which storage layout?", candidates: ["One file"] }],
    });
    const thinResult = await checkMandate(thin, { cwd: PACKAGE_ROOT });
    expect(line(thinResult.lines, "gate")).toMatchObject({ ok: false });
    expect(line(thinResult.lines, "gate").detail).toContain("open[0] carries 1");

    const missing = draft({ entry: { ...draft().entry, binds: ["open[3]"] } });
    expect(line((await checkMandate(missing, { cwd: PACKAGE_ROOT })).lines, "gate").detail).toContain("open[] does not carry");

    const bound = draft({ entry: { ...draft().entry, binds: ["open[0]"] } });
    expect(line((await checkMandate(bound, { cwd: PACKAGE_ROOT })).lines, "gate")).toMatchObject({ ok: true });
  });

  test("an open coordinate inside the utterance is a one-unit defect", async () => {
    const mandate = draft({ entry: { ...draft().entry, utterance: "Make variants for open[0] and nothing else.", binds: ["open[0]"] } });
    const defect = line((await checkMandate(mandate, { cwd: PACKAGE_ROOT })).lines, "one-unit");
    expect(defect.ok).toBe(false);
    expect(defect.detail).toContain("entry.utterance names a bound open item by coordinate");
  });
});

describe("the judged half", () => {
  test("a judge routing to not-track-worthy fails the routing line", async () => {
    process.env.TYPESAFE_API_KEY = "offline-fixture";
    const result = await checkMandate(draft(), { cwd: PACKAGE_ROOT, ask: { fetchImpl: fakeJudge({ routing: "not-track-worthy" }) } });
    const routing = line(result.lines, "routing");
    expect(routing.ok).toBe(false);
    expect(routing.detail).toContain("judge routes to not-track-worthy, the mandate names sketch");
    expect(result.verdict).toBe("FAILED");
  });

  test("a judge agreeing with the creator leaves the verdict passing", async () => {
    process.env.TYPESAFE_API_KEY = "offline-fixture";
    const result = await checkMandate(draft(), { cwd: PACKAGE_ROOT, ask: { fetchImpl: fakeJudge({ routing: "sketch" }) } });
    expect(line(result.lines, "routing").ok).toBe(true);
    expect(result.verdict).toBe("PASSED");
  });
});
