import { describe, expect, it } from "vitest";

import { findConsensus } from "./lab-reviewer.js";

const values = (...items: Array<[string, number]>) => items.map(([agentName, value]) => ({ agentName, value }));

describe("findConsensus", () => {
  it("agrees when a majority lies within the tolerance and picks the median agent", () => {
    expect(findConsensus(values(["agent-1", 79.9], ["agent-2", 80.4], ["agent-3", 79.2]), 2, 2)).toMatchObject({
      status: "agreed",
      agreeing: ["agent-3", "agent-1", "agent-2"],
      representative: "agent-1",
      spread: 1.2,
    });
  });

  it("keeps the agreeing pair and drops an outlier", () => {
    expect(findConsensus(values(["agent-1", 79.9], ["agent-2", 91], ["agent-3", 80.5]), 2, 2)).toMatchObject({
      status: "agreed",
      agreeing: ["agent-1", "agent-3"],
      representative: "agent-1",
    });
  });

  it("reports disagreement and too few results", () => {
    expect(findConsensus(values(["agent-1", 70], ["agent-2", 80], ["agent-3", 90]), 2, 2)).toMatchObject({
      status: "disagreed",
      representative: null,
    });
    expect(findConsensus(values(["agent-1", 80]), 2, 2)).toMatchObject({ status: "insufficient", representative: null });
  });
});
