import type { AgentLimits, AgentRole } from "@dejaml/agent-runtime";
import { MetricParserSchema, PythonVersionSchema } from "@dejaml/contracts";
import { z } from "zod";

/**
 * Standing instructions, result shapes, and limits for the seven roles. Each
 * role runs as its own agent instance with its own conversation; these are
 * only what each instance is told and must hand back. Transitions between
 * stages, policy decisions, and the final status belong to code.
 */

const RelativePath = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "a path relative to the repository root, without `..`");

export const PaperClaimSchema = z.object({
  method: z.string().min(1).max(300).describe("The model or method, e.g. `Random Forest`."),
  dataset: z.string().min(1).max(300),
  split: z.string().min(1).max(300).describe("The evaluation split, e.g. `official test set` or `10-fold CV`."),
  preprocessing: z.string().min(1).max(1_000).describe("Preprocessing the paper describes, or `not stated`."),
  seedPolicy: z.string().min(1).max(500).describe("Seed(s) the paper states, or `not stated`."),
  metric: z.object({ name: z.string().min(1).max(200), unit: z.enum(["fraction", "percent", "score"]) }),
  reportedValue: z.number().finite(),
  page: z.number().int().positive(),
  location: z.string().min(1).max(200).describe("Where on the page, e.g. `Table 2` or `Section 5.1`."),
  excerpt: z.string().min(1).max(1_000).describe("Copied verbatim from that page; it must contain the reported value."),
  missingFields: z.array(z.string().max(200)).max(20),
});

export const PaperClaimResultSchema = z.object({
  status: z.enum(["ready", "inconclusive"]),
  summary: z.string().min(1).max(2_000),
  selectedRepositoryUrl: z.string().max(300).nullable(),
  claim: PaperClaimSchema.nullable(),
  reasons: z.array(z.string().max(500)).max(20),
});

export const RepositoryMappingSchema = z.object({
  status: z.enum(["ready", "inconclusive"]),
  summary: z.string().min(1).max(2_000),
  entrypoints: z.array(z.object({ path: RelativePath, why: z.string().min(1).max(500) })).max(10),
  dataFiles: z.array(z.object({ path: RelativePath, why: z.string().max(500) })).max(20),
  dependencyFiles: z.array(RelativePath).max(20),
  metricSources: z.array(z.object({ path: RelativePath, description: z.string().min(1).max(500) })).max(10),
  runInstructions: z.string().max(2_000),
  warnings: z.array(z.string().max(500)).max(20),
});

export const AdapterSchema = z.object({
  /** Written by the orchestrator into the lab before any engineer starts. */
  path: z.string().regex(/^work\/adapter\/[A-Za-z0-9_.-]{1,80}\.py$/u),
  content: z.string().min(1).max(16 * 1024),
  why: z.string().min(1).max(1_000),
  source: z.string().min(1).max(500),
  differences: z.array(z.string().max(500)).max(20),
});

export const PlanSchema = z.object({
  status: z.enum(["ready", "blocked", "inconclusive"]),
  summary: z.string().min(1).max(2_000),
  blockedReason: z.string().max(1_000).nullable(),
  entrypoint: RelativePath.describe("The repository's official script for this claim."),
  command: z.object({
    argv: z.array(z.string().min(1).max(500)).min(2).max(40).describe("Starts with `python`; the next item is the entry point (or the adapter) as seen from cwd."),
    cwd: z.enum(["repo", "work/repo"]).describe("`work/repo` is a writable copy of the checkout made before the run; `repo` is the read-only checkout."),
  }),
  python: PythonVersionSchema,
  requirements: z.array(z.string().min(1).max(200)).max(150).describe("From the repository's dependency files, unchanged."),
  compatibilityConstraints: z.array(z.object({ requirement: z.string().min(1).max(200), reason: z.string().min(1).max(500) })).max(30).describe("Project-owned changes (relaxed or added pins); each is reported."),
  dataset: z.object({
    name: z.string().min(1).max(300),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("repository"), paths: z.array(RelativePath).min(1).max(20) }),
      z.object({ kind: z.literal("download"), url: z.string().max(2_000), sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), extract: z.boolean() }),
    ]),
  }),
  metricParser: MetricParserSchema,
  expectedRuntimeSeconds: z.number().int().positive().max(24 * 3_600),
  stopConditions: z.array(z.string().min(1).max(300)).min(1).max(10),
  adapter: AdapterSchema.nullable(),
  risks: z.array(z.string().max(500)).max(10),
});

export const DeviationSchema = z.object({ what: z.string().min(1).max(500), why: z.string().min(1).max(500) });

export const SubmissionSchema = z.object({
  status: z.enum(["measured", "not_measured"]),
  /** The Engineer's own words; never shown to the Reviewer. */
  summary: z.string().min(1).max(2_000),
  /** Receipt of the approved-command run whose output holds the metric. */
  officialReceiptId: z.string().min(1).max(100).nullable(),
  deviations: z.array(DeviationSchema).max(20),
  failureReason: z.string().max(1_000).nullable(),
});

