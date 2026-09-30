import type { RunEvent } from "@dejaml/contracts";

import { Badge, type Tone } from "../components/Badge";
import { EvidenceList } from "../components/Evidence";
import { findingsFor, labViewFor, studyResultFor, type AuditSummary, type StudyResult } from "../lib/lab";

const AUDIT_VERDICTS: Record<AuditSummary["verdict"], { label: string; tone: Tone; explanation: string }> = {
  confirmed: {
    label: "Metric confirmed",
    tone: "positive",
    explanation: "The Audit Agent confirms the measured metric matches the paper's claim semantically.",
  },
  uncertain: {
    label: "Metric uncertain",
    tone: "neutral",
    explanation: "The Audit Agent found ambiguities in metric alignment or experimental conditions.",
  },
  disputed: {
    label: "Metric disputed",
    tone: "negative",
    explanation: "The Audit Agent found the metric or conditions may not match what the paper reported.",
  },
};

function AuditSection({ audit }: { audit: AuditSummary }) {
  const info = AUDIT_VERDICTS[audit.verdict];
  return (
    <article className="card stack" aria-labelledby="audit-title">
      <h3 id="audit-title">Audit Agent verification</h3>
      <div className="row">
        <Badge tone={info.tone}>{info.label}</Badge>
        <span className="muted small">{info.explanation}</span>
      </div>
      <p className="small">{audit.summary}</p>
      {audit.concerns.length > 0 ? (
        <ul className="hypotheses small">
          {audit.concerns.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

const VERDICTS: Record<string, { label: string; tone: Tone; explanation: string }> = {
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
  inconclusive: {
    label: "Inconclusive",
    tone: "neutral",
    explanation: "The result could not be compared fairly, so no numeric verdict is given.",
  },
};

const STUDY_RESULTS: Record<StudyResult["status"], { label: string; tone: Tone; explanation: string }> = {
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
};

function StudyResultCard({ result }: { result: StudyResult }) {
  const info = STUDY_RESULTS[result.status];
  return (
    <article className="card stack" aria-labelledby="study-result-title" data-result={result.status}>
      <div className="row">
        <h3 id="study-result-title">Study result</h3>
        <Badge tone={info.tone}>{info.label}</Badge>
      </div>
      <p className="muted small">{info.explanation}</p>
      {result.reasons.length ? (
        <ul className="scope-list small">
          {result.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return "–";
  return unit === "percent" ? `${value}%` : String(value);
}

export function Findings({
  events,
  onDownload,
  reportHref,
  onNewStudy,
}: {
  events: readonly RunEvent[];
  onDownload: () => void;
  reportHref: string | null;
  onNewStudy?: (() => void) | undefined;
}) {
  const findings = findingsFor(events);
  const lab = labViewFor(events);
  const study = studyResultFor(events);
  if (!findings) {
    return (
      <section className="card stack" aria-labelledby="findings-title">
        <h2 id="findings-title">Findings</h2>
        {study ? <StudyResultCard result={study} /> : <p className="muted">The Result Verifier is still checking the metric.</p>}
      </section>
    );
  }
  const { assessment, unit } = findings;
  const verdict = VERDICTS[assessment.verdict] ?? VERDICTS.inconclusive!;
  const difference = assessment.signedDifference;
  const unitWord = unit === "percent" ? "percentage points" : "";

  return (
    <section className="stack" aria-labelledby="findings-title">
      <div className="row space-between">
        <h2 id="findings-title">Findings</h2>
        <div className="row-tight">
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

      {study ? <StudyResultCard result={study} /> : null}

      <article className="card stack verdict" data-verdict={assessment.verdict}>
        <div className="row">
          <Badge tone={verdict.tone}>{verdict.label}</Badge>
          <span className="muted small">{verdict.explanation}</span>
        </div>
        <div className="comparison">
          <div className="stat">
            <span className="muted small">Paper reports</span>
            <span className="stat-value">{formatValue(assessment.paperValue, unit)}</span>
          </div>
          <div className="stat">
            <span className="muted small">We observed</span>
            <span className="stat-value">{formatValue(assessment.observedValue, unit)}</span>
          </div>
          <div className="stat">
            <span className="muted small">Difference</span>
            <span className="stat-value">
              {difference === null ? "–" : `${difference > 0 ? "+" : ""}${difference}`}
              <span className="stat-unit"> {difference === null ? "" : unitWord}</span>
            </span>
          </div>
          <div className="stat">
            <span className="muted small">Tolerance</span>
            <span className="stat-value">
              ±{assessment.tolerance ?? "–"}
              <span className="stat-unit"> {unitWord}</span>
            </span>
          </div>
        </div>
        <p>{findings.summary}.</p>
        <EvidenceList evidence={assessment.evidence} />
      </article>

      <div className="lanes">
        <article className="card stack" aria-labelledby="checks-title">
          <h3 id="checks-title">Comparability checks</h3>
          <ul className="checks">
            {assessment.checks.map((check) => (
              <li key={check.name} data-passed={check.passed}>
                <span className="check-mark" aria-label={check.passed ? "passed" : "not met"}>
                  {check.passed ? "✓" : "!"}
                </span>
                <span className="small">{check.explanation}</span>
              </li>
            ))}
          </ul>
        </article>
        <article className="card stack" aria-labelledby="discrepancies-title">
          <h3 id="discrepancies-title">Why the numbers may differ</h3>
          {assessment.discrepancyHypotheses.length === 0 ? (
            <p className="muted small">No discrepancies to explain.</p>
          ) : (
            <ul className="hypotheses small">
              {assessment.discrepancyHypotheses.map((text) => (
                <li key={text}>
                  <Badge>Hypothesis</Badge> {text.replace(/^Hypothesis:\s*/u, "")}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">These are untested explanations, not conclusions.</p>
        </article>
      </div>

      {findings.audit ? <AuditSection audit={findings.audit} /> : null}

      <article className="card stack" aria-labelledby="limits-title">
        <h3 id="limits-title">Limitations and cleanup</h3>
        <ul className="scope-list">
          {assessment.limitations.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
        <p className="small">
          {lab.cleanup ? (
            <>
              <Badge tone={lab.cleanup.clean ? "positive" : "negative"}>{lab.cleanup.clean ? "Lab removed" : "Cleanup failed"}</Badge>{" "}
              {lab.cleanup.summary}
            </>
          ) : (
            <Badge tone="neutral">Cleanup pending</Badge>
          )}
        </p>
      </article>
    </section>
  );
}
