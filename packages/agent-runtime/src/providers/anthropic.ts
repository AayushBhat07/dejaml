import type { ProviderHttpOptions } from "./openai.js";
import { DEFAULT_PRICES, estimateCostUsd, priceFor } from "./pricing.js";
import {
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  type RequestContext,
  type RetryOptions,
  httpError,
  malformed,
  parseToolInput,
  readSse,
  streamError,
  withRetries,
  withTimeout,
} from "./retry.js";
import {
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ModelPrice,
  type StopReason,
  type TokenUsage,
  type ToolCall,
} from "./types.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicChatProviderOptions = ProviderHttpOptions & {
  apiKey: string;
  /** Origin only; the adapter posts to `{baseUrl}/v1/messages`. */
  baseUrl?: string;
  id?: string;
};

type Block = Record<string, unknown> & { type: string };
type AnthropicMessage = { role: "user" | "assistant"; content: Block[] };

export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
  tool_choice?: { type: "auto" };
  stream?: true;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isBlockArray(v: unknown): v is Block[] {
  return Array.isArray(v) && v.length > 0 && v.every((b) => isRecord(b) && typeof b["type"] === "string");
}

/**
 * Translates provider-neutral history into alternating user/assistant turns.
 * Consecutive tool results (and a following user message) merge into one
 * user turn. An assistant message whose `providerContent` came from this
 * provider id and the request's model is replayed verbatim (thinking blocks
 * included); otherwise its blocks are rebuilt from text and tool calls.
 */
export function toAnthropicMessages(providerId: string, model: string, messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.content }]);
    else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content, is_error: m.isError }]);
    } else {
      const pc = m.providerContent;
      if (pc && pc.provider === providerId && pc.model === model && isBlockArray(pc.content)) {
        push("assistant", pc.content);
        continue;
      }
      const blocks: Block[] = [];
      if (m.text !== null && m.text !== "") blocks.push({ type: "text", text: m.text });
      for (const c of m.toolCalls) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: isRecord(c.input) ? c.input : {} });
      }
      push("assistant", blocks);
    }
  }
  return out;
}

export function buildAnthropicRequestBody(providerId: string, request: ChatRequest): AnthropicRequestBody {
  const body: AnthropicRequestBody = {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    messages: toAnthropicMessages(providerId, request.model, request.messages),
  };
  if (request.system !== "") body.system = request.system;
  if (request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    body.tool_choice = { type: "auto" };
  }
  if (request.stream) body.stream = true;
  return body;
}

export function mapAnthropicStopReason(reason: unknown): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function parseUsage(raw: unknown, into?: TokenUsage): TokenUsage {
  const usage: TokenUsage = into ?? { inputTokens: 0, outputTokens: 0 };
  if (!isRecord(raw)) return usage;
  if (typeof raw["input_tokens"] === "number") usage.inputTokens = num(raw["input_tokens"]);
  if (typeof raw["output_tokens"] === "number") usage.outputTokens = num(raw["output_tokens"]);
  const cacheRead = num(raw["cache_read_input_tokens"]);
  const cacheWrite = num(raw["cache_creation_input_tokens"]);
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
  return usage;
}

/** Human-readable note for a refusal's `stop_details` (`{type, category, explanation}`), or null. */
export function describeStopDetails(details: unknown): string | null {
  if (!isRecord(details)) return null;
  const category = typeof details["category"] === "string" ? details["category"] : null;
  const explanation = typeof details["explanation"] === "string" ? details["explanation"] : null;
  if (category === null && explanation === null) return null;
  return `[refusal${category ? `: ${category}` : ""}]${explanation ? ` ${explanation}` : ""}`;
}

type Parsed = Omit<ChatResponse, "attempts" | "costUsd">;

export class AnthropicChatProvider implements ChatProvider {
  readonly id: string;
  readonly kind = "anthropic" as const;
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retry: Omit<RetryOptions, "signal">;
  readonly #prices: Readonly<Record<string, ModelPrice>>;