export const DiagnosisSchema = z.object({
  diagnosis: z.string().min(1).max(2_000),
  rootCause: z.string().min(1).max(1_000),
  suggestedFix: z.string().min(1).max(2_000),
  fixableWithoutChangingThePlan: z.boolean(),
  changesMethodology: z.boolean(),
});

export const ReviewSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  equivalence: z.enum(["equivalent", "minor_deviations", "not_equivalent"]),
  summary: z.string().min(1).max(2_000),
  checks: z
    .array(z.object({ name: z.string().min(1).max(200), passed: z.boolean(), explanation: z.string().min(1).max(1_000) }))
    .min(3)
    .max(12),
  concerns: z.array(z.string().max(1_000)).max(12),
});

/** The Supervisor at a checkpoint: it may continue, ask for one re-plan with a typed reason, or stop. */
export const SupervisorCheckpointSchema = z.object({
  action: z.enum(["continue", "replan", "stop"]),
  reason: z.enum(["none", "dependency_failure_replan", "execution_failed_replan", "reviewer_rejected_replan"]),
  guidance: z.string().max(2_000).describe("For a re-plan: what the Planner must change and why, citing evidence."),
});

/** The Supervisor at the end: a proposal that can only make the computed status more cautious. */
export const SupervisorVerdictSchema = z.object({
  proposedStatus: z.enum(["reproduced", "partially_reproduced", "not_reproduced", "inconclusive", "policy_blocked", "failed"]),
  rationale: z.string().min(1).max(3_000),
});

export type PaperClaim = z.infer<typeof PaperClaimSchema>;
export type PaperClaimResult = z.infer<typeof PaperClaimResultSchema>;
export type RepositoryMapping = z.infer<typeof RepositoryMappingSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Submission = z.infer<typeof SubmissionSchema>;
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type SupervisorCheckpoint = z.infer<typeof SupervisorCheckpointSchema>;
export type SupervisorVerdict = z.infer<typeof SupervisorVerdictSchema>;

export const ROLE_LIMITS: Record<AgentRole, Partial<AgentLimits>> = {
  paper_analyst: { maxIterations: 20, maxToolCalls: 30, maxWallMs: 10 * 60_000 },
  repository_analyst: { maxIterations: 25, maxToolCalls: 40, maxWallMs: 10 * 60_000 },
  reproduction_planner: { maxIterations: 30, maxToolCalls: 40, maxWallMs: 20 * 60_000 },
  lab_engineer: { maxIterations: 40, maxToolCalls: 60, maxWallMs: 60 * 60_000 },
  debugger: { maxIterations: 12, maxToolCalls: 20, maxWallMs: 8 * 60_000 },
  independent_reviewer: { maxIterations: 20, maxToolCalls: 30, maxWallMs: 10 * 60_000 },
  supervisor: { maxIterations: 8, maxToolCalls: 10, maxWallMs: 5 * 60_000 },
};

/** Tools each role is granted in a study (a subset of the runtime's capability ceiling). */
export const ROLE_GRANTS: Record<AgentRole, readonly string[]> = {
  paper_analyst: ["paper_list_pages", "paper_read_page", "paper_search"],
  repository_analyst: ["repo_acquire", "repo_list", "repo_read", "repo_search", "dependency_discover"],
  reproduction_planner: ["board_read", "paper_read_page", "repo_list", "repo_read", "repo_search", "dependency_discover", "dependency_check"],
  lab_engineer: [
    "board_read",
    "lab_list",
    "lab_read",
    "lab_search",
    "lab_logs",
    "lab_artifacts",
    "lab_run",
    "lab_run_official",
    "dependency_manifest",
    "dependency_inspectEnvironment",
    "dependency_request",
    "request_debugging",
    "lab_destroy",
  ],
  debugger: ["board_read", "lab_list", "lab_read", "lab_search", "lab_logs"],
  independent_reviewer: ["board_read", "repo_list", "repo_read", "paper_read_page", "artifact_read", "logs_read"],
  supervisor: ["board_read"],
};

