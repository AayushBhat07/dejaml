import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ExperimentPolicySchema, RunEventSchema, type Attempt, type ExperimentPlan } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";

import {
  assessResult,
  convertMetricValue,
  describeAssessment,
  extractMetric,
  MetricExtractionError,
  verifyResult,
  type VerifierEventInput,
} from "./index.js";

const caseManifest = JSON.parse(readFileSync(new URL("../../../cases/urban-land-cover/case.json", import.meta.url), "utf8")) as {
  comparison: { tolerance: number };
  knownDiscrepancies: string[];
};
const policy = ExperimentPolicySchema.parse(
  JSON.parse(readFileSync(new URL("../../../cases/urban-land-cover/policy.json", import.meta.url), "utf8")),
);

const plan: ExperimentPlan = {
  caseId: policy.caseId,
  repository: { url: policy.repository.url, commitSha: policy.repository.commitSha },
  claim: {
    experimentLabel: "Random Forest on UCI Urban Land Cover",
    dataset: "UCI Urban Land Cover",
    split: "official test set",
    model: "Random Forest",
    metric: { name: "accuracy", unit: "percent", reportedValue: 81.66 },
    seed: null,
    hyperparameters: {},
    evidence: [{ kind: "paper_page", reference: "page 4, Table 2" }],
    missingFields: ["validation split seed"],
    confidence: "high",
  },
  dataset: policy.dataset,
  preparation: [],
  executionAdapter: policy.trustedExecutionAdapter,
  command: policy.command,
  resources: policy.maximumResources,
  metricExtraction: policy.metricExtraction,
  maxAttempts: 1,
  stopConditions: policy.requiredStopConditions,
};

// Shape of the real runner output (cases/urban-land-cover/runner.py).
const resultJson = JSON.stringify({
  schemaVersion: 1,
  metrics: { accuracy: 0.798816568, accuracyPercent: 79.88, macroF1: 0.79 },
});
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "run_1:attempt-1",
    runId: "run_1",
    number: 1,
    label: "baseline",
    command: policy.command,
    changes: [],
    startedAt: "2026-09-28T12:00:00.000Z",
    endedAt: "2026-09-28T12:00:02.000Z",
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    artifactDigests: { "artifacts/result.json": digest(resultJson) },
    ...overrides,
  };
}

const artifact = { path: "artifacts/result.json", sha256: digest(resultJson), content: resultJson };

describe("extractMetric", () => {
  it("reads the reviewed JSON key and cites the artifact digest", () => {
    const metric = extractMetric({ plan, attempt: attempt(), artifact });
    expect(metric).toMatchObject({ name: "accuracy", value: 79.88, unit: "percent", split: "official test set" });
    expect(metric.evidence.reference).toBe(`artifacts/result.json#sha256=${digest(resultJson)}`);
  });

  it("refuses an artifact whose bytes differ from what the attempt recorded", () => {
    expect(() =>
      extractMetric({ plan, attempt: attempt(), artifact: { ...artifact, content: resultJson.replace("79.88", "81.66") } }),
    ).toThrow(/digest/u);
    const tampered = resultJson.replace("79.88", "81.66");
    expect(() =>
      extractMetric({ plan, attempt: attempt(), artifact: { ...artifact, sha256: digest(tampered), content: tampered } }),
    ).toThrow(MetricExtractionError);
  });

  it("rejects missing keys, prototype keys, and non-numeric values", () => {
    const withRule = (key: string): ExperimentPlan => ({
      ...plan,
      metricExtraction: { ...plan.metricExtraction, key },
    });
    expect(() => extractMetric({ plan: withRule("metrics.missing"), attempt: attempt(), artifact })).toThrow(/missing/u);
    expect(() => extractMetric({ plan: withRule("__proto__.x"), attempt: attempt(), artifact })).toThrow(/missing/u);
    const text = '{"metrics":{"accuracyPercent":"79.88"}}';
    expect(() =>
      extractMetric({
        plan,
        attempt: attempt({ artifactDigests: { "artifacts/result.json": digest(text) } }),
        artifact: { ...artifact, sha256: digest(text), content: text },
      }),
    ).toThrow(/finite number/u);
  });

  it("supports stdout patterns and CSV columns", () => {
    const stdoutPlan: ExperimentPlan = {
      ...plan,
      metricExtraction: { source: "stdout", pattern: "accuracy=([0-9.]+)" },
    };
    expect(extractMetric({ plan: stdoutPlan, attempt: attempt(), stdout: "accuracy=70\naccuracy=79.88\n" }).value).toBe(79.88);

    const csv = "epoch,accuracy\n1,70.1\n2,79.88\n";
    const csvPlan: ExperimentPlan = {
      ...plan,
      metricExtraction: { source: "csv", path: "artifacts/log.csv", key: "accuracy" },
    };
    expect(
      extractMetric({
        plan: csvPlan,
        attempt: attempt({ artifactDigests: { "artifacts/log.csv": digest(csv) } }),
        artifact: { path: "artifacts/log.csv", sha256: digest(csv), content: csv },
      }).value,
    ).toBe(79.88);
  });

  it("converts only between fraction and percent", () => {
    expect(convertMetricValue(0.5, "fraction", "percent")).toBe(50);
    expect(convertMetricValue(50, "percent", "fraction")).toBe(0.5);
    expect(convertMetricValue(0.5, "score", "percent")).toBeNull();
  });
});

