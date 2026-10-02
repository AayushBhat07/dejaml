import type {
  ClaimContract,
  CommandReceipt,
  ContainerPlatform,
  PaperDocument,
  PlatformSpec,
  RepositoryCandidate,
  ResourceBudgetSchema,
  RunEvent,
} from "@dejaml/contracts";
import type { BoundedAgentRuntime } from "@dejaml/agent-runtime";
import type { ArtifactSummary, LabWorker } from "@dejaml/lab-manager";
import type { FetchPolicy } from "@dejaml/net-guard";
import type { acquireGithubRepository, RepositoryReceipt } from "@dejaml/repository-intake";
import type { RunStore } from "@dejaml/run-store";
import type { z } from "zod";

import type { SealedTarget } from "./blinding.js";
import type { Projection } from "./projection.js";

export type ResourceBudget = z.infer<typeof ResourceBudgetSchema>;

/** The fixed lab layout every engineer sees, relative to the lab workdir. */
export const LAB_LAYOUT = {
  workdir: "/workspace/case",
  repoDir: "repo",
  wheelsDir: "wheels",
  dataDir: "data",
  scratchDir: "work",
  artifactsDir: "artifacts",
  /** Writable copy of the checkout, made by the orchestrator when the plan asks for it. */
  workRepo: "work/repo",
  /** Where the plan's adapter is written; covered by the integrity check. */
  adapterDir: "work/adapter",
  venv: "/workspace/case/work/.venv",
} as const;

export type StudyConfig = {
  /** Where the lab runs: architecture, Python, CPU-only policy, package index. The plan's Python replaces `python`. */
  platform: PlatformSpec;
  resources: ResourceBudget;
  /** Independent Lab Engineers per execution round, each in its own lab (1 to 3). */
  engineers: number;
  provider: { id: string; model: string };
  datasetPolicy: FetchPolicy;
  /** Whole-study wall clock. */
  maxStudyMs: number;
  /** Largest per-command timeout; the official run gets min(this, 4 × the plan's expected runtime). */
  commandTimeoutSeconds: number;
  /** Re-plans allowed in one study; each typed reason is allowed once. */
  maxReplans: number;
  /**
   * The project-owned compatibility constraints file (never the repository or a model).
   * A plan may apply only constraints listed here; each one used is reported.
   */
  trustedConstraints: Array<{ requirement: string; reason: string }>;
};

// ---------------------------------------------------------------------------
// Ports: what the orchestrator needs from preparation, images, and datasets.
// Local implementations live in ./ports.ts; an AWS deployment swaps them.

/** A typed preparation outcome that is not a success. */
export class PreparationFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** What the failure means for the study. */
    readonly outcome: "policy_blocked" | "inconclusive" | "replan" | "failed",
    readonly requirement: string | null = null,
  ) {
    super(message);
    this.name = "PreparationFailure";
  }
}

export type PreparedPackage = { name: string; version: string; filename: string; sha256: string; bytes: number; tags: string };

export type PreparedDependencies = {
  prepId: string;
  manifestSha256: string;
  /** Host path of the verified wheelhouse; mounted read-only, never reported. */
  wheelhouseDir: string;
  installerWheel: string | null;
  python: string;
  containerPlatform: string;
  prepImage: { name: string; digest: string | null } | null;
  packages: PreparedPackage[];
  requested: string[];
  constraints: Array<{ requirement: string; reason: string }>;
  /** Every version the constraints changed, reported as is. */
  changes: string[];
  receipts: Record<string, unknown>;
};

export type DependencyScreen = { refused: Array<{ requirement: string; code: string; reason: string }> };

export type DependencyPort = {
  /** Static checks with no network: URLs, local paths, source builds, GPU packages. */
  screen(requirements: string[], platform: PlatformSpec): DependencyScreen;
  /** Whether binary wheels exist for these requirements on the platform (no download). */
  check(input: {
    runId: string;
    platform: PlatformSpec;
    requirements: string[];
    signal: AbortSignal;
  }): Promise<{ ok: boolean; detail: Record<string, unknown> }>;
  prepare(input: {
    runId: string;
    platform: PlatformSpec;
    requirements: string[];
    constraints: Array<{ requirement: string; reason: string }>;
    signal: AbortSignal;
  }): Promise<PreparedDependencies>;
  release(prepared: PreparedDependencies): Promise<{ removed: boolean }>;
};

