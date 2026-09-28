import { createHash } from "node:crypto";

import {
  ExperimentPlanSchema,
  ExperimentPolicySchema,
  PlanPolicyResultSchema,
  type CodeAnalysis,
  type ExperimentPlan,
  type ExperimentPolicy,
  type PaperAnalysis,
  type PlanPolicyResult,
} from "@dejaml/contracts";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

export function evaluateExperimentPlan(input: {
  plan: ExperimentPlan;
  policy: ExperimentPolicy;
  paperAnalysis: PaperAnalysis;
  codeAnalysis: CodeAnalysis;
}): PlanPolicyResult {
  const plan = ExperimentPlanSchema.parse(input.plan);
  const policy = ExperimentPolicySchema.parse(input.policy);
  const codeMapping = input.codeAnalysis.mapping;
  const checks: PlanPolicyResult["checks"] = [];
  const check = (id: string, passed: boolean, explanation: string): void => {
    checks.push({ id, passed, explanation });
  };

  check("case", plan.caseId === policy.caseId, "Plan uses the reviewed case identifier.");
  check(
    "repository",
    plan.repository.url === policy.repository.url &&
      plan.repository.commitSha === policy.repository.commitSha &&
      codeMapping?.repositoryUrl === policy.repository.url &&
      codeMapping.commitSha === policy.repository.commitSha &&
      policy.repository.approvedEntrypoints.includes(codeMapping.entrypoint),
    "Repository URL, immutable commit, and analyzed entry point match the reviewed case.",
  );
  const paperClaim = input.paperAnalysis.claim;
  check(
    "claim",
    Boolean(
      paperClaim &&
        normalized(plan.claim.dataset) === normalized(policy.claim.dataset) &&
        normalized(plan.claim.model) === normalized(policy.claim.model) &&
        policy.claim.metricNames.map(normalized).includes(normalized(plan.claim.metric.name)) &&
        plan.claim.metric.unit === policy.claim.unit &&
        Math.abs(plan.claim.metric.reportedValue - policy.claim.reportedValue) < 1e-9 &&
        normalized(paperClaim.dataset) === normalized(plan.claim.dataset) &&
        normalized(paperClaim.model) === normalized(plan.claim.model) &&
        normalized(paperClaim.metric.name) === normalized(plan.claim.metric.name) &&
        paperClaim.metric.unit === plan.claim.metric.unit &&
        Math.abs(paperClaim.metric.reportedValue - plan.claim.metric.reportedValue) < 1e-9,
    ),
    "Claim identity and reported metric match the validated paper evidence and reviewed case.",
  );
  check("dataset", same(plan.dataset, policy.dataset), "Dataset source, checksum, and paths are exact.");
  check("preparation", same(plan.preparation, policy.preparation), "Preparation steps are allowlisted exactly.");
  check(
    "execution_adapter",
    same(plan.executionAdapter, policy.trustedExecutionAdapter),
    "Execution adapter path and checksum match the reviewed DéjàML-owned adapter.",
  );
  check("command", same(plan.command, policy.command), "Execution uses the reviewed argv command, directory, and environment.");
  check(
    "resources",
    plan.resources.cpus <= policy.maximumResources.cpus &&
      plan.resources.memoryMb <= policy.maximumResources.memoryMb &&
      plan.resources.pids <= policy.maximumResources.pids &&
      plan.resources.timeoutSeconds <= policy.maximumResources.timeoutSeconds &&
      plan.resources.networkDuringRun === false,
    "CPU, memory, process, timeout, and offline limits stay within reviewed ceilings.",
  );
  check(
    "metric_extraction",
    same(plan.metricExtraction, policy.metricExtraction),
    "Metric artifact and extraction key are exactly reviewed.",
  );
  check(
    "attempts",
    plan.maxAttempts <= policy.maximumAttempts,
    "Attempt count does not exceed the reviewed maximum.",
  );
  const allowedStops = new Set(policy.allowedStopConditions);
  check(
    "stop_conditions",
    policy.requiredStopConditions.every((condition) => plan.stopConditions.includes(condition)) &&
      plan.stopConditions.every((condition) => allowedStops.has(condition)),
    "All required stop conditions are present and no unknown conditions were added.",
  );

  const approved = checks.every((item) => item.passed);
  return PlanPolicyResultSchema.parse({
    approved,
    planDigest: approved ? createHash("sha256").update(stable(plan)).digest("hex") : null,
    checks,
  });
}
