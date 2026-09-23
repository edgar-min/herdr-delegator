// The public data contracts must describe the build that ships with them: a
// run.json this build's open writes validates, one missing the fields it now
// carries does not, and the shipped configuration example validates against the
// configuration schema.
import { describe, expect, test } from "bun:test";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeRun } from "../io.github.edgar-min.herdr-delegator/extensions/lib/track";

const ajv = addFormats(new Ajv2020({ strict: false }));
async function validator(schemaPath: string): Promise<ValidateFunction> {
  return ajv.getSchema(`file:${schemaPath}`) ?? ajv.compile({ ...JSON.parse(await readFile(schemaPath, "utf8")), $id: `file:${schemaPath}` });
}

async function openedRunManifest(): Promise<Record<string, unknown>> {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "herdr-cwd-")));
  const storageRoot = await realpath(await mkdtemp(path.join(tmpdir(), "herdr-store-")));
  await mkdir(path.join(cwd, ".omp"), { recursive: true });
  await writeFile(
    path.join(cwd, ".omp", "herdr-delegator.json"),
    `${JSON.stringify({ version: 1, storage: { root: storageRoot } }, null, 2)}\n`,
  );
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(path.join(tmpdir(), "herdr-user-"));
  await initializeRun({ operation: "init_run", track_id: "t1", run_id: "r1", cwd });
  return JSON.parse(await readFile(path.join(storageRoot, "t1", "r1", "run.json"), "utf8"));
}

describe("run.schema.json", () => {
  test("validates the run.json this build writes and rejects one missing channels or skills", async () => {
    const validate = await validator("run.schema.json");
    const manifest = await openedRunManifest();
    expect(validate(manifest)).toBe(true);

    const { channels: _channels, ...withoutChannels } = manifest;
    expect(validate(withoutChannels)).toBe(false);
    const { skills: _skills, ...withoutSkills } = manifest;
    expect(validate(withoutSkills)).toBe(false);
    expect(validate({ ...manifest, skills: { "herdr-orch": "not-a-digest", "herdr-worker": "x" } })).toBe(false);
    expect(validate({ ...manifest, channels: { ...(manifest.channels as object), assignments: "a2a/<id>.md" } })).toBe(false);
  });
});

describe("config.schema.json", () => {
  test("validates the shipped example", async () => {
    const validate = await validator("config.schema.json");
    expect(validate(JSON.parse(await readFile("config.example.json", "utf8")))).toBe(true);
  });

  test("rejects the retired guidance keys", async () => {
    const validate = await validator("config.schema.json");
    const base = { version: 1, storage: { root: "/tmp/runs" } };
    expect(validate({ ...base, orchestrator: { role: "@default", directive: "Plan first." } })).toBe(false);
    expect(validate({ ...base, worker_profiles: { task: { role: "@default", intent: "x" } } })).toBe(false);
    expect(validate({ ...base, worker_profiles: { task: { role: "@default", directive: "x" } } })).toBe(false);
    expect(validate({ ...base, worker_profiles: { task: { role: "@default", guidance: "x" } } })).toBe(false);
    expect(validate({ ...base, skill_routing: { rules: [], skills: { sip: { intent: "x" } } } })).toBe(false);
  });
});
