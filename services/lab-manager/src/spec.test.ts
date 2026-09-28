import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ExperimentPolicySchema, type ExperimentPlan } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";

import { LabSpecSchema, labSpecFromPlan } from "./spec.js";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const policy = ExperimentPolicySchema.parse(
  JSON.parse(readFileSync(new URL("../../../cases/urban-land-cover/policy.json", import.meta.url), "utf8")),
);

const plan: ExperimentPlan = {
  caseId: policy.caseId,
  repository: { url: policy.repository.url, commitSha: policy.repository.commitSha },
  claim: {
    experimentLabel: "Random Forest on UCI Urban Land Cover",
    dataset: policy.claim.dataset,
    split: "official test set",
    model: policy.claim.model,
    metric: { name: "accuracy", unit: "percent", reportedValue: policy.claim.reportedValue },
    seed: null,
    hyperparameters: {},
    evidence: [{ kind: "paper_page", reference: "page 4, Table 2" }],
    missingFields: [],
    confidence: "high",
  },
  dataset: policy.dataset,
  preparation: policy.preparation,
  executionAdapter: policy.trustedExecutionAdapter,
  command: policy.command,
  resources: policy.maximumResources,
  metricExtraction: policy.metricExtraction,
  maxAttempts: 1,
  stopConditions: policy.requiredStopConditions,
};

describe("labSpecFromPlan", () => {
  it("mounts the reviewed adapter and dataset read-only beside a writable artifact directory", () => {
    const spec = labSpecFromPlan({
      plan,
      runId: "run_1",
      projectRoot,
      image: "dejaml/python-cpu:0.1.0",
      expectedImageId: `sha256:${"c".repeat(64)}`,
    });

    expect(spec.workdir).toBe("/workspace/case");
    expect(spec.artifactsDir).toBe("artifacts");
    expect(spec.inputs.map((input) => input.containerPath)).toEqual([
      "runner.py",
      "data/training.csv",
      "data/testing.csv",
    ]);
    expect(spec.inputs[0]?.sha256).toBe(policy.trustedExecutionAdapter.sha256);
    expect(spec.inputs[1]?.hostPath).toMatch(/cases\/urban-land-cover\/data\/training\.csv$/u);
    expect(spec.resources).toEqual(policy.maximumResources);
  });

  it("rejects traversal, absolute container paths, and inputs over the artifact directory", () => {
    const base = labSpecFromPlan({
      plan,
      runId: "run_1",
      projectRoot,
      image: "dejaml/python-cpu:0.1.0",
      expectedImageId: `sha256:${"c".repeat(64)}`,
    });
    const withInput = (containerPath: string) =>
      LabSpecSchema.safeParse({ ...base, inputs: [{ hostPath: "/tmp/x", containerPath }] }).success;

    expect(withInput("../etc/passwd")).toBe(false);
    expect(withInput("/etc/passwd")).toBe(false);
    expect(withInput("data/./x")).toBe(false);
    expect(withInput("artifacts/result.json")).toBe(false);
    expect(LabSpecSchema.safeParse({ ...base, workdir: "/" }).success).toBe(false);
    expect(LabSpecSchema.safeParse({ ...base, resources: { ...base.resources, networkDuringRun: true } }).success).toBe(false);
  });
});
