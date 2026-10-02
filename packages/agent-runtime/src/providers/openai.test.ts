import { describe, expect, it } from "vitest";
import { OpenAIChatProvider } from "./openai.js";
import { fakeFetch, fixture, fixtureJson, jsonResponse, recordingSleep, sseResponse } from "./test-helpers.js";
import { ProviderError, type ChatRequest } from "./types.js";

const KEY = "sk-test-FIXTURE-SECRET-0123456789";
const PRICES = { "gpt-fixture-1": { inputPerMTok: 1, outputPerMTok: 4, cacheReadPerMTok: 0.25 } };

function baseRequest(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "gpt-fixture-1",
    system: "You reproduce ML claims.",
    messages: [{ role: "user", content: "Check the claim." }],
    tools: [],
    maxOutputTokens: 1024,
    ...over,
  };
}

const RUN_TOOL = {
  name: "run_command",
  description: "Run a shell command in the lab.",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
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

describe("OpenAIChatProvider (non-streaming)", () => {
  it("sends the documented request and parses a text completion", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("openai/chat-text.json"))]);
    const provider = new OpenAIChatProvider({ apiKey: KEY, fetchImpl, prices: PRICES });
    const res = await provider.chat(baseRequest());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers).toEqual({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    expect(calls[0]?.body).toEqual({
      model: "gpt-fixture-1",
      messages: [
        { role: "system", content: "You reproduce ML claims." },
        { role: "user", content: "Check the claim." },
      ],
      max_completion_tokens: 1024,
    });

    expect(res).toEqual({
      id: "chatcmpl-fixture-text-001",
      provider: "openai",
      model: "gpt-fixture-1",
      text: "The claim reproduces: accuracy 0.913 vs reported 0.915.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 176, outputTokens: 40, cacheReadTokens: 1024 },
      // 176*1 + 1024*0.25 + 40*4 = 592 per million
      costUsd: 0.000592,
      attempts: 1,
    });
  });

  it("serializes history, tools and tool results in Chat Completions format", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("openai/chat-text.json"))]);
    const provider = new OpenAIChatProvider({ apiKey: KEY, fetchImpl, baseUrl: "https://gateway.example.test/v1/" });
    await provider.chat(
      baseRequest({
        tools: [RUN_TOOL],
        messages: [
          { role: "user", content: "Run it." },
          {
            role: "assistant",
            text: null,
            toolCalls: [{ id: "call_1", name: "run_command", input: { command: "ls" }, rawInput: '{"command": "ls"}' }],
          },
          { role: "tool", toolCallId: "call_1", name: "run_command", content: "README.md", isError: false },
          { role: "assistant", text: "Done.", toolCalls: [] },
          { role: "user", content: "Thanks." },
        ],
      }),
    );
    expect(calls[0]?.url).toBe("https://gateway.example.test/v1/chat/completions");
    expect(calls[0]?.body).toEqual({
      model: "gpt-fixture-1",
      messages: [
        { role: "system", content: "You reproduce ML claims." },
        { role: "user", content: "Run it." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command": "ls"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "README.md" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "Thanks." },
      ],
      tools: [{ type: "function", function: { name: RUN_TOOL.name, description: RUN_TOOL.description, parameters: RUN_TOOL.inputSchema } }],
      tool_choice: "auto",
      max_completion_tokens: 1024,
    });
  });

  it("parses tool calls", async () => {
    const { fetchImpl } = fakeFetch([() => jsonResponse(fixture("openai/chat-tool-call.json"))]);
    const res = await new OpenAIChatProvider({ apiKey: KEY, fetchImpl }).chat(baseRequest({ tools: [RUN_TOOL] }));
    expect(res.stopReason).toBe("tool_use");
    expect(res.text).toBeNull();
    expect(res.toolCalls).toEqual([
      {
        id: "call_fixture_A1",
        name: "run_command",
        input: { command: "python train.py --seed 1", timeout_s: 600 },
        rawInput: '{"command":"python train.py --seed 1","timeout_s":600}',
      },
      { id: "call_fixture_B2", name: "read_file", input: { path: "results/metrics.json" }, rawInput: '{"path":"results/metrics.json"}' },
    ]);
    expect(res.usage).toEqual({ inputTokens: 800, outputTokens: 60 });
    expect(res.costUsd).toBeNull(); // no OpenAI prices are built in
  });

  it("keeps invalid tool-argument JSON as input null plus rawInput", async () => {
    const { fetchImpl } = fakeFetch([() => jsonResponse(fixture("openai/chat-invalid-tool-args.json"))]);
    const res = await new OpenAIChatProvider({ apiKey: KEY, fetchImpl }).chat(baseRequest({ tools: [RUN_TOOL] }));
    expect(res.toolCalls).toEqual([{ id: "call_fixture_bad", name: "run_command", input: null, rawInput: '{"command": "ls -la' }]);
  });

  it("maps finish reasons", async () => {
    const body = fixtureJson("openai/chat-text.json") as { choices: { finish_reason: string }[] };
    const cases: [string, string][] = [
      ["length", "max_tokens"],
      ["content_filter", "refusal"],
      ["something_new", "other"],
    ];
    for (const [finish, expected] of cases) {
      const b = structuredClone(body);
      b.choices[0]!.finish_reason = finish;
      const { fetchImpl } = fakeFetch([() => jsonResponse(b)]);
      const res = await new OpenAIChatProvider({ apiKey: KEY, fetchImpl }).chat(baseRequest());
      expect(res.stopReason).toBe(expected);
    }
  });
});

