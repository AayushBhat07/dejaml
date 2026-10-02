import { describe, expect, it } from "vitest";

import { labOne, makeEvent, studyEvents } from "../test/stream";
import { appendEvents, EMPTY_LOG, MAX_OUTPUT_LINE_CHARS, MAX_OUTPUT_LINES_PER_LAB, MAX_TELEMETRY_PER_LAB } from "./event-log";

const output = (sequence: number, lines: string[], labId = labOne) =>
  makeEvent(sequence, {
    type: "lab_output",
    actor: "lab_engineer",
    publicPayload: { labId, attemptId: "a", stream: "stdout", lines, truncatedLines: 0 },
  });

describe("event log", () => {
  it("keeps events in sequence order and each sequence once, however the stream delivers them", () => {
    const shuffled = [studyEvents[4]!, studyEvents[1]!, studyEvents[0]!, studyEvents[3]!, studyEvents[2]!];
    let log = appendEvents(EMPTY_LOG, shuffled);
    expect(log.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    // A reconnect that replays from an older cursor delivers duplicates; nothing is added twice.
    log = appendEvents(log, studyEvents.slice(0, 8));
    expect(log.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(log.lastSequence).toBe(8);
    const same = appendEvents(log, [studyEvents[2]!]);
    expect(same).toBe(log);
    // Late subscriber replay of the whole run, one event at a time.
    let late = EMPTY_LOG;
    for (const event of studyEvents) late = appendEvents(late, [event, event]);
    expect(late.events).toHaveLength(studyEvents.length);
    expect(late.lastSequence).toBe(studyEvents.at(-1)!.sequence);
  });

  it("bounds live terminal output per lab and counts what it no longer keeps", () => {
    let log = EMPTY_LOG;
    let sequence = 1;
    // 3,000 lines in 60 chunks for one lab, 10 for another.
    for (let chunk = 0; chunk < 60; chunk += 1) {
      log = appendEvents(log, [
        output(
          sequence++,
          Array.from({ length: 50 }, (_, index) => `line ${chunk * 50 + index}`),
        ),
      ]);
    }
    log = appendEvents(log, [output(sequence++, ["other lab"], "lab_other")]);
    const kept = log.events
      .filter((event) => event.type === "lab_output" && event.publicPayload.labId === labOne)
      .flatMap((event) => event.publicPayload.lines as string[]);
    expect(kept).toHaveLength(MAX_OUTPUT_LINES_PER_LAB);
    expect(kept.at(-1)).toBe("line 2999");
    expect(kept[0]).toBe(`line ${3000 - MAX_OUTPUT_LINES_PER_LAB}`);
    expect(log.droppedOutputLines[labOne]).toBe(3000 - MAX_OUTPUT_LINES_PER_LAB);
    expect(log.droppedOutputLines.lab_other).toBeUndefined();

    // A dropped chunk delivered again (a replay) is not added back or counted twice.
    const again = appendEvents(log, [output(1, ["line 0"])]);
    expect(again).toBe(log);

    // One enormous line is shortened; one enormous chunk keeps only its newest lines.
    const long = appendEvents(EMPTY_LOG, [output(1, ["x".repeat(MAX_OUTPUT_LINE_CHARS * 5)])]);
    expect((long.events[0]!.publicPayload.lines as string[])[0]!.length).toBeLessThan(MAX_OUTPUT_LINE_CHARS + 40);
    const huge = appendEvents(EMPTY_LOG, [
      output(
        1,
        Array.from({ length: MAX_OUTPUT_LINES_PER_LAB + 7 }, (_, index) => `${index}`),
      ),
    ]);
    expect(huge.droppedOutputLines[labOne]).toBe(7);
  });

  it("keeps only the newest resource samples of each lab", () => {
    const samples = Array.from({ length: MAX_TELEMETRY_PER_LAB + 30 }, (_, index) =>
      makeEvent(index + 1, { type: "lab_telemetry", actor: "lab_engineer", publicPayload: { labId: labOne, elapsedMs: index * 1000 } }),
    );
    const log = appendEvents(EMPTY_LOG, samples);
    expect(log.events).toHaveLength(MAX_TELEMETRY_PER_LAB);
    expect(log.events[0]!.publicPayload.elapsedMs).toBe(30_000);
    expect(log.droppedTelemetry[labOne]).toBe(30);
  });
});
