import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CodeAnalysis,
  type PaperAnalysis,
  type PaperDocument,
  type RepositoryAcquisition,
  type RepositoryCandidate,
} from "@dejaml/contracts";
import { RunStore } from "@dejaml/run-store";
import { afterEach, describe, expect, it } from "vitest";

import { type StructuredCompletionRequest, type StructuredModelClient } from "./model.js";
import { ParallelAnalysisError, runParallelAnalysis } from "./orchestrator.js";

const repositoryUrl = "https://github.com/mtesha/tdl-vs-ml-urbanlandcover";
const commitSha = "49ece7ff4cc43fd4cb258678d44854f1cb2a417d";

function paperFixture(): PaperDocument {
  const texts = [
    "Urban Land Cover classification study.",
    "The implementation is at https://github.com/mtesha/tdl-vs-ml-urbanlandcover.",
    "We evaluate classical models on the official test split.",
    "Table 2 reports Random Forest accuracy of 81.66 percent with 30 estimators.",
  ];
  return {
    schemaVersion: 1,
    file: { originalName: "paper.pdf", bytes: 1000, sha256: "a".repeat(64) },
    pageCount: texts.length,
    pages: texts.map((text, index) => ({ pageNumber: index + 1, text, charCount: text.length })),
    totalTextChars: texts.reduce((sum, text) => sum + text.length, 0),
    warnings: [],
  };
}

function candidateFixture(): RepositoryCandidate {
  return {
    repositoryUrl,
    owner: "mtesha",
    name: "tdl-vs-ml-urbanlandcover",
    occurrences: [{ pageNumber: 2, rawUrl: repositoryUrl }],
  };
}

function paperAnalysis(): PaperAnalysis {
  return {
    schemaVersion: 1,
    status: "ready",
    summary: "Found the Random Forest accuracy claim on page 4.",
    selectedRepositoryUrl: repositoryUrl,
    claim: {
      experimentLabel: "Random Forest on UCI Urban Land Cover",
      dataset: "UCI Urban Land Cover",
      split: "official test split",
      model: "Random Forest",
      metric: { name: "accuracy", unit: "percent", reportedValue: 81.66 },
      seed: null,
      hyperparameters: { nEstimators: 30 },
      evidence: [{ kind: "paper_page", reference: "page 4", excerpt: "81.66 percent" }],
      missingFields: ["seed"],
      confidence: "high",
    },
    reasons: [],
    warnings: ["seed not stated"],
  };
}

async function repositoryFixture(): Promise<{
  acquisition: RepositoryAcquisition;
  readmeSha: string;
  notebookSha: string;
}> {
  const destination = await tempRoot("dejaml-parallel-analysis-test-");
  const readme = "Run the Urban Land Cover notebook.";
  const notebook = JSON.stringify({
    cells: [
      { cell_type: "code", source: ["from sklearn.ensemble import RandomForestClassifier\n"] },
      { cell_type: "code", source: ["print('accuracy')\n"] },
    ],
  });
  await writeFile(join(destination, "README.md"), readme);
  await writeFile(join(destination, "experiment.ipynb"), notebook);
  await mkdir(join(destination, "data"));
  return {
    acquisition: {
      schemaVersion: 1,
      repositoryUrl,
      commitSha,
      defaultBranch: "main",
      repositorySizeKb: 10,
      destination,
      acquiredAt: "2026-09-28T12:00:00.000Z",
    },
    readmeSha: createHash("sha256").update(readme).digest("hex"),
    notebookSha: createHash("sha256").update(notebook).digest("hex"),
  };
}

function codeAnalysis(readmeSha: string, notebookSha: string): CodeAnalysis {
  return {
    schemaVersion: 1,
    status: "ready",
    summary: "Mapped the Random Forest experiment to the notebook.",
    mapping: {
      repositoryUrl,
      commitSha,
      entrypoint: "experiment.ipynb",
      relevantFiles: [
        { path: "README.md", sha256: readmeSha, reason: "run instructions" },
        { path: "experiment.ipynb", sha256: notebookSha, reason: "model and metric" },
      ],
      dependencyFiles: [],
      datasetReferences: ["UCI Urban Land Cover"],
      candidateCommand: null,
      metricEvidence: [{ kind: "repository_file", reference: "experiment.ipynb" }],
      warnings: ["notebook requires conversion before execution"],
    },
    reasons: [],
    warnings: [],
  };
}

function preparedRun(store: RunStore, runId: string): void {
  store.createRun({ paper: "paper.pdf" }, runId);
  store.transitionRun(runId, "ingesting");
  store.transitionRun(runId, "discovering_repository");
}

const tempRoots: string[] = [];
async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("parallel research analysis", () => {
  it("runs independent analysts concurrently and publishes completion events", async () => {
    const fixture = await repositoryFixture();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: StructuredModelClient = {
      async complete<T>(request: StructuredCompletionRequest<T>) {
        active += 1;
        calls += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 2) release?.();
        await barrier;
        const value = request.role === "paper_analyst" ? paperAnalysis() : codeAnalysis(fixture.readmeSha, fixture.notebookSha);
        active -= 1;
        return { value: request.schema.parse(value), provider: "test", model: "test-model" };
      },
    };
    const store = new RunStore();
    preparedRun(store, "run_parallel");

    const result = await runParallelAnalysis({
      runId: "run_parallel",
      runStore: store,
      paper: paperFixture(),
      repositoryCandidates: [candidateFixture()],
      acquisition: fixture.acquisition,
      modelClient: client,
    });

    expect(maxActive).toBe(2);
    expect(result.paper.value.status).toBe("ready");
    expect(result.code.value.status).toBe("ready");
    expect(store.getRun("run_parallel").status).toBe("planning");
    const events = store.listEvents("run_parallel");
    expect(events.map((event) => `${event.actor}:${event.status}`)).toEqual([
      "paper_analyst:started",
      "code_analyst:started",
      "paper_analyst:completed",
      "code_analyst:completed",
    ]);
    store.close();
  });

  it("preserves the successful analyst and ends inconclusive if its peer fails", async () => {
    const fixture = await repositoryFixture();
    const client: StructuredModelClient = {
      async complete<T>(request: StructuredCompletionRequest<T>) {
        if (request.role === "paper_analyst") throw new Error("provider timeout");
        return {
          value: request.schema.parse(codeAnalysis(fixture.readmeSha, fixture.notebookSha)),
        };
      },
    };
    const store = new RunStore();
    preparedRun(store, "run_partial_failure");

    await expect(
      runParallelAnalysis({
        runId: "run_partial_failure",
        runStore: store,
        paper: paperFixture(),
        repositoryCandidates: [candidateFixture()],
        acquisition: fixture.acquisition,
        modelClient: client,
      }),
    ).rejects.toBeInstanceOf(ParallelAnalysisError);

    expect(store.getRun("run_partial_failure").status).toBe("inconclusive");
    expect(store.listEvents("run_partial_failure").map((event) => `${event.actor}:${event.status}`)).toEqual([
      "paper_analyst:started",
      "code_analyst:started",
      "paper_analyst:failed",
      "code_analyst:completed",
    ]);
    store.close();
  });
});
