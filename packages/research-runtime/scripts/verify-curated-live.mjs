import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestPdf } from "@dejaml/paper-intake";
import {
  acquireGithubRepository,
  cleanupAcquiredRepository,
  discoverGithubRepositories,
} from "@dejaml/repository-intake";
import { RunStore } from "@dejaml/run-store";

import {
  OpenClawGatewayStructuredClient,
  runParallelAnalysis,
} from "../dist/index.js";

const paperUrl = "https://arxiv.org/pdf/2609.19010";
const repositoryUrl = "https://github.com/mtesha/tdl-vs-ml-urbanlandcover";
const expectedCommit = "49ece7ff4cc43fd4cb258678d44854f1cb2a417d";
const openClawBinary = process.env.OPENCLAW_BIN ?? "openclaw";
const acquisitionRoot = await mkdtemp(join(tmpdir(), "dejaml-live-analysis-"));
let acquisition;
const store = new RunStore();

try {
  const response = await fetch(paperUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`paper download returned HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 20 * 1024 * 1024) throw new Error("paper exceeds the demo intake limit");
  const paper = await ingestPdf({
    fileName: "2609.19010.pdf",
    data: new Uint8Array(await response.arrayBuffer()),
  });
  const candidates = discoverGithubRepositories(paper);
  if (!candidates.some((candidate) => candidate.repositoryUrl === repositoryUrl)) {
    throw new Error("curated repository was not discovered in the paper");
  }
  acquisition = await acquireGithubRepository({ repositoryUrl, destinationRoot: acquisitionRoot });
  if (acquisition.commitSha !== expectedCommit) {
    throw new Error(`expected commit ${expectedCommit}, received ${acquisition.commitSha}`);
  }

  const runId = "run_curated_live_verification";
  store.createRun({ paperUrl, repositoryUrl }, runId);
  store.transitionRun(runId, "ingesting");
  store.transitionRun(runId, "discovering_repository");
  const client = new OpenClawGatewayStructuredClient({
    binaryPath: openClawBinary,
    analystAgents: {
      paper_analyst: process.env.DEJAML_PAPER_AGENT ?? "dejaml-paper",
      code_analyst: process.env.DEJAML_CODE_AGENT ?? "dejaml-code",
    },
    timeoutSeconds: 180,
    thinking: "low",
  });
  const startedAt = Date.now();
  const result = await runParallelAnalysis({
    runId,
    runStore: store,
    paper,
    repositoryCandidates: candidates,
    acquisition,
    modelClient: client,
    targetHint: {
      model: "Random Forest",
      dataset: "UCI Urban Land Cover",
      metric: "accuracy",
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        paperStatus: result.paper.value.status,
        codeStatus: result.code.value.status,
        paperSummary: result.paper.value.summary,
        codeSummary: result.code.value.summary,
        paperReasons: result.paper.value.reasons,
        codeReasons: result.code.value.reasons,
        selectedModel: result.paper.value.claim?.model ?? null,
        selectedMetric: result.paper.value.claim?.metric ?? null,
        mappedEntrypoint: result.code.value.mapping?.entrypoint ?? null,
        finalRunStatus: store.getRun(runId).status,
        events: store.listEvents(runId).map((event) => ({
          sequence: event.sequence,
          actor: event.actor,
          status: event.status,
        })),
        elapsedMs: Date.now() - startedAt,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  store.close();
  if (acquisition) {
    await cleanupAcquiredRepository({
      destination: acquisition.destination,
      destinationRoot: acquisitionRoot,
    });
  }
  await rm(acquisitionRoot, { recursive: true, force: true });
}
