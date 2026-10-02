import { describe, expect, it } from "vitest";
import { DEFAULT_PRICES, PriceTableError, estimateCostUsd, parsePriceTable } from "./pricing.js";

describe("pricing", () => {
  it("builds in no prices, so nothing is guessed", () => {
    expect(DEFAULT_PRICES).toEqual({});
  });

  it("estimates cost, falling back to the input rate for cache reads without a cache price", () => {
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { inputPerMTok: 4, outputPerMTok: 20 })).toBe(24);
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, { inputPerMTok: 1, outputPerMTok: 5 })).toBe(1);
    expect(estimateCostUsd({ inputTokens: 10, outputTokens: 10 }, undefined)).toBeNull();
  });

  it("parses and validates an administrator price table", () => {
    expect(parsePriceTable('{"gpt-x":{"inputPerMTok":1,"outputPerMTok":2}}')).toEqual({ "gpt-x": { inputPerMTok: 1, outputPerMTok: 2 } });
    expect(() => parsePriceTable("nope")).toThrow(PriceTableError);
    expect(() => parsePriceTable('{"gpt-x":{"inputPerMTok":-1,"outputPerMTok":2}}')).toThrow(/DEJAML_MODEL_PRICES/);
    expect(() => parsePriceTable('{"gpt-x":{"inputPerMTok":1}}')).toThrow(PriceTableError);
    expect(() => parsePriceTable('{"bad name":{"inputPerMTok":1,"outputPerMTok":2}}')).toThrow(PriceTableError);
  });
});
