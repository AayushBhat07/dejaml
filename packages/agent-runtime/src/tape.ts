import { createHash } from "node:crypto";

import type { ChatRequest, ChatResponse, ToolCall } from "./providers/types.js";
import type { AgentRole, ToolResult } from "./tools.js";

/**
 * Record and replay of agent sessions (sub-phase 6.9).
 *
 * A recorded run keeps, for every agent, each model request and response and each tool call and the
 * result the model read back. A replay runs the same study again, against the same deterministic
 * model server, and compares as it goes:
 *
 * - Each request must equal the recorded one after the operator's substitutions (for example the
 *   shown number 81.66 => 77.66). A request that differs otherwise is input drift.
 * - Each response is compared with the recorded one (text, tool names, arguments). The first
 *   difference is where the agent's behaviour diverged.
 * - While an agent is still on its recorded path, each tool is run for its side effects, but the
 *   model reads back the recorded result, so the environment is frozen. A live result that differs
 *   is reported as environment drift.
 *
 * Run ids, agent ids, receipt ids and provider tool-call ids differ between runs, so the replay keeps
 * the model in the recorded run's id space: outgoing requests are translated to recorded ids, and ids
 * in the model's tool arguments are translated back. With nothing substituted, a replay of a
 * deterministic setup must report no divergence at all; that is the gate before any counterfactual.
 */

/** One agent of a run, identified across runs by role, label and how many such agents started before it. */
export type TapeAgent = { runId: string; agentId: string; role: AgentRole; label: string | null };

export type TapeResponse = { text: string | null; toolCalls: Array<{ id: string; name: string; input: unknown }>; stopReason: string };

export type TapeEntry =
  | { kind: "agent"; key: string; runId: string; agentId: string; role: AgentRole; label: string | null }
  | { kind: "model"; key: string; turn: number; requestSha256: string; request: string; response: TapeResponse }
  | {
      kind: "tool";
      key: string;
      index: number;
      call: { name: string; input: unknown };
      receiptId: string;
      result: { content: string; isError: boolean; status: string };
    };

export type DivergenceKind = "request" | "response" | "tool_call" | "tool_result" | "unrecorded_agent" | "not_reached";

export type Divergence = {
  key: string;
  kind: DivergenceKind;
  /** The model turn or tool-call index (from 1) where it happened, when there is one. */
  at: number | null;
  detail: string;
};

export type ReplayReport = {
  mode: "replay";
  recordedRunId: string;
  runId: string;
  substitutions: Array<{ from: string; to: string }>;
  /** True only when every agent read the same requests and did the same things as recorded, to the last recorded step. */
  identical: boolean;
  /** The first divergence that changed what an agent did (a response or a tool call), if any. */
  firstBehaviourDivergence: Divergence | null;
  /** Differences in what the model read or did: input drift, behaviour, missing agents or steps. */
  divergences: Divergence[];
  /**
   * Live tool results that differ from the recorded ones (timestamps, durations, a changed output). The model
   * read the recorded result while on its path, so these do not break `identical`; they show tool and
   * environment drift apart from model drift.
   */
  environmentDrift: Divergence[];
  agents: Array<{
    key: string;
    modelTurns: number;
    recordedModelTurns: number;
    toolCalls: number;
    recordedToolCalls: number;
    onScript: boolean;
  }>;
};

/** What the runtime asks of a tape for one agent. */
export interface AgentTape {
  chat(request: ChatRequest, send: (request: ChatRequest) => Promise<ChatResponse>): Promise<ChatResponse>;
  tool(call: ToolCall, receiptId: string, run: () => Promise<ToolResult>): Promise<ToolResult>;
}

