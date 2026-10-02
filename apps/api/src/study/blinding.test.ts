import { BlindingIntegrityError, sha256Hex } from "@dejaml/run-store";
import { describe, expect, it } from "vitest";

import {
  compareRevealed,
  executionContract,
  findValue,
  implausibleValue,
  lockObservation,
  type Observation,
  revealTarget,
  riggedAdapter,
  sealTarget,
  statesExpectation,
  valueForms,
  withholdInJson,
  withholdValue,
} from "./blinding.js";
import { canonicalJson } from "./contract.js";

/** A value no honest text would contain by accident. */
const SENTINEL = 0.3141592653589793;

const sealInput = {
  caseId: "sentinel-case",
  caseVersion: "v".repeat(64),
  paperSha256: "a".repeat(64),
  claimLocator: { page: 4, location: "Table 2" },
  metric: { name: "accuracy", unit: "fraction" as const },
  reportedValue: SENTINEL,
  tolerance: 0.02,
};

describe("sealed target commitment", () => {
  it("commits to canonical JSON with a private nonce, so equal values never share a commitment", () => {
    const first = sealTarget(sealInput);
    const second = sealTarget(sealInput);
    expect(first.commitment).toBe(sha256Hex(first.canonical));
    expect(first.canonical).toBe(canonicalJson(first.target));
    expect(first.target.nonce).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.commitment).not.toBe(second.commitment);
    // Every field the commitment binds.
    expect(Object.keys(JSON.parse(first.canonical) as object).sort()).toEqual(
      [
        "additionalMetrics",
        "caseId",
        "caseVersion",
        "claimLocator",
        "comparisonRule",
        "metric",
        "nonce",
        "paperSha256",
        "reportedValue",
        "schemaVersion",
        "tolerance",
      ].sort(),
    );
  });

  it("verifies the reveal, and a target mutated after sealing fails as a typed integrity error", () => {
    const sealed = sealTarget(sealInput);
    expect(revealTarget(sealed)).toEqual(sealed.target);
    const mutated = sealed.canonical.replace(String(SENTINEL), "0.9");
    expect(() => revealTarget({ canonical: mutated, commitment: sealed.commitment })).toThrow(BlindingIntegrityError);
    try {
      revealTarget({ canonical: mutated, commitment: sealed.commitment });
    } catch (error) {
      expect((error as BlindingIntegrityError).code).toBe("commitment_mismatch");
    }
  });

  it("compares deterministically, in code, with the revealed value", () => {
    const { target } = sealTarget(sealInput);
    expect(compareRevealed(target, 0.33)).toEqual({
      observed: 0.33,
      reported: SENTINEL,
      absoluteDelta: 0.015840735,
      tolerance: 0.02,
      withinTolerance: true,
      rule: "absolute_difference_within_tolerance",
    });
    expect(compareRevealed(target, 0.4).withinTolerance).toBe(false);
  });
});

describe("observation lock", () => {
  const observation: Observation = {
    schemaVersion: 1,
    runId: "run_x",
    round: 1,
    metric: { name: "accuracy", unit: "fraction", parser: { source: "stdout", pattern: "acc (\\d\\.\\d+)" } },
    planDigest: "p".repeat(64),
    repository: {
      url: "https://github.com/a/b",
      commitSha: "c".repeat(40),
      manifestSha256: "m".repeat(64),
      projectionSha256: "j".repeat(64),
    },
    environment: {
      digest: "e".repeat(64),
      labImageId: "sha256:x",
      labImageDigest: null,
      dependencyManifestSha256: null,
      platform: "linux/amd64",
    },
    datasets: [],
    engineers: [
      {
        engineerAgentId: "agt_1",
        label: "engineer-1",
        receiptId: "rcp_1",
        exitCode: 0,
        timedOut: false,
        stdoutSha256: "s".repeat(64),
        stderrSha256: "t".repeat(64),
        artifacts: [],
        metricOk: true,
        metricSource: "stdout",
        rawValue: 0.7988,
        observedValue: 0.7988,
        problem: null,
      },
    ],
  };

  it("is deterministic, and any change to the observation changes its commitment", () => {
    expect(lockObservation(observation)).toEqual(lockObservation(structuredClone(observation)));
    const mutated = structuredClone(observation);
    mutated.engineers[0]!.observedValue = 0.81;
    expect(lockObservation(mutated).commitment).not.toBe(lockObservation(observation).commitment);
  });

  it("refuses a metric value that cannot be right for its unit", () => {
    expect(implausibleValue(0.5, "fraction")).toBeNull();
    expect(implausibleValue(7, "fraction")).toMatch(/between 0 and 1/u);
    expect(implausibleValue(101, "percent")).toMatch(/between 0 and 100/u);
    expect(implausibleValue(Number.NaN, "score")).toMatch(/finite/u);
  });
});

