// The v6 opening contract: a run carries only mandate.json, run.json and a2a/,
// and every rule a born session works by lives in a role skill it is pointed at.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PACKAGE_ROOT, RUN_CHANNELS, ROLE_SKILL_NAMES, loadDelegatorConfig, readRunManifest, retiredConfigKeyWarning, roleSkillDigests } from "../io.github.edgar-min.herdr-delegator/extensions/lib/config";
import { sha256 } from "../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";
import { initializeRun, orchestratorFirstPrompt } from "../io.github.edgar-min.herdr-delegator/extensions/lib/track";
import { assignmentDispatchPointer } from "../mcp/tools";

async function fixtureSkills(bodies: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-skills-"));
  for (const [name, body] of Object.entries(bodies)) {
    await mkdir(path.join(root, "skills", name), { recursive: true });
    await writeFile(path.join(root, "skills", name, "SKILL.md"), body);
  }
  return root;
}

/** A project + storage root whose layered configuration this process resolves. */
async function fixtureProject(layer: Record<string, unknown>): Promise<{ cwd: string; storageRoot: string }> {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "herdr-cwd-")));
  const storageRoot = await realpath(await mkdtemp(path.join(tmpdir(), "herdr-store-")));
  await mkdir(path.join(cwd, ".omp"), { recursive: true });
  await writeFile(
    path.join(cwd, ".omp", "herdr-delegator.json"),
    `${JSON.stringify({ version: 1, storage: { root: storageRoot }, ...layer }, null, 2)}\n`,
  );
  // The user layer must not leak into a fixture assertion.
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(path.join(tmpdir(), "herdr-user-"));
  return { cwd, storageRoot };
}

describe("orchestratorFirstPrompt", () => {
  test("names the mandate and the ORCH skill and nothing else", () => {
    expect(orchestratorFirstPrompt("t1", "r1", "/runs/t1/r1/mandate.json")).toBe(
      "You are the ORCH of run t1/r1. Your mandate is /runs/t1/r1/mandate.json. Read skill://herdr-orch and carry out its routing before anything else.",
    );
  });

  test("appends the inbound clause when a channel document was observed", () => {
    const prompt = orchestratorFirstPrompt("t1", "r1", "/runs/t1/r1/mandate.json", {
      entries: [{ path: "/runs/t0/r1/a2a/orch-to-t1_r1.md", from_track_id: "t0", from_run_id: "r1", sha256: "a".repeat(64), bytes: 12, lines: 3, entry_line: 2 }],
      truncated: false,
      warnings: [],
    });
    expect(prompt.startsWith(
      "You are the ORCH of run t1/r1. Your mandate is /runs/t1/r1/mandate.json. Read skill://herdr-orch and carry out its routing before anything else.",
    )).toBe(true);
    expect(prompt).toContain("Another run has addressed an inter-run channel document to this run");
    expect(prompt).toContain("/runs/t0/r1/a2a/orch-to-t1_r1.md");
  });

  test("names no protocol or guidance document", () => {
    const prompt = orchestratorFirstPrompt("t1", "r1", "/runs/t1/r1/mandate.json");
    for (const removed of ["protocol.md", "protocol-orch.md", "protocol-worker.md", "guidance.md"]) {
      expect(prompt).not.toContain(removed);
    }
  });
});

describe("assignmentDispatchPointer", () => {
  const base = {
    assignmentId: "A-001",
    coordinate: "t1/r1/A-001",
    responsibilityKey: "server-opening-flow",
    artifactPath: "/runs/t1/r1/a2a/assignments/A-001.md",
    instructionsSha256: "b".repeat(64),
    reportPath: "/runs/t1/r1/a2a/w2-report.md",
  };

  test("routes a task worker through its profile skill, with no bare worker skill left to read", () => {
    const pointer = assignmentDispatchPointer({ ...base, profile: "task" });
    expect(pointer).toContain("skill://herdr-worker-task");
    expect(pointer).not.toContain("skill://herdr-worker ");
    expect(pointer).not.toContain("skill://herdr-worker.");
    expect(pointer).toContain("instructions /runs/t1/r1/a2a/assignments/A-001.md sha256=");
    expect(pointer).toContain("Append [Assignment Completion: A-001] to /runs/t1/r1/a2a/w2-report.md and remain idle.");
    expect(pointer).toContain('herdr_message {action:"wake_orch"}');
    expect(pointer).not.toContain("protocol-worker.md");
    expect(pointer).not.toContain("guidance");
  });

  test("resolves an unreadable profile from frontmatter rather than choosing another skill", () => {
    const pointer = assignmentDispatchPointer(base);
    expect(pointer).toContain("profile from the assignment frontmatter");
    expect(pointer).toContain("skill://herdr-worker-<profile>");
    expect(pointer).not.toContain("skill://herdr-worker ");
    expect(pointer).not.toContain("skill://herdr-worker.");
  });
});

