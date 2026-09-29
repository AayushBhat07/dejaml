import type { RunEvent } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";

import recorded from "../../../../fixtures/events/urban-land-cover-success.json";
import { stageForEvents, stageForStatus } from "./stages";

const events = recorded as RunEvent[];

describe("stages", () => {
  it("follows the recorded run through the product stages", () => {
    const labStart = events.findIndex((event) => event.actor === "lab_engineer");
    const verifierStart = events.findIndex((event) => event.actor === "result_verifier");
    expect(stageForEvents(events.slice(0, labStart))).toBe("research_team");
    expect(stageForEvents(events.slice(0, labStart + 1))).toBe("virtual_lab");
    expect(stageForEvents(events.slice(0, verifierStart + 1))).toBe("findings");
  });

  it("maps every run status", () => {
    expect(stageForStatus("analyzing")).toBe("research_team");
    expect(stageForStatus("running")).toBe("virtual_lab");
    expect(stageForStatus("timed_out")).toBe("findings");
  });
});