describe("OpenAIChatProvider (streaming)", () => {
  it("accumulates text deltas and index-keyed tool-call fragments, takes usage from the final chunk", async () => {
    const { fetchImpl, calls } = fakeFetch([() => sseResponse(fixture("openai/stream-text-and-tools.sse"), 23)]);
    const deltas: string[] = [];
    const res = await new OpenAIChatProvider({ apiKey: KEY, fetchImpl, prices: PRICES }).chat(
      baseRequest({ stream: true, tools: [RUN_TOOL], onText: (d) => deltas.push(d) }),
    );
    expect(calls[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(calls[0]?.headers["accept"]).toBe("text/event-stream");
    expect(deltas).toEqual(["Running ", "the baseline."]);
    expect(res).toEqual({
      id: "chatcmpl-fixture-stream-001",
      provider: "openai",
      model: "gpt-fixture-1",
      text: "Running the baseline.",
      toolCalls: [
        { id: "call_fixture_S1", name: "run_command", input: { command: "make test" }, rawInput: '{"command":"make test"}' },
        { id: "call_fixture_S2", name: "read_file", input: { path: "README.md" }, rawInput: '{"path":"README.md"}' },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 438, outputTokens: 48, cacheReadTokens: 512 },
      costUsd: (438 * 1 + 512 * 0.25 + 48 * 4) / 1e6,
      attempts: 1,
    });
  });

  it("treats a stream that ends without [DONE] as a retryable network error", async () => {
    const truncated = fixture("openai/stream-text-and-tools.sse").split("\n\n").slice(0, 1).join("\n\n") + "\n\n";
    const { fetchImpl, calls } = fakeFetch([() => sseResponse(truncated), () => sseResponse(fixture("openai/stream-text-and-tools.sse"))]);
    const { sleep } = recordingSleep();
    const res = await new OpenAIChatProvider({ apiKey: KEY, fetchImpl, retry: { sleep, random: () => 0 } }).chat(
      baseRequest({ stream: true }),
    );
    expect(calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
  });
});

describe("OpenAIChatProvider (errors and retries)", () => {
  it("retries 429 after the retry-after delay", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => jsonResponse(fixture("openai/error-429.json"), 429, { "retry-after": "1" }),
      () => jsonResponse(fixture("openai/chat-text.json")),
    ]);
    const { sleep, delays } = recordingSleep();
    const res = await new OpenAIChatProvider({ apiKey: KEY, fetchImpl, retry: { sleep } }).chat(baseRequest());
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([1000]);
    expect(res.attempts).toBe(2);
  });

  it("fails with rate_limited when retry-after exceeds the cap", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("openai/error-429.json"), 429, { "retry-after": "120" })]);
    const { sleep, delays } = recordingSleep();
    const err = await catchError(new OpenAIChatProvider({ apiKey: KEY, fetchImpl, retry: { sleep } }).chat(baseRequest()));
    expect(err.code).toBe("rate_limited");
    expect(err.details).toMatchObject({ status: 429, retryable: false, retryAfterMs: 120_000, attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("does not retry 400 and surfaces the provider error type and message", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("openai/error-400.json"), 400)]);
    const err = await catchError(new OpenAIChatProvider({ apiKey: KEY, fetchImpl }).chat(baseRequest()));
    expect(calls).toHaveLength(1);
    expect(err.code).toBe("invalid_request");
    expect(err.details).toMatchObject({ status: 400, retryable: false, attempts: 1 });
    expect(err.message).toContain("invalid_request_error");
    expect(err.message).toContain("Invalid schema for function 'run_command'");
    expect(err.message.length).toBeLessThanOrEqual(500);
  });

  it("retries 500 twice with jittered backoff and then succeeds", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => jsonResponse(fixture("openai/error-500.json"), 500),
      () => jsonResponse(fixture("openai/error-500.json"), 500),
      () => jsonResponse(fixture("openai/chat-text.json")),
    ]);
    const { sleep, delays } = recordingSleep();
    const res = await new OpenAIChatProvider({ apiKey: KEY, fetchImpl, retry: { sleep, random: () => 0.5 } }).chat(baseRequest());
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([250, 500]); // 0.5 * 500, 0.5 * 1000
    expect(res.attempts).toBe(3);
  });

  it("gives up after maxAttempts with the last error", async () => {
    const { fetchImpl, calls } = fakeFetch(Array.from({ length: 4 }, () => () => jsonResponse(fixture("openai/error-500.json"), 500)));
    const { sleep } = recordingSleep();
    const err = await catchError(new OpenAIChatProvider({ apiKey: KEY, fetchImpl, retry: { sleep } }).chat(baseRequest()));
    expect(calls).toHaveLength(4);
    expect(err.code).toBe("server_error");
    expect(err.details.attempts).toBe(4);
  });

  it("reports a malformed JSON body as malformed_response without retrying", async () => {
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse('{"id":"chatcmpl-x","choices":[', 200)]);
    const err = await catchError(new OpenAIChatProvider({ apiKey: KEY, fetchImpl }).chat(baseRequest()));
    expect(err.code).toBe("malformed_response");
    expect(calls).toHaveLength(1);
  });

  it("maps a network failure to a retryable network error", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => {
        throw new TypeError("fetch failed");
      },
      () => jsonResponse(fixture("openai/chat-text.json")),
    ]);
    const { sleep } = recordingSleep();
    const res = await new OpenAIChatProvider({ apiKey: KEY, fetchImpl, retry: { sleep } }).chat(baseRequest());
    expect(calls).toHaveLength(2);
    expect(res.attempts).toBe(2);
  });
});

describe("API key handling", () => {
  it("never exposes the key in thrown errors or in the serialized provider", async () => {
    const { fetchImpl } = fakeFetch([
      () => jsonResponse(fixture("openai/error-401-echoes-key.json"), 401),
      () => jsonResponse(fixture("openai/error-400.json"), 400),
      () => jsonResponse("not json", 200),
      () => {
        throw new TypeError(`connect failed`);
      },
    ]);
    const provider = new OpenAIChatProvider({ apiKey: KEY, fetchImpl, retry: { maxAttempts: 1 } });
    const errors: ProviderError[] = [];
    for (let i = 0; i < 4; i++) errors.push(await catchError(provider.chat(baseRequest())));
    expect(errors.map((e) => e.code)).toEqual(["authentication", "invalid_request", "malformed_response", "network"]);
    for (const e of errors) {
      expect(e.message).not.toContain(KEY);
      expect(JSON.stringify(e)).not.toContain(KEY);
      expect(String(e.stack)).not.toContain(KEY);
    }
    expect(errors[0]?.message).toContain("[redacted]");
    expect(JSON.stringify(provider)).not.toContain(KEY);
    expect(JSON.stringify({ ...provider })).not.toContain(KEY);
  });
});
