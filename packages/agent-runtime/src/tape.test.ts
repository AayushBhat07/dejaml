import { randomUUID } from "node:crypto";

import { RunStore } from "@dejaml/run-store";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ChatProvider, ChatRequest, ChatResponse } from "./providers/types.js";
import { BoundedAgentRuntime } from "./runtime.js";
import { parseTape, recordingTape, replayTape, type ReplayReport, type RunTape, type TapeEntry } from "./tape.js";
import { defineTool } from "./tools.js";

const Result = z.object({ answer: z.string() });

/**
 * A deterministic stand-in model: its reply depends only on the request it reads. It measures once,
 * and if the number it was shown is above what it measured, it tunes and measures again. Each call
 * gets a fresh random id, as a real server's would.
 */
class DeterministicModel implements ChatProvider {
  readonly id = "scripted";
  readonly kind = "scripted" as const;
  readonly seen: string[] = [];

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const text = JSON.stringify(request.messages);
    this.seen.push(text);
    const shown = Number(/shown (\d+\.\d+)/u.exec(text)?.[1] ?? "0");
    const measured = [...text.matchAll(/measured (\d+\.\d+)/gu)].map((match) => Number(match[1]));
    const tuned = text.includes('\\"tune\\":true') || text.includes('"tune":true');
    const call = (name: string, input: unknown) => ({
      id: `call_${randomUUID().slice(0, 8)}`,
      name,
      input,
      rawInput: JSON.stringify(input),
    });
    let toolCalls;
    if (measured.length === 0) toolCalls = [call("lab_run_official", { tune: false })];
    else if (!tuned && shown > measured.at(-1)!) toolCalls = [call("lab_run_official", { tune: true })];
    else toolCalls = [call("finish", { answer: `final ${measured.at(-1)}` })];
    return {
      id: null,
      provider: "scripted",
      model: request.model,
      text: null,
      toolCalls,
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: null,
      attempts: 1,
    };
  }
}

const stores: RunStore[] = [];
let clock = 0;
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

/** One run of one agent; `drift` changes what the tool prints without changing the number. */
async function run(shown: number, tape: RunTape, options: { drift?: boolean } = {}) {
  const store = new RunStore(":memory:");
  stores.push(store);
  const runId = store.createRun({ test: true }).id;
  const model = new DeterministicModel();
  const measure = defineTool({
    name: "lab_run_official",
    description: "Run the measurement",
    input: z.object({ tune: z.boolean() }),
    run: async (input, context) => ({
      content: `measured ${input.tune ? "81.70" : "79.88"} (receipt ${context.receiptId}, run ${context.runId}${options.drift ? ", took 412 ms" : ""})`,
      summary: "measured",
    }),
  });
  const runtime = new BoundedAgentRuntime({
    store,
    provider: () => model,
    tools: () => [measure],
    resultSchema: () => Result,
    tape,
  });
  const handle = await runtime.startAgent({
    runId,
    role: "lab_engineer",
    label: "engineer-1",
    instructions: "Measure.",
    objective: "Report the number.",
    // A wall-clock time in the task input, as a dataset receipt's fetchedAt is; it differs between runs.
    inputs: {
      note: `shown ${shown.toFixed(2)}`,
      runId,
      fetchedAt: new Date(Date.UTC(2026, 10, 9, 15, 27, 53) + ++clock * 1201).toISOString(),
    },
    grants: ["lab_run_official"],
    result: { schema: Result, description: "The number." },
    provider: { id: "scripted", model: "deterministic" },
  });
  const outcome = await handle.done;
  return { outcome, model, runId };
}

describe("record and replay", () => {
  it("a nothing-changed replay on a deterministic model is identical, though ids differ between runs", async () => {
    const lines: string[] = [];
    const first = await run(
      77.66,
      recordingTape((entry) => lines.push(JSON.stringify(entry))),
    );
    expect(first.outcome.result).toEqual({ answer: "final 79.88" });
    const recorded = parseTape(lines.join("\n"));
    expect(recorded.filter((entry) => entry.kind === "model")).toHaveLength(2);

    const written: ReplayReport[] = [];
    const replay = replayTape(recorded, { onReport: (report) => written.push(report) });
    const second = await run(77.66, replay);
    expect(second.runId).not.toBe(first.runId);
    // The last written comparison is the complete one, with no agent left "not reached".
    expect(written.at(-1)).toEqual(replay.report());
    expect(second.outcome.result).toEqual({ answer: "final 79.88" });
    const report = replay.report()!;
    expect(report.divergences).toEqual([]);
    expect(report.identical).toBe(true);
    // The model read the recorded run's ids and times, byte for byte.
    expect(second.model.seen).toEqual(first.model.seen);
  });

  it("changing only the shown number finds the first turn where the agent acts differently", async () => {
    const recorded: TapeEntry[] = [];
    await run(
      77.66,
      recordingTape((entry) => recorded.push(entry)),
    );
    const replay = replayTape(recorded, { substitutions: [{ from: "77.66", to: "81.66" }] });
    const second = await run(81.66, replay);
    expect(second.outcome.result).toEqual({ answer: "final 81.7" });
    const report = replay.report()!;
    expect(report.identical).toBe(false);
    // The requests matched once the intended substitution was applied; the model then chose to tune.
    expect(report.divergences.filter((item) => item.kind === "request")).toEqual([]);
    expect(report.firstBehaviourDivergence).toMatchObject({ kind: "response", at: 2, key: "lab_engineer|engineer-1|1" });
  });

  it("an unintended change to the inputs is reported as request drift", async () => {
    const recorded: TapeEntry[] = [];
    await run(
      77.66,
      recordingTape((entry) => recorded.push(entry)),
    );
    const replay = replayTape(recorded);
    await run(81.66, replay);
    const report = replay.report()!;
    expect(report.divergences[0]).toMatchObject({ kind: "request", at: 1 });
    expect(report.divergences[0]!.detail).toContain("77.66");
  });

  it("environment drift is reported apart, and the model reads the recorded result, so the replay stays identical", async () => {
    const recorded: TapeEntry[] = [];
    await run(
      77.66,
      recordingTape((entry) => recorded.push(entry)),
    );
    const replay = replayTape(recorded);
    const second = await run(77.66, replay, { drift: true });
    const report = replay.report()!;
    expect(report.divergences).toEqual([]);
    expect(report.identical).toBe(true);
    expect(report.environmentDrift.map((item) => item.kind)).toEqual(["tool_result"]);
    expect(report.firstBehaviourDivergence).toBeNull();
    expect(second.model.seen.join("")).not.toContain("412 ms");
  });
});
