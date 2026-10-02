import { Badge, type Tone } from "../Badge";
import { equivalenceLabel, type AgentCard, type CleanupSummary, type LabCard, type RunView } from "../../lib/live-run";
import type { ReportMetric, ReportSummary } from "../../lib/run-client";
import { formatMetricValue } from "./format";

const RESULTS: Record<string, { label: string; tone: Tone; explanation: string }> = {
  reproduced: {
    label: "Reproduced",
    tone: "positive",
    explanation: "Independent engineers agree, reviewers approved, and nothing in the method was changed.",
  },
  partially_reproduced: {
    label: "Partially reproduced",
    tone: "accent",
    explanation: "The number matches, with declared deviations such as newer library versions or a wrapper script.",
  },
  not_reproduced: {
    label: "Not reproduced",
    tone: "warning",
    explanation: "A faithful run was agreed and reviewed, and it lands outside the tolerance.",
  },
  inconclusive: { label: "Inconclusive", tone: "neutral", explanation: "The evidence does not support a verdict either way." },
  policy_blocked: {
    label: "Policy blocked",
    tone: "negative",
    explanation: "A safety policy stopped the study before it could measure the claim.",
  },
  failed: {
    label: "Failed",
    tone: "negative",
    explanation: "The study's infrastructure failed, so nothing about the paper was concluded.",
  },
  cancelled: { label: "Cancelled", tone: "neutral", explanation: "The study was cancelled; its agents and labs were stopped and removed." },
  // Older recordings decide with the Result Verifier's verdict.
  reproduced_within_tolerance: {
    label: "Reproduced within tolerance",
    tone: "positive",
    explanation: "The rerun landed within the case's tolerance of the published number.",
  },
  different_result: {
    label: "Different result",
    tone: "warning",
    explanation: "The rerun is comparable with the paper but lands outside the case's tolerance.",
  },
};

const REVIEW_VERDICTS: Record<string, { label: string; tone: Tone }> = {
  approve: { label: "Approved", tone: "positive" },
  reject: { label: "Rejected", tone: "negative" },
};

function Stat({ label, value, unit, testId }: { label: string; value: string; unit?: string; testId: string }) {
  return (
    <div className="stat">
      <span className="muted small">{label}</span>
      <span className="stat-value" data-testid={testId}>
        {value}
        {unit ? <span className="stat-unit"> {unit}</span> : null}
      </span>
    </div>
  );
}

