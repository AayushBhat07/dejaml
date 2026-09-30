import type { ClaimContract, ResultStatus, RunStatus, TerminalStudyStage } from "@dejaml/contracts";
import { type Consensus, findConsensus } from "@dejaml/research-runtime";

import type { ParsedMetric } from "./metric.js";
import type { Review, Submission } from "./roles.js";

/**
 * The final status, computed from evidence. Agents propose; this code
 * decides. A measurement counts only when the approved official command ran
 * and exited 0, code parsed the metric from that run, an Independent Reviewer
 * approved it, and the independent engineers agree.
 */

export type OfficialRun = {
  receiptId: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutSha256: string;
};

export type EngineerOutcome = {
  engineerAgentId: string;
  label: string;
  agentStatus: string;
  agentReason: string | null;
  submission: Submission | null;
  official: OfficialRun | null;
  metric: ParsedMetric | null;
  /** The parsed value in the paper's unit. */
  value: number | null;
  review: Review | null;
  reviewerAgentId: string | null;
  dependencyRequest: { requirements: string[]; reason: string } | null;
};

export type StatusDecision = {
  status: ResultStatus;
  reasons: string[];
  consensus: Consensus | null;
  representative: EngineerOutcome | null;
  absoluteDifference: number | null;
  equivalence: "equivalent" | "minor_deviations" | null;
};

export function rejection(outcome: EngineerOutcome): string | null {
  if (!outcome.official)
    return `the approved command never ran (${outcome.agentStatus}${outcome.agentReason ? `: ${outcome.agentReason}` : ""})`;
  if (outcome.official.timedOut) return "the approved command timed out";
  if (outcome.official.exitCode !== 0) return `the approved command exited with ${String(outcome.official.exitCode)}`;
  if (!outcome.metric?.ok)
    return `the metric could not be parsed from the official run: ${outcome.metric && !outcome.metric.ok ? outcome.metric.reason : "not parsed"}`;
  if (outcome.value === null) return "the metric could not be converted to the paper's unit";
  if (!outcome.review) return "not reviewed";
  if (outcome.review.verdict !== "approve") return `rejected by the Independent Reviewer: ${outcome.review.summary}`;
  if (outcome.review.equivalence === "not_equivalent") return "the Independent Reviewer judged it not equivalent to the paper's method";
  return null;
}

export function decideStatus(input: {
  cancelled: boolean;
  /** An infrastructure fault that stopped the study (image, lab, storage). */
  failure: string | null;
  policyViolations: string[];
  /** Why the study stopped before measuring, when it did. */
  stopReasons: string[];
  contract: ClaimContract | null;
  adapter: boolean;
  outcomes: EngineerOutcome[];
  engineersLaunched: number;
}): StatusDecision {
  const reasons: string[] = [];
  const empty = (status: ResultStatus): StatusDecision => ({
    status,
    reasons,
    consensus: null,
    representative: null,
    absoluteDifference: null,
    equivalence: null,
  });
  if (input.cancelled) {
    reasons.push("the study was cancelled before it finished");
    return empty("cancelled");
  }
  if (input.failure) {
    reasons.push(input.failure);
    return empty("failed");
  }
  if (input.policyViolations.length) {
    reasons.push(...input.policyViolations.map((item) => `policy: ${item}`));
    return empty("policy_blocked");
  }
  if (!input.contract) {
    reasons.push(...(input.stopReasons.length ? input.stopReasons : ["no approved claim contract"]));
    return empty("inconclusive");
  }
  const contract = input.contract;
  const approved = input.outcomes.filter((outcome) => {
    const why = rejection(outcome);
    if (why) reasons.push(`${outcome.label}: ${why}`);
    return why === null;
  });
  if (approved.length === 0) {
    reasons.push(...input.stopReasons);
    if (input.engineersLaunched === 0) reasons.push("no engineer ran the approved command");
    return empty("inconclusive");
  }
  const launched = Math.max(input.engineersLaunched, approved.length);
  const required = launched === 1 ? 1 : Math.floor(launched / 2) + 1;
  const consensus = findConsensus(
    approved.map((outcome) => ({ agentName: outcome.label, value: outcome.value! })),
    contract.tolerance,
    required,
  );
  if (consensus.status !== "agreed") {
    reasons.push(
      consensus.status === "disagreed"
        ? `independent engineers disagree (spread ${String(consensus.spread)} ${contract.metric.unit})`
        : `only ${approved.length} of ${launched} engineers produced an approved measurement; ${required} must agree`,
    );
    return { status: "inconclusive", reasons, consensus, representative: null, absoluteDifference: null, equivalence: null };
  }
  const representative = approved.find((outcome) => outcome.label === consensus.representative)!;
  const group = approved.filter((outcome) => consensus.agreeing.includes(outcome.label));
  const deviations =
    input.adapter ||
    contract.environment.compatibilityConstraints.length > 0 ||
    group.some((outcome) => outcome.review?.equivalence !== "equivalent" || (outcome.submission?.deviations.length ?? 0) > 0);
  const equivalence = deviations ? "minor_deviations" : "equivalent";
  const absoluteDifference = Math.abs(representative.value! - contract.reportedValue);
  if (absoluteDifference > contract.tolerance + 1e-9) {
    reasons.push(
      `the measured value ${representative.value} differs from the paper's ${contract.reportedValue} by ${round(absoluteDifference)} ${contract.metric.unit} (tolerance ${contract.tolerance})`,
    );
    return { status: "not_reproduced", reasons, consensus, representative, absoluteDifference, equivalence };
  }
  if (deviations) {
    const why = [
      input.adapter ? "an adapter wraps the official code" : null,
      contract.environment.compatibilityConstraints.length ? "compatibility constraints changed package versions" : null,
      group.some((outcome) => (outcome.submission?.deviations.length ?? 0) > 0) ? "the engineer declared deviations" : null,
      group.some((outcome) => outcome.review?.equivalence === "minor_deviations") ? "the Reviewer found minor deviations" : null,
    ].filter(Boolean);
    reasons.push(`the value matches within tolerance, with deviations: ${why.join("; ")}`);
    return { status: "partially_reproduced", reasons, consensus, representative, absoluteDifference, equivalence };
  }
  reasons.push("the approved official command reproduced the paper's value within tolerance, reviewed as methodologically equivalent");
  return { status: "reproduced", reasons, consensus, representative, absoluteDifference, equivalence };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The Supervisor may only make the outcome more cautious, and only in these ways. */
const DOWNGRADES: Record<ResultStatus, readonly ResultStatus[]> = {
  reproduced: ["partially_reproduced", "inconclusive"],
  partially_reproduced: ["inconclusive"],
  not_reproduced: ["inconclusive"],
  inconclusive: [],
  policy_blocked: [],
  failed: [],
  cancelled: [],
};

export function applySupervisor(computed: ResultStatus, proposed: ResultStatus | null): { status: ResultStatus; overridden: boolean } {
  if (proposed && DOWNGRADES[computed].includes(proposed)) return { status: proposed, overridden: true };
  return { status: computed, overridden: false };
}

export function terminalStageFor(status: ResultStatus): TerminalStudyStage {
  switch (status) {
    case "reproduced":
    case "partially_reproduced":
    case "not_reproduced":
      return "completed";
    default:
      return status;
  }
}

export function runStatusFor(status: ResultStatus): Extract<RunStatus, "completed" | "inconclusive" | "failed" | "cancelled"> {
  switch (status) {
    case "reproduced":
    case "partially_reproduced":
    case "not_reproduced":
      return "completed";
    case "failed":
    case "cancelled":
      return status;
    default:
      return "inconclusive";
  }
}
