import { elapsedBetween, formatElapsed, type RunView } from "../../lib/live-run";
import type { ConnectionState } from "../../lib/run-client";

const CONNECTION: Record<ConnectionState | "complete" | "replay", { label: string; tone: string }> = {
  connecting: { label: "Connecting…", tone: "neutral" },
  live: { label: "Connected", tone: "positive" },
  reconnecting: { label: "Reconnecting…", tone: "warning" },
  closed: { label: "Disconnected", tone: "negative" },
  complete: { label: "Run complete", tone: "neutral" },
  replay: { label: "Replay", tone: "warning" },
};

export function RunHeader({
  runId,
  title,
  subtitle,
  view,
  connection,
  now,
  following,
  onToggleFollow,
  onCancel,
  cancelling,
}: {
  runId: string;
  title: string;
  subtitle: string | null;
  view: RunView;
  connection: ConnectionState | "complete" | "replay";
  now: number;
  following: boolean;
  onToggleFollow: () => void;
  onCancel?: (() => void) | undefined;
  cancelling: boolean;
}) {
  const elapsed = elapsedBetween(view.startedAt, view.endedAt, now);
  const status = CONNECTION[connection];
  const ended = view.finished || view.result !== null;
  return (
    <header className="run-header card" aria-label="Study">
      <div className="run-header-top">
        <div className="stack-tight run-title">
          <h1>{title}</h1>
          {subtitle ? <p className="muted small">{subtitle}</p> : null}
        </div>
        <div className="row-tight run-controls">
          <span className="connection" data-tone={status.tone} role="status" data-testid="connection-status">
            <span className="connection-dot" aria-hidden="true" />
            {status.label}
          </span>
          <button type="button" className="button secondary small-button" aria-pressed={!following} onClick={onToggleFollow}>
            {following ? "Pause follow" : "Follow live"}
          </button>
          {onCancel && !ended ? (
            <button type="button" className="button danger small-button" onClick={onCancel} disabled={cancelling}>
              {cancelling ? "Cancelling…" : "Cancel study"}
            </button>
          ) : null}
        </div>
      </div>
      <dl className="run-facts small">
        <div>
          <dt>Run</dt>
          <dd className="mono" title={runId}>
            {runId}
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{view.provider ? `${view.provider} · ${view.model ?? "?"}` : "–"}</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd data-testid="current-stage">{view.currentStage}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd className="mono">{elapsed === null ? "–" : formatElapsed(elapsed)}</dd>
        </div>
      </dl>
      <ol className="stage-strip" aria-label="Study stages">
        {view.stages.map((step) => (
          <li key={step.id} className="stage-step" data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
            <span className="stage-mark" aria-hidden="true">
              {step.state === "done" ? "✓" : step.state === "failed" ? "!" : step.state === "skipped" ? "–" : ""}
            </span>
            {step.label}
          </li>
        ))}
      </ol>
    </header>
  );
}
