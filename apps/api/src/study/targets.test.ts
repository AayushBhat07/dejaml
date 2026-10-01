import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlatformSpec } from "@dejaml/contracts";
import { ingestPdf } from "@dejaml/paper-intake";
import { describe, expect, it } from "vitest";

import { reconcile, reviewPolicy } from "./contract.js";
import type { PaperClaim, Plan } from "./roles.js";
import {
  checkTargetPaper,
  claimMismatch,
  loadClaimTarget,
  loadReviewedTargets,
  paperAnalystTarget,
  plannerTarget,
  repositoryAnalystTarget,
  ReviewedTargetError,
  targetSummary,
} from "./targets.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const registry = join(root, "config/reviewed-targets");
const COMMIT = "1f8a8285a70e357274351c0935b5fc332be0e735";

async function pyts() {
  const target = (await loadReviewedTargets(registry, root)).get("pyts-boss-gunpoint");
  if (!target) throw new Error("the pyts target is missing");
  return target;
}

async function rawPyts(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(registry, "pyts-boss-gunpoint.json"), "utf8")) as Record<string, unknown>;
}

const verified: PaperClaim = {
  method: "BOSS transformer followed by a one-nearest neighbor classifier with the BOSS metric",
  dataset: "UCR GunPoint",
  split: "fixed UCR train/test split",
  preprocessing: "not stated",
  seedPolicy: "not stated",
  metric: { name: "accuracy", unit: "fraction" },
  reportedValue: 1,
  page: 4,
  location: "Table 2, row pyts, column GunPoint",
  excerpt: "pyts 0.752 0.870 1.000 0.526 1.000",
  missingFields: [],
};

const plan: Plan = {
  status: "ready",
  summary: "Run the official notebook through the reviewed adapter.",
  blockedReason: null,
  entrypoint: "0.10.0/BOSS.ipynb",
  command: { argv: ["python", "../work/adapter/run_boss_notebook.py", "0.10.0/BOSS.ipynb", "GunPoint"], cwd: "repo" },
  python: "3.11",
  requirements: [
    "pyts==0.10.0",
    "numpy==1.23.5",
    "scipy==1.9.3",
    "scikit-learn==1.1.3",
    "joblib==1.2.0",
    "threadpoolctl==3.1.0",
    "numba==0.57.1",
    "llvmlite==0.40.1",
  ],
  compatibilityConstraints: [{ requirement: "pip<24.1", reason: "installer only" }],
  dataset: { name: "UCR GunPoint", source: { kind: "package", package: "pyts", path: "datasets/cached_datasets/UCR/GunPoint" } },
  metricParser: { source: "stdout", pattern: "Accuracy on the test set: (\\d\\.\\d{3})" },
  expectedRuntimeSeconds: 120,
  stopConditions: ["the command exits non-zero"],
  adapter: null,
  risks: [],
};

const screen = { screen: () => ({ refused: [] }) };
const dependencies = {
  ...screen,
  check: async () => ({ ok: true, detail: {} }),
  prepare: async () => {
    throw new Error("unused");
  },
  release: async () => ({ removed: true }),
};

async function review(changes: Partial<Plan> = {}, trusted = [{ requirement: "pip<24.1", reason: "installer only" }]) {
  const target = await pyts();
  const adapter = changes.adapter === undefined ? reviewedAdapter(target) : changes.adapter;
  const reconciled = reconcile({
    claim: verified,
    plan: { ...plan, ...changes, adapter },
    repository: { url: target.repository.url, commitSha: COMMIT },
    platform: buildPlatformSpec({ architecture: "arm64", python: "3.11" }),
    tolerance: target.tolerance,
  });
  if (!reconciled.ok) throw new Error(reconciled.reasons.join("; "));
  return reviewPolicy({
    contract: reconciled.contract,
    adapter,
    repository: { commitSha: COMMIT, files: new Set(["0.10.0/BOSS.ipynb", "README.md"]) },
    datasetPolicy: { allowedHosts: [], maxRedirects: 3, maxBytes: 1024, timeoutMs: 1000 } as never,
    dependencies,
    commandTimeoutSeconds: 900,
    trustedConstraints: trusted,
    target,
  });
}

function reviewedAdapter(target: Awaited<ReturnType<typeof pyts>>): Plan["adapter"] {
  const { id: _id, sha256: _sha, ...adapter } = target.adapter!;
  return adapter;
}

