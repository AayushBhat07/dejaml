import { describe, expect, it } from "vitest";
import { AnthropicChatProvider } from "./anthropic.js";
import { fakeFetch, fixture, fixtureJson, hang, jsonResponse, recordingSleep, sseResponse } from "./test-helpers.js";
import { ProviderError, type ChatMessage, type ChatRequest } from "./types.js";

const KEY = "sk-ant-test-FIXTURE-SECRET-abcdef0123";
const MODEL = "claude-opus-5-5";
// Fixture prices supplied the way an administrator would (none are built in).
const PRICES = { [MODEL]: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 } };

function baseRequest(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: MODEL,
    system: "You reproduce ML claims.",
    messages: [{ role: "user", content: "Check the claim." }],
    tools: [],
    maxOutputTokens: 4096,
    ...over,
  };
}

const READ_TOOL = {
  name: "read_file",
  description: "Read a file from the workspace.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

async function catchError(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error("expected rejection");
}

describe("AnthropicChatProvider (non-streaming)", () => {
  it("sends the documented headers and body and parses a text message", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("anthropic/message-text.json"))]);
    const provider = new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl });
    const res = await provider.chat(baseRequest());

    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers).toEqual({
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    expect(calls[0]?.body).toEqual({
      model: MODEL,
      max_tokens: 4096,
      system: "You reproduce ML claims.",
      messages: [{ role: "user", content: [{ type: "text", text: "Check the claim." }] }],
    });
    const body = calls[0]?.body as Record<string, unknown>;
    for (const forbidden of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "tools"]) {
      expect(body).not.toHaveProperty(forbidden);
    }

    const content = (fixtureJson("anthropic/message-text.json") as { content: unknown }).content;
    expect(res).toEqual({
      id: "msg_fixture_text_001",
      provider: "anthropic",
      model: MODEL,
      text: "The reported accuracy reproduces within tolerance.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 2095, outputTokens: 503, cacheReadTokens: 4000 },
      // 2095*4 + 4000*0.20 + 503*20 = 19240 per million (fixture price table)
      costUsd: 0.01924,
      attempts: 1,
      providerContent: { provider: "anthropic", model: MODEL, content },
    });
  });

  it("sends tools with tool_choice auto and parses tool_use blocks", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("anthropic/message-tool-use.json"))]);
    const res = await new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl, baseUrl: "http://fixture.invalid/" }).chat(
      baseRequest({ tools: [READ_TOOL] }),
    );
    expect(calls[0]?.url).toBe("http://fixture.invalid/v1/messages");
    expect(calls[0]?.body).toMatchObject({
      tools: [{ name: "read_file", description: READ_TOOL.description, input_schema: READ_TOOL.inputSchema }],
      tool_choice: { type: "auto" },
    });
    expect(res.stopReason).toBe("tool_use");
    expect(res.text).toBe("I'll run the evaluation script and read the metrics.");
    expect(res.toolCalls).toEqual([
      {
        id: "toolu_fixture_01A",
        name: "run_command",
        input: { command: "python eval.py", timeout_s: 900 },
        rawInput: '{"command":"python eval.py","timeout_s":900}',
      },
      { id: "toolu_fixture_01B", name: "read_file", input: { path: "results/metrics.json" }, rawInput: '{"path":"results/metrics.json"}' },
    ]);
    expect(res.usage).toEqual({ inputTokens: 1500, outputTokens: 120, cacheWriteTokens: 1200 });
  });

  it("replays thinking blocks verbatim on the next request (same provider and model)", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => jsonResponse(fixture("anthropic/message-thinking.json")),
      () => jsonResponse(fixture("anthropic/message-text.json")),
    ]);
    const provider = new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl });
    const first = await provider.chat(baseRequest({ tools: [READ_TOOL] }));
    expect(first.text).toBe("Checking the seed handling first.");
    expect(first.toolCalls).toHaveLength(1);

    const history: ChatMessage[] = [
      { role: "user", content: "Check the claim." },
      {
        role: "assistant",
        text: first.text,
        toolCalls: first.toolCalls,
        ...(first.providerContent ? { providerContent: first.providerContent } : {}),
      },
      { role: "tool", toolCallId: "toolu_fixture_02A", name: "read_file", content: "import torch", isError: false },
    ];
    await provider.chat(baseRequest({ tools: [READ_TOOL], messages: history }));

    const original = (fixtureJson("anthropic/message-thinking.json") as { content: unknown }).content;
    const sent = calls[1]?.body as { messages: { role: string; content: unknown }[] };
    expect(sent.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Check the claim." }] },
      { role: "assistant", content: original },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture_02A", content: "import torch", is_error: false }] },
    ]);
    // The first request's messages are an exact prefix of the second (append-only history).
    const firstSent = calls[0]?.body as { messages: unknown[] };
    expect(sent.messages.slice(0, firstSent.messages.length)).toEqual(firstSent.messages);
  });

  it("rebuilds blocks (dropping thinking) when the provider content came from another model", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("anthropic/message-text.json"))]);
    const content = (fixtureJson("anthropic/message-thinking.json") as { content: unknown }).content;
    await new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl }).chat(
      baseRequest({
        model: "claude-sonnet-5-5",
        messages: [
          { role: "user", content: "Check the claim." },
          {
            role: "assistant",
            text: "Checking the seed handling first.",
            toolCalls: [{ id: "toolu_fixture_02A", name: "read_file", input: { path: "train.py" }, rawInput: '{"path":"train.py"}' }],
            providerContent: { provider: "anthropic", model: MODEL, content },
          },
          { role: "tool", toolCallId: "toolu_fixture_02A", name: "read_file", content: "import torch", isError: false },
        ],
      }),
    );
    const sent = calls[0]?.body as { messages: { role: string; content: unknown }[] };
    expect(sent.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Checking the seed handling first." },
        { type: "tool_use", id: "toolu_fixture_02A", name: "read_file", input: { path: "train.py" } },
      ],
    });
  });

  it("merges consecutive tool results and a following user message into one user turn", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("anthropic/message-text.json"))]);
    await new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl }).chat(
      baseRequest({
        system: "",
        messages: [
          { role: "user", content: "Run both." },
          {
            role: "assistant",
            text: null,
            toolCalls: [
              { id: "t1", name: "run_command", input: { command: "a" }, rawInput: '{"command":"a"}' },
              { id: "t2", name: "run_command", input: null, rawInput: "{bad" },
            ],
          },
          { role: "tool", toolCallId: "t1", name: "run_command", content: "ok", isError: false },
          { role: "tool", toolCallId: "t2", name: "run_command", content: "invalid input JSON", isError: true },
          { role: "user", content: "Also check the seed." },
        ],
      }),
    );
    expect(calls[0]?.body).toEqual({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        { role: "user", content: [{ type: "text", text: "Run both." }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "run_command", input: { command: "a" } },
            { type: "tool_use", id: "t2", name: "run_command", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false },
            { type: "tool_result", tool_use_id: "t2", content: "invalid input JSON", is_error: true },
            { type: "text", text: "Also check the seed." },
          ],
        },
      ],
    });
  });

  it("returns a refusal as a normal response and surfaces stop_details", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("anthropic/message-refusal.json"))]);
    const res = await new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl }).chat(baseRequest());
    expect(calls).toHaveLength(1);
    expect(res.stopReason).toBe("refusal");
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toBe("[refusal: cyber] The request was declined by a safety classifier.");
  });

  it("maps pause_turn and other stop reasons to other", async () => {
    const body = fixtureJson("anthropic/message-text.json") as Record<string, unknown>;
    const { fetchImpl } = fakeFetch([
      () => jsonResponse({ ...body, stop_reason: "pause_turn" }),
      () => jsonResponse({ ...body, stop_reason: "max_tokens" }),
    ]);
    const provider = new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl });
    expect((await provider.chat(baseRequest())).stopReason).toBe("other");
    expect((await provider.chat(baseRequest())).stopReason).toBe("max_tokens");
  });
});

