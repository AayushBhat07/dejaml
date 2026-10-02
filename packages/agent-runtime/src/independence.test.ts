import { RunStore } from "@dejaml/run-store";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { type AgentEvent, BoundedAgentRuntime, type AgentTask } from "./runtime.js";
import { ScriptedChatProvider, type ScriptedTurn } from "./testing.js";
import { defineTool, ROLE_CAPABILITIES, type ToolDefinition } from "./tools.js";
import type { ChatMessage, ChatProvider, ChatRequest } from "./providers/types.js";

/**
 * Proofs that every role is a separately instantiated, stateful participant:
 * its own id, conversation, tools, budgets, cancellation and failure state.
 * Nothing here relies on system prompts to separate agents.
 */

const Result = z.object({ answer: z.string() });
type ResultT = z.infer<typeof Result>;

const stores: RunStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

function harness(scripts: Record<string, ScriptedTurn[]>, tools: ToolDefinition[] = []) {
  const store = new RunStore();
  stores.push(store);
  const runId = store.createRun({}).id;
  const providers = new Map<string, ChatProvider>();
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
  return { store, runId, runtime, providers };
}

function task(runId: string, model: string, overrides: Partial<AgentTask<ResultT>> = {}): AgentTask<ResultT> {
  return {
    runId,
    role: "reproduction_planner",
    instructions: "Test.",
    objective: `Objective of ${model}.`,
    inputs: { marker: `input-of-${model}` },
    grants: [],
    result: { schema: Result, description: "An answer." },
    provider: { id: "scripted", model },
    ...overrides,
  };
}

const finish = (answer: string): ScriptedTurn => ({ calls: [{ name: "finish", input: { answer } }] });

