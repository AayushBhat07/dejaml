import http from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";

import type { EndpointTransport, Resolver } from "@dejaml/net-guard";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderConfigError,
  ProviderSelectionError,
  createChatProvider,
  loadProviderConfig,
  publicProviders,
} from "./registry.js";
import { fakeFetch, fixture, jsonResponse, recordingSleep, startLocalServer } from "./test-helpers.js";
import { ProviderError, type ChatRequest } from "./types.js";

const OPENAI_KEY = "sk-test-FIXTURE-openai-key-000";
const ANTHROPIC_KEY = "sk-ant-test-FIXTURE-key-111";
const CUSTOM_KEY = "custom-FIXTURE-key-222";

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadProviderConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderConfigError);
    return (err as ProviderConfigError).problems;
  }
  throw new Error("expected ProviderConfigError");
}

function request(model: string, over: Partial<ChatRequest> = {}): ChatRequest {
  return { model, system: "", messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 10, ...over };
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

describe("loadProviderConfig (server-only keys)", () => {
  it("offers nothing when no server key is configured", () => {
    const config = loadProviderConfig({});
    expect(publicProviders(config)).toEqual([]);
    expect(config.providers.find((p) => p.id === "openai")?.available).toBe(false);
    expect(config.providers.find((p) => p.id === "anthropic")?.available).toBe(false);
    // A model list alone is not enough: without a server key the provider is not offered.
    expect(publicProviders(loadProviderConfig({ DEJAML_OPENAI_MODELS: "gpt-fixture-1" }))).toEqual([]);
  });

  it("offers Anthropic with its default models once its server key is set", () => {
    expect(publicProviders(loadProviderConfig({ DEJAML_ANTHROPIC_API_KEY: ANTHROPIC_KEY }))).toEqual([
      { id: "anthropic", label: "Anthropic", models: ["claude-opus-5-5", "claude-sonnet-5-5"] },
    ]);
  });

  it("configures all three providers and exposes only ids, labels and models", () => {
    const config = loadProviderConfig({
      DEJAML_OPENAI_API_KEY: OPENAI_KEY,
      DEJAML_OPENAI_MODELS: "gpt-fixture-1, gpt-fixture-2",
      DEJAML_ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      DEJAML_ANTHROPIC_MODELS: "claude-sonnet-5-5",
      DEJAML_CUSTOM_BASE_URL: "https://llm.lab.example.test/v1/",
      DEJAML_CUSTOM_MODELS: "org/model-7b:q4",
      DEJAML_CUSTOM_API_KEY: CUSTOM_KEY,
      DEJAML_CUSTOM_LABEL: "Lab GPU cluster",
      DEJAML_MODEL_PRICES: '{"gpt-fixture-1":{"inputPerMTok":1,"outputPerMTok":2}}',
    });
    const pub = publicProviders(config);
    expect(pub).toEqual([
      { id: "openai", label: "OpenAI", models: ["gpt-fixture-1", "gpt-fixture-2"] },
      { id: "anthropic", label: "Anthropic", models: ["claude-sonnet-5-5"] },
      { id: "custom", label: "Lab GPU cluster", models: ["org/model-7b:q4"] },
    ]);
    const serialized = JSON.stringify(pub);
    for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, CUSTOM_KEY, "llm.lab.example.test", "https://", "keySource", "uploader"]) {
      expect(serialized).not.toContain(secret);
    }
    // Keys are not stored on the config objects either, however they are printed.
    for (const text of [JSON.stringify(config), inspect(config, { depth: 10, showHidden: true }), String(config)]) {
      for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, CUSTOM_KEY]) expect(text).not.toContain(secret);
    }
    // Nor on the providers built from it.
    for (const [id, model] of [
      ["openai", "gpt-fixture-1"],
      ["anthropic", "claude-sonnet-5-5"],
      ["custom", "org/model-7b:q4"],
    ] as const) {
      const provider = createChatProvider(config, id, model);
      for (const text of [JSON.stringify(provider), inspect(provider, { depth: 10, showHidden: true }), `${String(provider)}`]) {
        for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, CUSTOM_KEY]) expect(text).not.toContain(secret);
      }
    }
    expect(config.prices["gpt-fixture-1"]).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
    expect(config.prices["claude-opus-5-5"]).toBeUndefined();
  });

  it("refuses the removed uploader-key switch and legacy single-model settings", () => {
    for (const value of ["1", "true", "yes"]) {
      expect(problemsOf({ DEJAML_ALLOW_UPLOADER_KEYS: value })).toEqual([
        "DEJAML_ALLOW_UPLOADER_KEYS is no longer supported: provider keys come only from DEJAML_OPENAI_API_KEY, DEJAML_ANTHROPIC_API_KEY and DEJAML_CUSTOM_API_KEY",
      ]);
    }
    // "0" already meant "no uploader keys", so an existing deployment keeps starting.
    expect(publicProviders(loadProviderConfig({ DEJAML_ALLOW_UPLOADER_KEYS: "0" }))).toEqual([]);
    const legacy = problemsOf({ DEJAML_MODEL: "llama", DEJAML_MODEL_BASE_URL: "http://169.254.169.254/v1", DEJAML_MODEL_API_KEY: "sk-legacy-FIXTURE-0000" });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatch(/^DEJAML_MODEL, DEJAML_MODEL_BASE_URL, DEJAML_MODEL_API_KEY are no longer supported/);
    expect(legacy.join("\n")).not.toContain("sk-legacy");
    expect(legacy.join("\n")).not.toContain("169.254");
  });

  it("lists every problem at once without echoing keys or URLs", () => {
    const problems = problemsOf({
      DEJAML_OPENAI_API_KEY: "short",
      DEJAML_OPENAI_BASE_URL: "http://api.openai.example.test/v1",
      DEJAML_ANTHROPIC_MODELS: "claude-opus-5-5,bad model!",
      DEJAML_CUSTOM_BASE_URL: "https://user:pw@llm.example.test/v1?x=1#frag",
      DEJAML_MODEL_PRICES: "{",
    });
    expect(problems).toEqual([
      "DEJAML_OPENAI_API_KEY is not a valid API key (8-512 characters, no whitespace or control characters)",
      "DEJAML_OPENAI_BASE_URL must use https",
      'DEJAML_ANTHROPIC_MODELS contains an invalid model name "bad model!"',
      "DEJAML_CUSTOM_MODELS is required when DEJAML_CUSTOM_BASE_URL is set",
      "DEJAML_CUSTOM_BASE_URL must not contain credentials, must not contain a query string, must not contain a fragment",
      "Invalid DEJAML_MODEL_PRICES: not valid JSON",
    ]);
    expect(problems.join("\n")).not.toContain("pw@");
  });

  it("requires custom base URL and models together, and a base URL for key/label", () => {
    expect(problemsOf({ DEJAML_CUSTOM_MODELS: "m1" })).toEqual(["DEJAML_CUSTOM_BASE_URL is required when DEJAML_CUSTOM_MODELS is set"]);
    expect(problemsOf({ DEJAML_CUSTOM_API_KEY: CUSTOM_KEY })).toEqual(["DEJAML_CUSTOM_API_KEY is set but DEJAML_CUSTOM_BASE_URL is not"]);
  });

  it("requires a model list when an OpenAI key is set", () => {
    expect(problemsOf({ DEJAML_OPENAI_API_KEY: OPENAI_KEY })).toEqual(["DEJAML_OPENAI_MODELS is required when DEJAML_OPENAI_API_KEY is set"]);
  });
});

