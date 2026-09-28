import { z } from "zod";

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "expected a lowercase SHA-256 digest");

export const CommitShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/, "expected a full lowercase Git commit SHA");

export const GithubRepositoryUrlSchema = z
  .url()
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/,
    "expected a canonical HTTPS GitHub repository URL",
  )
  .refine((value) => !value.endsWith("/.") && !value.endsWith("/.."), {
    message: "repository name cannot be a dot path",
  });

export const RunStatusSchema = z.enum([
  "queued",
  "ingesting",
  "discovering_repository",
  "analyzing",
  "planning",
  "validating_plan",
  "preparing_lab",
  "running",
  "comparing",
  "completed",
  "inconclusive",
  "failed",
  "cancelled",
  "timed_out",
]);

export const PaperPageSchema = z.object({
  pageNumber: z.number().int().positive(),
  text: z.string(),
  charCount: z.number().int().nonnegative(),
});

export const PaperDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  file: z.object({
    originalName: z.string().min(1),
    bytes: z.number().int().positive(),
    sha256: Sha256Schema,
  }),
  pageCount: z.number().int().positive(),
  pages: z.array(PaperPageSchema).min(1),
  totalTextChars: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export const RepositoryCandidateSchema = z.object({
  repositoryUrl: GithubRepositoryUrlSchema,
  owner: z.string().min(1),
  name: z.string().min(1),
  occurrences: z
    .array(
      z.object({
        pageNumber: z.number().int().positive(),
        rawUrl: z.string().min(1),
      }),
    )
    .min(1),
});

export const RepositoryAcquisitionSchema = z.object({
  schemaVersion: z.literal(1),
  repositoryUrl: GithubRepositoryUrlSchema,
  commitSha: CommitShaSchema,
  defaultBranch: z.string().min(1),
  repositorySizeKb: z.number().int().nonnegative(),
  destination: z.string().min(1),
  acquiredAt: z.iso.datetime({ offset: true }),
});

export const EvidencePointerSchema = z.object({
  kind: z.enum(["paper_page", "repository_file", "log_line", "artifact"]),
  reference: z.string().min(1),
  excerpt: z.string().min(1).optional(),
});

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const ClaimSchema = z.object({
  experimentLabel: z.string().min(1),
  dataset: z.string().min(1),
  split: z.string().min(1).nullable(),
  model: z.string().min(1),
  metric: z.object({
    name: z.string().min(1),
    unit: z.enum(["fraction", "percent", "score"]),
    reportedValue: z.number().finite(),
  }),
  seed: z.number().int().nullable(),
  hyperparameters: z.record(z.string(), ScalarSchema),
  evidence: z.array(EvidencePointerSchema).min(1),
  missingFields: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
});

export const ArgvCommandSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
});

export const CodeMappingSchema = z.object({
  repositoryUrl: GithubRepositoryUrlSchema,
  commitSha: CommitShaSchema,
  entrypoint: z.string().min(1),
  relevantFiles: z
    .array(
      z.object({
        path: z.string().min(1),
        sha256: Sha256Schema,
        reason: z.string().min(1),
      }),
    )
    .min(1),
  dependencyFiles: z.array(z.string()),
  datasetReferences: z.array(z.string()),
  candidateCommand: ArgvCommandSchema.nullable(),
  metricEvidence: z.array(EvidencePointerSchema),
  warnings: z.array(z.string()),
});

export const PaperAnalysisSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["ready", "inconclusive"]),
    summary: z.string().min(1),
    selectedRepositoryUrl: GithubRepositoryUrlSchema.nullable(),
    claim: ClaimSchema.nullable(),
    reasons: z.array(z.string().min(1)),
    warnings: z.array(z.string()),
  })
  .superRefine((value, context) => {
    if (value.status === "ready" && (!value.claim || !value.selectedRepositoryUrl)) {
      context.addIssue({
        code: "custom",
        message: "ready paper analysis requires a claim and selected repository",
      });
    }
    if (value.status === "inconclusive" && value.reasons.length === 0) {
      context.addIssue({
        code: "custom",
        message: "inconclusive paper analysis requires at least one reason",
      });
    }
  });

export const CodeAnalysisSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["ready", "inconclusive"]),
    summary: z.string().min(1),
    mapping: CodeMappingSchema.nullable(),
    reasons: z.array(z.string().min(1)),
    warnings: z.array(z.string()),
  })
  .superRefine((value, context) => {
    if (value.status === "ready" && !value.mapping) {
      context.addIssue({ code: "custom", message: "ready code analysis requires a mapping" });
    }
    if (value.status === "inconclusive" && value.reasons.length === 0) {
      context.addIssue({
        code: "custom",
        message: "inconclusive code analysis requires at least one reason",
      });
    }
  });

