import { inspect } from "node:util";

import { NetGuardError } from "@dejaml/net-guard";
import { describe, expect, it } from "vitest";

import { AnthropicChatProvider } from "./anthropic.js";
import { OpenAIChatProvider } from "./openai.js";
import type { FetchLike } from "./retry.js";
import { fakeFetch, fixture, jsonResponse, recordingSleep, sseResponse } from "./test-helpers.js";
import { ProviderError, type ChatProvider, type ChatRequest } from "./types.js";

/*
 * Cross-adapter hardening: the two official adapters must each speak their
 * own wire format, refuse unlisted models before any request, cap response
 * sizes, retry only what is worth retrying, and never reveal their key.
 */

const OPENAI_KEY = "sk-test-FIXTURE-hardening-openai-0001";
const ANTHROPIC_KEY = "sk-ant-test-FIXTURE-hardening-0002";

type Adapter = {
  name: string;
  key: string;
  model: string;
  okBody: () => Response;
  make: (fetchImpl: FetchLike, extra?: Record<string, unknown>) => ChatProvider;
  streamFixture: string;
};

const adapters: Adapter[] = [
  {
    name: "openai",
    key: OPENAI_KEY,
    model: "gpt-fixture-1",
    okBody: () => jsonResponse(fixture("openai/chat-text.json")),
    make: (fetchImpl, extra = {}) => new OpenAIChatProvider({ apiKey: OPENAI_KEY, fetchImpl, models: ["gpt-fixture-1"], ...extra }),
    streamFixture: "openai/stream-text-and-tools.sse",
  },
  {
    name: "anthropic",
    key: ANTHROPIC_KEY,
    model: "claude-opus-5-5",
    okBody: () => jsonResponse(fixture("anthropic/message-text.json")),
    make: (fetchImpl, extra = {}) => new AnthropicChatProvider({ apiKey: ANTHROPIC_KEY, fetchImpl, models: ["claude-opus-5-5"], ...extra }),
    streamFixture: "anthropic/stream-text-tool-thinking.sse",
  },
];

function request(model: string, over: Partial<ChatRequest> = {}): ChatRequest {
  return { model, system: "", messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 64, ...over };
}

async function catchError(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error("expected rejection");
}

/** A streaming body that never ends on its own: `chunk` repeated forever. */
function endless(chunk: string, headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(chunk);
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes);
      },
    }),
    { status: 200, headers },
  );
}