  constructor(options: AnthropicChatProviderOptions) {
    this.id = options.id ?? "anthropic";
    this.baseUrl = (options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retry = options.retry ?? {};
    this.#prices = options.prices ?? DEFAULT_PRICES;
  }

  toJSON(): Record<string, unknown> {
    return { id: this.id, kind: this.kind };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = JSON.stringify(buildAnthropicRequestBody(this.id, request));
    const url = `${this.baseUrl}/v1/messages`;
    const headers: Record<string, string> = {
      "x-api-key": this.#apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    };
    if (request.stream) headers["accept"] = "text/event-stream";

    const { value, attempts } = await withRetries(
      () =>
        withTimeout(request.signal, this.#timeoutMs, async (ctx) => {
          const res = await this.#fetch(url, { method: "POST", headers, body, signal: ctx.signal });
          if (!res.ok) {
            let text = "";
            try {
              text = await res.text();
            } catch {
              // status alone is enough
            }
            throw httpError("Anthropic", res.status, text, res.headers, [this.#apiKey]);
          }
          if (request.stream) return await this.#readStream(res, request, ctx);
          const text = await res.text();
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            throw malformed("Anthropic", "body is not valid JSON");
          }
          return this.#parseMessage(json, request.model);
        }),
      { ...this.#retry, signal: request.signal },
    );
    const price = priceFor(value.model, this.#prices) ?? priceFor(request.model, this.#prices);
    return { ...value, attempts, costUsd: estimateCostUsd(value.usage, price) };
  }

  #finish(
    id: string | null,
    model: string,
    requestModel: string,
    content: Block[],
    toolCalls: ToolCall[],
    stopReasonRaw: unknown,
    stopDetails: unknown,
    usage: TokenUsage,
  ): Parsed {
    const texts = content.filter((b) => b.type === "text" && typeof b["text"] === "string").map((b) => b["text"] as string);
    let text: string | null = texts.length > 0 ? texts.join("") : null;
    const stopReason = mapAnthropicStopReason(stopReasonRaw);
    if (stopReason === "refusal") {
      const note = describeStopDetails(stopDetails);
      if (note) text = text ? `${text}\n\n${note}` : note;
    }
    return {
      id,
      provider: this.id,
      model,
      text,
      toolCalls,
      stopReason,
      usage,
      providerContent: { provider: this.id, model: requestModel, content },
    };
  }

  #parseMessage(json: unknown, requestModel: string): Parsed {
    if (!isRecord(json)) throw malformed("Anthropic", "body is not an object");
    const content = json["content"];
    if (!Array.isArray(content)) throw malformed("Anthropic", "missing content array");
    const blocks: Block[] = [];
    const toolCalls: ToolCall[] = [];
    content.forEach((b, i) => {
      if (!isRecord(b) || typeof b["type"] !== "string") throw malformed("Anthropic", `content[${i}] has no type`);
      const block = b as Block;
      if (block.type === "tool_use") {
        const id = block["id"];
        const name = block["name"];
        if (typeof id !== "string" || typeof name !== "string") throw malformed("Anthropic", `content[${i}] tool_use missing id or name`);
        const input = block["input"] ?? {};
        toolCalls.push({ id, name, input, rawInput: JSON.stringify(input) });
      }
      blocks.push(block);
    });
    return this.#finish(
      typeof json["id"] === "string" ? json["id"] : null,
      typeof json["model"] === "string" ? json["model"] : requestModel,
      requestModel,
      blocks,
      toolCalls,
      json["stop_reason"],
      json["stop_details"],
      parseUsage(json["usage"]),
    );
  }

  async #readStream(res: Response, request: ChatRequest, ctx: RequestContext): Promise<Parsed> {
    if (!res.body) throw malformed("Anthropic", "stream has no body");
    let id: string | null = null;
    let model = request.model;
    let stopReason: unknown = null;
    let stopDetails: unknown = null;
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const blocks = new Map<number, Block>();
    const partialJson = new Map<number, string>();
    const toolCalls = new Map<number, ToolCall>();
    let stopped = false;

    const blockAt = (index: unknown): [number, Block] => {
      if (typeof index !== "number") throw malformed("Anthropic", "stream event without index");
      const b = blocks.get(index);
      if (!b) throw malformed("Anthropic", `delta for unknown content block ${index}`);
      return [index, b];
    };

    for await (const ev of readSse(res.body, ctx.signal)) {
      if (ev.data.trim() === "") continue;
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch {
        throw malformed("Anthropic", "stream event is not valid JSON");
      }
      if (!isRecord(data)) throw malformed("Anthropic", "stream event is not an object");
      const type = typeof data["type"] === "string" ? data["type"] : ev.event;
      switch (type) {
        case "ping":
          break;
        case "error": {
          const e = isRecord(data["error"]) ? data["error"] : {};
          throw streamError(
            "Anthropic",
            typeof e["type"] === "string" ? e["type"] : "error",
            typeof e["message"] === "string" ? e["message"] : "stream error",
            [this.#apiKey],
          );
        }
        case "message_start": {
          const msg = data["message"];
          if (!isRecord(msg)) throw malformed("Anthropic", "message_start without message");
          if (typeof msg["id"] === "string") id = msg["id"];
          if (typeof msg["model"] === "string") model = msg["model"];
          parseUsage(msg["usage"], usage);
          break;
        }
        case "content_block_start": {
          const index = data["index"];
          const cb = data["content_block"];
          if (typeof index !== "number" || !isRecord(cb) || typeof cb["type"] !== "string") {
            throw malformed("Anthropic", "content_block_start missing index or block");
          }
          const block = structuredClone(cb) as Block;
          blocks.set(index, block);
          if (block.type === "tool_use") partialJson.set(index, "");
          break;
        }
        case "content_block_delta": {
          const [index, block] = blockAt(data["index"]);
          const delta = data["delta"];
          if (!isRecord(delta)) throw malformed("Anthropic", "content_block_delta without delta");
          switch (delta["type"]) {
            case "text_delta": {
              const t = typeof delta["text"] === "string" ? delta["text"] : "";
              block["text"] = `${typeof block["text"] === "string" ? block["text"] : ""}${t}`;
              if (t !== "") {
                ctx.markDelivered();
                request.onText?.(t);
              }
              break;
            }
            case "input_json_delta":
              partialJson.set(index, `${partialJson.get(index) ?? ""}${typeof delta["partial_json"] === "string" ? delta["partial_json"] : ""}`);
              break;
            case "thinking_delta":
              block["thinking"] = `${typeof block["thinking"] === "string" ? block["thinking"] : ""}${typeof delta["thinking"] === "string" ? delta["thinking"] : ""}`;
              break;
            case "signature_delta":
              block["signature"] = `${typeof block["signature"] === "string" ? block["signature"] : ""}${typeof delta["signature"] === "string" ? delta["signature"] : ""}`;
              break;
            case "citations_delta": {
              const list = Array.isArray(block["citations"]) ? (block["citations"] as unknown[]) : [];
              list.push(delta["citation"]);
              block["citations"] = list;
              break;
            }
            default:
              break;
          }
          break;
        }
        case "content_block_stop": {
          const [index, block] = blockAt(data["index"]);
          if (block.type === "tool_use") {
            const raw = partialJson.get(index) ?? "";
            const startInput = isRecord(block["input"]) ? block["input"] : {};
            const input = raw === "" ? startInput : parseToolInput(raw);
            // Keep an object in the replayable content even if the JSON was invalid.
            block["input"] = isRecord(input) ? input : {};
            const toolId = block["id"];
            const name = block["name"];
            if (typeof toolId !== "string" || typeof name !== "string") throw malformed("Anthropic", "tool_use block missing id or name");
            toolCalls.set(index, { id: toolId, name, input, rawInput: raw === "" ? JSON.stringify(startInput) : raw });
          }
          break;
        }
        case "message_delta": {
          const delta = data["delta"];
          if (isRecord(delta)) {
            if ("stop_reason" in delta) stopReason = delta["stop_reason"];
            if ("stop_details" in delta) stopDetails = delta["stop_details"];
          }
          parseUsage(data["usage"], usage);
          break;
        }
        case "message_stop":
          stopped = true;
          break;
        default:
          break;
      }
      if (stopped) break;
    }
    if (!stopped) throw new ProviderError("network", "Anthropic stream ended before message_stop", { retryable: true });

    const indices = [...blocks.keys()].sort((a, b) => a - b);
    const content = indices.map((i) => blocks.get(i) as Block);
    const calls = indices.flatMap((i) => {
      const c = toolCalls.get(i);
      return c ? [c] : [];
    });
    return this.#finish(id, model, request.model, content, calls, stopReason, stopDetails, usage);
  }
}