export const INSTRUCTIONS: Record<AgentRole, string> = {
  paper_analyst: [
    "Read the uploaded paper with your tools and select exactly one numeric experimental claim that a CPU-only run of the paper's own code could check.",
    "Prefer a claim in a table or the text that names its method, dataset, split, and metric. `excerpt` must be copied verbatim from `page` and contain the reported value.",
    "selectedRepositoryUrl must be one of the repository candidates you were given. Write `not stated` for preprocessing or seed when the paper does not say, and list them in missingFields; never guess.",
    "You cannot see the repository or the other analysts. If no claim is checkable on a CPU, finish with status inconclusive and the reasons.",
  ].join("\n"),
  repository_analyst: [
    "Acquire the paper's repository with repo_acquire (only the listed candidate URLs are allowed), then map it: the official entry points, where the data lives, the dependency files, and where the code computes or prints metrics.",
    "Use dependency_discover to report which dependency files exist. Read README instructions. You only read files: nothing in the repository is executed by you.",
    "You do not know which claim the Paper Analyst chose; describe what the repository can produce.",
  ].join("\n"),
  reproduction_planner: [
    "Reconcile the Paper Analyst's claim with the Repository Analyst's map (both on the board) into one exact plan to reproduce that claim with the repository's official code in an offline, CPU-only Linux lab.",
    "The command runs `python <entrypoint> [args]` from `repo` (read-only) or `work/repo` (a writable copy made before the run). Choose the Python version the code supports (3.10 or 3.11 for older code). Requirements come from the repository's dependency files unchanged; a pin may be relaxed or added only by choosing an entry from trustedCompatibilityConstraints (copied exactly into compatibilityConstraints); anything else is refused by policy.",
    "Use dependency_check to see whether binary wheels exist for your requirements on the lab platform; nothing is built from source, and GPU packages (CUDA, ROCm) are refused.",
    "Data: prefer files in the repository. A download is allowed only from an administrator-allowed host and needs its SHA-256; otherwise set status blocked.",
    "metricParser must read the number the official code prints (stdout pattern with one capture group) or writes (a JSON file under artifacts/). An adapter is a small wrapper that only calls the official code and captures its metric; it must list every difference. Never plan a rewritten approximation, a changed dataset, a subset, altered filtering, or a replacement metric.",
  ].join("\n"),
  lab_engineer: [
    "You work alone inside a sealed, offline Linux lab prepared for the approved plan: /workspace/case/repo is the repository (read-only), work/repo is a writable copy when the plan asked for one, data/ holds verified datasets (read-only), and the Python environment is already installed.",
    "Run the approved command with lab_run_official. It runs exactly the plan's argv from the plan's cwd, after the lab checks the checkout and environment are unchanged. When it fails, read its logs, inspect files, and fix what the plan allows (for example create an output directory with lab_run). Use request_debugging when you are stuck.",
    "If the code needs a different or extra package, use dependency_request with the reason and then finish as not_measured: the plan is re-approved and a fresh lab is prepared. Never change the code, the data, the split, or the metric.",
    "When the official run succeeded, finish as measured with its receipt id. The metric is parsed by the lab from that run, not by you. Declare every deviation you know of.",
  ].join("\n"),
  debugger: [
    "A Lab Engineer's command failed. Read its receipts and logs, the approved plan, and the files in the lab (read-only) and find the root cause.",
    "Propose the smallest fix that keeps the paper's method, data, and metric unchanged. Say whether it needs a change to the approved plan (a different package, command, or Python version) and whether it would change the methodology.",
  ].join("\n"),
  independent_reviewer: [
    "Review one measured result independently. You see the approved plan (claim contract), the paper, the repository, dependency and dataset receipts, command receipts and logs, the exported artifacts, the declared adapter and deviations, and the metric the lab parsed. You do not see the Engineer's reasoning and must not assume it.",
    "Check: the approved official command ran and exited 0; the metric came from that run; the dataset, split, preprocessing, and metric match the paper's claim; declared deviations and compatibility changes are acceptable.",
    "equivalence is `equivalent` only if nothing methodological changed, `minor_deviations` for library-version or path-only differences that should not change the number, and `not_equivalent` for any toy example, approximation, changed dataset, subset, altered filtering, or replacement metric. Reject anything not_equivalent or unsupported by the evidence.",
  ].join("\n"),
  supervisor: [
    "You oversee a reproduction study that code runs stage by stage. You read the evidence board and answer at checkpoints.",
    "At a checkpoint after execution or review, choose continue, replan (with the typed reason and concrete guidance for the Planner), or stop. A re-plan is allowed once per reason; do not ask for the same thing twice.",
    "At the end, propose the status the evidence supports with your rationale. The final status is computed from evidence: you can make it more cautious, never more favourable, and you cannot create evidence.",
  ].join("\n"),
};

export const RESULT_DESCRIPTIONS: Record<AgentRole, string> = {
  paper_analyst: "The selected claim with its page, location, and verbatim excerpt, or inconclusive with reasons.",
  repository_analyst: "A map of the repository: entry points, data, dependency files, metric sources.",
  reproduction_planner: "The exact reproduction plan, or blocked/inconclusive with the reason.",
  lab_engineer: "Your submission: measured with the official run's receipt, or not_measured with the reason, and every deviation.",
  debugger: "Your diagnosis and the smallest faithful fix.",
  independent_reviewer: "Your verdict, the equivalence judgment, the checks you made, and concerns.",
  supervisor: "Your checkpoint decision or your final status proposal.",
};
