import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExperimentPolicySchema } from "@dejaml/contracts";
import { ingestPdf } from "@dejaml/paper-intake";
import {
  acquireGithubRepository,
  cleanupAcquiredRepository,
  discoverGithubRepositories,
} from "@dejaml/repository-intake";
import { RunStore } from "@dejaml/run-store";

import {
  OpenClawGatewayStructuredClient,
  runLeadResearch,
  runParallelAnalysis,
} from "../dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../../..");
const policy = ExperimentPolicySchema.parse(
  JSON.parse(await readFile(resolve(projectRoot, "cases/urban-land-cover/policy.json"), "utf8")),
);
const paperUrl = "https://arxiv.org/pdf/2609.19010";
const openClawBinary = process.env.OPENCLAW_BIN ?? "openclaw";
const acquisitionRoot = await mkdtemp(join(tmpdir(), "dejaml-live-plan-"));
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
  if (!candidates.some((candidate) => candidate.repositoryUrl === policy.repository.url)) {
    throw new Error("curated repository was not discovered in the paper");
  }
  acquisition = await acquireGithubRepository({
    repositoryUrl: policy.repository.url,
    destinationRoot: acquisitionRoot,
  });
  if (acquisition.commitSha !== policy.repository.commitSha) {
    throw new Error(`expected commit ${policy.repository.commitSha}, received ${acquisition.commitSha}`);
  }

  const runId = `run_curated_plan_${Date.now()}`;
  store.createRun({ paperUrl, repositoryUrl: policy.repository.url }, runId);
  store.transitionRun(runId, "ingesting");
  store.transitionRun(runId, "discovering_repository");
  const client = new OpenClawGatewayStructuredClient({
    binaryPath: openClawBinary,
    analystAgents: {
      paper_analyst: process.env.DEJAML_PAPER_AGENT ?? "dejaml-paper",
      code_analyst: process.env.DEJAML_CODE_AGENT ?? "dejaml-code",
      lead_researcher: process.env.DEJAML_LEAD_AGENT ?? "dejaml-lead",
    },
    timeoutSeconds: 180,
    thinking: "low",
  });
  const startedAt = Date.now();
  const analyses = await runParallelAnalysis({
    runId,
    runStore: store,
    paper,
    repositoryCandidates: candidates,
    acquisition,
    modelClient: client,
    targetHint: { model: "Random Forest", dataset: "UCI Urban Land Cover", metric: "accuracy" },
  });
  const lead = await runLeadResearch({
    runId,
    runStore: store,
    paperAnalysis: analyses.paper.value,
    codeAnalysis: analyses.code.value,
    policy,
    modelClient: client,
  });
  if (!lead.policy?.approved) {
    const failedChecks = lead.policy?.checks.filter((check) => !check.passed).map((check) => check.id) ?? [];
    throw new Error(
      `curated plan did not pass deterministic policy: ${failedChecks.join(", ") || "no policy result"}; ` +
        `lead=${lead.decision.value.status}; reasons=${lead.decision.value.reasons.join(" | ")}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        paperStatus: analyses.paper.value.status,
        codeStatus: analyses.code.value.status,
        leadStatus: lead.decision.value.status,
        policyApproved: lead.policy.approved,
        planDigest: lead.policy.planDigest,
        failedPolicyChecks: lead.policy.checks.filter((check) => !check.passed).map((check) => check.id),
        finalRunStatus: store.getRun(runId).status,
        events: store.listEvents(runId).map((event) => ({
          sequence: event.sequence,
          actor: event.actor,
          type: event.type,
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
    await cleanupAcquiredRepository({ destination: acquisition.destination, destinationRoot: acquisitionRoot });
  }
  await rm(acquisitionRoot, { recursive: true, force: true });
}
