import type { CommandReceipt, PaperDocument, RepositoryCandidate, ResourceBudgetSchema, RunEvent } from "@dejaml/contracts";
import type { BoundedAgentRuntime } from "@dejaml/agent-runtime";
import type { ArtifactSummary, LabManager } from "@dejaml/lab-manager";
import type { DatasetReceipt, FetchPolicy } from "@dejaml/net-guard";
import type { DependencyDiscovery, DependencyManifest, DependencyPreparer, PythonResolution } from "@dejaml/prep";
import type { acquireGithubRepository, RepositoryReceipt } from "@dejaml/repository-intake";
import type { RunStore } from "@dejaml/run-store";
import type { z } from "zod";

export type ResourceBudget = z.infer<typeof ResourceBudgetSchema>;

/** The fixed lab layout every engineer sees, relative to the lab workdir. */
export const LAB_LAYOUT = {
  workdir: "/workspace/case",
  repoDir: "repo",
  wheelsDir: "wheels",
  dataDir: "data",
  scratchDir: "work",
  artifactsDir: "artifacts",
  venv: "/workspace/case/work/.venv",
} as const;

export type StudyConfig = {
  image: { name: string; expectedImageId: string };
  resources: ResourceBudget;
  /** Independent Lab Engineers, each in its own lab (1 to 4). */
  engineers: number;
  provider: { id: string; model: string };
  datasetPolicy: FetchPolicy;
  /** Whole-study wall clock. */
  maxStudyMs: number;
  /** Largest per-command timeout an engineer may ask for. */
  commandTimeoutSeconds: number;
  /** Most delegate calls the Supervisor may make. */
  maxDelegations: number;
};

/** A lab_run as recorded for evidence; output text is kept bounded for provenance checks. */
export type CommandRecord = CommandReceipt & { stdoutTail: string; stderrTail: string };

export type EngineerLab = {
  agentId: string;
  label: string;
  labId: string;
  imageId: string;
  commands: CommandRecord[];
  /** Files the engineer wrote with lab_write_file: path relative to the workdir -> sha256 and content. */
  written: Map<string, { sha256: string; content: string }>;
  /** Latest digest of each file under artifacts/, from command outcomes. */
  artifacts: Map<string, ArtifactSummary>;
  environment: { python: string | null; distributions: Array<{ name: string; version: string }> } | null;
  destroyed: boolean;
};

export type ExportedArtifact = ArtifactSummary & { hostPath: string; text: string | null };

export type StageName = "analysis" | "plan" | "engineering" | "review";

export type StudyContext = {
  runId: string;
  paper: PaperDocument;
  candidates: RepositoryCandidate[];
  store: RunStore;
  labs: LabManager;
  prep: DependencyPreparer | null;
  runtime: BoundedAgentRuntime;
  config: StudyConfig;
  /** Private per-run directory on the host (checkouts, datasets, exports). */
  workDir: string;
  acquire: typeof acquireGithubRepository;
  repository: { receipt: RepositoryReceipt; dir: string; root: string } | null;
  dependencies: {
    discovery: DependencyDiscovery | null;
    resolution: PythonResolution | null;
    manifest: DependencyManifest | null;
    manifestSha256: string | null;
    failures: Array<{ code: string; message: string; requirement: string | null }>;
  };
  datasets: Array<DatasetReceipt & { name: string }>;
  labsByAgent: Map<string, EngineerLab>;
  exports: Map<string, ExportedArtifact[]>;
  delegations: { total: number; byStage: Record<StageName, number> };
  runStage: (stage: StageName, objective: string, supervisorAgentId: string, signal: AbortSignal) => Promise<string>;
  event: (type: string, status: RunEvent["status"], summary: string, payload?: Record<string, unknown>) => void;
};
