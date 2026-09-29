// Turns a finished real study report into the web app's replay fixture, so the
// no-backend demo replays a real run instead of the prepared one. Refuses a
// report that fails the demo acceptance test or did not use the expected lab
// image. Also keeps the report itself as the labelled prior-run report.
//
//   node apps/api/scripts/record-fixture.mjs artifacts/rehearsals/<time>/<runId>.json
//   (--allow-stand-in --out-dir <dir> writes a stand-in run elsewhere, for testing)
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { RunEventSchema } from "@dejaml/contracts";

import { checkDemoAcceptance, loadCases } from "../dist/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "allow-stand-in": { type: "boolean", default: false }, "out-dir": { type: "string" } },
});
const [reportPath] = positionals;
if (!reportPath) throw new Error("usage: record-fixture.mjs <report.json>");
const outDir = values["out-dir"] ? resolve(values["out-dir"]) : repoRoot;
if (values["allow-stand-in"] && outDir === repoRoot) {
  throw new Error("--allow-stand-in needs --out-dir outside the repository fixtures");
}

const lock = JSON.parse(await readFile(join(repoRoot, "lab-images/python-cpu/image-lock.json"), "utf8"));
const expectedImageId = process.env.DEJAML_EXPECTED_IMAGE_ID ?? lock.verifiedImageId;
const [curated] = await loadCases(repoRoot);
const report = JSON.parse(await readFile(reportPath, "utf8"));
const acceptance = checkDemoAcceptance(report, curated, { expectedImageId });
if (!acceptance.passed) {
  const failed = acceptance.checks.filter((check) => !check.passed);
  throw new Error(`the report fails the demo acceptance test: ${JSON.stringify(failed, null, 2)}`);
}
if (!acceptance.realRun && !values["allow-stand-in"]) {
  throw new Error(`the report's lab image ${report.lab?.imageId} is not the expected ${expectedImageId}`);
}

const events = RunEventSchema.array().parse(report.events);
const meta = {
  schemaVersion: 1,
  source: "recorded",
  runId: report.runId,
  recordedAt: report.finishedAt,
  imageId: report.lab.imageId,
  observedValue: report.assessment.observedValue,
  verdict: report.assessment.verdict,
  note: "Events recorded from a real study by apps/api/scripts/record-fixture.mjs. The web app replays them when no backend is connected and labels them as a recorded replay.",
};
const eventsDir = join(outDir, "fixtures/events");
const reportsDir = join(outDir, "fixtures/reports");
await mkdir(eventsDir, { recursive: true });
await mkdir(reportsDir, { recursive: true });
await writeFile(join(eventsDir, "urban-land-cover-success.json"), `${JSON.stringify(events, null, 2)}\n`);
await writeFile(join(eventsDir, "urban-land-cover-success.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
await copyFile(reportPath, join(reportsDir, "urban-land-cover-prior-run.json"));
process.stdout.write(`${JSON.stringify({ ...meta, events: events.length, outDir }, null, 2)}\n`);
