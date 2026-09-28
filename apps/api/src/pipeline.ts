import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Assessment,
  Attempt,
  ExperimentPlan,
  Metric,
  PaperDocument,
  PlanPolicyResult,
  RepositoryAcquisition,
  RunEvent,
  RunStatus,
} from "@dejaml/contracts";
import { type CleanupReceipt, type LabManager, labSpecFromPlan } from "@dejaml/lab-manager";
import { ingestPdf, PaperIntakeError } from "@dejaml/paper-intake";
import {
  acquireGithubRepository,
  cleanupAcquiredRepository,
  discoverGithubRepositories,
} from "@dejaml/repository-intake";
import { runLeadResearch, runParallelAnalysis, type StructuredModelClient } from "@dejaml/research-runtime";
import { verifyResult } from "@dejaml/result-verifier";
import type { RunStore } from "@dejaml/run-store";

import type { CuratedCase } from "./cases.js";

export type PipelineDependencies = {
  store: RunStore;
  labs: LabManager;
  model: StructuredModelClient;
  cases: CuratedCase[];
  projectRoot: string;
  /** Private working directory for repository checkouts and reports. */
  workRoot: string;
  image: { name: string; expectedImageId: string };
  acquire?: typeof acquireGithubRepository;
};

export type StudyReport = {
  schemaVersion: 1;
  runId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  paper: { name: string; bytes: number; sha256: string; pages: number } | null;
  caseId: string | null;
  repository: { url: string; commitSha: string } | null;
  plan: ExperimentPlan | null;
  policy: PlanPolicyResult | null;
  lab: {
    image: string;
    imageId: string | null;
    attempt: Attempt | null;
    stdout: string;
    stderr: string;
    logsTruncated: boolean;
    cleanup: CleanupReceipt | null;
  } | null;
  metric: Metric | null;
  assessment: Assessment | null;
  failure: string | null;
  events: RunEvent[];
};

class StudyCancelled extends Error {
  constructor() {
    super("study cancelled");
    this.name = "StudyCancelled";
  }
}

/**
 * Runs one study end to end: intake, repository discovery and acquisition,
 * parallel analysis, Lead Researcher and policy, one lab attempt, verification,
 * and cleanup. Every terminal state produces a report and, when a lab existed,
 * a cleanup receipt.
 */
