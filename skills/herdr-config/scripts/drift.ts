/**
 * Protocol digest and drift report for one run.
 *
 * A run's three protocol documents are pinned to the digests this project has
 * shipped, so "is this run's protocol the installed text?" is answerable without
 * opening either file. The verdict comes from the same acceptance function the
 * run loader uses — this script never re-decides acceptance — and every outcome,
 * including a conflict, is printed rather than thrown, because the report is the
 * point.
 *
 *   bun skills/herdr-config/scripts/drift.ts <run-path>
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { PROTOCOL_TEMPLATE_PATH } from "../../../io.github.edgar-min.herdr-delegator/extensions/lib/config";
import { acceptProtocolDocument } from "../../../io.github.edgar-min.herdr-delegator/extensions/lib/templates";
import { sha256 } from "../../../io.github.edgar-min.herdr-delegator/extensions/lib/contracts";

const PROTOCOL_DOCUMENTS = ["protocol.md", "protocol-orch.md", "protocol-worker.md"] as const;
const ABSENT = "—";

const runPath = process.argv[2];
if (!runPath || runPath.startsWith("-")) {
  console.error("usage: bun skills/herdr-config/scripts/drift.ts <run-path>");
  process.exit(2);
}

const templateDir = path.dirname(PROTOCOL_TEMPLATE_PATH);
const rows: string[] = [];

for (const name of PROTOCOL_DOCUMENTS) {
  let runDigest = ABSENT;
  let installedDigest = ABSENT;
  let verdict: string;
  try {
    const [existing, template] = await Promise.all([readFile(path.join(runPath, name)), readFile(path.join(templateDir, name))]);
    runDigest = sha256(existing);
    installedDigest = sha256(template);
    const acceptance = acceptProtocolDocument(name, existing, template);
    verdict = acceptance.current ? "current" : `historical (${acceptance.warning ?? ""})`;
  } catch (error: unknown) {
    verdict = `unknown (${error instanceof Error ? error.message : String(error)})`;
  }
  rows.push(`| ${name} | ${runDigest} | ${installedDigest} | ${verdict.replace(/\|/g, "/").replace(/\s+/g, " ").trim()} |`);
}

console.log("| document | run sha256 | installed sha256 | verdict |");
console.log("| --- | --- | --- | --- |");
for (const row of rows) console.log(row);
