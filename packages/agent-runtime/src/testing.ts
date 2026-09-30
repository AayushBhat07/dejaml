import type { ChatProvider, ChatRequest, ChatResponse, ToolCall } from "./providers/types.js";

/**
 * A provider that replays a script, for tests only. It is never offered by
 * the provider registry and never used for an acceptance run.
 */
export type ScriptedTurn =
  | { text?: string; calls?: Array<{ name: string; input: unknown; id?: string }> }
  | ((
      request: ChatRequest,
    ) =>
      | { text?: string; calls?: Array<{ name: string; input: unknown; id?: string }> }
      | Promise<{ text?: string; calls?: Array<{ name: string; input: unknown; id?: string }> }>);

export class ScriptedChatProvider implements ChatProvider {
  readonly id = "scripted";
  readonly kind = "scripted" as const;
  readonly requests: ChatRequest[] = [];
  readonly #turns: ScriptedTurn[];
  #counter = 0;

  constructor(turns: ScriptedTurn[]) {
    this.#turns = [...turns];
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (request.signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    const { signal: _signal, onText: _onText, ...copy } = request;
    this.requests.push(structuredClone(copy) as ChatRequest);
    const next = this.#turns.shift();
    if (!next) throw new Error("scripted provider ran out of turns");
    const turn = typeof next === "function" ? await next(request) : next;
    const toolCalls: ToolCall[] = (turn.calls ?? []).map((call) => ({
      id: call.id ?? `call_${++this.#counter}`,
      name: call.name,
      input: call.input,
      rawInput: JSON.stringify(call.input),
    }));
    return {
      id: `scripted_${this.#counter}`,
      provider: "scripted",
      model: request.model,
      text: turn.text ?? null,
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "end_turn",
      usage: { inputTokens: 100, outputTokens: 20 },
      costUsd: null,
      attempts: 1,
    };
  }

  get remaining(): number {
    return this.#turns.length;
  }
}
