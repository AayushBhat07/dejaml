import type { AgentLimits, AgentRole } from "@dejaml/agent-runtime";
import { PaperAnalysisSchema } from "@dejaml/contracts";
import { z } from "zod";

/**
 * Standing instructions, result shapes, and limits for the seven roles.
 * Each role runs as its own agent instance with its own conversation.
 */

const RelativePath = z.string().min(1).max(300);

export const PaperClaimResultSchema = PaperAnalysisSchema;

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

export const PlanSchema = z.object({
  status: z.enum(["ready", "blocked", "inconclusive"]),
  summary: z.string().min(1).max(2_000),
  /** The claim this plan targets, copied from the Paper Analyst's claim. */
  target: z.object({
    experimentLabel: z.string().min(1).max(300),
    metric: z.string().min(1).max(200),
    unit: z.enum(["fraction", "percent", "score"]),
    reportedValue: z.number(),
  }),
  officialEntrypoint: z.object({ path: RelativePath, why: z.string().min(1).max(500) }).nullable(),
  steps: z.array(z.string().min(1).max(500)).min(1).max(15),
  environment: z.object({
    requested: z.array(z.string().max(200)).max(150),
    manifestPrepared: z.boolean(),
    deviations: z.array(z.string().max(500)).max(20),
  }),
  datasets: z.array(z.object({ name: z.string().min(1).max(200), source: z.enum(["repository", "download"]), location: z.string().min(1).max(500) })).max(10),
  metricExtraction: z.string().min(1).max(1_000),
  adapterExpected: z.boolean(),
  adapterJustification: z.string().max(1_000).nullable(),
  risks: z.array(z.string().max(500)).max(10),
  blockedReason: z.string().max(1_000).nullable(),
});

export const AdapterDeclarationSchema = z.object({
  path: RelativePath,
  why: z.string().min(1).max(1_000),
  source: z.string().min(1).max(500),
  differences: z.array(z.string().max(500)).max(20),
  changesEvidenceEquivalence: z.boolean(),
});

export const SubmissionSchema = z.object({
  status: z.enum(["measured", "not_measured"]),
  summary: z.string().min(1).max(2_000),
  /** JSON file under artifacts/ written by a successful run step. */
  metricFile: RelativePath.nullable(),
  /** Dot path of the numeric value inside the JSON file, such as `metrics.accuracy`. */
  metricKey: z.string().min(1).max(200).nullable(),
  unit: z.enum(["fraction", "percent", "score"]).nullable(),
  /** Receipt of the lab_run step that produced the metric file. */
  producingReceiptId: z.string().min(1).max(100).nullable(),
  officialCodeRan: z.boolean(),
  officialCommands: z.array(z.string().max(500)).max(10),
  adapters: z.array(AdapterDeclarationSchema).max(10),
  deviations: z.array(z.string().max(500)).max(20),
  failureReason: z.string().max(1_000).nullable(),
});

