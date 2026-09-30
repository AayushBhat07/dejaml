import type { Claim, ResultStatus, RunStatus } from "@dejaml/contracts";
import { type Consensus, findConsensus, findLiteral } from "@dejaml/research-runtime";

import type { CommandRecord, EngineerLab, ExportedArtifact } from "./context.js";
import type { Plan, Review, Submission } from "./roles.js";

/**
 * Deterministic checks and the final status. Agents propose; this code
 * decides. A measurement counts only when its provenance holds, an
 * Independent Reviewer approved it as methodologically equivalent (or with
 * minor, declared deviations), and enough independent engineers agree.
 */

export const TOLERANCE = { percent: 2, fraction: 0.02, score: 0.02 } as const;

export type Provenance = { ok: boolean; problems: string[]; warnings: string[] };

export type EngineerOutcome = {
  engineerAgentId: string;
  label: string;
  agentStatus: string;
  agentReason: string | null;
  submission: Submission | null;
  provenance: Provenance;
  metricArtifact: ExportedArtifact | null;
  producingCommand: CommandRecord | null;
  /** Raw value read from the metric file, in the submission's unit. */
  rawValue: number | null;
  /** The value in the claim's unit, set by the verifier. */
  value: number | null;
  review: Review | null;
  reviewerAgentId: string | null;
};