describe("AnthropicChatProvider (streaming)", () => {
  it("reconstructs text, split tool input, thinking with signature, and usage from events", async () => {
    const { fetchImpl, calls } = fakeFetch([() => sseResponse(fixture("anthropic/stream-text-tool-thinking.sse"), 29)]);
    const deltas: string[] = [];
    const res = await new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl }).chat(
      baseRequest({ stream: true, tools: [READ_TOOL], onText: (d) => deltas.push(d) }),
    );
    expect(calls[0]?.body).toMatchObject({ stream: true });
    expect(calls[0]?.body).not.toHaveProperty("thinking");
    expect(deltas).toEqual(["Reading the ", "metrics."]);
    const content = [
      { type: "thinking", thinking: "Need the metrics file first.", signature: "EqQBCkYIBxgCKkBFIXTUREstreamSignature==" },
      { type: "text", text: "Reading the metrics." },
      { type: "tool_use", id: "toolu_fixture_03A", name: "read_file", input: { path: "results/metrics.json" } },
    ];
    expect(res).toEqual({
      id: "msg_fixture_stream_001",
      provider: "anthropic",
      model: MODEL,
      text: "Reading the metrics.",
      toolCalls: [
        {
          id: "toolu_fixture_03A",
          name: "read_file",
          input: { path: "results/metrics.json" },
          rawInput: '{"path": "results/metrics.json"}',
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1800, outputTokens: 87, cacheReadTokens: 2048 },
      costUsd: (1800 * 4 + 2048 * 0.2 + 87 * 20) / 1e6,
      attempts: 1,
      providerContent: { provider: "anthropic", model: MODEL, content },
    });

    // The reconstructed content (thinking + signature) is what gets replayed next turn.
    const next = fakeFetch([() => jsonResponse(fixture("anthropic/message-text.json"))]);
    await new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl: next.fetchImpl }).chat(
      baseRequest({
        messages: [
          { role: "user", content: "Check the claim." },
          { role: "assistant", text: res.text, toolCalls: res.toolCalls, providerContent: res.providerContent! },
          { role: "tool", toolCallId: "toolu_fixture_03A", name: "read_file", content: "{}", isError: false },
        ],
      }),
    );
    expect((next.calls[0]?.body as { messages: unknown[] }).messages[1]).toEqual({ role: "assistant", content });
  });

  it("keeps invalid streamed tool JSON as input null plus rawInput", async () => {
    const { fetchImpl } = fakeFetch([() => sseResponse(fixture("anthropic/stream-invalid-tool-json.sse"))]);
    const res = await new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl }).chat(baseRequest({ stream: true }));
    expect(res.stopReason).toBe("max_tokens");
    expect(res.toolCalls).toEqual([{ id: "toolu_fixture_bad", name: "run_command", input: null, rawInput: '{"command": "ls' }]);
  });

  it("turns an error event mid-stream into a retryable overloaded ProviderError", async () => {
    const { fetchImpl } = fakeFetch([() => sseResponse(fixture("anthropic/stream-error-midstream.sse"))]);
    const err = await catchError(
      new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl, retry: { maxAttempts: 1 } }).chat(baseRequest({ stream: true })),
    );
    expect(err.code).toBe("overloaded");
    expect(err.details.retryable).toBe(true);
    expect(err.message).toContain("overloaded_error");
  });

  it("retries a stream that failed with an error event before any text was delivered", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => sseResponse(fixture("anthropic/stream-error-midstream.sse")),
      () => sseResponse(fixture("anthropic/stream-text-tool-thinking.sse")),
    ]);
    const { sleep } = recordingSleep();
    const res = await new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl, retry: { sleep } }).chat(
      baseRequest({ stream: true }),
    );
    expect(calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
  });

  it("does not retry a stream failure after text reached the caller", async () => {
    const full = fixture("anthropic/stream-text-tool-thinking.sse");
    const cut = full.slice(0, full.indexOf('event: content_block_stop\ndata: {"type":"content_block_stop","index":1}'));
    const withError = `${cut}event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`;
    const { fetchImpl, calls } = fakeFetch([() => sseResponse(withError), () => sseResponse(full)]);
    const { sleep } = recordingSleep();
    const err = await catchError(
      new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl, retry: { sleep } }).chat(
        baseRequest({ stream: true, onText: () => {} }),
      ),
    );
    expect(calls).toHaveLength(1);
    expect(err.code).toBe("overloaded");
    expect(err.details.retryable).toBe(false);
  });
});