describe("agent independence", () => {
  it("1. gives every agent a unique id and its own persisted history", async () => {
    const { runtime, runId, store } = harness({ a: [finish("A")], b: [finish("B")], c: [finish("C")] });
    const handles = await Promise.all(
      ["a", "b", "c"].map((model, index) =>
        runtime.startAgent(task(runId, model, { role: (["reproduction_planner", "debugger", "supervisor"] as const)[index]! })),
      ),
    );
    await Promise.all(handles.map((handle) => handle.done));
    const ids = handles.map((handle) => handle.agentId);
    expect(new Set(ids).size).toBe(3);
    for (const [index, id] of ids.entries()) {
      const history = JSON.stringify(store.ledger.listTurns(id));
      const own = ["a", "b", "c"][index]!;
      expect(history).toContain(`input-of-${own}`);
      for (const other of ["a", "b", "c"].filter((item) => item !== own)) expect(history).not.toContain(`input-of-${other}`);
    }
    expect(store.ledger.listAgents(runId).map((agent) => agent.role)).toEqual(["reproduction_planner", "debugger", "supervisor"]);
  });

  it("2. runs agents concurrently: each waits for the other to have started", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const aStarted = new Promise<void>((resolve) => (releaseA = resolve));
    const bStarted = new Promise<void>((resolve) => (releaseB = resolve));
    // Each agent's first model call blocks until the other agent has also made its first call.
    // Run sequentially, this would deadlock and the test would time out.
    const { runtime, runId } = harness({
      a: [
        async () => {
          releaseA();
          await bStarted;
          return finish("A") as { calls: Array<{ name: string; input: unknown }> };
        },
      ],
      b: [
        async () => {
          releaseB();
          await aStarted;
          return finish("B") as { calls: Array<{ name: string; input: unknown }> };
        },
      ],
    });
    const [a, b] = await Promise.all([runtime.startAgent(task(runId, "a")), runtime.startAgent(task(runId, "b", { role: "debugger" }))]);
    const outcomes = await Promise.race([
      Promise.all([a.done, b.done]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("agents did not run concurrently")), 2_000)),
    ]);
    expect(outcomes.map((item) => item.result?.answer)).toEqual(["A", "B"]);
  });

  it("3. isolates tools per role: capability sets differ and an ungranted call is denied", async () => {
    const hostTool = (name: string) =>
      defineTool({ name, description: name, input: z.object({}), run: async () => ({ content: `${name} ran`, summary: name }) });
    const tools = ["lab_run", "paper_read_page", "delegate"].map(hostTool);
    const { runtime, runId, store } = harness(
      { a: [{ calls: [{ name: "lab_run", input: {} }] }, { calls: [{ name: "paper_read_page", input: {} }] }, finish("done")] },
      tools,
    );
    expect(ROLE_CAPABILITIES.paper_analyst).not.toContain("lab_run");
    expect(ROLE_CAPABILITIES.independent_reviewer).not.toContain("lab_run");
    expect(ROLE_CAPABILITIES.supervisor).not.toContain("lab_run");
    expect(ROLE_CAPABILITIES.debugger).not.toContain("lab_run");
    for (const role of Object.keys(ROLE_CAPABILITIES) as Array<keyof typeof ROLE_CAPABILITIES>) {
      if (role !== "lab_engineer") expect(ROLE_CAPABILITIES[role]).not.toContain("lab_write_file");
    }
    await expect(runtime.startAgent(task(runId, "x", { grants: ["lab_run"] }))).rejects.toThrow(/may not be granted/u);
    const handle = await runtime.startAgent(task(runId, "a", { grants: ["paper_read_page"] }));
    await handle.done;
    expect(store.ledger.listReceipts({ agentId: handle.agentId }).map((item) => [item.tool, item.status])).toEqual([
      ["lab_run", "denied"],
      ["paper_read_page", "ok"],
      ["finish", "ok"],
    ]);
  });

  it("4. delivers an explicit message only to its addressee, persisted in the ledger", async () => {
    let deliver!: () => void;
    const gate = new Promise<void>((resolve) => (deliver = resolve));
    const { runtime, runId, store, providers } = harness(
      {
        target: [
          async () => {
            await gate;
            return { calls: [{ name: "board_read", input: {} }] };
          },
          (request) => ({ calls: [{ name: "finish", input: { answer: lastUser(request) } }] }),
        ],
        bystander: [{ calls: [{ name: "board_read", input: {} }] }, finish("bystander done")],
      },
      [defineTool({ name: "board_read", description: "b", input: z.object({}), run: async () => ({ content: "[]", summary: "read" }) })],
    );
    const target = await runtime.startAgent(task(runId, "target", { grants: ["board_read"] }));
    const bystander = await runtime.startAgent(task(runId, "bystander", { role: "debugger", grants: ["board_read"] }));
    await runtime.sendMessage(target.agentId, {
      from: { agentId: bystander.agentId, role: "debugger" },
      text: "typed finding: entry point is run.py",
    });
    deliver();
    const [outcome] = await Promise.all([target.done, bystander.done]);
    expect(outcome.result?.answer).toContain("typed finding: entry point is run.py");
    expect(JSON.stringify(store.ledger.listTurns(target.agentId))).toContain("typed finding");
    expect(JSON.stringify(store.ledger.listTurns(bystander.agentId))).not.toContain("typed finding");
    expect(JSON.stringify((providers.get("bystander") as ScriptedChatProvider).requests)).not.toContain("typed finding");
  });

  it("6. cancels one agent without touching another", async () => {
    const slow = defineTool({
      name: "lab_list",
      description: "slow",
      input: z.object({}),
      run: (_input, context) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ content: "listed", summary: "listed" }), 150);
          context.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
    });
    const { runtime, runId, store } = harness(
      {
        doomed: [{ calls: [{ name: "lab_list", input: {} }] }, finish("never")],
        survivor: [{ calls: [{ name: "lab_list", input: {} }] }, finish("survived")],
      },
      [slow],
    );
    const doomed = await runtime.startAgent(task(runId, "doomed", { role: "debugger", grants: ["lab_list"] }));
    const survivor = await runtime.startAgent(task(runId, "survivor", { role: "debugger", grants: ["lab_list"] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runtime.cancelAgent(doomed.agentId);
    const [a, b] = await Promise.all([doomed.done, survivor.done]);
    expect(a.status).toBe("cancelled");
    expect(b).toMatchObject({ status: "completed", result: { answer: "survived" } });
    expect(store.ledger.getAgent(doomed.agentId).status).toBe("cancelled");
    expect(store.ledger.getAgent(survivor.agentId).status).toBe("completed");
  });

  it("7. keeps failure state per agent: one provider failure does not fail another", async () => {
    const store = new RunStore();
    stores.push(store);
    const runId = store.createRun({}).id;
    const healthy = new ScriptedChatProvider([finish("fine")]);
    const broken: ChatProvider = {
      id: "broken",
      kind: "scripted",
      chat: async () => {
        throw new Error("upstream 500");
      },
    };
    const runtime = new BoundedAgentRuntime({ store, provider: ({ model }) => (model === "broken" ? broken : healthy), tools: () => [] });
    const [a, b] = await Promise.all([
      runtime.startAgent(task(runId, "broken")),
      runtime.startAgent(task(runId, "healthy", { role: "debugger" })),
    ]);
    const [failed, ok] = await Promise.all([a.done, b.done]);
    expect(failed).toMatchObject({ status: "failed", reason: "upstream 500" });
    expect(ok).toMatchObject({ status: "completed" });
    expect(store.ledger.getAgent(a.agentId).failure).toBe("upstream 500");
    expect(store.ledger.getAgent(b.agentId).failure).toBeNull();
  });

  it("keeps budgets per agent: one exhausting its budget leaves the other's counters untouched", async () => {
    const loop = Array.from({ length: 5 }, () => ({ calls: [{ name: "board_read", input: {} }] }));
    const board = defineTool({
      name: "board_read",
      description: "b",
      input: z.object({}),
      run: async () => ({ content: "[]", summary: "read" }),
    });
    const { runtime, runId } = harness({ tight: loop, loose: [{ calls: [{ name: "board_read", input: {} }] }, finish("ok")] }, [board]);
    const [tight, loose] = await Promise.all([
      runtime.startAgent(task(runId, "tight", { grants: ["board_read"], limits: { maxIterations: 2 } })),
      runtime.startAgent(task(runId, "loose", { role: "debugger", grants: ["board_read"], limits: { maxIterations: 10 } })),
    ]);
    const [a, b] = await Promise.all([tight.done, loose.done]);
    expect(a).toMatchObject({ status: "exhausted", usage: { iterations: 2 } });
    expect(b).toMatchObject({ status: "completed", usage: { iterations: 2, toolCalls: 2 } });
  });

  it("emits observable lifecycle and tool events per agent", async () => {
    const board = defineTool({
      name: "board_read",
      description: "b",
      input: z.object({}),
      run: async () => ({ content: "[]", summary: "read" }),
    });
    const { runtime, runId, store } = harness({ a: [{ calls: [{ name: "board_read", input: {} }] }, finish("A")] }, [board]);
    const events: AgentEvent[] = [];
    // Subscribing to a pre-assigned id sees the agent's whole life, from its first turn.
    runtime.subscribe("agt_observed", (event) => events.push(event));
    const handle = await runtime.startAgent(task(runId, "a", { agentId: "agt_observed", grants: ["board_read"] }));
    await handle.done;
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["model_turn", "tool_call", "tool_result", "lifecycle"]));
    expect(events.every((event) => event.agentId === handle.agentId)).toBe(true);
    const runEvents = store.listEvents(runId).map((event) => event.type);
    expect(runEvents).toEqual(expect.arrayContaining(["agent_started", "agent_turn", "agent_finished"]));
  });

  it("8. never shows the Reviewer the Engineer's reasoning, diagnoses, or submission prose", async () => {
    const read = defineTool({
      name: "board_read",
      description: "b",
      input: z.object({}),
      run: async (_input, context) => ({ content: JSON.stringify(context.board.visibleTo(context.role)), summary: "read" }),
    });
    const { runtime, runId, store } = harness(
      {
        engineer: [
          { text: "PRIVATE-ENGINEER-THOUGHT: maybe tweak the seed", calls: [{ name: "board_read", input: {} }] },
          finish("submitted"),
        ],
        reviewer: [{ calls: [{ name: "board_read", input: {} }] }, finish("reviewed")],
      },
      [read],
    );
    const engineer = await runtime.startAgent(task(runId, "engineer", { role: "lab_engineer", grants: ["board_read"] }));
    await engineer.done;
    const board = runtime.board(runId);
    board.post({
      kind: "diagnosis",
      authorAgentId: "agt_dbg",
      authorRole: "debugger",
      key: engineer.agentId,
      payload: { diagnosis: "PRIVATE-DEBUGGER-NOTE" },
    });
    board.post({ kind: "note", authorAgentId: engineer.agentId, authorRole: "lab_engineer", payload: { text: "PRIVATE-NOTE" } });
    board.post({
      kind: "submission",
      authorAgentId: engineer.agentId,
      authorRole: "lab_engineer",
      key: engineer.agentId,
      payload: {
        submission: {
          status: "measured",
          summary: "PRIVATE-SUMMARY",
          failureReason: "PRIVATE-FAILURE",
          producingReceiptId: "rcpt_1",
          deviations: ["numpy 2.1 instead of 1.19"],
        },
      },
    });
    board.post({
      kind: "command_receipt",
      authorAgentId: engineer.agentId,
      authorRole: "lab_engineer",
      key: engineer.agentId,
      payload: { receiptId: "rcpt_1", exitCode: 0 },
    });
    const reviewer = await runtime.startAgent(task(runId, "reviewer", { role: "independent_reviewer", grants: ["board_read"] }));
    await reviewer.done;
    const seen = JSON.stringify(store.ledger.listTurns(reviewer.agentId));
    expect(seen).toContain("rcpt_1");
    expect(seen).toContain("numpy 2.1 instead of 1.19");
    for (const hidden of ["PRIVATE-ENGINEER-THOUGHT", "PRIVATE-DEBUGGER-NOTE", "PRIVATE-NOTE", "PRIVATE-SUMMARY", "PRIVATE-FAILURE"]) {
      expect(seen).not.toContain(hidden);
    }
  });

  it("10. never lets two roles share or mutate one message history", async () => {
    const seen = new Map<string, ChatMessage[][]>();
    const record = (name: string) => (request: ChatRequest) => {
      const list = seen.get(name) ?? [];
      list.push(request.messages);
      seen.set(name, list);
      // A misbehaving consumer mutates what it was given.
      (request.messages as ChatMessage[]).push({ role: "user", content: `INJECTED-BY-${name}` });
      return { calls: [{ name: "finish", input: { answer: name } }] };
    };
    const { runtime, runId, store } = harness({ a: [record("a")], b: [record("b")] });
    const [a, b] = await Promise.all([runtime.startAgent(task(runId, "a")), runtime.startAgent(task(runId, "b", { role: "debugger" }))]);
    await Promise.all([a.done, b.done]);
    expect(seen.get("a")![0]).not.toBe(seen.get("b")![0]);
    const historyA = JSON.stringify(store.ledger.listTurns(a.agentId));
    const historyB = JSON.stringify(store.ledger.listTurns(b.agentId));
    expect(historyA).not.toContain("INJECTED");
    expect(historyB).not.toContain("INJECTED");
    expect(historyA).not.toContain("input-of-b");
    expect(historyB).not.toContain("input-of-a");
    // Every read of a history returns fresh objects.
    const first = store.ledger.listTurns(a.agentId);
    (first[0]!.message as { content: string }).content = "tampered";
    expect(JSON.stringify(store.ledger.listTurns(a.agentId))).not.toContain("tampered");
  });
});

function lastUser(request: ChatRequest): string {
  const message = [...request.messages].reverse().find((item) => item.role === "user");
  return message && message.role === "user" ? message.content : "";
}
