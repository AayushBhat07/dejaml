import {
  CodeAnalysisSchema,
  type CodeAnalysis,
  type PaperAnalysis,
  PaperAnalysisSchema,
  type PaperDocument,
  type RepositoryAcquisition,
  type RepositoryCandidate,
} from "@dejaml/contracts";
import { type RunStore } from "@dejaml/run-store";

import { buildPaperEvidenceBundle, snapshotRepositoryForAnalysis, type RepositoryEvidenceBundle } from "./evidence.js";
import { type StructuredCompletion, type StructuredModelClient } from "./model.js";
import { type AnalysisTargetHint, buildCodeAnalystPrompt, buildPaperAnalystPrompt } from "./prompts.js";

export type ParallelAnalysisResult = {
  paper: StructuredCompletion<PaperAnalysis>;
  code: StructuredCompletion<CodeAnalysis>;
};

export class ParallelAnalysisError extends Error {
  constructor(
    message: string,
    readonly failures: Array<{ role: "paper_analyst" | "code_analyst"; message: string }>,
  ) {
    super(message);
    this.name = "ParallelAnalysisError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicFailureSummary(role: "Paper" | "Code", error: unknown): string {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("cancel")) return `${role} analysis was cancelled.`;
  if (message.includes("timeout") || message.includes("deadline")) {
    return `${role} analysis exceeded its time limit.`;
  }
  if (message.includes("json") || message.includes("schema") || message.includes("validation")) {
    return `${role} analysis returned an invalid structured result.`;
  }
  return `${role} analysis could not be completed by the configured model runtime.`;
}

function validatePaperAnalysis(analysis: PaperAnalysis, document: PaperDocument, candidates: RepositoryCandidate[]): void {
  if (analysis.selectedRepositoryUrl) {
    const approved = new Set(candidates.map((candidate) => candidate.repositoryUrl.toLowerCase()));
    if (!approved.has(analysis.selectedRepositoryUrl.toLowerCase())) {
      throw new Error("Paper Analyst selected a repository not found by deterministic discovery");
    }
  }
  const pages = new Set(document.pages.map((page) => page.pageNumber));
  for (const evidence of analysis.claim?.evidence ?? []) {
    if (evidence.kind !== "paper_page") continue;
    const match = /\bpage\s+(\d+)\b/iu.exec(evidence.reference);
    if (!match || !pages.has(Number(match[1]))) {
      throw new Error(`Paper Analyst returned an invalid page reference: ${evidence.reference}`);
    }
  }
}

function validateCodeAnalysis(analysis: CodeAnalysis, acquisition: RepositoryAcquisition, repository: RepositoryEvidenceBundle): void {
  if (!analysis.mapping) return;
  if (
    analysis.mapping.repositoryUrl.toLowerCase() !== acquisition.repositoryUrl.toLowerCase() ||
    analysis.mapping.commitSha !== acquisition.commitSha
  ) {
    throw new Error("Code Analyst changed the approved repository identity or commit");
  }
  const files = new Map(repository.files.map((file) => [file.path, file.sha256]));
  if (!files.has(analysis.mapping.entrypoint)) {
    throw new Error(`Code Analyst entry point was not in supplied evidence: ${analysis.mapping.entrypoint}`);
  }
  for (const file of analysis.mapping.relevantFiles) {
    if (files.get(file.path) !== file.sha256) {
      throw new Error(`Code Analyst returned an unknown file or digest: ${file.path}`);
    }
  }
  for (const path of analysis.mapping.dependencyFiles) {
    if (!files.has(path)) throw new Error(`Code Analyst returned an unknown dependency file: ${path}`);
  }
}

export async function runParallelAnalysis(input: {
  runId: string;
  runStore: RunStore;
  paper: PaperDocument;
  repositoryCandidates: RepositoryCandidate[];
  acquisition: RepositoryAcquisition;
  modelClient: StructuredModelClient;
  targetHint?: AnalysisTargetHint;
  signal?: AbortSignal;
}): Promise<ParallelAnalysisResult> {
  const paperEvidence = buildPaperEvidenceBundle(input.paper, input.repositoryCandidates);
  const repositoryEvidence = await snapshotRepositoryForAnalysis(input.acquisition.destination);
  const paperPrompt = buildPaperAnalystPrompt({
    paper: paperEvidence,
    candidates: input.repositoryCandidates,
    ...(input.targetHint ? { targetHint: input.targetHint } : {}),
  });
  const codePrompt = buildCodeAnalystPrompt({
    acquisition: input.acquisition,
    repository: repositoryEvidence,
    ...(input.targetHint ? { targetHint: input.targetHint } : {}),
  });

  input.runStore.transitionRun(input.runId, "analyzing");
  input.runStore.appendEvent({
    runId: input.runId,
    actor: "paper_analyst",
    type: "analysis_started",
    status: "started",
    summary: "Paper Analyst is extracting one reported experimental claim.",
    evidence: paperEvidence.includedPages.map((pageNumber) => ({
      kind: "paper_page" as const,
      reference: `page ${pageNumber}`,
    })),
    publicPayload: { includedPages: paperEvidence.includedPages, omittedPages: paperEvidence.omittedPages },
  });
  input.runStore.appendEvent({
    runId: input.runId,
    actor: "code_analyst",
    type: "analysis_started",
    status: "started",
    summary: "Code Analyst is mapping repository files to a runnable experiment.",
    evidence: [{ kind: "artifact", reference: `repository@${input.acquisition.commitSha}` }],
    publicPayload: { inspectedFiles: repositoryEvidence.files.map((file) => file.path) },
  });

  const runPaper = async (): Promise<StructuredCompletion<PaperAnalysis>> => {
    try {
      const completion = await input.modelClient.complete({
        sessionId: `${input.runId}:paper_analyst`,
        role: "paper_analyst",
        systemPrompt: paperPrompt.systemPrompt,
        prompt: paperPrompt.prompt,
        schema: PaperAnalysisSchema,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      validatePaperAnalysis(completion.value, input.paper, input.repositoryCandidates);
      input.runStore.appendEvent({
        runId: input.runId,
        actor: "paper_analyst",
        type: "analysis_completed",
        status: completion.value.status === "ready" ? "completed" : "warning",
        summary: completion.value.summary,
        evidence: completion.value.claim?.evidence ?? [],
        publicPayload: { analysis: completion.value },
      });
      return completion;
    } catch (error) {
      input.runStore.appendEvent({
        runId: input.runId,
        actor: "paper_analyst",
        type: "analysis_failed",
        status: "failed",
        summary: publicFailureSummary("Paper", error),
        evidence: [],
        publicPayload: {},
      });
      throw error;
    }
  };

  const runCode = async (): Promise<StructuredCompletion<CodeAnalysis>> => {
    try {
      const completion = await input.modelClient.complete({
        sessionId: `${input.runId}:code_analyst`,
        role: "code_analyst",
        systemPrompt: codePrompt.systemPrompt,
        prompt: codePrompt.prompt,
        schema: CodeAnalysisSchema,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      validateCodeAnalysis(completion.value, input.acquisition, repositoryEvidence);
      input.runStore.appendEvent({
        runId: input.runId,
        actor: "code_analyst",
        type: "analysis_completed",
        status: completion.value.status === "ready" ? "completed" : "warning",
        summary: completion.value.summary,
        evidence: completion.value.mapping?.metricEvidence ?? [],
        publicPayload: { analysis: completion.value },
      });
      return completion;
    } catch (error) {
      input.runStore.appendEvent({
        runId: input.runId,
        actor: "code_analyst",
        type: "analysis_failed",
        status: "failed",
        summary: publicFailureSummary("Code", error),
        evidence: [],
        publicPayload: {},
      });
      throw error;
    }
  };

  const [paperResult, codeResult] = await Promise.allSettled([runPaper(), runCode()]);
  const failures: ParallelAnalysisError["failures"] = [];
  if (paperResult.status === "rejected") {
    failures.push({ role: "paper_analyst", message: errorMessage(paperResult.reason) });
  }
  if (codeResult.status === "rejected") {
    failures.push({ role: "code_analyst", message: errorMessage(codeResult.reason) });
  }
  if (failures.length > 0) {
    input.runStore.transitionRun(input.runId, input.signal?.aborted ? "cancelled" : "inconclusive");
    throw new ParallelAnalysisError("one or more analyst sessions failed", failures);
  }

  input.runStore.transitionRun(input.runId, "planning");
  return {
    paper: (paperResult as PromiseFulfilledResult<StructuredCompletion<PaperAnalysis>>).value,
    code: (codeResult as PromiseFulfilledResult<StructuredCompletion<CodeAnalysis>>).value,
  };
}
