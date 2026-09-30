import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { type AgentOutcome, type AgentRole, BoundedAgentRuntime, type ChatProvider, ROLE_LABELS } from "@dejaml/agent-runtime";
import type {
  Assessment,
  Attempt,
  ClaimContract,
  Metric,
  PaperDocument,
  RepositoryCandidate,
  ResultStatus,
  RunEvent,
  RunStatus,
  StageRetryReason,
  WorkStage,
} from "@dejaml/contracts";
import { WORK_STAGES } from "@dejaml/contracts";
import { type CleanupReceipt, DEFAULT_LAB_LIMITS, type LabWorker, LabSpecSchema } from "@dejaml/lab-manager";
import { acquireGithubRepository, cleanupAcquiredRepository } from "@dejaml/repository-intake";
import type { RunStore, StageRecord } from "@dejaml/run-store";
import type { z } from "zod";

import { type ArtifactStore, LocalArtifactStore } from "../boundaries.js";
import {
  type AcquiredDataset,
  type DatasetPort,
  type DependencyPort,
  type EngineerLab,
  type ExportedArtifact,
  LAB_LAYOUT,
  type LabImage,
  type LabImagePort,
  PreparationFailure,
  type PreparedDependencies,
  type StudyConfig,
  type StudyContext,
} from "./context.js";
import { reconcile, reviewPolicy } from "./contract.js";
import { measureIntegrity, orchestratorActor, runInLab } from "./lab-tools.js";
import { convertUnit, parseMetric } from "./metric.js";
import {
  DiagnosisSchema,
  INSTRUCTIONS,
  type PaperClaimResult,
  PaperClaimResultSchema,
  type Plan,
  PlanSchema,
  type RepositoryMapping,
  RepositoryMappingSchema,
  RESULT_DESCRIPTIONS,
  type Review,
  ReviewSchema,
  ROLE_GRANTS,
  ROLE_LIMITS,
  type Submission,
  SubmissionSchema,
  type SupervisorCheckpoint,
  SupervisorCheckpointSchema,
  type SupervisorVerdict,
  SupervisorVerdictSchema,
} from "./roles.js";
import { acquireRepository, buildStudyTools } from "./tools.js";
import {
  applySupervisor,
  decideStatus,
  type EngineerOutcome,
  type OfficialRun,
  type StatusDecision,
  runStatusFor,
  terminalStageFor,
} from "./verdict.js";

const execFileAsync = promisify(execFile);

/** Run states in order; the study moves the run forward along them, never back. */
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

const RUN_STATUS_FOR_STAGE: Record<WorkStage, RunStatus> = {
  ingesting: "ingesting",
  analyzing_paper: "analyzing",
  analyzing_repository: "analyzing",
  reconciling: "planning",
  policy_review: "validating_plan",
  preparing: "preparing_lab",
  executing: "running",
  reviewing: "comparing",
  deciding: "comparing",
};

const STAGE_LEASE_MS = 15 * 60_000;

export type LeakCheck = (runId: string) => Promise<{ containers: string[]; networks: string[] }>;

/** Lists Docker containers and networks still labelled with this run (labs and prep both label theirs). */
export const dockerLeakCheck: LeakCheck = async (runId) => {
  const list = async (args: string[]): Promise<string[]> => {
    const { stdout } = await execFileAsync("docker", args, { timeout: 30_000 });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  };
  return {
    containers: await list(["ps", "-a", "--filter", `label=dejaml.run=${runId}`, "--format", "{{.Names}}"]),
    networks: await list(["network", "ls", "--filter", `label=dejaml.run=${runId}`, "--format", "{{.Name}}"]),
  };
};

export type MultiAgentDependencies = {
  store: RunStore;
  labs: LabWorker;
  dependencies: DependencyPort | null;
  images: LabImagePort;
  datasets: DatasetPort | null;
  config: StudyConfig;
  /** The model behind every agent of this run. Keys stay inside the provider object. */
  chatProvider: ChatProvider;
  workRoot: string;
  /** Where exported lab artifacts are kept; files under `workRoot/exports` by default. */
  artifacts?: ArtifactStore;
  acquire?: typeof acquireGithubRepository;
  leakCheck?: LeakCheck;
  /** This process as a stage owner; defaults to a fresh id. */
  owner?: string;
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
  runtime: "native autonomous agent runtime";
  provider: { id: string; model: string };
  agents: AgentSummary[];
  stages: Array<Pick<StageRecord, "stage" | "status" | "attempt" | "retryReason" | "error" | "startedAt" | "endedAt">>;
  transitions: Array<{ stage: string; from: string; to: string; attempt: number; reason: string | null; at: string }>;
  board: Array<{
    id: string;
    kind: string;
    key: string | null;
    author: string;
    authorAgentId: string | null;
    createdAt: string;
    payload: Record<string, unknown>;
  }>;
  receipts: Array<{
    id: string;
    agentId: string;
    tool: string;
    status: string;
    summary: string | null;
    inputSha256: string;
    outputSha256: string | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
  messages: Array<{ from: string | null; to: string; at: string }>;
  paper: { name: string; sha256: string; pages: number };
  repository: Record<string, unknown> | null;
  contract: ClaimContract | null;
  planDigest: string | null;
  adapter: { path: string; sha256: string; why: string; source: string; differences: string[] } | null;
  policy: { outcome: string; violations: string[]; warnings: string[] } | null;
  platform: { containerPlatform: string; python: string; accelerator: string; packageIndex: string };
  labImage: LabImage | null;
  dependencies: Omit<PreparedDependencies, "wheelhouseDir"> | null;
  datasets: Array<AcquiredDataset["identity"]>;
  engineers: Array<
    Omit<EngineerOutcome, "submission"> & {
      submission: Submission | null;
      artifacts: Array<{ path: string; sha256: string; bytes: number }>;
    }
  >;
  result: {
    status: ResultStatus;
    computedStatus: ResultStatus;
    supervisor: { proposedStatus: ResultStatus; rationale: string; applied: boolean } | null;
    reasons: string[];
    paperValue: number | null;
    observedValue: number | null;
    absoluteDifference: number | null;
    tolerance: number | null;
  };
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null; providerAttempts: number; toolCalls: number };
  cleanup: {
    labs: CleanupReceipt[];
    dependenciesRemoved: boolean;
    datasetsRemoved: boolean;
    workDirRemoved: boolean;
    leftoverContainers: string[];
    leftoverNetworks: string[];
    liveAgents: string[];
    verified: boolean;
  };
};

export type MultiAgentResult = {
  report: MultiAgentReport;
  repository: { url: string; commitSha: string } | null;
  metric: Metric | null;
  assessment: Assessment | null;
  attempt: Attempt | null;
  stdout: string;
  imageId: string | null;
  failure: string | null;
  cancelled: boolean;
};

type StageOutput = Record<string, unknown>;
type PaperStageOutput = { agentId: string; status: string; reason: string | null; result: PaperClaimResult | null };
type RepositoryStageOutput = {
  agentId: string;
  status: string;
  reason: string | null;
  result: RepositoryMapping | null;
  repository: { url: string; commitSha: string; manifestSha256: string; fileCount: number; totalBytes: number } | null;
};
type PlanStageOutput = {
  agentId: string;
  status: string;
  reason: string | null;
  plan: Plan | null;
  contract: ClaimContract | null;
  reconcileErrors: string[];
};
type PolicyStageOutput = {
  outcome: "approved" | "policy_blocked" | "inconclusive";
  violations: string[];
  warnings: string[];
  planDigest: string | null;
};
type PrepareStageOutput = {
  dependencies: Omit<PreparedDependencies, "wheelhouseDir"> | null;
  datasets: Array<AcquiredDataset["identity"]>;
  labImage: LabImage | null;
  failure: { code: string; outcome: PreparationFailure["outcome"]; message: string; requirement: string | null } | null;
};
type EngineerRecord = EngineerOutcome & {
  labId: string | null;
  imageId: string | null;
  commands: Array<Omit<EngineerLab["commands"][number], "stdoutFull">>;
  artifacts: Array<{ path: string; sha256: string; bytes: number }>;
  environment: EngineerLab["environment"];
  officialStdoutTail: string;
};
type ExecuteStageOutput = {
  engineers: EngineerRecord[];
  failure: { code: string; outcome: PreparationFailure["outcome"]; message: string } | null;
};
type ReviewStageOutput = { reviews: Array<{ engineerAgentId: string; reviewerAgentId: string; status: string; review: Review | null }> };
type DecideStageOutput = {
  status: ResultStatus;
  computedStatus: ResultStatus;
  reasons: string[];
  supervisor: { proposedStatus: ResultStatus; rationale: string; applied: boolean } | null;
};

