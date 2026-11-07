import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseToolInput } from "./argument-repair.js";

const Parser = z.discriminatedUnion("source", [
  z.object({ source: z.literal("json"), path: z.string().regex(/^artifacts\//u), key: z.string() }),
  z.object({ source: z.literal("stdout"), pattern: z.string().min(3) }),
]);
const Plan = z.object({
  summary: z.string(),
  metricParser: Parser,
  requirements: z.array(z.string()),
  adapter: z.union([z.object({ path: z.string(), content: z.string() }), z.object({ reviewedAdapterId: z.string() })]).nullable(),
  note: z.string(),
});
const good = {
  summary: "plan",
  metricParser: { source: "json", path: "artifacts/result.json", key: "metrics.accuracy" },
  requirements: ["numpy==2.0.0"],
  adapter: { reviewedAdapterId: "runner" },
  note: "{not json but a string field}",
};

describe("parseToolInput", () => {
  it("passes a valid input through unchanged and records no repair", () => {
    const parsed = parseToolInput(Plan, good);
    expect(parsed).toEqual({ success: true, data: good, decoded: [] });
  });

  it("decodes nested objects, unions and arrays that were sent as JSON strings", () => {
    const sent = {
      ...good,
      metricParser: JSON.stringify(good.metricParser),
      requirements: JSON.stringify(good.requirements),
      adapter: ` ${JSON.stringify(good.adapter)} `,
    };
    const parsed = parseToolInput(Plan, sent);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(good);
    expect([...parsed.decoded].sort()).toEqual(["adapter", "metricParser", "requirements"]);
    // The model's own input is never mutated.
    expect(typeof sent.metricParser).toBe("string");
  });

  it("still applies every check to the decoded value", () => {
    const sent = { ...good, metricParser: JSON.stringify({ source: "json", path: "../result.json", key: "k" }) };
    const parsed = parseToolInput(Plan, sent);
    expect(parsed.success).toBe(false);
    // The error describes what the model sent, not the decoded value.
    expect(!parsed.success && parsed.error.issues[0]?.message).toMatch(/expected object/u);
  });

  it("never turns a string field into a structure, and ignores strings that are not JSON", () => {
    expect(parseToolInput(Plan, { ...good, note: "[1, 2]" })).toMatchObject({ success: true, decoded: [] });
    expect(parseToolInput(Plan, { ...good, metricParser: "source=json" }).success).toBe(false);
    expect(parseToolInput(Plan, { ...good, metricParser: "{broken" }).success).toBe(false);
  });
});