/** A tape for one study run: records it, or replays a recorded run against it. */
export interface RunTape {
  forAgent(agent: TapeAgent): AgentTape;
  /** Recorded entries so far (a replay records the new run too, so it can be replayed in turn). */
  entries(): readonly TapeEntry[];
  /** Replay only: the comparison so far. */
  report(): ReplayReport | null;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The parts of a request the model sees, as one stable string. */
export function requestText(request: ChatRequest): string {
  return JSON.stringify({
    system: request.system,
    messages: request.messages.map((message) =>
      message.role === "assistant"
        ? {
            role: "assistant",
            text: message.text,
            toolCalls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
          }
        : message,
    ),
    tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    maxOutputTokens: request.maxOutputTokens,
  });
}

function responseOf(response: ChatResponse): TapeResponse {
  return {
    text: response.text,
    toolCalls: response.toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
    stopReason: response.stopReason,
  };
}

/** What the model did in a response, without provider ids: two responses with the same behaviour compare equal. */
const behaviour = (response: TapeResponse): string =>
  JSON.stringify({ text: response.text ?? "", calls: response.toolCalls.map((call) => [call.name, call.input]) });

/** The first place two strings differ, with a little context from each. */
export function firstDifference(expected: string, actual: string): string {
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) index += 1;
  const from = Math.max(0, index - 60);
  return `at character ${index}: recorded …${expected.slice(from, index + 80)}… replay …${actual.slice(from, index + 80)}…`;
}

