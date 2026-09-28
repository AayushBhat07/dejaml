import {
  type CodeAnalysis,
  type ExperimentPlan,
  ExperimentPolicySchema,
  type PaperAnalysis,
} from "@dejaml/contracts";

const repositoryUrl = "https://github.com/mtesha/tdl-vs-ml-urbanlandcover";
const commitSha = "49ece7ff4cc43fd4cb258678d44854f1cb2a417d";

const claim: ExperimentPlan["claim"] = {
  experimentLabel: "Random Forest on UCI Urban Land Cover",
  dataset: "UCI Urban Land Cover",
  split: "official test set",
  model: "Random Forest",
  metric: { name: "accuracy", unit: "percent", reportedValue: 81.66 },
  seed: null,
  hyperparameters: { nEstimators: 30 },
  evidence: [{ kind: "paper_page", reference: "page 4, Table 2" }],
  missingFields: ["validation split seed"],
  confidence: "high",
};

export const policyFixture = ExperimentPolicySchema.parse({
  schemaVersion: 1,
  caseId: "urban-land-cover-random-forest",
  repository: {
    url: repositoryUrl,
    commitSha,
    approvedEntrypoints: ["Urban Land Cover Classification.ipynb"],
  },
  claim: {
    dataset: "UCI Urban Land Cover",
    model: "Random Forest",
    metricNames: ["accuracy", "test accuracy"],
    unit: "percent",
    reportedValue: 81.66,
  },
  dataset: {
    name: "UCI Urban Land Cover",
    sourceUrl: "https://archive.ics.uci.edu/static/public/295/urban%2Bland%2Bcover.zip",
    sha256: "277a27000a4a4b593f655595b92904ccb30ece48b8bb2a35cf5d3854d7204f79",
    expectedPaths: ["data/training.csv", "data/testing.csv"],
  },
  preparation: [],
  trustedExecutionAdapter: {
    source: "curated_case",
    path: "cases/urban-land-cover/runner.py",
    sha256: "276fa3d9b5d4677139c20ab71ceee491b7c849b74278b9a655c122ade8460f6b",
  },
  command: {
    executable: "python",
    args: ["runner.py", "--training", "data/training.csv", "--testing", "data/testing.csv", "--output", "artifacts/result.json"],
    cwd: "/workspace/case",
    env: {},
  },
  maximumResources: {
    cpus: 2,
    memoryMb: 2048,
    pids: 128,
    timeoutSeconds: 120,
    networkDuringRun: false,
  },
  metricExtraction: { source: "json", path: "artifacts/result.json", key: "metrics.accuracyPercent" },
  maximumAttempts: 1,
  requiredStopConditions: ["dataset digest mismatch", "repository commit mismatch", "timeout or resource limit"],
  allowedStopConditions: [
    "dataset digest mismatch",
    "repository commit mismatch",
    "timeout or resource limit",
    "metric artifact missing or invalid",
  ],
});

export const planFixture: ExperimentPlan = {
  caseId: policyFixture.caseId,
  repository: { url: repositoryUrl, commitSha },
  claim,
  dataset: policyFixture.dataset,
  preparation: [],
  executionAdapter: policyFixture.trustedExecutionAdapter,
  command: policyFixture.command,
  resources: policyFixture.maximumResources,
  metricExtraction: policyFixture.metricExtraction,
  maxAttempts: 1,
  stopConditions: [...policyFixture.requiredStopConditions],
};

export const paperFixture: PaperAnalysis = {
  schemaVersion: 1,
  status: "ready",
  summary: "Found the reviewed claim.",
  selectedRepositoryUrl: repositoryUrl,
  claim,
  reasons: [],
  warnings: [],
};

export const codeFixture: CodeAnalysis = {
  schemaVersion: 1,
  status: "ready",
  summary: "Mapped the reviewed notebook.",
  mapping: {
    repositoryUrl,
    commitSha,
    entrypoint: "Urban Land Cover Classification.ipynb",
    relevantFiles: [{ path: "Urban Land Cover Classification.ipynb", sha256: "a".repeat(64), reason: "reviewed experiment" }],
    dependencyFiles: [],
    datasetReferences: ["UCI Urban Land Cover"],
    candidateCommand: null,
    metricEvidence: [{ kind: "repository_file", reference: "Urban Land Cover Classification.ipynb" }],
    warnings: [],
  },
  reasons: [],
  warnings: [],
};
