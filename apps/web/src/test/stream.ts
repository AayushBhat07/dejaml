import type { RunEvent } from "@dejaml/contracts";

import captured from "./stand-in-study-events.json";

/**
 * A real event stream from the API's multi-agent study (two Lab Engineers,
 * two Independent Reviewers), captured over SSE from
 * apps/web/scripts/stand-in-study-server.mjs. The study code, agent runtime,
 * policy review, and Lab Manager are real; the model, GitHub, and Docker are
 * the API's scripted stand-ins, so every id, digest, and value in it is fake.
 */
export const studyEvents = captured as RunEvent[];

/** The stream up to and including the first event that matches. */
export function until(match: (event: RunEvent) => boolean, events: readonly RunEvent[] = studyEvents): RunEvent[] {
  const index = events.findIndex(match);
  if (index < 0) throw new Error("no event matches");
  return events.slice(0, index + 1);
}

export const byType =
  (type: string, extra: (event: RunEvent) => boolean = () => true) =>
  (event: RunEvent): boolean =>
    event.type === type && extra(event);

/** Builds an event shaped like the server's, for cases the captured run does not cover. */
export function makeEvent(sequence: number, partial: Partial<RunEvent> & Pick<RunEvent, "type">): RunEvent {
  return {
    id: `evt_test_${sequence}`,
    runId: studyEvents[0]!.runId,
    sequence,
    timestamp: new Date(Date.parse("2026-10-01T15:20:00.000Z") + sequence * 1000).toISOString(),
    actor: "system",
    status: "progress",
    summary: partial.type,
    evidence: [],
    publicPayload: {},
    ...partial,
  };
}

export const engineerOne = studyEvents.find((event) => event.type === "agent_started" && event.publicPayload.label === "engineer-1")!;
export const labOne = String(
  studyEvents.find((event) => event.type === "agent_command" && event.publicPayload.agent === "engineer-1")!.publicPayload.labId,
);
