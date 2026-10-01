import { useLayoutEffect, useRef, useState } from "react";

import { Badge, type Tone } from "../Badge";
import { elapsedBetween, formatElapsed, type LabCard, type LabState, type Preparation } from "../../lib/live-run";
import { formatBytes } from "../../lib/paper";

const LAB_STATES: Record<LabState, { label: string; tone: Tone }> = {
  creating: { label: "Creating", tone: "accent" },
  ready: { label: "Ready", tone: "accent" },
  running: { label: "Running a command", tone: "accent" },
  idle: { label: "Idle", tone: "neutral" },
  failed: { label: "Failed", tone: "negative" },
  cancelled: { label: "Cancelled", tone: "warning" },
  timed_out: { label: "Timed out", tone: "negative" },
  removed: { label: "Removed", tone: "positive" },
  cleanup_failed: { label: "Cleanup failed", tone: "negative" },
};

function seconds(ms: number | null): string {
  return ms === null ? "–" : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : formatElapsed(ms);
}

function Meter({ label, value, max, display }: { label: string; value: number; max: number | null; display: string }) {
  const percent = max && max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter">
      <div className="row space-between small">
        <span className="muted">{label}</span>
        <span className="mono">{display}</span>
      </div>
      <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max ?? 0} aria-valuenow={value}>
        <div className="meter-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Terminal({ lab, droppedByPage }: { lab: LabCard; droppedByPage: number }) {
  const element = useRef<HTMLPreElement>(null);
  const [pinned, setPinned] = useState(true);
  useLayoutEffect(() => {
    const node = element.current;
    if (node && pinned) node.scrollTop = node.scrollHeight;
  }, [lab.lines.length, pinned]);
  const hidden = droppedByPage + lab.serverDroppedLines;
  return (
    <div className="stack-tight">
      {hidden > 0 || lab.truncatedLines > 0 ? (
        <p className="terminal-notice small" role="status" data-testid="terminal-truncation">
          {hidden > 0
            ? `${hidden.toLocaleString()} earlier line${hidden === 1 ? " is" : "s are"} not shown here${lab.serverDroppedLines > 0 ? "; the server kept them in the bounded attempt log" : " to keep this page light"}. `
            : ""}
          {lab.truncatedLines > 0 ? `${lab.truncatedLines} long line${lab.truncatedLines === 1 ? " was" : "s were"} shortened. ` : ""}
          The full bounded log is in the report.
        </p>
      ) : null}
      <pre
        ref={element}
        className="terminal"
        aria-live="off"
        aria-label={`Lab output${lab.label ? ` for ${lab.label}` : ""}`}
        onScroll={(event) => {
          const node = event.currentTarget;
          setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 32);
        }}
      >
        {lab.lines.length === 0 ? (
          <span className="terminal-muted">{lab.state === "running" ? "Waiting for output…" : "No output yet."}</span>
        ) : (
          lab.lines.map((line) => (
            <span key={line.key} className={line.stream === "stderr" ? "terminal-err" : undefined}>
              {line.text}
              {"\n"}
            </span>
          ))
        )}
      </pre>
    </div>
  );
}

