import {
  AuditDecisionSchema,
  type Assessment,
  type AuditDecision,
  type ExperimentPlan,
  type Metric,
  type PaperAnalysis,
} from "@dejaml/contracts";
import { type RunStore } from "@dejaml/run-store";

import { type StructuredCompletion, type StructuredModelClient } from "./model.js";
import { buildAuditAgentPrompt } from "./prompts.js";

export type AuditResult = {
  decision: StructuredCompletion<AuditDecision>;
};

function failureSummary(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("cancel")) return "Audit Agent verification was cancelled.";
  if (message.includes("timeout") || message.includes("deadline")) {
    return "Audit Agent verification exceeded its time limit.";
  }
  if (message.includes("json") || message.includes("schema") || message.includes("validation")) {
    return "Audit Agent returned an invalid structured result.";
  }
  return "Audit Agent verification could not be completed by the configured model runtime.";
}

export async function runAudit(input: {
  runId: string;
  runStore: RunStore;
  paperAnalysis: PaperAnalysis;
  metric: Metric;
  assessment: Assessment;
  plan: ExperimentPlan;
  modelClient: StructuredModelClient;
  signal?: AbortSignal;
}): Promise<AuditResult> {
  input.runStore.appendEvent({
    runId: input.runId,
    actor: "audit_agent",
    type: "audit_started",
    status: "started",
    summary: "Audit Agent is semantically verifying the measured metric against the paper claim.",
    evidence: [],
    publicPayload: {},
  });

  try {
    const prompt = buildAuditAgentPrompt({
      paperAnalysis: input.paperAnalysis,
      metric: input.metric,
      assessment: input.assessment,
      paperClaimedValue: input.plan.claim.metric.reportedValue,
      paperClaimedUnit: input.plan.claim.metric.unit,
    });
    const decision = await input.modelClient.complete({
      sessionId: `${input.runId}:audit_agent`,
      role: "audit_agent",
      systemPrompt: prompt.systemPrompt,
      prompt: prompt.prompt,
      schema: AuditDecisionSchema,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.runStore.appendEvent({
      runId: input.runId,
      actor: "audit_agent",
      type: "audit_completed",
      status: decision.value.verdict === "disputed" ? "warning" : "completed",
      summary: decision.value.summary,
      evidence: decision.value.evidence,
      publicPayload: { audit: decision.value },
    });
    return { decision };
  } catch (error) {
    input.runStore.appendEvent({
      runId: input.runId,
      actor: "audit_agent",
      type: "audit_failed",
      status: "failed",
      summary: failureSummary(error),
      evidence: [],
      publicPayload: {},
    });
    throw error;
  }
}
