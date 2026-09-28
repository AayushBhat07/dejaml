import type { RunEvent } from "@dejaml/contracts";

import { Badge, type Tone } from "../components/Badge";

export const ROLE_LABELS: Record<RunEvent["actor"], string> = {
  system: "DéjàML",
  paper_analyst: "Paper Analyst",
  code_analyst: "Code Analyst",
  lead_researcher: "Lead Researcher",
  lab_engineer: "Lab Engineer",
  result_verifier: "Result Verifier",
};

export const STATUS_TONES: Record<RunEvent["status"], Tone> = {
  started: "accent",
  progress: "neutral",
  completed: "positive",
  warning: "warning",
  failed: "negative",
};

/** Ordered public activity for a run. Later sub-phases replace this with dedicated screens. */
export function RunActivity({ events }: { events: readonly RunEvent[] }) {
  if (events.length === 0) return <p className="muted">Waiting for the first update…</p>;
  return (
    <ol className="timeline" aria-label="Study activity">
      {events.map((event) => (
        <li key={event.id} className="timeline-item">
          <span className="timeline-actor">{ROLE_LABELS[event.actor]}</span>
          <span>{event.summary}</span>
          <Badge tone={STATUS_TONES[event.status]}>{event.status}</Badge>
        </li>
      ))}
    </ol>
  );
}