function LabDetail({
  lab,
  now,
  droppedByPage,
  highlight,
  preparation,
}: {
  lab: LabCard;
  now: number;
  droppedByPage: number;
  highlight: string | null;
  preparation: Preparation;
}) {
  const state = LAB_STATES[lab.state];
  const latest = lab.telemetry.at(-1);
  const elapsed = elapsedBetween(lab.createdAt, lab.endedAt, now);
  const commandElapsed = lab.current?.running ? elapsedBetween(lab.current.startedAt, null, now) : (lab.current?.durationMs ?? null);
  const highlighted = highlight?.split("#sha256=")[0] ?? null;
  return (
    <div className="stack lab-detail" data-testid="lab-detail">
      <div className="row space-between">
        <div className="row-tight">
          <Badge tone={state.tone}>{state.label}</Badge>
          {lab.cancelRequested && lab.state !== "removed" ? <Badge tone="warning">Cancellation requested</Badge> : null}
        </div>
        <span className="muted small">
          Round {lab.round} · step {lab.steps} · {elapsed === null ? "–" : formatElapsed(elapsed)}
        </span>
      </div>

      <div className="stack-tight">
        <h4 className="lab-subhead">Current command</h4>
        {lab.current ? (
          <>
            <pre className="command mono small">{lab.current.text}</pre>
            <p className="muted small">
              {lab.current.step !== null ? `Step ${lab.current.step} · ` : ""}
              {lab.current.running
                ? `running for ${seconds(commandElapsed)}`
                : lab.current.timedOut
                  ? `stopped at its time limit after ${seconds(commandElapsed)}`
                  : `exit ${String(lab.current.exitCode)} after ${seconds(commandElapsed)}`}
            </p>
          </>
        ) : (
          <p className="muted small">No command has run in this lab yet.</p>
        )}
        {lab.official ? (
          <p className="small" data-testid="official-run">
            <Badge tone={lab.official.exitCode === 0 ? "positive" : "warning"}>Approved command</Badge> {lab.official.summary}
            {lab.official.durationMs !== null ? ` (${seconds(lab.official.durationMs)})` : ""}
          </p>
        ) : null}
      </div>

      <div className="stack-tight">
        <h4 className="lab-subhead">Output</h4>
        <Terminal lab={lab} droppedByPage={droppedByPage} />
      </div>

      <div className="lab-columns">
        <div className="stack-tight">
          <h4 className="lab-subhead">Resources</h4>
          {latest ? (
            <div className="stack-tight">
              <Meter
                label="CPU"
                value={latest.cpuPercent}
                max={latest.cpuLimit === null ? null : latest.cpuLimit * 100}
                display={`${latest.cpuPercent.toFixed(0)}%${latest.cpuLimit === null ? "" : ` of ${latest.cpuLimit * 100}%`}`}
              />
              <Meter
                label="Memory"
                value={latest.memoryBytes}
                max={latest.memoryLimitBytes}
                display={`${formatBytes(latest.memoryBytes)} of ${formatBytes(latest.memoryLimitBytes)}`}
              />
              <Meter
                label="Processes"
                value={latest.pids}
                max={latest.pidLimit}
                display={`${latest.pids}${latest.pidLimit === null ? "" : ` of ${latest.pidLimit}`}`}
              />
              <p className="muted small">
                {lab.telemetry.length} sample{lab.telemetry.length === 1 ? "" : "s"}, last at {seconds(latest.elapsedMs)}
              </p>
            </div>
          ) : (
            <p className="muted small">No resource samples yet. They appear while a command runs.</p>
          )}
        </div>
        <div className="stack-tight">
          <h4 className="lab-subhead">Isolation</h4>
          {lab.isolation ? (
            <dl className="facts small">
              <dt>Network</dt>
              <dd data-testid="network-state">
                {lab.isolation.network === "none" ? "Off (no network interface)" : lab.isolation.network}
                {lab.isolation.sealed ? " · sealed" : ""}
              </dd>
              <dt>Root filesystem</dt>
              <dd>{lab.isolation.readOnlyRoot ? "Read-only" : "Writable"}</dd>
              <dt>Limits</dt>
              <dd>
                {lab.isolation.cpus ?? "?"} CPU · {lab.isolation.memoryMb ?? "?"} MB · {lab.isolation.pids ?? "?"} processes
                {lab.isolation.timeoutSeconds ? ` · ${lab.isolation.timeoutSeconds} s per command` : ""}
              </dd>
              {lab.image ? (
                <>
                  <dt>Image</dt>
                  <dd className="mono">{lab.image}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="muted small">Shown once the lab is created.</p>
          )}
        </div>
      </div>

      <div className="stack-tight">
        <h4 className="lab-subhead">Dependencies</h4>
        <p className="small" data-testid="dependency-status">
          {preparation.failure
            ? preparation.failure
            : lab.environment
              ? lab.environment
              : preparation.wheels
                ? `${preparation.wheels.count} verified wheels prepared; installing offline in this lab…`
                : "Setting up the environment…"}
        </p>
      </div>

      <div className="stack-tight">
        <h4 className="lab-subhead">Artifacts</h4>
        {lab.artifacts.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <ul className="artifact-list small">
            {lab.artifacts.map((artifact) => (
              <li key={artifact.path} data-highlight={highlighted === artifact.path}>
                <span className="mono">{artifact.path}</span>
                {artifact.bytes !== null ? <span className="muted"> · {formatBytes(artifact.bytes)}</span> : null}
                {artifact.sha256 ? (
                  <span className="mono muted artifact-hash" title={artifact.sha256}>
                    sha256 {artifact.sha256.slice(0, 12)}…
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="stack-tight">
        <h4 className="lab-subhead">Cleanup</h4>
        {lab.cleanup ? (
          <p className="small" data-testid="lab-cleanup">
            <Badge tone={lab.cleanup.clean ? "positive" : "negative"}>{lab.cleanup.clean ? "Removed" : "Needs attention"}</Badge>{" "}
            {lab.cleanup.summary}
            {lab.cleanup.verifiedAbsent ? " · verified absent" : ""}
          </p>
        ) : (
          <p className="muted small">The lab is destroyed when its engineer finishes.</p>
        )}
      </div>
    </div>
  );
}

export function LabPanel({
  labs,
  now,
  selectedLabId,
  onSelectLab,
  droppedOutputLines,
  highlight,
  preparation,
  waitingText,
  onCancel,
  cancellable,
}: {
  labs: readonly LabCard[];
  now: number;
  selectedLabId: string | null;
  onSelectLab: (labId: string) => void;
  droppedOutputLines: Readonly<Record<string, number>>;
  highlight: string | null;
  preparation: Preparation;
  waitingText: string;
  onCancel?: (() => void) | undefined;
  cancellable: boolean;
}) {
  const selected = labs.find((lab) => lab.labId === selectedLabId) ?? labs.find((lab) => lab.state === "running") ?? labs.at(-1) ?? null;
  return (
    <section className="panel lab-panel" aria-labelledby="lab-title">
      <header className="panel-head">
        <h2 id="lab-title">Virtual Lab</h2>
        {cancellable && onCancel ? (
          <button type="button" className="button secondary small-button" onClick={onCancel}>
            Cancel study
          </button>
        ) : null}
      </header>
      {labs.length > 1 ? (
        <div className="lab-tabs" role="tablist" aria-label="Labs">
          {labs.map((lab, index) => (
            <button
              key={lab.labId}
              type="button"
              role="tab"
              className="lab-tab"
              aria-selected={lab.labId === selected?.labId}
              data-state={lab.state}
              onClick={() => onSelectLab(lab.labId)}
            >
              {lab.label ?? `Lab ${index + 1}`}
              {lab.round > 1 ? ` (round ${lab.round})` : ""}
            </button>
          ))}
        </div>
      ) : null}
      {selected ? (
        <LabDetail
          lab={selected}
          now={now}
          droppedByPage={droppedOutputLines[selected.labId] ?? 0}
          highlight={highlight}
          preparation={preparation}
        />
      ) : (
        <div className="stack-tight">
          <p className="muted small" data-testid="lab-waiting">
            {waitingText}
          </p>
          <dl className="facts small">
            <dt>Lab image</dt>
            <dd>{preparation.image ?? "not prepared yet"}</dd>
            <dt>Dependencies</dt>
            <dd>
              {preparation.failure ?? (preparation.wheels ? `${preparation.wheels.count} verified wheels prepared` : "not prepared yet")}
            </dd>
            {preparation.dataset ? (
              <>
                <dt>Dataset</dt>
                <dd>{preparation.dataset}</dd>
              </>
            ) : null}
          </dl>
        </div>
      )}
    </section>
  );
}
