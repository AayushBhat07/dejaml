// Stand-ins for Docker, the model provider, and GitHub, used by tests and by
// scripts/verify-stack.mjs to exercise the real API, pipeline, Lab Manager,
// policy gate, and verifier without external services. Never used by main.ts.
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CodeAnalysisSchema,
  LeadResearchDecisionSchema,
  PaperAnalysisSchema,
  type ExperimentPlan,
  type RepositoryAcquisition,
} from "@dejaml/contracts";
import type { ContainerRuntime, RuntimeCommandOptions, RuntimeCommandResult } from "@dejaml/lab-manager";
import type { StructuredCompletionRequest, StructuredModelClient } from "@dejaml/research-runtime";
import { PDFDocument, StandardFonts } from "pdf-lib";

import type { CuratedCase } from "./cases.js";

export const STAND_IN_IMAGE_ID = `sha256:${"c".repeat(64)}`;
export const NOTEBOOK = '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}\n';
export const NOTEBOOK_PATH = "Urban Land Cover Classification.ipynb";
const RESULT = '{"metrics":{"accuracyPercent":79.88}}';

export type ExecMode = "success" | "hang" | "no_metric" | "crash";

function ok(stdout = ""): RuntimeCommandResult {
  return {
    exitCode: 0,
    stdout: { text: stdout, bytes: stdout.length, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    aborted: false,
  };
}

/**
 * Stands in for Docker: success writes the curated result; hang waits to be
 * killed; no_metric exits 0 without a result; crash exits 3.
 */
export class ScriptedRuntime implements ContainerRuntime {
  mode: ExecMode = "success";
  /** Spreads the scripted output over this many milliseconds so live views have time to update. */
  execDelayMs = 0;
  readonly containers = new Set<string>();
  execStarted: (() => void) | null = null;
  #artifacts = "";
  #kill: (() => void) | null = null;

  async docker(args: readonly string[], options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    const [command] = args;
    if (command === "image") return ok(`${STAND_IN_IMAGE_ID} 10001:10001`);
    if (command === "create") {
      this.containers.add(args[args.indexOf("--name") + 1] ?? "");
      const mount = args.find((arg) => arg.endsWith("dst=/workspace/case/artifacts")) ?? "";
      this.#artifacts = /src=([^,]+),/u.exec(mount)?.[1] ?? "";
      return ok();
    }
    if (command === "exec") {
      this.execStarted?.();
      if (this.mode === "hang") {
        options.onOutput?.("stdout", "training…\n");
        await new Promise<void>((resolve) => {
          this.#kill = resolve;
        });
        return { ...ok(), exitCode: 137 };
      }
      if (this.mode === "no_metric") return ok("finished without writing a result\n");
      if (this.mode === "crash") {
        options.onOutput?.("stderr", "Traceback (most recent call last): KeyError: 'class'\n");
        return { ...ok(), exitCode: 3, stderr: { text: "KeyError: 'class'\n", bytes: 16, truncated: false } };
      }
      for (let step = 1; step <= 3 && this.execDelayMs > 0; step += 1) {
        options.onOutput?.("stdout", `stand-in progress ${step}/3\n`);
        await new Promise((resolve) => setTimeout(resolve, this.execDelayMs / 3));
      }
      await writeFile(join(this.#artifacts, "result.json"), RESULT);
      options.onOutput?.("stdout", 'DEJAML_RESULT={"accuracyPercent":79.88}\n');
      return ok('DEJAML_RESULT={"accuracyPercent":79.88}\n');
    }
    if (command === "stats") {
      while (!options.signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      return { ...ok(), aborted: true };
    }
    if (command === "kill") {
      this.#kill?.();
      return ok();
    }
    if (command === "rm") {
      this.containers.delete(args.at(-1) ?? "");
      return ok();
    }
    if (command === "ps") {
      const filter = args[args.indexOf("--filter") + 1] ?? "";
      return ok(filter === "label=dejaml.lab" ? [...this.containers].map((name) => `${name}\tlab_${"a".repeat(32)}\trun_x`).join("\n") : "");
    }
    return ok();
  }
}

/** Returns reviewed analyses so the pipeline can be exercised without a model provider. */
export class ScriptedModel implements StructuredModelClient {
  constructor(
    private readonly curated: CuratedCase,
    private readonly timeoutSeconds: number,
    private readonly delayMs = 0,
    /** Lets a test alter the Lead Researcher's plan, for example to exceed policy. */
    private readonly editPlan: (plan: ExperimentPlan) => ExperimentPlan = (plan) => plan,
  ) {}

  async complete<T>(request: StructuredCompletionRequest<T>): Promise<{ value: T }> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (request.signal?.aborted) throw new Error("cancelled");
    const policy = this.curated.policy;
    const claim = {
      experimentLabel: "Random Forest on UCI Urban Land Cover",
      dataset: policy.claim.dataset,
      split: "official test set",
      model: policy.claim.model,
      metric: { name: "accuracy", unit: policy.claim.unit, reportedValue: policy.claim.reportedValue },
      seed: null,
      hyperparameters: {},
      evidence: [{ kind: "paper_page" as const, reference: "page 1", excerpt: "Random Forest test accuracy of 81.66" }],
      missingFields: ["validation split seed"],
      confidence: "high" as const,
    };
    if (request.role === "paper_analyst") {
      return {
        value: request.schema.parse(
          PaperAnalysisSchema.parse({
            schemaVersion: 1,
            status: "ready",
            summary: "Extracted Random Forest test accuracy of 81.66%",
            selectedRepositoryUrl: policy.repository.url,
            claim,
            reasons: [],
            warnings: [],
          }),
        ),
      };
    }
    if (request.role === "code_analyst") {
      return {
        value: request.schema.parse(
          CodeAnalysisSchema.parse({
            schemaVersion: 1,
            status: "ready",
            summary: "Mapped the paper claim to a CPU-compatible Random Forest run",
            mapping: {
              repositoryUrl: policy.repository.url,
              commitSha: policy.repository.commitSha,
              entrypoint: NOTEBOOK_PATH,
              relevantFiles: [
                { path: NOTEBOOK_PATH, sha256: createHash("sha256").update(NOTEBOOK).digest("hex"), reason: "experiment" },
              ],
              dependencyFiles: [],
              datasetReferences: ["UCI Urban Land Cover"],
              candidateCommand: null,
              metricEvidence: [{ kind: "repository_file", reference: NOTEBOOK_PATH }],
              warnings: ["The validation split seed is not fixed."],
            },
            reasons: [],
            warnings: [],
          }),
        ),
      };
    }
    const plan: ExperimentPlan = {
      caseId: policy.caseId,
      repository: { url: policy.repository.url, commitSha: policy.repository.commitSha },
      claim,
      dataset: policy.dataset,
      preparation: policy.preparation,
      executionAdapter: policy.trustedExecutionAdapter,
      command: policy.command,
      resources: { ...policy.maximumResources, timeoutSeconds: this.timeoutSeconds },
      metricExtraction: policy.metricExtraction,
      maxAttempts: 1,
      stopConditions: policy.requiredStopConditions,
    };
    return {
      value: request.schema.parse(
        LeadResearchDecisionSchema.parse({
          schemaVersion: 1,
          status: "ready",
          summary: "Approved one deterministic CPU experiment with seed 42",
          plan: this.editPlan(plan),
          reasons: [],
          warnings: [],
        }),
      ),
    };
  }
}

export async function paperPdf(withLink = true): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText("Urban Land Cover: Random Forest test accuracy of 81.66 percent on the test set.", {
    x: 40,
    y: 730,
    size: 11,
    font,
  });
  pdf.addPage([612, 792]).drawText(
    withLink
      ? "Code: https://github.com/mtesha/tdl-vs-ml-urbanlandcover for reproducibility of every table."
      : "Code is available from the authors on request for reproducibility of every table.",
    { x: 40, y: 730, size: 11, font },
  );
  return pdf.save();
}

/** Creates a checkout containing only the curated notebook, pinned to the reviewed commit. */
export function standInAcquire(
  curated: CuratedCase,
  created: string[] = [],
  commitSha = curated.policy.repository.commitSha,
) {
  return async (input: { repositoryUrl: string; destinationRoot: string }): Promise<RepositoryAcquisition> => {
    const destination = await mkdtemp(join(input.destinationRoot, "dejaml-repo-"));
    created.push(destination);
    await writeFile(join(destination, NOTEBOOK_PATH), NOTEBOOK);
    return {
      schemaVersion: 1,
      repositoryUrl: input.repositoryUrl,
      commitSha,
      defaultBranch: "main",
      repositorySizeKb: 10,
      destination,
      acquiredAt: new Date().toISOString(),
    };
  };
}