export async function runStudy(
  input: { runId: string; fileName: string; data: Uint8Array; signal: AbortSignal },
  deps: PipelineDependencies,
): Promise<StudyReport> {
  const { runId, signal } = input;
  const { store } = deps;
  const startedAt = new Date().toISOString();
  const report: Omit<StudyReport, "status" | "finishedAt" | "events"> = {
    schemaVersion: 1,
    runId,
    startedAt,
    paper: null,
    caseId: null,
    repository: null,
    plan: null,
    policy: null,
    lab: null,
    metric: null,
    assessment: null,
    failure: null,
  };
  const event = (
    type: string,
    status: RunEvent["status"],
    summary: string,
    publicPayload: Record<string, unknown> = {},
    evidence: RunEvent["evidence"] = [],
  ): void => {
    store.appendEvent({ runId, actor: "system", type, status, summary, evidence, publicPayload });
  };
  const finish = (status: RunStatus): void => {
    if (store.isTerminal(runId)) return;
    try {
      store.transitionRun(runId, status);
    } catch {
      // For example, cancellation arriving during the synchronous comparison step.
      store.transitionRun(runId, "failed");
    }
  };
  const checkCancelled = (): void => {
    if (signal.aborted) throw new StudyCancelled();
  };

  let acquisition: RepositoryAcquisition | null = null;
  const acquisitionRoot = await mkdtemp(join(deps.workRoot, "checkouts-"));
  let activeLabId: string | null = null;
  const onAbort = (): void => {
    if (activeLabId) void deps.labs.cancelLab(activeLabId);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    // 1. Paper intake.
    store.transitionRun(runId, "ingesting");
    let paper: PaperDocument;
    try {
      paper = await ingestPdf({ fileName: input.fileName, data: input.data });
    } catch (error) {
      if (!(error instanceof PaperIntakeError)) throw error;
      event("paper_rejected", "failed", `The paper could not be read: ${error.message}`, { code: error.code });
      report.failure = error.message;
      finish("inconclusive");
      return await finalize();
    }
    report.paper = { name: paper.file.originalName, bytes: paper.file.bytes, sha256: paper.file.sha256, pages: paper.pageCount };
    event(
      "run_created",
      "completed",
      "Study created and paper fingerprint recorded",
      { pages: paper.pageCount, warnings: paper.warnings },
      [{ kind: "artifact", reference: `${paper.file.originalName}#sha256=${paper.file.sha256}` }],
    );
    checkCancelled();

    // 2. Repository discovery: only a reviewed case may proceed.
    store.transitionRun(runId, "discovering_repository");
    const candidates = discoverGithubRepositories(paper);
    const match = deps.cases.find((curated) =>
      candidates.some((candidate) => candidate.repositoryUrl === curated.policy.repository.url),
    );
    if (!match) {
      const summary =
        candidates.length === 0
          ? "No GitHub repository link was found in the paper"
          : "The linked repository is not a supported case in this demo";
      event("repository_unsupported", "warning", summary, {
        candidates: candidates.map((candidate) => candidate.repositoryUrl),
      });
      report.failure = summary;
      finish("inconclusive");
      return await finalize();
    }
    report.caseId = match.policy.caseId;
    const occurrence = candidates.find((candidate) => candidate.repositoryUrl === match.policy.repository.url);
    event(
      "repository_found",
      "completed",
      "Found the implementation repository linked by the paper",
      { repositoryUrl: match.policy.repository.url },
      (occurrence?.occurrences ?? []).map((item) => ({
        kind: "paper_page" as const,
        reference: `page ${item.pageNumber}`,
        excerpt: item.rawUrl,
      })),
    );
    acquisition = await (deps.acquire ?? acquireGithubRepository)({
      repositoryUrl: match.policy.repository.url,
      destinationRoot: acquisitionRoot,
    });
    if (acquisition.commitSha !== match.policy.repository.commitSha) {
      event("repository_commit_mismatch", "failed", "The repository has moved past the reviewed commit", {
        expected: match.policy.repository.commitSha,
        received: acquisition.commitSha,
      });
      report.failure = "repository commit mismatch";
      finish("inconclusive");
      return await finalize();
    }
    report.repository = { url: acquisition.repositoryUrl, commitSha: acquisition.commitSha };
    event("repository_acquired", "completed", "Pinned the repository at the reviewed commit", {
      commitSha: acquisition.commitSha,
    });
    checkCancelled();

    // 3. Parallel analysis, then Lead Researcher and the deterministic policy gate.
    const claim = match.manifest.paper.claim;
    const analyses = await runParallelAnalysis({
      runId,
      runStore: store,
      paper,
      repositoryCandidates: candidates,
      acquisition,
      modelClient: deps.model,
      targetHint: { model: claim.model, dataset: claim.dataset, metric: claim.metric },
      signal,
    });
    checkCancelled();
    const lead = await runLeadResearch({
      runId,
      runStore: store,
      paperAnalysis: analyses.paper.value,
      codeAnalysis: analyses.code.value,
      policy: match.policy,
      modelClient: deps.model,
      signal,
    });
    report.policy = lead.policy;
    report.plan = lead.decision.value.plan;
    if (!lead.policy?.approved || !lead.decision.value.plan) {
      report.failure = lead.policy ? "plan rejected by policy" : "Lead Researcher returned no plan";
      return await finalize();
    }
    const plan = lead.decision.value.plan;
    checkCancelled();
    await cleanupAcquiredRepository({ destination: acquisition.destination, destinationRoot: acquisitionRoot });
    acquisition = null;

    // 4. One attempt in a disposable lab; the lab is destroyed in every outcome.
    const spec = labSpecFromPlan({
      plan,
      runId,
      projectRoot: deps.projectRoot,
      image: deps.image.name,
      expectedImageId: deps.image.expectedImageId,
    });
    report.lab = {
      image: deps.image.name,
      imageId: null,
      attempt: null,
      stdout: "",
      stderr: "",
      logsTruncated: false,
      cleanup: null,
    };
    const lab = report.lab;
    const handle = await deps.labs.createLab(spec);
    activeLabId = handle.labId;
    let labFailure: unknown = null;
    try {
      lab.imageId = handle.imageId;
      checkCancelled();
      await deps.labs.prepareLab(handle.labId, plan.preparation);
      store.transitionRun(runId, "running");
      const outcome = await deps.labs.executeAttempt(handle.labId, {
        number: 1,
        label: "baseline",
        command: plan.command,
        observe: true,
      });
      lab.attempt = outcome.attempt;
      lab.stdout = outcome.stdout.text;
      lab.stderr = outcome.stderr.text;
      lab.logsTruncated = outcome.stdout.truncated || outcome.stderr.truncated;
      if (outcome.attempt.timedOut) {
        finish("timed_out");
      } else if (outcome.attempt.cancelled) {
        finish("cancelled");
      } else {
        // 5. Verification from the exported artifact.
        store.transitionRun(runId, "comparing");
        const path = plan.metricExtraction.path;
        const artifact =
          path && outcome.attempt.artifactDigests[path]
            ? await deps.labs.readArtifact(handle.labId, path).catch(() => undefined)
            : undefined;
        const verification = verifyResult({
          runId,
          plan,
          attempt: outcome.attempt,
          ...(artifact ? { artifact } : {}),
          stdout: outcome.stdout.text,
          tolerance: match.manifest.comparison.tolerance,
          knownDiscrepancies: match.manifest.knownDiscrepancies,
          events: (item) => store.appendEvent(item),
        });
        report.metric = verification.metric;
        report.assessment = verification.assessment;
        finish(verification.assessment.verdict === "inconclusive" ? "inconclusive" : "completed");
      }
    } catch (error) {
      labFailure = error;
    } finally {
      activeLabId = null;
      lab.cleanup = await deps.labs.destroyLab(handle.labId, `run ${store.getRun(runId).status}`);
    }
    if (labFailure) throw labFailure;
    if (!lab.cleanup.verifiedAbsent) report.failure = "lab cleanup could not be verified";
    return await finalize();
  } catch (error) {
    if (error instanceof StudyCancelled || signal.aborted) {
      event("run_cancelled", "warning", "The study was cancelled", {});
      finish("cancelled");
    } else {
      report.failure = error instanceof Error ? error.message : String(error);
      if (!store.isTerminal(runId)) {
        event("run_failed", "failed", "The study stopped because of an internal error", {});
        finish("failed");
      }
    }
    return await finalize();
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (acquisition) {
      await cleanupAcquiredRepository({ destination: acquisition.destination, destinationRoot: acquisitionRoot }).catch(
        () => undefined,
      );
    }
    await rm(acquisitionRoot, { recursive: true, force: true });
  }

  async function finalize(): Promise<StudyReport> {
    const status = store.getRun(runId).status;
    event("run_finished", status === "completed" ? "completed" : "warning", `Study finished: ${status.replaceAll("_", " ")}`, {
      runStatus: status,
      verdict: report.assessment?.verdict ?? null,
    });
    const complete: StudyReport = {
      ...report,
      status,
      finishedAt: new Date().toISOString(),
      events: store.listEvents(runId),
    };
    const reportsDir = join(deps.workRoot, "reports");
    await mkdir(reportsDir, { recursive: true });
    await writeFile(join(reportsDir, `${runId}.json`), `${JSON.stringify(complete, null, 2)}\n`);
    return complete;
  }
}
