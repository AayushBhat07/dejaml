// Rehearses the demo against a running API: uploads the curated paper several
// times, waits for each study, downloads its report, and applies the demo
// acceptance test. A run only counts as real when its lab image is the
// expected one (the image lock, or DEJAML_EXPECTED_IMAGE_ID).
//
//   node apps/api/scripts/rehearse.mjs --paper paper.pdf [--runs 3]
//     [--base http://127.0.0.1:8787] [--out artifacts/rehearsals] [--allow-stand-in]
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { checkDemoAcceptance, loadCases } from "../dist/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({
  options: {
    paper: { type: "string" },
    runs: { type: "string", default: "3" },
    base: { type: "string", default: "http://127.0.0.1:8787" },
    out: { type: "string", default: join(repoRoot, "artifacts/rehearsals") },
    "allow-stand-in": { type: "boolean", default: false },
  },
});
if (!values.paper) throw new Error("--paper is required");

const lock = JSON.parse(await readFile(join(repoRoot, "lab-images/python-cpu/image-lock.json"), "utf8"));
const expectedImageId = process.env.DEJAML_EXPECTED_IMAGE_ID ?? lock.verifiedImageId;
const [curated] = await loadCases(repoRoot);
const paper = await readFile(values.paper);
const outDir = resolve(values.out, new Date().toISOString().replaceAll(":", "-"));
await mkdir(outDir, { recursive: true });
const TERMINAL = new Set(["completed", "inconclusive", "cancelled", "timed_out", "failed"]);

function labContainers() {
  const result = spawnSync("docker", ["ps", "--all", "--quiet", "--filter", "label=dejaml.lab"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split("\n").filter(Boolean).length : null;
}

async function rehearse(index) {
  const started = Date.now();
  const form = new FormData();
  form.append("paper", new Blob([paper]), basename(values.paper));
  const created = await fetch(`${values.base}/api/runs`, { method: "POST", body: form });
  if (created.status !== 202) throw new Error(`upload refused: ${created.status} ${await created.text()}`);
  const { runId } = await created.json();
  for (;;) {
    const run = await (await fetch(`${values.base}/api/runs/${runId}`)).json();
    if (TERMINAL.has(run.status)) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  let response;
  for (let tries = 0; tries < 100; tries += 1) {
    response = await fetch(`${values.base}/api/runs/${runId}/report`);
    if (response.status === 200) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const downloadable = response.status === 200 && (response.headers.get("content-disposition") ?? "").includes("attachment");
  const report = await response.json();
  await writeFile(join(outDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const acceptance = checkDemoAcceptance(report, curated, { expectedImageId });
  const remaining = labContainers();
  const passed = acceptance.passed && downloadable && (remaining === null || remaining === 0);
  return {
    rehearsal: index,
    runId,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    status: report.status,
    observed: report.assessment?.observedValue ?? null,
    verdict: report.assessment?.verdict ?? null,
    realRun: acceptance.realRun,
    downloadable,
    remainingLabContainers: remaining,
    passed,
    failedChecks: acceptance.checks.filter((check) => !check.passed),
  };
}

const results = [];
for (let index = 1; index <= Number(values.runs); index += 1) {
  const result = await rehearse(index);
  results.push(result);
  process.stdout.write(
    `rehearsal ${index}: ${result.passed ? "PASS" : "FAIL"} ${result.status} ${result.observed ?? "-"} ${result.verdict ?? "-"} ` +
      `${result.seconds}s ${result.realRun ? "real" : "NOT the expected image"}` +
      `${result.failedChecks.length ? ` failed: ${result.failedChecks.map((check) => check.name).join(", ")}` : ""}\n`,
  );
}
const summary = {
  base: values.base,
  expectedImageId,
  rehearsals: results.length,
  passed: results.filter((result) => result.passed).length,
  allReal: results.every((result) => result.realRun),
  results,
};
await writeFile(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`reports and summary: ${outDir}\n`);
const ok = summary.passed === summary.rehearsals && (summary.allReal || values["allow-stand-in"]);
process.exit(ok ? 0 : 1);