describe("roleSkillDigests", () => {
  test("hashes the exact installed SKILL.md bytes of the ORCH and every profile skill", async () => {
    const bodies = {
      "herdr-orch": "# herdr-orch\n\nrouting table\n",
      "herdr-worker-default": "# default profile\n",
      "herdr-worker-slow": "# slow profile\n",
      "herdr-worker-task": "# task profile\n",
    };
    const root = await fixtureSkills(bodies);
    const digests = await roleSkillDigests(root);
    expect(Object.keys(digests).sort()).toEqual(["herdr-orch", "herdr-worker-default", "herdr-worker-slow", "herdr-worker-task"]);
    expect(digests).toEqual(Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, sha256(Buffer.from(body))])));
  });

  test("pins no retired common worker skill", async () => {
    expect([...ROLE_SKILL_NAMES]).not.toContain("herdr-worker");
    const root = await fixtureSkills({
      "herdr-orch": "# herdr-orch\n",
      "herdr-worker": "# retired\n",
      "herdr-worker-default": "# default profile\n",
      "herdr-worker-slow": "# slow profile\n",
      "herdr-worker-task": "# task profile\n",
    });
    expect(Object.keys(await roleSkillDigests(root))).not.toContain("herdr-worker");
  });

  test("refuses a missing profile skill directory by name", async () => {
    const root = await fixtureSkills({
      "herdr-orch": "# herdr-orch\n",
      "herdr-worker-default": "# default profile\n",
      "herdr-worker-slow": "# slow profile\n",
    });
    const missing = path.join(root, "skills", "herdr-worker-task", "SKILL.md");
    expect(roleSkillDigests(root)).rejects.toThrow(missing);
  });
});

describe("initializeRun", () => {
  test("writes only run.json and a2a/, with the run's channels and skill digests", async () => {
    const { cwd, storageRoot } = await fixtureProject({});
    const result = await initializeRun({ operation: "init_run", track_id: "t1", run_id: "r1", cwd });
    const runPath = path.join(storageRoot, "t1", "r1");
    expect(result.ok).toBe(true);
    expect((await readdir(runPath)).sort()).toEqual(["a2a", "run.json"]);

    const manifest = await readRunManifest(runPath);
    expect(manifest.channels).toEqual(RUN_CHANNELS);
    expect(manifest.channels).toEqual({
      assignments: "a2a/assignments/<id>.md",
      reports: "a2a/<lane>-report.md",
      inter_run: "a2a/orch-to-<track>_<run>.md",
    });
    expect(Object.keys(manifest.skills ?? {}).sort()).toEqual([...ROLE_SKILL_NAMES].sort());
    for (const name of ROLE_SKILL_NAMES) {
      expect(manifest.skills?.[name]).toBe(sha256(await readFile(path.join(PACKAGE_ROOT, "skills", name, "SKILL.md"))));
    }
  });

  test("reports a retired configuration key instead of failing the run", async () => {
    const { cwd, storageRoot } = await fixtureProject({
      worker_profiles: { task: { role: "@default", directive: "Verify every edit." } },
    });
    const result = await initializeRun({ operation: "init_run", track_id: "t2", run_id: "r1", cwd });
    expect(result.observation?.config_warning).toContain("worker_profiles.task.directive");
    expect((await readdir(path.join(storageRoot, "t2", "r1"))).sort()).toEqual(["a2a", "run.json"]);
  });
});

describe("loadDelegatorConfig", () => {
  test("warns on each retired key and still resolves the layer", async () => {
    const { cwd } = await fixtureProject({
      orchestrator: { role: "@default", directive: "Plan first." },
      worker_profiles: { slow: { role: "@default", intent: "Adversarial review.", guidance: "legacy" } },
      skill_routing: { rules: [], skills: { "skill-retro": { intent: "Retro." } } },
    });
    const { config, warnings } = await loadDelegatorConfig(undefined, cwd);
    expect(config.orchestrator).toEqual({ role: "@default", thinking: "inherit" });
    expect(config.worker_profiles.slow).toEqual({ role: "@default", thinking: "inherit" });
    expect(Object.hasOwn(config, "skill_routing")).toBe(false);
    const layerPath = path.join(cwd, ".omp", "herdr-delegator.json");
    for (const coordinate of ["orchestrator.directive", "worker_profiles.slow.intent", "worker_profiles.slow.guidance", "skill_routing"]) {
      expect(warnings).toContain(retiredConfigKeyWarning(`${layerPath}.${coordinate}`));
    }
  });
});
