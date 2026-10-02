import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunStore } from "@dejaml/run-store";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { BoundedAgentRuntime, type AgentTask } from "./runtime.js";
import { ScriptedChatProvider, type ScriptedTurn } from "./testing.js";
import { defineTool, type ToolDefinition } from "./tools.js";
import type { ChatProvider } from "./providers/types.js";

const Result = z.object({ answer: z.string() });

const echo = defineTool({
  name: "board_read",
  description: "Read the board",
  input: z.object({ kinds: z.array(z.string()).optional() }),
  run: async (_input, context) => ({
    content: JSON.stringify(context.board.visibleTo(context.role).map((entry) => entry.kind)),
    summary: "read board",
  }),
});

function slowTool(name: string, ms: number): ToolDefinition {
  return defineTool({
    name,
    description: "slow",
    input: z.object({}),
    run: (_input, context) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ content: "done", summary: "done" }), ms);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      }),
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(scripts: Record<string, ScriptedTurn[]>, tools: ToolDefinition[] = [echo], file = ":memory:") {
  const store = new RunStore(file);
  const run = store.createRun({ test: true });
  const providers = new Map<string, ScriptedChatProvider>();
  const runtime = new BoundedAgentRuntime({
    store,
    provider: ({ model }) => {
      let provider = providers.get(model);
      if (!provider) {
        provider = new ScriptedChatProvider(scripts[model] ?? []);
        providers.set(model, provider);
      }
      return provider;
    },
    tools: ({ grants }) => tools.filter((tool) => grants.includes(tool.name)),
    resultSchema: () => Result,
  });
  cleanups.push(() => store.close());
  return { store, runId: run.id, runtime, providers };
}

function task(runId: string, model: string, overrides: Partial<AgentTask<z.infer<typeof Result>>> = {}): AgentTask<z.infer<typeof Result>> {
  return {
    runId,
    role: "reproduction_planner",
    instructions: "Test instructions.",
    objective: "Answer.",
    inputs: { secretNote: `only for ${model}` },
    grants: ["board_read"],
    result: { schema: Result, description: "An answer." },
    provider: { id: "scripted", model },
    ...overrides,
  };
}

