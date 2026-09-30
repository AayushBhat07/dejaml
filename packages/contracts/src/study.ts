import { z } from "zod";

import { PlatformSpecSchema } from "./platform.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u, "expected a lowercase SHA-256 digest");
const CommitSha = z.string().regex(/^[a-f0-9]{40}$/u, "expected a full lowercase Git commit SHA");
/** A path relative to the checkout: no absolute paths, no `..`, no backslashes. */
const RepoPath = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "expected a path inside the repository");

/**
 * The stages of a study. The orchestrator is a persisted state machine over
 * these stages; models run inside stages but never choose transitions.
 */
export const StudyStageSchema = z.enum([
  "ingesting",
  "analyzing_paper",
  "analyzing_repository",
  "reconciling",
  "policy_review",
  "preparing",
  "executing",
  "debugging",
  "reviewing",
  "deciding",
  "completed",
  "inconclusive",
  "policy_blocked",
  "failed",
  "cancelled",
]);
export type StudyStage = z.infer<typeof StudyStageSchema>;

export const TERMINAL_STUDY_STAGES = ["completed", "inconclusive", "policy_blocked", "failed", "cancelled"] as const satisfies readonly StudyStage[];
export type TerminalStudyStage = (typeof TERMINAL_STUDY_STAGES)[number];

/** Work stages in dependency order. `debugging` runs inside `executing`, on request. */
export const WORK_STAGES = [
  "ingesting",
  "analyzing_paper",
  "analyzing_repository",
  "reconciling",
  "policy_review",
  "preparing",
  "executing",
  "reviewing",
  "deciding",
] as const satisfies readonly StudyStage[];
export type WorkStage = (typeof WORK_STAGES)[number];

/** What each work stage waits for. Both analysts start together after ingesting. */
export const STAGE_PREREQUISITES: Record<WorkStage, readonly WorkStage[]> = {
  ingesting: [],
  analyzing_paper: ["ingesting"],
  analyzing_repository: ["ingesting"],
  reconciling: ["analyzing_paper", "analyzing_repository"],
  policy_review: ["reconciling"],
  preparing: ["policy_review"],
  executing: ["preparing"],
  reviewing: ["executing"],
  deciding: ["reviewing"],
};

export const StageRunStatusSchema = z.enum(["pending", "running", "completed", "failed", "skipped", "invalidated"]);
export type StageRunStatus = z.infer<typeof StageRunStatusSchema>;

/** Why a stage ran again. Every retry and invalidation carries one. */
export const StageRetryReasonSchema = z.enum([
  "process_restart",
  "dependency_failure_replan",
  "execution_failed_replan",
  "reviewer_rejected_replan",
  "transient_provider_error",
  "operator_request",
]);
export type StageRetryReason = z.infer<typeof StageRetryReasonSchema>;

/**
 * The outcome of one claim. Only an approved, methodologically equivalent
 * measurement can be `reproduced`; a toy example, a rewritten approximation,
 * a changed dataset, a reduced sample, altered filtering, or a replacement
 * metric never can. `failed` means the study could not run to a decision
 * (an infrastructure fault); `cancelled` means it was stopped.
 */
export const StudyResultStatusSchema = z.enum([
  "reproduced",
  "partially_reproduced",
  "not_reproduced",
  "inconclusive",
  "policy_blocked",
  "failed",
  "cancelled",
]);
export type StudyResultStatus = z.infer<typeof StudyResultStatusSchema>;

/** How cautious each status is; the Supervisor may only move toward the end of this list. */
export const STATUS_CAUTION: Record<StudyResultStatus, number> = {
  reproduced: 0,
  partially_reproduced: 1,
  not_reproduced: 2,
  inconclusive: 3,
  policy_blocked: 4,
  failed: 5,
  cancelled: 6,
};

export const MetricParserSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("json"),
    /** File under `artifacts/` written by the official run. */
    path: z.string().regex(/^artifacts\/[A-Za-z0-9._/-]{1,200}$/u).refine((value) => !value.split("/").includes(".."), "no `..`"),
    /** Dot path to the number, such as `metrics.accuracy`. */
    key: z.string().regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,9}$/u),
  }),
  z.object({
    source: z.literal("stdout"),
    /** A regular expression with exactly one capture group for the number, applied to the official command's stdout. */
    pattern: z.string().min(3).max(300),
  }),
]);
export type MetricParser = z.infer<typeof MetricParserSchema>;

/**
 * One bounded claim, fully specified. The deterministic reconciler builds it
 * from the Paper Analyst's claim and the Planner's plan, and policy review
 * refuses to prepare or execute anything until every field is valid.
 */
export const ClaimContractSchema = z.object({
  schemaVersion: z.literal(1),
  method: z.string().min(1).max(300),
  dataset: z.object({
    name: z.string().min(1).max(300),
    /** Where the data comes from: files in the checkout, or an allowlisted download with a checksum. */
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("repository"), paths: z.array(RepoPath).min(1).max(20) }),
      z.object({ kind: z.literal("download"), url: z.url(), sha256: Sha256.nullable(), extract: z.boolean() }),
    ]),
  }),
  split: z.string().min(1).max(300),
  preprocessing: z.string().min(1).max(1_000),
  seedPolicy: z.string().min(1).max(500),
  metric: z.object({ name: z.string().min(1).max(200), unit: z.enum(["fraction", "percent", "score"]) }),
  reportedValue: z.number().finite(),
  paperReference: z.object({ page: z.number().int().positive(), location: z.string().min(1).max(200), excerpt: z.string().min(1).max(1_000) }),
  repository: z.object({ url: z.string().min(1), commitSha: CommitSha }),
  entrypoint: RepoPath,
  /** The exact command, run from `cwd` (relative to the lab workspace). */
  command: z.object({ argv: z.array(z.string().min(1).max(500)).min(1).max(40), cwd: z.string().max(300) }),
  environment: z.object({
    platform: PlatformSpecSchema,
    requirements: z.array(z.string().max(300)).max(200),
    /** Project-owned compatibility constraints, each shown in the report. */
    compatibilityConstraints: z.array(z.object({ requirement: z.string().max(300), reason: z.string().min(1).max(500) })).max(30),
  }),
  expectedRuntimeSeconds: z.number().int().positive().max(24 * 3_600),
  metricParser: MetricParserSchema,
  tolerance: z.number().nonnegative(),
  stopConditions: z.array(z.string().min(1).max(300)).min(1).max(10),
});
export type ClaimContract = z.infer<typeof ClaimContractSchema>;

/** An explicit, typed message between two agents of a run. */
export const AgentMessageKindSchema = z.enum(["request", "finding", "question", "answer", "instruction"]);
export const TypedAgentMessageSchema = z.object({
  kind: AgentMessageKindSchema,
  text: z.string().min(1).max(4_000),
  refs: z.array(z.string().min(1).max(100)).max(20).default([]),
});
export type TypedAgentMessage = z.infer<typeof TypedAgentMessageSchema>;

export const PlanDigestSchema = Sha256;
