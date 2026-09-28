import {
  AssessmentSchema,
  AttemptSchema,
  ExperimentPlanSchema,
  MetricSchema,
  type Assessment,
  type Attempt,
  type ExperimentPlan,
  type Metric,
  type RunEvent,
} from "@dejaml/contracts";

import {
  convertMetricValue,
  extractMetric,
  MetricExtractionError,
  type ExportedArtifact,
  type MetricUnit,
} from "./extract.js";

export type VerifierEventInput = Omit<RunEvent, "id" | "sequence" | "timestamp">;
export type VerifierEventSink = (event: VerifierEventInput) => unknown;

type Check = Assessment["checks"][number];

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

/** Removes binary floating-point noise such as 79.88 - 81.66 = -1.7800000000000011. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Compares one observed metric with the paper claim. The numeric verdict is
 * reached only when every comparability check passes; otherwise the result is
 * `inconclusive`. The tolerance is a product threshold in the claim's unit,
 * not a statement of statistical equivalence.
 */
export function assessResult(input: {
  plan: ExperimentPlan;
  attempt: Attempt;
  metric: Metric | null;
  tolerance: number;
  extractionFailure?: string;
  knownDiscrepancies?: string[];
}): Assessment {
  const plan = ExperimentPlanSchema.parse(input.plan);
  const attempt = AttemptSchema.parse(input.attempt);
  const metric = input.metric ? MetricSchema.parse(input.metric) : null;
  const claim = plan.claim;
  if (!Number.isFinite(input.tolerance) || input.tolerance < 0) {
    throw new Error("tolerance must be a finite non-negative number");
  }

  const checks: Check[] = [];
  const check = (name: string, passed: boolean, explanation: string): boolean => {
    checks.push({ name, passed, explanation });
    return passed;
  };

  const attemptFinished = attempt.exitCode === 0 && !attempt.timedOut && !attempt.cancelled;
  const blocking = [
    check(
      "attempt_completed",
      attemptFinished,
      attemptFinished
        ? "The attempt exited with code 0 within its limits."
        : attempt.timedOut
          ? "The attempt hit its wall-time limit."
          : attempt.cancelled
            ? "The attempt was cancelled."
            : `The attempt exited with code ${String(attempt.exitCode)}.`,
    ),
    check(
      "baseline_attempt",
      attempt.label === "baseline" && attempt.changes.length === 0,
      attempt.label === "baseline" && attempt.changes.length === 0
        ? "The compared value comes from the unmodified baseline attempt."
        : "Only an unmodified baseline attempt is compared with the paper.",
    ),
    check(
      "metric_extracted",
      metric !== null,
      metric
        ? `Read ${metric.value} using ${metric.extractionRule}.`
        : `No metric was extracted${input.extractionFailure ? `: ${input.extractionFailure}` : "."}`,
    ),
    check(
      "metric_definition",
      metric !== null && normalized(metric.name) === normalized(claim.metric.name),
      `The paper reports ${claim.metric.name}; the attempt measured ${metric?.name ?? "nothing"}.`,
    ),
    check(
      "unit",
      metric !== null && convertMetricValue(1, metric.unit, claim.metric.unit) !== null,
      metric
        ? metric.unit === claim.metric.unit
          ? `Both values are in ${claim.metric.unit}.`
          : `Converted ${metric.unit} to ${claim.metric.unit}.`
        : "No unit to compare.",
    ),
    check(
      "dataset",
      normalized(plan.dataset.name) === normalized(claim.dataset),
      `The run used ${plan.dataset.name}; the claim is on ${claim.dataset}.`,
    ),
    check(
      "split",
      claim.split !== null && metric !== null && normalized(metric.split) === normalized(claim.split),
      claim.split === null
        ? "The paper does not identify the evaluation split."
        : `Both values are on the ${claim.split}.`,
    ),
  ];
  // Seed behaviour is reported, not blocking: an unstated seed is a finding.
  const seedKnown = check(
    "seed",
    claim.seed !== null,
    claim.seed !== null
      ? `The paper states seed ${claim.seed}.`
      : "The paper result does not identify the seed; this attempt used the case's documented seed.",
  );

  const comparable = blocking.every(Boolean);
  const observedValue =
    comparable && metric ? round(convertMetricValue(metric.value, metric.unit, claim.metric.unit) ?? Number.NaN) : null;
  const paperValue = claim.metric.reportedValue;
  const signedDifference = observedValue === null ? null : round(observedValue - paperValue);
  const absoluteDifference = signedDifference === null ? null : Math.abs(signedDifference);
  const verdict: Assessment["verdict"] =
    absoluteDifference === null
      ? "inconclusive"
      : absoluteDifference <= input.tolerance + 1e-9
        ? "reproduced_within_tolerance"
        : "different_result";

  const discrepancyHypotheses =
    verdict === "different_result"
      ? [
          ...(seedKnown
            ? []
            : ["The paper's unstated random seed may produce a different split or forest than the seed used here."]),
          ...(input.knownDiscrepancies ?? []),
        ].map((text) => `Hypothesis: ${text}`)
      : [];

  const limitations = [
    `The ${input.tolerance} ${unitLabel(claim.metric.unit)} tolerance is a product threshold, not a test of statistical equivalence.`,
    "One attempt was compared; run-to-run variance was not measured.",
    ...(seedKnown ? [] : ["The paper's seed is unknown, so an exact match is not expected."]),
  ];

  return AssessmentSchema.parse({
    comparable,
    checks,
    paperValue,
    observedValue,
    signedDifference,
    absoluteDifference,
    tolerance: input.tolerance,
    verdict,
    discrepancyHypotheses,
    evidence: [...claim.evidence, ...(metric ? [metric.evidence] : [])],
    limitations,
  });
}