/** Run-specific ids and salted hashes: a prefix of letters and an underscore, then 12 or more hex digits (or a UUID). */
const ID_TOKEN = /^(?:[a-z]{1,12}_)?[0-9a-f]{12,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Wall-clock times (ISO 8601) that reach a model's input directly, such as a dataset receipt's fetchedAt. */
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gu;

function timestampAt(text: string, index: number): string {
  for (const match of text.matchAll(TIMESTAMP)) {
    if (match.index > index) break;
    if (index < match.index + match[0].length) return match[0];
  }
  return "";
}

function tokenAt(text: string, index: number): string {
  let start = index;
  let end = index;
  while (start > 0 && /[\w-]/u.test(text[start - 1]!)) start -= 1;
  while (end < text.length && /[\w-]/u.test(text[end]!)) end += 1;
  return text.slice(start, end);
}

/**
 * Where a replay's text differs from the recorded text only by run-specific ids (agent and receipt ids,
 * board ids, salted commitments) or wall-clock timestamps, learns each pair so the model can be shown the
 * recorded one. Stops at the first difference that is not an id or a timestamp of the same shape.
 */
function learnIds(expected: string, actual: string, ids: Map<string, string>, limit = 200): void {
  let current = actual;
  for (let round = 0; round < limit && current !== expected; round += 1) {
    let index = 0;
    while (index < expected.length && index < current.length && expected[index] === current[index]) index += 1;
    const shape = (token: string): string => token.replace(/[0-9a-f]/giu, "x");
    const wantTime = timestampAt(expected, index);
    const gotTime = timestampAt(current, index);
    let want = wantTime;
    let got = gotTime;
    if (!wantTime || !gotTime || shape(wantTime) !== shape(gotTime)) {
      want = tokenAt(expected, index);
      got = tokenAt(current, index);
      if (!ID_TOKEN.test(want) || !ID_TOKEN.test(got) || shape(want) !== shape(got)) return;
    }
    if (!want || !got || want === got) return;
    ids.set(got, want);
    current = current.split(got).join(want);
  }
}

function replaceAll(text: string, pairs: ReadonlyArray<readonly [string, string]>): string {
  let out = text;
  for (const [from, to] of pairs) if (from && from !== to) out = out.split(from).join(to);
  return out;
}

/** Keys agents by role, label and how many agents with the same role and label started before them in the run. */
class AgentKeys {
  readonly #byAgent = new Map<string, string>();
  readonly #counts = new Map<string, number>();

  key(agent: TapeAgent): string {
    const known = this.#byAgent.get(agent.agentId);
    if (known) return known;
    const base = `${agent.role}|${agent.label ?? ""}`;
    const count = (this.#counts.get(base) ?? 0) + 1;
    this.#counts.set(base, count);
    const key = `${base}|${count}`;
    this.#byAgent.set(agent.agentId, key);
    return key;
  }
}

/** Records every model exchange and tool result of a run. `sink` receives each entry as it is made (for a JSONL file). */
export function recordingTape(sink?: (entry: TapeEntry) => void): RunTape {
  const entries: TapeEntry[] = [];
  const keys = new AgentKeys();
  const push = (entry: TapeEntry): void => {
    entries.push(entry);
    sink?.(entry);
  };
  return {
    forAgent(agent) {
      const key = keys.key(agent);
      push({ kind: "agent", key, runId: agent.runId, agentId: agent.agentId, role: agent.role, label: agent.label });
      let turn = 0;
      let index = 0;
      return {
        async chat(request, send) {
          const response = await send(request);
          turn += 1;
          const text = requestText(request);
          push({ kind: "model", key, turn, requestSha256: sha256(text), request: text, response: responseOf(response) });
          return response;
        },
        async tool(call, receiptId, run) {
          const result = await run();
          index += 1;
          push({
            kind: "tool",
            key,
            index,
            call: { name: call.name, input: call.input },
            receiptId,
            result: {
              content: result.content,
              isError: Boolean(result.isError),
              status: result.status ?? (result.isError ? "error" : "ok"),
            },
          });
          return result;
        },
      };
    },
    entries: () => entries,
    report: () => null,
  };
}

/** Reads a JSONL tape. */
export function parseTape(text: string): TapeEntry[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TapeEntry);
}

/**
 * Replays a recorded run against a new one. `substitutions` are the only differences the operator
 * intends (applied to the recorded requests before they are compared); none means a nothing-changed
 * replay, which must come out identical. The new run is recorded too, through `sink`.
 */
export function replayTape(
  recorded: readonly TapeEntry[],
  options: {
    substitutions?: Array<{ from: string; to: string }>;
    sink?: (entry: TapeEntry) => void;
    onReport?: (report: ReplayReport) => void;
  } = {},
): RunTape {
  const substitutions = options.substitutions ?? [];
  const recorder = recordingTape(options.sink);
  const keys = new AgentKeys();
  const recordedAgents = new Map<string, Extract<TapeEntry, { kind: "agent" }>>();
  const recordedTurns = new Map<string, Array<Extract<TapeEntry, { kind: "model" }>>>();
  const recordedTools = new Map<string, Array<Extract<TapeEntry, { kind: "tool" }>>>();
  for (const entry of recorded) {
    if (entry.kind === "agent") recordedAgents.set(entry.key, entry);
    else if (entry.kind === "model") recordedTurns.set(entry.key, [...(recordedTurns.get(entry.key) ?? []), entry]);
    else recordedTools.set(entry.key, [...(recordedTools.get(entry.key) ?? []), entry]);
  }
  const recordedRunId = [...recordedAgents.values()][0]?.runId ?? "";
  let runId = "";
  // Replay-run ids => recorded-run ids, longest first so an id is never cut by a shorter one inside it.
  const ids = new Map<string, string>();
  const toRecorded = (text: string): string =>
    replaceAll(
      text,
      [...ids.entries()].sort((a, b) => b[0].length - a[0].length),
    );
  const toReplay = (text: string): string =>
    replaceAll(
      text,
      [...ids.entries()].map(([live, old]) => [old, live] as const).sort((a, b) => b[0].length - a[0].length),
    );
  const divergences: Divergence[] = [];
  const progress = new Map<string, { turns: number; tools: number; onScript: boolean }>();
  const diverge = (divergence: Divergence): void => {
    divergences.push(divergence);
    options.onReport?.(report());
  };

  function report(): ReplayReport {
    const missing: Divergence[] = [];
    for (const [key, turns] of recordedTurns) {
      const seen = progress.get(key);
      if (!seen) missing.push({ key, kind: "not_reached", at: null, detail: "this recorded agent never started in the replay" });
      else if (seen.onScript && seen.turns < turns.length)
        missing.push({
          key,
          kind: "not_reached",
          at: seen.turns + 1,
          detail: `the replay stopped after ${seen.turns} of ${turns.length} recorded turns`,
        });
    }
    const all = [...divergences.filter((item) => item.kind !== "tool_result"), ...missing];
    return {
      mode: "replay",
      recordedRunId,
      runId,
      substitutions,
      identical: all.length === 0,
      firstBehaviourDivergence: divergences.find((item) => item.kind === "response" || item.kind === "tool_call") ?? null,
      divergences: all,
      environmentDrift: divergences.filter((item) => item.kind === "tool_result"),
      agents: [...progress.entries()].map(([key, seen]) => ({
        key,
        modelTurns: seen.turns,
        recordedModelTurns: recordedTurns.get(key)?.length ?? 0,
        toolCalls: seen.tools,
        recordedToolCalls: recordedTools.get(key)?.length ?? 0,
        onScript: seen.onScript,
      })),
    };
  }

  const pairs = substitutions.map((item) => [item.from, item.to] as const);
  const translate = (request: ChatRequest): ChatRequest =>
    JSON.parse(toRecorded(JSON.stringify(withoutRuntimeFields(request)))) as ChatRequest;

  return {
    forAgent(agent) {
      runId = agent.runId;
      const key = keys.key(agent);
      const live = recorder.forAgent(agent);
      const old = recordedAgents.get(key);
      const seen = { turns: 0, tools: 0, onScript: Boolean(old) };
      progress.set(key, seen);
      if (old) {
        ids.set(agent.runId, old.runId);
        ids.set(agent.agentId, old.agentId);
      } else {
        diverge({ key, kind: "unrecorded_agent", at: null, detail: "the recorded run has no agent with this role and label" });
      }
      return {
        async chat(request, send) {
          const turnIndex = seen.turns;
          const expected = seen.onScript ? recordedTurns.get(key)?.at(turnIndex) : undefined;
          // The model reads the request in the recorded run's id space; ids this run made afresh are learned here.
          const want = expected ? replaceAll(expected.request, pairs) : null;
          if (want) learnIds(want, requestText(translate(request)), ids);
          const outgoing: ChatRequest = { ...request, ...translate(request) };
          const sent = await live.chat(outgoing, send);
          seen.turns += 1;
          const response = responseOf(sent);
          if (seen.onScript) {
            if (!expected) {
              seen.onScript = false;
              diverge({ key, kind: "response", at: seen.turns, detail: "the agent took more model turns than recorded" });
            } else {
              const got = requestText(outgoing);
              if (want !== got) diverge({ key, kind: "request", at: seen.turns, detail: firstDifference(want ?? "", got) });
              if (behaviour(expected.response) !== behaviour(response)) {
                seen.onScript = false;
                diverge({
                  key,
                  kind: "response",
                  at: seen.turns,
                  detail: firstDifference(behaviour(expected.response), behaviour(response)),
                });
              }
            }
          }
          // Provider call ids are not part of the behaviour: on script they are set to the recorded ones, so later requests match.
          const callIds = expected && seen.onScript ? expected.response.toolCalls.map((call) => call.id) : [];
          return {
            ...sent,
            toolCalls: sent.toolCalls.map((call, position) => {
              const raw = toReplay(call.rawInput);
              return {
                ...call,
                id: callIds.at(position) ?? call.id,
                input: call.input === null ? null : (JSON.parse(toReplay(JSON.stringify(call.input))) as unknown),
                rawInput: raw,
              };
            }),
          };
        },
        async tool(call, receiptId, run) {
          const position = seen.tools;
          seen.tools += 1;
          const expected = seen.onScript ? recordedTools.get(key)?.at(position) : undefined;
          const callText = toRecorded(JSON.stringify({ name: call.name, input: call.input }));
          if (seen.onScript && (!expected || JSON.stringify(expected.call) !== callText)) {
            seen.onScript = false;
            diverge({
              key,
              kind: "tool_call",
              at: seen.tools,
              detail: expected ? firstDifference(JSON.stringify(expected.call), callText) : "a tool call the recorded run did not make",
            });
          }
          if (!seen.onScript || !expected) return live.tool(call, receiptId, run);
          ids.set(receiptId, expected.receiptId);
          // Run it for its side effects (labs, the board), but let the model read what it read in the recorded run.
          const result = await live.tool(call, receiptId, run);
          learnIds(expected.result.content, toRecorded(result.content), ids);
          const liveContent = toRecorded(result.content);
          if (liveContent !== expected.result.content)
            diverge({ key, kind: "tool_result", at: seen.tools, detail: firstDifference(expected.result.content, liveContent) });
          return { ...result, content: toReplay(expected.result.content), isError: expected.result.isError };
        },
      };
    },
    entries: () => recorder.entries(),
    report,
  };
}

function withoutRuntimeFields(request: ChatRequest): Omit<ChatRequest, "signal" | "onText"> {
  const { signal: _signal, onText: _onText, ...rest } = request;
  return rest;
}
