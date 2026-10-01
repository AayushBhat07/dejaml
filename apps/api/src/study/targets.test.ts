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