describe("leak detection", () => {
  it("knows the usual written forms of a value, on both scales", () => {
    const forms = valueForms(SENTINEL, "fraction");
    for (const form of ["0.3141592653589793", "0.314", "0.3142", "0.31416", "31.4", "31.42", "31.416"]) expect(forms).toContain(form);
    // Too short to mean anything when detecting: never refuse on them.
    expect(forms).not.toContain("0.3");
    expect(forms).not.toContain("0.31");
    // A low-entropy value is withheld when redacting, but never detected.
    expect(valueForms(1, "fraction")).toEqual([]);
    expect(valueForms(1, "fraction", "redact")).toEqual(expect.arrayContaining(["1.0", "1.000", "100.0"]));
  });

  it("finds the value as a whole number token only", () => {
    expect(findValue(SENTINEL, "fraction", "the paper reports 31.42% accuracy")).toBe("31.42");
    expect(findValue(SENTINEL, "fraction", "acc=0.3142")).toBe("0.3142");
    expect(findValue(SENTINEL, "fraction", "version 0.314.2 and 10.3142")).toBeNull();
    expect(findValue(SENTINEL, "fraction", "learning rate 0.31")).toBeNull();
  });

  it("withholds every form in text and JSON", () => {
    expect(withholdValue(SENTINEL, "fraction", "got 0.3142 (31.42%), not 0.5")).toBe("got [withheld] ([withheld]%), not 0.5");
    expect(withholdInJson(SENTINEL, "fraction", { a: [`x ${SENTINEL}`], b: SENTINEL, c: 2 })).toEqual({
      a: ["x [withheld]"],
      b: null,
      c: 2,
    });
  });

  it("recognizes a plan that states an expected result, without refusing ordinary planning text", () => {
    for (const text of [
      "The accuracy should be 0.95 on the test set.",
      "Expected accuracy: 81.66",
      "We expect the score to reach 92%.",
      "Stop if accuracy is not close to 0.9.",
      "The paper's accuracy is 0.98",
      "tolerance 0.02",
      "a result higher than the paper",
    ]) {
      expect(statesExpectation(text), text).toBe(true);
    }
    for (const text of [
      "Run the notebook's code cells in order and print the test accuracy.",
      "Stop if the command does not finish within 600 seconds.",
      "Use Python 3.11; the script will write the result to artifacts/result.json.",
      "Reproduce the paper's accuracy on GunPoint with the official code.",
    ]) {
      expect(statesExpectation(text), text).toBe(false);
    }
  });

  it("recognizes adapters that compare with or print a fixed result", () => {
    expect(riggedAdapter("import math\nif math.isclose(acc, x): print('ok')")).not.toBeNull();
    expect(riggedAdapter("if abs(acc - target) < 0.01: pass")).not.toBeNull();
    expect(riggedAdapter("print('accuracy: 0.98')")).not.toBeNull();
    expect(riggedAdapter("expected_accuracy = 3")).not.toBeNull();
    expect(riggedAdapter("for cell in nb['cells']:\n    exec(compile(src, name, 'exec'), ns)")).toBeNull();
  });
});

describe("execution view", () => {
  it("drops the reported value, tolerance and paper reference, and adds the metric's direction", () => {
    const view = executionContract({
      schemaVersion: 1,
      method: "BOSS",
      dataset: { name: "GunPoint", source: { kind: "repository", paths: ["data.csv"] } },
      split: "test",
      preprocessing: "none",
      seedPolicy: "none",
      metric: { name: "test accuracy", unit: "fraction" },
      reportedValue: SENTINEL,
      paperReference: { page: 4, location: "Table 2", excerpt: `pyts ${SENTINEL}` },
      repository: { url: "https://github.com/a/b", commitSha: "c".repeat(40) },
      entrypoint: "run.py",
      command: { argv: ["python", "run.py"], cwd: "repo" },
      environment: { platform: {} as never, requirements: [], compatibilityConstraints: [] },
      expectedRuntimeSeconds: 10,
      metricParser: { source: "stdout", pattern: "acc (\\d\\.\\d+)" },
      tolerance: 0.02,
      additionalMetrics: [
        {
          metric: { name: "macro F1", unit: "fraction" },
          reportedValue: 0.2718281828459045,
          paperReference: { page: 4, location: "Table 2", excerpt: "macro F1 0.2718281828459045" },
          metricParser: { source: "json", path: "artifacts/result.json", key: "metrics.macroF1" },
          tolerance: 0.03,
        },
      ],
      stopConditions: ["exit non-zero"],
    });
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/reportedValue|tolerance|paperReference|excerpt|Table 2|0\.314|0\.271828/u);
    expect(view.metric).toEqual({ name: "test accuracy", unit: "fraction", direction: "higher_is_better" });
    expect(view.additionalMetrics).toEqual([
      {
        metric: { name: "macro F1", unit: "fraction", direction: "higher_is_better" },
        metricParser: { source: "json", path: "artifacts/result.json", key: "metrics.macroF1" },
      },
    ]);
  });
});