describe("assessResult", () => {
  it("reports the curated result as a different result with labelled hypotheses", () => {
    const metric = extractMetric({ plan, attempt: attempt(), artifact });
    const assessment = assessResult({
      plan,
      attempt: attempt(),
      metric,
      tolerance: caseManifest.comparison.tolerance,
      knownDiscrepancies: caseManifest.knownDiscrepancies,
    });

    expect(assessment).toMatchObject({
      comparable: true,
      paperValue: 81.66,
      observedValue: 79.88,
      signedDifference: -1.78,
      absoluteDifference: 1.78,
      verdict: "different_result",
    });
    expect(assessment.checks.find((item) => item.name === "seed")?.passed).toBe(false);
    expect(assessment.discrepancyHypotheses.every((text) => text.startsWith("Hypothesis: "))).toBe(true);
    expect(assessment.discrepancyHypotheses).toHaveLength(caseManifest.knownDiscrepancies.length + 1);
    expect(describeAssessment(assessment, "percent")).toBe("Observed 79.88%, which is 1.78 percentage points below the paper");
  });

  it("reproduces within tolerance after converting a fraction", () => {
    const metric = { ...extractMetric({ plan, attempt: attempt(), artifact }), value: 0.8166, unit: "fraction" as const };
    const assessment = assessResult({ plan, attempt: attempt(), metric, tolerance: 1 });
    expect(assessment).toMatchObject({ observedValue: 81.66, signedDifference: 0, verdict: "reproduced_within_tolerance" });
    expect(assessment.discrepancyHypotheses).toEqual([]);
  });

  it("is inconclusive for timeouts, modified attempts, wrong metrics, and incomparable units", () => {
    const metric = extractMetric({ plan, attempt: attempt(), artifact });
    const verdict = (overrides: Parameters<typeof assessResult>[0]) => assessResult(overrides).verdict;
    const base = { plan, attempt: attempt(), metric, tolerance: 1 };

    expect(verdict({ ...base, attempt: attempt({ timedOut: true, exitCode: null }) })).toBe("inconclusive");
    expect(verdict({ ...base, attempt: attempt({ label: "modified", changes: ["seed 7"] }) })).toBe("inconclusive");
    expect(verdict({ ...base, metric: { ...metric, name: "macro F1" } })).toBe("inconclusive");
    expect(verdict({ ...base, metric: { ...metric, unit: "score" } })).toBe("inconclusive");
    expect(verdict({ ...base, plan: { ...plan, claim: { ...plan.claim, split: null } } })).toBe("inconclusive");
    const none = assessResult({ ...base, metric: null, extractionFailure: "metric key missing" });
    expect(none).toMatchObject({ comparable: false, observedValue: null, signedDifference: null });
    expect(describeAssessment(none, "percent")).toBe("Inconclusive: No metric was extracted: metric key missing");
  });
});

describe("verifyResult", () => {
  it("emits schema-valid Result Verifier events matching the fixture narrative", () => {
    const events: VerifierEventInput[] = [];
    const { assessment } = verifyResult({
      runId: "run_1",
      plan,
      attempt: attempt(),
      artifact,
      tolerance: caseManifest.comparison.tolerance,
      knownDiscrepancies: caseManifest.knownDiscrepancies,
      events: (event) => events.push(event),
    });

    expect(assessment.verdict).toBe("different_result");
    expect(events.map((event) => `${event.type}:${event.status}`)).toEqual([
      "comparison_started:started",
      "metric_extracted:progress",
      "comparison_completed:completed",
    ]);
    for (const event of events) {
      RunEventSchema.parse({ ...event, id: "evt", sequence: 1, timestamp: new Date().toISOString() });
    }
  });

  it("turns a missing artifact into an inconclusive assessment", () => {
    const events: VerifierEventInput[] = [];
    const { metric, assessment } = verifyResult({
      runId: "run_1",
      plan,
      attempt: attempt({ artifactDigests: {} }),
      tolerance: 1,
      events: (event) => events.push(event),
    });
    expect(metric).toBeNull();
    expect(assessment.verdict).toBe("inconclusive");
    expect(events.map((event) => event.status)).toEqual(["started", "failed", "warning"]);
  });
});
