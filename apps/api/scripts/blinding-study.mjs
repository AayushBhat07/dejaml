// Blinding study runner.
//
// Runs every paper × arm × replicate of a matrix through a running DéjàML API,
// one study at a time, and appends one results row per finished study to
// <out>/results.jsonl, with the full report in <out>/reports/. It is
// resumable: a run whose key is already in results.jsonl is skipped, so the
// script can be stopped and started again.
//
// The API must be started with DEJAML_RESEARCH_CONDITIONS=1 (and its usual
// provider key in its own environment). This script never reads, sends or
// prints a key.
//
// Usage:
//   node apps/api/scripts/blinding-study.mjs <matrix.json> <out-dir> [--dry-run]
//
//   acceptance/blinding/pilot-matrix.json   the 90-run pilot
//
// Environment (all optional):
//   DEJAML_ACCEPT_API       API base (default http://127.0.0.1:8787/api)
//   DEJAML_ACCEPT_PROVIDER  provider id from /api/config (default: the first listed)
//   DEJAML_ACCEPT_MODEL     model from that provider (default: its first)
//
// Exit codes: 0 every run finished, 1 a run could not start, 2 usage,
// 4 stopped early because too many runs failed for harness reasons.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { expandMatrix, harnessFailure, matrixProblems, resultRow, runKey, uploadFields } from "./blinding-lib.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [matrixPath, outArgument] = args.filter((item) => !item.startsWith("--"));
if (!matrixPath || !outArgument) {
  console.error("usage: node apps/api/scripts/blinding-study.mjs <matrix.json> <out-dir> [--dry-run]");
  process.exit(2);
}
const matrix = JSON.parse(await readFile(resolve(matrixPath), "utf8"));
const problems = matrixProblems(matrix);
if (problems.length) {
  console.error(`The matrix is not valid:\n- ${problems.join("\n- ")}`);
  process.exit(2);
}
const matrixDir = dirname(resolve(matrixPath));
const papers = new Map();
for (const paper of matrix.papers) {
  const path = resolve(matrixDir, paper.pdf.replace(/^~(?=\/)/u, process.env.HOME ?? "~"));
  let data;
  try {
    data = await readFile(path);
  } catch {
    console.error(`${paper.id}: the paper PDF is not at ${path}.`);
    process.exit(2);
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (paper.sha256 && paper.sha256 !== sha256) {
    console.error(`${paper.id}: the PDF's SHA-256 ${sha256} does not match the matrix's ${paper.sha256}.`);
    process.exit(2);
  }
  papers.set(paper.id, { ...paper, path, data });
}

const out = resolve(outArgument);
const resultsPath = join(out, "results.jsonl");
await mkdir(join(out, "reports"), { recursive: true });
const done = new Set();
try {
  for (const line of (await readFile(resultsPath, "utf8")).split("\n")) if (line.trim()) done.add(JSON.parse(line).key);
} catch {
  // No results yet.
}
const rows = expandMatrix(matrix);
const pending = rows.filter((row) => !done.has(runKey(row)));
console.log(`${rows.length} runs in the matrix, ${done.size} already finished, ${pending.length} to run`);
await writeFile(join(out, "plan.json"), `${JSON.stringify({ matrix: { ...matrix }, order: rows.map(runKey) }, null, 2)}\n`);
if (dryRun) {
  for (const row of pending) console.log(`  ${runKey(row)} (decoy ${row.decoyDirection})`);
  process.exit(0);
}

const api = (process.env.DEJAML_ACCEPT_API ?? "http://127.0.0.1:8787/api").replace(/\/$/u, "");
let config;
try {
  config = await (await fetch(`${api}/config`)).json();
} catch (error) {
  console.error(`The API at ${api} is not reachable (${error instanceof Error ? error.message : String(error)}).`);
  process.exit(2);
}
const provider = config.providers?.find((item) => item.id === (process.env.DEJAML_ACCEPT_PROVIDER ?? config.providers[0]?.id));
if (!provider) {
  console.error("The API lists no model provider; put a key in the API's own environment and restart it.");
  process.exit(2);
}
const model = process.env.DEJAML_ACCEPT_MODEL ?? provider.models[0];
console.log(`provider ${provider.id}/${model}`);

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function start(paper, row) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const form = new FormData();
    form.append("paper", new Blob([paper.data], { type: "application/pdf" }), basename(paper.path));
    form.append("providerId", provider.id);
    form.append("modelName", model);
    for (const [name, value] of Object.entries(uploadFields(paper, row))) form.append(name, value);
    const response = await fetch(`${api}/runs`, { method: "POST", body: form });
    if (response.ok) return (await response.json()).runId;
    const text = await response.text();
    // One study at a time: wait for the server to be free.
    if (response.status === 409) {
      await sleep(10_000);
      continue;
    }
    throw new Error(`the API refused the study: ${response.status} ${text}`);
  }
  throw new Error("the API stayed busy for 20 minutes");
}

async function waitForReport(runId) {
  for (;;) {
    const response = await fetch(`${api}/runs/${runId}/report`);
    if (response.ok) {
      const report = await response.json();
      if (report.finishedAt) return report;
    }
    await sleep(5_000);
  }
}

let finished = 0;
let harness = 0;
for (const row of pending) {
  const paper = papers.get(row.paperId);
  const label = runKey(row);
  const startedAt = Date.now();
  let runId;
  try {
    runId = await start(paper, row);
  } catch (error) {
    console.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(`${new Date().toISOString().slice(11, 19)} ${label} started as ${runId}`);
  const report = await waitForReport(runId);
  await writeFile(join(out, "reports", `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const result = resultRow(row, report);
  await appendFile(resultsPath, `${JSON.stringify(result)}\n`);
  finished += 1;
  if (harnessFailure(result)) harness += 1;
  console.log(
    `${new Date().toISOString().slice(11, 19)} ${label} ${result.status ?? result.runStatus}: observed ${result.observedValue ?? "none"}, control ${
      result.controlValue ?? "none"
    }, ${Math.round((Date.now() - startedAt) / 1000)} s, $${result.costUsd?.toFixed(3) ?? "?"}`,
  );
  // Stop and look if the harness, not the papers, is failing.
  if (finished === 20 && harness / finished > 0.2) {
    console.error(`Stopped: ${harness} of the first ${finished} runs failed for harness reasons. Fix the cause, then run again to resume.`);
    process.exit(4);
  }
}
console.log(`All ${rows.length} runs finished. Summarize with: node apps/api/scripts/blinding-analysis.mjs ${resultsPath}`);
