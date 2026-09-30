import type { RunEvent } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";

import recorded from "../../../../fixtures/events/urban-land-cover-success.json";
import { buildReport, findingsFor, labViewFor, MAX_TERMINAL_LINES, studyResultFor } from "./lab";

const events = recorded as RunEvent[];
const until = (type: string, status: RunEvent["status"]) =>
  events.slice(0, events.findIndex((event) => event.type === type && event.status === status) + 1);

describe("labViewFor", () => {
  it("follows the recorded lab from creation to cleanup", () => {
    expect(labViewFor(until("plan_approved", "completed")).phase).toBe("waiting");
    const running = labViewFor(until("attempt", "started"));
    expect(running.phase).toBe("running");
    expect(running.command?.args).toContain("artifacts/result.json");
    expect(running.isolation).toMatchObject({ network: "none", readOnlyRoot: true, cpus: 2, memoryMb: 2048 });

    const done = labViewFor(events);
    expect(done).toMatchObject({ phase: "finished", exitCode: 0, cleanup: { clean: true } });
    expect(done.lines.map((line) => line.text)).toContain("DEJAML_ARTIFACT=/workspace/case/artifacts/result.json");
    expect(done.telemetry.length).toBeGreaterThanOrEqual(2);
    expect(done.artifacts).toEqual([
      expect.objectContaining({ path: "artifacts/result.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    ]);
  });

  it("reports timeouts and keeps only the newest terminal lines", () => {
    const base = events[0]!;
    const make = (sequence: number, type: string, status: RunEvent["status"], publicPayload: Record<string, unknown>): RunEvent => ({
      ...base,
      id: `e${sequence}`,
      sequence,
      actor: "lab_engineer",
      type,
      status,
      summary: type,
      evidence: [],
      publicPayload,
    });
    const lines = Array.from({ length: MAX_TERMINAL_LINES + 20 }, (_, index) => `line ${index}`);
    const view = labViewFor([
      make(1, "attempt", "started", { executable: "python", args: [], cwd: "/workspace/case" }),
      make(2, "lab_output", "progress", { stream: "stderr", lines }),
      make(3, "lab_output", "warning", { droppedLines: 7 }),
      make(4, "attempt", "failed", { timedOut: true, exitCode: null }),
    ]);
    expect(view.phase).toBe("timed_out");
    expect(view.lines).toHaveLength(MAX_TERMINAL_LINES);
    expect(view.lines.at(-1)).toMatchObject({ stream: "stderr", text: `line ${MAX_TERMINAL_LINES + 19}` });
    expect(view.heldBackLines).toBe(27);
  });
});

describe("findings and report", () => {
  it("reads the verifier's assessment and builds a labelled report", () => {
    const findings = findingsFor(events);
    expect(findings?.assessment).toMatchObject({ verdict: "different_result", signedDifference: -1.78, tolerance: 1 });
    expect(findings?.unit).toBe("percent");
    expect(findingsFor(until("attempt", "completed"))).toBeNull();

    const report = buildReport("run_x", events, { kind: "prepared" });
    expect(report.source).toBe("example replay (nothing was executed)");
    expect(report.verdict).toBe("different_result");
    expect(report.lab.cleanup).toEqual({ clean: true, summary: "Disposable lab removed" });
    expect(report.events).toHaveLength(events.length);
    expect(buildReport("run_x", events, { kind: "recorded", runId: "run_real", recordedAt: "2026-09-29T10:00:00Z" }).source).toBe(
      "recorded run run_real from 2026-09-29T10:00:00Z, replayed (nothing was executed now)",
    );
    expect(buildReport("run_x", events, null).source).toBe("live run");
  });
});

describe("studyResultFor", () => {
  it("accepts every final study status, including failed and cancelled", () => {
    for (const status of [
      "reproduced",
      "partially_reproduced",
      "not_reproduced",
      "inconclusive",
      "policy_blocked",
      "failed",
      "cancelled",
    ]) {
      const event = { type: "study_result", publicPayload: { status, reasons: ["r"] } } as unknown as RunEvent;
      expect(studyResultFor([event])).toEqual({ status, reasons: ["r"] });
    }
    expect(studyResultFor([{ type: "study_result", publicPayload: { status: "raised" } } as unknown as RunEvent])).toBeNull();
  });
});
