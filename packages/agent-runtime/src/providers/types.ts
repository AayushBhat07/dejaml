/**
 * Provider-neutral chat types. Each adapter translates these to and from its
 * provider's wire format (endpoint, headers, tool-call shape, streaming, errors).
 * Model-provider access is not an agent runtime: adapters only exchange one
 * request and one response; the loop, tools, and limits live in the runtime.
 */

export type JsonSchema = Record<string, unknown>;

export type ToolSpec = {
  /** `^[a-zA-Z0-9_-]{1,64}$`, valid for both OpenAI and Anthropic. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type ToolCall = {
  /** Provider-issued id, echoed back on the matching tool result. */
  id: string;
  name: string;
  /** Parsed arguments; `null` when the provider sent arguments that were not valid JSON. */
  input: unknown;
  /** The raw argument text as received, kept for receipts and malformed-input errors. */
  rawInput: string;
};

export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      text: string | null;
      toolCalls: ToolCall[];
      /**
       * Provider-native content, replayed unchanged on later turns when the
       * same provider and model continue the conversation (Anthropic thinking
       * blocks must be echoed back verbatim). Opaque to the runtime.
       */
      providerContent?: { provider: string; model: string; content: unknown };
    }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError: boolean };

export type ChatRequest = {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** Stream the response; `onText` receives text deltas as they arrive. */
  stream?: boolean;
  onText?: (delta: string) => void;
};

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type ChatResponse = {
  id: string | null;
  provider: string;
  model: string;
  text: string | null;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: TokenUsage;
  /** Estimated cost in USD from the configured price table; null when the model has no price. */
  costUsd: number | null;
  /** Provider retries that happened inside this call. */
  attempts: number;
  providerContent?: { provider: string; model: string; content: unknown };
};

export type ProviderErrorCode =
  | "authentication"
  | "permission"
  | "invalid_request"
  | "not_found"
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "timeout"
  | "network"
  | "cancelled"
  | "malformed_response"
  | "refusal"
  /** The response body exceeded the configured byte cap. */
  | "response_too_large"
  /** The requested model is not on the provider's configured allowlist; no request was sent. */
  | "model_not_allowed"
  /** The endpoint (or where it resolved or redirected to) is refused by the network policy. */
  | "blocked_endpoint";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly details: { status?: number; retryable: boolean; retryAfterMs?: number; attempts?: number } = { retryable: false },
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** `util.inspect` hook: providers print only their public identity, never keys. */
export const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export interface ChatProvider {
  /** Configured provider id, such as `openai`, `anthropic`, or `custom`. */
  readonly id: string;
  readonly kind: "openai" | "anthropic" | "openai_compatible" | "scripted";
  chat(request: ChatRequest): Promise<ChatResponse>;
}

/** Price per million tokens in USD. */
export type ModelPrice = { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number };
