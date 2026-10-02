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
import {
  BlindingIntegrityError,
  type BlindingPhase,
  type BlindingRecord,
  type RunStore,
  sha256Hex,
  type StageRecord,
} from "@dejaml/run-store";
import type { z } from "zod";

import { type ArtifactStore, LocalArtifactStore } from "../boundaries.js";
import {
  compareRevealed,
  type Comparison,
  environmentDigest,
  type ExecutionContract,
  executionClaim,
  executionContract,
  findValue,
  forwardableMapping,
  implausibleValue,
  lockObservation,
  type Observation,
  revealTarget,
  riggedAdapter,
  type SealedTarget,
  sealTarget,
  statesExpectation,
  withholdInJson,
} from "./blinding.js";
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
import { canonicalJson, reconcile, reviewPolicy, TOLERANCE } from "./contract.js";
import { measureIntegrity, orchestratorActor, runInLab } from "./lab-tools.js";
import { convertUnit, parseMetric } from "./metric.js";
import {
  DiagnosisSchema,
  INSTRUCTIONS,
  TARGETED_INSTRUCTIONS,
  type PaperClaim,
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
  withVerdict,
} from "./roles.js";
import {
  adapterSha256,
  type ClaimTarget,
  claimMismatch,
  paperAnalystTarget,
  plannerTarget,
  publicTargetSummary,
  repositoryAnalystTarget,
} from "./targets.js";
import { acquireRepository, buildStudyTools, refreshProjection } from "./tools.js";
import {
  applySupervisor,
  decideStatus,
  type EngineerOutcome,
  type OfficialRun,
  type RevealedComparison,
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
  /** The reviewed claim target the study investigated (public view), or null when the agents chose the claim. */
  reviewedTarget: Record<string, unknown> | null;
  repository: Record<string, unknown> | null;
  /** The full contract once the target is revealed (or in the audit report); the execution view before. */
  contract: ClaimContract | ExecutionContract | null;
  /** The commitments, their order, and the reveal proof. */
  blinding: BlindingReport;
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

export type BlindingReport = {
  /** True when no paper value appears in this report (the target was never revealed). */
  sealed: boolean;
  revealed: boolean;
  commitment: string | null;
  sealedAt: string | null;
  /** Every recorded phase in order, with its commitment and public facts. */
  records: Array<Pick<BlindingRecord, "sequence" | "phase" | "round" | "commitment" | "record" | "at">>;
  /** The execution projection the agents and labs saw. */
  projection: {
    sha256: string;
    originalManifestSha256: string | null;
    notebooksStripped: Array<{ path: string; outputsRemoved: number }>;
    documentsWithheld: number;
    staticFindings: number;
  } | null;
  /** After the reveal only: the sealed payload (with its nonce) and the verification. */
  reveal: { canonical: string; recomputedCommitment: string; verified: boolean; observationVerified: boolean } | null;
  comparison: (Comparison & { blindVerdicts: string[] }) | null;
  /** In an audit report of a study that never revealed: the sealed payload, for an administrator. */
  sealedPayload: string | null;
  errors: string[];
};

export type MultiAgentResult = {
  /** Public report: no paper value, tolerance, or nonce unless the target was revealed. */
  report: MultiAgentReport;
  /** Administrator audit report: everything, including a sealed payload that was never revealed. */
  auditReport: MultiAgentReport;
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
type ReviewStageOutput = {
  reviews: Array<{ engineerAgentId: string; reviewerAgentId: string; status: string; review: Review | null }>;
  /** The round this blind review belongs to (the executing stage's attempt). */
  round?: number;
};
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
  input: {
    runId: string;
    paper: PaperDocument;
    candidates: RepositoryCandidate[];
    signal: AbortSignal;
    /** A reviewed claim target from the server's registry: which claim to investigate, never a result. */
    target?: ClaimTarget | null;
  },
  deps: MultiAgentDependencies,
): Promise<MultiAgentResult> {
  const { runId } = input;
  const { store, config } = deps;
  const stages = store.stages;
  const owner = deps.owner ?? `orchestrator_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const provider = config.provider;
  const target = input.target ?? null;
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
      reviewedTarget: target,
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
    // A reviewed target pins the repository to its reviewed commit from the first acquisition.
    pinnedCommit: target?.repository.commitSha ?? null,
    projection: null,
    sealedForScan: null,
    contract: null,
    planDigest: null,
    prepared: null,
    datasets: [],
    labsByAgent: new Map(),
    exports: new Map(),
    finishLab: (agentId, reason) => finishLab(agentId, reason),
    event,
  };
  // The revealed, verified target; null until both locks are recorded.
  let revealed = null as SealedTarget | null;
  const runtime = new BoundedAgentRuntime({
    store,
    provider: () => deps.chatProvider,
    tools: (agent) => buildStudyTools(ctx, agent),
    resultSchema: resultSchemaFor,
    // Before the reveal, no request of any agent but the Paper Analyst may carry the sealed value.
    requestGuard: (agent, text) => {
      if (agent.role === "paper_analyst" || revealed || !ctx.sealedForScan) return null;
      return findValue(ctx.sealedForScan.value, ctx.sealedForScan.unit, text) ? "it carries the sealed paper value" : null;
    },
  });
  ctx.runtime = runtime;
  const board = runtime.board(runId);

  // ---------------------------------------------------------------------------
  // Blinding: the sealed target, the locks, and the reveal (see ./blinding.ts).

  const blinding = store.blinding;
  const blindingErrors: string[] = [];

  /** Records a phase once; on resume the recorded phase is returned, and a different commitment is an integrity failure. */
  function ensurePhase(
    phase: BlindingPhase,
    round: number,
    input: { commitment?: string | null; record?: Record<string, unknown> } = {},
  ): BlindingRecord {
    const existing = blinding.find(runId, phase, round);
    if (existing) {
      if (input.commitment && existing.commitment !== input.commitment)
        throw new BlindingIntegrityError(`the ${phase.replaceAll("_", " ")} commitment changed after it was locked`);
      return existing;
    }
    return blinding.record(runId, phase, { round, commitment: input.commitment ?? null, record: input.record ?? {} });
  }

  /** Loads the sealed value for trusted scanning (projection, request guard); never handed to an agent. */
  function loadSealed(): void {
    const row = blinding.sealedTarget(runId);
    if (!row) return;
    const sealed = JSON.parse(row.canonical) as SealedTarget;
    ctx.sealedForScan = { value: sealed.reportedValue, unit: sealed.metric.unit };
  }

  function seal(input: Omit<SealedTarget, "schemaVersion" | "comparisonRule" | "nonce">): void {
    if (blinding.sealedTarget(runId)) return loadSealed();
    const sealed = sealTarget(input);
    const record = blinding.seal(runId, {
      canonical: sealed.canonical,
      commitment: sealed.commitment,
      record: { caseId: input.caseId, metric: input.metric.name, unit: input.metric.unit, comparisonRule: sealed.target.comparisonRule },
    });
    event("target_sealed", "completed", "Paper target sealed: the reported value stays hidden until the experiment and review are locked", {
      caseId: input.caseId,
      commitment: sealed.commitment,
      metric: input.metric.name,
      sealedAt: record.at,
    });
    loadSealed();
  }

  function sealFromClaim(claim: PaperClaim): void {
    seal({
      caseId: null,
      caseVersion: null,
      paperSha256: input.paper.file.sha256,
      claimLocator: { page: claim.page, location: claim.location },
      metric: claim.metric,
      reportedValue: claim.reportedValue,
      tolerance: TOLERANCE[claim.metric.unit],
    });
  }

  function agentsStarted(): void {
    if (blinding.find(runId, "agents_started")) return;
    ensurePhase("agents_started", 0, {
      record: {
        blindRoles: ["repository_analyst", "reproduction_planner", "lab_engineer", "debugger", "independent_reviewer", "supervisor"],
      },
    });
    event("agents_started", "started", "Blind agents start: none of them is told the paper's value", {});
  }

  /** The sealed value for withholding, when one is sealed. */
  const sealedView = (): { value: number; unit: SealedTarget["metric"]["unit"] } | null => ctx.sealedForScan;
  const isSealed = (): boolean => blinding.sealedTarget(runId) !== null;

  /** The observation of one execution round: everything the measurement depends on, and nothing about the target. */
  function buildObservation(round: number, engineers: EngineerRecord[]): Observation {
    const contract = ctx.contract!;
    const environment = {
      labImageId: prepOut?.labImage?.imageId ?? null,
      labImageDigest: prepOut?.labImage?.digest ?? null,
      dependencyManifestSha256: prepOut?.dependencies?.manifestSha256 ?? null,
      platform: contract.environment.platform.containerPlatform,
    };
    return {
      schemaVersion: 1,
      runId,
      round,
      metric: { name: contract.metric.name, unit: contract.metric.unit, parser: contract.metricParser },
      planDigest: ctx.planDigest ?? "",
      repository: {
        url: contract.repository.url,
        commitSha: contract.repository.commitSha,
        manifestSha256: ctx.repository?.receipt.manifestSha256 ?? repoOut?.repository?.manifestSha256 ?? null,
        projectionSha256: ctx.projection?.sha256 ?? null,
      },
      environment: { ...environment, digest: environmentDigest(environment) },
      datasets: (prepOut?.datasets ?? []).map((item) => ({ name: item.name, sha256: item.sha256 })),
      engineers: engineers.map((item) => ({
        engineerAgentId: item.engineerAgentId,
        label: item.label,
        receiptId: item.official?.receiptId ?? null,
        exitCode: item.official?.exitCode ?? null,
        timedOut: item.official?.timedOut ?? false,
        stdoutSha256: item.official?.stdoutSha256 ?? null,
        stderrSha256: item.commands.find((command) => command.receiptId === item.official?.receiptId)?.stderrSha256 ?? null,
        artifacts: item.artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
        metricOk: item.metric?.ok === true,
        metricSource: item.metric?.ok ? item.metric.source : null,
        rawValue: item.metric?.ok ? item.metric.value : null,
        observedValue: item.value,
        problem: item.metric && !item.metric.ok ? item.metric.reason : null,
      })),
    };
  }

  /** Any JSON with every form of the sealed value withheld (unchanged when nothing is sealed). */
  const withhold = <T>(json: T): T => (ctx.sealedForScan ? withholdInJson(ctx.sealedForScan.value, ctx.sealedForScan.unit, json) : json);

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
      instructions: (target ? TARGETED_INSTRUCTIONS[role] : undefined) ?? INSTRUCTIONS[role],
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
      payload: withhold({ replan: reason, guidance: guidance.slice(0, 2_000), evidence }),
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
      inputs: { resultKind: "checkpoint", checkpoint: name, evidence: withhold(evidence), replanReasonsAvailable: available },
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
          objective: target ? "Verify the reviewed claim against the paper." : "Select the one claim to reproduce.",
          inputs: {
            paper: { name: input.paper.file.originalName, pages: input.paper.pageCount },
            repositoryCandidates: urls,
            ...(target ? { reviewedTarget: paperAnalystTarget(target) } : {}),
          },
          schema: PaperClaimResultSchema,
        });
        const outcome = await handle.done;
        const result = outcome.status === "completed" ? (outcome.result ?? null) : null;
        // Without a reviewed target, the Paper Analyst's own claim is sealed before any blind agent reads it.
        if (!target && result?.status === "ready" && result.claim) sealFromClaim(result.claim);
        if (result) {
          // Code reduces the handoff to the execution claim: never the value, tolerance, excerpt, page, or the analyst's prose.
          board.post({
            kind: "paper_claim",
            authorAgentId: handle.agentId,
            authorRole: "paper_analyst",
            payload: {
              status: result.status,
              claim: result.claim ? executionClaim(result.claim, sealedView()) : null,
              missingFields: withhold(result.claim?.missingFields ?? []),
            },
          });
        }
        return { agentId: handle.agentId, status: outcome.status, reason: outcome.reason, result };
      }),
      runStage<RepositoryStageOutput>("analyzing_repository", async () => {
        const handle = await launch("repository_analyst", {
          stage: "analyzing_repository",
          label: "repository-analyst",
          objective: target
            ? "Acquire the pinned repository and map the reviewed claim to its official code."
            : "Acquire and map the paper's repository.",
          inputs: {
            ...(target ? { reviewedTarget: repositoryAnalystTarget(target) } : {}),
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
    if (ctx.sealedForScan && ctx.repository && !ctx.projection?.documentsWithheld.length && !target) {
      // The projection was built before the claim was sealed: rebuild it so documentation withholds the value too.
      await refreshProjection(ctx);
    }
    // The map is forwarded only after the target is sealed, with every form of the value withheld.
    if (repoOut?.result && !board.list().some((entry) => entry.kind === "repository_mapping")) {
      board.post({
        kind: "repository_mapping",
        authorAgentId: repoOut.agentId,
        authorRole: "repository_analyst",
        payload: forwardableMapping(repoOut.result, sealedView()),
      });
    }
    if (ctx.sealedForScan) agentsStarted();
  }

  async function plan(): Promise<boolean> {
    const claim = paperOut?.result?.claim ?? null;
    const repository = repoOut?.repository ?? null;
    if (target && claim && paperOut?.result?.status === "ready") {
      // A reviewed target is the claim under study: the analyst may reject it, but never swap it for another.
      const mismatch = claimMismatch(target, claim);
      if (mismatch) {
        stopReasons.push(mismatch);
        event("claim_mismatch", "warning", mismatch, { caseId: target.caseId });
        return false;
      }
    }
    planOut = await runStage<PlanStageOutput>("reconciling", async () => {
      const handle = await launch("reproduction_planner", {
        stage: "reconciling",
        label: "planner",
        objective: "Plan how to measure the selected claim's metric with the repository's official code.",
        inputs: {
          // The execution claim only: what to measure, never what the paper measured.
          claim: claim ? executionClaim(claim, sealedView()) : null,
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
          previousRounds: withhold(replanGuidance),
          ...(target ? { reviewedTarget: plannerTarget(target) } : {}),
        },
        schema: PlanSchema,
      });
      const outcome = await handle.done;
      const proposed = outcome.status === "completed" ? (outcome.result ?? null) : null;
      let contract: ClaimContract | null = null;
      let reconcileErrors: string[] = [];
      if (proposed) {
        // A plan measures; it never states what the result should be. Refused with a neutral reason.
        const sealed = sealedView();
        const free = [proposed.summary, proposed.blockedReason ?? "", ...proposed.risks, ...proposed.stopConditions].join("\n");
        if ((sealed && findValue(sealed.value, sealed.unit, JSON.stringify(proposed))) || statesExpectation(free))
          reconcileErrors.push("the plan states an expected result, which a blinded plan must not do");
        board.post({ kind: "plan", authorAgentId: handle.agentId, authorRole: "reproduction_planner", payload: withhold(proposed) });
      }
      let plan: Plan | null = null;
      if (proposed) {
        // A reference to a reviewed adapter becomes the reviewed, hash-checked file; any other id is refused.
        let adapter: Plan["adapter"] = null;
        if (proposed.adapter && "reviewedAdapterId" in proposed.adapter) {
          const reviewed = target?.adapter;
          if (reviewed && reviewed.id === proposed.adapter.reviewedAdapterId) {
            adapter = {
              path: reviewed.path,
              content: reviewed.content,
              why: reviewed.why,
              source: reviewed.source,
              differences: reviewed.differences,
            };
          } else {
            reconcileErrors.push(`the plan names an unknown reviewed adapter ${proposed.adapter.reviewedAdapterId}`);
          }
        } else {
          adapter = proposed.adapter;
        }
        plan = { ...proposed, adapter };
      }
      if (plan?.adapter && reconcileErrors.length === 0) {
        const sealed = sealedView();
        if ((sealed && findValue(sealed.value, sealed.unit, plan.adapter.content)) || riggedAdapter(plan.adapter.content))
          reconcileErrors.push("the adapter contains a value or a comparison it must not contain");
      }
      if (plan?.status === "ready" && claim && repository && reconcileErrors.length === 0) {
        const reconciled = reconcile({
          claim,
          plan,
          repository,
          platform: config.platform,
          pages: ctx.paper.pages,
          ...(target ? { tolerance: target.tolerance } : {}),
        });
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
      policyViolations.push(withhold(result.plan.blockedReason ?? result.plan.summary));
      return false;
    }
    if (result.plan.status === "inconclusive" || !result.contract) {
      stopReasons.push(
        result.reconcileErrors.length
          ? `the plan is incomplete: ${result.reconcileErrors.join("; ")}`
          : `the plan is inconclusive: ${withhold(result.plan.summary)}`,
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
        target,
      });
      if (review.outcome === "approved") {
        board.post({
          kind: "claim_contract",
          authorAgentId: null,
          authorRole: "system",
          // The execution view: never the reported value, tolerance, or paper excerpt.
          payload: {
            planDigest: review.planDigest,
            contract: executionContract(result.contract!),
            adapter: result.plan!.adapter,
            warnings: review.warnings,
          },
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
    const round = stages.stage(runId, "executing").attempt;
    if (isSealed()) {
      const measuredCount = execOut.engineers.filter((item) => item.official?.exitCode === 0 && item.metric?.ok).length;
      if (!blinding.find(runId, "execution_completed", round)) {
        ensurePhase("execution_completed", round, { record: { engineers: execOut.engineers.length, measured: measuredCount } });
        event(
          "execution_completed",
          "completed",
          `Execution round ${round} finished: ${measuredCount} of ${execOut.engineers.length} engineers measured`,
          {
            round,
            engineers: execOut.engineers.length,
            measured: measuredCount,
          },
        );
      }
    }
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

    // Lock the observation before any Reviewer starts: from here it cannot change.
    const observation = buildObservation(round, execOut.engineers);
    const locked = lockObservation(observation);
    if (isSealed() && !blinding.find(runId, "observation_locked", round)) {
      ensurePhase("observation_locked", round, { commitment: locked.commitment, record: { observation } });
      event("observation_locked", "completed", "Observation locked: the measured value can no longer change", {
        round,
        commitment: locked.commitment,
        metric: { name: observation.metric.name, unit: observation.metric.unit },
        observed: observation.engineers.map((item) => ({ engineer: item.label, value: item.observedValue, metricOk: item.metricOk })),
      });
    } else if (isSealed()) {
      // Resumed: the recomputed observation must be the one that was locked.
      ensurePhase("observation_locked", round, { commitment: locked.commitment });
    }

    reviewOut = await runStage<ReviewStageOutput>("reviewing", async () => {
      const reviews = await Promise.all(
        measured.map(async (engineer) => {
          const handle = await launch("independent_reviewer", {
            stage: "reviewing",
            label: `reviewer-${engineer.label}`,
            objective: `Review ${engineer.label}'s measurement independently and blind.`,
            inputs: {
              submissionKey: engineer.engineerAgentId,
              // The execution view: the Reviewer never sees the paper's value, tolerance, or a difference.
              contract: executionContract(contract),
              observationCommitment: locked.commitment,
              planDigest: ctx.planDigest,
              adapter,
              adapterSha256: adapter ? adapterSha256(adapter.content) : null,
              reviewedAdapterId:
                adapter && target?.adapter && adapterSha256(adapter.content) === target.adapter.sha256 ? target.adapter.id : null,
              // What the Repository Analyst found in the pinned repository (the official entry point and metric sources).
              repositoryEvidence: repoOut?.result
                ? withhold({
                    summary: repoOut.result.summary,
                    entrypoints: repoOut.result.entrypoints,
                    metricSources: repoOut.result.metricSources,
                    runInstructions: repoOut.result.runInstructions,
                  })
                : null,
              repository: repoOut?.repository ?? null,
              dependencyManifest: prepOut?.dependencies
                ? {
                    manifestSha256: prepOut.dependencies.manifestSha256,
                    containerPlatform: prepOut.dependencies.containerPlatform,
                    packages: prepOut.dependencies.packages.map((item) => `${item.name}==${item.version}`),
                    changes: prepOut.dependencies.changes,
                  }
                : null,
              datasets: prepOut?.datasets ?? [],
              officialReceiptId: engineer.official?.receiptId ?? null,
              // The Reviewer verifies metric provenance through the locked receipt,
              // logs, and exported artifact. Do not duplicate the numeric observation
              // in its initial user message: an honest measurement can equal the
              // sealed paper value exactly, which is not evidence of target leakage.
              parsedMetricEvidence:
                engineer.metric && engineer.metric.ok
                  ? {
                      ok: true,
                      unit: engineer.metric.unit,
                      source: engineer.metric.source,
                      matches: engineer.metric.matches,
                    }
                  : engineer.metric,
              declaredDeviations: engineer.submission?.deviations ?? [],
              exportedArtifacts: (ctx.exports.get(engineer.engineerAgentId) ?? []).map((item) => ({
                path: item.path,
                sha256: item.sha256,
                bytes: item.bytes,
              })),
              hint: "Read board entries with key = submissionKey (command_receipt, artifact, metric, submission); use logs_read and artifact_read with engineerAgentId = submissionKey. repo_read shows the repository as the lab saw it (saved notebook outputs removed).",
            },
            schema: ReviewSchema,
          });
          const outcome = await handle.done;
          // Code derives approve/reject from the blind equivalence verdict.
          const review = outcome.status === "completed" && outcome.result ? withVerdict(outcome.result) : null;
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
      return { reviews, round };
    });
    if (isSealed()) {
      // Lock the blind review before anything is revealed: a commitment over the observation and every review.
      const commitment = sha256Hex(canonicalJson({ observationCommitment: locked.commitment, reviews: reviewOut.reviews }));
      const verdicts = reviewOut.reviews.map((item) => ({
        engineerAgentId: item.engineerAgentId,
        reviewerAgentId: item.reviewerAgentId,
        status: item.status,
        equivalence: item.review?.equivalence ?? null,
        verdict: item.review?.verdict ?? null,
      }));
      if (!blinding.find(runId, "blind_review_locked", round)) {
        ensurePhase("blind_review_locked", round, { commitment, record: { observationCommitment: locked.commitment, reviews: verdicts } });
        event("blind_review_locked", "completed", "Blind review locked: the Reviewers judged the run without the paper's value", {
          round,
          commitment,
          verdicts: verdicts.map((item) => ({
            engineer: execOut!.engineers.find((entry) => entry.engineerAgentId === item.engineerAgentId)?.label ?? null,
            equivalence: item.equivalence,
          })),
        });
      } else {
        ensurePhase("blind_review_locked", round, { commitment });
      }
    }
    for (const item of reviewOut.reviews) {
      const engineer = execOut.engineers.find((entry) => entry.engineerAgentId === item.engineerAgentId);
      if (engineer) {
        engineer.review = item.review;
        engineer.reviewerAgentId = item.reviewerAgentId;
      }
    }
    const approved = reviewOut.reviews.filter((item) => item.review?.verdict === "approve");
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
    // The lab mounts the execution projection: code and data unchanged, saved notebook outputs removed.
    const inputs: Array<{ hostPath: string; containerPath: string }> = [
      { hostPath: ctx.projection?.dir ?? ctx.repository!.dir, containerPath: LAB_LAYOUT.repoDir },
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
          contract: executionContract(contract),
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
      // A number that cannot be this metric (an accuracy of 7, NaN) is not a measurement.
      const implausible = metric.ok ? (value === null ? null : implausibleValue(value, contract.metric.unit)) : null;
      if (implausible) {
        metric = { ok: false as const, reason: implausible };
        value = null;
      }
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
      // The value itself is published only with the observation lock.
      metric?.ok
        ? `${label} measured ${contract.metric.name} with the approved command`
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
      // Scanned again at the moment it enters the lab.
      const sealed = sealedView();
      if ((sealed && findValue(sealed.value, sealed.unit, adapter.content)) || riggedAdapter(adapter.content))
        throw new PreparationFailure("adapter_refused", "the adapter contains a value or a comparison it must not contain", "inconclusive");
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
    if (target) {
      // A reviewed target is sealed before any agent starts; only its commitment is public.
      seal({
        caseId: target.caseId,
        caseVersion: target.version,
        paperSha256: input.paper.file.sha256,
        claimLocator: { page: target.claim.page, location: target.claim.location },
        metric: target.claim.metric,
        reportedValue: target.claim.reportedValue,
        tolerance: target.tolerance,
      });
      agentsStarted();
    } else {
      loadSealed();
    }
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
        reveal();
        const computed = decide(false);
        recordComparison(computed);
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
      if (!revealed) reveal();
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
  recordFinalStatus();

  /**
   * The reveal: only after both locks, never on a cancelled or stopped study.
   * Code recomputes the commitment of the sealed payload and of the locked
   * observation; a mismatch is a typed integrity failure. Repeating it is a
   * no-op that verifies again.
   */
  function reveal(): void {
    if (!isSealed() || study.signal.aborted || input.signal.aborted) return;
    const already = blinding.find(runId, "target_revealed");
    const last = blinding.last(runId);
    if (!already && last?.phase !== "blind_review_locked") return;
    const row = blinding.sealedTarget(runId)!;
    const opened = revealTarget({ canonical: row.canonical, commitment: row.commitment });
    const observationRecord = blinding.find(runId, "observation_locked", last?.round);
    const observation = (observationRecord?.record as { observation?: Observation } | undefined)?.observation ?? null;
    const observationVerified =
      observation !== null && observationRecord !== null && lockObservation(observation).commitment === observationRecord.commitment;
    if (!observationVerified) throw new BlindingIntegrityError("the locked observation does not match its commitment");
    if (!already) {
      blinding.record(runId, "target_revealed", {
        round: last!.round,
        commitment: row.commitment,
        record: { canonical: row.canonical, recomputedCommitment: sha256Hex(row.canonical), verified: true, observationVerified },
      });
      event(
        "target_revealed",
        "completed",
        "Paper target revealed: its commitment was verified after the observation and blind review were locked",
        {
          commitment: row.commitment,
          verified: true,
          reportedValue: opened.reportedValue,
          tolerance: opened.tolerance,
          metric: opened.metric,
          claimLocator: opened.claimLocator,
        },
      );
    }
    revealed = opened;
  }

  function recordComparison(computed: StatusDecision): void {
    if (!revealed || blinding.find(runId, "deterministic_comparison")) return;
    const representative = computed.representative;
    const comparison =
      representative?.value !== null && representative?.value !== undefined ? compareRevealed(revealed, representative.value) : null;
    const record = {
      comparison,
      computedStatus: computed.status,
      blindVerdicts: (reviewOut?.reviews ?? []).map((item) => item.review?.equivalence ?? item.status),
    };
    ensurePhase("deterministic_comparison", blinding.last(runId)?.round ?? 0, { record });
    event(
      "deterministic_comparison",
      "completed",
      comparison
        ? `Code compared the locked observation with the revealed target: |${comparison.observed} − ${comparison.reported}| = ${comparison.absoluteDelta} (tolerance ${comparison.tolerance})`
        : "Code compared the evidence with the revealed target: no approved measurement to compare",
      record,
    );
  }

  function recordFinalStatus(): void {
    if (!isSealed() || blinding.find(runId, "final_status")) return;
    try {
      ensurePhase("final_status", blinding.last(runId)?.round ?? 0, {
        record: { status: finalStatus, sealed: !revealed, computedStatus: decision?.status ?? null },
      });
      event(
        "final_status",
        "completed",
        revealed ? `Final status: ${finalStatus.replaceAll("_", " ")}` : "Final status recorded; the paper target stays sealed",
        {
          status: finalStatus,
          sealed: !revealed,
        },
      );
    } catch (error) {
      blindingErrors.push(errorText(error));
    }
  }

  function decide(isCancelled: boolean): StatusDecision {
    const engineers = execOut?.engineers ?? [];
    let comparisonTarget: RevealedComparison | null = revealed
      ? { reportedValue: revealed.reportedValue, tolerance: revealed.tolerance }
      : null;
    const extra: string[] = [];
    if (
      revealed &&
      ctx.contract &&
      (ctx.contract.reportedValue !== revealed.reportedValue || ctx.contract.metric.unit !== revealed.metric.unit)
    ) {
      // The approved claim must be the sealed one; otherwise nothing is compared.
      extra.push("the approved claim is not the sealed target");
      comparisonTarget = null;
    }
    const decision = decideStatus({
      cancelled: isCancelled,
      failure: infrastructureFailure,
      policyViolations,
      stopReasons: [...stopReasons, ...extra],
      contract: ctx.contract,
      revealed: comparisonTarget,
      adapter: Boolean(planOut?.plan?.adapter),
      outcomes: engineers,
      engineersLaunched: engineers.length,
    });
    // A reviewed target states the most favourable status its evidence can honestly support.
    if (target?.maximumVerdict === "partially_reproduced" && decision.status === "reproduced") {
      return {
        ...decision,
        status: "partially_reproduced",
        reasons: [...decision.reasons, `the reviewed target ${target.caseId} allows at most partially reproduced`],
      };
    }
    return decision;
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

  const report = buildReport("public");
  const auditReport = buildReport("audit");
  const representative = decision.representative;
  const contract = ctx.contract;
  return {
    report,
    auditReport,
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
    assessment: contract ? assessmentFor(decision, contract, revealed) : null,
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

  function blindingReport(mode: "public" | "audit"): BlindingReport {
    const records = blinding.records(runId);
    const sealedRow = blinding.sealedTarget(runId);
    const revealRecord = records.find((item) => item.phase === "target_revealed") ?? null;
    const comparisonRecord = records.find((item) => item.phase === "deterministic_comparison") ?? null;
    const projection = ctx.projection;
    return {
      sealed: !revealRecord,
      revealed: revealRecord !== null,
      commitment: sealedRow?.commitment ?? null,
      sealedAt: sealedRow?.sealedAt ?? null,
      records: records.map(({ sequence, phase, round, commitment, record, at }) => ({ sequence, phase, round, commitment, record, at })),
      projection: projection
        ? {
            sha256: projection.sha256,
            originalManifestSha256: ctx.repository?.receipt.manifestSha256 ?? null,
            notebooksStripped: projection.notebooksStripped,
            documentsWithheld: projection.documentsWithheld.length,
            staticFindings: projection.staticFindings.length,
          }
        : null,
      reveal: revealRecord
        ? {
            canonical: String(revealRecord.record.canonical),
            recomputedCommitment: String(revealRecord.record.recomputedCommitment),
            verified: revealRecord.record.verified === true,
            observationVerified: revealRecord.record.observationVerified === true,
          }
        : null,
      comparison: comparisonRecord?.record.comparison
        ? {
            ...(comparisonRecord.record.comparison as Comparison),
            blindVerdicts: (comparisonRecord.record.blindVerdicts as string[] | undefined) ?? [],
          }
        : null,
      // Only an administrator's audit report carries a payload that was never revealed.
      sealedPayload: mode === "audit" && !revealRecord ? (sealedRow?.canonical ?? null) : null,
      errors: blindingErrors,
    };
  }

  function buildReport(mode: "public" | "audit"): MultiAgentReport {
    // Before the reveal, the public report carries no paper value, tolerance, excerpt, or nonce.
    const open = mode === "audit" || revealed !== null;
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
      reviewedTarget: target ? publicTargetSummary(target) : null,
      repository: ctx.repository || repoOut?.repository ? (repoOut?.repository ?? null) : null,
      contract: ctx.contract ? (open ? ctx.contract : executionContract(ctx.contract)) : null,
      blinding: blindingReport(mode),
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
        paperValue: revealed ? revealed.reportedValue : open ? (ctx.contract?.reportedValue ?? null) : null,
        observedValue: representative?.value ?? null,
        absoluteDifference: revealed ? decision!.absoluteDifference : null,
        tolerance: revealed ? revealed.tolerance : open ? (ctx.contract?.tolerance ?? null) : null,
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

/** The assessment; before the reveal it carries no paper value, tolerance, or excerpt. */
function assessmentFor(decision: StatusDecision, contract: ClaimContract, revealed: SealedTarget | null): Assessment {
  const observed = decision.representative?.value ?? null;
  const comparable =
    revealed !== null && observed !== null && ["reproduced", "partially_reproduced", "not_reproduced"].includes(decision.status);
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
    paperValue: revealed?.reportedValue ?? null,
    observedValue: observed,
    signedDifference: observed === null || !revealed ? null : Math.round((observed - revealed.reportedValue) * 1e9) / 1e9,
    absoluteDifference: revealed ? decision.absoluteDifference : null,
    tolerance: revealed?.tolerance ?? null,
    verdict: !comparable ? "inconclusive" : decision.status === "not_reproduced" ? "different_result" : "reproduced_within_tolerance",
    discrepancyHypotheses: decision.status === "not_reproduced" ? decision.reasons : [],
    evidence: revealed
      ? [
          {
            kind: "paper_page",
            reference: `page ${contract.paperReference.page}, ${contract.paperReference.location}`,
            excerpt: contract.paperReference.excerpt,
          },
        ]
      : [],
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
