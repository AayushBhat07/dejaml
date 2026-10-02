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
  .refine(
    (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
    "a path relative to the repository root, without `..`",
  );

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
  content: z
    .string()
    .min(1)
    .max(16 * 1024),
  why: z.string().min(1).max(1_000),
  source: z.string().min(1).max(500),
  differences: z.array(z.string().max(500)).max(20),
});

/** A plan may name a reviewed adapter by id instead of writing one; code substitutes the reviewed, hash-checked file. */
export const ReviewedAdapterRefSchema = z.object({
  reviewedAdapterId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
    .describe("The id of the reviewed adapter you were given."),
});

export const PlanSchema = z.object({
  status: z.enum(["ready", "blocked", "inconclusive"]),
  summary: z.string().min(1).max(2_000),
  blockedReason: z.string().max(1_000).nullable(),
  entrypoint: RelativePath.describe("The repository's official script for this claim."),
  command: z.object({
    argv: z
      .array(z.string().min(1).max(500))
      .min(2)
      .max(40)
      .describe("Starts with `python`; the next item is the entry point (or the adapter) as seen from cwd."),
    cwd: z
      .enum(["repo", "work/repo"])
      .describe("`work/repo` is a writable copy of the checkout made before the run; `repo` is the read-only checkout."),
  }),
  python: PythonVersionSchema,
  requirements: z.array(z.string().min(1).max(200)).max(150).describe("From the repository's dependency files, unchanged."),
  compatibilityConstraints: z
    .array(z.object({ requirement: z.string().min(1).max(200), reason: z.string().min(1).max(500) }))
    .max(30)
    .describe("Project-owned changes (relaxed or added pins); each is reported."),
  dataset: z.object({
    name: z.string().min(1).max(300),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("repository"), paths: z.array(RelativePath).min(1).max(20) }),
      z.object({
        kind: z.literal("download"),
        url: z.string().max(2_000),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        extract: z.boolean(),
      }),
      z
        .object({ kind: z.literal("package"), package: z.string().min(1).max(100), path: z.string().min(1).max(300) })
        .describe("Data bundled inside a Python package the plan pins exactly with == in requirements (path inside that package)."),
    ]),
  }),
  metricParser: MetricParserSchema,
  expectedRuntimeSeconds: z
    .number()
    .int()
    .positive()
    .max(24 * 3_600),
  stopConditions: z.array(z.string().min(1).max(300)).min(1).max(10),
  adapter: z.union([AdapterSchema, ReviewedAdapterRefSchema]).nullable(),
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

/**
 * The blind review (phase 1). The Reviewer never sees the paper's value, the
 * tolerance, a difference, or a pass/fail: it judges whether the run measured
 * the claim faithfully. Code derives approve/reject from `equivalence` and
 * locks the review before the target is revealed.
 */
