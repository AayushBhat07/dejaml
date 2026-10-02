import { type EndpointAccess, NetGuardError, validateEndpointUrl } from "@dejaml/net-guard";

import { estimateCostUsd, priceFor, DEFAULT_PRICES } from "./pricing.js";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  type NetGuardSeams,
  type ProviderHttpOptions,
  type RequestContext,
  type RetryOptions,
  assertModelAllowed,
  guardedProviderFetch,
  httpError,
  malformed,
  parseToolInput,
  readBoundedText,
  readErrorBody,
  readSse,
  streamError,
  withRetries,
  withTimeout,
} from "./retry.js";
import {
  INSPECT,
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

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type OpenAIChatProviderOptions = ProviderHttpOptions & {
  apiKey: string;
  baseUrl?: string;
  id?: string;
};

/**
 * The administrator's OpenAI-compatible endpoint. It never takes an injected
 * fetch: every request goes through net-guard's guarded fetch under `access`.
 */
export type OpenAICompatibleChatProviderOptions = Omit<ProviderHttpOptions, "fetchImpl"> & {
  baseUrl: string;
  apiKey?: string;
  id?: string;
  /** Display label used in error messages. */
  label?: string;
  /** Which addresses the endpoint may resolve to. Default `public`; wider levels are for development only. */
  access?: EndpointAccess;
  /** Allow plain http (only honored with `loopback` access). */
  allowHttp?: boolean;
  /** Test seams for the guarded fetch (resolver, transport, address policy). */
  netGuard?: NetGuardSeams;
};

// ---------------------------------------------------------------------------
// Wire types (subset of the Chat Completions API)

type OAToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type OAMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OAToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIRequestBody = {
  model: string;
  messages: OAMessage[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  tool_choice?: "auto";
  max_completion_tokens: number;
  stream?: true;
  stream_options?: { include_usage: true };
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Arguments text to replay for a prior tool call: the original bytes when valid JSON. */
function replayArguments(call: ToolCall): string {
  if (call.rawInput !== "") {
    try {
      JSON.parse(call.rawInput);
      return call.rawInput;
    } catch {
      // fall through
    }
  }
  return JSON.stringify(call.input ?? {});
}

export function toOpenAIMessages(system: string, messages: ChatMessage[]): OAMessage[] {
  const out: OAMessage[] = [];
  if (system !== "") out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const msg: OAMessage = { role: "assistant", content: m.text };
      if (m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: replayArguments(c) },
        }));
      }
      out.push(msg);
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

