import type { RunEvent } from "@dejaml/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendEvents, EMPTY_LOG } from "../lib/event-log";
import type { ReportSummary } from "../lib/run-client";
import { byType, labOne, makeEvent, studyEvents, until } from "../test/stream";
import { LiveRun } from "./LiveRun";

afterEach(() => {
  document.body.innerHTML = "";
});

const logOf = (events: readonly RunEvent[]) => appendEvents(EMPTY_LOG, events);
const props = { runId: studyEvents[0]!.runId, connection: "live" as const, reportHref: "/api/runs/r/report", onDownload: () => undefined };
const cards = (role: string) => screen.getAllByTestId("agent-card").filter((card) => card.getAttribute("data-role") === role);
const finalReport: ReportSummary = {
  paperValue: 81.66,
  observedValue: 79.88,
  signedDifference: -1.78,
  tolerance: 2,
  unit: "percent",
  verdict: "reproduced_within_tolerance",
  checks: [{ name: "approved command", passed: true, explanation: "The approved official command ran in the sealed lab and exited 0." }],
  hypotheses: [],
  reviews: [
    {
      engineer: "engineer-1",
      verdict: "approve",
      equivalence: "equivalent",
      summary: "The approved official command ran and wrote the metric.",
      concerns: [],
    },
    { engineer: "engineer-2", verdict: "approve", equivalence: "equivalent", summary: null, concerns: [] },
  ],
};

