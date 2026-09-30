import type { Claim, CodeMapping } from "@dejaml/contracts";
import type { RunStore } from "@dejaml/run-store";
import { z } from "zod";

import type { StructuredModelClient } from "./model.js";

export const LabPlanSchema = z.object({
  summary: z.string().min(1).max(600),
  entrypoint: z.string().max(300).nullable(),
  steps: z.array(z.string().min(1).max(300)).min(1).max(10),
  risks: z.array(z.string().min(1).max(300)).max(6),
});
export type LabPlan = z.infer<typeof LabPlanSchema>;

export const LabDiagnosisSchema = z.object({
  diagnosis: z.string().min(1).max(600),
  suggestedFix: z.string().min(1).max(1_200),
  reproducibleHere: z.boolean(),
});
export type LabDiagnosis = z.infer<typeof LabDiagnosisSchema>;

type TeamContext = {
  runId: string;
  agentName?: string;
  model: StructuredModelClient;
  store: RunStore;
  signal?: AbortSignal;
};

function sessionId(context: TeamContext, role: string): string {
  return `${context.runId}:${role}${context.agentName ? `:${context.agentName}` : ""}`;
}

function emit(context: TeamContext, type: string, summary: string, payload: Record<string, unknown>): void {
  context.store.appendEvent({
    runId: context.runId,
    actor: "lab_engineer",
    type,
    status: "progress",
    summary: summary.slice(0, 300),
    evidence: [],
    publicPayload: { ...(context.agentName ? { agent: context.agentName } : {}), ...payload },
  });
}

/**
 * The team's Planner reads the claim, the analysts' hints, and the first look
 * at the repository, and writes the plan the Engineer follows. It runs no
 * commands itself.
 */
export async function planLabWork(
  context: TeamContext & {
    claim: Claim;
    mapping: CodeMapping | null;
    repositoryListing: string;
    environment: Record<string, unknown>;
  },
): Promise<LabPlan> {
  const decision = await context.model.complete({
    sessionId: sessionId(context, "lab_planner"),
    role: "lab_planner",
    systemPrompt: [
      "You are the Planner on a DéjàML lab team. An Engineer will carry out your plan inside a sealed, offline Linux container.",
      "Write a short, concrete plan to reproduce the claim with the repository's own code: which entry point to use, how to load the data the repository ships, what small adapter to write, and how to write the metric to a JSON file under artifacts/.",
      "Nothing can be installed or downloaded. Name the risks that could make the claim unreproducible here. Return JSON only.",
    ].join("\n"),
    prompt: JSON.stringify({
      claim: context.claim,
      codeAnalystHints: context.mapping
        ? {
            entrypoint: context.mapping.entrypoint,
            relevantFiles: context.mapping.relevantFiles.map((file) => file.path),
            datasetReferences: context.mapping.datasetReferences,
            candidateCommand: context.mapping.candidateCommand,
            warnings: context.mapping.warnings,
          }
        : null,
      repositoryListing: context.repositoryListing.slice(0, 8_000),
      environment: context.environment,
    }),
    schema: LabPlanSchema,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  emit(context, "lab_plan", `Planner: ${decision.value.summary}`, { plan: decision.value });
  return decision.value;
}

/**
 * The team's Debugger reads one failed command with the Engineer's files and
 * recent steps, and proposes a fix. The Engineer decides whether to apply it.
 */
export async function diagnoseLabFailure(
  context: TeamContext & {
    claim: Claim;
    plan: LabPlan | null;
    failedCommand: string[];
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    files: Array<{ path: string; content: string }>;
    recentSteps: string[];
  },
): Promise<LabDiagnosis> {
  const decision = await context.model.complete({
    sessionId: sessionId(context, "lab_debugger"),
    role: "lab_debugger",
    systemPrompt: [
      "You are the Debugger on a DéjàML lab team. A command inside a sealed, offline Linux container failed.",
      "Find the root cause from the output and the Engineer's files, and propose the smallest fix that keeps the claimed setup.",
      "Nothing can be installed or downloaded; if the failure needs that, say reproducibleHere is false. Return JSON only.",
    ].join("\n"),
    prompt: JSON.stringify({
      claim: context.claim,
      plan: context.plan,
      failedCommand: context.failedCommand,
      exitCode: context.exitCode,
      timedOut: context.timedOut,
      stdout: context.stdout.slice(-4_000),
      stderr: context.stderr.slice(-6_000),
      engineerFiles: context.files.map((file) => ({ path: file.path, content: file.content.slice(0, 8_000) })),
      recentSteps: context.recentSteps,
    }),
    schema: LabDiagnosisSchema,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  emit(context, "lab_diagnosis", `Debugger: ${decision.value.diagnosis}`, { diagnosis: decision.value });
  return decision.value;
}