describe("reviewed claim targets", () => {
  it("loads the pyts target from the server registry with its adapter checked against the reviewed hash", async () => {
    const target = await pyts();
    expect(target).toMatchObject({
      caseId: "pyts-boss-gunpoint",
      claim: { page: 4, reportedValue: 1, metric: { unit: "fraction" } },
      repository: { url: "https://github.com/johannfaouzi/pyts-repro", commitSha: COMMIT, entrypoint: "0.10.0/BOSS.ipynb" },
      maximumVerdict: "partially_reproduced",
    });
    expect(target.adapter?.content).toContain("BOSS.ipynb");
    expect(Object.isFrozen(target)).toBe(true);
  });

  it("refuses a tampered adapter, an excerpt without the value, and any field outside the schema", async () => {
    const raw = await rawPyts();
    const dir = await mkdtemp(join(tmpdir(), "dejaml-target-"));
    try {
      await mkdir(join(dir, "acceptance/proof"), { recursive: true });
      await writeFile(join(dir, "acceptance/proof/pyts_run_boss_notebook.py"), "print('changed')\n");
      await expect(loadClaimTarget(raw, dir)).rejects.toThrow(/does not match its reviewed hash/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const claim = raw.claim as Record<string, unknown>;
    await expect(loadClaimTarget({ ...raw, claim: { ...claim, excerpt: "Table 2: Accuracy scores" } }, root)).rejects.toThrow(
      /does not contain the reported value/u,
    );
    // A target never carries an observed result, a command, or anything else unreviewed.
    await expect(loadClaimTarget({ ...raw, observedValue: 1 }, root)).rejects.toBeInstanceOf(ReviewedTargetError);
    await expect(loadClaimTarget({ ...raw, command: ["python", "x.py"] }, root)).rejects.toBeInstanceOf(ReviewedTargetError);
  });

  it("matches only the reviewed paper, whose cited page holds the reviewed excerpt", async () => {
    const target = await pyts();
    const data = new Uint8Array(await readFile(join(root, "acceptance/papers/pyts-jmlr-2020-19-763.pdf")));
    const paper = await ingestPdf({ fileName: "pyts.pdf", data });
    expect(checkTargetPaper(target, { sha256: paper.file.sha256, pages: paper.pages })).toBeNull();
    expect(checkTargetPaper(target, { sha256: "0".repeat(64), pages: paper.pages })).toMatch(/not the one reviewed/u);
    const otherPage = paper.pages.map((page) => (page.pageNumber === 4 ? { ...page, text: "nothing here" } : page));
    expect(checkTargetPaper(target, { sha256: paper.file.sha256, pages: otherPage })).toMatch(/not on page 4/u);
  });

  it("recognizes the Table 2 BOSS/GunPoint claim and refuses the BOSSVS listing claim", async () => {
    const target = await pyts();
    expect(claimMismatch(target, verified)).toBeNull();
    const listing: PaperClaim = {
      ...verified,
      method: "BOSSVS",
      dataset: "GunPoint",
      reportedValue: 0.98,
      page: 3,
      location: "Listing 1",
      excerpt: "0.98",
    };
    expect(claimMismatch(target, listing)).toMatch(/page 3 instead of 4.*reported value 0.98 instead of 1.*method "BOSSVS"/u);
    expect(claimMismatch(target, { ...verified, dataset: "ECG200" })).toMatch(/dataset "ECG200"/u);
  });

  it("tells each agent only what its role needs, and never an observed result", async () => {
    const target = await pyts();
    const analyst = JSON.stringify(paperAnalystTarget(target));
    expect(analyst).not.toContain(target.claim.excerpt);
    expect(analyst).toContain("Table 2");
    const repository = JSON.stringify(repositoryAnalystTarget(target));
    expect(repository).toContain(COMMIT);
    expect(repository).not.toContain("reportedValue");
    const planner = plannerTarget(target);
    expect(planner).toMatchObject({ reviewedAdapter: { id: "pyts-boss-notebook-runner" }, metricParser: target.metricParser });
    for (const view of [analyst, repository, JSON.stringify(planner), JSON.stringify(targetSummary(target))]) {
      expect(view).not.toMatch(/observed/iu);
    }
    expect(JSON.stringify(targetSummary(target))).not.toContain("exec(compile");
  });

  it("approves a plan that fits the reviewed limits, and caps nothing by itself", async () => {
    const result = await review();
    expect(result.violations).toEqual([]);
    expect(result.outcome).toBe("approved");
    expect(result.warnings.join(" ")).toContain("adapter");
  });

  it("refuses a plan that strays from the reviewed claim, entry point, parser, environment, or adapter", async () => {
    const target = await pyts();
    const cases: Array<[Partial<Plan>, RegExp]> = [
      [{ entrypoint: "0.10.0/BOSSVS.ipynb" }, /entry point/u],
      [{ requirements: [...plan.requirements, "pandas==2.2.0"] }, /outside the reviewed set: pandas==2.2.0/u],
      [{ metricParser: { source: "stdout", pattern: "accuracy: ([0-9.]+)" } }, /metric parser/u],
      [{ python: "3.12" }, /Python 3.12/u],
      [{ expectedRuntimeSeconds: 3_600 }, /runtime exceeds/u],
      [{ dataset: { name: "GunPoint", source: { kind: "repository", paths: ["README.md"] } } }, /dataset source/u],
      [{ adapter: { ...reviewedAdapter(target)!, content: `${target.adapter!.content}\n# changed\n` } }, /not the reviewed adapter/u],
    ];
    for (const [changes, reason] of cases) {
      const result = await review(changes);
      expect(result.outcome, String(reason)).not.toBe("approved");
      expect(result.violations.join("; ")).toMatch(reason);
    }
  });

  it("never relaxes policy: a constraint the target allows is still refused unless the trusted file lists it", async () => {
    const result = await review({}, []);
    expect(result.outcome).toBe("policy_blocked");
    expect(result.violations.join(" ")).toContain("not in the project's trusted constraints file");
  });
});

describe("the Urban Land Cover reviewed target", () => {
  const URBAN_COMMIT = "49ece7ff4cc43fd4cb258678d44854f1cb2a417d";
  const DATASET = {
    kind: "download" as const,
    url: "https://archive.ics.uci.edu/static/public/295/urban%2Bland%2Bcover.zip",
    sha256: "277a27000a4a4b593f655595b92904ccb30ece48b8bb2a35cf5d3854d7204f79",
    extract: true,
  };
  const claim: PaperClaim = {
    method: "Random Forest classifier",
    dataset: "UCI Urban Land Cover",
    split: "the official UCI test set",
    preprocessing: "z-score scaling",
    seedPolicy: "fixed seeds, not listed",
    metric: { name: "test accuracy", unit: "percent" },
    reportedValue: 81.66,
    page: 4,
    location: "Table 2, row Random Forest",
    excerpt: "81.66",
    missingFields: [],
  };
  const urbanPlan: Plan = {
    status: "ready",
    summary: "Run the reviewed adapter on the official CSVs.",
    blockedReason: null,
    entrypoint: "Urban Land Cover Classification.ipynb",
    command: {
      argv: [
        "python",
        "../work/adapter/urban_land_cover_runner.py",
        "--training",
        "../data/extracted/urban+land+cover/training.csv",
        "--testing",
        "../data/extracted/urban+land+cover/testing.csv",
        "--output",
        "../artifacts/result.json",
      ],
      cwd: "repo",
    },
    python: "3.12",
    requirements: ["numpy==2.5.3", "pandas==3.0.6", "scipy==1.18.1", "scikit-learn==1.9.1"],
    compatibilityConstraints: [],
    dataset: { name: "UCI Urban Land Cover", source: DATASET },
    metricParser: { source: "json", path: "artifacts/result.json", key: "metrics.accuracyPercent" },
    expectedRuntimeSeconds: 60,
    stopConditions: ["the command exits non-zero"],
    adapter: null,
    risks: [],
  };

  async function urban() {
    const target = (await loadReviewedTargets(registry, root)).get("urban-land-cover-random-forest");
    if (!target) throw new Error("the urban target is missing");
    return target;
  }

  async function reviewUrban(changes: Partial<Plan> = {}) {
    const target = await urban();
    const { id: _id, sha256: _sha, ...reviewed } = target.adapter!;
    const adapter = changes.adapter === undefined ? reviewed : changes.adapter;
    const reconciled = reconcile({
      claim,
      plan: { ...urbanPlan, ...changes, adapter },
      repository: { url: target.repository.url, commitSha: URBAN_COMMIT },
      platform: buildPlatformSpec({ architecture: "arm64", python: "3.12" }),
      tolerance: target.tolerance,
    });
    if (!reconciled.ok) throw new Error(reconciled.reasons.join("; "));
    return reviewPolicy({
      contract: reconciled.contract,
      adapter,
      repository: { commitSha: URBAN_COMMIT, files: new Set(["Urban Land Cover Classification.ipynb", "README.md"]) },
      datasetPolicy: { allowedHosts: ["archive.ics.uci.edu"], maxRedirects: 3, maxBytes: 5 * 1024 * 1024, timeoutMs: 1000 } as never,
      dependencies,
      commandTimeoutSeconds: 900,
      trustedConstraints: [],
      target,
    });
  }

  it("loads with its paper, pinned commit, dataset hash, metric parser and hash-checked adapter", async () => {
    const target = await urban();
    expect(target).toMatchObject({
      caseId: "urban-land-cover-random-forest",
      paper: { sha256: "13b0c3fb3c2823f78eb650f918aa521493bddd6eccb55a2b9857c37d44d0a6a1" },
      claim: { page: 4, reportedValue: 81.66, metric: { unit: "percent" } },
      repository: {
        url: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover",
        commitSha: URBAN_COMMIT,
        entrypoint: "Urban Land Cover Classification.ipynb",
      },
      dataset: { source: DATASET },
      metricParser: { source: "json", path: "artifacts/result.json", key: "metrics.accuracyPercent" },
      tolerance: 1,
      maximumVerdict: "partially_reproduced",
    });
    expect(target.adapter?.sha256).toBe("9156565eb6cac1679f266ee03644dc377fc87934c8ced1a903e167999e591476");
  });

  it("labels the adapter as project-owned and lists every known difference from the paper", async () => {
    const target = await urban();
    const differences = target.adapter!.differences.join("\n");
    expect(target.adapter!.content).toContain("reviewed adapter (project-owned, NOT official repository code)");
    expect(differences).toMatch(/project-owned adapter, not official repository code/u);
    expect(differences).toMatch(/random_state unset.*42/u);
    expect(differences).toMatch(/stratif/u);
    expect(differences).toMatch(/z-scores the test set independently/u);
    expect(differences).toMatch(/urbantraining\.csv/u);
  });

  it("never carries the paper value or a prior observed value in anything an agent can see", async () => {
    const target = await urban();
    // The adapter never prints the paper's number, so a run cannot echo it; 79.88 was the earlier deterministic result.
    expect(target.adapter!.content).not.toMatch(/81\.66|79\.88/u);
    const raw = await readFile(join(registry, "urban-land-cover-random-forest.json"), "utf8");
    expect(raw).not.toContain("79.88");
    for (const view of [paperAnalystTarget(target), repositoryAnalystTarget(target), plannerTarget(target), targetSummary(target)]) {
      expect(JSON.stringify(view)).not.toMatch(/79\.88|observed/iu);
    }
  });

  it("approves the faithful plan and refuses one that changes the dataset, parser or Python", async () => {
    const approved = await reviewUrban();
    expect(approved.violations).toEqual([]);
    expect(approved.outcome).toBe("approved");
    const cases: Array<[Partial<Plan>, RegExp]> = [
      [{ dataset: { name: "UCI Urban Land Cover", source: { ...DATASET, sha256: "0".repeat(64) } } }, /dataset download/u],
      [{ dataset: { name: "UCI Urban Land Cover", source: { ...DATASET, extract: false } } }, /dataset download/u],
      [{ metricParser: { source: "json", path: "artifacts/result.json", key: "metrics.f1" } }, /metric parser/u],
      [{ python: "3.11" }, /Python 3.11/u],
      [{ requirements: [...urbanPlan.requirements, "xgboost==2.1.0"] }, /outside the reviewed set/u],
    ];
    for (const [changes, reason] of cases) {
      const result = await reviewUrban(changes);
      expect(result.outcome, String(reason)).not.toBe("approved");
      expect(result.violations.join("; ")).toMatch(reason);
    }
  });

  it("refuses a different claim from the same table", async () => {
    const target = await urban();
    expect(claimMismatch(target, claim)).toBeNull();
    expect(claimMismatch(target, { ...claim, method: "XGBoost", reportedValue: 83.1 })).toMatch(/reported value 83.1 instead of 81.66/u);
  });
});
