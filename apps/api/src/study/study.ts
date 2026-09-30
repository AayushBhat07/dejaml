import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  type AgentOutcome,
  type AgentRole,
  BoundedAgentRuntime,
  type ChatProvider,
  ROLE_CAPABILITIES,
  ROLE_LABELS,
  ToolDenied,
} from "@dejaml/agent-runtime";
import type {
  Assessment,
  Attempt,
  Claim,
  ClaimEvidence,
  Metric,
  PaperAnalysis,
  PaperDocument,
  RepositoryCandidate,
  ResultStatus,
  RunEvent,
  RunStatus,
} from "@dejaml/contracts";
import { type CleanupReceipt, DEFAULT_LAB_LIMITS, type LabManager, LabSpecSchema } from "@dejaml/lab-manager";
import type { DependencyPreparer } from "@dejaml/prep";
import { acquireGithubRepository, cleanupAcquiredRepository } from "@dejaml/repository-intake";
import type { Consensus } from "@dejaml/research-runtime";
import { verifyResult } from "@dejaml/result-verifier";
import type { RunStore } from "@dejaml/run-store";

import { type EngineerLab, type ExportedArtifact, LAB_LAYOUT, type StageName, type StudyConfig, type StudyContext } from "./context.js";
import {
  INSTRUCTIONS,
  PaperClaimResultSchema,
  type Plan,
  PlanSchema,
  RepositoryMappingSchema,
  RESULT_DESCRIPTIONS,
  type Review,
  ReviewSchema,
  ROLE_LIMITS,
  type Submission,
  SubmissionSchema,
  SupervisorResultSchema,
} from "./roles.js";
import { buildStudyTools } from "./tools.js";
import { applySupervisor, checkProvenance, decideStatus, type EngineerOutcome, runStatusFor, TOLERANCE } from "./verdict.js";

const execFileAsync = promisify(execFile);

/** Progress order of run states; the study only ever moves forward along it. */
const PROGRESS: readonly RunStatus[] = [
  "queued",
  "ingesting",
  "discovering_repository",
  "analyzing",
  "planning",
  "validating_plan",
  "preparing_lab",
  "running",
  "comparing",
];

export type LeakCheck = (runId: string) => Promise<{ containers: string[]; networks: string[] }>;

/** Lists Docker containers and networks still labelled with this run (labs and prep both label theirs). */
export const dockerLeakCheck: LeakCheck = async (runId) => {
  const list = async (args: string[]): Promise<string[]> => {
    const { stdout } = await execFileAsync("docker", args, { timeout: 30_000 });
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  };
  return {
    containers: await list(["ps", "-a", "--filter", `label=dejaml.run=${runId}`, "--format", "{{.Names}}"]),
    networks: await list(["network", "ls", "--filter", `label=dejaml.run=${runId}`, "--format", "{{.Name}}"]),
  };
};

export type MultiAgentDependencies = {
  store: RunStore;
  labs: LabManager;
  prep: DependencyPreparer | null;
  config: StudyConfig;
  /** The model behind every agent of this run. Keys stay inside the provider object. */
  chatProvider: ChatProvider;
  workRoot: string;
  acquire?: typeof acquireGithubRepository;
  leakCheck?: LeakCheck;
};

export type AgentSummary = {
  agentId: string;
  role: AgentRole;
  roleLabel: string;
  label: string | null;
  parentId: string | null;
  status: string;
  reason: string | null;
  provider: string;
  model: string;
  grants: string[];
  usage: Record<string, number | null>;
  createdAt: string;
  finishedAt: string | null;
};

export type MultiAgentReport = {
  runtime: "bounded autonomous agent runtime";
  provider: { id: string; model: string };
  agents: AgentSummary[];
  board: Array<{ id: string; kind: string; key: string | null; author: string; authorAgentId: string | null; createdAt: string; payload: Record<string, unknown> }>;
  receipts: Array<{ id: string; agentId: string; tool: string; status: string; summary: string | null; inputSha256: string; outputSha256: string | null; startedAt: string; finishedAt: string | null }>;
  repository: Record<string, unknown> | null;
  dependencies: { manifest: Record<string, unknown> | null; manifestSha256: string | null; failures: StudyContext["dependencies"]["failures"] };
  datasets: Array<Record<string, unknown>>;
  plan: Plan | null;
  engineers: Array<Omit<EngineerOutcome, "metricArtifact" | "producingCommand"> & { metricArtifact: { path: string; sha256: string; bytes: number } | null; producingReceiptId: string | null; artifacts: Array<{ path: string; sha256: string; bytes: number }> }>;
  consensus: Consensus | null;
  result: {
    status: ResultStatus;
    mechanicalStatus: ResultStatus;
    supervisor: { proposedStatus: ResultStatus; rationale: string; applied: boolean } | null;
    reasons: string[];
    evidence: ClaimEvidence | null;
  };
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null; providerAttempts: number; toolCalls: number };
  delegations: StudyContext["delegations"];
  cleanup: {
    labs: CleanupReceipt[];
    wheelhouseRemoved: boolean;
    workDirRemoved: boolean;
    leftoverContainers: string[];
    leftoverNetworks: string[];
    liveAgents: string[];
    verified: boolean;
  };
};