describe("custom endpoint address policy", () => {
  const custom = (url: string, extra: Record<string, string> = {}) => ({ DEJAML_CUSTOM_BASE_URL: url, DEJAML_CUSTOM_MODELS: "m1", ...extra });
  const PRIVATE_HINT = " (for a development server set DEJAML_CUSTOM_ALLOW_PRIVATE=1; never in production)";

  it.each([
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://10.0.0.5/v1",
    "https://172.16.0.1/v1",
    "https://192.168.1.1/v1",
    "https://100.64.0.1/v1",
    "https://169.254.169.254/v1",
    "https://[fd00:ec2::254]/v1",
    "https://[fc00::1]/v1",
    "https://[fd12:3456::1]/v1",
    "https://[fe80::1]/v1",
    "https://224.0.0.1/v1",
    "https://[ff02::1]/v1",
    "https://0.0.0.0/v1",
    "https://[::]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[::ffff:10.0.0.5]/v1",
    "https://[::ffff:169.254.169.254]/v1",
  ])("refuses the non-public address %s by default", (url) => {
    expect(problemsOf(custom(url))).toEqual([
      `DEJAML_CUSTOM_BASE_URL points at a loopback, private, link-local, metadata or otherwise non-public address${PRIVATE_HINT}`,
    ]);
  });

  it.each(["https://localhost/v1", "https://app.localhost/v1", "https://gpu.internal/v1", "https://box.local/v1", "https://ollama/v1", "https://metadata.google.internal/v1"])(
    "refuses the internal name %s by default",
    (url) => {
      expect(problemsOf(custom(url))).toEqual([`DEJAML_CUSTOM_BASE_URL uses a local, internal or single-label hostname${PRIVATE_HINT}`]);
    },
  );

  it("refuses non-canonical IPv4 forms", () => {
    for (const url of ["https://0x7f.1/v1", "https://2130706433/v1", "https://0177.0.0.1/v1"]) {
      expect(problemsOf(custom(url))).toEqual(["DEJAML_CUSTOM_BASE_URL uses a non-canonical IP address"]);
    }
  });

  it("allows private networks only with DEJAML_CUSTOM_ALLOW_PRIVATE=1 outside production, and never metadata", () => {
    for (const url of ["https://10.0.0.5/v1", "https://gpu.internal:8443/v1", "https://ollama/v1", "https://[fd12::1]/v1", "https://100.64.0.1/v1"]) {
      const config = loadProviderConfig(custom(url, { DEJAML_CUSTOM_ALLOW_PRIVATE: "1", NODE_ENV: "development" }));
      expect(config.providers.find((p) => p.id === "custom")?.endpointAccess).toBe("private");
    }
    for (const url of ["https://169.254.169.254/v1", "https://[fd00:ec2::254]/v1", "https://[::ffff:169.254.169.254]/v1"]) {
      expect(problemsOf(custom(url, { DEJAML_CUSTOM_ALLOW_PRIVATE: "1" }))).toEqual([
        "DEJAML_CUSTOM_BASE_URL points at a loopback, private, link-local, metadata or otherwise non-public address",
      ]);
    }
    expect(problemsOf(custom("https://metadata.google.internal/v1", { DEJAML_CUSTOM_ALLOW_PRIVATE: "1" }))).toEqual([
      "DEJAML_CUSTOM_BASE_URL uses a local, internal or single-label hostname",
    ]);
  });

  it("allows local plain http only with DEJAML_CUSTOM_ALLOW_LOCAL_HTTP=1 outside production", () => {
    for (const url of ["http://127.0.0.1:8000/v1", "http://localhost:11434/v1", "http://[::1]:8080/v1"]) {
      expect(problemsOf(custom(url))).toEqual(["DEJAML_CUSTOM_BASE_URL must use https"]);
      const config = loadProviderConfig(custom(url, { DEJAML_CUSTOM_ALLOW_LOCAL_HTTP: "1" }));
      expect(config.providers.find((p) => p.id === "custom")?.available).toBe(true);
    }
    expect(problemsOf(custom("http://10.0.0.5/v1", { DEJAML_CUSTOM_ALLOW_LOCAL_HTTP: "1" }))).toEqual([
      "DEJAML_CUSTOM_BASE_URL must use https (plain http is only allowed for 127.0.0.1, localhost or [::1])",
    ]);
  });

  it("refuses both development flags when NODE_ENV=production", () => {
    expect(problemsOf(custom("http://127.0.0.1:8000/v1", { DEJAML_CUSTOM_ALLOW_LOCAL_HTTP: "1", NODE_ENV: "production" }))).toEqual([
      "DEJAML_CUSTOM_ALLOW_LOCAL_HTTP is a development-only setting and is not allowed when NODE_ENV=production",
      "DEJAML_CUSTOM_BASE_URL must use https",
    ]);
    expect(problemsOf(custom("https://10.0.0.5/v1", { DEJAML_CUSTOM_ALLOW_PRIVATE: "1", NODE_ENV: "production" }))).toEqual([
      "DEJAML_CUSTOM_ALLOW_PRIVATE is a development-only setting and is not allowed when NODE_ENV=production",
      `DEJAML_CUSTOM_BASE_URL points at a loopback, private, link-local, metadata or otherwise non-public address${PRIVATE_HINT}`,
    ]);
  });

  it("applies the public policy to an overridden OpenAI base URL too", () => {
    expect(problemsOf({ DEJAML_OPENAI_BASE_URL: "https://169.254.169.254/v1" })).toEqual([
      "DEJAML_OPENAI_BASE_URL points at a loopback, private, link-local, metadata or otherwise non-public address",
    ]);
    expect(problemsOf({ DEJAML_OPENAI_BASE_URL: "https://proxy.internal/v1", DEJAML_CUSTOM_ALLOW_PRIVATE: "1" })).toEqual([
      "DEJAML_OPENAI_BASE_URL uses a local, internal or single-label hostname",
    ]);
  });
});

