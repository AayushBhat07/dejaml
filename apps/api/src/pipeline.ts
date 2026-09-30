import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Assessment,
  Attempt,
  AuditDecision,
  ExperimentPlan,
  Metric,
  PaperAnalysis,
  PaperDocument,
  PlanPolicyResult,
  RepositoryAcquisition,
  RepositoryCandidate,
  RunEvent,
  RunStatus,
} from "@dejaml/contracts";
import type { ChatProvider } from "@dejaml/agent-runtime";
import { type ContainerPlatform, containerPlatformFor, hostArchitecture, type ResourceBudgetSchema } from "@dejaml/contracts";
import { type ArtifactContent, type AttemptOutcome, type CleanupReceipt, type LabManager, labSpecFromPlan } from "@dejaml/lab-manager";
import { ingestPdf, PaperIntakeError } from "@dejaml/paper-intake";
import { acquireGithubRepository, cleanupAcquiredRepository, discoverGithubRepositories } from "@dejaml/repository-intake";
import { runAudit, runLabAgent, runLeadResearch, runParallelAnalysis, type StructuredModelClient } from "@dejaml/research-runtime";
import { verifyResult } from "@dejaml/result-verifier";
import type { z } from "zod";
import type { RunStore } from "@dejaml/run-store";

import type { CuratedCase } from "./cases.js";
import {
  type DatasetPort,
  type DependencyPort,
  type LabImagePort,
  type LeakCheck,
  type MultiAgentReport,
  runMultiAgentStudy,
  type StudyConfig,
} from "./study/index.js";

type ResourceBudget = z.infer<typeof ResourceBudgetSchema>;

export type PipelineDependencies = {
  store: RunStore;
  labs: LabManager;
  model: StructuredModelClient;
  cases: CuratedCase[];
  projectRoot: string;
  /** Private working directory for repository checkouts and reports. */
  workRoot: string;
  /** The curated-path lab image; `platform` defaults to this host's Linux platform. */
  image: { name: string; expectedImageId: string; platform?: ContainerPlatform };
  acquire?: typeof acquireGithubRepository;
  /** Experimental tool-driven lab execution; the curated path remains the default. */
  labAgentEnabled?: boolean;
  /**
   * Papers without a reviewed case: separate agents (Supervisor, analysts,
   * planner, engineers, reviewers) run the study in sealed labs.
   */
  multiAgent?: MultiAgentOptions;
};

export type MultiAgentOptions = {
  enabled: boolean;
  /** Trust zone 2; null disables dependency preparation (the plan may then use only the standard library). */
  dependencies: DependencyPort | null;
  /** Resolves the lab image for the approved platform and Python. */
  images: LabImagePort;
  /** Trust zone 4; null disables dataset downloads. */
  datasets: DatasetPort | null;
  config: Omit<StudyConfig, "provider">;
  leakCheck?: LeakCheck;
};

