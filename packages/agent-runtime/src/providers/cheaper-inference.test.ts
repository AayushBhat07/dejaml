import http, { type ServerResponse } from "node:http";
import { inspect } from "node:util";

import type { EndpointTransport, Resolver } from "@dejaml/net-guard";
import { afterEach, describe, expect, it } from "vitest";

import { nativeRuntimeUrlViolation } from "../native-guard.js";
import {
  CHEAPER_INFERENCE_BASE_URL,
  ProviderConfigError,
  ProviderSelectionError,
  createChatProvider,
  loadProviderConfig,
  providerRoute,
  publicProviders,
  type CreateChatProviderOptions,
} from "./registry.js";
import { recordingSleep, startLocalServer, type ServerHit } from "./test-helpers.js";
import { ProviderError, type ChatRequest } from "./types.js";

/*
 * Cheaper Inference: a trusted third-party OpenAI-compatible gateway at a
 * fixed endpoint. These tests drive the real guarded fetch: the resolver and
 * transport seams send the socket to a local stand-in server, while the
 * transport records exactly where the request was addressed (scheme, host,
 * port and path). No real key is used and nothing leaves the machine.
 */

const KEY = "ci-test-key-000000";
const MODEL = "claude-sonnet-5.5";
const ENV = { DEJAML_CHEAPER_INFERENCE_API_KEY: KEY };

type Addressed = { protocol: string; hostname: string; port: number; path: string; servername: string | undefined };

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

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

/**
 * A stand-in for the gateway: `handle` answers each request. Returns the
 * guarded-fetch seams that route the pinned socket to it and record where each
 * request was addressed.
 */
async function gateway(handle: (res: ServerResponse, hit: ServerHit, index: number) => void) {
  const server = await startLocalServer((_req, res, hit) => handle(res, hit, server.hits.length - 1));
  close = server.close;
  const addressed: Addressed[] = [];
  const resolved: string[] = [];
  const resolver: Resolver = async (hostname) => {
    resolved.push(hostname);
    return [{ address: "127.0.0.1", family: 4 }];
  };
  const transport: EndpointTransport = (options, callback) => {
    addressed.push({
      protocol: String(options.protocol),
      hostname: String(options.hostname),
      port: Number(options.port),
      path: String(options.path),
      servername: options.servername,
    });
    const { lookup: _lookup, servername: _servername, ...rest } = options;
    return http.request({ ...rest, protocol: "http:", hostname: "127.0.0.1", port: server.port, family: 4 }, callback);
  };
  // The stand-in listens on loopback, so the test widens the address policy; production never sets this seam.
  const netGuard: NonNullable<CreateChatProviderOptions["netGuard"]> = { resolver, transport, addressPolicy: () => true };
  return { server, addressed, resolved, netGuard };
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(typeof body === "string" ? body : JSON.stringify(body));
}

const COMPLETION = {
  id: "chatcmpl-ci-0001",
  object: "chat.completion",
  model: MODEL,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_ci_1", type: "function", function: { name: "run_command", arguments: '{"command":"make test"}' } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, prompt_tokens_details: { cached_tokens: 1000 } },
};