export function readDotPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current) && /^\d+$/u.test(part) ? current[Number(part)] : (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Checks that a submitted number came from a real run in the engineer's lab:
 * the producing command exists, succeeded, and wrote the metric file with the
 * exported digest; the number is not typed into the command or into a file
 * the engineer wrote; and every file the producing command names is declared.
 */
export function checkProvenance(input: {
  submission: Submission;
  lab: EngineerLab;
  exported: ExportedArtifact[];
}): Provenance & { artifact: ExportedArtifact | null; command: CommandRecord | null; rawValue: number | null } {
  const { submission, lab } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  const none = { artifact: null, command: null, rawValue: null };
  if (submission.status !== "measured") return { ok: false, problems: ["the engineer did not measure the claim"], warnings, ...none };
  if (!submission.metricFile || !submission.metricKey || !submission.unit || !submission.producingReceiptId) {
    return { ok: false, problems: ["a measured submission must name the metric file, key, unit, and producing receipt"], warnings, ...none };
  }
  if (!submission.officialCodeRan) problems.push("the engineer reports that the official code did not run");
  const command = lab.commands.find((item) => item.receiptId === submission.producingReceiptId) ?? null;
  if (!command) problems.push(`receipt ${submission.producingReceiptId} is not a command this engineer ran`);
  else if (command.exitCode !== 0 || command.timedOut) problems.push(`the producing command exited with ${String(command.exitCode)}`);
  const artifact = input.exported.find((item) => item.path === submission.metricFile) ?? null;
  if (!artifact) problems.push(`${submission.metricFile} was not found among the exported artifacts`);
  if (command && artifact) {
    const produced = command.artifacts.find((item) => item.path === artifact.path);
    if (!produced) problems.push(`the producing command did not write ${artifact.path}`);
    else if (produced.sha256 !== artifact.sha256) problems.push(`${artifact.path} changed after the producing command`);
  }
  let rawValue: number | null = null;
  if (artifact?.text) {
    try {
      const parsed = readDotPath(JSON.parse(artifact.text), submission.metricKey);
      if (typeof parsed === "number" && Number.isFinite(parsed)) rawValue = parsed;
      else problems.push(`${submission.metricKey} in ${artifact.path} is not a finite number`);
    } catch {
      problems.push(`${artifact.path} is not valid JSON`);
    }
  } else if (artifact) {
    problems.push(`${artifact.path} is not a text file`);
  }
  if (rawValue !== null && command) {
    const texts = [command.argv.join(" "), ...[...lab.written.values()].map((file) => file.content)];
    const literal = findLiteral(rawValue, texts);
    if (literal) problems.push(`the value ${literal} appears literally in the producing command or in a file the engineer wrote`);
  }
  const declared = new Set(submission.adapters.map((adapter) => adapter.path));
  const undeclared = [...lab.written.keys()].filter((path) => !declared.has(path) && !declared.has(path.replace(/^work\//u, "")));
  if (command) {
    const named = undeclared.filter((path) => command.argv.some((arg) => arg.includes(path.replace(/^work\//u, ""))));
    if (named.length) problems.push(`the producing command uses undeclared files: ${named.join(", ")}`);
  }
  if (undeclared.length) warnings.push(`files written but not declared as adapters: ${undeclared.join(", ")}`);
  for (const adapter of submission.adapters) {
    if (!lab.written.has(adapter.path) && !lab.written.has(`work/${adapter.path}`)) {
      warnings.push(`adapter ${adapter.path} was declared but not written with lab_write_file`);
    }
  }
  return { ok: problems.length === 0, problems, warnings, artifact, command, rawValue };
}

export type StatusDecision = {
  status: ResultStatus;
  reasons: string[];
  consensus: Consensus | null;
  representative: EngineerOutcome | null;
  equivalence: "equivalent" | "minor_deviations" | null;
};

export function decideStatus(input: {
  claim: Claim | null;
  plan: Plan | null;
  outcomes: EngineerOutcome[];
  engineersLaunched: number;
  policyBlocks: string[];
  /** Filled by the caller from the verifier for the representative. */
  compare: (outcome: EngineerOutcome) => { within: boolean; absoluteDifference: number | null } | null;
}): StatusDecision {
  const reasons: string[] = [];
  const empty = (status: ResultStatus): StatusDecision => ({ status, reasons, consensus: null, representative: null, equivalence: null });
  if (!input.claim) {
    reasons.push("no testable claim was selected from the paper");
    return empty(input.policyBlocks.length ? "policy_blocked" : "inconclusive");
  }
  const tolerance = TOLERANCE[input.claim.metric.unit];
  const approved = input.outcomes.filter((outcome) => {
    const why = rejection(outcome);
    if (why) reasons.push(`${outcome.label}: ${why}`);
    return why === null;
  });
  if (approved.length === 0) {
    if (input.policyBlocks.length) {
      reasons.push(...input.policyBlocks.map((block) => `policy: ${block}`));
      return empty("policy_blocked");
    }
    if (input.plan && input.plan.status !== "ready") reasons.push(`the plan is ${input.plan.status}: ${input.plan.blockedReason ?? input.plan.summary}`);
    if (input.engineersLaunched === 0) reasons.push("no engineer ran the official code");
    return empty("inconclusive");
  }
  const launched = Math.max(input.engineersLaunched, approved.length);
  const required = launched === 1 ? 1 : Math.floor(launched / 2) + 1;
  const consensus = findConsensus(approved.map((outcome) => ({ agentName: outcome.label, value: outcome.value! })), tolerance, required);
  if (consensus.status !== "agreed") {
    reasons.push(
      consensus.status === "disagreed"
        ? `independent engineers disagree (spread ${String(consensus.spread)} ${input.claim.metric.unit})`
        : `only ${approved.length} of ${launched} engineers produced an approved measurement; ${required} must agree`,
    );
    return { status: "inconclusive", reasons, consensus, representative: null, equivalence: null };
  }
  const representative = approved.find((outcome) => outcome.label === consensus.representative)!;
  const group = approved.filter((outcome) => consensus.agreeing.includes(outcome.label));
  const deviations =
    group.some((outcome) => outcome.review?.equivalence !== "equivalent") ||
    group.some((outcome) => (outcome.submission?.adapters.length ?? 0) > 0 || (outcome.submission?.deviations.length ?? 0) > 0) ||
    (input.plan?.environment.deviations.length ?? 0) > 0;
  const equivalence = deviations ? "minor_deviations" : "equivalent";
  const comparison = input.compare(representative);
  if (!comparison) {
    reasons.push("the verifier could not compare the representative measurement with the paper");
    return { status: "inconclusive", reasons, consensus, representative, equivalence };
  }
  if (!comparison.within) {
    reasons.push(`the agreed value differs from the paper by ${String(comparison.absoluteDifference)} ${input.claim.metric.unit} (tolerance ${tolerance})`);
    return { status: "not_reproduced", reasons, consensus, representative, equivalence };
  }
  if (equivalence === "minor_deviations") {
    reasons.push("the value matches within tolerance, with declared deviations (library versions, adapters, or paths)");
    return { status: "partially_reproduced", reasons, consensus, representative, equivalence };
  }
  reasons.push("independent engineers agree and the value matches the paper within tolerance, with no methodological changes");
  return { status: "reproduced", reasons, consensus, representative, equivalence };
}

function rejection(outcome: EngineerOutcome): string | null {
  if (!outcome.submission) return `no submission (${outcome.agentStatus}${outcome.agentReason ? `: ${outcome.agentReason}` : ""})`;
  if (outcome.submission.status !== "measured") return `not measured: ${outcome.submission.failureReason ?? outcome.submission.summary}`;
  if (!outcome.provenance.ok) return `provenance failed: ${outcome.provenance.problems.join("; ")}`;
  if (outcome.submission.adapters.some((adapter) => adapter.changesEvidenceEquivalence)) return "an adapter changes the evidence (declared by the engineer)";
  if (!outcome.review) return "not reviewed";
  if (outcome.review.verdict !== "approve") return `rejected by the Independent Reviewer: ${outcome.review.summary}`;
  if (outcome.review.equivalence === "not_equivalent") return "the Independent Reviewer judged it not equivalent to the paper's method";
  if (outcome.value === null) return "the verifier could not read the value in the claim's unit";
  return null;
}

/** The Supervisor may only make the outcome more cautious. */
const DOWNGRADES: Record<ResultStatus, readonly ResultStatus[]> = {
  reproduced: ["partially_reproduced", "inconclusive"],
  partially_reproduced: ["inconclusive"],
  not_reproduced: ["inconclusive"],
  inconclusive: [],
  policy_blocked: [],
};

export function applySupervisor(mechanical: ResultStatus, proposed: ResultStatus | null): { status: ResultStatus; overridden: boolean } {
  if (proposed && DOWNGRADES[mechanical].includes(proposed)) return { status: proposed, overridden: true };
  return { status: mechanical, overridden: false };
}

export function runStatusFor(status: ResultStatus): Extract<RunStatus, "completed" | "inconclusive"> {
  return status === "inconclusive" || status === "policy_blocked" ? "inconclusive" : "completed";
}
