import { buildPlatformSpec, type ClaimContract } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";

import { canonicalJson, checkMetricPattern, planDigest, reconcile, reviewPolicy } from "./contract.js";
import { convertUnit, matchAllBounded, parseMetric } from "./metric.js";
import type { PaperClaim, Plan, Review } from "./roles.js";
import { applySupervisor, decideStatus, type EngineerOutcome, runStatusFor, terminalStageFor } from "./verdict.js";

const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);
const platform = buildPlatformSpec({ architecture: "amd64", python: "3.13" });

const claim: PaperClaim = {
  method: "Random Forest",
  dataset: "UCI Urban Land Cover",
  split: "official test set",
  preprocessing: "not stated",
  seedPolicy: "not stated",
  metric: { name: "accuracy", unit: "percent" },
  reportedValue: 81.66,
  page: 4,
  location: "Table 2",
  excerpt: "RF 81.66",
  missingFields: [],
};

const plan: Plan = {
  status: "ready",
  summary: "run train.py",
  blockedReason: null,
  entrypoint: "train.py",
  command: { argv: ["python", "train.py", "--seed", "0"], cwd: "work/repo" },
  python: "3.11",
  requirements: ["scikit-learn==1.5.2"],
  compatibilityConstraints: [],
  dataset: { name: "UCI", source: { kind: "repository", paths: ["data/train.csv"] } },
  metricParser: { source: "stdout", pattern: "accuracy: ([0-9.]+)" },
  expectedRuntimeSeconds: 60,
  stopConditions: ["exit non-zero"],
  adapter: null,
  risks: [],
};

function contractFor(changes: Partial<Plan> = {}): ClaimContract {
  const result = reconcile({
    claim,
    plan: { ...plan, ...changes },
    repository: { url: "https://github.com/x/y", commitSha: COMMIT },
    platform,
  });
  if (!result.ok) throw new Error(result.reasons.join("; "));
  return result.contract;
}

const files = new Set(["train.py", "data/train.csv", "README.md"]);
const screen = {
  screen: (requirements: string[]) => ({
    refused: requirements
      .filter((item) => /torch|cuda|rocm/iu.test(item))
      .map((requirement) => ({ requirement, code: "gpu_package", reason: "GPU packages are refused" })),
  }),
};
const dependencies = {
  ...screen,
  check: async () => ({ ok: true, detail: {} }),
  prepare: async () => {
    throw new Error("unused");
  },
  release: async () => ({ removed: true }),
};
const policy = (contract: ClaimContract, adapter: Plan["adapter"] = null, datasetHosts: string[] = []) =>
  reviewPolicy({
    contract,
    adapter,
    repository: { commitSha: COMMIT, files },
    datasetPolicy: { allowedHosts: datasetHosts, maxRedirects: 3, maxBytes: 1024, timeoutMs: 1000 } as never,
    dependencies,
    commandTimeoutSeconds: 900,
    trustedConstraints: [{ requirement: "numpy<2", reason: "the code uses np.float, removed in NumPy 1.24" }],
  });