describe("Cheaper Inference configuration", () => {
  it("is offered with its label and the default model once its key is set; /api/config shows only id, label and models", () => {
    const config = loadProviderConfig(ENV);
    expect(publicProviders(config)).toEqual([{ id: "cheaper_inference", label: "Cheaper Inference", models: [MODEL] }]);
    const text = JSON.stringify(publicProviders(config));
    for (const hidden of [KEY, "cheaperinference.com", "baseUrl", "route", "trusted_gateway"]) expect(text).not.toContain(hidden);
    const provider = config.providers.find((p) => p.id === "cheaper_inference");
    expect(provider).toMatchObject({ kind: "openai_compatible", route: "trusted_gateway", baseUrl: CHEAPER_INFERENCE_BASE_URL });
    // Not offered without a key.
    expect(publicProviders(loadProviderConfig({ DEJAML_CHEAPER_INFERENCE_MODELS: MODEL }))).toEqual([]);
  });

  it("permits only claude-sonnet-5.5 in DEJAML_CHEAPER_INFERENCE_MODELS", () => {
    expect(publicProviders(loadProviderConfig({ ...ENV, DEJAML_CHEAPER_INFERENCE_MODELS: ` ${MODEL} ` }))[0]?.models).toEqual([MODEL]);
    for (const models of ["claude-opus-5-5", "claude-sonnet-5-5", `${MODEL},claude-opus-5-5`, "gpt-fixture-1"]) {
      expect(() => loadProviderConfig({ ...ENV, DEJAML_CHEAPER_INFERENCE_MODELS: models })).toThrow(ProviderConfigError);
    }
    try {
      loadProviderConfig({ ...ENV, DEJAML_CHEAPER_INFERENCE_MODELS: "claude-opus-5-5" });
    } catch (err) {
      expect((err as ProviderConfigError).problems).toEqual([
        'DEJAML_CHEAPER_INFERENCE_MODELS lists "claude-opus-5-5", which is not permitted for Cheaper Inference (allowed: claude-sonnet-5.5)',
      ]);
    }
  });

  it("has no setting that changes its endpoint", () => {
    for (const name of ["DEJAML_CHEAPER_INFERENCE_BASE_URL", "DEJAML_CHEAPER_INFERENCE_URL", "DEJAML_CHEAPER_INFERENCE_ENDPOINT"]) {
      expect(() => loadProviderConfig({ ...ENV, [name]: "https://evil.example.test/v1" })).toThrow(
        /is not supported: the Cheaper Inference endpoint is fixed at https:\/\/api\.cheaperinference\.com\/v1/,
      );
    }
  });

  it("refuses a malformed key without echoing it", () => {
    try {
      loadProviderConfig({ DEJAML_CHEAPER_INFERENCE_API_KEY: "ci test key 000000" });
      throw new Error("expected ProviderConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderConfigError);
      expect((err as Error).message).toContain("DEJAML_CHEAPER_INFERENCE_API_KEY is not a valid API key");
      expect((err as Error).message).not.toContain("ci test key");
    }
  });

  it("keeps the generic custom provider separate and unchanged", () => {
    const config = loadProviderConfig({
      ...ENV,
      DEJAML_CUSTOM_BASE_URL: "https://llm.lab.example.test/v1",
      DEJAML_CUSTOM_MODELS: "lab-model",
    });
    expect(publicProviders(config)).toEqual([
      { id: "cheaper_inference", label: "Cheaper Inference", models: [MODEL] },
      { id: "custom", label: "Custom endpoint", models: ["lab-model"] },
    ]);
    const custom = config.providers.find((p) => p.id === "custom");
    expect(custom).toMatchObject({ kind: "openai_compatible", route: "custom", baseUrl: "https://llm.lab.example.test/v1" });
    expect(() => createChatProvider(config, "custom", MODEL)).toThrow(ProviderSelectionError);
  });

  it("never reveals its key through serialization or util.inspect", () => {
    const config = loadProviderConfig(ENV);
    const provider = createChatProvider(config, "cheaper_inference", MODEL);
    for (const text of [
      JSON.stringify(config),
      inspect(config, { depth: 10, showHidden: true }),
      JSON.stringify(provider),
      inspect(provider),
    ]) {
      expect(text).not.toContain(KEY);
    }
    expect(JSON.parse(JSON.stringify(provider))).toEqual({ id: "cheaper_inference", kind: "openai_compatible" });
  });
});

describe("Cheaper Inference route classification", () => {
  it("identifies the gateway truthfully as a trusted third party, never as official Anthropic", () => {
    const config = loadProviderConfig({
      ...ENV,
      DEJAML_ANTHROPIC_API_KEY: "sk-ant-test-FIXTURE-route-0001",
      DEJAML_OPENAI_API_KEY: "sk-test-FIXTURE-route-openai-0002",
      DEJAML_OPENAI_MODELS: "gpt-fixture-1",
      DEJAML_CUSTOM_BASE_URL: "https://llm.lab.example.test/v1",
      DEJAML_CUSTOM_MODELS: "lab-model",
    });
    const routes = Object.fromEntries(config.providers.map((p) => [p.id, providerRoute(p)]));
    expect(routes["cheaper_inference"]).toEqual({
      id: "cheaper_inference",
      kind: "openai_compatible",
      endpointHost: "api.cheaperinference.com",
      official: false,
      route: "trusted_gateway",
      https: true,
    });
    expect(routes["anthropic"]).toMatchObject({ endpointHost: "api.anthropic.com", official: true, route: "official", https: true });
    expect(routes["openai"]).toMatchObject({ endpointHost: "api.openai.com", official: true, route: "official", https: true });
    expect(routes["custom"]).toMatchObject({ endpointHost: "llm.lab.example.test", official: false, route: "custom", https: true });
    expect(JSON.stringify(routes)).not.toContain(KEY);

    // An overridden OpenAI base URL is a custom route, not official.
    const overridden = loadProviderConfig({
      DEJAML_OPENAI_API_KEY: "sk-test-FIXTURE-route-openai-0002",
      DEJAML_OPENAI_MODELS: "gpt-fixture-1",
      DEJAML_OPENAI_BASE_URL: "https://proxy.example.test/v1",
    }).providers.find((p) => p.id === "openai")!;
    expect(providerRoute(overridden)).toMatchObject({ endpointHost: "proxy.example.test", official: false, route: "custom" });
  });

  it("passes the native OpenClaw / localhost-bridge guard", () => {
    expect(nativeRuntimeUrlViolation(new URL(`${CHEAPER_INFERENCE_BASE_URL}/chat/completions`))).toBeUndefined();
  });
});

describe("Cheaper Inference over the guarded fetch", () => {
  it("sends exactly to https://api.cheaperinference.com/v1/chat/completions with the server key, and parses tool calls and usage", async () => {
    const gw = await gateway((res) => json(res, 200, COMPLETION));
    const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: gw.netGuard });
    const res = await provider.chat(request(MODEL));
    expect(gw.resolved).toEqual(["api.cheaperinference.com"]);
    expect(gw.addressed).toEqual([
      {
        protocol: "https:",
        hostname: "api.cheaperinference.com",
        port: 443,
        path: "/v1/chat/completions",
        servername: "api.cheaperinference.com",
      },
    ]);
    const hit = gw.server.hits[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.url).toBe("/v1/chat/completions");
    expect(hit.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(hit.headers["x-api-key"]).toBeUndefined();
    expect(JSON.parse(hit.body)).toMatchObject({ model: MODEL, max_completion_tokens: 64 });
    expect(res.provider).toBe("cheaper_inference");
    expect(`${res.provider}/${res.model}`).toBe("cheaper_inference/claude-sonnet-5.5");
    expect(res.toolCalls).toEqual([
      { id: "call_ci_1", name: "run_command", input: { command: "make test" }, rawInput: '{"command":"make test"}' },
    ]);
    expect(res.stopReason).toBe("tool_use");
    // prompt_tokens includes cached tokens; TokenUsage keeps the buckets disjoint.
    expect(res.usage).toEqual({ inputTokens: 200, outputTokens: 80, cacheReadTokens: 1000 });
    expect(res.attempts).toBe(1);
  });

  it("ignores every other endpoint setting: OpenAI and custom base URLs never redirect it", async () => {
    const gw = await gateway((res) => json(res, 200, COMPLETION));
    const config = loadProviderConfig({
      ...ENV,
      DEJAML_OPENAI_BASE_URL: "https://proxy.example.test/v1",
      DEJAML_CUSTOM_BASE_URL: "https://llm.lab.example.test/v9",
      DEJAML_CUSTOM_MODELS: MODEL,
    });
    await createChatProvider(config, "cheaper_inference", MODEL, { netGuard: gw.netGuard }).chat(request(MODEL));
    expect(gw.addressed.map((a) => `${a.protocol}//${a.hostname}:${a.port}${a.path}`)).toEqual([
      "https://api.cheaperinference.com:443/v1/chat/completions",
    ]);
  });

  it("refuses any model but claude-sonnet-5.5 without sending anything", async () => {
    const gw = await gateway((res) => json(res, 200, COMPLETION));
    const config = loadProviderConfig(ENV);
    expect(() => createChatProvider(config, "cheaper_inference", "claude-opus-5-5", { netGuard: gw.netGuard })).toThrow(
      ProviderSelectionError,
    );
    const provider = createChatProvider(config, "cheaper_inference", MODEL, { netGuard: gw.netGuard });
    const err = await catchError(provider.chat(request("claude-opus-5-5")));
    expect(err.code).toBe("model_not_allowed");
    expect(err.details.retryable).toBe(false);
    expect(gw.resolved).toEqual([]);
    expect(gw.server.hits).toHaveLength(0);
  });

  it("redacts the key when the gateway echoes it in an error, and does not retry 401", async () => {
    const gw = await gateway((res) =>
      json(res, 401, { error: { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error", code: "invalid_api_key" } }),
    );
    const { sleep, delays } = recordingSleep();
    const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: gw.netGuard, retry: { sleep } });
    const err = await catchError(provider.chat(request(MODEL)));
    expect(err.code).toBe("authentication");
    expect(err.details).toMatchObject({ status: 401, retryable: false, attempts: 1 });
    expect(err.message).toContain("Cheaper Inference HTTP 401");
    expect(err.message).toContain("[redacted]");
    for (const text of [err.message, String(err.stack), inspect(err), JSON.stringify(err)]) expect(text).not.toContain(KEY);
    expect(gw.server.hits).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("maps 402 to payment_required and never retries it", async () => {
    const gw = await gateway((res) => json(res, 402, { error: { message: "Insufficient credit", type: "payment_required" } }));
    const { sleep, delays } = recordingSleep();
    const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: gw.netGuard, retry: { sleep } });
    const err = await catchError(provider.chat(request(MODEL)));
    expect(err.code).toBe("payment_required");
    expect(err.details).toMatchObject({ status: 402, retryable: false, attempts: 1 });
    expect(gw.server.hits).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("retries 429 after Retry-After within the bounded policy", async () => {
    const gw = await gateway((res, _hit, index) =>
      index === 0
        ? json(res, 429, { error: { message: "slow down", type: "rate_limit_exceeded" } }, { "retry-after": "2" })
        : json(res, 200, COMPLETION),
    );
    const { sleep, delays } = recordingSleep();
    const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: gw.netGuard, retry: { sleep } });
    const res = await provider.chat(request(MODEL));
    expect(delays).toEqual([2000]);
    expect(res.attempts).toBe(2);
    expect(gw.server.hits).toHaveLength(2);
  });

  it("refuses a Retry-After above the cap instead of waiting", async () => {
    const gw = await gateway((res) => json(res, 429, { error: { message: "later" } }, { "retry-after": "3600" }));
    const { sleep, delays } = recordingSleep();
    const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: gw.netGuard, retry: { sleep } });
    const err = await catchError(provider.chat(request(MODEL)));
    expect(err.code).toBe("rate_limited");
    expect(err.details.retryable).toBe(false);
    expect(delays).toEqual([]);
    expect(gw.server.hits).toHaveLength(1);
  });

  it("retries 5xx a bounded number of times", async () => {
    const gw = await gateway((res) => json(res, 503, { error: { message: "upstream unavailable" } }));
    const { sleep, delays } = recordingSleep();
    const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, {
      netGuard: gw.netGuard,
      retry: { sleep, maxAttempts: 3, random: () => 0.5 },
    });
    const err = await catchError(provider.chat(request(MODEL)));
    expect(err.code).toBe("server_error");
    expect(err.details.attempts).toBe(3);
    expect(gw.server.hits).toHaveLength(3);
    expect(delays).toHaveLength(2);
  });

  it("rejects malformed tool calls as malformed_response without retrying", async () => {
    const broken = {
      ...COMPLETION,
      choices: [
        { index: 0, message: { role: "assistant", content: null, tool_calls: [{ type: "function", function: { arguments: "{}" } }] } },
      ],
    };
    for (const body of [broken, { ...COMPLETION, choices: [{ index: 0, message: { role: "assistant", tool_calls: "run_command" } }] }]) {
      const gw = await gateway((res) => json(res, 200, body));
      const { sleep, delays } = recordingSleep();
      const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: gw.netGuard, retry: { sleep } });
      const err = await catchError(provider.chat(request(MODEL)));
      expect(err.code).toBe("malformed_response");
      expect(err.message).toMatch(/^Cheaper Inference returned a malformed response/);
      expect(gw.server.hits).toHaveLength(1);
      expect(delays).toEqual([]);
      await close?.();
      close = null;
    }
  });

  it("streams text and tool-call deltas and reads usage from the final chunk", async () => {
    const chunk = (body: unknown) => `data: ${JSON.stringify({ id: "chatcmpl-ci-stream", model: MODEL, ...(body as object) })}\n\n`;
    const sse =
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: { content: "Running " }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: { content: "the tests." }, finish_reason: null }] }) +
      chunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_ci_s1", type: "function", function: { name: "run_command", arguments: "" } }] },
          },
        ],
      }) +
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] } }] }) +
      chunk({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_ci_s2", function: { name: "read_file", arguments: "" } }] } }],
      }) +
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"pytest"}' } }] } }] }) +
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":"README.md"}' } }] } }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      chunk({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 500 } } }) +
      "data: [DONE]\n\n";
    const gw = await gateway((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Split across writes so SSE lines straddle reads.
      for (let i = 0; i < sse.length; i += 29) res.write(sse.slice(i, i + 29));
      res.end();
    });
    const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: gw.netGuard });
    const deltas: string[] = [];
    const res = await provider.chat(request(MODEL, { stream: true, onText: (d) => deltas.push(d) }));
    expect(JSON.parse(gw.server.hits[0]!.body)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(gw.server.hits[0]!.headers["accept"]).toBe("text/event-stream");
    expect(deltas).toEqual(["Running ", "the tests."]);
    expect(res.text).toBe("Running the tests.");
    expect(res.toolCalls).toEqual([
      { id: "call_ci_s1", name: "run_command", input: { command: "pytest" }, rawInput: '{"command":"pytest"}' },
      { id: "call_ci_s2", name: "read_file", input: { path: "README.md" }, rawInput: '{"path":"README.md"}' },
    ]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 400, outputTokens: 40, cacheReadTokens: 500 });
  });

  it("rejects a streamed tool call without a name as malformed_response", async () => {
    const sse =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_x", function: { arguments: "{}" } }] } }] })}\n\n` +
      "data: [DONE]\n\n";
    const gw = await gateway((res) => res.writeHead(200, { "content-type": "text/event-stream" }).end(sse));
    const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: gw.netGuard });
    const err = await catchError(provider.chat(request(MODEL, { stream: true })));
    expect(err.code).toBe("malformed_response");
    expect(gw.server.hits).toHaveLength(1);
  });

  it("honours cancellation and never retries it", async () => {
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const gw = await gateway(() => arrived()); // never answers
    const { sleep, delays } = recordingSleep();
    const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: gw.netGuard, retry: { sleep } });
    const controller = new AbortController();
    const pending = catchError(provider.chat(request(MODEL, { signal: controller.signal })));
    await reached;
    controller.abort();
    const err = await pending;
    expect(err.code).toBe("cancelled");
    expect(err.details.retryable).toBe(false);
    expect(gw.server.hits).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("caps the response size (response_too_large), for JSON and for streams", async () => {
    const big = JSON.stringify({ ...COMPLETION, padding: "x".repeat(8192) });
    let gw = await gateway((res) => json(res, 200, big));
    let provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, {
      netGuard: gw.netGuard,
      maxResponseBytes: 4096,
    });
    let err = await catchError(provider.chat(request(MODEL)));
    expect(err.code).toBe("response_too_large");
    expect(err.details.retryable).toBe(false);
    expect(gw.server.hits).toHaveLength(1);
    await close?.();
    close = null;

    gw = await gateway((res) => res.writeHead(200, { "content-type": "text/event-stream" }).end(`: ${"x".repeat(8192)}\n\n`));
    provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: gw.netGuard, maxResponseBytes: 4096 });
    err = await catchError(provider.chat(request(MODEL, { stream: true })));
    expect(err.code).toBe("response_too_large");
  });

  it("refuses the gateway resolving to a private address under the production policy", async () => {
    let connected = 0;
    const transport: EndpointTransport = () => {
      connected += 1;
      throw new Error("must not connect");
    };
    const resolver: Resolver = async () => [{ address: "10.0.0.8", family: 4 }];
    const provider = createChatProvider(loadProviderConfig(ENV), "cheaper_inference", MODEL, { netGuard: { resolver, transport } });
    const err = await catchError(provider.chat(request(MODEL)));
    expect(err.code).toBe("blocked_endpoint");
    expect(connected).toBe(0);
  });
});
