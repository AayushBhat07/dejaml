import type { RunEvent } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";

import { labViewFor } from "./lab";
import { ReplayRunClient } from "./run-client";

describe("ReplayRunClient", () => {
  it("replays in order and stops the lab when cancelled mid-attempt", async () => {
    const client = new ReplayRunClient(1);
    const { runId } = await client.createRun(new File(["%PDF-"], "p.pdf"));
    const events: RunEvent[] = [];
    const stop = client.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (events.some((event) => event.type === "attempt" && event.status === "started")) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });
    await client.cancel(runId);
    const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    expect(events.length).toBe(count);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.every((event) => event.runId === runId)).toBe(true);
    expect(labViewFor(events)).toMatchObject({ phase: "cancelled", cleanup: { clean: true } });
  });
});
