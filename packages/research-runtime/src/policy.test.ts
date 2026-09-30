import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { type ExperimentPlan, ExperimentPolicySchema } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";

import { evaluateExperimentPlan } from "./policy.js";
import { codeFixture, paperFixture, planFixture, policyFixture } from "./test-fixtures.js";

function evaluate(plan: ExperimentPlan) {
  return evaluateExperimentPlan({
    plan,
    policy: policyFixture,
    paperAnalysis: paperFixture,
    codeAnalysis: codeFixture,
  });
}

describe("deterministic experiment plan policy", () => {
  it("keeps the committed case policy synchronized with the trusted adapter", async () => {
    const policyPath = new URL("../../../cases/urban-land-cover/policy.json", import.meta.url);
    const projectRoot = new URL("../../../", import.meta.url);
    const committedPolicy = ExperimentPolicySchema.parse(JSON.parse(await readFile(policyPath, "utf8")));
    const adapter = await readFile(new URL(committedPolicy.trustedExecutionAdapter.path, projectRoot));
    expect(committedPolicy).toEqual(policyFixture);
    expect(createHash("sha256").update(adapter).digest("hex")).toBe(committedPolicy.trustedExecutionAdapter.sha256);
  });

  it("approves only the exact bounded curated plan and produces a stable digest", () => {
    const first = evaluate(planFixture);
    const second = evaluate(structuredClone(planFixture));
    expect(first.approved).toBe(true);
    expect(first.checks.every((check) => check.passed)).toBe(true);
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.planDigest).toBe(first.planDigest);
  });

  it.each([
    ["repository commit", (plan: ExperimentPlan) => (plan.repository.commitSha = "b".repeat(40)), "repository"],
    ["dataset digest", (plan: ExperimentPlan) => (plan.dataset.sha256 = "c".repeat(64)), "dataset"],
    ["command argument", (plan: ExperimentPlan) => plan.command.args.push("--unsafe"), "command"],
    ["working directory", (plan: ExperimentPlan) => (plan.command.cwd = "/tmp"), "command"],
    ["environment", (plan: ExperimentPlan) => (plan.command.env = { TOKEN: "secret" }), "command"],
    ["preparation", (plan: ExperimentPlan) => plan.preparation.push({ kind: "install", description: "extra" }), "preparation"],
    ["adapter digest", (plan: ExperimentPlan) => (plan.executionAdapter.sha256 = "d".repeat(64)), "execution_adapter"],
    ["resource ceiling", (plan: ExperimentPlan) => (plan.resources.memoryMb = 4096), "resources"],
    ["metric rule", (plan: ExperimentPlan) => (plan.metricExtraction.key = "other"), "metric_extraction"],
    ["unknown stop condition", (plan: ExperimentPlan) => plan.stopConditions.push("ignore failures"), "stop_conditions"],
    ["missing stop condition", (plan: ExperimentPlan) => plan.stopConditions.pop(), "stop_conditions"],
  ])("rejects a changed %s", (_name, mutate, failedCheck) => {
    const changed = structuredClone(planFixture);
    mutate(changed);
    const result = evaluate(changed);
    expect(result.approved).toBe(false);
    expect(result.planDigest).toBeNull();
    expect(result.checks.find((check) => check.id === failedCheck)?.passed).toBe(false);
  });
});
