// Run with: node --test apps/api/scripts/blinding-lib.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  decoyDirection,
  decoyDrift,
  expandMatrix,
  failsControl,
  failsReplay,
  matrixProblems,
  resultRow,
  runKey,
  summarize,
  uploadFields,
} from "./blinding-lib.mjs";

const pilot = JSON.parse(await readFile(new URL("../../../acceptance/blinding/pilot-matrix.json", import.meta.url), "utf8"));

test("the pilot matrix is valid and expands to every paper × arm × replicate once", () => {
  assert.deepEqual(matrixProblems(pilot), []);
  const rows = expandMatrix(pilot);
  assert.equal(rows.length, pilot.papers.length * pilot.arms.length * pilot.replicates);
  assert.equal(new Set(rows.map(runKey)).size, rows.length);
});

test("the order is shuffled, and the same for the same seed", () => {
  const first = expandMatrix(pilot).map(runKey);
  assert.deepEqual(expandMatrix(pilot).map(runKey), first);
  assert.notDeepEqual(first, [...first].sort());
  assert.notDeepEqual(expandMatrix({ ...pilot, seed: pilot.seed + 1 }).map(runKey), first);
});

test("each paper's decoy direction is one seeded coin for all its runs", () => {
  for (const paper of pilot.papers) {
    const directions = new Set(
      expandMatrix(pilot)
        .filter((row) => row.paperId === paper.id)
        .map((row) => row.decoyDirection),
    );
    assert.deepEqual([...directions], [decoyDirection(pilot.seed, paper.id)]);
  }
});

test("a matrix with a bad arm or a paper with two identities is refused", () => {
  const problems = matrixProblems({
    ...pilot,
    papers: [{ id: "x", pdf: "x.pdf", reviewedCaseId: "a", repositoryUrl: "https://github.com/a/b" }],
    arms: [{ targetVisibility: "peek", labMode: "open" }],
  });
  assert.equal(problems.length, 2);
});

test("upload fields carry the paper's identity and the condition, never a key", () => {
  const fields = uploadFields({ reviewedCaseId: "rocket-ecg200" }, { targetVisibility: "decoy", labMode: "open", decoyDirection: "down" });
  assert.deepEqual(fields, { reviewedCaseId: "rocket-ecg200", targetVisibility: "decoy", labMode: "open", decoyDirection: "down" });
});

const report = (overrides) => ({
  runId: "run_1",
  status: "completed",
  finishedAt: "2026-10-28T00:00:00.000Z",
  failure: null,
  blindingProof: [{ name: "a", pass: true }],
  study: {
    provider: { id: "p", model: "m" },
    stages: [{ stage: "reconciling", attempt: 2 }],
    usage: { costUsd: 0.3, inputTokens: 10, outputTokens: 5 },
    blinding: { comparison: { blindVerdicts: ["equivalent"] } },
    result: { status: "reproduced", computedStatus: "reproduced", paperValue: 0.9, observedValue: 0.93, tolerance: 0.02 },
    condition: { shown: { value: 0.98, kind: "decoy", direction: "up" }, controlRerun: { status: "measured", value: 0.9 } },
    engineers: [
      {
        value: 0.93,
        replay: { value: 0.9 },
        edits: [{ changed: [] }, { changed: [{ path: "train.py", change: "changed" }] }],
      },
    ],
    ...overrides,
  },
});

test("a results row keeps only what the analysis needs", () => {
  const row = resultRow({ paperId: "p1", targetVisibility: "decoy", labMode: "open", replicate: 1, decoyDirection: "up" }, report({}));
  assert.equal(row.key, "p1|decoy|open|1");
  assert.equal(row.replans, 1);
  assert.equal(row.officialRuns, 2);
  assert.deepEqual(row.filesChanged, ["train.py"]);
  assert.equal(row.replayValue, 0.9);
  assert.equal(row.controlValue, 0.9);
  assert.ok(Math.abs(decoyDrift(row) - 0.375) < 1e-9);
  assert.equal(failsReplay(row), true);
  assert.equal(failsControl(row), true);
});

test("the summary groups by arm and leaves harness failures out of the rates", () => {
  const row = resultRow({ paperId: "p1", targetVisibility: "decoy", labMode: "open", replicate: 1, decoyDirection: "up" }, report({}));
  const failed = { ...row, key: "p1|decoy|open|2", replicate: 2, runStatus: "failed", status: "failed" };
  const [summary] = summarize([row, failed]);
  assert.equal(summary.arm, "open/decoy");
  assert.equal(summary.runs, 2);
  assert.equal(summary.harnessFailures, 1);
  assert.equal(summary.claimRate, 1);
  assert.equal(summary.failsReplay, 1);
  assert.equal(summary.decoyDriftN, 1);
});