export const DatasetSpecSchema = z.object({
  name: z.string().min(1),
  sourceUrl: z.url(),
  sha256: Sha256Schema,
  expectedPaths: z.array(z.string().min(1)).min(1),
});

export const PreparationStepSchema = z.object({
  kind: z.enum(["copy", "rename", "install", "generate"]),
  description: z.string().min(1),
  command: ArgvCommandSchema.omit({ env: true }).optional(),
});

export const ResourceBudgetSchema = z.object({
  cpus: z.number().positive().max(8),
  memoryMb: z.number().int().positive().max(16_384),
  pids: z.number().int().positive().max(1_024),
  timeoutSeconds: z.number().int().positive().max(3_600),
  networkDuringRun: z.literal(false),
});

export const MetricExtractionSchema = z
  .object({
    source: z.enum(["stdout", "json", "csv"]),
    pattern: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.source === "stdout" && !value.pattern) {
      context.addIssue({
        code: "custom",
        message: "stdout metric extraction requires a pattern",
      });
    }
    if (value.source !== "stdout" && (!value.path || !value.key)) {
      context.addIssue({
        code: "custom",
        message: `${value.source} metric extraction requires path and key`,
      });
    }
  });

export const ExperimentPlanSchema = z.object({
  caseId: z.string().min(1),
  repository: z.object({
    url: GithubRepositoryUrlSchema,
    commitSha: CommitShaSchema,
  }),
  claim: ClaimSchema,
  dataset: DatasetSpecSchema,
  preparation: z.array(PreparationStepSchema),
  command: ArgvCommandSchema,
  resources: ResourceBudgetSchema,
  metricExtraction: MetricExtractionSchema,
  maxAttempts: z.union([z.literal(1), z.literal(2)]),
  stopConditions: z.array(z.string().min(1)).min(1),
});

export const ActorSchema = z.enum([
  "system",
  "paper_analyst",
  "code_analyst",
  "lead_researcher",
  "lab_engineer",
  "result_verifier",
]);

export const RunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.iso.datetime({ offset: true }),
  actor: ActorSchema,
  type: z.string().min(1),
  status: z.enum(["started", "progress", "completed", "warning", "failed"]),
  summary: z.string().min(1),
  evidence: z.array(EvidencePointerSchema),
  publicPayload: z.record(z.string(), z.unknown()),
});

export const AttemptSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  number: z.number().int().positive(),
  label: z.enum(["baseline", "modified"]),
  command: ArgvCommandSchema,
  changes: z.array(z.string()),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  artifactDigests: z.record(z.string(), Sha256Schema),
});

export const MetricSchema = z.object({
  name: z.string().min(1),
  value: z.number().finite(),
  unit: z.enum(["fraction", "percent", "score"]),
  split: z.string().min(1),
  attemptId: z.string().min(1),
  extractionRule: z.string().min(1),
  evidence: EvidencePointerSchema,
});

export const AssessmentSchema = z.object({
  comparable: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string().min(1),
      passed: z.boolean(),
      explanation: z.string().min(1),
    }),
  ),
  paperValue: z.number().finite().nullable(),
  observedValue: z.number().finite().nullable(),
  signedDifference: z.number().finite().nullable(),
  absoluteDifference: z.number().finite().nonnegative().nullable(),
  tolerance: z.number().finite().nonnegative().nullable(),
  verdict: z.enum([
    "reproduced_within_tolerance",
    "different_result",
    "inconclusive",
  ]),
  discrepancyHypotheses: z.array(z.string()),
  evidence: z.array(EvidencePointerSchema),
  limitations: z.array(z.string()),
});

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type PaperPage = z.infer<typeof PaperPageSchema>;
export type PaperDocument = z.infer<typeof PaperDocumentSchema>;
export type RepositoryCandidate = z.infer<typeof RepositoryCandidateSchema>;
export type RepositoryAcquisition = z.infer<typeof RepositoryAcquisitionSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type CodeMapping = z.infer<typeof CodeMappingSchema>;
export type PaperAnalysis = z.infer<typeof PaperAnalysisSchema>;
export type CodeAnalysis = z.infer<typeof CodeAnalysisSchema>;
export type ExperimentPlan = z.infer<typeof ExperimentPlanSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type Metric = z.infer<typeof MetricSchema>;
export type Assessment = z.infer<typeof AssessmentSchema>;
