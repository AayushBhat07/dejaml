import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RunStore } from "./index.js";

describe("RunStore", () => {
  let store: RunStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it("persists ordered events and replays from a sequence", () => {
    store = new RunStore();
    store.createRun({ filename: "paper.pdf" }, "run_demo");
    store.appendEvent({
      runId: "run_demo",
      actor: "paper_analyst",
      type: "analysis_started",
      status: "started",
      summary: "Paper analysis started",
      evidence: [],
      publicPayload: {},
    });
    store.appendEvent({
      runId: "run_demo",
      actor: "code_analyst",
      type: "analysis_started",
      status: "started",
      summary: "Code analysis started",
      evidence: [],
      publicPayload: {},
    });

    expect(store.listEvents("run_demo").map((event) => event.sequence)).toEqual([
      1, 2,
    ]);
    expect(store.listEvents("run_demo", 1).map((event) => event.actor)).toEqual([
      "code_analyst",
    ]);
  });

  it("notifies live subscribers", () => {
    store = new RunStore();
    store.createRun({}, "run_live");
    const listener = vi.fn();
    const unsubscribe = store.subscribe("run_live", listener);

    const event = store.appendEvent({
      runId: "run_live",
      actor: "lead_researcher",
      type: "plan_started",
      status: "started",
      summary: "Reconciling paper and code evidence",
      evidence: [],
      publicPayload: {},
    });

    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
  });

  it("restores run events after reopening a file-backed store", () => {
    const directory = mkdtempSync(join(tmpdir(), "dejaml-run-store-"));
    const databasePath = join(directory, "runs.sqlite");
    try {
      store = new RunStore(databasePath);
      store.createRun({ filename: "paper.pdf" }, "run_restore");
      store.appendEvent({
        runId: "run_restore",
        actor: "paper_analyst",
        type: "claim_found",
        status: "completed",
        summary: "Found a paper claim",
        evidence: [{ kind: "paper_page", reference: "page 4" }],
        publicPayload: { value: 81.66 },
      });
      store.close();

      store = new RunStore(databasePath);
      expect(store.getRun("run_restore").input.filename).toBe("paper.pdf");
      expect(store.listEvents("run_restore")).toHaveLength(1);
    } finally {
      store?.close();
      store = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces the run state machine", () => {
    store = new RunStore();
    store.createRun({}, "run_state");
    expect(store.transitionRun("run_state", "ingesting").status).toBe("ingesting");
    expect(() => store?.transitionRun("run_state", "running")).toThrow(
      "invalid run transition",
    );
  });

  it("does not allow terminal runs to transition", () => {
    store = new RunStore();
    store.createRun({}, "run_terminal");
    store.transitionRun("run_terminal", "failed");
    expect(() => store?.transitionRun("run_terminal", "ingesting")).toThrow(
      "cannot transition terminal run",
    );
  });
});