export type MultiAgentResult = {
  report: MultiAgentReport;
  claim: Claim | null;
  paperAnalysis: PaperAnalysis | null;
  repository: { url: string; commitSha: string } | null;
  metric: Metric | null;
  assessment: Assessment | null;
  attempt: Attempt | null;
  stdout: string;
  imageId: string | null;
  failure: string | null;
  cancelled: boolean;
};

/**
 * A reproduction study run by separate agents: a Supervisor that delegates
 * stages; Paper and Repository Analysts; a Reproduction Planner that prepares
 * dependencies; independent Lab Engineers, each in its own sealed lab, with
 * Debuggers on request; and one Independent Reviewer per submission. The
 * final status is computed from their evidence, never taken from an agent.
 */
export async function runMultiAgentStudy(
  input: { runId: string; paper: PaperDocument; candidates: RepositoryCandidate[]; signal: AbortSignal },
  deps: MultiAgentDependencies,
): Promise<MultiAgentResult> {
  const { runId } = input;
  const { store } = deps;
  const event = (type: string, status: RunEvent["status"], summary: string, payload: Record<string, unknown> = {}): void => {
    store.appendEvent({ runId, actor: "system", type, status, summary, evidence: [], publicPayload: payload });
  };
  const advance = (target: RunStatus): void => {
    const current = store.getRun(runId).status;
    const from = PROGRESS.indexOf(current);
    const to = PROGRESS.indexOf(target);
    if (from < 0 || to <= from) return;
    for (let index = from + 1; index <= to; index += 1) store.transitionRun(runId, PROGRESS[index]!);
  };

  await mkdir(deps.workRoot, { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(join(deps.workRoot, "study-"));
  // Lab users read the checkout and datasets through read-only mounts.
  await chmod(workDir, 0o711);
  const exportRoot = join(deps.workRoot, "exports", runId);

  const study = new AbortController();
  const onAbort = (): void => study.abort(input.signal.reason);
  input.signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => study.abort(new Error("study time limit reached")), deps.config.maxStudyMs);

  const outcomes = new Map<string, EngineerOutcome>();
  const labReceipts: CleanupReceipt[] = [];
  let engineersLaunched = 0;
  let plan: Plan | null = null;
  let paperAnalysis: PaperAnalysis | null = null;

  const ctx: StudyContext = {
    runId,
    paper: input.paper,
    candidates: input.candidates,
    store,
    labs: deps.labs,
    prep: deps.prep,
    runtime: undefined as unknown as BoundedAgentRuntime,
    config: deps.config,
    workDir,
    acquire: deps.acquire ?? acquireGithubRepository,
    repository: null,
    dependencies: { discovery: null, resolution: null, manifest: null, manifestSha256: null, failures: [] },
    datasets: [],
    labsByAgent: new Map(),
    exports: new Map(),
    delegations: { total: 0, byStage: { analysis: 0, plan: 0, engineering: 0, review: 0 } },
    runStage: (stage, objective, supervisorAgentId, signal) => runStage(stage, objective, supervisorAgentId, signal),
    event,
  };
  const runtime = new BoundedAgentRuntime({
    store,
    provider: () => deps.chatProvider,
    tools: (agent) => buildStudyTools(ctx, agent),
  });
  ctx.runtime = runtime;
  const board = runtime.board(runId);
  const provider = deps.config.provider;

  const start = <T>(role: AgentRole, options: { label: string; parentAgentId: string | null; objective: string; inputs: Record<string, unknown>; schema: import("zod").ZodType<T>; agentId?: string }) =>
    runtime.startAgent<T>({
      runId,
      role,
      ...(options.agentId ? { agentId: options.agentId } : {}),
      parentAgentId: options.parentAgentId,
      label: options.label,
      instructions: INSTRUCTIONS[role],
      objective: options.objective,
      inputs: options.inputs,
      grants: [...ROLE_CAPABILITIES[role]],
      limits: ROLE_LIMITS[role],
      result: { schema: options.schema, description: RESULT_DESCRIPTIONS[role] },
      provider,
    });

  const latestClaim = (): Claim | null => {
    const entry = board.latest("paper_claim");
    return entry ? ((entry.payload as { claim: Claim | null }).claim ?? null) : null;
  };

  async function runStage(stage: StageName, objective: string, supervisorAgentId: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted || study.signal.aborted) throw new ToolDenied("the study is stopping");
    event("stage_started", "started", `Supervisor delegated the ${stage} stage`, { stage, objective: objective.slice(0, 500) });
    const summary = await (async () => {
      switch (stage) {
        case "analysis":
          return analysisStage(objective, supervisorAgentId);
        case "plan":
          return planStage(objective, supervisorAgentId);
        case "engineering":
          return engineeringStage(objective, supervisorAgentId);
        case "review":
          return reviewStage(objective, supervisorAgentId);
      }
    })();
    event("stage_finished", "completed", `The ${stage} stage finished`, { stage });
    return summary;
  }

  async function analysisStage(objective: string, parent: string): Promise<string> {
    advance("analyzing");
    const urls = input.candidates.map((candidate) => candidate.repositoryUrl);
    const [paperHandle, repoHandle] = await Promise.all([
      start("paper_analyst", {
        label: `paper-analyst-${ctx.delegations.byStage.analysis}`,
        parentAgentId: parent,
        objective: `Select the one claim to reproduce. ${objective}`,
        inputs: { paper: { name: input.paper.file.originalName, pages: input.paper.pageCount }, repositoryCandidates: urls },
        schema: PaperClaimResultSchema,
      }),
      start("repository_analyst", {
        label: `repository-analyst-${ctx.delegations.byStage.analysis}`,
        parentAgentId: parent,
        objective: `Acquire and map the paper's repository. ${objective}`,
        inputs: {
          repositoryCandidates: input.candidates.map((candidate) => ({
            url: candidate.repositoryUrl,
            namedByUploader: candidate.providedByUser === true,
            pages: candidate.occurrences.map((item) => item.pageNumber),
          })),
        },
        schema: RepositoryMappingSchema,
      }),
    ]);
    const [paperOutcome, repoOutcome] = await Promise.all([paperHandle.done, repoHandle.done]);
    const lines: string[] = [];
    if (paperOutcome.status === "completed" && paperOutcome.result) {
      paperAnalysis = paperOutcome.result;
      board.post({ kind: "paper_claim", authorAgentId: paperOutcome.agentId, authorRole: "paper_analyst", payload: { claim: paperOutcome.result.claim, analysis: paperOutcome.result } });
      lines.push(paperOutcome.result.claim
        ? `Paper Analyst selected: ${paperOutcome.result.claim.experimentLabel}, ${paperOutcome.result.claim.metric.name} = ${paperOutcome.result.claim.metric.reportedValue} ${paperOutcome.result.claim.metric.unit}.`
        : `Paper Analyst found no testable claim: ${paperOutcome.result.reasons.join("; ")}`);
    } else {
      lines.push(`Paper Analyst ${paperOutcome.status}: ${paperOutcome.reason ?? "no result"}`);
    }
    if (repoOutcome.status === "completed" && repoOutcome.result) {
      board.post({ kind: "repository_mapping", authorAgentId: repoOutcome.agentId, authorRole: "repository_analyst", payload: repoOutcome.result });
      lines.push(`Repository Analyst (${repoOutcome.result.status}): ${repoOutcome.result.summary}`);
    } else {
      lines.push(`Repository Analyst ${repoOutcome.status}: ${repoOutcome.reason ?? "no result"}`);
    }
    lines.push(ctx.repository ? `Repository pinned at ${ctx.repository.receipt.commitSha}.` : "No repository was acquired.");
    return lines.join("\n");
  }

  async function planStage(objective: string, parent: string): Promise<string> {
    const claim = latestClaim();
    if (!claim) throw new ToolDenied("planning needs a claim from the Paper Analyst; run analysis first");
    if (!ctx.repository) throw new ToolDenied("planning needs an acquired repository; run analysis first");
    advance("planning");
    const handle = await start("reproduction_planner", {
      label: `planner-${ctx.delegations.byStage.plan}`,
      parentAgentId: parent,
      objective: `Plan the reproduction of the selected claim and prepare its Python dependencies. ${objective}`,
      inputs: {
        claim,
        repository: { url: ctx.repository.receipt.repositoryUrl, commitSha: ctx.repository.receipt.commitSha },
        labEnvironment: {
          python: "3.13 (the lab image's interpreter; packages come only from the prepared wheelhouse)",
          platform: "Linux x86-64, CPU only",
          network: "none during execution",
          cpus: deps.config.resources.cpus,
          memoryMb: deps.config.resources.memoryMb,
          commandTimeoutSeconds: deps.config.commandTimeoutSeconds,
        },
        datasetHostsAllowed: deps.config.datasetPolicy.allowedHosts,
        dependencyPreparation: deps.prep ? "available" : "disabled on this server",
        previousRounds: previousRounds(),
      },
      schema: PlanSchema,
    });
    const outcome = await handle.done;
    if (outcome.status !== "completed" || !outcome.result) return `Planner ${outcome.status}: ${outcome.reason ?? "no plan"}`;
    plan = outcome.result;
    const warnings: string[] = [];
    if (plan.target.reportedValue !== claim.metric.reportedValue || plan.target.unit !== claim.metric.unit) {
      warnings.push("the plan's target differs from the Paper Analyst's claim; the claim is authoritative");
    }
    if (plan.environment.manifestPrepared && !ctx.dependencies.manifest) warnings.push("the plan says dependencies were prepared, but no manifest exists");
    board.post({ kind: "plan", authorAgentId: outcome.agentId, authorRole: "reproduction_planner", payload: { ...plan, warnings, manifestSha256: ctx.dependencies.manifestSha256 } });
    if (plan.status === "blocked") {
      board.post({ kind: "policy_block", authorAgentId: outcome.agentId, authorRole: "reproduction_planner", payload: { reason: plan.blockedReason ?? plan.summary } });
    }
    advance("validating_plan");
    return [
      `Plan ${plan.status}: ${plan.summary}`,
      `Entry point: ${plan.officialEntrypoint?.path ?? "none"}`,
      `Dependencies: ${ctx.dependencies.manifest ? `${ctx.dependencies.manifest.packages.length} wheels prepared (manifest ${ctx.dependencies.manifestSha256?.slice(0, 12)})` : "none prepared"}${ctx.dependencies.failures.length ? `; failures: ${ctx.dependencies.failures.map((item) => `${item.code}${item.requirement ? ` (${item.requirement})` : ""}`).join(", ")}` : ""}`,
      `Environment deviations: ${plan.environment.deviations.join("; ") || "none"}`,
      ...warnings.map((warning) => `Warning: ${warning}`),
    ].join("\n");
  }

  function previousRounds(): Array<Record<string, unknown>> {
    return [...outcomes.values()].map((outcome) => ({
      engineer: outcome.label,
      status: outcome.submission?.status ?? outcome.agentStatus,
      failure: outcome.submission?.failureReason ?? outcome.agentReason,
      provenanceProblems: outcome.provenance.problems,
      review: outcome.review ? { verdict: outcome.review.verdict, equivalence: outcome.review.equivalence, concerns: outcome.review.concerns } : null,
    }));
  }

  async function engineeringStage(objective: string, parent: string): Promise<string> {
    const claim = latestClaim();
    if (!plan || plan.status !== "ready" || !claim || !ctx.repository) {
      throw new ToolDenied("engineering needs a ready plan; run plan first (or finish if the plan is blocked)");
    }
    if (plan.environment.manifestPrepared && !ctx.dependencies.manifest) {
      throw new ToolDenied("the plan needs prepared dependencies but none exist; re-plan");
    }
    advance("running");
    const round = ctx.delegations.byStage.engineering;
    const count = Math.max(1, Math.min(4, deps.config.engineers));
    event("engineers_started", "progress", `${count} independent Lab Engineers will each work in their own sealed lab`, { count, round });
    const results = await Promise.all(Array.from({ length: count }, (_, index) => runEngineer(`engineer-${round}-${index + 1}`, parent, objective, claim, plan!)));
    return results.join("\n");
  }

  async function runEngineer(label: string, parent: string, objective: string, claim: Claim, currentPlan: Plan): Promise<string> {
    const agentId = `agt_${randomUUID().replaceAll("-", "")}`;
    const inputs: Array<{ hostPath: string; containerPath: string }> = [{ hostPath: ctx.repository!.dir, containerPath: LAB_LAYOUT.repoDir }];
    if (ctx.dependencies.manifest) inputs.push({ hostPath: ctx.dependencies.manifest.wheelhouseDir, containerPath: LAB_LAYOUT.wheelsDir });
    if (ctx.datasets.length) inputs.push({ hostPath: join(workDir, "datasets"), containerPath: LAB_LAYOUT.dataDir });
    const spec = LabSpecSchema.parse({
      runId,
      image: deps.config.image.name,
      expectedImageId: deps.config.image.expectedImageId,
      workdir: LAB_LAYOUT.workdir,
      artifactsDir: LAB_LAYOUT.artifactsDir,
      scratchDir: LAB_LAYOUT.scratchDir,
      inputs,
      resources: deps.config.resources,
      limits: DEFAULT_LAB_LIMITS,
    });
    engineersLaunched += 1;
    const handle = await deps.labs.createLab(spec);
    const lab: EngineerLab = {
      agentId,
      label,
      labId: handle.labId,
      imageId: handle.imageId,
      commands: [],
      written: new Map(),
      artifacts: new Map(),
      environment: null,
      destroyed: false,
    };
    ctx.labsByAgent.set(agentId, lab);
    let outcome: AgentOutcome<Submission> | null = null;
    let exported: ExportedArtifact[] = [];
    try {
      const engineer = await start("lab_engineer", {
        agentId,
        label,
        parentAgentId: parent,
        objective: `Reproduce the claim with the repository's official code, following the plan. ${objective}`,
        inputs: {
          claim,
          plan: currentPlan,
          dependencies: ctx.dependencies.manifest
            ? { wheelhouse: `${LAB_LAYOUT.wheelsDir}/`, venv: LAB_LAYOUT.venv, packages: ctx.dependencies.manifest.packages.map((item) => `${item.name}==${item.version}`) }
            : "none prepared; the lab's system Python has only the standard library and the image's packages",
          datasets: ctx.datasets.map((item) => ({ name: item.name, path: `${LAB_LAYOUT.dataDir}/${item.fileName}`, sha256: item.sha256 })),
          layout: LAB_LAYOUT,
          limits: { commandTimeoutSeconds: deps.config.commandTimeoutSeconds, cpus: deps.config.resources.cpus, memoryMb: deps.config.resources.memoryMb },
        },
        schema: SubmissionSchema,
      });
      outcome = await engineer.done;
      exported = await exportArtifacts(lab);
    } finally {
      lab.destroyed = true;
      const receipt = await deps.labs.destroyLab(handle.labId, `${label} finished`).catch((error: unknown) => ({
        labId: handle.labId,
        runId,
        containerName: handle.containerName,
        reason: `destroy failed: ${error instanceof Error ? error.message : String(error)}`,
        containerRemoved: false,
        artifactDirectoryRemoved: false,
        verifiedAbsent: false,
        destroyedAt: new Date().toISOString(),
        errors: [String(error)],
      }));
      labReceipts.push(receipt);
    }
    ctx.exports.set(agentId, exported);
    const submission = outcome?.status === "completed" ? outcome.result : null;
    const provenance = submission ? checkProvenance({ submission, lab, exported }) : { ok: false, problems: ["no submission"], warnings: [], artifact: null, command: null, rawValue: null };
    const record: EngineerOutcome = {
      engineerAgentId: agentId,
      label,
      agentStatus: outcome?.status ?? "failed",
      agentReason: outcome?.reason ?? null,
      submission,
      provenance: { ok: provenance.ok, problems: provenance.problems, warnings: provenance.warnings },
      metricArtifact: provenance.artifact,
      producingCommand: provenance.command,
      rawValue: provenance.rawValue,
      value: null,
      review: null,
      reviewerAgentId: null,
    };
    outcomes.set(agentId, record);
    for (const artifact of exported) {
      board.post({ kind: "artifact", authorAgentId: null, authorRole: "system", key: agentId, payload: { path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes, engineer: label } });
    }
    for (const adapter of submission?.adapters ?? []) {
      const written = lab.written.get(adapter.path) ?? lab.written.get(`work/${adapter.path}`);
      board.post({ kind: "adapter_record", authorAgentId: agentId, authorRole: "lab_engineer", key: agentId, payload: { ...adapter, sha256: written?.sha256 ?? null, writtenInLab: Boolean(written) } });
    }
    board.post({
      kind: "submission",
      authorAgentId: agentId,
      authorRole: "lab_engineer",
      key: agentId,
      payload: { engineer: label, agentStatus: record.agentStatus, submission, provenance: record.provenance, rawValue: record.rawValue, environment: lab.environment },
    });
    event("engineer_finished", provenance.ok ? "completed" : "warning", provenance.ok
      ? `${label} measured ${String(record.rawValue)} ${submission?.unit ?? ""} from ${submission?.metricFile}`
      : `${label} produced no verifiable measurement (${record.provenance.problems[0] ?? record.agentStatus})`, { engineer: label, agentId, status: record.agentStatus });
    return `${label}: ${submission ? `${submission.status}; ${submission.summary}` : `${record.agentStatus}: ${record.agentReason ?? ""}`} Provenance ${provenance.ok ? "ok" : `failed (${provenance.problems.join("; ")})`}.`;
  }

  async function exportArtifacts(lab: EngineerLab): Promise<ExportedArtifact[]> {
    const exported: ExportedArtifact[] = [];
    try {
      await deps.labs.freezeLab(lab.labId);
    } catch {
      // A lab that already stopped cannot change its artifacts either.
    }
    for (const summary of [...lab.artifacts.values()].slice(0, DEFAULT_LAB_LIMITS.maxArtifactFiles)) {
      try {
        const artifact = await deps.labs.readArtifact(lab.labId, summary.path);
        const hostPath = join(exportRoot, lab.label, artifact.path);
        await mkdir(dirname(hostPath), { recursive: true, mode: 0o700 });
        await writeFile(hostPath, artifact.content, { mode: 0o600 });
        const text = artifact.content.subarray(0, 1024).includes(0) ? null : artifact.content.toString("utf8");
        exported.push({ path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes, hostPath, text: text === null ? null : text.slice(0, 200_000) });
      } catch {
        // Removed or oversized artifacts are simply not exported.
      }
    }
    return exported;
  }

  async function reviewStage(objective: string, parent: string): Promise<string> {
    const claim = latestClaim();
    const pending = [...outcomes.values()].filter((outcome) => outcome.submission?.status === "measured" && outcome.review === null);
    if (!claim || pending.length === 0) throw new ToolDenied("there are no unreviewed measured submissions");
    const lines = await Promise.all(pending.map(async (outcome, index) => {
      const handle = await start("independent_reviewer", {
        label: `reviewer-${ctx.delegations.byStage.review}-${index + 1}`,
        parentAgentId: parent,
        objective: `Review ${outcome.label}'s submission independently. ${objective}`,
        inputs: {
          submissionKey: outcome.engineerAgentId,
          engineer: outcome.label,
          claim,
          plan,
          submission: outcome.submission,
          measuredValue: outcome.rawValue,
          deterministicChecks: outcome.provenance,
          exportedArtifacts: (ctx.exports.get(outcome.engineerAgentId) ?? []).map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
          hint: "Read board entries with key = submissionKey (command_receipt, artifact, adapter_record, submission), and use artifact_read with engineerAgentId = submissionKey.",
        },
        schema: ReviewSchema,
      });
      const result = await handle.done;
      if (result.status === "completed" && result.result) {
        outcome.review = result.result as Review;
        outcome.reviewerAgentId = handle.agentId;
        board.post({ kind: "review", authorAgentId: handle.agentId, authorRole: "independent_reviewer", key: outcome.engineerAgentId, payload: result.result });
        return `${outcome.label}: ${result.result.verdict} (${result.result.equivalence}) ${result.result.summary}`;
      }
      return `${outcome.label}: reviewer ${result.status} (${result.reason ?? "no verdict"})`;
    }));
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // The Supervisor drives the stages; the study code then decides.

  let supervisorOutcome: AgentOutcome<{ proposedStatus: ResultStatus; rationale: string }> | null = null;
  let failure: string | null = null;
  const stopAgents = (): void => {
    for (const agentId of runtime.liveAgents()) void runtime.cancelAgent(agentId);
    for (const lab of ctx.labsByAgent.values()) if (!lab.destroyed) void deps.labs.cancelLab(lab.labId).catch(() => undefined);
  };
  study.signal.addEventListener("abort", stopAgents, { once: true });
  try {
    event("study_team", "started", "A Supervisor agent will delegate the study to independent specialist agents", {
      runtime: "bounded autonomous agent runtime",
      provider: provider.id,
      model: provider.model,
      engineers: deps.config.engineers,
    });
    const supervisor = await start("supervisor", {
      label: "supervisor",
      parentAgentId: null,
      objective:
        "Run a reproduction study of this paper: find the one CPU-checkable claim, reproduce it with the official repository code in sealed offline labs, have every measurement reviewed independently, and report the status the evidence supports.",
      inputs: {
        paper: { name: input.paper.file.originalName, pages: input.paper.pageCount },
        repositoryCandidates: input.candidates.map((candidate) => candidate.repositoryUrl),
        engineersPerRound: deps.config.engineers,
        maxDelegations: deps.config.maxDelegations,
      },
      schema: SupervisorResultSchema,
    });
    supervisorOutcome = await supervisor.done;
    if (supervisorOutcome.status !== "completed") failure = `Supervisor ${supervisorOutcome.status}: ${supervisorOutcome.reason ?? ""}`;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const cancelled = input.signal.aborted;

  // ---------------------------------------------------------------------------
  // Deterministic decision.

  const claim = latestClaim();
  const tolerance = claim ? TOLERANCE[claim.metric.unit] : null;
  const verifications = new Map<string, ReturnType<typeof verifyResult>>();
  const attemptFor = (outcome: EngineerOutcome): Attempt | null => {
    const command = outcome.producingCommand;
    if (!command || !outcome.metricArtifact) return null;
    const now = new Date().toISOString();
    return {
      id: `${runId}:${outcome.label}:${command.receiptId}`,
      runId,
      number: 1,
      label: "baseline",
      command: { executable: command.argv[0] ?? "", args: command.argv.slice(1), cwd: command.cwd, env: {} },
      changes: [],
      startedAt: now,
      endedAt: now,
      exitCode: command.exitCode,
      timedOut: command.timedOut,
      cancelled: false,
      artifactDigests: { [outcome.metricArtifact.path]: outcome.metricArtifact.sha256 },
    };
  };
  const verify = (outcome: EngineerOutcome, withEvents: boolean) => {
    const attempt = attemptFor(outcome);
    if (!claim || !attempt || !outcome.submission?.metricKey || !outcome.metricArtifact || tolerance === null) return null;
    return verifyResult({
      runId,
      plan: { claim, dataset: { name: claim.dataset }, metricExtraction: { source: "json", path: outcome.metricArtifact.path, key: outcome.submission.metricKey } },
      attempt,
      artifact: { path: outcome.metricArtifact.path, sha256: outcome.metricArtifact.sha256, content: outcome.metricArtifact.text ?? "" },
      stdout: outcome.producingCommand?.stdoutTail ?? "",
      ...(outcome.submission.unit ? { observedUnit: outcome.submission.unit } : {}),
      tolerance,
      ...(withEvents ? { events: (item: Parameters<RunStore["appendEvent"]>[0]) => store.appendEvent(item) } : {}),
    });
  };
  for (const outcome of outcomes.values()) {
    if (!outcome.provenance.ok) continue;
    const check = verify(outcome, false);
    if (check?.assessment.comparable && check.assessment.observedValue !== null) outcome.value = check.assessment.observedValue;
  }
  const policyBlocks = board.list(["policy_block"]).map((entry) => String((entry.payload as { reason: string }).reason));
  const decision = decideStatus({
    claim,
    plan,
    outcomes: [...outcomes.values()],
    engineersLaunched,
    policyBlocks,
    compare: (outcome) => {
      const check = verify(outcome, true);
      if (!check) return null;
      verifications.set(outcome.engineerAgentId, check);
      if (!check.assessment.comparable) return null;
      return { within: check.assessment.verdict === "reproduced_within_tolerance", absoluteDifference: check.assessment.absoluteDifference };
    },
  });
  if (cancelled) decision.reasons.unshift("the study was cancelled before it finished");
  if (failure && !cancelled) decision.reasons.push(failure);
  const proposal = supervisorOutcome?.status === "completed" ? supervisorOutcome.result : null;
  const applied = applySupervisor(cancelled ? "inconclusive" : decision.status, proposal?.proposedStatus ?? null);
  const finalStatus: ResultStatus = cancelled ? "inconclusive" : applied.status;
  if (applied.overridden) decision.reasons.push(`the Supervisor made the result more cautious: ${proposal!.rationale.slice(0, 500)}`);
  board.post({ kind: "status_decision", authorAgentId: null, authorRole: "system", payload: { status: finalStatus, mechanicalStatus: decision.status, reasons: decision.reasons, supervisorProposal: proposal } });

  const representative = decision.representative;
  const verification = representative ? verifications.get(representative.engineerAgentId) ?? null : null;
  const evidence = buildEvidence();

  // ---------------------------------------------------------------------------
  // Cleanup on every path: agents, labs, wheelhouse, checkouts, temp files.

  clearTimeout(deadline);
  input.signal.removeEventListener("abort", onAbort);
  study.signal.removeEventListener("abort", stopAgents);
  for (const agentId of runtime.liveAgents()) await runtime.cancelAgent(agentId).catch(() => undefined);
  for (const lab of ctx.labsByAgent.values()) {
    if (!lab.destroyed) {
      lab.destroyed = true;
      labReceipts.push(await deps.labs.destroyLab(lab.labId, "study finished"));
    }
  }
  let wheelhouseRemoved = true;
  const wheelhouse = ctx.dependencies.manifest?.wheelhouseDir;
  if (wheelhouse) {
    try {
      await chmod(wheelhouse, 0o700);
      await rm(wheelhouse, { recursive: true, force: true });
      wheelhouseRemoved = !(await stat(wheelhouse).then(() => true, () => false));
    } catch {
      wheelhouseRemoved = false;
    }
  }
  if (ctx.repository) {
    await cleanupAcquiredRepository({ destination: ctx.repository.receipt.destination, destinationRoot: ctx.repository.root }).catch(() => undefined);
  }
  await rm(workDir, { recursive: true, force: true });
  const workDirRemoved = !(await stat(workDir).then(() => true, () => false));
  const leaks = await (deps.leakCheck ?? dockerLeakCheck)(runId).catch((error: unknown) => ({ containers: [`leak check failed: ${String(error)}`], networks: [] }));
  const liveAgents = runtime.liveAgents();
  const cleanup = {
    labs: labReceipts,
    wheelhouseRemoved,
    workDirRemoved,
    leftoverContainers: leaks.containers,
    leftoverNetworks: leaks.networks,
    liveAgents,
    verified:
      labReceipts.every((receipt) => receipt.verifiedAbsent) &&
      wheelhouseRemoved &&
      workDirRemoved &&
      leaks.containers.length === 0 &&
      leaks.networks.length === 0 &&
      liveAgents.length === 0,
  };
  event("study_cleanup", cleanup.verified ? "completed" : "failed", cleanup.verified
    ? `Destroyed ${labReceipts.length} lab(s) and removed prepared files; nothing from this study is left running`
    : "Some study resources could not be verified as removed", cleanup);

  // ---------------------------------------------------------------------------
  // Run status: move forward to a terminal state.

  if (!store.isTerminal(runId)) {
    if (cancelled) {
      store.transitionRun(runId, "cancelled");
    } else {
      const target = runStatusFor(finalStatus);
      const current = store.getRun(runId).status;
      if (target === "completed" || current === "preparing_lab" || current === "running") advance("comparing");
      store.transitionRun(runId, target);
    }
  }
  event("study_result", finalStatus === "reproduced" ? "completed" : "warning", `Result: ${finalStatus.replaceAll("_", " ")}`, { status: finalStatus, reasons: decision.reasons });

  const agents = store.ledger.listAgents(runId);
  const usage = agents.reduce(
    (total, agent) => ({
      inputTokens: total.inputTokens + agent.usage.inputTokens,
      outputTokens: total.outputTokens + agent.usage.outputTokens,
      costUsd: total.costUsd === null || agent.usage.costUsd === null ? null : total.costUsd + agent.usage.costUsd,
      providerAttempts: total.providerAttempts + agent.usage.providerAttempts,
      toolCalls: total.toolCalls + agent.usage.toolCalls,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 as number | null, providerAttempts: 0, toolCalls: 0 },
  );
  const report: MultiAgentReport = {
    runtime: "bounded autonomous agent runtime",
    provider,
    agents: agents.map((agent) => ({
      agentId: agent.id,
      role: agent.role as AgentRole,
      roleLabel: ROLE_LABELS[agent.role as AgentRole] ?? agent.role,
      label: (agent.task as { label?: string | null }).label ?? null,
      parentId: agent.parentId,
      status: agent.status,
      reason: agent.failure,
      provider: agent.provider,
      model: agent.model,
      grants: agent.grants,
      usage: { ...agent.usage },
      createdAt: agent.createdAt,
      finishedAt: ["created", "running", "waiting"].includes(agent.status) ? null : agent.updatedAt,
    })),
    board: board.list().map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      key: entry.key,
      author: entry.authorRole,
      authorAgentId: entry.authorAgentId,
      createdAt: entry.createdAt,
      payload: entry.payload,
    })),
    receipts: store.ledger.listReceipts({ runId }).map((receipt) => ({
      id: receipt.id,
      agentId: receipt.agentId,
      tool: receipt.tool,
      status: receipt.status,
      summary: receipt.summary,
      inputSha256: receipt.inputSha256,
      outputSha256: receipt.outputSha256,
      startedAt: receipt.startedAt,
      finishedAt: receipt.endedAt,
    })),
    repository: ctx.repository
      ? (({ manifest: _manifest, destination: _destination, ...rest }) => rest)(ctx.repository.receipt)
      : null,
    dependencies: {
      manifest: ctx.dependencies.manifest ? (({ wheelhouseDir: _dir, ...rest }) => rest)(ctx.dependencies.manifest) : null,
      manifestSha256: ctx.dependencies.manifestSha256,
      failures: ctx.dependencies.failures,
    },
    datasets: ctx.datasets.map(({ path: _path, ...rest }) => rest),
    plan,
    engineers: [...outcomes.values()].sort((a, b) => a.label.localeCompare(b.label)).map(({ producingCommand: _command, metricArtifact, ...outcome }) => ({
      ...outcome,
      metricArtifact: metricArtifact ? { path: metricArtifact.path, sha256: metricArtifact.sha256, bytes: metricArtifact.bytes } : null,
      producingReceiptId: _command?.receiptId ?? null,
      artifacts: (ctx.exports.get(outcome.engineerAgentId) ?? []).map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
    })),
    consensus: decision.consensus,
    result: {
      status: finalStatus,
      mechanicalStatus: decision.status,
      supervisor: proposal ? { proposedStatus: proposal.proposedStatus, rationale: proposal.rationale, applied: applied.overridden } : null,
      reasons: decision.reasons,
      evidence,
    },
    usage,
    delegations: ctx.delegations,
    cleanup,
  };
  const representativeLab = representative ? ctx.labsByAgent.get(representative.engineerAgentId) : undefined;
  return {
    report,
    claim,
    paperAnalysis,
    repository: ctx.repository ? { url: ctx.repository.receipt.repositoryUrl, commitSha: ctx.repository.receipt.commitSha } : null,
    metric: verification?.metric ?? null,
    assessment: verification?.assessment ?? null,
    attempt: representative ? attemptFor(representative) : null,
    stdout: representative?.producingCommand?.stdoutTail ?? "",
    imageId: representativeLab?.imageId ?? [...ctx.labsByAgent.values()][0]?.imageId ?? null,
    failure: finalStatus === "inconclusive" || finalStatus === "policy_blocked" ? decision.reasons.join("; ") || failure : null,
    cancelled,
  };

  function buildEvidence(): ClaimEvidence | null {
    if (!claim || !ctx.repository) return null;
    const chosen = representative ?? [...outcomes.values()].find((outcome) => outcome.submission?.status === "measured") ?? null;
    const lab = chosen ? ctx.labsByAgent.get(chosen.engineerAgentId) : undefined;
    const manifest = ctx.dependencies.manifest;
    return {
      claim: {
        experimentLabel: claim.experimentLabel,
        metric: claim.metric.name,
        unit: claim.metric.unit,
        reportedValue: claim.metric.reportedValue,
        paperReferences: claim.evidence.filter((item) => item.kind === "paper_page").map((item) => item.reference),
      },
      repository: { url: ctx.repository.receipt.repositoryUrl, commitSha: ctx.repository.receipt.commitSha, manifestSha256: ctx.repository.receipt.manifestSha256 },
      datasets: ctx.datasets.map((item) => ({ name: item.name, source: item.finalUrl, sha256: item.sha256, bytes: item.bytes })),
      environment: {
        image: deps.config.image.name,
        imageId: lab?.imageId ?? null,
        python: lab?.environment?.python ?? manifest?.pythonVersion ?? null,
        manifestSha256: ctx.dependencies.manifestSha256,
        packages: (manifest?.packages ?? []).map((item) => ({ name: item.name, version: item.version, sha256: item.sha256 })),
      },
      commands: (lab?.commands ?? []).slice(-40).map(({ stdoutTail: _out, stderrTail: _err, ...receipt }) => receipt),
      artifacts: (chosen ? ctx.exports.get(chosen.engineerAgentId) ?? [] : []).map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
      // Only adapters that exist as files written in the lab carry a digest; the rest are listed in reasons by the provenance check.
      adapters: (chosen?.submission?.adapters ?? []).flatMap((adapter) => {
        const written = lab?.written.get(adapter.path) ?? lab?.written.get(`work/${adapter.path}`);
        return written ? [{ ...adapter, sha256: written.sha256 }] : [];
      }),
      measuredValue: chosen?.value ?? chosen?.rawValue ?? null,
      comparison: {
        method: `absolute difference in ${claim.metric.unit} against the paper's reported value; ${decision.consensus ? `${decision.consensus.required} independent engineer(s) must agree` : "no agreement was reached"}`,
        tolerance,
        absoluteDifference: verification?.assessment.absoluteDifference ?? null,
      },
      status: finalStatus,
      reasons: decision.reasons,
    };
  }
}

/** Lists what an interrupted study left on disk, for startup cleanup. */
export async function removeStaleStudyDirs(workRoot: string): Promise<number> {
  let removed = 0;
  for (const name of await readdir(workRoot).catch(() => [] as string[])) {
    if (name.startsWith("study-")) {
      await rm(join(workRoot, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