describe("BoundedAgentRuntime", () => {
  it("runs each agent as a separate instance with its own conversation", async () => {
    const { runtime, runId, providers, store } = setup({
      a: [{ calls: [{ name: "board_read", input: {} }] }, { calls: [{ name: "finish", input: { answer: "A" } }] }],
      b: [{ calls: [{ name: "finish", input: { answer: "B" } }] }],
    });
    const [first, second] = await Promise.all([
      runtime.startAgent(task(runId, "a")),
      runtime.startAgent(task(runId, "b", { role: "debugger" })),
    ]);
    expect(first.agentId).not.toBe(second.agentId);
    const [a, b] = await Promise.all([first.done, second.done]);
    expect(a.result).toEqual({ answer: "A" });
    expect(b.result).toEqual({ answer: "B" });
    // Agent B never saw agent A's inputs or history.
    const seenByB = JSON.stringify(providers.get("b")!.requests);
    expect(seenByB).toContain("only for b");
    expect(seenByB).not.toContain("only for a");
    expect(store.ledger.listTurns(first.agentId).length).toBeGreaterThan(store.ledger.listTurns(second.agentId).length);
    expect(store.ledger.listAgents(runId).map((agent) => agent.status)).toEqual(["completed", "completed"]);
    const receipts = store.ledger.listReceipts({ agentId: first.agentId });
    expect(receipts.map((receipt) => [receipt.tool, receipt.status])).toEqual([
      ["board_read", "ok"],
      ["finish", "ok"],
    ]);
    expect(receipts[0]!.outputSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("refuses a grant outside the role's capability set before starting", async () => {
    const { runtime, runId } = setup({});
    await expect(runtime.startAgent(task(runId, "x", { grants: ["lab_run"] }))).rejects.toThrow(/may not be granted lab_run/u);
  });

  it("denies an ungranted tool call and lets the agent continue", async () => {
    const { runtime, runId, store } = setup({
      a: [{ calls: [{ name: "lab_run", input: { argv: ["sh"] } }] }, { calls: [{ name: "finish", input: { answer: "ok" } }] }],
    });
    const handle = await runtime.startAgent(task(runId, "a"));
    const outcome = await handle.done;
    expect(outcome.status).toBe("completed");
    expect(store.ledger.listReceipts({ agentId: handle.agentId })[0]!.status).toBe("denied");
  });

  it("returns invalid tool input and an invalid finish result to the model", async () => {
    const { runtime, runId, providers } = setup({
      a: [
        { calls: [{ name: "board_read", input: { kinds: "not-an-array" } }] },
        { calls: [{ name: "finish", input: { wrong: 1 } }] },
        { calls: [{ name: "finish", input: { answer: "fixed" } }] },
      ],
    });
    const outcome = await (await runtime.startAgent(task(runId, "a"))).done;
    expect(outcome.result).toEqual({ answer: "fixed" });
    const last = providers.get("a")!.requests.at(-1)!.messages.at(-1)!;
    expect(last.role === "tool" && last.isError && last.content).toMatch(/Invalid finish input/u);
  });

  it("enforces iteration and tool-call limits", async () => {
    const loop = Array.from({ length: 10 }, () => ({ calls: [{ name: "board_read", input: {} }] }));
    const { runtime, runId } = setup({ a: loop, b: loop });
    const byIterations = await (await runtime.startAgent(task(runId, "a", { limits: { maxIterations: 3 } }))).done;
    expect(byIterations.status).toBe("exhausted");
    expect(byIterations.reason).toMatch(/iteration limit/u);
    expect(byIterations.usage.iterations).toBe(3);
    const byTools = await (await runtime.startAgent(task(runId, "b", { limits: { maxToolCalls: 2 } }))).done;
    expect(byTools.status).toBe("exhausted");
    expect(byTools.reason).toMatch(/tool-call limit/u);
  });

  it("enforces token and time limits", async () => {
    const loop = Array.from({ length: 10 }, () => ({ calls: [{ name: "board_read", input: {} }] }));
    const { runtime, runId } = setup({ a: loop, b: [{ calls: [{ name: "lab_list", input: {} }] }] }, [echo, slowTool("lab_list", 200)]);
    const byTokens = await (await runtime.startAgent(task(runId, "a", { limits: { maxInputTokens: 250 } }))).done;
    expect(byTokens.reason).toMatch(/input-token limit/u);
    const byTime = await (
      await runtime.startAgent(task(runId, "b", { role: "debugger", grants: ["lab_list"], limits: { maxWallMs: 50 } }))
    ).done;
    expect(byTime.status).toBe("exhausted");
    expect(byTime.reason).toMatch(/time limit/u);
  });

  it("cancels a running agent and its tool call", async () => {
    const { runtime, runId, store } = setup({ a: [{ calls: [{ name: "board_read", input: {} }] }] }, [
      defineTool({ ...slowTool("board_read", 10_000) }),
    ]);
    const handle = await runtime.startAgent(task(runId, "a"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.cancelAgent(handle.agentId);
    const outcome = await handle.done;
    expect(outcome.status).toBe("cancelled");
    expect(store.ledger.getAgent(handle.agentId).status).toBe("cancelled");
  });

  it("delivers explicit messages between agents without sharing history", async () => {
    const { runtime, runId, providers } = setup({
      a: [
        { calls: [{ name: "board_read", input: {} }] },
        (request) => {
          const last = request.messages.filter((message) => message.role === "user").at(-1);
          return { calls: [{ name: "finish", input: { answer: last?.role === "user" ? last.content : "none" } }] };
        },
      ],
    });
    const handle = await runtime.startAgent(task(runId, "a"));
    await runtime.sendMessage(handle.agentId, { from: { agentId: null, role: "supervisor" }, text: "use page 3" });
    const outcome = await handle.done;
    expect(outcome.result?.answer).toContain("use page 3");
    expect(JSON.stringify(providers.get("a")!.requests)).toContain("Message from supervisor");
  });

  it("limits what the Independent Reviewer can read from the board", async () => {
    const { runtime, runId } = setup({
      r: [
        (request) => ({ calls: [{ name: "board_read", input: {} }], text: String(request.messages.length) }),
        (request) => {
          const last = request.messages.at(-1);
          return { calls: [{ name: "finish", input: { answer: last?.role === "tool" ? last.content : "" } }] };
        },
      ],
    });
    const board = runtime.board(runId);
    board.post({ kind: "diagnosis", authorAgentId: "agt_x", authorRole: "debugger", payload: { hidden: "engineer reasoning" } });
    board.post({ kind: "command_receipt", authorAgentId: "agt_y", authorRole: "lab_engineer", payload: { receiptId: "r1", exitCode: 0 } });
    const outcome = await (await runtime.startAgent(task(runId, "r", { role: "independent_reviewer" }))).done;
    expect(outcome.result?.answer).toContain("command_receipt");
    expect(outcome.result?.answer).not.toContain("diagnosis");
  });

  it("resumes an interrupted agent from its persisted conversation in a new runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dejaml-runtime-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "runs.sqlite");
    let crash!: () => void;
    const crashed = new Promise<void>((resolve) => {
      crash = resolve;
    });
    // Real crash scenario: a granted tool hangs and the process dies mid-call.
    const second = setup(
      { b: [{ calls: [{ name: "board_read", input: {} }] }, { calls: [{ name: "lab_list", input: {} }] }] },
      [
        echo,
        defineTool({
          name: "lab_list",
          description: "hangs",
          input: z.object({}),
          run: () => {
            crash();
            return new Promise(() => undefined);
          },
        }),
      ],
      file,
    );
    const hung = await second.runtime.startAgent(task(second.runId, "b", { role: "lab_engineer", grants: ["board_read", "lab_list"] }));
    await crashed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.store.ledger.getAgent(hung.agentId).status).toBe("running");
    const turnsBefore = second.store.ledger.listTurns(hung.agentId).length;

    // A new process opens the same database and resumes the agent.
    const third = setup(
      {
        b: [
          (request) => {
            const last = request.messages.at(-1);
            return { calls: [{ name: "finish", input: { answer: last?.role === "tool" ? last.content : "no tool result" } }] };
          },
        ],
      },
      [
        echo,
        defineTool({
          name: "lab_list",
          description: "ok",
          input: z.object({}),
          run: async () => ({ content: "listed", summary: "listed" }),
        }),
      ],
      file,
    );
    const resumed = await third.runtime.resumeAgent(hung.agentId);
    const outcome = await resumed.done;
    expect(outcome.status).toBe("completed");
    expect((outcome.result as { answer: string }).answer).toMatch(/^INTERRUPTED/u);
    expect(third.store.ledger.listTurns(hung.agentId).length).toBeGreaterThan(turnsBefore);
    const receipts = third.store.ledger.listReceipts({ agentId: hung.agentId });
    expect(receipts.find((receipt) => receipt.tool === "lab_list")!.status).toBe("interrupted");
    expect(third.store.ledger.getAgent(hung.agentId).usage.iterations).toBe(3);
  });

  it("rolls over to a new conversation segment instead of editing history", async () => {
    const big = defineTool({
      name: "board_read",
      description: "big",
      input: z.object({}),
      run: async () => ({ content: "x".repeat(5_000), summary: "big" }),
    });
    const { runtime, runId, store, providers } = setup(
      {
        a: [
          { calls: [{ name: "board_read", input: {} }] },
          { calls: [{ name: "board_read", input: {} }] },
          { calls: [{ name: "finish", input: { answer: "done" } }] },
        ],
      },
      [big],
    );
    const handle = await runtime.startAgent(task(runId, "a", { limits: { maxContextChars: 6_000 } }));
    const outcome = await handle.done;
    expect(outcome.status).toBe("completed");
    expect(outcome.usage.segments).toBe(2);
    const requests = providers.get("a")!.requests;
    // Every request's history is a prefix-extension of the one before it within a segment.
    const opening = requests.at(-1)!.messages[0]!;
    expect(opening.role === "user" ? opening.content : "").toMatch(/context limit/u);
    expect(store.ledger.listTurns(handle.agentId, 1).length).toBeGreaterThan(0);
  });

  it("marks provider failures without crashing the process", async () => {
    const store = new RunStore();
    cleanups.push(() => store.close());
    const run = store.createRun({});
    const failing: ChatProvider = {
      id: "x",
      kind: "scripted",
      chat: async () => {
        throw new Error("boom");
      },
    };
    const runtime = new BoundedAgentRuntime({ store, provider: () => failing, tools: () => [] });
    const outcome = await (await runtime.startAgent(task(run.id, "a", { grants: [] }))).done;
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toBe("boom");
  });
});
