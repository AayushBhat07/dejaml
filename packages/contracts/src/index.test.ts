import { describe, expect, it } from "vitest";

import { AssessmentSchema, ExperimentPlanSchema, RunEventSchema } from "./index.js";

const claim = {
  experimentLabel: "Random Forest on UCI Urban Land Cover",
  dataset: "UCI Urban Land Cover",
  split: "official test set",
  model: "Random Forest",
  metric: { name: "accuracy", unit: "percent", reportedValue: 81.66 },
  seed: null,
  hyperparameters: { nEstimators: 30 },
  evidence: [{ kind: "paper_page", reference: "page 4, Table 2" }],
  missingFields: ["validation split seed"],
  confidence: "high",
} as const;

describe("ExperimentPlanSchema", () => {
  it("accepts a bounded curated plan", () => {
    const parsed = ExperimentPlanSchema.parse({
      caseId: "urban-land-cover-random-forest",
      repository: {
        url: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover",
        commitSha: "49ece7ff4cc43fd4cb258678d44854f1cb2a417d",
      },
      claim,
      dataset: {
        name: "UCI Urban Land Cover",
        sourceUrl: "https://archive.ics.uci.edu/static/public/295/urban%2Bland%2Bcover.zip",
        sha256: "277a27000a4a4b593f655595b92904ccb30ece48b8bb2a35cf5d3854d7204f79",
        expectedPaths: ["data/training.csv", "data/testing.csv"],
      },
      preparation: [],
      executionAdapter: {
        source: "curated_case",
        path: "cases/urban-land-cover/runner.py",
        sha256: "276fa3d9b5d4677139c20ab71ceee491b7c849b74278b9a655c122ade8460f6b",
      },
      command: {
        executable: "python",
        args: ["runner.py"],
        cwd: "/workspace/case",
        env: {},
      },
      resources: {
        cpus: 2,
        memoryMb: 2048,
        pids: 128,
        timeoutSeconds: 120,
        networkDuringRun: false,
      },
      metricExtraction: {
        source: "json",
        path: "artifacts/result.json",
        key: "metrics.accuracyPercent",
      },
      maxAttempts: 1,
      stopConditions: ["dataset digest mismatch"],
    });

    expect(parsed.resources.networkDuringRun).toBe(false);
  });

  it("rejects network during the experiment", () => {
    const result = ExperimentPlanSchema.safeParse({
      caseId: "unsafe",
      repository: {
        url: "https://github.com/example/repo",
        commitSha: "a".repeat(40),
      },
      claim,
      dataset: {
        name: "dataset",
        sourceUrl: "https://example.com/data.zip",
        sha256: "b".repeat(64),
        expectedPaths: ["data.csv"],
      },
      preparation: [],
      executionAdapter: {
        source: "curated_case",
        path: "cases/urban-land-cover/runner.py",
        sha256: "276fa3d9b5d4677139c20ab71ceee491b7c849b74278b9a655c122ade8460f6b",
      },
      command: { executable: "python", args: [], cwd: "/workspace", env: {} },
      resources: {
        cpus: 1,
        memoryMb: 512,
        pids: 32,
        timeoutSeconds: 30,
        networkDuringRun: true,
      },
      metricExtraction: {
        source: "stdout",
        pattern: "accuracy=(?<value>[0-9.]+)",
      },
      maxAttempts: 1,
      stopConditions: ["timeout"],
    });

    expect(result.success).toBe(false);
  });
});

describe("RunEventSchema", () => {
  it("requires an offset-aware timestamp", () => {
    expect(
      RunEventSchema.safeParse({
        id: "evt_1",
        runId: "run_1",
        sequence: 1,
        timestamp: "2026-09-28T20:00:00Z",
        actor: "paper_analyst",
        type: "claim_found",
        status: "completed",
        summary: "Found the Random Forest claim",
        evidence: [{ kind: "paper_page", reference: "page 4" }],
        publicPayload: { value: 81.66 },
      }).success,
    ).toBe(true);
  });
});

describe("AssessmentSchema", () => {
  it("represents a different comparable result", () => {
    const assessment = AssessmentSchema.parse({
      comparable: true,
      checks: [{ name: "metric", passed: true, explanation: "accuracy in percent" }],
      paperValue: 81.66,
      observedValue: 79.88,
      signedDifference: -1.78,
      absoluteDifference: 1.78,
      tolerance: 1,
      verdict: "different_result",
      discrepancyHypotheses: ["validation split seed was not published"],
      evidence: [{ kind: "artifact", reference: "artifacts/result.json" }],
      limitations: ["single deterministic rerun"],
    });

    expect(assessment.verdict).toBe("different_result");
  });
});