export const BLIND_VERDICTS = ["equivalent", "partially_equivalent", "not_equivalent", "insufficient_evidence"] as const;
export const ReviewSchema = z.object({
  equivalence: z
    .enum(BLIND_VERDICTS)
    .describe(
      "equivalent: nothing methodological changed; partially_equivalent: deviations that should not change the number; not_equivalent: the method, data, split, or metric changed; insufficient_evidence: the evidence cannot show it.",
    ),
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
export type Adapter = z.infer<typeof AdapterSchema>;
/** The Planner's output, which may reference a reviewed adapter by id. */
export type ProposedPlan = z.infer<typeof PlanSchema>;
/** A plan after code resolved any reviewed adapter reference: the adapter is always the full text. */
export type Plan = Omit<ProposedPlan, "adapter"> & { adapter: Adapter | null };
export type Submission = z.infer<typeof SubmissionSchema>;
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type BlindReview = z.infer<typeof ReviewSchema>;
/** A blind review with the verdict code derived from it. */
export type Review = BlindReview & { verdict: "approve" | "reject" };

export function withVerdict(review: BlindReview): Review {
  return {
    ...review,
    verdict: review.equivalence === "equivalent" || review.equivalence === "partially_equivalent" ? "approve" : "reject",
  };
}
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
  reproduction_planner: ["board_read", "repo_list", "repo_read", "repo_search", "dependency_discover", "dependency_check"],
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
  independent_reviewer: ["board_read", "repo_list", "repo_read", "artifact_read", "logs_read"],
  supervisor: ["board_read"],
};

/** Every role after the Paper Analyst works blind to the paper's number. */
const BLIND_PLANNING =
  "The study is blinded: you are not told the value the paper reports, and must not try to find it. Plan to measure the metric faithfully, never to match a number: state no expected, target, or reported value, no tolerance, and no comparison with the paper anywhere in the plan. A plan that does is refused.";
// Paths are relative to the lab workspace (/workspace/case); see LAB_LAYOUT in context.ts.
const LAB_PATHS =
  "Lab layout, relative to the workspace /workspace/case: `repo` (the checkout, read-only), `work/repo` (its writable copy), `work/adapter` (a reviewed adapter), `data/extracted/` (an extracted dataset archive, read-only; a reviewed dataset's `files` are listed relative to it), and `artifacts/` (collected outputs). A metricParser `path` such as `artifacts/result.json` is read from the workspace, so the official run must write it there: from `repo` that is `../artifacts/result.json`, from `work/repo` it is `../../artifacts/result.json`. Likewise a dataset file is `../data/extracted/<file>` from `repo` and `../../data/extracted/<file>` from `work/repo`.";
const BLIND_EXECUTION =
  "The study is blinded: you are not told the value the paper reports or any tolerance, and must not look for them (saved notebook outputs were removed). Never compare your measurement with a paper value; the lab parses the metric and code compares it only after the result and its review are locked.";

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
    "You do not know which claim the Paper Analyst chose; describe what the repository can produce. Saved notebook outputs were removed from the checkout you read; do not report any result value in your map.",
  ].join("\n"),
  reproduction_planner: [
    "Reconcile the Paper Analyst's claim with the Repository Analyst's map (both on the board) into one exact plan to reproduce that claim with the repository's official code in an offline, CPU-only Linux lab.",
    "The command runs `python <entrypoint> [args]` from `repo` (read-only) or `work/repo` (a writable copy made before the run). Choose the Python version the code supports (3.10 or 3.11 for older code). Requirements come from the repository's dependency files unchanged; a pin may be relaxed or added only by choosing an entry from trustedCompatibilityConstraints (copied exactly into compatibilityConstraints); anything else is refused by policy.",
    "Use dependency_check to see whether binary wheels exist for your requirements on the lab platform; nothing is built from source, and GPU packages (CUDA, ROCm) are refused.",
    "Data: prefer files in the repository. A download is allowed only from an administrator-allowed host and needs its SHA-256; otherwise set status blocked.",
    "metricParser must read the number the official code prints (stdout pattern with one capture group) or writes (a JSON file under artifacts/). An adapter is a small wrapper that only calls the official code and captures its metric; it must list every difference. Never plan a rewritten approximation, a changed dataset, a subset, altered filtering, or a replacement metric.",
    LAB_PATHS,
    BLIND_PLANNING,
  ].join("\n"),
  lab_engineer: [
    "You work alone inside a sealed, offline Linux lab prepared for the approved plan: /workspace/case/repo is the repository (read-only), work/repo is a writable copy when the plan asked for one, data/ holds verified datasets (read-only), and the Python environment is already installed.",
    "Run the approved command with lab_run_official. It runs exactly the plan's argv from the plan's cwd, after the lab checks the checkout and environment are unchanged. When it fails, read its logs, inspect files, and fix what the plan allows (for example create an output directory with lab_run). Use request_debugging when you are stuck.",
    LAB_PATHS,
    "If the code needs a different or extra package, use dependency_request with the reason and then finish as not_measured: the plan is re-approved and a fresh lab is prepared. Never change the code, the data, the split, or the metric.",
    "When the official run succeeded, finish as measured with its receipt id. The metric is parsed by the lab from that run, not by you. Declare every deviation you know of.",
    BLIND_EXECUTION,
  ].join("\n"),
  debugger: [
    "A Lab Engineer's command failed. Read its receipts and logs, the approved plan, and the files in the lab (read-only) and find the root cause.",
    "Propose the smallest fix that keeps the paper's method, data, and metric unchanged. Say whether it needs a change to the approved plan (a different package, command, or Python version) and whether it would change the methodology.",
    BLIND_EXECUTION,
  ].join("\n"),
  independent_reviewer: [
    "Review one measured result independently and blind. You see the approved execution plan (method, dataset, split, preprocessing, metric and its direction, repository commit, entry point, command, environment, parser), the repository as the lab saw it, dependency and dataset receipts, command receipts and logs, the exported artifacts, the declared adapter and deviations, and the metric the lab parsed. You do not see the paper's value, any tolerance, any difference, or the Engineer's reasoning, and must not look for them or assume them.",
    "Check: the approved official command ran and exited 0; the metric came from that run's own new output (never from saved notebook output or a hard-coded number); the dataset, split, preprocessing, and metric match the plan; declared deviations and compatibility changes are acceptable.",
    "equivalence is `equivalent` only if nothing methodological changed; `partially_equivalent` for library-version, path, or wrapper differences that should not change the number; `not_equivalent` for any toy example, approximation, changed dataset, subset, altered filtering, altered algorithm, changed split, or replacement metric; `insufficient_evidence` when the receipts and logs cannot show how the number was produced.",
    "Judge the protocol, not the number: you cannot know whether it matches the paper, and must not guess. Evaluate every listed adapter difference against the plan and the pinned repository's code, and name in concerns each one that could move the number. An adapter is project-owned code, not the authors' (reviewedAdapterId and adapterSha256 identify a reviewed one); say so in your summary. Your review is locked before code reveals the paper's value.",
  ].join("\n"),
  supervisor: [
    "You oversee a reproduction study that code runs stage by stage. You read the evidence board and answer at checkpoints.",
    "At a checkpoint after execution or review, choose continue, replan (with the typed reason and concrete guidance for the Planner), or stop. A re-plan is allowed once per reason; do not ask for the same thing twice.",
    "At the end, propose the status the evidence supports with your rationale. The final status is computed from evidence: you can make it more cautious, never more favourable, and you cannot create evidence, change the metric, or change the blind review.",
    "The study is blinded: before the reveal you are not told the paper's value or tolerance. The comparison is computed by code after the observation and the blind review are locked.",
  ].join("\n"),
};

