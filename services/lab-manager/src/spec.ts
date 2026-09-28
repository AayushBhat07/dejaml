import { posix } from "node:path";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { ExperimentPlanSchema, ResourceBudgetSchema, type ExperimentPlan } from "@dejaml/contracts";
import { z } from "zod";

export const ImageIdSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "expected a local image ID such as sha256:<64 hex>");

/** A path inside the lab workspace, written relative to the lab working directory. */
export const WorkspaceRelativePathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      posix.normalize(value) === value &&
      value !== "." &&
      !value.split("/").includes(".."),
    { message: "expected a normalized relative path without '..'" },
  );

export const LabInputSchema = z.object({
  hostPath: z.string().refine(isAbsolute, { message: "input host path must be absolute" }),
  containerPath: WorkspaceRelativePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});

export const LabLimitsSchema = z.object({
  maxLogBytes: z.number().int().positive().max(8 * 1024 * 1024),
  maxArtifactBytes: z.number().int().positive().max(64 * 1024 * 1024),
  maxArtifactTotalBytes: z.number().int().positive().max(256 * 1024 * 1024),
  maxArtifactFiles: z.number().int().positive().max(1_000),
  tmpfsMb: z.number().int().positive().max(1_024),
});

export const LabSpecSchema = z
  .object({
    runId: z.string().min(1),
    image: z.string().min(1),
    expectedImageId: ImageIdSchema,
    workdir: z
      .string()
      .regex(/^\/workspace(?:\/[A-Za-z0-9._-]+)+$/u, "workdir must be beneath /workspace"),
    artifactsDir: WorkspaceRelativePathSchema,
    inputs: z.array(LabInputSchema),
    resources: ResourceBudgetSchema,
    limits: LabLimitsSchema,
  })
  .superRefine((spec, context) => {
    const seen = new Set<string>();
    for (const input of spec.inputs) {
      if (seen.has(input.containerPath)) {
        context.addIssue({ code: "custom", message: `duplicate input path ${input.containerPath}` });
      }
      seen.add(input.containerPath);
      if (
        input.containerPath === spec.artifactsDir ||
        input.containerPath.startsWith(`${spec.artifactsDir}/`) ||
        spec.artifactsDir.startsWith(`${input.containerPath}/`)
      ) {
        context.addIssue({
          code: "custom",
          message: `input ${input.containerPath} overlaps the writable artifact directory`,
        });
      }
    }
  });

export type LabInput = z.infer<typeof LabInputSchema>;
export type LabLimits = z.infer<typeof LabLimitsSchema>;
export type LabSpec = z.infer<typeof LabSpecSchema>;

export const DEFAULT_LAB_LIMITS: LabLimits = {
  maxLogBytes: 256 * 1024,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxArtifactTotalBytes: 32 * 1024 * 1024,
  maxArtifactFiles: 64,
  tmpfsMb: 64,
};

/**
 * Translates an approved experiment plan into a lab specification. The
 * DéjàML-owned execution adapter and the dataset files are mounted read-only
 * from the curated case directory; only the artifact directory is writable.
 */
export function labSpecFromPlan(input: {
  plan: ExperimentPlan;
  runId: string;
  projectRoot: string;
  image: string;
  expectedImageId: string;
  limits?: Partial<LabLimits>;
}): LabSpec {
  const plan = ExperimentPlanSchema.parse(input.plan);
  const projectRoot = resolve(input.projectRoot);
  const adapterPath = resolve(projectRoot, plan.executionAdapter.path);
  const caseRoot = dirname(adapterPath);
  if (!caseRoot.startsWith(`${projectRoot}/`)) {
    throw new Error("execution adapter must live inside the project");
  }
  const adapterName = posix.basename(plan.executionAdapter.path);
  const artifactFile = plan.metricExtraction.path;
  const artifactsDir = artifactFile ? posix.dirname(artifactFile) : "artifacts";

  return LabSpecSchema.parse({
    runId: input.runId,
    image: input.image,
    expectedImageId: input.expectedImageId,
    workdir: plan.command.cwd,
    artifactsDir,
    inputs: [
      { hostPath: adapterPath, containerPath: adapterName, sha256: plan.executionAdapter.sha256 },
      ...plan.dataset.expectedPaths.map((path) => ({
        hostPath: join(caseRoot, path),
        containerPath: path,
      })),
    ],
    resources: plan.resources,
    limits: { ...DEFAULT_LAB_LIMITS, ...input.limits },
  });
}
