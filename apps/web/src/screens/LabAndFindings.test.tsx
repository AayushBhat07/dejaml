import type { RunEvent } from "@dejaml/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import recorded from "../../../../fixtures/events/urban-land-cover-success.json";
import { Findings } from "./Findings";
import { VirtualLab } from "./VirtualLab";

const events = recorded as RunEvent[];
const until = (type: string, status: RunEvent["status"]) =>
  events.slice(0, events.findIndex((event) => event.type === type && event.status === status) + 1);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("VirtualLab", () => {
  it("shows the approved command, isolation, and a cancel action while running", () => {
    const cancel = vi.fn();
    render(<VirtualLab events={until("attempt", "started")} onCancel={cancel} />);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText(/python runner\.py --training data\/training\.csv/u)).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("shows output, resources, artifact digest, and cleanup when finished", () => {
    render(<VirtualLab events={events} onCancel={() => undefined} />);
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    expect(within(screen.getByLabelText("Lab output")).getByText(/DEJAML_ARTIFACT=/u)).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Memory" })).toBeTruthy();
    expect(screen.getByText(/sha256 [a-f0-9]{12}…/u)).toBeTruthy();
    expect(screen.getByText("Cleaned up")).toBeTruthy();
  });
});

describe("Findings", () => {
  it("compares paper and observed values with checks, hypotheses, and cleanup", () => {
    const download = vi.fn();
    render(<Findings events={events} onDownload={download} reportHref={null} />);
    expect(screen.getByText("Different result")).toBeTruthy();
    expect(screen.getByText("81.66%")).toBeTruthy();
    expect(screen.getByText("79.88%")).toBeTruthy();
    expect(screen.getByText("-1.78")).toBeTruthy();
    expect(screen.getAllByText("Hypothesis").length).toBe(5);
    expect(screen.getByText(/does not identify the seed/u)).toBeTruthy();
    expect(screen.getByText("Lab removed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download report" }));
    expect(download).toHaveBeenCalledOnce();
  });

  it("links to the server report in live mode and waits before a verdict exists", () => {
    render(<Findings events={events} onDownload={() => undefined} reportHref="/api/runs/r1/report" />);
    expect(screen.getByRole("link", { name: "Download report" }).getAttribute("href")).toBe("/api/runs/r1/report");
    document.body.innerHTML = "";
    render(<Findings events={until("attempt", "completed")} onDownload={() => undefined} reportHref={null} />);
    expect(screen.getByText(/still checking/u)).toBeTruthy();
  });
});
