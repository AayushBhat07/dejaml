import { Badge, type Tone } from "../Badge";
import { equivalenceLabel, type Blinding } from "../../lib/live-run";
import { formatClock, formatMetricValue, shortHash } from "./format";

const EQUIVALENCE_TONES: Record<string, Tone> = {
  equivalent: "positive",
  partially_equivalent: "accent",
  not_equivalent: "warning",
  insufficient_evidence: "neutral",
};

const STATE_MARK: Record<Blinding["phases"][number]["state"], string> = { done: "✓", current: "", pending: "" };

function Hash({ value, testId }: { value: string; testId?: string }) {
  return (
    <code className="mono blinding-hash" title={value} data-testid={testId}>
      {shortHash(value)}
    </code>
  );
}

function Verdicts({ verdicts }: { verdicts: Array<{ engineer: string | null; equivalence: string | null }> }) {
  if (verdicts.length === 0) return <p className="muted small">No blind verdict was recorded.</p>;
  return (
    <ul className="review-list small" data-testid="blind-verdicts">
      {verdicts.map((verdict, index) => (
        <li key={`${verdict.engineer ?? "reviewer"}:${index}`}>
          <span className="mono">{verdict.engineer ?? "reviewer"}</span>{" "}
          <Badge tone={verdict.equivalence ? (EQUIVALENCE_TONES[verdict.equivalence] ?? "neutral") : "neutral"}>
            {equivalenceLabel(verdict.equivalence)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * The blinding protocol, visible for the whole run. Before `target_revealed`
 * it can show only what the stream has said so far: the sealed commitment, the
 * metric's name, the observation and the blind verdicts. It has no paper value
 * to show, because the view holds none until the reveal.
 */
export function BlindingPanel({ blinding, ended, finalStatus }: { blinding: Blinding; ended: boolean; finalStatus: string | null }) {
  const { sealed, observation, blindReview, reveal, comparison, final } = blinding;
  const stayedSealed = final?.sealed === true || (ended && !reveal && sealed !== null);
  const unit = reveal?.metric?.unit ?? observation?.metric?.unit ?? null;
  const metricName = reveal?.metric?.name ?? observation?.metric?.name ?? sealed?.metric ?? null;
  const observedValues = observation?.observed.map((item) => item.value).filter((value): value is number => value !== null) ?? [];
  const observed = comparison?.observed ?? (observedValues.length > 0 ? observedValues[0]! : null);
  const reported = reveal?.reportedValue ?? null;
  const delta = comparison?.absoluteDelta ?? (reported !== null && observed !== null ? Math.abs(observed - reported) : null);
  const tolerance = reveal?.tolerance ?? null;
  const status = final?.status ?? finalStatus;

  return (
    <section
      className="card blinding stack"
      aria-labelledby="blinding-title"
      data-testid="blinding-panel"
      data-revealed={reveal ? "true" : "false"}
      data-sealed={sealed ? "true" : "false"}
    >
      <div className="row space-between">
        <div className="row-tight">
          <h2 id="blinding-title">Blinding</h2>
          {reveal ? (
            <Badge tone={reveal.verified ? "positive" : "negative"}>{reveal.verified ? "Target revealed" : "Reveal not verified"}</Badge>
          ) : sealed ? (
            <Badge tone="accent">Paper target sealed</Badge>
          ) : (
            <Badge>Waiting for the seal</Badge>
          )}
        </div>
        {metricName ? (
          <span className="small muted" data-testid="blinding-metric">
            Metric: <strong>{metricName}</strong>
            {unit ? ` (${unit})` : ""}
          </span>
        ) : null}
      </div>

      {sealed ? (
        <p className="small">
          <strong>Paper target sealed</strong> with commitment <Hash value={sealed.commitment} testId="target-commitment" />
          {sealed.sealedAt ? <span className="muted"> at {formatClock(sealed.sealedAt)}</span> : null}
        </p>
      ) : (
        <p className="small muted">The paper target is sealed before any agent starts.</p>
      )}
      {ended && !blinding.present ? (
        <p className="small muted" data-testid="no-blinding">
          This run recorded no blinding events.
        </p>
      ) : stayedSealed ? (
        <p className="notice small" role="status" data-testid="stayed-sealed">
          The paper target stayed sealed (the study stopped before the locks).
        </p>
      ) : !reveal ? (
        <p className="small" data-testid="value-hidden">
          Reported value hidden until experiment and review are locked.
        </p>
      ) : null}

      <ol className="blinding-steps" aria-label="Blinding steps">
        {blinding.phases.map((phase) => (
          <li
            key={phase.id}
            className="stage-step"
            data-state={phase.state}
            data-phase={phase.id}
            aria-current={phase.state === "current" ? "step" : undefined}
          >
            <span className="stage-mark" aria-hidden="true">
              {STATE_MARK[phase.state]}
            </span>
            <span>{phase.label}</span>
            <span className="muted mono">
              {phase.at ? <time dateTime={phase.at}>{formatClock(phase.at)}</time> : phase.state === "current" ? "now" : "pending"}
            </span>
          </li>
        ))}
      </ol>

      {observation ? (
        <div className="stack-tight" data-testid="blinding-observation">
          <h3 className="lab-subhead">Observation locked{observation.round !== null ? ` (round ${observation.round})` : ""}</h3>
          <ul className="review-list small">
            {observation.observed.map((item) => (
              <li key={item.engineer}>
                <span className="mono">{item.engineer}</span> <strong>{formatMetricValue(item.value, unit)}</strong>
                {item.metricOk ? null : <span className="muted"> · metric not read</span>}
              </li>
            ))}
          </ul>
          {observation.commitment ? (
            <p className="small muted">
              Observation commitment <Hash value={observation.commitment} testId="observation-commitment" />
            </p>
          ) : null}
        </div>
      ) : null}

      {blindReview ? (
        <div className="stack-tight" data-testid="blinding-review">
          <h3 className="lab-subhead">Blind review locked{blindReview.round !== null ? ` (round ${blindReview.round})` : ""}</h3>
          <Verdicts verdicts={blindReview.verdicts} />
          {blindReview.commitment ? (
            <p className="small muted">
              Review commitment <Hash value={blindReview.commitment} />
            </p>
          ) : null}
        </div>
      ) : null}

      {reveal ? (
        <div className="stack-tight" data-testid="blinding-reveal">
          <h3 className="lab-subhead">Revealed comparison</h3>
          <dl className="facts small">
            <dt>Paper value</dt>
            <dd data-testid="blinding-paper-value">{formatMetricValue(reported, unit)}</dd>
            <dt>Observed value</dt>
            <dd data-testid="blinding-observed-value">{formatMetricValue(observed, unit)}</dd>
            <dt>Absolute difference</dt>
            <dd data-testid="blinding-delta">{delta === null ? "–" : String(Math.round(delta * 10_000) / 10_000)}</dd>
            <dt>Tolerance</dt>
            <dd data-testid="blinding-tolerance">{tolerance === null ? "–" : `±${tolerance}`}</dd>
            {comparison?.withinTolerance !== null && comparison?.withinTolerance !== undefined ? (
              <>
                <dt>Rule</dt>
                <dd>
                  {comparison.withinTolerance ? "Within tolerance" : "Outside tolerance"}
                  {comparison.rule ? <span className="muted mono"> · {comparison.rule}</span> : null}
                </dd>
              </>
            ) : null}
            {reveal.claimLocator?.page !== null && reveal.claimLocator?.page !== undefined ? (
              <>
                <dt>Where</dt>
                <dd>
                  Page {reveal.claimLocator.page}
                  {reveal.claimLocator.location ? `, ${reveal.claimLocator.location}` : ""}
                </dd>
              </>
            ) : null}
          </dl>
          <p className="small" data-testid="commitment-verified">
            {reveal.verified ? <Badge tone="positive">Commitment verified</Badge> : <Badge tone="negative">Commitment NOT verified</Badge>}{" "}
            {reveal.commitment ? <Hash value={reveal.commitment} /> : null}
          </p>
        </div>
      ) : null}

      {status && (reveal || stayedSealed || final) ? (
        <p className="small" data-testid="blinding-final-status">
          Final status: <strong>{status.replaceAll("_", " ")}</strong>
        </p>
      ) : null}
    </section>
  );
}
