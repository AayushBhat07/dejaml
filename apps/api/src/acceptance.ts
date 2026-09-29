import type { CuratedCase } from "./cases.js";
import type { StudyReport } from "./pipeline.js";

export type AcceptanceCheck = { name: string; passed: boolean; detail: string };

/**
 * The demo acceptance test (ARCHITECTURE.md §15) applied to one finished
 * study report. `realRun` is false when the lab image is not the one the
 * caller expects, so a stand-in run can never pass as a real rehearsal.
 */
export function checkDemoAcceptance(
  report: StudyReport,
  curated: CuratedCase,
  options: { expectedImageId?: string } = {},
): { passed: boolean; realRun: boolean; checks: AcceptanceCheck[] } {
  const checks: AcceptanceCheck[] = [];
  const check = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };
  const { policy, manifest } = curated;
  const events = report.events;
  const attempt = report.lab?.attempt ?? null;
  const assessment = report.assessment;

  const found = events.find((event) => event.type === "repository_found");
  check(
    "repository_discovered",
    found?.publicPayload.repositoryUrl === policy.repository.url && found.evidence.some((item) => item.kind === "paper_page"),
    found ? `${String(found.publicPayload.repositoryUrl)} (${found.evidence.map((item) => item.reference).join(", ")})` : "no repository_found event",
  );
  const claim = report.plan?.claim;
  check(
    "claim_with_page_evidence",
    claim?.model === manifest.paper.claim.model && (claim?.evidence ?? []).some((item) => item.kind === "paper_page"),
    claim ? `${claim.model}, ${claim.metric.name} ${claim.metric.reportedValue}` : "no approved plan",
  );
  check(
    "commit_pinned",
    report.repository?.commitSha === policy.repository.commitSha,
    report.repository?.commitSha ?? "no repository acquired",
  );
  const labCreate = events.find((event) => event.type === "lab_create" && event.status === "completed");
  check(
    "isolated_experiment",
    attempt?.exitCode === 0 &&
      !attempt.timedOut &&
      !attempt.cancelled &&
      labCreate?.publicPayload.network === "none" &&
      labCreate.publicPayload.readOnlyRoot === true,
    attempt ? `exit ${String(attempt.exitCode)}, image ${report.lab?.imageId ?? "unknown"}` : "no attempt",
  );
  check(
    "metric_parsed",
    report.metric !== null && Number.isFinite(report.metric.value),
    report.metric ? `${report.metric.name} = ${report.metric.value} (${report.metric.extractionRule})` : "no metric",
  );
  check(
    "comparison",
    assessment !== null && assessment.comparable && assessment.verdict !== "inconclusive",
    assessment ? `${assessment.verdict}, difference ${String(assessment.signedDifference)}` : "no assessment",
  );
  check(
    "seed_finding",
    (assessment?.discrepancyHypotheses ?? []).some((text) => /seed/iu.test(text)),
    `${assessment?.discrepancyHypotheses.length ?? 0} hypotheses`,
  );
  check(
    "cleanup_receipt",
    report.lab?.cleanup?.verifiedAbsent === true && report.lab.cleanup.artifactDirectoryRemoved,
    report.lab?.cleanup ? `container removed ${String(report.lab.cleanup.containerRemoved)}` : "no receipt",
  );
  check(
    "report_complete",
    report.status === "completed" && events.at(-1)?.type === "run_finished",
    `status ${report.status}, ${events.length} events`,
  );
  const baseline = manifest.comparison.rehearsalBaseline;
  if (baseline) {
    check(
      "matches_rehearsal_baseline",
      assessment?.observedValue === baseline.observedValue && assessment.verdict === baseline.verdict,
      `expected ${baseline.observedValue} ${baseline.verdict}, got ${String(assessment?.observedValue ?? null)} ${assessment?.verdict ?? "none"}`,
    );
  }
  const realRun = options.expectedImageId !== undefined && report.lab?.imageId === options.expectedImageId;
  return { passed: checks.every((item) => item.passed), realRun, checks };
}