describe("Live Run Dashboard", () => {
  it("shows every agent instance as its own card: two engineers, two cards", () => {
    render(<LiveRun {...props} log={logOf(until(byType("agent_turn", (event) => event.publicPayload.label === "engineer-2")))} />);
    const engineers = cards("lab_engineer");
    expect(engineers).toHaveLength(2);
    expect(within(engineers[0]!).getByText("engineer-1")).toBeTruthy();
    expect(within(engineers[1]!).getByText("engineer-2")).toBeTruthy();
    expect(within(engineers[1]!).getByText("Using a tool")).toBeTruthy();
    expect(within(engineers[1]!).getByText(/agt_[a-f0-9]{6}/u)).toBeTruthy();
    expect(within(engineers[1]!).getByText("Tool calls")).toBeTruthy();
  });

  it("keeps earlier agents and evidence visible as the study moves into the lab and review", () => {
    const { rerender } = render(<LiveRun {...props} log={logOf(until(byType("agent_turn")))} />);
    expect(within(cards("paper_analyst")[0]!).getByText("Using a tool")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Virtual Lab" })).toBeTruthy();

    rerender(<LiveRun {...props} log={logOf(until(byType("lab_output")))} />);
    expect(within(cards("paper_analyst")[0]!).getByText("Done")).toBeTruthy();
    expect(within(cards("reproduction_planner")[0]!).getByText("Done")).toBeTruthy();
    expect(screen.getByText(/Policy review approved the plan/u)).toBeTruthy();

    rerender(
      <LiveRun {...props} log={logOf(until(byType("agent_turn", (event) => event.publicPayload.role === "independent_reviewer")))} />,
    );
    // Reviewers are visible and reviewing; analysts, planner, engineers and the plan approval are all still on screen.
    expect(within(cards("independent_reviewer")[0]!).getByText("Reviewing")).toBeTruthy();
    expect(cards("paper_analyst")).toHaveLength(1);
    expect(cards("lab_engineer")).toHaveLength(2);
    expect(screen.getByText(/Policy review approved the plan/u)).toBeTruthy();
    expect(screen.getByTestId("current-stage").textContent).toBe("Independent review");
  });

  it("says why waiting agents wait, without animating them as working", () => {
    render(<LiveRun {...props} log={logOf(until(byType("agent_turn")))} />);
    const planner = cards("reproduction_planner")[0]!;
    expect(planner.getAttribute("data-status")).toBe("waiting");
    expect(within(planner).getByTestId("waiting-reason").textContent).toBe(
      "Waiting for the Paper Analyst and the Repository Analyst to finish.",
    );
    expect(planner.querySelector(".agent-dot")?.getAttribute("data-status")).toBe("waiting");
    expect(within(cards("lab_engineer")[0]!).getByTestId("waiting-reason").textContent).toBe("Waiting for an approved plan.");
    expect(within(cards("independent_reviewer")[0]!).getByTestId("waiting-reason").textContent).toBe(
      "Waiting for execution evidence from the Lab Engineers.",
    );
    expect(within(cards("supervisor")[0]!).getByTestId("waiting-reason").textContent).toMatch(/^Waits for checkpoints/u);
    expect(screen.getByTestId("debugger-note").textContent).toMatch(/only if a Lab Engineer asks for help/u);
    expect(screen.getByTestId("lab-waiting").textContent).toBe("Waiting for an approved plan.");
  });

  it("streams live terminal output, resource use, and the approved command into the engineer's lab", () => {
    const base = until(byType("lab_output", (event) => event.publicPayload.labId === labOne));
    const next = base.at(-1)!.sequence + 1;
    const { rerender } = render(<LiveRun {...props} log={logOf(base)} />);
    const terminal = screen.getByLabelText("Lab output for engineer-1");
    expect(terminal.textContent).toContain("stand-in progress 2/3");
    expect(screen.getByText("Running a command")).toBeTruthy();
    expect(screen.getByTestId("network-state").textContent).toContain("Off (no network interface)");

    rerender(
      <LiveRun
        {...props}
        log={logOf([
          ...base,
          makeEvent(next, {
            type: "lab_telemetry",
            actor: "lab_engineer",
            publicPayload: {
              labId: labOne,
              elapsedMs: 3000,
              cpuPercent: 150,
              memoryBytes: 300 * 1024 * 1024,
              memoryLimitBytes: 2048 * 1024 * 1024,
              pids: 12,
              limits: { cpus: 2, pids: 256 },
            },
          }),
          makeEvent(next + 1, {
            type: "lab_output",
            actor: "lab_engineer",
            publicPayload: { labId: labOne, stream: "stderr", lines: ["warning: slow"] },
          }),
        ])}
      />,
    );
    expect(screen.getByLabelText("Lab output for engineer-1").textContent).toContain("warning: slow");
    expect(screen.getByRole("meter", { name: "CPU" }).getAttribute("aria-valuenow")).toBe("150");
    expect(screen.getByRole("meter", { name: "Processes" }).getAttribute("aria-valuemax")).toBe("256");
    expect(screen.getByText("12 of 256")).toBeTruthy();
  });

  it("says how much terminal output it no longer shows", () => {
    const base = until(byType("lab_output", (event) => event.publicPayload.labId === labOne));
    let sequence = base.at(-1)!.sequence;
    const flood = Array.from({ length: 30 }, () =>
      makeEvent(++sequence, {
        type: "lab_output",
        actor: "lab_engineer",
        publicPayload: { labId: labOne, stream: "stdout", lines: Array.from({ length: 100 }, (_, index) => `epoch ${sequence}.${index}`) },
      }),
    );
    render(
      <LiveRun
        {...props}
        log={logOf([
          ...base,
          ...flood,
          makeEvent(++sequence, {
            type: "lab_output",
            actor: "lab_engineer",
            status: "warning",
            publicPayload: { labId: labOne, droppedLines: 50 },
          }),
        ])}
      />,
    );
    const notice = screen.getByTestId("terminal-truncation").textContent ?? "";
    expect(notice).toMatch(/2,052 earlier lines are not shown here; the server kept them in the bounded attempt log/u);
    expect(screen.getByLabelText("Lab output for engineer-1").textContent?.split("\n").filter(Boolean)).toHaveLength(1_000);
  });

  it("filters the stream by agent instance and by event type", () => {
    render(<LiveRun {...props} log={logOf(studyEvents)} report={finalReport} />);
    const stream = screen.getByTestId("stream-list");
    const engineer2 = cards("lab_engineer")[1]!;
    fireEvent.click(within(engineer2).getByRole("button", { name: /Show only Lab Engineer engineer-2 activity/u }));
    const rows = within(stream).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((row) => !row.textContent?.includes("engineer-1"))).toBe(true);
    expect(rows.some((row) => row.textContent?.includes("engineer-2 ran the approved command"))).toBe(true);

    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^Tool calls/u }));
    expect(within(stream).queryAllByText(/turn \d: /u)).toEqual([]);
    expect(within(stream).getByText(/Policy review approved the plan/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Tool calls/u }));
    expect(within(stream).getAllByText(/turn \d: /u).length).toBeGreaterThan(5);
  });

  it("stops following when the viewer scrolls back, without snapping to new events", () => {
    const early = until(byType("plan_approved"));
    const { rerender } = render(<LiveRun {...props} log={logOf(early)} />);
    const list = screen.getByTestId("stream-list");
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 400 });
    list.scrollTop = 200;
    fireEvent.scroll(list);
    expect(screen.getByRole("button", { name: "Follow live" })).toBeTruthy();
    rerender(<LiveRun {...props} log={logOf(until(byType("lab_ready")))} />);
    expect(list.scrollTop).toBe(200);
    expect(screen.getByRole("button", { name: /new events · Jump to latest/u })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Jump to latest/u }));
    expect(list.scrollTop).toBe(2000);
    expect(screen.getByRole("button", { name: "Pause follow" })).toBeTruthy();
  });

  it("opens an evidence reference and shows it in the Virtual Lab", () => {
    render(<LiveRun {...props} log={logOf(studyEvents)} report={finalReport} />);
    const stream = screen.getByTestId("stream-list");
    const exported = within(stream)
      .getAllByText(/Exported artifacts\/result\.json/u)[1]!
      .closest("li")!;
    fireEvent.click(within(exported).getByRole("button", { name: /Artifact artifacts\/result\.json/u }));
    const detail = screen.getByRole("region", { name: "Evidence detail" });
    expect(within(detail).getByText(/^[a-f0-9]{64}$/u)).toBeTruthy();
    fireEvent.click(within(detail).getByRole("button", { name: "Show in the Virtual Lab" }));
    expect(screen.getByRole("tab", { name: "engineer-2" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('.artifact-list li[data-highlight="true"]')?.textContent).toContain("artifacts/result.json");
  });

  it("shows the final result: values, delta, reviewer verdicts, deterministic status, report, and cleanup", () => {
    const onNewStudy = vi.fn();
    render(<LiveRun {...props} connection="closed" log={logOf(studyEvents)} report={finalReport} onNewStudy={onNewStudy} />);
    const result = screen.getByRole("region", { name: /Result/u });
    expect(within(result).getByText("Reproduced")).toBeTruthy();
    expect(screen.getByTestId("paper-value").textContent).toBe("81.66%");
    expect(screen.getByTestId("observed-value").textContent).toBe("79.88%");
    expect(screen.getByTestId("delta-value").textContent).toBe("-1.78 points");
    expect(screen.getByTestId("tolerance-value").textContent).toBe("±2 points");
    expect(within(screen.getByTestId("review-verdicts")).getAllByText("Approved")).toHaveLength(2);
    expect(screen.getByTestId("result-reasons").textContent).toContain("within tolerance");
    const cleanup = screen.getByTestId("cleanup-verification");
    expect(within(cleanup).getByText("Cleanup verified")).toBeTruthy();
    expect(cleanup.textContent).toContain("2 of 2 labs verified absent");
    expect(screen.getByRole("link", { name: "Download report" }).getAttribute("href")).toBe("/api/runs/r/report");
    expect(screen.getByTestId("connection-status").textContent).toBe("Run complete");
    expect(screen.queryByRole("button", { name: "Cancel study" })).toBeNull();
    // Each lab's own cleanup stays visible in the Virtual Lab.
    expect(screen.getByTestId("lab-cleanup").textContent).toContain("verified absent");
    fireEvent.click(screen.getByRole("button", { name: "New study" }));
    expect(onNewStudy).toHaveBeenCalledOnce();
  });

  it("shows reconnecting, cancellation requests, and a cancelled study's cleanup", () => {
    const onCancel = vi.fn();
    const running = until(byType("lab_output", (event) => event.publicPayload.labId === labOne));
    const { rerender } = render(<LiveRun {...props} connection="reconnecting" log={logOf(running)} onCancel={onCancel} />);
    expect(screen.getByTestId("connection-status").textContent).toBe("Reconnecting…");
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Cancel study" })[0]!);
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeTruthy();

    let sequence = running.at(-1)!.sequence;
    const tail = [
      makeEvent(++sequence, { type: "lab_cancel", actor: "lab_engineer", publicPayload: { labId: labOne } }),
      makeEvent(++sequence, {
        type: "agent_command",
        actor: "lab_engineer",
        status: "failed",
        publicPayload: { labId: labOne, step: 6, agent: "engineer-1", exitCode: null, timedOut: false },
      }),
      makeEvent(++sequence, {
        type: "lab_cleanup",
        actor: "lab_engineer",
        status: "completed",
        summary: "Disposable lab removed",
        publicPayload: { labId: labOne, verifiedAbsent: true, containerRemoved: true },
      }),
      makeEvent(++sequence, {
        type: "study_cleanup",
        status: "completed",
        summary: "Destroyed 2 lab(s) and removed prepared files; nothing from this study is left running",
        publicPayload: {
          verified: true,
          labs: [{ verifiedAbsent: true }, { verifiedAbsent: true }],
          dependenciesRemoved: true,
          datasetsRemoved: true,
          workDirRemoved: true,
          leftoverContainers: [],
          leftoverNetworks: [],
          liveAgents: [],
        },
      }),
      makeEvent(++sequence, {
        type: "study_result",
        status: "warning",
        summary: "Result: cancelled",
        publicPayload: { status: "cancelled", reasons: ["the study was cancelled"] },
      }),
      makeEvent(++sequence, {
        type: "run_finished",
        status: "warning",
        summary: "Study finished: cancelled",
        publicPayload: { runStatus: "cancelled", verdict: null },
      }),
    ];
    rerender(<LiveRun {...props} connection="closed" log={logOf([...running, ...tail])} onCancel={onCancel} />);
    expect(within(screen.getByRole("region", { name: /Result/u })).getByText("Cancelled")).toBeTruthy();
    expect(screen.getByTestId("current-stage").textContent).toBe("Finished: cancelled");
    expect(within(screen.getByTestId("cleanup-verification")).getByText("Cleanup verified")).toBeTruthy();
  });
});
