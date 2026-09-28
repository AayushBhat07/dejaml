import {
  LeadResearchDecisionSchema,
  type CodeAnalysis,
  type ExperimentPolicy,
  type LeadResearchDecision,
  type PaperAnalysis,
  type PlanPolicyResult,
} from "@dejaml/contracts";
import { type RunStore } from "@dejaml/run-store";

import { type StructuredCompletion, type StructuredModelClient } from "./model.js";
import { evaluateExperimentPlan } from "./policy.js";
import { buildLeadResearcherPrompt } from "./prompts.js";

export type LeadResearchResult = {
  decision: StructuredCompletion<LeadResearchDecision>;
  policy: PlanPolicyResult | null;
};

function failureSummary(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("cancel")) return "Lead Researcher reconciliation was cancelled.";
  if (message.includes("timeout") || message.includes("deadline")) {
    return "Lead Researcher reconciliation exceeded its time limit.";
  }
  if (message.includes("json") || message.includes("schema") || message.includes("validation")) {
    return "Lead Researcher returned an invalid structured result.";
  }
  return "Lead Researcher reconciliation could not be completed by the configured model runtime.";
}

export async function runLeadResearch(input: {
  runId: string;
  runStore: RunStore;
  paperAnalysis: PaperAnalysis;
  codeAnalysis: CodeAnalysis;
  policy: ExperimentPolicy;
  modelClient: StructuredModelClient;
  signal?: AbortSignal;
}): Promise<LeadResearchResult> {
  input.runStore.appendEvent({
    runId: input.runId,
    actor: "lead_researcher",
    type: "reconciliation_started",
    status: "started",
    summary: "Lead Researcher is reconciling the paper claim and repository mapping.",
    evidence: [],
    publicPayload: {},
  });

  try {
    const prompt = buildLeadResearcherPrompt(input);
    const decision = await input.modelClient.complete({
      sessionId: `${input.runId}:lead_researcher`,
      role: "lead_researcher",
      systemPrompt: prompt.systemPrompt,
      prompt: prompt.prompt,
      schema: LeadResearchDecisionSchema,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.runStore.appendEvent({
      runId: input.runId,
      actor: "lead_researcher",
      type: "reconciliation_completed",
      status: decision.value.status === "ready" ? "completed" : "warning",
      summary: decision.value.summary,
      evidence: decision.value.plan?.claim.evidence ?? [],
      publicPayload: { decision: decision.value },
    });
    if (decision.value.status === "inconclusive" || !decision.value.plan) {
      input.runStore.transitionRun(input.runId, "inconclusive");
      return { decision, policy: null };
    }

    input.runStore.transitionRun(input.runId, "validating_plan");
    input.runStore.appendEvent({
      runId: input.runId,
      actor: "system",
      type: "plan_policy_started",
      status: "started",
      summary: "Deterministic policy is checking the proposed experiment plan.",
      evidence: [],
      publicPayload: { caseId: input.policy.caseId },
    });
    const policy = evaluateExperimentPlan({
      plan: decision.value.plan,
      policy: input.policy,
      paperAnalysis: input.paperAnalysis,
      codeAnalysis: input.codeAnalysis,
    });
    input.runStore.appendEvent({
      runId: input.runId,
      actor: "system",
      type: "plan_policy_completed",
      status: policy.approved ? "completed" : "failed",
      summary: policy.approved
        ? "Experiment plan passed every deterministic policy check."
        : "Experiment plan was rejected by deterministic policy.",
      evidence: [],
      publicPayload: { policy },
    });
    input.runStore.transitionRun(input.runId, policy.approved ? "preparing_lab" : "inconclusive");
    return { decision, policy };
  } catch (error) {
    input.runStore.appendEvent({
      runId: input.runId,
      actor: "lead_researcher",
      type: "reconciliation_failed",
      status: "failed",
      summary: failureSummary(error),
      evidence: [],
      publicPayload: {},
    });
    input.runStore.transitionRun(input.runId, "inconclusive");
    throw error;
  }
}