describe("AnthropicChatProvider (errors, retries, timeouts, cancellation)", () => {
  it("retries 529 overloaded and then succeeds", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => jsonResponse(fixture("anthropic/error-529-overloaded.json"), 529),
      () => jsonResponse(fixture("anthropic/message-text.json")),
    ]);
    const { sleep, delays } = recordingSleep();
    const codes: string[] = [];
    const res = await new AnthropicChatProvider({
      apiKey: KEY,
      prices: PRICES,
      fetchImpl,
      retry: { sleep, random: () => 1, onRetry: ({ error }) => codes.push(error.code) },
    }).chat(baseRequest());
    expect(calls).toHaveLength(2);
    expect(codes).toEqual(["overloaded"]);
    expect(delays).toEqual([500]);
    expect(res.attempts).toBe(2);
  });

  it("honours retry-after-ms", async () => {
    const { fetchImpl } = fakeFetch([
      () => jsonResponse(fixture("anthropic/error-529-overloaded.json"), 529, { "retry-after-ms": "750" }),
      () => jsonResponse(fixture("anthropic/message-text.json")),
    ]);
    const { sleep, delays } = recordingSleep();
    await new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl, retry: { sleep } }).chat(baseRequest());
    expect(delays).toEqual([750]);
  });

  it("does not retry 400 and includes the provider error type and message", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("anthropic/error-400.json"), 400)]);
    const err = await catchError(new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl }).chat(baseRequest()));
    expect(calls).toHaveLength(1);
    expect(err.code).toBe("invalid_request");
    expect(err.message).toBe(
      'Anthropic HTTP 400 invalid_request_error: tool_choice: type "tool" and "any" are not supported for this model.',
    );
  });

  it("maps 401/403/404 without retrying", async () => {
    const body = (type: string) => ({ type: "error", error: { type, message: "nope" } });
    const { fetchImpl, calls } = fakeFetch([
      () => jsonResponse(body("authentication_error"), 401),
      () => jsonResponse(body("permission_error"), 403),
      () => jsonResponse(body("not_found_error"), 404),
    ]);
    const provider = new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await catchError(provider.chat(baseRequest()))).code);
    expect(codes).toEqual(["authentication", "permission", "not_found"]);
    expect(calls).toHaveLength(3);
  });

  it("times out a hung request with the timeout code (retryable, bounded)", async () => {
    const { fetchImpl, calls } = fakeFetch([hang, hang]);
    const { sleep } = recordingSleep();
    const err = await catchError(
      new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl, timeoutMs: 20, retry: { sleep, maxAttempts: 2 } }).chat(
        baseRequest(),
      ),
    );
    expect(err.code).toBe("timeout");
    expect(err.details.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("reports caller cancellation during a request as cancelled and does not retry", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = fakeFetch([
      (req) => {
        setTimeout(() => controller.abort(), 5);
        return hang(req);
      },
    ]);
    const err = await catchError(
      new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl, timeoutMs: 10_000 }).chat(
        baseRequest({ signal: controller.signal }),
      ),
    );
    expect(err.code).toBe("cancelled");
    expect(err.details.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("aborts promptly while sleeping between retries", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = fakeFetch([
      () => jsonResponse(fixture("anthropic/error-529-overloaded.json"), 529, { "retry-after": "10" }),
    ]);
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);
    const err = await catchError(
      new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl }).chat(baseRequest({ signal: controller.signal })),
    );
    expect(err.code).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toHaveLength(1);
  });

  it("never exposes the key in errors or the serialized provider", async () => {
    const { fetchImpl } = fakeFetch([
      () => jsonResponse({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }, 401),
      () => sseResponse(fixture("anthropic/stream-error-midstream.sse")),
    ]);
    const provider = new AnthropicChatProvider({ apiKey: KEY, prices: PRICES, fetchImpl, retry: { maxAttempts: 1 } });
    const errors = [await catchError(provider.chat(baseRequest())), await catchError(provider.chat(baseRequest({ stream: true })))];
    for (const e of errors) {
      expect(e.message).not.toContain(KEY);
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
    expect(JSON.stringify(provider)).not.toContain(KEY);
    expect(JSON.stringify({ ...provider })).not.toContain(KEY);
  });
});
