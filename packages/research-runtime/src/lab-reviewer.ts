import type { Claim } from "@dejaml/contracts";
import type { RunStore } from "@dejaml/run-store";
import { z } from "zod";

import type { AutonomousLabResult } from "./autonomous-lab-agent.js";
import type { StructuredModelClient } from "./model.js";

export const LabReviewSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  summary: z.string().min(1).max(600),
  concerns: z.array(z.string().min(1).max(300)).max(10),
});
export type LabReview = z.infer<typeof LabReviewSchema>;

const MAX_FILE_CHARS = 16_000;

/**
 * An independent reviewer reads what one Lab Agent did (its files, its
 * commands, and the metric file) and decides whether the metric was computed
 * honestly on the claimed setup. It never sees other replicas' work.
 */
export async function reviewLabSubmission(input: {
  runId: string;
  agentName: string;
  claim: Claim;
  session: AutonomousLabResult;
  model: StructuredModelClient;
  store: RunStore;
  signal?: AbortSignal;
}): Promise<LabReview> {
  const { session } = input;
  const evidence = {
    claim: input.claim,
    submission: session.submission,
    producingCommand: session.attempt?.command ?? null,
    metricFile: session.artifact
      ? { path: session.artifact.path, content: session.artifact.content.toString("utf8").slice(0, 4_000) }
      : null,
    producingStdoutTail: session.stdout.slice(-4_000),
    agentFiles: session.files.map((file) => ({
      path: file.path,
      content: file.content.length > MAX_FILE_CHARS ? `${file.content.slice(0, MAX_FILE_CHARS)}\n…[truncated]` : file.content,
    })),
    steps: session.transcript.map((entry) => ({
      step: entry.step,
      action: entry.action?.tool === "write_file" ? { tool: "write_file", path: entry.action.path } : entry.action,
      exitCode: entry.observation.exitCode ?? null,
    })),
  };
  const decision = await input.model.complete({
    sessionId: `${input.runId}:lab_reviewer:${input.agentName}`,
    role: "lab_reviewer",
    systemPrompt: [
      "You are DéjàML's Lab Reviewer. A Lab Agent worked alone in a sealed container to reproduce a paper claim.",
      "Decide whether its submitted metric can be trusted. Approve only if all hold:",
      "- the metric is computed by running the repository's model or method, not written in, copied, or derived from the paper's number;",
      "- the data, split, and metric match the claim, or any change is stated and minor;",
      "- the metric file comes from the producing command shown.",
      "Reject with specific concerns otherwise. Return JSON only.",
    ].join("\n"),
    prompt: JSON.stringify(evidence),
    schema: LabReviewSchema,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const review = decision.value;
  input.store.appendEvent({
    runId: input.runId,
    actor: "lab_reviewer",
    type: "lab_review_completed",
    status: review.verdict === "approve" ? "completed" : "warning",
    summary: `${review.verdict === "approve" ? "Approved" : "Rejected"} ${input.agentName}: ${review.summary}`.slice(0, 300),
    evidence: [],
    publicPayload: { agent: input.agentName, review },
  });
  return review;
}

export type ReplicaValue = { agentName: string; value: number };

export type Consensus = {
  status: "agreed" | "disagreed" | "insufficient";
  /** Replicas whose values fall within the tolerance of each other. */
  agreeing: string[];
  values: ReplicaValue[];
  spread: number | null;
  tolerance: number;
  required: number;
  /** The replica whose value is the median of the agreeing group. */
  representative: string | null;
};

/**
 * Finds the largest group of replica values that lie within `tolerance` of
 * each other. At least `required` replicas must agree for a verdict.
 */
export function findConsensus(values: ReplicaValue[], tolerance: number, required: number): Consensus {
  const sorted = [...values].sort((left, right) => left.value - right.value);
  let best: ReplicaValue[] = [];
  for (let start = 0; start < sorted.length; start += 1) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1]!.value - sorted[start]!.value <= tolerance + 1e-9) end += 1;
    const group = sorted.slice(start, end + 1);
    if (group.length > best.length) best = group;
  }
  const spread = sorted.length > 0 ? sorted.at(-1)!.value - sorted[0]!.value : null;
  const agreed = best.length >= required;
  return {
    status: values.length < required ? "insufficient" : agreed ? "agreed" : "disagreed",
    agreeing: agreed ? best.map((item) => item.agentName) : [],
    values,
    spread: spread === null ? null : Math.round(spread * 1e6) / 1e6,
    tolerance,
    required,
    representative: agreed ? best[Math.floor((best.length - 1) / 2)]!.agentName : null,
  };
}
