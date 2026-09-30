import type { RunEvent } from "@dejaml/contracts";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import recorded from "../../../../fixtures/events/urban-land-cover-success.json";
import { analystsOverlapped, laneFor } from "../lib/lanes";
import { ResearchTeam } from "./ResearchTeam";

const events = recorded as RunEvent[];
const upTo = (type: string, actor: RunEvent["actor"]) =>
  events.slice(0, events.findIndex((event) => event.type === type && event.actor === actor) + 1);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("lanes", () => {
  it("derives role status from the event stream", () => {
    const midway = upTo("repository_found", "paper_analyst");
    expect(laneFor(midway, "paper_analyst").status).toBe("working");
    expect(laneFor(midway, "lead_researcher").status).toBe("waiting");
    expect(laneFor(events, "code_analyst")).toMatchObject({ status: "done", warnings: 1 });
    expect(laneFor([...events.slice(0, 2), { ...events[1]!, id: "x", sequence: 99, status: "failed" }], "paper_analyst").status).toBe(
      "failed",
    );
    expect(analystsOverlapped(events)).toBe(true);
    expect(analystsOverlapped(upTo("analysis_started", "paper_analyst"))).toBe(false);
  });
});

describe("ResearchTeam", () => {
  it("shows both analysts working in parallel while the Lead waits for them", () => {
    render(<ResearchTeam events={upTo("claim_found", "paper_analyst")} />);
    expect(screen.getByText("Analysts working in parallel")).toBeTruthy();
    const lead = screen.getByRole("article", { name: "Lead Researcher" });
    expect(within(lead).getByText("Waiting for Code Analyst to finish.")).toBeTruthy();
    const paper = screen.getByRole("article", { name: "Paper Analyst" });
    expect(within(paper).getByText("Done")).toBeTruthy();
    expect(within(paper).getByText("page 4, Table 2")).toBeTruthy();
    expect(within(paper).getByText("Random Forest — Test Acc. 81.66")).toBeTruthy();
  });

  it("surfaces the reproducibility warning with its code evidence", () => {
    render(<ResearchTeam events={upTo("plan_approved", "lead_researcher")} />);
    const code = screen.getByRole("article", { name: "Code Analyst" });
    expect(within(code).getByText("1 warning")).toBeTruthy();
    expect(within(code).getByText("Urban Land Cover Classification.ipynb#train_test_split")).toBeTruthy();
    const lead = screen.getByRole("article", { name: "Lead Researcher" });
    expect(within(lead).getByText("Approved one deterministic CPU experiment with seed 42")).toBeTruthy();
  });
});
