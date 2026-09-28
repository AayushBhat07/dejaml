import type { RunEvent } from "@dejaml/contracts";

import { Badge, type Tone } from "../components/Badge";
import { EvidenceList } from "../components/Evidence";
import { analystsOverlapped, laneFor, type Lane, type LaneStatus } from "../lib/lanes";
import { ROLE_LABELS, STATUS_TONES } from "../lib/roles";

const ROLE_BRIEFS: Partial<Record<RunEvent["actor"], string>> = {
  paper_analyst: "Reads the paper, finds the repository link, and picks one numeric claim.",
  code_analyst: "Reads the pinned repository and maps the claim to code it can run.",
  lead_researcher: "Reconciles both analyses into one experiment plan and checks it against policy.",
};

const LANE_BADGES: Record<LaneStatus, { label: string; tone: Tone }> = {
  waiting: { label: "Waiting", tone: "neutral" },
  working: { label: "Working", tone: "accent" },
  done: { label: "Done", tone: "positive" },
  failed: { label: "Failed", tone: "negative" },
};

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function RoleLane({ lane, waitingText }: { lane: Lane; waitingText: string }) {
  const badge = LANE_BADGES[lane.status];
  return (
    <article className="lane card" data-status={lane.status} aria-labelledby={`lane-${lane.actor}`}>
      <header className="lane-header">
        <div className="stack-tight">
          <h3 id={`lane-${lane.actor}`}>{ROLE_LABELS[lane.actor]}</h3>
          <p className="muted small">{ROLE_BRIEFS[lane.actor]}</p>
        </div>
        <div className="row-tight">
          {lane.warnings > 0 ? (
            <Badge tone="warning">
              {lane.warnings} warning{lane.warnings === 1 ? "" : "s"}
            </Badge>
          ) : null}
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
      </header>
      {lane.events.length === 0 ? (
        <p className="muted small lane-waiting">{waitingText}</p>
      ) : (
        <ol className="lane-events">
          {lane.events.map((event) => (
            <li key={event.id} className="lane-event" data-status={event.status}>
              <div className="lane-event-head">
                <span>{event.summary}</span>
                <span className="row-tight">
                  <time className="muted small" dateTime={event.timestamp}>
                    {formatTime(event.timestamp)}
                  </time>
                  {event.status === "warning" || event.status === "failed" ? (
                    <Badge tone={STATUS_TONES[event.status]}>{event.status}</Badge>
                  ) : null}
                </span>
              </div>
              <EvidenceList evidence={event.evidence} />
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

export function ResearchTeam({ events }: { events: readonly RunEvent[] }) {
  const paper = laneFor(events, "paper_analyst");
  const code = laneFor(events, "code_analyst");
  const lead = laneFor(events, "lead_researcher");
  const parallel = analystsOverlapped(events);
  const intake = events.filter((event) => event.actor === "system");
  const leadWaiting =
    paper.status === "done" && code.status === "done"
      ? "Both analyses are in. Starting reconciliation…"
      : `Waiting for ${[paper, code]
          .filter((lane) => lane.status !== "done")
          .map((lane) => ROLE_LABELS[lane.actor])
          .join(" and ")} to finish.`;

  return (
    <section className="stack" aria-labelledby="research-title">
      <div className="row space-between">
        <div className="stack-tight">
          <h2 id="research-title">Research Team</h2>
          <p className="muted small">
            {intake[0]?.summary ?? "Setting up the study…"}
          </p>
        </div>
        {parallel ? <Badge tone="accent">Analysts working in parallel</Badge> : null}
      </div>
      <div className="lanes">
        <RoleLane lane={paper} waitingText="Starting soon." />
        <RoleLane lane={code} waitingText="Starts once the repository is acquired." />
      </div>
      <RoleLane lane={lead} waitingText={leadWaiting} />
    </section>
  );
}
