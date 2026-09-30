import { z } from "zod";

import type { ExperimentPlan } from "@dejaml/contracts";
import type { AttemptOutcome, LabManager, LabSpec } from "@dejaml/lab-manager";
import type { RunStore } from "@dejaml/run-store";

import type { StructuredModelClient } from "./model.js";

const LabDecisionSchema = z.object({
  action: z.enum(["request_lab", "run_approved_experiment", "inspect_result", "finish"]),
  summary: z.string().min(1).max(240),
});

export type LabAgentResult = {
  labId: string;
  outcome: AttemptOutcome;
  metricArtifact: Buffer | null;
  imageId: string;
};

/**
 * A bounded tool loop. The model chooses the next action after each tool
 * observation; the trusted host owns Docker and all arguments. Only the
 * policy-approved plan can be run. No model output becomes a shell command.
 */
export async function runLabAgent(input: {
  runId: string;
  plan: ExperimentPlan;
  spec: LabSpec;
  labs: Pick<LabManager, "createLab" | "prepareLab" | "executeAttempt" | "readArtifact" | "destroyLab">;
  model: StructuredModelClient;
  store: RunStore;
  signal?: AbortSignal;
  onLabCreated?: (labId: string) => void;
  onLabDestroyed?: () => void;
}): Promise<LabAgentResult> {
  let labId: string | null = null;
  let imageId: string | null = null;
  let outcome: AttemptOutcome | null = null;
  let metricArtifact: Buffer | null = null;
  let inspected = false;
  let finished = false;
  let observation = {
    state: "not_created",
    allowedActions: ["request_lab"],
    approvedCommand: input.plan.command,
    resourceBudget: input.plan.resources,
  } as Record<string, unknown>;

  const event = (type: string, summary: string, payload: Record<string, unknown> = {}): void => {
    input.store.appendEvent({
      runId: input.runId,
      actor: "lab_engineer",
      type,
      status: "progress",
      summary,
      evidence: [],
      publicPayload: payload,
    });
  };

  try {
    for (let step = 0; step < 6; step += 1) {
      if (input.signal?.aborted) throw new Error("lab agent cancelled");
      const decision = await input.model.complete({
        sessionId: `${input.runId}:lab_agent`,
        role: "lab_agent",
        systemPrompt:
          "You operate an approved research lab through the listed tools. Return one JSON action and a short public summary. " +
          "Choose only from allowedActions. You cannot change the approved command or resources. " +
          "After a run, inspect the result before finishing. Never claim a metric that is absent from the observation.",
        prompt: JSON.stringify(observation),
        schema: LabDecisionSchema,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const { action, summary } = decision.value;
      const allowed = observation.allowedActions as string[];
      if (!allowed.includes(action)) {
        event("lab_agent_rejected", "Lab Agent requested an action outside the current state", { action });
        throw new Error(`Lab Agent action ${action} is not allowed after ${String(observation.state)}`);
      }
      event("lab_agent_action", summary, { action });

      if (action === "request_lab") {
        const handle = await input.labs.createLab(input.spec);
        labId = handle.labId;
        imageId = handle.imageId;
        input.onLabCreated?.(labId);
        const preparation = await input.labs.prepareLab(labId, input.plan.preparation);
        if (preparation.some((record) => record.exitCode !== null && record.exitCode !== 0)) {
          throw new Error("approved lab preparation failed");
        }
        observation = {
          state: "ready",
          allowedActions: ["run_approved_experiment"],
          labId,
          preparation: preparation.map((record) => ({ kind: record.step.kind, exitCode: record.exitCode })),
          approvedCommand: input.plan.command,
        };
      } else if (action === "run_approved_experiment") {
        if (!labId) throw new Error("lab was not created");
        input.store.transitionRun(input.runId, "running");
        outcome = await input.labs.executeAttempt(labId, {
          number: 1,
          label: "baseline",
          command: input.plan.command,
          observe: true,
        });
        observation = {
          state: "attempt_completed",
          allowedActions: ["inspect_result"],
          exitCode: outcome.attempt.exitCode,
          timedOut: outcome.attempt.timedOut,
          cancelled: outcome.attempt.cancelled,
          stdout: outcome.stdout.text.slice(-8_000),
          stderr: outcome.stderr.text.slice(-8_000),
          artifacts: outcome.artifacts,
        };
      } else if (action === "inspect_result") {
        if (!labId || !outcome) throw new Error("no attempt to inspect");
        const path = input.plan.metricExtraction.path;
        if (path && outcome.attempt.artifactDigests[path]) {
          metricArtifact = (await input.labs.readArtifact(labId, path)).content;
        }
        inspected = true;
        observation = {
          state: "inspected",
          allowedActions: ["finish"],
          exitCode: outcome.attempt.exitCode,
          metricArtifactPath: path ?? null,
          metricArtifactPresent: metricArtifact !== null,
          metricArtifactPreview: metricArtifact?.toString("utf8").slice(0, 4_000) ?? null,
          stdout: outcome.stdout.text.slice(-4_000),
          stderr: outcome.stderr.text.slice(-4_000),
        };
      } else {
        if (!inspected || !outcome) throw new Error("Lab Agent cannot finish before inspecting an attempt");
        event("lab_agent_finished", summary, { attemptId: outcome.attempt.id });
        finished = true;
        break;
      }
    }
    if (!finished || !inspected || !outcome) throw new Error("Lab Agent exceeded its six-step budget");
  } finally {
    if (labId && !finished) {
      await input.labs.destroyLab(labId, "lab agent stopped");
      input.onLabDestroyed?.();
    }
  }
  if (!labId || !outcome || !imageId) throw new Error("Lab Agent finished without an attempt");
  return { labId, outcome, metricArtifact, imageId };
}