function SummarySignal({ label, value, tone }: { label: string; value: string; tone: "positive" | "warning" | "negative" | "neutral" }) {
  return (
    <div className="summary-signal" data-tone={tone}>
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function metricLabel(value: string | null): string {
  if (!value) return "Primary metric";
  return value.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

function MetricRow({ metric }: { metric: ReportMetric }) {
  const difference = metric.signedDifference;
  const status =
    metric.status === "within_tolerance"
      ? { label: "Within tolerance", tone: "positive" as Tone }
      : metric.status === "outside_tolerance"
        ? { label: "Outside tolerance", tone: "warning" as Tone }
        : metric.status === "sealed"
          ? { label: "Sealed", tone: "neutral" as Tone }
          : { label: "Not measured", tone: "neutral" as Tone };
  return (
    <li className="metric-row" data-testid={`metric-row-${metric.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`}>
      <div className="metric-row-name">
        <strong>{metricLabel(metric.name)}</strong>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <dl className="metric-row-values">
        <div>
          <dt>Paper</dt>
          <dd>{formatMetricValue(metric.paperValue, metric.unit)}</dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd>{formatMetricValue(metric.observedValue, metric.unit)}</dd>
        </div>
        <div>
          <dt>Difference</dt>
          <dd>{difference === null ? "–" : `${difference > 0 ? "+" : ""}${Math.round(difference * 10_000) / 10_000}`}</dd>
        </div>
        <div>
          <dt>Tolerance</dt>
          <dd>{metric.tolerance === null ? "–" : `±${metric.tolerance}`}</dd>
        </div>
      </dl>
    </li>
  );
}

function CleanupLine({ cleanup, labs }: { cleanup: CleanupSummary | null; labs: readonly LabCard[] }) {
  if (cleanup) {
    const items = [
      `${cleanup.labsRemoved} of ${cleanup.labsTotal} lab${cleanup.labsTotal === 1 ? "" : "s"} verified absent`,
      cleanup.dependenciesRemoved === null ? null : cleanup.dependenciesRemoved ? "prepared wheels removed" : "prepared wheels NOT removed",
      cleanup.datasetsRemoved === null ? null : cleanup.datasetsRemoved ? "datasets removed" : "datasets NOT removed",
      cleanup.workDirRemoved === null ? null : cleanup.workDirRemoved ? "work directory removed" : "work directory NOT removed",
      cleanup.leftovers > 0 ? `${cleanup.leftovers} leftover container(s) or network(s)` : "no leftover containers or networks",
      cleanup.liveAgents > 0 ? `${cleanup.liveAgents} agent(s) still running` : "no agent still running",
    ].filter((item): item is string => item !== null);
    return (
      <div className="stack-tight" data-testid="cleanup-verification">
        <p className="small">
          <Badge tone={cleanup.verified ? "positive" : "negative"}>{cleanup.verified ? "Cleanup verified" : "Cleanup not verified"}</Badge>{" "}
          {cleanup.summary}
        </p>
        <ul className="scope-list small">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    );
  }
  const cleaned = labs.filter((lab) => lab.cleanup);
  if (cleaned.length === 0) return <Badge tone="neutral">Cleanup pending</Badge>;
  const clean = cleaned.every((lab) => lab.cleanup?.clean);
  return (
    <p className="small" data-testid="cleanup-verification">
      <Badge tone={clean ? "positive" : "negative"}>{clean ? "Lab removed" : "Cleanup failed"}</Badge> {cleaned.at(-1)?.cleanup?.summary}
    </p>
  );
}

export function Completion({
  view,
  report,
  reportHref,
  onDownload,
  onNewStudy,
  reviewers,
}: {
  view: RunView;
  report: ReportSummary | null;
  reportHref: string | null;
  onDownload: () => void;
  onNewStudy?: (() => void) | undefined;
  reviewers: readonly AgentCard[];
}) {
  const statusKey = view.result?.status ?? report?.verdict ?? view.verdict ?? null;
  const result = statusKey
    ? (RESULTS[statusKey] ?? { label: statusKey.replaceAll("_", " "), tone: "neutral" as Tone, explanation: "" })
    : null;
  const { reveal, comparison, observation } = view.blinding;
  // The paper value comes only from the reveal event, or from a report that says the target was revealed.
  const revealedReport = report?.revealed === true ? report : null;
  const unit = reveal?.metric?.unit ?? report?.unit ?? observation?.metric?.unit ?? (view.claim?.unit || null);
  const paperValue = reveal?.reportedValue ?? revealedReport?.paperValue ?? null;
  const lockedObserved = observation?.observed.find((item) => item.value !== null)?.value ?? null;
  const observed = report?.observedValue ?? comparison?.observed ?? lockedObserved;
  const delta =
    paperValue === null
      ? null
      : (revealedReport?.signedDifference ?? (observed !== null ? Math.round((observed - paperValue) * 1e6) / 1e6 : null));
  const tolerance = reveal?.tolerance ?? revealedReport?.tolerance ?? null;
  const sealed = paperValue === null && view.blinding.sealed !== null;
  const unitWord = unit === "percent" ? "points" : "";
  const metricName = metricLabel(reveal?.metric?.name ?? observation?.metric?.name ?? view.claim?.metric ?? null);
  const additionalMetrics = report?.metrics?.filter((metric) => !metric.primary) ?? [];
  const withinTolerance =
    comparison?.withinTolerance ??
    report?.blinding?.comparison?.withinTolerance ??
    (delta !== null && tolerance !== null ? Math.abs(delta) <= tolerance + 1e-9 : null);
  const reviewCount = report?.reviews.length ?? reviewers.length;
  const reviewsApproved = report?.reviews.length
    ? report.reviews.every((review) => review.verdict === "approve")
    : reviewers.length > 0 && reviewers.every((reviewer) => reviewer.status === "done");
  const targetVerified = reveal?.verified ?? report?.blinding?.verified ?? null;
  const cleanupVerified = view.cleanup?.verified ?? null;
  return (
    <section className="card completion stack" aria-labelledby="completion-title" data-result={statusKey ?? "pending"}>
      <div className="completion-header">
        <div className="completion-heading stack-tight">
          <span className="muted small">Final summary</span>
          <h2 id="completion-title">{result?.label ?? "Deciding"}</h2>
          {result?.explanation ? <p className="muted result-explanation">{result.explanation}</p> : null}
        </div>
        <div className="completion-actions">
          {onNewStudy ? (
            <button className="button secondary" type="button" onClick={onNewStudy}>
              New study
            </button>
          ) : null}
          {reportHref ? (
            <a className="button secondary" href={reportHref} download>
              Download report
            </a>
          ) : (
            <button className="button secondary" type="button" onClick={onDownload}>
              Download report
            </button>
          )}
        </div>
      </div>
      <div className="metric-summary-heading">
        <div>
          <span className="muted small">Metric under review</span>
          <h3>{metricName}</h3>
        </div>
        {withinTolerance !== null ? (
          <Badge tone={withinTolerance ? "positive" : "warning"}>{withinTolerance ? "Within tolerance" : "Outside tolerance"}</Badge>
        ) : null}
      </div>
      <div className="comparison" aria-label={`${metricName} comparison`}>
        <Stat label="Paper reports" value={sealed ? "Sealed" : formatMetricValue(paperValue, unit)} testId="paper-value" />
        <Stat label="We observed" value={formatMetricValue(observed, unit)} testId="observed-value" />
        <Stat
          label="Difference"
          value={delta === null ? "-" : `${delta > 0 ? "+" : ""}${Math.round(delta * 10_000) / 10_000}`}
          unit={delta === null ? "" : unitWord}
          testId="delta-value"
        />
        <Stat
          label="Tolerance"
          value={tolerance === null ? "-" : `±${tolerance}`}
          unit={tolerance ? unitWord : ""}
          testId="tolerance-value"
        />
      </div>
      {additionalMetrics.length ? (
        <section className="additional-metrics" aria-labelledby="additional-metrics-title">
          <div className="additional-metrics-heading">
            <h3 id="additional-metrics-title">Additional paper metrics</h3>
            <span className="muted small">Measured by the same approved run</span>
          </div>
          <ul className="metric-list">
            {additionalMetrics.map((metric) => (
              <MetricRow key={`${metric.name}:${metric.unit}`} metric={metric} />
            ))}
          </ul>
        </section>
      ) : null}
      <div className="summary-signals" aria-label="Result confidence">
        <SummarySignal
          label="Target proof"
          value={targetVerified === true ? "Commitment verified" : targetVerified === false ? "Verification failed" : "Not available"}
          tone={targetVerified === true ? "positive" : targetVerified === false ? "negative" : "neutral"}
        />
        <SummarySignal
          label="Independent review"
          value={reviewCount === 0 ? "Not completed" : reviewsApproved ? `${reviewCount} approved` : `${reviewCount} reviewed`}
          tone={reviewCount === 0 ? "neutral" : reviewsApproved ? "positive" : "warning"}
        />
        <SummarySignal
          label="Cleanup"
          value={cleanupVerified === true ? "Verified" : cleanupVerified === false ? "Needs attention" : "Pending"}
          tone={cleanupVerified === true ? "positive" : cleanupVerified === false ? "negative" : "neutral"}
        />
      </div>
      {!report && view.native ? (
        <p className="muted small">The measured value and its comparison are read from the server's report once the study finishes.</p>
      ) : null}
      <details className="audit-disclosure">
        <summary>
          <span>
            <strong>Method and audit details</strong>
            <span className="muted small">Reviewer reasoning, comparability checks, and cleanup evidence</span>
          </span>
          <span className="disclosure-label" aria-hidden="true">
            View details
          </span>
        </summary>
        <div className="audit-details stack">
          {view.result?.reasons.length ? (
            <div className="stack-tight">
              <h3 className="lab-subhead">Why this status</h3>
              <ul className="scope-list small" data-testid="result-reasons">
                {view.result.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="completion-grid">
            <div className="stack-tight">
              <h3 className="lab-subhead">Independent Reviewer verdicts</h3>
              {report?.reviews.length ? (
                <ul className="review-list small" data-testid="review-verdicts">
                  {report.reviews.map((review) => {
                    const verdict = REVIEW_VERDICTS[review.verdict] ?? { label: review.verdict, tone: "neutral" as Tone };
                    return (
                      <li key={review.engineer}>
                        <span className="mono">{review.engineer}</span> <Badge tone={verdict.tone}>{verdict.label}</Badge>
                        {review.equivalence ? (
                          <span className="muted" data-testid="review-equivalence">
                            {" "}
                            {equivalenceLabel(review.equivalence)}
                          </span>
                        ) : null}
                        {review.summary ? <p className="muted">{review.summary}</p> : null}
                        {review.concerns.length ? (
                          <ul className="scope-list">
                            {review.concerns.map((concern) => (
                              <li key={concern}>{concern}</li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : reviewers.length ? (
                <ul className="review-list small" data-testid="review-verdicts">
                  {reviewers.map((card) => (
                    <li key={card.key}>
                      <span className="mono">{card.label ?? card.role}</span>{" "}
                      <Badge tone={card.status === "done" ? "positive" : card.status === "failed" ? "negative" : "neutral"}>
                        {card.status === "done" ? "Review submitted" : card.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No Independent Reviewer ran in this study.</p>
              )}
            </div>
            <div className="stack-tight">
              <h3 className="lab-subhead">Cleanup</h3>
              <CleanupLine cleanup={view.cleanup} labs={view.labs} />
            </div>
          </div>
          {report?.checks.length ? (
            <div className="stack-tight">
              <h3 className="lab-subhead">Comparability checks</h3>
              <ul className="checks">
                {report.checks.map((check) => (
                  <li key={check.name} data-passed={check.passed}>
                    <span className="check-mark" aria-label={check.passed ? "passed" : "not met"}>
                      {check.passed ? "✓" : "!"}
                    </span>
                    <span className="small">{check.explanation}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {report?.hypotheses.length ? (
            <div className="stack-tight">
              <h3 className="lab-subhead">Why the numbers may differ</h3>
              <ul className="hypotheses small">
                {report.hypotheses.map((text) => (
                  <li key={text}>
                    <Badge>Hypothesis</Badge> {text.replace(/^Hypothesis:\s*/u, "")}
                  </li>
                ))}
              </ul>
              <p className="muted small">These are untested explanations, not conclusions.</p>
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}
