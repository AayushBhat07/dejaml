import type { RunEvent } from "@dejaml/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import recordedRun from "../../../../../fixtures/events/urban-land-cover-success.json";
import { campusModel } from "../../lib/campus";
import { appendEvents, EMPTY_LOG } from "../../lib/event-log";
import { analyzeRun } from "../../lib/live-run";
import { blindedStream, byType, SENTINEL_TEXT, studyEvents, until } from "../../test/stream";
import { LiveRun } from "../../screens/LiveRun";

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = "";
});

const logOf = (events: readonly RunEvent[]) => appendEvents(EMPTY_LOG, events);
const props = { runId: studyEvents[0]!.runId, connection: "live" as const, reportHref: null, onDownload: () => undefined };

describe("campus model", () => {
  it("puts every agent instance in its room: two engineers in the lab, two reviewers at the desk", () => {
    const model = campusModel(analyzeRun(studyEvents), null);
    const zones = (zone: string) => model.agents.filter((agent) => agent.zone === zone).map((agent) => agent.role);
    expect(zones("read")).toEqual(["paper_analyst"]);
    expect(zones("repo")).toEqual(["repository_analyst"]);
    expect(zones("lab").filter((role) => role === "lab_engineer")).toHaveLength(2);
    expect(zones("ver")).toEqual(["independent_reviewer", "independent_reviewer"]);
    // Agents sharing a room stand in different places.
    const engineers = model.agents.filter((agent) => agent.role === "lab_engineer");
    expect(new Set(engineers.map((agent) => agent.slot)).size).toBe(engineers.length);
  });

  it("walks work between rooms only because an event handed it on", () => {
    const early = campusModel(analyzeRun(until(byType("agent_started", (event) => event.actor === "paper_analyst"))), null);
    expect(early.handoffs).toEqual([]);

    const model = campusModel(analyzeRun(studyEvents), null);
    expect(model.handoffs.map((handoff) => `${handoff.carry}:${handoff.from}->${handoff.to}`)).toEqual([
      "claim:read->plan",
      "code:repo->plan",
      "plan:plan->lab",
      "metric:lab->ver",
      "metric:lab->ver",
      "report:ver->store",
    ]);
    const engineerKeys = model.agents.filter((agent) => agent.role === "lab_engineer").map((agent) => agent.key);
    const carriers = model.handoffs.filter((handoff) => handoff.carry === "metric").map((handoff) => handoff.agentKey);
    expect(new Set(carriers)).toEqual(new Set(engineerKeys.filter((key) => carriers.includes(key))));
    expect(new Set(carriers).size).toBe(2);
  });

  it("follows the lab from absent, to running, to destroyed", () => {
    expect(campusModel(analyzeRun(until(byType("plan_approved"))), null).labPresence).toBe("absent");
    const running = campusModel(analyzeRun(until(byType("lab_ready"))), null);
    expect(running.labPresence).toBe("active");
    expect(running.lab?.network).toBe("none");
    const done = campusModel(analyzeRun(studyEvents), null);
    expect(done.labPresence).toBe("removed");
    expect(done.ended).toBe(true);
  });

  it("keeps the paper value sealed in every prefix before the reveal", () => {
    const events = blindedStream();
    const reveal = events.findIndex((event) => event.type === "target_revealed");
    for (let end = 1; end <= reveal; end += 1) {
      const model = campusModel(analyzeRun(events.slice(0, end)), null);
      expect(model.paper.sealed).toBe(true);
      expect(model.paper.value).toBeNull();
      expect(model.delta.value).toBeNull();
      expect(JSON.stringify(model)).not.toMatch(SENTINEL_TEXT);
    }
    const locked = campusModel(analyzeRun(until(byType("observation_locked"), events)), null);
    expect(locked.observed.value).toBe("0.2875");
    expect(locked.observed.foot).toMatch(/^locked/u);

    const revealed = campusModel(analyzeRun(events), null);
    expect(revealed.paper.sealed).toBe(false);
    expect(revealed.paper.value).toMatch(SENTINEL_TEXT);
    expect(revealed.delta.value).not.toBeNull();
    expect(revealed.status).toBe("reproduced");
  });
});

describe("Research Campus", () => {
  it("is the default layout, and the dashboard is one click away", () => {
    render(<LiveRun {...props} log={logOf(studyEvents)} />);
    const campus = screen.getByTestId("research-campus");
    expect(within(campus).getByTestId("campus-status").textContent).toBe("Reproduced");
    expect(within(campus).queryAllByRole("listitem", { current: "step" })).toHaveLength(0);
    expect(screen.queryByTestId("agent-card")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
    expect(screen.queryByTestId("research-campus")).toBeNull();
    expect(screen.getAllByTestId("agent-card").length).toBeGreaterThan(0);
    expect(window.localStorage.getItem("dejaml.liveRunLayout")).toBe("dashboard");
  });

  it("never renders the paper value before the reveal", () => {
    const events = blindedStream();
    const reveal = events.findIndex((event) => event.type === "target_revealed");
    const { rerender } = render(<LiveRun {...props} log={logOf(events.slice(0, 1))} />);
    for (let end = 2; end <= reveal; end += 1) {
      act(() => rerender(<LiveRun {...props} log={logOf(events.slice(0, end))} />));
      expect(screen.getByTestId("campus-paper-value").textContent).toBe("Sealed");
      expect(document.body.innerHTML).not.toMatch(SENTINEL_TEXT);
    }
    act(() => rerender(<LiveRun {...props} log={logOf(events)} />));
    expect(screen.getByTestId("campus-paper-value").textContent).toMatch(SENTINEL_TEXT);
  });

  it("shows an older recording's comparison and verdict once the recording reaches it", () => {
    const events = recordedRun as RunEvent[];
    const compared = events.findIndex((event) => event.type === "comparison_completed");
    const { rerender } = render(<LiveRun {...props} replay log={logOf(events.slice(0, compared))} />);
    // Recorded before blinding existed: hidden until the comparison, but never called sealed.
    expect(screen.getByTestId("campus-paper-value").textContent).toBe("—");
    act(() => rerender(<LiveRun {...props} replay log={logOf(events)} />));
    expect(screen.getByTestId("campus-paper-value").textContent).toBe("81.66%");
    expect(screen.getByTestId("campus-delta-value").textContent).toBe("−1.78 pp");
    expect(screen.getByTestId("campus-status").textContent).not.toBe("");
    const model = campusModel(analyzeRun(events), null);
    expect(model.handoffs.map((handoff) => handoff.carry)).toEqual(["claim", "code", "plan", "metric", "report"]);
  });
});
