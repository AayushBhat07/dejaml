import type { RunEvent } from "@dejaml/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { studyEvents } from "../test/stream";
import { labViewFor } from "./lab";
import { HttpRunClient, RECONNECT_DELAYS_MS, ReplayRunClient, summarizeReport, type ConnectionState } from "./run-client";

describe("ReplayRunClient", () => {
  it("replays in order and stops the lab when cancelled mid-attempt", async () => {
    const client = new ReplayRunClient(1);
    const { runId } = await client.createRun(new File(["%PDF-"], "p.pdf"));
    const events: RunEvent[] = [];
    const stop = client.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (events.some((event) => event.type === "attempt" && event.status === "started")) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });
    await client.cancel(runId);
    const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    expect(events.length).toBe(count);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.every((event) => event.runId === runId)).toBe(true);
    expect(labViewFor(events)).toMatchObject({ phase: "cancelled", cleanup: { clean: true } });
  });
});

/** A stand-in for the browser's EventSource that the test drives by hand. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  send(event: RunEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }
  /** The browser lost the connection and will retry by itself (sending Last-Event-ID). */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }
  /** The browser gave up on this stream. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe("HttpRunClient streaming", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeEventSource.instances = [];
  });

  it("resumes after the last sequence, never delivers an event twice, and reconnects after a closed stream", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const client = new HttpRunClient("/api");
    const received: number[] = [];
    const states: ConnectionState[] = [];
    const stop = client.subscribe("run_x", 3, {
      onEvent: (event) => received.push(event.sequence),
      onStatus: (state) => states.push(state),
    });

    const first = FakeEventSource.instances[0]!;
    expect(first.url).toBe("/api/runs/run_x/events?after=3");
    first.open();
    for (const event of studyEvents.slice(2, 8)) first.send(event); // 3 is already known; 4..8 are new
    first.send(studyEvents[5]!); // a duplicate
    expect(received).toEqual([4, 5, 6, 7, 8]);

    // A dropped connection the browser retries by itself: no new stream; it resumes with Last-Event-ID.
    first.drop();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(states.at(-1)).toBe("reconnecting");
    first.open();
    first.send(studyEvents[6]!); // replayed after the browser's reconnect
    first.send(studyEvents[8]!);
    expect(received).toEqual([4, 5, 6, 7, 8, 9]);

    // The browser gave up: the page opens a new stream after the last sequence it has, with backoff.
    first.fail();
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]!);
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toBe("/api/runs/run_x/events?after=9");
    second.fail();
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]!);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[1]! - RECONNECT_DELAYS_MS[0]!);
    const third = FakeEventSource.instances[2]!;
    third.open();
    third.send(studyEvents[9]!);
    expect(received.at(-1)).toBe(10);
    expect(states).toEqual([
      "connecting",
      "live",
      "reconnecting",
      "live",
      "reconnecting",
      "reconnecting",
      "reconnecting",
      "reconnecting",
      "live",
    ]);

    stop();
    expect(third.readyState).toBe(FakeEventSource.CLOSED);
    expect(states.at(-1)).toBe("closed");
    third.fail();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("reports an event it cannot read instead of passing it on", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const errors: string[] = [];
    const received: RunEvent[] = [];
    new HttpRunClient().subscribe("run_x", 0, { onEvent: (event) => received.push(event), onError: (message) => errors.push(message) });
    FakeEventSource.instances[0]!.onmessage?.({ data: "{not json" } as MessageEvent<string>);
    FakeEventSource.instances[0]!.onmessage?.({ data: JSON.stringify({ sequence: 1 }) } as MessageEvent<string>);
    expect(received).toEqual([]);
    expect(errors).toHaveLength(2);
  });
});

describe("summarizeReport", () => {
  it("reads only the public comparison, reviews, and checks from a server report", () => {
    const summary = summarizeReport({
      assessment: {
        paperValue: 81.66,
        observedValue: 79.88,
        signedDifference: -1.78,
        tolerance: 2,
        verdict: "reproduced_within_tolerance",
        checks: [{ name: "approved command", passed: true, explanation: "ran" }],
        discrepancyHypotheses: [],
      },
      study: {
        contract: { metric: { unit: "percent" } },
        result: { paperValue: 81.66, observedValue: 79.88, tolerance: 2 },
        engineers: [
          { label: "engineer-1", review: { verdict: "approve", equivalence: "equivalent", summary: "ok", concerns: [] } },
          { label: "engineer-2", review: null },
        ],
        board: [{ payload: { secret: "never read" } }],
      },
    });
    expect(summary).toEqual({
      paperValue: 81.66,
      observedValue: 79.88,
      signedDifference: -1.78,
      tolerance: 2,
      unit: "percent",
      verdict: "reproduced_within_tolerance",
      checks: [{ name: "approved command", passed: true, explanation: "ran" }],
      hypotheses: [],
      reviews: [{ engineer: "engineer-1", verdict: "approve", equivalence: "equivalent", summary: "ok", concerns: [] }],
    });
    expect(summarizeReport(null)).toBeNull();
  });
});