/**
 * Replacements for the standing instructions when the study investigates a
 * reviewed claim target. The target says which claim to check; it never says
 * the claim holds, and every agent may still reject it on the evidence.
 */
export const TARGETED_INSTRUCTIONS: Partial<Record<AgentRole, string>> = {
  paper_analyst: [
    "This study investigates one reviewed claim, given in `reviewedTarget` (page, location, method, dataset, split, metric, and the value the paper reports). Verify it against the uploaded paper with your tools; do not choose a different claim.",
    "If the paper supports it, finish ready with that claim: its page and location, an `excerpt` copied verbatim from that page that contains the reported value, and the method, dataset, split, metric, and reported value as the paper states them.",
    "If the paper does not state that claim on that page, or states a different value, method, dataset, or metric, finish inconclusive and say exactly what does not match. Never substitute another table, listing, method (for example a variant with a similar name), or value.",
    "selectedRepositoryUrl must be one of the repository candidates you were given. Write `not stated` for preprocessing or seed when the paper does not say, and list them in missingFields; never guess. You cannot see the repository or the other analysts.",
  ].join("\n"),
  repository_analyst: [
    "This study investigates one reviewed claim (`reviewedTarget`). Acquire the repository with repo_acquire (it is pinned to the reviewed commit), then inspect it independently: does the claim map to official code here? Identify the official notebook or script for it, where its data comes from, the dependency files and the environment it needs, and where the code computes or prints the metric.",
    "Do not assume the target is valid: if the repository has no official code for this method, dataset, and metric, finish inconclusive and say why. Use dependency_discover to report which dependency files exist. You only read files: nothing in the repository is executed by you. You do not see the Paper Analyst's work.",
    "The study is blinded: you are not told the value the paper reports, saved notebook outputs were removed from the checkout you read, and you must not report any result value in your map.",
  ].join("\n"),
  reproduction_planner: [
    "This study investigates one reviewed claim (`reviewedTarget`). Reconcile it with the Paper Analyst's verified claim contract and the Repository Analyst's map (both on the board) into one exact plan that measures that claim with the reviewed entry point of the pinned repository in an offline, CPU-only Linux lab.",
    "Plan only for the reviewed claim: never switch to another method, a variant with a similar name, another library version, another dataset, split, or metric. If the analysts' evidence does not support the reviewed claim, or the repository's code does not produce it, finish blocked or inconclusive with the reason.",
    "Your plan must fit the reviewed limits, which policy enforces: the entry point, a Python version from `environment.python`, requirements only from `environment.requirements`, compatibility constraints only from `environment.allowedCompatibilityConstraints` (copied exactly, and only if also listed in trustedCompatibilityConstraints), the reviewed dataset source, the reviewed `metricParser` exactly, and an expected runtime within the ceiling.",
    "The command runs `python <entrypoint or adapter> [args]` from `repo` (read-only) or `work/repo`. When a reviewed adapter is given, read it; if it is needed, set adapter to {reviewedAdapterId: <its id>} and run it at its path (for example `../work/adapter/<file>.py` from `repo`) with the arguments it expects. Do not write your own adapter for a reviewed claim. Use dependency_check to confirm binary wheels exist for the lab platform.",
    LAB_PATHS,
    BLIND_PLANNING,
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