describe("adapter wire formats are separate", () => {
  it("OpenAI uses Bearer auth on /chat/completions; Anthropic uses x-api-key + anthropic-version on /v1/messages", async () => {
    const oa = fakeFetch([() => jsonResponse(fixture("openai/chat-text.json"))]);
    await adapters[0]!.make(oa.fetchImpl).chat(request("gpt-fixture-1"));
    expect(oa.calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(oa.calls[0]?.headers["authorization"]).toBe(`Bearer ${OPENAI_KEY}`);
    expect(oa.calls[0]?.headers["x-api-key"]).toBeUndefined();
    expect(oa.calls[0]?.headers["anthropic-version"]).toBeUndefined();
    expect(oa.calls[0]?.body).toHaveProperty("max_completion_tokens");
    expect(oa.calls[0]?.body).not.toHaveProperty("max_tokens");

    const an = fakeFetch([() => jsonResponse(fixture("anthropic/message-text.json"))]);
    await adapters[1]!.make(an.fetchImpl).chat(request("claude-opus-5-5"));
    expect(an.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(an.calls[0]?.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(an.calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(an.calls[0]?.headers["authorization"]).toBeUndefined();
    expect(an.calls[0]?.body).toHaveProperty("max_tokens");
    expect(an.calls[0]?.body).not.toHaveProperty("max_completion_tokens");
  });

  it("continues a tool conversation in each provider's own shape", async () => {
    const history: ChatRequest["messages"] = [
      { role: "user", content: "Run it." },
      { role: "assistant", text: null, toolCalls: [{ id: "call_1", name: "run_command", input: { command: "ls" }, rawInput: '{"command":"ls"}' }] },
      { role: "tool", toolCallId: "call_1", name: "run_command", content: "a.txt", isError: false },
    ];
    const oa = fakeFetch([() => jsonResponse(fixture("openai/chat-text.json"))]);
    await adapters[0]!.make(oa.fetchImpl).chat(request("gpt-fixture-1", { messages: history }));
    expect((oa.calls[0]?.body as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "Run it." },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "a.txt" },
    ]);
    const an = fakeFetch([() => jsonResponse(fixture("anthropic/message-text.json"))]);
    await adapters[1]!.make(an.fetchImpl).chat(request("claude-opus-5-5", { messages: history }));
    expect((an.calls[0]?.body as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Run it." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "run_command", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "a.txt", is_error: false }] },
    ]);
  });
});

describe.each(adapters)("$name adapter hardening", (adapter) => {
  it("refuses a model outside the allowlist before any network call", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const err = await catchError(adapter.make(fetchImpl).chat(request("not-a-listed-model")));
    expect(err.code).toBe("model_not_allowed");
    expect(err.details.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses a JSON body whose declared length is over the cap", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse("{}", 200, { "content-length": "4096" })]);
    const err = await catchError(adapter.make(fetchImpl, { maxResponseBytes: 1024 }).chat(request(adapter.model)));
    expect(err.code).toBe("response_too_large");
    expect(err.details.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("stops reading an undeclared JSON body at the cap", async () => {
    const { fetchImpl } = fakeFetch([() => endless('{"pad":"xxxxxxxxxxxxxxxx"}')]);
    const err = await catchError(adapter.make(fetchImpl, { maxResponseBytes: 4096 }).chat(request(adapter.model)));
    expect(err.code).toBe("response_too_large");
  });

  it("stops reading an SSE stream at the cap", async () => {
    const { fetchImpl } = fakeFetch([() => endless(": keep-alive padding padding padding\n\n", { "content-type": "text/event-stream" })]);
    const err = await catchError(adapter.make(fetchImpl, { maxResponseBytes: 4096 }).chat(request(adapter.model, { stream: true })));
    expect(err.code).toBe("response_too_large");
  });

  it("still parses a full stream under the default cap", async () => {
    const { fetchImpl } = fakeFetch([() => sseResponse(fixture(adapter.streamFixture))]);
    const res = await adapter.make(fetchImpl, { models: undefined }).chat(request(adapter.model, { stream: true }));
    expect(res.toolCalls.length).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
  });

  it.each([400, 401, 403, 404, 413, 422])("does not retry HTTP %i", async (status) => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse({ error: { type: "x", message: "no" } }, status), () => adapter.okBody()]);
    const { sleep } = recordingSleep();
    const err = await catchError(adapter.make(fetchImpl, { retry: { sleep } }).chat(request(adapter.model)));
    expect(err.details.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each([408, 409, 429, 500, 502, 503, 504, 529])("retries HTTP %i", async (status) => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse({ error: { type: "x", message: "busy" } }, status), () => adapter.okBody()]);
    const { sleep } = recordingSleep();
    const res = await adapter.make(fetchImpl, { retry: { sleep } }).chat(request(adapter.model));
    expect(calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
  });

  it("honours x-should-retry both ways", async () => {
    const { sleep } = recordingSleep();
    const noRetry = fakeFetch([() => jsonResponse({ error: { message: "stop" } }, 503, { "x-should-retry": "false" })]);
    expect((await catchError(adapter.make(noRetry.fetchImpl, { retry: { sleep } }).chat(request(adapter.model)))).details.retryable).toBe(false);
    expect(noRetry.calls).toHaveLength(1);
    const retry = fakeFetch([() => jsonResponse({ error: { message: "again" } }, 400, { "x-should-retry": "true" }), () => adapter.okBody()]);
    expect((await adapter.make(retry.fetchImpl, { retry: { sleep } }).chat(request(adapter.model))).attempts).toBe(2);
  });

  it("retries a connection reset", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    const { fetchImpl, calls } = fakeFetch([
      () => {
        throw reset;
      },
      () => {
        throw new NetGuardError("request_failed", "Request failed (ECONNRESET)");
      },
      () => adapter.okBody(),
    ]);
    const { sleep } = recordingSleep();
    const res = await adapter.make(fetchImpl, { retry: { sleep } }).chat(request(adapter.model));
    expect(calls).toHaveLength(3);
    expect(res.attempts).toBe(3);
  });

  it("maps network-guard refusals to blocked_endpoint without retrying", async () => {
    for (const code of ["private_address", "unsafe_hostname", "redirect_refused", "pinning_violation", "scheme_not_allowed"] as const) {
      const { fetchImpl, calls } = fakeFetch([
        () => {
          throw new NetGuardError(code, `refused: ${code}`);
        },
      ]);
      const err = await catchError(adapter.make(fetchImpl).chat(request(adapter.model)));
      expect([code, err.code, err.details.retryable]).toEqual([code, "blocked_endpoint", false]);
      expect(calls).toHaveLength(1);
    }
    const big = fakeFetch([
      () => {
        throw new NetGuardError("response_too_large", "Body exceeds 10 bytes");
      },
    ]);
    expect((await catchError(adapter.make(big.fetchImpl).chat(request(adapter.model)))).code).toBe("response_too_large");
  });

  it("keeps the key out of JSON, util.inspect, and errors", async () => {
    const { fetchImpl } = fakeFetch([() => jsonResponse({ error: { type: "authentication_error", message: `bad key ${adapter.key}` } }, 401)]);
    const provider = adapter.make(fetchImpl);
    const err = await catchError(provider.chat(request(adapter.model)));
    for (const text of [JSON.stringify(provider), inspect(provider, { depth: 10, showHidden: true }), String(provider), err.message, JSON.stringify(err), inspect(err)]) {
      expect(text).not.toContain(adapter.key);
    }
    expect(inspect(provider)).toContain(adapter.name);
  });
});

describe("rate-limit headers", () => {
  it("waits for Anthropic's exhausted-limit reset when a 429 has no retry-after", async () => {
    const reset = new Date(Date.now() + 3_000).toISOString();
    const { fetchImpl, calls } = fakeFetch([
      () =>
        jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "slow" } }, 429, {
          "anthropic-ratelimit-requests-remaining": "5",
          "anthropic-ratelimit-requests-reset": new Date(Date.now() + 60_000).toISOString(),
          "anthropic-ratelimit-tokens-remaining": "0",
          "anthropic-ratelimit-tokens-reset": reset,
        }),
      () => jsonResponse(fixture("anthropic/message-text.json")),
    ]);
    const { sleep, delays } = recordingSleep();
    await adapters[1]!.make(fetchImpl, { retry: { sleep } }).chat(request("claude-opus-5-5"));
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(2_000);
    expect(delays[0]).toBeLessThanOrEqual(3_000);
  });

  it("waits for OpenAI's x-ratelimit-reset duration, and gives up when it exceeds the cap", async () => {
    const { sleep, delays } = recordingSleep();
    const ok = fakeFetch([
      () => jsonResponse(fixture("openai/error-429.json"), 429, { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1.5s" }),
      () => jsonResponse(fixture("openai/chat-text.json")),
    ]);
    await adapters[0]!.make(ok.fetchImpl, { retry: { sleep } }).chat(request("gpt-fixture-1"));
    expect(delays).toEqual([1500]);

    const capped = fakeFetch([
      () => jsonResponse(fixture("openai/error-429.json"), 429, { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "6m0s" }),
    ]);
    const err = await catchError(adapters[0]!.make(capped.fetchImpl, { retry: { sleep, maxDelayMs: 20_000 } }).chat(request("gpt-fixture-1")));
    expect(err.code).toBe("rate_limited");
    expect(err.details).toMatchObject({ retryable: false, retryAfterMs: 360_000 });
    expect(capped.calls).toHaveLength(1);
  });

  it("prefers retry-after-ms over the reset headers", async () => {
    const { sleep, delays } = recordingSleep();
    const { fetchImpl } = fakeFetch([
      () =>
        jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "slow" } }, 429, {
          "retry-after-ms": "250",
          "anthropic-ratelimit-tokens-remaining": "0",
          "anthropic-ratelimit-tokens-reset": new Date(Date.now() + 9_000).toISOString(),
        }),
      () => jsonResponse(fixture("anthropic/message-text.json")),
    ]);
    await adapters[1]!.make(fetchImpl, { retry: { sleep } }).chat(request("claude-opus-5-5"));
    expect(delays).toEqual([250]);
  });
});
