import { useEffect, useRef, type ReactNode } from "react";

import type { Tone as BadgeTone } from "../Badge";
import type { CampusAgentState, CampusModel } from "../../lib/campus";
import { formatElapsed } from "../../lib/live-run";
import { RESULTS } from "../live/Completion";
import { CampusScene } from "./scene";

export function statusLabel(status: string): string {
  return RESULTS[status]?.label ?? status.replaceAll("_", " ");
}

function statusTone(status: string): BadgeTone {
  return RESULTS[status]?.tone ?? "neutral";
}

const PILLS: Record<CampusAgentState, string> = {
  working: "Working",
  idle: "Waiting",
  blocked: "Blocked",
  done: "Done",
  stopped: "Stopped",
};

function clockOf(offsetMs: number | null): string {
  return offsetMs === null ? "–" : formatElapsed(offsetMs);
}

function Kpi({
  icon,
  tone,
  label,
  value,
  foot,
  testId,
  children,
}: {
  icon: string;
  tone: string;
  label: string;
  value: string | null;
  foot: string;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <div className="campus-card campus-kpi" data-testid={testId}>
      <div className="campus-kpi-label">
        <span className="campus-icon" data-tone={tone} aria-hidden="true">
          {icon}
        </span>
        {label}
      </div>
      <div className="campus-kpi-value" data-testid={`${testId}-value`}>
        {value ?? children ?? "—"}
      </div>
      <div className="campus-kpi-foot">{foot}</div>
    </div>
  );
}

/**
 * The Research Campus: an isometric picture of the study with the run's own
 * numbers around it. The scene and every card are drawn from `model`, which is
 * derived from the same events and report as the dashboard.
 */