describe("createChatProvider", () => {
  const env = {
    DEJAML_OPENAI_API_KEY: OPENAI_KEY,
    DEJAML_OPENAI_MODELS: "gpt-fixture-1",
    DEJAML_ANTHROPIC_API_KEY: ANTHROPIC_KEY,
  };

  it("uses the server key and enforces the model allowlist at selection and on every call", async () => {
    const config = loadProviderConfig(env);
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("anthropic/message-text.json"))]);
    const provider = createChatProvider(config, "anthropic", "claude-opus-5-5", { fetchImpl });
    expect(provider.kind).toBe("anthropic");
    const res = await provider.chat(request("claude-opus-5-5"));
    expect(calls[0]?.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(res.costUsd).toBeNull(); // no price configured for this model
    // A later request for an unlisted model fails before any network call.
    const err = await catchError(provider.chat(request("claude-haiku-4-5")));
    expect(err.code).toBe("model_not_allowed");
    expect(calls).toHaveLength(1);
    expect(() => createChatProvider(config, "anthropic", "claude-haiku-4-5")).toThrow(ProviderSelectionError);
    expect(() => createChatProvider(config, "gemini", "x")).toThrow(ProviderSelectionError);
  });

  it("builds OpenAI with its server key against the documented endpoint", async () => {
    const config = loadProviderConfig(env);
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("openai/chat-text.json"))]);
    await createChatProvider(config, "openai", "gpt-fixture-1", { fetchImpl }).chat(request("gpt-fixture-1"));
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${OPENAI_KEY}`);
  });

  it("never accepts a caller-supplied key, and refuses a provider without a server key", () => {
    const config = loadProviderConfig({ DEJAML_OPENAI_MODELS: "gpt-fixture-1" });
    expect(() => createChatProvider(config, "openai", "gpt-fixture-1")).toThrow(/not configured/);
    const full = loadProviderConfig(env);
    for (const extra of [{ uploaderKey: "sk-FIXTURE-uploader-0000" }, { apiKey: "sk-FIXTURE-uploader-0000" }]) {
      let message = "";
      try {
        createChatProvider(full, "openai", "gpt-fixture-1", extra as never);
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderSelectionError);
        message = (err as Error).message;
      }
      expect(message).toBe("Provider keys come only from the server environment");
    }
  });
});

describe("custom endpoint requests go through the guarded fetch", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it("reaches a loopback development endpoint with the server key (http, ALLOW_LOCAL_HTTP)", async () => {
    const server = await startLocalServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(fixture("openai/chat-text.json"));
    });
    close = server.close;
    const config = loadProviderConfig({
      DEJAML_CUSTOM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      DEJAML_CUSTOM_MODELS: "gpt-fixture-1",
      DEJAML_CUSTOM_API_KEY: CUSTOM_KEY,
      DEJAML_CUSTOM_ALLOW_LOCAL_HTTP: "1",
    });
    const provider = createChatProvider(config, "custom", "gpt-fixture-1");
    expect(provider.kind).toBe("openai_compatible");
    const res = await provider.chat(request("gpt-fixture-1"));
    expect(res.text).toContain("The claim reproduces");
    expect(server.hits).toHaveLength(1);
    expect(server.hits[0]).toMatchObject({ method: "POST", url: "/v1/chat/completions" });
    expect(server.hits[0]?.headers["authorization"]).toBe(`Bearer ${CUSTOM_KEY}`);
    expect(JSON.parse(server.hits[0]?.body ?? "{}")).toMatchObject({ model: "gpt-fixture-1" });
  });

  it("streams SSE through the guard and caps the stream size", async () => {
    let body = fixture("openai/stream-text-and-tools.sse");
    const server = await startLocalServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }).end(body);
    });
    close = server.close;
    const config = loadProviderConfig({
      DEJAML_CUSTOM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      DEJAML_CUSTOM_MODELS: "gpt-fixture-1",
      DEJAML_CUSTOM_ALLOW_LOCAL_HTTP: "1",
    });
    const deltas: string[] = [];
    const res = await createChatProvider(config, "custom", "gpt-fixture-1").chat(
      request("gpt-fixture-1", { stream: true, onText: (d) => deltas.push(d) }),
    );
    expect(deltas.join("")).toBe(res.text);
    expect(res.toolCalls.length).toBe(2);
    expect(server.hits[0]?.headers["authorization"]).toBeUndefined();

    body = `: ${"x".repeat(8192)}\n\n`;
    const err = await catchError(
      createChatProvider(config, "custom", "gpt-fixture-1", { maxResponseBytes: 4096 }).chat(request("gpt-fixture-1", { stream: true })),
    );
    expect(err.code).toBe("response_too_large");
  });

  it("refuses redirects and does not retry them", async () => {
    const server = await startLocalServer((_req, res) => {
      res.writeHead(307, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    });
    close = server.close;
    const config = loadProviderConfig({
      DEJAML_CUSTOM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      DEJAML_CUSTOM_MODELS: "gpt-fixture-1",
      DEJAML_CUSTOM_ALLOW_LOCAL_HTTP: "1",
    });
    const err = await catchError(createChatProvider(config, "custom", "gpt-fixture-1").chat(request("gpt-fixture-1")));
    expect(err.code).toBe("blocked_endpoint");
    expect(err.message).toMatch(/redirect/);
    expect(server.hits).toHaveLength(1);
  });

  it("refuses a public-looking hostname that resolves to a private address, before connecting", async () => {
    const config = loadProviderConfig({ DEJAML_CUSTOM_BASE_URL: "https://llm.example.test/v1", DEJAML_CUSTOM_MODELS: "m1" });
    for (const answer of [
      { address: "10.0.0.8", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
      { address: "169.254.169.254", family: 4 as const },
      { address: "::ffff:127.0.0.1", family: 6 as const },
      { address: "fd00:ec2::254", family: 6 as const },
      { address: "::1", family: 6 as const },
    ]) {
      let transportCalls = 0;
      const transport: EndpointTransport = () => {
        transportCalls += 1;
        throw new Error("must not connect");
      };
      const resolver: Resolver = async () => [answer];
      const err = await catchError(createChatProvider(config, "custom", "m1", { netGuard: { resolver, transport } }).chat(request("m1")));
      expect([answer.address, err.code, err.details.retryable, err.details.attempts]).toEqual([answer.address, "blocked_endpoint", false, 1]);
      expect(transportCalls).toBe(0);
    }
  });

  it("re-resolves on every attempt and pins each connection (DNS rebinding across a retry is refused)", async () => {
    // A listener that resets every connection stands in for a failing public host.
    const reset = http.createServer();
    reset.on("connection", (socket) => socket.destroy());
    await new Promise<void>((resolve) => reset.listen(0, "127.0.0.1", resolve));
    const resetPort = (reset.address() as AddressInfo).port;
    close = () => new Promise<void>((resolve) => reset.close(() => resolve()));

    let resolutions = 0;
    const rebinding: Resolver = async () => {
      resolutions += 1;
      return resolutions === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.8", family: 4 }];
    };
    const pinnedAnswers: string[] = [];
    const transport: EndpointTransport = (options, callback) => {
      // Record what the socket would resolve to, then send it to the resetting listener instead.
      options.lookup?.(String(options.hostname), {}, (_err, address) => pinnedAnswers.push(String(address)));
      const { lookup: _lookup, servername: _servername, ...rest } = options;
      return http.request({ ...rest, protocol: "http:", hostname: "127.0.0.1", port: resetPort, family: 4 }, callback);
    };
    const config = loadProviderConfig({ DEJAML_CUSTOM_BASE_URL: "https://llm.example.test/v1", DEJAML_CUSTOM_MODELS: "m1" });
    const { sleep, delays } = recordingSleep();
    const provider = createChatProvider(config, "custom", "m1", { netGuard: { resolver: rebinding, transport }, retry: { sleep } });
    const err = await catchError(provider.chat(request("m1")));
    expect(resolutions).toBe(2);
    expect(delays).toHaveLength(1); // the reset was retried once...
    expect(pinnedAnswers).toEqual(["93.184.216.34"]); // ...the first socket was pinned to the validated answer...
    expect(err.code).toBe("blocked_endpoint"); // ...and the rebound private answer was refused.
    expect(err.details.attempts).toBe(2);
  });
});
