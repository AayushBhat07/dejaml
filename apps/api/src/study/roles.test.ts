import { DEFAULT_AGENT_LIMITS } from "@dejaml/agent-runtime";
import { describe, expect, it } from "vitest";

import { contextLimits } from "./roles.js";

describe("limits for a small context window", () => {
  it("rolls a 48k-token conversation over well before the window is full", () => {
    const limits = contextLimits(49_152);
    // At 3 characters a token the kept conversation is about 24.6k tokens; one turn adds at most 6k.
    expect(limits.maxContextChars / 3 + limits.maxTurnOutputTokens).toBeLessThan(49_152 * 0.8);
    expect(limits.maxToolResultChars).toBeLessThanOrEqual(limits.maxContextChars / 6);
  });

  it("fits a 32k-token window, where the Reviewer overflowed at 35,878 tokens", () => {
    const limits = contextLimits(32_768);
    expect(limits.maxContextChars / 3 + limits.maxTurnOutputTokens).toBeLessThan(32_768 * 0.8);
  });

  it("never raises a limit above the default for a large window", () => {
    const limits = contextLimits(1_000_000);
    expect(limits.maxContextChars).toBe(DEFAULT_AGENT_LIMITS.maxContextChars);
    expect(limits.maxToolResultChars).toBe(DEFAULT_AGENT_LIMITS.maxToolResultChars);
    expect(limits.maxTurnOutputTokens).toBe(DEFAULT_AGENT_LIMITS.maxTurnOutputTokens);
  });
});