export function ResearchCampus({ model }: { model: CampusModel }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<CampusScene | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = CampusScene.create(canvas, { statusLabel });
    if (!scene) return;
    sceneRef.current = scene;
    scene.start();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => scene.resize());
    observer?.observe(canvas);
    return () => {
      observer?.disconnect();
      scene.stop();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setModel(model);
  }, [model]);

  const { lab } = model;
  const total = model.steps.length || 1;
  const chips = {
    provisioned: model.labPresence === "active",
    running: model.lab?.running === true && model.labPresence === "active",
    destroyed: model.labPresence === "removed",
  };
  const working = model.agents.filter((agent) => agent.state === "working").length;

  return (
    <section className="campus" aria-label="Research campus" data-testid="research-campus">
      <canvas
        ref={canvasRef}
        className="campus-scene"
        role="img"
        aria-label="Isometric research campus: the study's agents read the paper, map the code, plan, run the experiment in a disposable lab, and verify the result"
      />

      <div className="campus-kpis">
        <Kpi icon="P" tone="paper" label="Paper claim" value={model.paper.value} foot={model.paper.foot} testId="campus-paper">
          {model.paper.sealed ? (
            <span className="campus-sealed">
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
                <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              Sealed
            </span>
          ) : null}
        </Kpi>
        <Kpi icon="L" tone="lab" label="Observed" value={model.observed.value} foot={model.observed.foot} testId="campus-observed" />
        <div className="campus-card campus-kpi" data-testid="campus-delta">
          <div className="campus-kpi-label">
            <span className="campus-icon" data-tone="ver" aria-hidden="true">
              V
            </span>
            Δ vs claim
          </div>
          <div className="campus-kpi-value" data-testid="campus-delta-value">
            {model.delta.value ?? "—"}
          </div>
          <div className="campus-kpi-foot">
            {model.status ? (
              <span className="campus-tag" data-tone={statusTone(model.status)} data-testid="campus-status">
                {statusLabel(model.status)}
              </span>
            ) : (
              model.delta.foot
            )}
          </div>
        </div>
      </div>

      <aside className="campus-card campus-side" aria-label="Disposable lab and agents">
        <h3 className="campus-title">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="2" width="12" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2" />
            <circle cx="8" cy="8" r="2" fill="currentColor" />
          </svg>
          Disposable Lab
          {model.labCount > 1 ? <span className="campus-sub-inline">{model.labCount} labs</span> : null}
        </h3>
        <div className="campus-sub mono" data-testid="campus-lab-id">
          {lab ? [lab.label ?? lab.labId, lab.image, lab.platform].filter(Boolean).join(" · ") : "no lab yet"}
        </div>
        <div className="campus-chips">
          <span className="campus-chip" data-on={chips.provisioned}>
            Provisioned
          </span>
          <span className="campus-chip" data-on={chips.running}>
            Running
          </span>
          <span className="campus-chip" data-on={chips.destroyed} data-tone="warn">
            Destroyed
          </span>
        </div>
        <div className="campus-resources">
          <div>
            <b>{lab?.cpus != null ? `${lab.cpus} CPU` : "–"}</b>
            <span>cores</span>
          </div>
          <div>
            <b>{lab?.memoryMb != null ? `${lab.memoryMb} MB` : "–"}</b>
            <span>memory</span>
          </div>
          <div>
            <b>{lab?.network ? (lab.network === "none" ? "Off" : lab.network) : "–"}</b>
            <span>network during run</span>
          </div>
          <div>
            <b>{lab?.timeoutSeconds != null ? `${lab.timeoutSeconds} s` : "–"}</b>
            <span>timeout budget</span>
          </div>
        </div>
        <div className="campus-section">
          <span>Agents</span>
          <span>{working} active</span>
        </div>
        <ul className="campus-agents" data-testid="campus-agents">
          {model.agents.map((agent) => (
            <li key={agent.key} data-role={agent.role} data-state={agent.state}>
              <span className="campus-dot" data-tone={agent.tone} aria-hidden="true">
                {agent.initial}
              </span>
              <div className="campus-agent-text">
                <div className="campus-agent-name">
                  {agent.name}
                  {agent.label && agent.label !== agent.role ? <span className="campus-agent-label mono"> {agent.label}</span> : null}
                </div>
                <div className="campus-agent-activity" title={agent.activity}>
                  {agent.activity || "–"}
                </div>
              </div>
              <span className="campus-pill" data-state={agent.state}>
                {PILLS[agent.state]}
              </span>
            </li>
          ))}
        </ul>
      </aside>

      <div className="campus-card campus-pipeline">
        <div className="campus-head">
          Reproduction pipeline<span className="campus-head-sub mono">paper.pdf → evidence report</span>
        </div>
        <ol className="campus-track" style={{ gridTemplateColumns: `repeat(${total}, 1fr)` }} aria-label="Pipeline stages">
          {model.steps.map((step) => (
            <li key={step.id} className="campus-step" data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
              <i aria-hidden="true">{step.state === "done" ? "✓" : step.state === "failed" ? "!" : ""}</i>
              {step.label}
            </li>
          ))}
        </ol>
        <div className="campus-now">
          <span data-testid="campus-now">{model.currentStage}</span>
          <div
            className="campus-bar"
            role="progressbar"
            aria-label="Stages complete"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={model.stepsDone}
          >
            <i style={{ width: `${(model.stepsDone / total) * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="campus-card campus-feed-card">
        <div className="campus-head">
          Evidence stream<span className="campus-tag">append-only</span>
        </div>
        <ul className="campus-feed" data-testid="campus-feed">
          {model.feed.length === 0 ? (
            <li>
              <time>0:00</time>
              <span className="campus-feed-dot" data-tone="system" />
              <span>Waiting for the first event</span>
            </li>
          ) : (
            model.feed.map((item) => (
              <li key={item.id}>
                <time dateTime={item.at}>{clockOf(item.offsetMs)}</time>
                <span className="campus-feed-dot" data-tone={item.tone} />
                <span className="campus-feed-text">{item.text}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </section>
  );
}