describe("claim contract and policy review", () => {
  it("reconciles the claim and the plan into one contract with the plan's Python and the unit's tolerance", () => {
    const contract = contractFor();
    expect(contract.environment.platform).toMatchObject({ containerPlatform: "linux/amd64", python: { version: "3.11", abi: "cp311" } });
    expect(contract.tolerance).toBe(2);
    expect(contract.reportedValue).toBe(81.66);
    expect(reconcile({ claim, plan: { ...plan, entrypoint: "../x.py" }, repository: { url: "u", commitSha: COMMIT }, platform }).ok).toBe(
      false,
    );
  });

  it("applies only constraints from the trusted constraints file and reports each one", () => {
    const trusted = policy(contractFor({ compatibilityConstraints: [{ requirement: "NumPy < 2", reason: "planner's words" }] }));
    expect(trusted.outcome).toBe("approved");
    expect(trusted.warnings.join(" ")).toMatch(/numpy.*np\.float/iu);
    const untrusted = policy(contractFor({ compatibilityConstraints: [{ requirement: "scikit-learn==0.20", reason: "older API" }] }));
    expect(untrusted.outcome).toBe("policy_blocked");
    expect(untrusted.violations.join(" ")).toMatch(/not in the project's trusted constraints file/u);
  });

  it("accepts data bundled in a package only when that package is pinned exactly", () => {
    const dataset = {
      name: "UCR GunPoint",
      source: { kind: "package" as const, package: "pyts", path: "datasets/cached_datasets/UCR/GunPoint" },
    };
    expect(policy(contractFor({ dataset, requirements: ["pyts==0.10.0", "numpy==1.23.5"] })).outcome).toBe("approved");
    const loose = policy(contractFor({ dataset, requirements: ["pyts>=0.10"] }));
    expect(loose.outcome).toBe("inconclusive");
    expect(loose.violations.join(" ")).toMatch(/must pin exactly/u);
  });

  it("requires the claim's excerpt verbatim on its cited page with the reported value", () => {
    const pages = [{ pageNumber: 4, text: "Adiac ECG200 GunPoint\npyts 0.752 0.870 1.000\nTable 2: Accuracy scores" }];
    const cited = { ...claim, page: 4, excerpt: "pyts 0.752 0.870 1.000", reportedValue: 1 };
    const repository = { url: "https://github.com/x/y", commitSha: COMMIT };
    expect(reconcile({ claim: cited, plan, repository, platform, pages }).ok).toBe(true);
    expect(reconcile({ claim: { ...cited, excerpt: "pyts 0.99" }, plan, repository, platform, pages })).toMatchObject({
      ok: false,
      reasons: [expect.stringMatching(/not on page 4/u)],
    });
    expect(reconcile({ claim: { ...cited, reportedValue: 0.9 }, plan, repository, platform, pages })).toMatchObject({
      ok: false,
      reasons: [expect.stringMatching(/reported value/u)],
    });
    expect(reconcile({ claim: { ...cited, page: 9 }, plan, repository, platform, pages }).ok).toBe(false);
  });

  it("approves a faithful plan with a stable digest", () => {
    const contract = contractFor();
    const review = policy(contract);
    expect(review).toMatchObject({ outcome: "approved", violations: [] });
    expect(review.planDigest).toBe(planDigest(contract, null));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("refuses GPU packages, unlisted and unchecksummed datasets, and oversize runtimes as policy blocks", () => {
    expect(policy(contractFor({ requirements: ["torch==2.4.0+cu121"] })).outcome).toBe("policy_blocked");
    expect(
      policy(
        contractFor({
          dataset: { name: "d", source: { kind: "download", url: "https://evil.example/d.csv", sha256: SHA, extract: false } },
        }),
      ).violations.join(),
    ).toMatch(/allowlist/u);
    expect(
      policy(
        contractFor({
          dataset: { name: "d", source: { kind: "download", url: "https://data.example/d.csv", sha256: null, extract: false } },
        }),
        null,
        ["data.example"],
      ).violations.join(),
    ).toMatch(/SHA-256/u);
    expect(policy(contractFor({ expectedRuntimeSeconds: 5_000 })).outcome).toBe("policy_blocked");
  });

  it("refuses commands that do not run the entry point or adapter, and values typed into the command", () => {
    expect(policy(contractFor({ command: { argv: ["python", "-c", "print(1)"], cwd: "repo" } })).outcome).toBe("inconclusive");
    expect(policy(contractFor({ command: { argv: ["python", "other.py"], cwd: "repo" } })).violations.join()).toMatch(
      /neither the entry point/u,
    );
    expect(policy(contractFor({ command: { argv: ["python", "train.py", "--target", "81.66"], cwd: "repo" } })).violations.join()).toMatch(
      /reported value/u,
    );
    expect(
      policy(contractFor({ entrypoint: "missing.py", command: { argv: ["python", "missing.py"], cwd: "repo" } })).violations.join(),
    ).toMatch(/not a file/u);
    expect(policy(contractFor({ dataset: { name: "d", source: { kind: "repository", paths: ["nope.csv"] } } })).violations.join()).toMatch(
      /not in the pinned checkout/u,
    );
  });

  it("allows a declared adapter but warns, and refuses an adapter holding the reported value", () => {
    const adapter = {
      path: "work/adapter/run.py",
      content: "import runpy\nrunpy.run_path('train.py')\n",
      why: "notebook",
      source: "train.py",
      differences: [],
    };
    const contract = contractFor({ command: { argv: ["python", "../adapter/run.py"], cwd: "work/repo" }, adapter });
    const review = policy(contract, adapter);
    expect(review.outcome).toBe("approved");
    expect(review.warnings.join()).toMatch(/adapter/u);
    expect(policy(contract, { ...adapter, content: "print('accuracy: 81.66')" }).violations.join()).toMatch(/adapter contains/u);
  });

  it("checks metric patterns for exactly one capture group", () => {
    expect(checkMetricPattern("acc: ([0-9.]+)")).toBeNull();
    expect(checkMetricPattern("acc: [0-9.]+")).toMatch(/exactly one/u);
    expect(checkMetricPattern("(a)(b)")).toMatch(/exactly one/u);
    expect(checkMetricPattern("([")).toMatch(/not a valid/u);
  });
});

describe("metric parsing", () => {
  it("reads the last stdout match and JSON keys by code", async () => {
    await expect(
      parseMetric(
        { source: "stdout", pattern: "accuracy: ([0-9.]+)" },
        { stdout: "accuracy: 0.5\naccuracy: 0.79\n", artifacts: new Map() },
      ),
    ).resolves.toMatchObject({ ok: true, value: 0.79, matches: 2 });
    await expect(
      parseMetric({ source: "stdout", pattern: "accuracy: ([0-9.]+)" }, { stdout: "nothing", artifacts: new Map() }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      parseMetric(
        { source: "json", path: "artifacts/r.json", key: "m.acc" },
        { stdout: "", artifacts: new Map([["artifacts/r.json", '{"m":{"acc":79.88}}']]) },
      ),
    ).resolves.toMatchObject({ ok: true, value: 79.88 });
    await expect(
      parseMetric({ source: "json", path: "artifacts/r.json", key: "m.acc" }, { stdout: "", artifacts: new Map() }),
    ).resolves.toMatchObject({ ok: false });
    expect(convertUnit(0.7988, "fraction", "percent")).toBeCloseTo(79.88);
    expect(convertUnit(79.88, "percent", "fraction")).toBeCloseTo(0.7988);
  });

  it("stops a catastrophic pattern instead of hanging the service", async () => {
    await expect(matchAllBounded("(a+)+$", `${"a".repeat(40)}!`, 200)).rejects.toThrow(/did not finish/u);
  });
});

const review = (overrides: Partial<Review> = {}): Review => ({
  verdict: "approve",
  equivalence: "equivalent",
  summary: "ok",
  checks: [
    { name: "a", passed: true, explanation: "x" },
    { name: "b", passed: true, explanation: "x" },
    { name: "c", passed: true, explanation: "x" },
  ],
  concerns: [],
  ...overrides,
});

function outcome(value: number | null, overrides: Partial<EngineerOutcome> = {}): EngineerOutcome {
  return {
    engineerAgentId: `agt_${Math.random()}`,
    label: "engineer-1",
    agentStatus: "completed",
    agentReason: null,
    submission: { status: "measured", summary: "s", officialReceiptId: "rcp", deviations: [], failureReason: null },
    official: {
      receiptId: "rcp",
      argv: ["python", "train.py"],
      cwd: "/workspace/case/work/repo",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdoutSha256: SHA,
    },
    metric: value === null ? { ok: false, reason: "no match" } : { ok: true, value, unit: null, source: "stdout", matches: 1 },
    value,
    review: review(),
    reviewerAgentId: "agt_r",
    dependencyRequest: null,
    ...overrides,
  };
}

describe("status from evidence", () => {
  const base = { cancelled: false, failure: null, policyViolations: [], stopReasons: [], adapter: false, engineersLaunched: 1 };
  const contract = contractFor({ requirements: [] });

  it("reproduces only an approved, equivalent measurement within tolerance", () => {
    expect(decideStatus({ ...base, contract, outcomes: [outcome(80.1)] }).status).toBe("reproduced");
    expect(decideStatus({ ...base, contract, outcomes: [outcome(70)] }).status).toBe("not_reproduced");
    expect(
      decideStatus({ ...base, contract, outcomes: [outcome(80.1, { review: review({ equivalence: "minor_deviations" }) })] }).status,
    ).toBe("partially_reproduced");
    expect(decideStatus({ ...base, adapter: true, contract, outcomes: [outcome(80.1)] }).status).toBe("partially_reproduced");
    expect(
      decideStatus({
        ...base,
        contract: contractFor({ requirements: [], compatibilityConstraints: [{ requirement: "numpy<2", reason: "old API" }] }),
        outcomes: [outcome(80.1)],
      }).status,
    ).toBe("partially_reproduced");
  });

  it("never counts a failed run, an unparsed metric, or a rejected or non-equivalent review", () => {
    const failedRun = outcome(80, {
      official: { receiptId: "r", argv: [], cwd: "", exitCode: 1, timedOut: false, durationMs: 1, stdoutSha256: SHA },
    });
    expect(decideStatus({ ...base, contract, outcomes: [failedRun] }).status).toBe("inconclusive");
    expect(decideStatus({ ...base, contract, outcomes: [outcome(null)] }).status).toBe("inconclusive");
    expect(decideStatus({ ...base, contract, outcomes: [outcome(80, { review: review({ verdict: "reject" }) })] }).status).toBe(
      "inconclusive",
    );
    expect(decideStatus({ ...base, contract, outcomes: [outcome(80, { review: review({ equivalence: "not_equivalent" }) })] }).status).toBe(
      "inconclusive",
    );
    expect(decideStatus({ ...base, contract, outcomes: [outcome(80, { review: null })] }).status).toBe("inconclusive");
    expect(decideStatus({ ...base, contract, outcomes: [outcome(80, { official: null })] }).status).toBe("inconclusive");
  });

  it("requires agreeing engineers", () => {
    const two = { ...base, engineersLaunched: 2, contract };
    expect(decideStatus({ ...two, outcomes: [outcome(80, { label: "e1" }), outcome(80.5, { label: "e2" })] }).status).toBe("reproduced");
    expect(decideStatus({ ...two, outcomes: [outcome(80, { label: "e1" }), outcome(60, { label: "e2" })] }).status).toBe("inconclusive");
    expect(decideStatus({ ...two, outcomes: [outcome(80, { label: "e1" })] }).status).toBe("inconclusive");
  });

  it("maps cancellation, infrastructure failure, and policy blocks first", () => {
    expect(decideStatus({ ...base, cancelled: true, contract, outcomes: [outcome(80)] }).status).toBe("cancelled");
    expect(decideStatus({ ...base, failure: "docker down", contract, outcomes: [] }).status).toBe("failed");
    expect(decideStatus({ ...base, policyViolations: ["gpu"], contract: null, outcomes: [] }).status).toBe("policy_blocked");
    expect(decideStatus({ ...base, stopReasons: ["no claim"], contract: null, outcomes: [] })).toMatchObject({
      status: "inconclusive",
      reasons: ["no claim"],
    });
  });

  it("lets the Supervisor only lower the status", () => {
    expect(applySupervisor("reproduced", "partially_reproduced")).toEqual({ status: "partially_reproduced", overridden: true });
    expect(applySupervisor("inconclusive", "reproduced")).toEqual({ status: "inconclusive", overridden: false });
    expect(applySupervisor("not_reproduced", "reproduced")).toEqual({ status: "not_reproduced", overridden: false });
    expect(applySupervisor("partially_reproduced", "reproduced")).toEqual({ status: "partially_reproduced", overridden: false });
    expect(applySupervisor("policy_blocked", "reproduced")).toEqual({ status: "policy_blocked", overridden: false });
    expect(applySupervisor("failed", "inconclusive")).toEqual({ status: "failed", overridden: false });
  });

  it("maps statuses to terminal stages and run states", () => {
    expect(terminalStageFor("partially_reproduced")).toBe("completed");
    expect(terminalStageFor("policy_blocked")).toBe("policy_blocked");
    expect(runStatusFor("policy_blocked")).toBe("inconclusive");
    expect(runStatusFor("failed")).toBe("failed");
    expect(runStatusFor("cancelled")).toBe("cancelled");
  });
});