export const DiagnosisSchema = z.object({
  diagnosis: z.string().min(1).max(2_000),
  rootCause: z.string().min(1).max(1_000),
  suggestedFix: z.string().min(1).max(2_000),
  fixableInLab: z.boolean(),
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

export const SupervisorResultSchema = z.object({
  proposedStatus: z.enum(["reproduced", "partially_reproduced", "not_reproduced", "inconclusive", "policy_blocked"]),
  rationale: z.string().min(1).max(3_000),
});

export type RepositoryMapping = z.infer<typeof RepositoryMappingSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Submission = z.infer<typeof SubmissionSchema>;
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type SupervisorResult = z.infer<typeof SupervisorResultSchema>;

export const ROLE_LIMITS: Record<AgentRole, Partial<AgentLimits>> = {
  paper_analyst: { maxIterations: 20, maxToolCalls: 30, maxWallMs: 10 * 60_000 },
  repository_analyst: { maxIterations: 25, maxToolCalls: 40, maxWallMs: 10 * 60_000 },
  reproduction_planner: { maxIterations: 30, maxToolCalls: 40, maxWallMs: 25 * 60_000 },
  lab_engineer: { maxIterations: 60, maxToolCalls: 80, maxWallMs: 50 * 60_000 },
  debugger: { maxIterations: 12, maxToolCalls: 20, maxWallMs: 8 * 60_000 },
  independent_reviewer: { maxIterations: 20, maxToolCalls: 30, maxWallMs: 10 * 60_000 },
  supervisor: { maxIterations: 30, maxToolCalls: 30, maxWallMs: 3 * 60 * 60_000 },
};

export const INSTRUCTIONS: Record<AgentRole, string> = {
  paper_analyst: [
    "Read the uploaded paper with your tools and select exactly one numeric experimental claim that a CPU-only run of the paper's own code could check.",
    "Prefer a claim in a table or the text that names its metric, dataset, and value. Cite every fact with a `paper_page` evidence pointer whose reference is `page N` and whose excerpt is copied from that page.",
    "selectedRepositoryUrl must be one of the repository candidates you were given. Record missing information (seed, split, preprocessing) in missingFields rather than guessing.",
    "You cannot see the repository. If no claim is testable on a CPU, finish with status inconclusive and the reasons.",
  ].join("\n"),
  repository_analyst: [
    "Acquire the paper's repository with repo_acquire (only the listed candidate URLs are allowed), then map it: the official entry points, where the data lives, the dependency files, and where the code computes or prints metrics.",
    "Use dependency_discover to report which dependency files and lockfiles exist. Read README instructions. Never run anything: you only read files.",
    "You do not know which claim the Paper Analyst chose; describe what the repository can produce.",
  ].join("\n"),
  reproduction_planner: [
    "Reconcile the Paper Analyst's claim with the Repository Analyst's map into a concrete plan to reproduce that one claim with the repository's official code, in an offline Linux lab (Python 3.13, CPU only, no network).",
    "Prepare the Python environment before the lab starts: choose requirements (prefer the project's lockfile or pinned requirements), call dependency_resolvePython, then dependency_downloadWheels. Only binary wheels exist here; nothing is built from source.",
    "If a pinned version has no compatible wheel, you may relax that pin, but record every relaxed or dropped requirement in environment.deviations: a different library version is a deviation the reviewer will weigh. Do not add packages the code does not import.",
    "Datasets: prefer data shipped in the repository. dataset_fetch works only for administrator-allowed hosts; if the data cannot be obtained, set status blocked with blockedReason.",
    "Plan to run official scripts. An adapter (a small script the Engineer writes) is acceptable only to call the official code, fix paths, or write the metric to a JSON file; say why in adapterJustification. Never plan a rewritten approximation, a changed dataset, a reduced sample, or a replacement metric.",
  ].join("\n"),
  lab_engineer: [
    "You work alone inside a sealed, offline Linux lab. /workspace/case/repo is the repository (read-only); /workspace/case/wheels holds prepared Python wheels (read-only) when the plan needed packages; /workspace/case/data holds downloaded datasets (read-only) when any were fetched; /workspace/case/work is your writable scratch space; /workspace/case/artifacts is where results must be written.",
    "Follow the plan. If wheels were prepared, call dependency_installOffline first, then run Python as /workspace/case/work/.venv/bin/python. Scripts that write output next to themselves need a writable copy: copy the repository into work/ (for example `cp -r repo work/repo`) and run from there.",
    "Run the official code first. When a command fails, read the error, inspect files, and fix the cause; use request_debugging when you are stuck. Retrying the identical command without a change is not a fix.",
    "The metric must come from a real run: write it to a JSON file under artifacts/ from code that computes it (not by typing the number), and submit that file with the lab_run receipt of the step that produced it. Declare every file you wrote that changes or wraps the computation in adapters, with why, its source, and every methodological difference.",
    "Never change the dataset, subsample, swap the metric, or tune toward the paper's number. If the claim cannot be measured faithfully, finish with status not_measured and the reason.",
  ].join("\n"),
  debugger: [
    "A Lab Engineer's command failed. Read the failing command receipts, the plan, and the files in the lab (read-only) and find the root cause.",
    "Propose the smallest fix that keeps the paper's method, data, and metric unchanged. Say if the fix would change the methodology, and if it cannot be fixed inside an offline lab.",
  ].join("\n"),
  independent_reviewer: [
    "Review one submitted measurement independently. You see the paper claim, repository metadata, the declared plan, the environment manifest, dataset receipts, command receipts with exit codes and output hashes, the exported artifacts, and the adapter declarations. You do not see the Engineer's reasoning, and you must not assume it.",
    "Check: the official code actually ran; the metric file came from that run; the dataset, split, and metric match the claim; every adapter is declared and its differences are acceptable; environment deviations are recorded.",
    "equivalence is `equivalent` only if nothing methodological changed, `minor_deviations` for library-version or path-only differences that should not change the number, and `not_equivalent` for any toy example, rewritten approximation, changed dataset, reduced sample, or replacement metric. Reject anything not_equivalent or unsupported by the evidence.",
  ].join("\n"),
  supervisor: [
    "You coordinate a reproduction study by delegating to specialist agents with the delegate tool, and you read their results on the evidence board.",
    "Typical order: paper_analyst and repository_analyst together (they are independent), then reproduction_planner, then lab_engineer (runs independent engineers in separate labs), then independent_reviewer (reviews every submission).",
    "When a stage fails, read why and decide: retry it with a sharper objective (for example re-plan after a dependency failure), or stop. Do not retry the same thing unchanged.",
    "Finish with the status you believe the evidence supports and your rationale. The final status is also checked mechanically: you can make it more cautious, never more favourable.",
  ].join("\n"),
};

export const RESULT_DESCRIPTIONS: Record<AgentRole, string> = {
  paper_analyst: "The selected claim with page evidence, or inconclusive with reasons.",
  repository_analyst: "A map of the repository: entry points, data, dependency files, metric sources.",
  reproduction_planner: "The reproduction plan, or blocked/inconclusive with the reason.",
  lab_engineer: "Your submission: the metric JSON file and key, the producing receipt, adapters, and deviations.",
  debugger: "Your diagnosis and the smallest faithful fix.",
  independent_reviewer: "Your verdict, the equivalence judgment, the checks you made, and concerns.",
  supervisor: "The status you propose and your rationale.",
};