export const DEFAULT_STUDY_RESOURCES: ResourceBudget = {
  cpus: 2,
  memoryMb: 4096,
  pids: 256,
  timeoutSeconds: 1800,
  networkDuringRun: false,
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
  audit: AuditDecision | null;
  /** Present when independent agents ran the study instead of a reviewed plan. */
  study?: MultiAgentReport;
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
  input: {
    runId: string;
    fileName: string;
    data: Uint8Array;
    signal: AbortSignal;
    /** A repository the uploader named; it is tried before links found in the paper. */
    repositoryUrl?: string;
    /** Whose model key drives the agents; recorded without the key itself. Keys are only ever the server's. */
    modelSource?: "server";
    /** Resume a study after a restart from its saved inputs, skipping intake and discovery. */
    resume?: { paper: PaperDocument; candidates: RepositoryCandidate[] };
    /** The configured provider and model the agents use; the key stays inside the provider. */
    agents?: { provider: ChatProvider; selection: { id: string; model: string } };
  },
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
    audit: null,
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
    if (input.resume) {
      const { paper, candidates } = input.resume;
      report.paper = { name: paper.file.originalName, bytes: paper.file.bytes, sha256: paper.file.sha256, pages: paper.pageCount };
      event("run_resumed", "progress", "The service restarted; the study resumes from its saved stages", {});
      if (!deps.multiAgent?.enabled) {
        report.failure = "Autonomous studies are disabled on this server, so the interrupted study cannot resume";
        finish("failed");
        return await finalize();
      }
      return await multiAgentStudy(paper, candidates, deps.multiAgent);
    }
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
    const discovered = discoverGithubRepositories(paper);
    const provided = input.repositoryUrl;
    const candidates: RepositoryCandidate[] = provided
      ? [
          {
            ...(discovered.find((candidate) => candidate.repositoryUrl === provided) ?? {
              repositoryUrl: provided,
              owner: provided.split("/")[3] ?? "",
              name: provided.split("/")[4] ?? "",
              occurrences: [],
            }),
            providedByUser: true,
          },
          ...discovered.filter((candidate) => candidate.repositoryUrl !== provided),
        ]
      : discovered;
    if (input.modelSource) {
      event("model_connection", "completed", "Agents use the server's model connection", {
        source: input.modelSource,
        ...(input.agents ? { provider: input.agents.selection.id, model: input.agents.selection.model } : {}),
      });
    }
    const match = deps.cases.find((curated) => candidates.some((candidate) => candidate.repositoryUrl === curated.policy.repository.url));
    if (!match && deps.multiAgent?.enabled && candidates[0]) {
      return await multiAgentStudy(paper, candidates, deps.multiAgent);
    }
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
    let paperAnalysis: PaperAnalysis | null = null;
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
    paperAnalysis = analyses.paper.value;
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
      platform: deps.image.platform ?? hostContainerPlatform(),
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
    const verifyAndAudit = async (outcome: AttemptOutcome, artifact?: ArtifactContent): Promise<void> => {
      lab.attempt = outcome.attempt;
      lab.stdout = outcome.stdout.text;
      lab.stderr = outcome.stderr.text;
      lab.logsTruncated = outcome.stdout.truncated || outcome.stderr.truncated;
      if (outcome.attempt.timedOut) return finish("timed_out");
      if (outcome.attempt.cancelled) return finish("cancelled");

      store.transitionRun(runId, "comparing");
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
      if (verification.metric && verification.assessment.verdict !== "inconclusive" && paperAnalysis) {
        store.transitionRun(runId, "auditing");
        checkCancelled();
        try {
          const auditResult = await runAudit({
            runId,
            runStore: store,
            paperAnalysis,
            metric: verification.metric,
            assessment: verification.assessment,
            plan,
            modelClient: deps.model,
            signal,
          });
          report.audit = auditResult.decision.value;
        } catch {
          // Semantic audit remains optional; deterministic verification is authoritative.
        }
      }
      finish(verification.assessment.verdict === "inconclusive" ? "inconclusive" : "completed");
    };

    if (deps.labAgentEnabled) {
      const agent = await runLabAgent({
        runId,
        plan,
        spec,
        labs: deps.labs,
        model: deps.model,
        store,
        signal,
        onLabCreated: (id) => {
          activeLabId = id;
        },
        onLabDestroyed: () => {
          activeLabId = null;
        },
      });
      lab.imageId = agent.imageId;
      try {
        const path = plan.metricExtraction.path;
        const digest = path ? agent.outcome.attempt.artifactDigests[path] : undefined;
        const artifact =
          path && digest && agent.metricArtifact
            ? { path, sha256: digest, bytes: agent.metricArtifact.length, content: agent.metricArtifact }
            : undefined;
        await verifyAndAudit(agent.outcome, artifact);
      } finally {
        activeLabId = null;
        lab.cleanup = await deps.labs.destroyLab(agent.labId, `run ${store.getRun(runId).status}`);
      }
      if (!lab.cleanup.verifiedAbsent) report.failure = "lab cleanup could not be verified";
      return await finalize();
    }

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
      const path = plan.metricExtraction.path;
      const artifact =
        path && outcome.attempt.artifactDigests[path] ? await deps.labs.readArtifact(handle.labId, path).catch(() => undefined) : undefined;
      await verifyAndAudit(outcome, artifact);
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
      await cleanupAcquiredRepository({ destination: acquisition.destination, destinationRoot: acquisitionRoot }).catch(() => undefined);
    }
    await rm(acquisitionRoot, { recursive: true, force: true });
  }

  /**
   * No reviewed case covers this paper: independent agents run the study
   * under a Supervisor (see ./study), and the report records their evidence.
   */
  async function multiAgentStudy(
    paper: PaperDocument,
    candidates: RepositoryCandidate[],
    options: MultiAgentOptions,
  ): Promise<StudyReport> {
    const agents = input.agents;
    if (!agents) {
      report.failure = "No model provider was selected for the agents";
      event("agents_unavailable", "failed", report.failure, {});
      finish("inconclusive");
      return await finalize();
    }
    event(
      "repository_found",
      "completed",
      "Found repository candidates; no reviewed case exists, so independent agents will run the study",
      {
        candidates: candidates.map((candidate) => candidate.repositoryUrl),
        autonomous: true,
      },
    );
    const result = await runMultiAgentStudy(
      { runId, paper, candidates, signal },
      {
        store,
        labs: deps.labs,
        dependencies: options.dependencies,
        images: options.images,
        datasets: options.datasets,
        config: { ...options.config, provider: agents.selection },
        chatProvider: agents.provider,
        workRoot: deps.workRoot,
        ...(deps.acquire ? { acquire: deps.acquire } : {}),
        ...(options.leakCheck ? { leakCheck: options.leakCheck } : {}),
      },
    );
    report.study = result.report;
    report.repository = result.repository;
    report.metric = result.metric;
    report.assessment = result.assessment;
    report.failure = result.failure;
    report.lab = {
      image: deps.image.name,
      imageId: result.imageId,
      attempt: result.attempt,
      stdout: result.stdout,
      stderr: "",
      logsTruncated: false,
      cleanup: result.report.cleanup.labs.find((receipt) => !receipt.verifiedAbsent) ?? result.report.cleanup.labs.at(-1) ?? null,
    };
    if (!result.report.cleanup.verified)
      report.failure = [report.failure, "study cleanup could not be verified"].filter(Boolean).join("; ");
    return await finalize();
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

function hostContainerPlatform(): ContainerPlatform {
  const architecture = hostArchitecture(process.arch);
  if (!architecture) throw new Error(`unsupported host architecture ${process.arch}; set the lab image platform explicitly`);
  return containerPlatformFor(architecture);
}
