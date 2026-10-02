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

/** A paper value that appears only in `target_revealed` (and the comparison after it) of `blindedStream`. */
export const SENTINEL = 0.3141592653589793;
/** What the sentinel looks like as text, rounded or as a percentage. */
export const SENTINEL_TEXT = /0\.314|31\.4/u;
const OBSERVED = 0.2875;

/**
 * The captured study with a fraction metric whose paper value is SENTINEL. The
 * sentinel is only in the events after the blind review is locked, so anything
 * built from an earlier prefix must not contain it.
 */
export function blindedStream(): RunEvent[] {
  const metric = { name: "accuracy", unit: "fraction" };
  return studyEvents.map((event) => {
    const payload = event.publicPayload;
    switch (event.type) {
      case "observation_locked":
        return {
          ...event,
          publicPayload: {
            ...payload,
            metric,
            observed: [
              { engineer: "engineer-1", value: OBSERVED, metricOk: true },
              { engineer: "engineer-2", value: OBSERVED, metricOk: true },
            ],
          },
        };
      case "target_revealed":
        return { ...event, publicPayload: { ...payload, reportedValue: SENTINEL, tolerance: 0.05, metric } };
      case "deterministic_comparison":
        return {
          ...event,
          publicPayload: {
            ...payload,
            comparison: {
              observed: OBSERVED,
              reported: SENTINEL,
              absoluteDelta: Math.abs(OBSERVED - SENTINEL),
              tolerance: 0.05,
              withinTolerance: true,
              rule: "|observed - reported| <= tolerance",
            },
          },
        };
      default:
        return event;
    }
  });
}

export const engineerOne = studyEvents.find((event) => event.type === "agent_started" && event.publicPayload.label === "engineer-1")!;
export const labOne = String(
  studyEvents.find((event) => event.type === "agent_command" && event.publicPayload.agent === "engineer-1")!.publicPayload.labId,
);
