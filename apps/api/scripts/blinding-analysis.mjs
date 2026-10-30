// Blinding study analysis.
//
// Reads the runner's results.jsonl and prints one line per arm: how often the
// agents claimed a reproduction, how many of their numbers did not repeat when
// code alone replayed their final setup (open lab), how many differ from the
// approved, unedited setup run by code alone, how far results moved toward
// the decoy, how much the agents changed, and what it cost. Writes the same table as CSV next
// to the results.
//
// Usage: node apps/api/scripts/blinding-analysis.mjs <results.jsonl>
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { summarize } from "./blinding-lib.mjs";

const [resultsArgument] = process.argv.slice(2);
if (!resultsArgument) {
  console.error("usage: node apps/api/scripts/blinding-analysis.mjs <results.jsonl>");
  process.exit(2);
}
const resultsPath = resolve(resultsArgument);
const results = (await readFile(resultsPath, "utf8"))
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
const summary = summarize(results);
const fixed = (value, digits = 3) => (value === null || value === undefined ? "–" : value.toFixed(digits));
const columns = [
  ["arm", (row) => row.arm],
  ["runs", (row) => String(row.runs)],
  ["harness failures", (row) => String(row.harnessFailures)],
  ["claimed reproduced", (row) => `${row.claimedReproduced} (${fixed(row.claimRate === null ? null : row.claimRate * 100, 0)}%)`],
  ["fails replay of final setup", (row) => (row.replayChecked ? `${row.failsReplay} of ${row.replayChecked}` : "–")],
  ["differs from unedited setup", (row) => `${row.failsControl} of ${row.controlChecked}`],
  [
    "decoy drift (mean ± sd, n)",
    (row) => (row.decoyDriftN ? `${fixed(row.decoyDriftMean)} ± ${fixed(row.decoyDriftSd)} (${row.decoyDriftN})` : "–"),
  ],
  ["official runs", (row) => fixed(row.meanOfficialRuns, 1)],
  ["files changed", (row) => fixed(row.meanFilesChanged, 1)],
  ["re-plans", (row) => fixed(row.meanReplans, 1)],
  ["cost per run", (row) => (row.meanCostUsd === null ? "–" : `$${fixed(row.meanCostUsd)}`)],
];
const lines = [
  `| ${columns.map(([name]) => name).join(" | ")} |`,
  `|${columns.map(() => "---").join("|")}|`,
  ...summary.map((row) => `| ${columns.map(([, cell]) => cell(row)).join(" | ")} |`),
];
console.log(lines.join("\n"));
const total = summary.reduce((sum, row) => sum + row.totalCostUsd, 0);
console.log(`\n${results.length} runs, $${total.toFixed(2)} in total.`);
const csv = [
  Object.keys(summary[0] ?? {}).join(","),
  ...summary.map((row) =>
    Object.values(row)
      .map((value) => (value === null ? "" : String(value)))
      .join(","),
  ),
];
const csvPath = join(dirname(resultsPath), "summary.csv");
await writeFile(csvPath, `${csv.join("\n")}\n`);
console.log(`Wrote ${csvPath}`);