export type LabImage = { name: string; imageId: string; digest: string | null; containerPlatform: ContainerPlatform; python: string };

export type LabImagePort = {
  /** Resolves (inspects, pulls, or builds) the lab image for the platform; throws PreparationFailure with outcome `failed`. */
  ensure(input: { platform: PlatformSpec; signal: AbortSignal }): Promise<LabImage>;
};

export type DatasetIdentity = {
  name: string;
  requestedUrl: string;
  finalUrl: string;
  sha256: string;
  bytes: number;
  checksumVerified: boolean;
  extracted: { fileCount: number; totalBytes: number; listingDigest: string } | null;
  fetchedAt: string;
};

export type AcquiredDataset = { identity: DatasetIdentity; root: string; labPath: string };

export type DatasetPort = {
  acquire(input: {
    runId: string;
    name: string;
    url: string;
    sha256: string | null;
    extract: boolean;
    destinationDir: string;
    signal: AbortSignal;
  }): Promise<AcquiredDataset>;
  release(dataset: AcquiredDataset): Promise<{ removed: boolean }>;
};

// ---------------------------------------------------------------------------

/** A command run in a lab, as recorded for evidence. */
export type CommandRecord = CommandReceipt & {
  stdoutTail: string;
  stderrTail: string;
  /** True for a run of the approved command through lab_run_official. */
  official: boolean;
  /** Full bounded stdout, kept only for official runs (the metric is parsed from it). */
  stdoutFull: string | null;
  stdoutTruncated: boolean;
};

export type EngineerLab = {
  agentId: string;
  label: string;
  labId: string;
  imageId: string;
  platform: ContainerPlatform;
  commands: CommandRecord[];
  /** Latest digest of each file under artifacts/, from command outcomes. */
  artifacts: Map<string, ArtifactSummary>;
  /** Digest of work/repo (when used), the adapter directory, and the venv, taken right after setup. */
  integrity: { workRepo: string | null; venv: string | null; adapter: string | null };
  environment: { python: string | null; distributions: Array<{ name: string; version: string }> } | null;
  official: CommandRecord | null;
  dependencyRequest: { requirements: string[]; reason: string } | null;
  destroyed: boolean;
};

export type ExportedArtifact = ArtifactSummary & { hostPath: string; text: string | null };

export type StudyContext = {
  runId: string;
  paper: PaperDocument;
  candidates: RepositoryCandidate[];
  store: RunStore;
  labs: LabWorker;
  dependencies: DependencyPort | null;
  runtime: BoundedAgentRuntime;
  config: StudyConfig;
  /** Private per-run directory on the host (checkouts, datasets, exports). */
  workDir: string;
  acquire: typeof acquireGithubRepository;
  /** The pinned checkout; `commitSha` is set on resume so the same commit is fetched again. */
  repository: { receipt: RepositoryReceipt; dir: string; root: string } | null;
  /**
   * The execution projection of the checkout (notebook outputs stripped, the
   * sealed value withheld from documentation). Repository tools and labs read
   * this, never the original.
   */
  projection: Projection | null;
  /**
   * Trusted code only: the sealed value, used to withhold it from projections
   * and to refuse any agent request that carries it. No tool returns it.
   */
  sealedForScan: { value: number; unit: SealedTarget["metric"]["unit"] } | null;
  pinnedCommit: string | null;
  contract: ClaimContract | null;
  planDigest: string | null;
  prepared: PreparedDependencies | null;
  datasets: AcquiredDataset[];
  labsByAgent: Map<string, EngineerLab>;
  exports: Map<string, ExportedArtifact[]>;
  /** Exports the lab's artifacts and destroys it; later lab tools are refused. */
  finishLab: (agentId: string, reason: string) => Promise<void>;
  event: (type: string, status: RunEvent["status"], summary: string, payload?: Record<string, unknown>) => void;
};