export function buildOpenAIRequestBody(request: ChatRequest): OpenAIRequestBody {
  const body: OpenAIRequestBody = {
    model: request.model,
    messages: toOpenAIMessages(request.system, request.messages),
    max_completion_tokens: request.maxOutputTokens,
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    body.tool_choice = "auto";
  }
  if (request.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

export function mapOpenAIFinishReason(reason: unknown): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

/**
 * OpenAI reports `prompt_tokens` including cached tokens. `TokenUsage` keeps
 * the three input buckets disjoint (as Anthropic reports them), so
 * `inputTokens` here is `prompt_tokens - cached_tokens`.
 */
function parseUsage(raw: unknown): TokenUsage {
  if (!isRecord(raw)) return { inputTokens: 0, outputTokens: 0 };
  const prompt = num(raw["prompt_tokens"]);
  const details = raw["prompt_tokens_details"];
  const cached = isRecord(details) ? num(details["cached_tokens"]) : 0;
  const usage: TokenUsage = { inputTokens: Math.max(0, prompt - cached), outputTokens: num(raw["completion_tokens"]) };
  if (cached > 0) usage.cacheReadTokens = cached;
  return usage;
}

function parseToolCalls(raw: unknown, label: string): ToolCall[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw malformed(label, "message.tool_calls is not an array");
  return raw.map((tc, i) => {
    if (!isRecord(tc) || !isRecord(tc["function"])) throw malformed(label, `tool_calls[${i}] has no function`);
    const fn = tc["function"];
    const id = tc["id"];
    const name = fn["name"];
    const args = fn["arguments"];
    if (typeof id !== "string" || typeof name !== "string") throw malformed(label, `tool_calls[${i}] missing id or name`);
    const rawInput = typeof args === "string" ? args : args === undefined ? "" : JSON.stringify(args);
    return { id, name, input: parseToolInput(rawInput), rawInput };
  });
}

// ---------------------------------------------------------------------------

type WireKind = "openai" | "openai_compatible";

class OpenAIWireProvider implements ChatProvider {
  readonly id: string;
  readonly kind: WireKind;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #models: readonly string[] | null;
  readonly #retry: Omit<RetryOptions, "signal">;
  readonly #prices: Readonly<Record<string, ModelPrice>>;
  readonly #label: string;

  constructor(
    kind: WireKind,
    id: string,
    label: string,
    baseUrl: string,
    apiKey: string | undefined,
    options: ProviderHttpOptions,
    endpoint: { access: EndpointAccess; allowHttp: boolean; seams?: NetGuardSeams | undefined },
  ) {
    this.kind = kind;
    this.id = id;
    this.#label = label;
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#apiKey = apiKey;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#models = options.models ? [...options.models] : null;
    this.#fetch =
      options.fetchImpl ??
      guardedProviderFetch({
        access: endpoint.access,
        allowHttp: endpoint.allowHttp,
        timeoutMs: this.#timeoutMs,
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        maxResponseBytes: this.#maxBytes,
        seams: endpoint.seams,
      });
    this.#retry = options.retry ?? {};
    this.#prices = options.prices ?? DEFAULT_PRICES;
  }

  /** The endpoint origin and path prefix (no key). */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  toJSON(): Record<string, unknown> {
    return { id: this.id, kind: this.kind };
  }

  [INSPECT](): string {
    return `${this.constructor.name} ${JSON.stringify(this.toJSON())}`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    assertModelAllowed(this.#models, request.model, this.#label);
    const body = JSON.stringify(buildOpenAIRequestBody(request));
    const url = `${this.#baseUrl}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (request.stream) headers["Accept"] = "text/event-stream";
    if (this.#apiKey !== undefined) headers["Authorization"] = `Bearer ${this.#apiKey}`;
    const secrets = [this.#apiKey];

    const { value, attempts } = await withRetries(
      () =>
        withTimeout(request.signal, this.#timeoutMs, async (ctx) => {
          const res = await this.#fetch(url, { method: "POST", headers, body, signal: ctx.signal });
          if (!res.ok) {
            let text = "";
            try {
              text = await readErrorBody(res, this.#label);
            } catch {
              // body unreadable; status alone is enough
            }
            throw httpError(this.#label, res.status, text, res.headers, secrets);
          }
          if (request.stream) return await this.#readStream(res, request, ctx);
          const text = await readBoundedText(res, this.#maxBytes, this.#label);
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            throw malformed(this.#label, "body is not valid JSON");
          }
          return this.#parseCompletion(json, request.model);
        }),
      { ...this.#retry, signal: request.signal },
    );
    return {
      ...value,
      attempts,
      costUsd: estimateCostUsd(value.usage, priceFor(value.model, this.#prices) ?? priceFor(request.model, this.#prices)),
    };
  }

  #parseCompletion(json: unknown, requestModel: string): Omit<ChatResponse, "attempts" | "costUsd"> {
    if (!isRecord(json)) throw malformed(this.#label, "body is not an object");
    const choices = json["choices"];
    if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0]["message"])) {
      throw malformed(this.#label, "missing choices[0].message");
    }
    const choice = choices[0];
    const message = choices[0]["message"];
    const content = message["content"];
    const refusal = message["refusal"];
    let text: string | null = typeof content === "string" ? content : null;
    let stopReason = mapOpenAIFinishReason(choice["finish_reason"]);
    if (typeof refusal === "string" && refusal !== "") {
      stopReason = "refusal";
      if (text === null || text === "") text = refusal;
    }
    return {
      id: typeof json["id"] === "string" ? json["id"] : null,
      provider: this.id,
      model: typeof json["model"] === "string" ? json["model"] : requestModel,
      text,
      toolCalls: parseToolCalls(message["tool_calls"], this.#label),
      stopReason,
      usage: parseUsage(json["usage"]),
    };
  }

  async #readStream(res: Response, request: ChatRequest, ctx: RequestContext): Promise<Omit<ChatResponse, "attempts" | "costUsd">> {
    if (!res.body) throw malformed(this.#label, "stream has no body");
    let id: string | null = null;
    let model = request.model;
    let text = "";
    let sawText = false;
    let refusal = "";
    let finish: unknown = null;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let done = false;
    const calls = new Map<number, { id: string; name: string; args: string }>();

    {
      for await (const ev of readSse(res.body, ctx.signal, { maxBytes: this.#maxBytes, providerLabel: this.#label })) {
        const data = ev.data.trim();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        if (data === "") continue;
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw malformed(this.#label, "stream chunk is not valid JSON");
        }
        if (!isRecord(chunk)) throw malformed(this.#label, "stream chunk is not an object");
        if (isRecord(chunk["error"])) {
          const e = chunk["error"];
          const msg = typeof e["message"] === "string" ? e["message"] : "stream error";
          const type = typeof e["type"] === "string" ? e["type"] : typeof e["code"] === "string" ? e["code"] : "error";
          throw streamError(this.#label, type, msg, [this.#apiKey]);
        }
        if (typeof chunk["id"] === "string") id = chunk["id"];
        if (typeof chunk["model"] === "string") model = chunk["model"];
        if (isRecord(chunk["usage"])) usage = parseUsage(chunk["usage"]);
        const choices = chunk["choices"];
        if (!Array.isArray(choices)) continue;
        for (const choice of choices) {
          if (!isRecord(choice)) continue;
          if (choice["finish_reason"] !== null && choice["finish_reason"] !== undefined) finish = choice["finish_reason"];
          const delta = choice["delta"];
          if (!isRecord(delta)) continue;
          if (typeof delta["content"] === "string" && delta["content"] !== "") {
            sawText = true;
            text += delta["content"];
            ctx.markDelivered();
            request.onText?.(delta["content"]);
          }
          if (typeof delta["refusal"] === "string") refusal += delta["refusal"];
          const tcs = delta["tool_calls"];
          if (Array.isArray(tcs)) {
            for (const tc of tcs) {
              if (!isRecord(tc)) continue;
              const index = typeof tc["index"] === "number" ? tc["index"] : calls.size;
              let entry = calls.get(index);
              if (!entry) {
                entry = { id: "", name: "", args: "" };
                calls.set(index, entry);
              }
              if (typeof tc["id"] === "string" && tc["id"] !== "") entry.id = tc["id"];
              const fn = tc["function"];
              if (isRecord(fn)) {
                if (typeof fn["name"] === "string" && fn["name"] !== "") entry.name = fn["name"];
                if (typeof fn["arguments"] === "string") entry.args += fn["arguments"];
              }
            }
          }
        }
      }
    }
    if (!done) {
      throw new ProviderError("network", `${this.#label} stream ended before [DONE]`, { retryable: true });
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => {
        if (c.id === "" || c.name === "") throw malformed(this.#label, `streamed tool call ${index} missing id or name`);
        return { id: c.id, name: c.name, input: parseToolInput(c.args), rawInput: c.args };
      });
    let stopReason = mapOpenAIFinishReason(finish);
    let finalText: string | null = sawText ? text : null;
    if (refusal !== "") {
      stopReason = "refusal";
      if (finalText === null) finalText = refusal;
    }
    return { id, provider: this.id, model, text: finalText, toolCalls, stopReason, usage };
  }
}

/**
 * OpenAI Chat Completions: `POST {baseUrl}/chat/completions` with
 * `Authorization: Bearer <key>`. An overridden base URL gets the same
 * public-address guard as every other request.
 */
export class OpenAIChatProvider extends OpenAIWireProvider {
  constructor(options: OpenAIChatProviderOptions) {
    super("openai", options.id ?? "openai", "OpenAI", options.baseUrl ?? OPENAI_DEFAULT_BASE_URL, options.apiKey, options, {
      access: "public",
      allowHttp: false,
    });
  }
}

/**
 * Administrator-configured endpoint speaking the Chat Completions wire
 * format. The base URL is validated here and every request (each attempt)
 * goes through the guarded fetch, which re-resolves and re-validates it.
 */
export class OpenAICompatibleChatProvider extends OpenAIWireProvider {
  constructor(options: OpenAICompatibleChatProviderOptions) {
    const access = options.access ?? "public";
    const allowHttp = options.allowHttp === true;
    const label = options.label ?? "Custom endpoint";
    try {
      validateEndpointUrl(options.baseUrl, { access, allowHttp });
    } catch (err) {
      if (err instanceof NetGuardError) {
        throw new ProviderError("blocked_endpoint", `${label} base URL is refused by the network policy (${err.code})`, {
          retryable: false,
        });
      }
      throw err;
    }
    const { fetchImpl: _ignored, ...http } = options as OpenAICompatibleChatProviderOptions & { fetchImpl?: unknown };
    super("openai_compatible", options.id ?? "custom", label, options.baseUrl, options.apiKey, http, {
      access,
      allowHttp,
      seams: options.netGuard,
    });
  }
}