function unitLabel(unit: MetricUnit): string {
  return unit === "percent" ? "percentage point" : unit === "fraction" ? "fraction" : "score";
}

function formatValue(value: number, unit: MetricUnit): string {
  return unit === "percent" ? `${value}%` : String(value);
}

/** One-line public summary, e.g. "Observed 79.88%, which is 1.78 percentage points below the paper". */
export function describeAssessment(assessment: Assessment, unit: MetricUnit): string {
  if (assessment.verdict === "inconclusive" || assessment.observedValue === null || assessment.signedDifference === null) {
    const failed = assessment.checks.find((item) => !item.passed && item.name !== "seed");
    return `Inconclusive: ${failed?.explanation ?? "the result could not be compared"}`;
  }
  const observed = formatValue(assessment.observedValue, unit);
  const difference = Math.abs(assessment.signedDifference);
  if (difference === 0) return `Observed ${observed}, exactly the paper's value`;
  const amount = unit === "percent" ? `${difference} percentage point${difference === 1 ? "" : "s"}` : String(difference);
  const direction = assessment.signedDifference < 0 ? "below" : "above";
  return `Observed ${observed}, which is ${amount} ${direction} the paper`;
}

/**
 * Extracts the metric, assesses it, and records public Result Verifier events.
 * Extraction failures become an `inconclusive` assessment instead of an error.
 */
export function verifyResult(input: {
  runId: string;
  plan: ExperimentPlan;
  attempt: Attempt;
  artifact?: ExportedArtifact;
  stdout?: string;
  observedUnit?: MetricUnit;
  tolerance: number;
  knownDiscrepancies?: string[];
  events?: VerifierEventSink;
}): { metric: Metric | null; assessment: Assessment } {
  const emit = (event: Omit<VerifierEventInput, "runId" | "actor">): void => {
    input.events?.({ runId: input.runId, actor: "result_verifier", ...event });
  };
  emit({
    type: "comparison_started",
    status: "started",
    summary: "Checking metric, dataset, split, and units before comparison",
    evidence: [],
    publicPayload: { attemptId: input.attempt.id },
  });

  let metric: Metric | null = null;
  let extractionFailure: string | undefined;
  try {
    metric = extractMetric({
      plan: input.plan,
      attempt: input.attempt,
      ...(input.artifact ? { artifact: input.artifact } : {}),
      ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
      ...(input.observedUnit ? { observedUnit: input.observedUnit } : {}),
    });
    emit({
      type: "metric_extracted",
      status: "progress",
      summary: `Read ${metric.name} = ${metric.value} from the attempt`,
      evidence: [metric.evidence],
      publicPayload: { metric },
    });
  } catch (error) {
    if (!(error instanceof MetricExtractionError)) throw error;
    extractionFailure = error.message;
    emit({
      type: "metric_extracted",
      status: "failed",
      summary: "The metric could not be read from the attempt",
      evidence: [],
      publicPayload: { code: error.code, reason: error.message },
    });
  }

  const assessment = assessResult({
    plan: input.plan,
    attempt: input.attempt,
    metric,
    tolerance: input.tolerance,
    ...(extractionFailure ? { extractionFailure } : {}),
    ...(input.knownDiscrepancies ? { knownDiscrepancies: input.knownDiscrepancies } : {}),
  });
  emit({
    type: "comparison_completed",
    status: assessment.verdict === "inconclusive" ? "warning" : "completed",
    summary: describeAssessment(assessment, input.plan.claim.metric.unit),
    evidence: assessment.evidence,
    publicPayload: {
      verdict: assessment.verdict,
      paperValue: assessment.paperValue,
      observedValue: assessment.observedValue,
      signedDifference: assessment.signedDifference,
      tolerance: assessment.tolerance,
      unit: input.plan.claim.metric.unit,
      failedChecks: assessment.checks.filter((item) => !item.passed).map((item) => item.name),
      assessment,
    },
  });
  return { metric, assessment };
}
