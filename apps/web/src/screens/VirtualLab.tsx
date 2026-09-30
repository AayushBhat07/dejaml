import type { RunEvent } from "@dejaml/contracts";
import { useEffect, useRef } from "react";

import { Badge, type Tone } from "../components/Badge";
import { formatBytes } from "../lib/paper";
import { labViewFor, type LabPhase, type TelemetrySample } from "../lib/lab";

const PHASES: Record<LabPhase, { label: string; tone: Tone }> = {
  waiting: { label: "Waiting for an approved plan", tone: "neutral" },
  preparing: { label: "Preparing", tone: "accent" },
  running: { label: "Running", tone: "accent" },
  finished: { label: "Finished", tone: "positive" },
  failed: { label: "Failed", tone: "negative" },
  timed_out: { label: "Timed out", tone: "negative" },
  cancelled: { label: "Cancelled", tone: "warning" },
};

function seconds(ms: number | null): string {
  return ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`;
}

function Meter({ label, value, max, display }: { label: string; value: number; max: number; display: string }) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter">
      <div className="row space-between small">
        <span className="muted">{label}</span>
        <span className="mono">{display}</span>
      </div>
      <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className="meter-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Telemetry({ latest, samples }: { latest: TelemetrySample | undefined; samples: number }) {
  if (!latest) return <p className="muted small">No resource samples yet.</p>;
  return (
    <div className="stack">
      <Meter
        label="CPU"
        value={latest.cpuPercent}
        max={latest.cpuLimit * 100}
        display={`${latest.cpuPercent.toFixed(0)}% of ${latest.cpuLimit * 100}%`}
      />
      <Meter
        label="Memory"
        value={latest.memoryBytes}
        max={latest.memoryLimitBytes}
        display={`${formatBytes(latest.memoryBytes)} of ${formatBytes(latest.memoryLimitBytes)}`}
      />
      <Meter label="Processes" value={latest.pids} max={latest.pidLimit} display={`${latest.pids} of ${latest.pidLimit}`} />
      <p className="muted small">
        {samples} sample{samples === 1 ? "" : "s"}, last at {seconds(latest.elapsedMs)}
      </p>
    </div>
  );
}

export function VirtualLab({ events, onCancel }: { events: readonly RunEvent[]; onCancel?: () => void }) {
  const lab = labViewFor(events);
  const phase = PHASES[lab.phase];
  const terminal = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const element = terminal.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lab.lines.length]);

  const active = lab.phase === "preparing" || lab.phase === "running";
  return (
    <section className="stack" aria-labelledby="lab-title">
      <div className="row space-between">
        <div className="stack-tight">
          <h2 id="lab-title">Virtual Lab</h2>
          <p className="muted small">One disposable, offline CPU container. Only the approved command runs here.</p>
        </div>
        <div className="row-tight">
          <Badge tone={phase.tone}>{phase.label}</Badge>
          {active && onCancel ? (
            <button className="button secondary" type="button" onClick={onCancel}>
              Cancel run
            </button>
          ) : null}
        </div>
      </div>

      <div className="lab-grid">
        <div className="stack">
          <article className="card stack" aria-labelledby="command-title">
            <h3 id="command-title">Approved command</h3>
            {lab.command ? (
              <pre className="command mono">
                <span className="muted">{lab.command.cwd} $ </span>
                {[lab.command.executable, ...lab.command.args].join(" ")}
              </pre>
            ) : (
              <p className="muted small">The command appears once the lab starts the attempt.</p>
            )}
          </article>
          <article className="card stack" aria-labelledby="terminal-title">
            <div className="row space-between">
              <h3 id="terminal-title">Output</h3>
              {lab.exitCode !== null ? (
                <span className="muted small">
                  exit {lab.exitCode} · {seconds(lab.durationMs)}
                </span>
              ) : null}
            </div>
            <pre ref={terminal} className="terminal" aria-live="polite" aria-label="Lab output">
              {lab.lines.length === 0 ? (
                <span className="terminal-muted">{active ? "Waiting for output…" : "No output yet."}</span>
              ) : (
                lab.lines.map((line) => (
                  <span key={line.key} className={line.stream === "stderr" ? "terminal-err" : undefined}>
                    {line.text}
                    {"\n"}
                  </span>
                ))
              )}
            </pre>
            {lab.heldBackLines > 0 ? (
              <p className="muted small">{lab.heldBackLines} more lines are kept only in the downloadable log.</p>
            ) : null}
          </article>
        </div>

        <div className="stack">
          <article className="card stack" aria-labelledby="resources-title">
            <h3 id="resources-title">Resources</h3>
            <Telemetry latest={lab.telemetry.at(-1)} samples={lab.telemetry.length} />
          </article>
          <article className="card stack" aria-labelledby="isolation-title">
            <h3 id="isolation-title">Isolation</h3>
            {lab.isolation ? (
              <dl className="facts small">
                <dt>Image</dt>
                <dd className="mono">{lab.image}</dd>
                <dt>Network</dt>
                <dd>{lab.isolation.network === "none" ? "Off" : lab.isolation.network}</dd>
                <dt>Root filesystem</dt>
                <dd>{lab.isolation.readOnlyRoot ? "Read-only" : "Writable"}</dd>
                <dt>Limits</dt>
                <dd>
                  {lab.isolation.cpus} CPU · {lab.isolation.memoryMb} MB · {lab.isolation.pids} processes · {lab.isolation.timeoutSeconds} s
                </dd>
              </dl>
            ) : (
              <p className="muted small">Shown once the lab is created.</p>
            )}
          </article>
          <article className="card stack" aria-labelledby="artifacts-title">
            <h3 id="artifacts-title">Artifacts</h3>
            {lab.artifacts.length === 0 ? (
              <p className="muted small">None yet.</p>
            ) : (
              <ul className="artifact-list small">
                {lab.artifacts.map((artifact) => (
                  <li key={artifact.path}>
                    <span className="mono">{artifact.path}</span>
                    <span className="muted"> · {formatBytes(artifact.bytes)}</span>
                    {artifact.sha256 ? (
                      <span className="mono muted artifact-hash" title={artifact.sha256}>
                        sha256 {artifact.sha256.slice(0, 12)}…
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </article>
          {lab.cleanup ? (
            <p className="small">
              <Badge tone={lab.cleanup.clean ? "positive" : "negative"}>{lab.cleanup.clean ? "Cleaned up" : "Cleanup failed"}</Badge>{" "}
              {lab.cleanup.summary}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
