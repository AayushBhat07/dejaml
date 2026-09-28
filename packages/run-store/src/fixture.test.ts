import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RunEventSchema } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/events/urban-land-cover-success.json", import.meta.url),
);
const FixtureSchema = z.array(RunEventSchema).min(1);

describe("parallel research event fixture", () => {
  it("is schema-valid, ordered, and visibly concurrent", () => {
    const events = FixtureSchema.parse(
      JSON.parse(readFileSync(fixturePath, "utf8")) as unknown,
    );
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );

    const paperStarted = events.findIndex(
      (event) => event.actor === "paper_analyst" && event.status === "started",
    );
    const codeStarted = events.findIndex(
      (event) => event.actor === "code_analyst" && event.status === "started",
    );
    const paperCompleted = events.findIndex(
      (event) => event.actor === "paper_analyst" && event.status === "completed",
    );
    const codeCompleted = events.findIndex(
      (event) => event.actor === "code_analyst" && event.status === "completed",
    );

    expect(paperStarted).toBeGreaterThan(-1);
    expect(codeStarted).toBeGreaterThan(-1);
    expect(codeStarted).toBeLessThan(paperCompleted);
    expect(paperStarted).toBeLessThan(codeCompleted);
  });
});