function stableAgentId(...parts: Array<string | number>): string {
  return `agt_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Result schemas by role, for resuming an agent after a restart. */
function resultSchemaFor(role: AgentRole, task: Record<string, unknown>): z.ZodType {
  const kind = (task.inputs as Record<string, unknown> | undefined)?.resultKind;
  switch (role) {
    case "paper_analyst":
      return PaperClaimResultSchema;
    case "repository_analyst":
      return RepositoryMappingSchema;
    case "reproduction_planner":
      return PlanSchema;
    case "lab_engineer":
      return SubmissionSchema;
    case "debugger":
      return DiagnosisSchema;
    case "independent_reviewer":
      return ReviewSchema;
    case "supervisor":
      return kind === "verdict" ? SupervisorVerdictSchema : SupervisorCheckpointSchema;
  }
}

/**
 * A reproduction study as a persisted, deterministic state machine. Code owns
 * every transition; separate agents do the work inside stages:
 *
 *   ingesting → (analyzing_paper ‖ analyzing_repository) → reconciling (Planner)
 *   → policy_review (code) → preparing (code) → executing (Lab Engineers,
 *   Debuggers on request) → reviewing (Independent Reviewers) → deciding
 *   (code, then the Supervisor may only lower the status).
 *
 * The Supervisor answers at checkpoints (continue, one typed re-plan, or
 * stop); it cannot skip policy, create a lab, or raise a verdict. Completed
 * stages are never rerun without a typed invalidation, so a restart resumes
 * where the study stopped.
 */
export async function runMultiAgentStudy(
  input: { runId: string; paper: PaperDocument; candidates: RepositoryCandidate[]; signal: AbortSignal },
  deps: MultiAgentDependencies,
): Promise<MultiAgentResult> {
  const { runId } = input;
  const { store, config } = deps;
  const stages = store.stages;
  const owner = deps.owner ?? `orchestrator_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const provider = config.provider;
  const event = (type: string, status: RunEvent["status"], summary: string, payload: Record<string, unknown> = {}): void => {
    store.appendEvent({ runId, actor: "system", type, status, summary, evidence: [], publicPayload: payload });
  };
  const advance = (target: RunStatus): void => {
    if (store.isTerminal(runId)) return;
    const current = store.getRun(runId).status;
    const from = PROGRESS.indexOf(current);
    const to = PROGRESS.indexOf(target);
    if (from < 0 || to <= from) return;
    for (let index = from + 1; index <= to; index += 1) store.transitionRun(runId, PROGRESS[index]!);
  };

  if (!stages.state(runId)) {
    stages.begin(runId, {
      // Everything a restarted service needs to resume: the extracted paper, the candidates, the provider, the platform. Never a key.
      paperDocument: input.paper,
      candidates: input.candidates,
      provider,
      platform: config.platform,
    });
  }
  const resumed = stages.stages(runId).some((record) => record.attempt > 0);

  await mkdir(deps.workRoot, { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(join(deps.workRoot, "study-"));
  // Lab users read the checkout and datasets through read-only mounts.
  await chmod(workDir, 0o711);
  const artifactStore = deps.artifacts ?? new LocalArtifactStore(join(deps.workRoot, "exports"));

  const study = new AbortController();
  const onAbort = (): void => study.abort(input.signal.reason);
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) study.abort(input.signal.reason);
  const deadline = setTimeout(() => study.abort(new Error("study time limit reached")), config.maxStudyMs);

  const labReceipts: CleanupReceipt[] = [];
  const ctx: StudyContext = {
    runId,
    paper: input.paper,
    candidates: input.candidates,
    store,
    labs: deps.labs,
    dependencies: deps.dependencies,
    runtime: undefined as unknown as BoundedAgentRuntime,
    config,
    workDir,
    acquire: deps.acquire ?? acquireGithubRepository,
    repository: null,
    pinnedCommit: null,
    contract: null,
    planDigest: null,
    prepared: null,
    datasets: [],
    labsByAgent: new Map(),
    exports: new Map(),
    finishLab: (agentId, reason) => finishLab(agentId, reason),
    event,
  };
  const runtime = new BoundedAgentRuntime({
    store,
    provider: () => deps.chatProvider,
    tools: (agent) => buildStudyTools(ctx, agent),
    resultSchema: resultSchemaFor,
  });
  ctx.runtime = runtime;
  const board = runtime.board(runId);

  // ---------------------------------------------------------------------------
  // Stage and agent helpers.

  const generation = (stage: WorkStage): number =>
    stages.transitions(runId).filter((item) => item.stage === stage && item.to === "invalidated").length;

  async function runStage<T extends StageOutput>(stage: WorkStage, body: () => Promise<T>, options: { skip?: boolean } = {}): Promise<T> {
    if (study.signal.aborted) throw new StudyCancelled();
    const current = stages.stage(runId, stage);
    const retryReason: StageRetryReason | undefined =
      current.attempt > 0 && current.status !== "completed" && current.status !== "skipped"
        ? (current.retryReason ?? "process_restart")
        : undefined;
    const claim = stages.claim(runId, stage, owner, { leaseMs: STAGE_LEASE_MS, ...(retryReason ? { retryReason } : {}) });
    if (claim.completed) {
      event("stage_resumed", "progress", `The ${stage.replaceAll("_", " ")} stage already finished; its saved result is used`, { stage });
      return (claim.record.output ?? {}) as T;
    }
    advance(RUN_STATUS_FOR_STAGE[stage]);
    board.post({
      kind: "stage",
      authorAgentId: null,
      authorRole: "system",
      payload: { stage, status: "started", attempt: claim.record.attempt, retryReason: claim.record.retryReason },
    });
    event(
      "stage_started",
      "started",
      `Stage ${stage.replaceAll("_", " ")} started${claim.record.retryReason ? ` (retry: ${claim.record.retryReason.replaceAll("_", " ")})` : ""}`,
      {
        stage,
        attempt: claim.record.attempt,
        retryReason: claim.record.retryReason,
      },
    );
    const renew = setInterval(() => {
      try {
        stages.renew(runId, stage, owner, STAGE_LEASE_MS);
      } catch {
        // The stage ended meanwhile.
      }
    }, STAGE_LEASE_MS / 3);
    renew.unref();
    try {
      const output = await body();
      if (options.skip) stages.skip(runId, stage, owner, output);
      else stages.complete(runId, stage, owner, output);
      board.post({
        kind: "stage",
        authorAgentId: null,
        authorRole: "system",
        payload: { stage, status: options.skip ? "skipped" : "completed" },
      });
      return output;
    } catch (error) {
      try {
        stages.fail(runId, stage, owner, errorText(error));
      } catch {
        // Already ended.
      }
      board.post({
        kind: "stage",
        authorAgentId: null,
        authorRole: "system",
        payload: { stage, status: "failed", error: errorText(error).slice(0, 500) },
      });
      throw error;
    } finally {
      clearInterval(renew);
    }
  }

  /** Marks every later stage up to `until` as skipped, so the study can decide. */
  async function skipThrough(until: WorkStage, reason: string): Promise<void> {
    for (const stage of WORK_STAGES) {
      if (stage === until) break;
      const record = stages.stage(runId, stage);
      if (record.status === "completed" || record.status === "skipped") continue;
      await runStage(stage, async () => ({ skipped: reason }), { skip: true });
    }
  }

  /**
   * Starts an agent with a stable id, or resumes it after a restart. The id
   * depends on the run, the stage, how often the stage was invalidated, and
   * the label, so a resumed stage finds the same agent instead of starting a
   * duplicate.
   */
  async function launch<T>(
    role: AgentRole,
    options: {
      stage: WorkStage;
      label: string;
      objective: string;
      inputs: Record<string, unknown>;
      schema: z.ZodType<T>;
      parentAgentId?: string | null;
      idSalt?: string | number;
    },
  ): Promise<{ agentId: string; done: Promise<AgentOutcome<T>> }> {
    const agentId = stableAgentId(runId, options.stage, generation(options.stage), options.label, options.idSalt ?? "");
    let existing = false;
    try {
      store.ledger.getAgent(agentId);
      existing = true;
    } catch {
      existing = false;
    }
    if (existing) {
      const handle = await runtime.resumeAgent(agentId);
      return { agentId, done: handle.done as Promise<AgentOutcome<T>> };
    }
    const handle = await runtime.startAgent<T>({
      runId,
      role,
      agentId,
      parentAgentId: options.parentAgentId ?? null,
      label: options.label,
      instructions: INSTRUCTIONS[role],
      objective: options.objective,
      inputs: options.inputs,
      grants: [...ROLE_GRANTS[role]],
      limits: ROLE_LIMITS[role],
      result: { schema: options.schema, description: RESULT_DESCRIPTIONS[role] },
      provider,
    });
    return { agentId, done: handle.done };
  }

  async function ensureRepository(url: string, commitSha: string): Promise<void> {
    if (ctx.repository) return;
    ctx.pinnedCommit = commitSha;
    await acquireRepository(ctx, url, study.signal);
    event("repository_reacquired", "progress", `Fetched ${url} again at the pinned commit ${commitSha.slice(0, 12)}`, { url, commitSha });
  }

  // ---------------------------------------------------------------------------
  // Labs.

  async function finishLab(agentId: string, reason: string): Promise<void> {
    const lab = ctx.labsByAgent.get(agentId);
    if (!lab || lab.destroyed) return;
    lab.destroyed = true;
    ctx.exports.set(agentId, await exportArtifacts(lab));
    const receipt = await deps.labs.destroyLab(lab.labId, reason).catch((error: unknown) => ({
      labId: lab.labId,
      runId,
      containerName: "",
      platform: lab.platform,
      imageId: lab.imageId,
      imageDigest: null,
      reason: `destroy failed: ${errorText(error)}`,
      containerRemoved: false,
      artifactDirectoryRemoved: false,
      verifiedAbsent: false,
      destroyedAt: new Date().toISOString(),
      errors: [errorText(error)],
    }));
    labReceipts.push(receipt);
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
        const stored = await artifactStore.put({ runId, scope: lab.label, path: artifact.path, content: artifact.content });
        const hostPath = stored.uri;
        const text = artifact.content.subarray(0, 1024).includes(0) ? null : artifact.content.toString("utf8");
        exported.push({
          path: artifact.path,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
          hostPath,
          text: text === null ? null : text.slice(0, 200_000),
        });
      } catch {
        // Removed or oversized artifacts are simply not exported.
      }
    }
    return exported;
  }

  const stopAgents = (): void => {
    for (const agentId of runtime.liveAgents()) void runtime.cancelAgent(agentId);
    for (const lab of ctx.labsByAgent.values()) if (!lab.destroyed) void deps.labs.cancelLab(lab.labId).catch(() => undefined);
  };
  study.signal.addEventListener("abort", stopAgents, { once: true });

  // ---------------------------------------------------------------------------
  // The stages.

  let paperOut = null as PaperStageOutput | null;
  let repoOut = null as RepositoryStageOutput | null;
  let planOut = null as PlanStageOutput | null;
  let policyOut = null as PolicyStageOutput | null;
  let prepOut = null as PrepareStageOutput | null;
  let execOut = null as ExecuteStageOutput | null;
  let reviewOut = null as ReviewStageOutput | null;
  const stopReasons: string[] = [];
  const policyViolations: string[] = [];
  let infrastructureFailure = null as string | null;
  let checkpointCount = 0;

  const usedReplans = (): Set<StageRetryReason> =>
    new Set(
      stages
        .transitions(runId)
        .filter((item) => item.stage === "reconciling" && item.to === "invalidated")
        .map((item) => item.reason as StageRetryReason),
    );
  const canReplan = (reason: StageRetryReason): boolean => {
    const used = usedReplans();
    return !used.has(reason) && used.size < config.maxReplans;
  };
  let replanGuidance: Array<{ reason: StageRetryReason; guidance: string; evidence: Record<string, unknown> }> = [];

  async function replan(reason: StageRetryReason, guidance: string, evidence: Record<string, unknown>): Promise<void> {
    replanGuidance = [...replanGuidance, { reason, guidance, evidence }];
    board.post({
      kind: "note",
      authorAgentId: null,
      authorRole: "system",
      payload: { replan: reason, guidance: guidance.slice(0, 2_000), evidence },
    });
    await releasePrepared();
    stages.invalidate(runId, "reconciling", reason);
    ctx.contract = null;
    ctx.planDigest = null;
    event("replan", "warning", `Re-planning (${reason.replaceAll("_", " ")})`, { reason });
  }

  async function checkpoint(
    name: string,
    evidence: Record<string, unknown>,
    allowed: StageRetryReason[],
  ): Promise<SupervisorCheckpoint | null> {
    checkpointCount += 1;
    const available = allowed.filter(canReplan);
    const handle = await launch("supervisor", {
      stage: name === "after_review" ? "reviewing" : "executing",
      label: `supervisor-${name}`,
      idSalt: `${checkpointCount}:${stages.stage(runId, name === "after_review" ? "reviewing" : "executing").attempt}`,
      objective: `Checkpoint ${name.replaceAll("_", " ")}: decide whether the study continues, re-plans once with a typed reason, or stops.`,
      inputs: { resultKind: "checkpoint", checkpoint: name, evidence, replanReasonsAvailable: available },
      schema: SupervisorCheckpointSchema,
    });
    const outcome = await handle.done;
    const decision = outcome.status === "completed" ? (outcome.result ?? null) : null;
    board.post({
      kind: "supervisor_decision",
      authorAgentId: handle.agentId,
      authorRole: "supervisor",
      payload: {
        checkpoint: name,
        action: decision?.action ?? "none",
        reason: decision?.reason ?? null,
        guidance: decision?.guidance ?? outcome.reason ?? "",
      },
    });
    return decision;
  }

  async function releasePrepared(): Promise<void> {
    if (ctx.prepared && deps.dependencies) await deps.dependencies.release(ctx.prepared).catch(() => undefined);
    ctx.prepared = null;
    for (const dataset of ctx.datasets) await deps.datasets?.release(dataset).catch(() => undefined);
    ctx.datasets = [];
  }

  async function analysis(): Promise<void> {
    await runStage("ingesting", async () => ({
      paper: { name: input.paper.file.originalName, sha256: input.paper.file.sha256, pages: input.paper.pageCount },
      candidates: input.candidates.map((candidate) => candidate.repositoryUrl),
      platform: config.platform.containerPlatform,
    }));
    const urls = input.candidates.map((candidate) => candidate.repositoryUrl);
    // The two analysts run at the same time and never see each other's findings.
    [paperOut, repoOut] = await Promise.all([
      runStage<PaperStageOutput>("analyzing_paper", async () => {
        const handle = await launch("paper_analyst", {
          stage: "analyzing_paper",
          label: "paper-analyst",
          objective: "Select the one claim to reproduce.",
          inputs: { paper: { name: input.paper.file.originalName, pages: input.paper.pageCount }, repositoryCandidates: urls },
          schema: PaperClaimResultSchema,
        });
        const outcome = await handle.done;
        const result = outcome.status === "completed" ? (outcome.result ?? null) : null;
        if (result)
          board.post({
            kind: "paper_claim",
            authorAgentId: handle.agentId,
            authorRole: "paper_analyst",
            payload: { claim: result.claim, analysis: result },
          });
        return { agentId: handle.agentId, status: outcome.status, reason: outcome.reason, result };
      }),
      runStage<RepositoryStageOutput>("analyzing_repository", async () => {
        const handle = await launch("repository_analyst", {
          stage: "analyzing_repository",
          label: "repository-analyst",
          objective: "Acquire and map the paper's repository.",
          inputs: {
            repositoryCandidates: input.candidates.map((candidate) => ({
              url: candidate.repositoryUrl,
              namedByUploader: candidate.providedByUser === true,
              pages: candidate.occurrences.map((item) => item.pageNumber),
            })),
          },
          schema: RepositoryMappingSchema,
        });
        const outcome = await handle.done;
        const result = outcome.status === "completed" ? (outcome.result ?? null) : null;
        if (result)
          board.post({ kind: "repository_mapping", authorAgentId: handle.agentId, authorRole: "repository_analyst", payload: result });
        const receipt = ctx.repository?.receipt ?? null;
        return {
          agentId: handle.agentId,
          status: outcome.status,
          reason: outcome.reason,
          result,
          repository: receipt
            ? {
                url: receipt.repositoryUrl,
                commitSha: receipt.commitSha,
                manifestSha256: receipt.manifestSha256,
                fileCount: receipt.fileCount,
                totalBytes: receipt.totalBytes,
              }
            : null,
        };
      }),
    ]);
  }

  async function plan(): Promise<boolean> {
    const claim = paperOut?.result?.claim ?? null;
    const repository = repoOut?.repository ?? null;
    planOut = await runStage<PlanStageOutput>("reconciling", async () => {
      const handle = await launch("reproduction_planner", {
        stage: "reconciling",
        label: "planner",
        objective: "Plan the reproduction of the selected claim with the repository's official code.",
        inputs: {
          claim,
          repository,
          lab: {
            platform: config.platform.containerPlatform,
            accelerator: "CPU only",
            pythonVersions: ["3.10", "3.11", "3.12", "3.13"],
            network: "none during execution",
            cpus: config.resources.cpus,
            memoryMb: config.resources.memoryMb,
            commandTimeoutSeconds: config.commandTimeoutSeconds,
          },
          datasetHostsAllowed: config.datasetPolicy.allowedHosts,
          trustedCompatibilityConstraints: config.trustedConstraints,
          dependencyPreparation: deps.dependencies ? "available" : "disabled on this server",
          previousRounds: replanGuidance,
        },
        schema: PlanSchema,
      });
      const outcome = await handle.done;
      const plan = outcome.status === "completed" ? (outcome.result ?? null) : null;
      if (plan) board.post({ kind: "plan", authorAgentId: handle.agentId, authorRole: "reproduction_planner", payload: plan });
      let contract: ClaimContract | null = null;
      let reconcileErrors: string[] = [];
      if (plan?.status === "ready" && claim && repository) {
        const reconciled = reconcile({ claim, plan, repository, platform: config.platform, pages: ctx.paper.pages });
        if (reconciled.ok) contract = reconciled.contract;
        else reconcileErrors = reconciled.reasons;
      }
      return { agentId: handle.agentId, status: outcome.status, reason: outcome.reason, plan, contract, reconcileErrors };
    });
    const result = planOut;
    if (!result.plan) {
      stopReasons.push(`the Planner did not finish (${result.status}${result.reason ? `: ${result.reason}` : ""})`);
      return false;
    }
    if (result.plan.status === "blocked") {
      policyViolations.push(result.plan.blockedReason ?? result.plan.summary);
      return false;
    }
    if (result.plan.status === "inconclusive" || !result.contract) {
      stopReasons.push(
        result.reconcileErrors.length
          ? `the plan is incomplete: ${result.reconcileErrors.join("; ")}`
          : `the plan is inconclusive: ${result.plan.summary}`,
      );
      return false;
    }
    ctx.contract = result.contract;

    policyOut = await runStage<PolicyStageOutput>("policy_review", async () => {
      const files = new Set((ctx.repository?.receipt.manifest ?? []).map((entry) => entry.path));
      const review = reviewPolicy({
        contract: result.contract!,
        adapter: result.plan!.adapter,
        repository: { commitSha: ctx.repository?.receipt.commitSha ?? "", files },
        datasetPolicy: config.datasetPolicy,
        dependencies: deps.dependencies,
        commandTimeoutSeconds: config.commandTimeoutSeconds,
        trustedConstraints: config.trustedConstraints,
      });
      if (review.outcome === "approved") {
        board.post({
          kind: "claim_contract",
          authorAgentId: null,
          authorRole: "system",
          payload: { planDigest: review.planDigest, contract: result.contract!, adapter: result.plan!.adapter, warnings: review.warnings },
        });
        event("plan_approved", "completed", `Policy review approved the plan (digest ${review.planDigest.slice(0, 12)})`, {
          planDigest: review.planDigest,
          warnings: review.warnings,
        });
      } else {
        board.post({
          kind: "policy_block",
          authorAgentId: null,
          authorRole: "system",
          payload: { reason: review.violations.join("; "), outcome: review.outcome },
        });
        event("plan_refused", "warning", `Policy review refused the plan: ${review.violations[0] ?? review.outcome}`, {
          outcome: review.outcome,
          violations: review.violations,
        });
      }
      return {
        outcome: review.outcome,
        violations: review.violations,
        warnings: review.warnings,
        planDigest: review.outcome === "approved" ? review.planDigest : null,
      };
    });
    if (policyOut.outcome === "policy_blocked") {
      policyViolations.push(...policyOut.violations);
      return false;
    }
    if (policyOut.outcome === "inconclusive") {
      stopReasons.push(...policyOut.violations.map((item) => `plan refused: ${item}`));
      return false;
    }
    ctx.planDigest = policyOut.planDigest;
    return true;
  }

  async function prepare(): Promise<"ready" | "replan" | "stop"> {
    const contract = ctx.contract!;
    // On resume, a completed preparation whose files are gone is prepared again (it is hash-pinned and deterministic).
    const saved = stages.stage(runId, "preparing");
    if (
      saved.status === "completed" &&
      !ctx.prepared &&
      ((saved.output as PrepareStageOutput | null)?.dependencies || (saved.output as PrepareStageOutput | null)?.datasets.length)
    ) {
      stages.invalidate(runId, "preparing", "process_restart");
    }
    prepOut = await runStage<PrepareStageOutput>("preparing", async () => {
      try {
        const labImage = await deps.images.ensure({ platform: contract.environment.platform, signal: study.signal });
        event("lab_image_ready", "completed", `Lab image ready for ${labImage.containerPlatform}, Python ${labImage.python}`, {
          image: labImage.name,
          digest: labImage.digest,
          imageId: labImage.imageId,
        });
        if (contract.environment.requirements.length && deps.dependencies) {
          ctx.prepared = await deps.dependencies.prepare({
            runId,
            platform: contract.environment.platform,
            requirements: contract.environment.requirements,
            constraints: contract.environment.compatibilityConstraints,
            signal: study.signal,
          });
          const { wheelhouseDir: _dir, ...recorded } = ctx.prepared;
          board.post({ kind: "dependency_manifest", authorAgentId: null, authorRole: "system", payload: recorded });
          event(
            "dependencies_prepared",
            "completed",
            `Prepared ${ctx.prepared.packages.length} verified wheels for ${ctx.prepared.containerPlatform}`,
            {
              manifestSha256: ctx.prepared.manifestSha256,
              packages: ctx.prepared.packages.length,
              changes: ctx.prepared.changes,
            },
          );
        }
        const source = contract.dataset.source;
        if (source.kind === "download") {
          if (!deps.datasets)
            throw new PreparationFailure("datasets_disabled", "dataset downloads are disabled on this server", "policy_blocked");
          const root = join(workDir, "datasets");
          await mkdir(root, { recursive: true, mode: 0o711 });
          const dataset = await deps.datasets.acquire({
            runId,
            name: contract.dataset.name,
            url: source.url,
            sha256: source.sha256,
            extract: source.extract,
            destinationDir: join(root, "d0"),
            signal: study.signal,
          });
          ctx.datasets.push(dataset);
          board.post({
            kind: "dataset_receipt",
            authorAgentId: null,
            authorRole: "system",
            payload: { ...dataset.identity, labPath: dataset.labPath },
          });
          event(
            "dataset_acquired",
            "completed",
            `Downloaded dataset ${contract.dataset.name} (${dataset.identity.bytes} bytes, checksum verified)`,
            { sha256: dataset.identity.sha256 },
          );
        }
        const datasets = ctx.datasets.map((item) => item.identity);
        if (source.kind === "package") {
          // The dataset's identity is the verified wheel that carries it.
          const normalized = source.package.toLowerCase().replace(/[-_.]+/gu, "-");
          const wheel = ctx.prepared?.packages.find((item) => item.name.toLowerCase().replace(/[-_.]+/gu, "-") === normalized);
          if (!wheel)
            throw new PreparationFailure(
              "dataset_package_missing",
              `the dataset package ${source.package} was not prepared`,
              "inconclusive",
              source.package,
            );
          const identity = {
            name: contract.dataset.name,
            requestedUrl: `wheel:${wheel.filename}#${source.path}`,
            finalUrl: `wheel:${wheel.filename}#${source.path}`,
            sha256: wheel.sha256,
            bytes: wheel.bytes,
            checksumVerified: true,
            extracted: null,
            fetchedAt: new Date().toISOString(),
          };
          datasets.push(identity);
          board.post({
            kind: "dataset_receipt",
            authorAgentId: null,
            authorRole: "system",
            payload: { ...identity, labPath: `${LAB_LAYOUT.venv} (${source.package} ${wheel.version})` },
          });
        }
        const { wheelhouseDir: _dir, ...recorded } = ctx.prepared ?? { wheelhouseDir: "" };
        return {
          dependencies: ctx.prepared ? (recorded as Omit<PreparedDependencies, "wheelhouseDir">) : null,
          datasets,
          labImage,
          failure: null,
        };
      } catch (error) {
        if (!(error instanceof PreparationFailure)) throw error;
        await releasePrepared();
        board.post({
          kind: "note",
          authorAgentId: null,
          authorRole: "system",
          payload: { preparationFailure: error.code, message: error.message, requirement: error.requirement },
        });
        event("preparation_failed", "warning", `Preparation failed: ${error.code}`, {
          code: error.code,
          requirement: error.requirement,
          outcome: error.outcome,
        });
        return {
          dependencies: null,
          datasets: [],
          labImage: null,
          failure: { code: error.code, outcome: error.outcome, message: error.message, requirement: error.requirement },
        };
      }
    });
    const failure = prepOut.failure;
    if (!failure) return "ready";
    if (failure.outcome === "replan" && canReplan("dependency_failure_replan")) {
      await replan(
        "dependency_failure_replan",
        `Preparation failed with ${failure.code}${failure.requirement ? ` for ${failure.requirement}` : ""}: ${failure.message}`,
        { failure },
      );
      return "replan";
    }
    if (failure.outcome === "failed") infrastructureFailure = `preparation failed: ${failure.message}`;
    else if (failure.outcome === "policy_blocked") policyViolations.push(`${failure.code}: ${failure.message}`);
    else stopReasons.push(`preparation failed (${failure.code}): ${failure.message}`);
    return "stop";
  }

  async function execute(): Promise<"reviewed" | "replan" | "stop"> {
    const contract = ctx.contract!;
    const adapter = planOut?.plan?.adapter ?? null;
    const labImage = prepOut!.labImage!;
    const attempt = stages.stage(runId, "executing").attempt;
    execOut = await runStage<ExecuteStageOutput>("executing", async () => {
      const count = Math.max(1, Math.min(3, config.engineers));
      try {
        const engineers = await Promise.all(
          Array.from({ length: count }, (_, index) => runEngineer(`engineer-${index + 1}`, attempt + 1, contract, adapter, labImage)),
        );
        return { engineers, failure: null };
      } catch (error) {
        if (!(error instanceof PreparationFailure)) throw error;
        return { engineers: [], failure: { code: error.code, outcome: error.outcome, message: error.message } };
      }
    });
    restoreLabs(execOut.engineers);
    if (execOut.failure) {
      if (execOut.failure.outcome === "replan" && canReplan("dependency_failure_replan")) {
        await replan("dependency_failure_replan", `Lab setup failed with ${execOut.failure.code}: ${execOut.failure.message}`, {
          failure: execOut.failure,
        });
        return "replan";
      }
      if (execOut.failure.outcome === "failed") infrastructureFailure = `lab setup failed: ${execOut.failure.message}`;
      else stopReasons.push(`lab setup failed (${execOut.failure.code}): ${execOut.failure.message}`);
      return "stop";
    }
    const measured = execOut.engineers.filter((item) => item.official?.exitCode === 0 && item.metric?.ok);
    const requests = execOut.engineers.flatMap((item) => (item.dependencyRequest ? [item.dependencyRequest] : []));
    if (measured.length === 0) {
      const decision = await checkpoint(
        "after_execution",
        {
          engineers: execOut.engineers.map((item) => ({
            label: item.label,
            status: item.submission?.status ?? item.agentStatus,
            official: item.official ? { exitCode: item.official.exitCode, timedOut: item.official.timedOut } : null,
            metric: item.metric,
            failureReason: item.submission?.failureReason ?? item.agentReason,
          })),
          dependencyRequests: requests,
        },
        requests.length ? ["dependency_failure_replan", "execution_failed_replan"] : ["execution_failed_replan"],
      );
      if (decision?.action === "replan" && decision.reason !== "none" && canReplan(decision.reason)) {
        await replan(decision.reason, decision.guidance, { dependencyRequests: requests });
        return "replan";
      }
      stopReasons.push(
        decision?.action === "stop"
          ? `the Supervisor stopped the study: ${decision.guidance.slice(0, 500)}`
          : "no engineer measured the claim with the approved command",
      );
      await skipThrough("deciding", "nothing was measured");
      return "stop";
    }

    reviewOut = await runStage<ReviewStageOutput>("reviewing", async () => {
      const reviews = await Promise.all(
        measured.map(async (engineer) => {
          const handle = await launch("independent_reviewer", {
            stage: "reviewing",
            label: `reviewer-${engineer.label}`,
            objective: `Review ${engineer.label}'s measurement independently.`,
            inputs: {
              submissionKey: engineer.engineerAgentId,
              contract,
              planDigest: ctx.planDigest,
              adapter,
              officialReceiptId: engineer.official?.receiptId ?? null,
              parsedMetric: engineer.metric,
              valueInPaperUnit: engineer.value,
              declaredDeviations: engineer.submission?.deviations ?? [],
              exportedArtifacts: (ctx.exports.get(engineer.engineerAgentId) ?? []).map((item) => ({
                path: item.path,
                sha256: item.sha256,
                bytes: item.bytes,
              })),
              hint: "Read board entries with key = submissionKey (command_receipt, artifact, metric, submission); use logs_read and artifact_read with engineerAgentId = submissionKey.",
            },
            schema: ReviewSchema,
          });
          const outcome = await handle.done;
          const review = outcome.status === "completed" ? (outcome.result ?? null) : null;
          if (review)
            board.post({
              kind: "review",
              authorAgentId: handle.agentId,
              authorRole: "independent_reviewer",
              key: engineer.engineerAgentId,
              payload: review,
            });
          return { engineerAgentId: engineer.engineerAgentId, reviewerAgentId: handle.agentId, status: outcome.status, review };
        }),
      );
      return { reviews };
    });
    for (const item of reviewOut.reviews) {
      const engineer = execOut.engineers.find((entry) => entry.engineerAgentId === item.engineerAgentId);
      if (engineer) {
        engineer.review = item.review;
        engineer.reviewerAgentId = item.reviewerAgentId;
      }
    }
    const approved = reviewOut.reviews.filter((item) => item.review?.verdict === "approve" && item.review.equivalence !== "not_equivalent");
    if (approved.length === 0) {
      const decision = await checkpoint(
        "after_review",
        {
          reviews: reviewOut.reviews.map((item) => ({
            verdict: item.review?.verdict ?? item.status,
            equivalence: item.review?.equivalence ?? null,
            concerns: item.review?.concerns ?? [],
          })),
        },
        ["reviewer_rejected_replan"],
      );
      if (decision?.action === "replan" && decision.reason === "reviewer_rejected_replan" && canReplan("reviewer_rejected_replan")) {
        await replan("reviewer_rejected_replan", decision.guidance, {
          reviews: reviewOut.reviews.map((item) => item.review?.concerns ?? []),
        });
        return "replan";
      }
    }
    return "reviewed";
  }

  function restoreLabs(engineers: EngineerRecord[]): void {
    // After a restart the labs are gone; their records come back from the stage output for the Reviewers.
    for (const item of engineers) {
      if (ctx.labsByAgent.has(item.engineerAgentId)) continue;
      ctx.labsByAgent.set(item.engineerAgentId, {
        agentId: item.engineerAgentId,
        label: item.label,
        labId: item.labId ?? "",
        imageId: item.imageId ?? "",
        platform: config.platform.containerPlatform,
        commands: item.commands.map((command) => ({ ...command, stdoutFull: null })),
        artifacts: new Map(item.artifacts.map((artifact) => [artifact.path, artifact])),
        integrity: { workRepo: null, venv: null, adapter: null },
        environment: item.environment,
        official: null,
        dependencyRequest: item.dependencyRequest,
        destroyed: true,
      });
    }
  }

  async function runEngineer(
    label: string,
    round: number,
    contract: ClaimContract,
    adapter: Plan["adapter"],
    labImage: LabImage,
  ): Promise<EngineerRecord> {
    const agentId = stableAgentId(runId, "executing", generation("executing"), label, round);
    const inputs: Array<{ hostPath: string; containerPath: string }> = [
      { hostPath: ctx.repository!.dir, containerPath: LAB_LAYOUT.repoDir },
    ];
    if (ctx.prepared) inputs.push({ hostPath: ctx.prepared.wheelhouseDir, containerPath: LAB_LAYOUT.wheelsDir });
    if (ctx.datasets[0]) inputs.push({ hostPath: ctx.datasets[0].root, containerPath: LAB_LAYOUT.dataDir });
    const spec = LabSpecSchema.parse({
      runId,
      image: labImage.name,
      expectedImageId: labImage.imageId,
      platform: labImage.containerPlatform,
      workdir: LAB_LAYOUT.workdir,
      artifactsDir: LAB_LAYOUT.artifactsDir,
      scratchDir: LAB_LAYOUT.scratchDir,
      inputs,
      resources: config.resources,
      limits: DEFAULT_LAB_LIMITS,
    });
    let handle;
    try {
      handle = await deps.labs.createLab(spec);
    } catch (error) {
      throw new PreparationFailure("lab_unavailable", `the lab could not be created: ${errorText(error)}`, "failed");
    }
    const lab: EngineerLab = {
      agentId,
      label,
      labId: handle.labId,
      imageId: handle.imageId,
      platform: labImage.containerPlatform,
      commands: [],
      artifacts: new Map(),
      integrity: { workRepo: null, venv: null, adapter: null },
      environment: null,
      official: null,
      dependencyRequest: null,
      destroyed: false,
    };
    ctx.labsByAgent.set(agentId, lab);
    let outcome: AgentOutcome<Submission> | null = null;
    try {
      await setUpLab(lab, contract, adapter);
      const engineer = await launch("lab_engineer", {
        stage: "executing",
        label,
        idSalt: round,
        objective: "Run the approved command for the claim in your lab and report the result.",
        inputs: {
          contract,
          planDigest: ctx.planDigest,
          adapter: adapter ? { path: adapter.path, why: adapter.why, differences: adapter.differences } : null,
          layout: LAB_LAYOUT,
          environment: lab.environment,
          datasets: ctx.datasets.map((item) => ({ name: item.identity.name, path: item.labPath, sha256: item.identity.sha256 })),
          limits: { commandTimeoutSeconds: config.commandTimeoutSeconds, cpus: config.resources.cpus, memoryMb: config.resources.memoryMb },
        },
        schema: SubmissionSchema,
      });
      // The orchestrator made the lab under this id before the agent existed; the ids match by construction.
      if (engineer.agentId !== agentId) throw new Error("engineer id mismatch");
      outcome = await engineer.done;
    } finally {
      await finishLab(agentId, `${label} finished`);
    }
    const submission = outcome?.status === "completed" ? (outcome.result ?? null) : null;
    const exported = ctx.exports.get(agentId) ?? [];
    const official: OfficialRun | null = lab.official
      ? {
          receiptId: lab.official.receiptId,
          argv: lab.official.argv,
          cwd: lab.official.cwd,
          exitCode: lab.official.exitCode,
          timedOut: lab.official.timedOut,
          durationMs: lab.official.durationMs,
          stdoutSha256: lab.official.stdoutSha256,
        }
      : null;
    let metric = null;
    let value: number | null = null;
    if (lab.official && lab.official.exitCode === 0 && !lab.official.timedOut) {
      // Only artifacts exactly as the official run wrote them count.
      const producedBy = new Map(lab.official.artifacts.map((item) => [item.path, item.sha256]));
      const artifacts = new Map(exported.filter((item) => producedBy.get(item.path) === item.sha256).map((item) => [item.path, item.text]));
      metric = await parseMetric(contract.metricParser, { stdout: lab.official.stdoutFull ?? "", artifacts });
      if (metric.ok) value = convertUnit(metric.value, metric.unit, contract.metric.unit);
      board.post({
        kind: "metric",
        authorAgentId: null,
        authorRole: "system",
        key: agentId,
        payload: {
          value,
          raw: metric.ok ? metric.value : null,
          unit: contract.metric.unit,
          receiptId: lab.official.receiptId,
          source: metric.ok ? metric.source : null,
          problem: metric.ok ? null : metric.reason,
        },
      });
    }
    for (const artifact of exported) {
      board.post({
        kind: "artifact",
        authorAgentId: null,
        authorRole: "system",
        key: agentId,
        payload: { path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes, engineer: label },
      });
    }
    board.post({
      kind: "submission",
      authorAgentId: agentId,
      authorRole: "lab_engineer",
      key: agentId,
      payload: { engineer: label, agentStatus: outcome?.status ?? "failed", ...(submission ?? {}) },
    });
    event(
      "engineer_finished",
      metric?.ok ? "completed" : "warning",
      metric?.ok
        ? `${label} measured ${String(value)} ${contract.metric.unit} with the approved command`
        : `${label} produced no measurement (${official ? `exit ${String(official.exitCode)}` : (outcome?.status ?? "failed")})`,
      { engineer: label, agentId },
    );
    return {
      engineerAgentId: agentId,
      label,
      agentStatus: outcome?.status ?? "failed",
      agentReason: outcome?.reason ?? null,
      submission,
      official,
      metric,
      value,
      review: null,
      reviewerAgentId: null,
      dependencyRequest: lab.dependencyRequest,
      labId: lab.labId,
      imageId: lab.imageId,
      commands: lab.commands.slice(-60).map(({ stdoutFull: _full, ...command }) => ({
        ...command,
        stdoutTail: command.stdoutTail.slice(-4_000),
        stderrTail: command.stderrTail.slice(-4_000),
      })),
      artifacts: exported.map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
      environment: lab.environment,
      officialStdoutTail: lab.official?.stdoutTail.slice(-8_000) ?? "",
    };
  }

  /** The orchestrator prepares the lab; the Engineer starts only after this. */
  async function setUpLab(lab: EngineerLab, contract: ClaimContract, adapter: Plan["adapter"]): Promise<void> {
    const actor = orchestratorActor;
    const must = async (argv: string[], what: string, outcome: PreparationFailure["outcome"], timeout = 600): Promise<void> => {
      const record = await runInLab(ctx, lab, actor(), argv, LAB_LAYOUT.workdir, {}, timeout);
      if (record.exitCode !== 0)
        throw new PreparationFailure(
          `lab_${what.replaceAll(" ", "_")}_failed`,
          `${what} failed: ${record.stderrTail.slice(-800)}`,
          outcome,
        );
    };
    if (contract.command.cwd === LAB_LAYOUT.workRepo) {
      await must(
        [
          "python",
          "-I",
          "-S",
          "-c",
          "import shutil, sys; shutil.copytree(sys.argv[1], sys.argv[2], symlinks=True)",
          LAB_LAYOUT.repoDir,
          LAB_LAYOUT.workRepo,
        ],
        "copy repository",
        "failed",
      );
    }
    if (adapter) {
      await deps.labs.writeScratchFile(lab.labId, adapter.path, adapter.content, lab.commands.length + 1);
    }
    if (ctx.prepared?.installerWheel) {
      const { offlineInstallCommands } = await import("@dejaml/prep");
      const commands = offlineInstallCommands({
        wheelhouse: `${LAB_LAYOUT.workdir}/${LAB_LAYOUT.wheelsDir}`,
        venv: LAB_LAYOUT.venv,
        installerWheel: ctx.prepared.installerWheel,
      });
      for (const argv of commands) await must(argv, "offline install", "replan", 900);
    } else {
      await must(["python", "-m", "venv", "--without-pip", LAB_LAYOUT.venv], "create environment", "failed");
    }
    const inspect = await runInLab(
      ctx,
      lab,
      actor(),
      [`${LAB_LAYOUT.venv}/bin/python`, "-c", "import json, platform; print(json.dumps({'python': platform.python_version()}))"],
      LAB_LAYOUT.workdir,
      {},
      60,
    );
    try {
      lab.environment = {
        python: (JSON.parse(inspect.stdoutTail) as { python: string }).python,
        distributions: (ctx.prepared?.packages ?? []).map((item) => ({ name: item.name, version: item.version })),
      };
    } catch {
      lab.environment = { python: null, distributions: [] };
    }
    if (lab.environment.python && !lab.environment.python.startsWith(`${contract.environment.platform.python.version}.`)) {
      throw new PreparationFailure(
        "python_mismatch",
        `the lab's Python ${lab.environment.python} does not match the approved ${contract.environment.platform.python.version}`,
        "failed",
      );
    }
    lab.integrity = await measureIntegrity(ctx, lab, contract.dataset.source.kind === "repository" ? contract.dataset.source.paths : []);
    event(
      "lab_ready",
      "completed",
      `${lab.label}'s lab is ready: repository, ${ctx.prepared ? `${ctx.prepared.packages.length} packages installed offline` : "standard library only"}, Python ${lab.environment.python ?? "unknown"}`,
      {
        engineer: lab.label,
        imageId: lab.imageId,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Drive the stages.

  let decision = null as StatusDecision | null;
  let supervisorProposal = null as SupervisorVerdict | null;
  let supervisorApplied = false;
  let finalStatus: ResultStatus = "failed";
  try {
    event(
      "study_team",
      "started",
      resumed ? "Resuming the study from its saved stages" : "Independent agents will run the study, stage by stage",
      {
        runtime: "native autonomous agent runtime",
        provider: provider.id,
        model: provider.model,
        platform: config.platform.containerPlatform,
        resumed,
      },
    );
    await analysis();
    if (repoOut?.repository && !ctx.repository) await ensureRepository(repoOut.repository.url, repoOut.repository.commitSha);
    if (!paperOut?.result?.claim || paperOut.result.status !== "ready") {
      stopReasons.push(
        paperOut?.result
          ? `no testable claim: ${paperOut.result.reasons.join("; ") || paperOut.result.summary}`
          : `the Paper Analyst did not finish (${paperOut?.status ?? "unknown"})`,
      );
    } else if (!repoOut?.repository) {
      stopReasons.push(
        repoOut?.result
          ? `the repository was not acquired: ${repoOut.result.summary}`
          : `the Repository Analyst did not finish (${repoOut?.status ?? "unknown"})`,
      );
    } else {
      for (let round = 0; round <= config.maxReplans; round += 1) {
        if (!(await plan())) break;
        const prepared = await prepare();
        if (prepared === "replan") continue;
        if (prepared === "stop") break;
        const executed = await execute();
        if (executed === "replan") continue;
        break;
      }
    }
    if (!infrastructureFailure) {
      await skipThrough("deciding", stopReasons[0] ?? policyViolations[0] ?? "not needed");
      const out = await runStage<DecideStageOutput>("deciding", async () => {
        const computed = decide(false);
        let proposal: SupervisorVerdict | null = null;
        const handle = await launch("supervisor", {
          stage: "deciding",
          label: "supervisor-verdict",
          objective: "Propose the final status the evidence supports.",
          inputs: { resultKind: "verdict", computedStatus: computed.status, reasons: computed.reasons },
          schema: SupervisorVerdictSchema,
        });
        const outcome = await handle.done;
        if (outcome.status === "completed" && outcome.result) proposal = outcome.result;
        const applied = applySupervisor(computed.status, proposal?.proposedStatus ?? null);
        const reasons = [...computed.reasons];
        if (applied.overridden) reasons.push(`the Supervisor made the result more cautious: ${proposal!.rationale.slice(0, 500)}`);
        board.post({
          kind: "status_decision",
          authorAgentId: null,
          authorRole: "system",
          payload: { status: applied.status, computedStatus: computed.status, reasons, supervisorProposal: proposal },
        });
        return {
          status: applied.status,
          computedStatus: computed.status,
          reasons,
          supervisor: proposal
            ? { proposedStatus: proposal.proposedStatus, rationale: proposal.rationale, applied: applied.overridden }
            : null,
        };
      });
      decision = decide(false);
      decision.reasons = out.reasons;
      finalStatus = out.status;
      supervisorProposal = out.supervisor
        ? { proposedStatus: out.supervisor.proposedStatus as SupervisorVerdict["proposedStatus"], rationale: out.supervisor.rationale }
        : null;
      supervisorApplied = out.supervisor?.applied ?? false;
    }
  } catch (error) {
    if (!(error instanceof StudyCancelled) && !study.signal.aborted) infrastructureFailure = errorText(error);
  }
  const cancelled = input.signal.aborted || (study.signal.aborted && !infrastructureFailure);
  if (cancelled || infrastructureFailure || !decision) {
    if (study.signal.aborted && !input.signal.aborted && !infrastructureFailure) infrastructureFailure = errorText(study.signal.reason);
    decision = decide(input.signal.aborted);
    finalStatus = decision.status;
  }

  function decide(isCancelled: boolean): StatusDecision {
    const engineers = execOut?.engineers ?? [];
    return decideStatus({
      cancelled: isCancelled,
      failure: infrastructureFailure,
      policyViolations,
      stopReasons,
      contract: ctx.contract,
      adapter: Boolean(planOut?.plan?.adapter),
      outcomes: engineers,
      engineersLaunched: engineers.length,
    });
  }

  // ---------------------------------------------------------------------------
  // Cleanup on every path: agents, labs, prepared files, checkouts, temp files.

  clearTimeout(deadline);
  input.signal.removeEventListener("abort", onAbort);
  study.signal.removeEventListener("abort", stopAgents);
  for (const agentId of runtime.liveAgents()) await runtime.cancelAgent(agentId).catch(() => undefined);
  for (const lab of ctx.labsByAgent.values()) if (!lab.destroyed) await finishLab(lab.agentId, "study finished");
  let dependenciesRemoved = true;
  if (ctx.prepared && deps.dependencies)
    dependenciesRemoved = (await deps.dependencies.release(ctx.prepared).catch(() => ({ removed: false }))).removed;
  let datasetsRemoved = true;
  for (const dataset of ctx.datasets) {
    const released = await deps.datasets?.release(dataset).catch(() => ({ removed: false }));
    if (released && !released.removed) datasetsRemoved = false;
  }
  if (ctx.repository) {
    await cleanupAcquiredRepository({ destination: ctx.repository.receipt.destination, destinationRoot: ctx.repository.root }).catch(
      () => undefined,
    );
  }
  await rm(workDir, { recursive: true, force: true });
  const workDirRemoved = !(await stat(workDir).then(
    () => true,
    () => false,
  ));
  const leaks = await (deps.leakCheck ?? dockerLeakCheck)(runId).catch((error: unknown) => ({
    containers: [`leak check failed: ${String(error)}`],
    networks: [],
  }));
  const liveAgents = runtime.liveAgents();
  const cleanup = {
    labs: labReceipts,
    dependenciesRemoved,
    datasetsRemoved,
    workDirRemoved,
    leftoverContainers: leaks.containers,
    leftoverNetworks: leaks.networks,
    liveAgents,
    verified:
      labReceipts.every((receipt) => receipt.verifiedAbsent) &&
      dependenciesRemoved &&
      datasetsRemoved &&
      workDirRemoved &&
      leaks.containers.length === 0 &&
      leaks.networks.length === 0 &&
      liveAgents.length === 0,
  };
  event(
    "study_cleanup",
    cleanup.verified ? "completed" : "failed",
    cleanup.verified
      ? `Destroyed ${labReceipts.length} lab(s) and removed prepared files; nothing from this study is left running`
      : "Some study resources could not be verified as removed",
    cleanup,
  );

  // ---------------------------------------------------------------------------
  // Terminal state: the study state machine and the run both end, once.

  if (!stages.state(runId)?.terminal) stages.finish(runId, terminalStageFor(finalStatus), finalStatus);
  if (!store.isTerminal(runId)) {
    const target = runStatusFor(finalStatus);
    if (target === "completed" || target === "inconclusive") {
      const current = store.getRun(runId).status;
      if (target === "completed" || current === "preparing_lab" || current === "running") advance("comparing");
    }
    store.transitionRun(runId, target);
  }
  event("study_result", finalStatus === "reproduced" ? "completed" : "warning", `Result: ${finalStatus.replaceAll("_", " ")}`, {
    status: finalStatus,
    reasons: decision.reasons,
  });

  const report = buildReport();
  const representative = decision.representative;
  const contract = ctx.contract;
  return {
    report,
    repository: repoOut?.repository ? { url: repoOut.repository.url, commitSha: repoOut.repository.commitSha } : null,
    metric:
      representative && contract && representative.value !== null && representative.official && representative.metric?.ok
        ? {
            name: contract.metric.name,
            value: representative.value,
            unit: contract.metric.unit,
            split: contract.split,
            attemptId: `${runId}:${representative.label}:${representative.official.receiptId}`,
            extractionRule: representative.metric.source,
            evidence: {
              kind: contract.metricParser.source === "stdout" ? "log_line" : "artifact",
              reference: representative.metric.source,
            },
          }
        : null,
    assessment: contract ? assessmentFor(decision, contract) : null,
    attempt: representative?.official ? attemptFor(representative) : null,
    stdout: execOut?.engineers.find((item) => item.engineerAgentId === representative?.engineerAgentId)?.officialStdoutTail ?? "",
    imageId: prepOut?.labImage?.imageId ?? null,
    failure:
      finalStatus === "reproduced" || finalStatus === "partially_reproduced" || finalStatus === "not_reproduced"
        ? null
        : decision.reasons.join("; ") || null,
    cancelled: finalStatus === "cancelled",
  };

  function attemptFor(outcome: EngineerOutcome): Attempt {
    const official = outcome.official!;
    const now = new Date().toISOString();
    const artifacts = execOut?.engineers.find((item) => item.engineerAgentId === outcome.engineerAgentId)?.artifacts ?? [];
    return {
      id: `${runId}:${outcome.label}:${official.receiptId}`,
      runId,
      number: 1,
      label: "baseline",
      command: { executable: "python", args: official.argv.slice(1), cwd: official.cwd, env: {} },
      changes: planOut?.plan?.adapter ? [`adapter ${planOut.plan.adapter.path}`] : [],
      startedAt: now,
      endedAt: now,
      exitCode: official.exitCode,
      timedOut: official.timedOut,
      cancelled: false,
      artifactDigests: Object.fromEntries(artifacts.map((item) => [item.path, item.sha256])),
    };
  }

  function buildReport(): MultiAgentReport {
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
    const adapter = planOut?.plan?.adapter ?? null;
    const representative = decision!.representative;
    return {
      runtime: "native autonomous agent runtime",
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
      stages: stages.stages(runId).map(({ stage, status, attempt, retryReason, error, startedAt, endedAt }) => ({
        stage,
        status,
        attempt,
        retryReason,
        error,
        startedAt,
        endedAt,
      })),
      transitions: stages.transitions(runId).map(({ stage, from, to, attempt, reason, at }) => ({ stage, from, to, attempt, reason, at })),
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
      messages: store.ledger.listMessages({ runId }).map((item) => ({ from: item.fromAgentId, to: item.toAgentId, at: item.createdAt })),
      paper: { name: input.paper.file.originalName, sha256: input.paper.file.sha256, pages: input.paper.pageCount },
      repository: ctx.repository || repoOut?.repository ? (repoOut?.repository ?? null) : null,
      contract: ctx.contract,
      planDigest: ctx.planDigest,
      adapter: adapter
        ? {
            path: adapter.path,
            sha256: createHash("sha256").update(adapter.content).digest("hex"),
            why: adapter.why,
            source: adapter.source,
            differences: adapter.differences,
          }
        : null,
      policy: policyOut ? { outcome: policyOut.outcome, violations: policyOut.violations, warnings: policyOut.warnings } : null,
      platform: {
        containerPlatform: (ctx.contract?.environment.platform ?? config.platform).containerPlatform,
        python: (ctx.contract?.environment.platform ?? config.platform).python.version,
        accelerator: config.platform.accelerator,
        packageIndex: config.platform.packageIndex.id,
      },
      labImage: prepOut?.labImage ?? null,
      dependencies: prepOut?.dependencies ?? null,
      datasets: prepOut?.datasets ?? [],
      engineers: (execOut?.engineers ?? []).map(
        ({ commands: _commands, officialStdoutTail: _tail, labId: _lab, imageId: _image, environment: _environment, ...rest }) => rest,
      ),
      result: {
        status: finalStatus,
        computedStatus: decision!.status,
        supervisor: supervisorProposal
          ? { proposedStatus: supervisorProposal.proposedStatus, rationale: supervisorProposal.rationale, applied: supervisorApplied }
          : null,
        reasons: decision!.reasons,
        paperValue: ctx.contract?.reportedValue ?? null,
        observedValue: representative?.value ?? null,
        absoluteDifference: decision!.absoluteDifference,
        tolerance: ctx.contract?.tolerance ?? null,
      },
      usage,
      cleanup,
    };
  }
}

class StudyCancelled extends Error {
  constructor() {
    super("the study was cancelled");
    this.name = "StudyCancelled";
  }
}

function assessmentFor(decision: StatusDecision, contract: ClaimContract): Assessment {
  const observed = decision.representative?.value ?? null;
  const comparable = observed !== null && ["reproduced", "partially_reproduced", "not_reproduced"].includes(decision.status);
  return {
    comparable,
    checks: [
      {
        name: "approved command",
        passed: decision.representative?.official?.exitCode === 0,
        explanation: "The approved official command ran in the sealed lab and exited 0.",
      },
      {
        name: "metric parsed by code",
        passed: decision.representative?.metric?.ok === true,
        explanation: "The metric was parsed from the official run with the contract's parser.",
      },
      {
        name: "independent review",
        passed: decision.representative?.review?.verdict === "approve",
        explanation: decision.representative?.review?.summary ?? "No approved review.",
      },
    ],
    paperValue: contract.reportedValue,
    observedValue: observed,
    signedDifference: observed === null ? null : observed - contract.reportedValue,
    absoluteDifference: decision.absoluteDifference,
    tolerance: contract.tolerance,
    verdict: !comparable ? "inconclusive" : decision.status === "not_reproduced" ? "different_result" : "reproduced_within_tolerance",
    discrepancyHypotheses: decision.status === "not_reproduced" ? decision.reasons : [],
    evidence: [
      {
        kind: "paper_page",
        reference: `page ${contract.paperReference.page}, ${contract.paperReference.location}`,
        excerpt: contract.paperReference.excerpt,
      },
    ],
    limitations: decision.status === "partially_reproduced" ? decision.reasons : [],
  };
}

/** Removes what an interrupted study left on disk, for startup cleanup. */
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
