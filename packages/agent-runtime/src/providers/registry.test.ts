import { describe, expect, it } from "vitest";
import {
  ProviderConfigError,
  ProviderSelectionError,
  createChatProvider,
  loadProviderConfig,
  publicProviders,
} from "./registry.js";
import { fakeFetch, fixture, jsonResponse } from "./test-helpers.js";

const OPENAI_KEY = "sk-test-FIXTURE-openai-key-000";
const ANTHROPIC_KEY = "sk-ant-test-FIXTURE-key-111";
const CUSTOM_KEY = "custom-FIXTURE-key-222";
const UPLOADER_KEY = "sk-ant-test-FIXTURE-uploader-333";

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadProviderConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderConfigError);
    return (err as ProviderConfigError).problems;
  }
  throw new Error("expected ProviderConfigError");
}

describe("loadProviderConfig", () => {
  it("defaults to Anthropic with uploader keys when nothing is configured", () => {
    const config = loadProviderConfig({});
    expect(publicProviders(config)).toEqual([
      { id: "anthropic", label: "Anthropic", models: ["claude-opus-5-5", "claude-sonnet-5-5"], keySource: "uploader" },
    ]);
    expect(config.providers.find((p) => p.id === "openai")?.available).toBe(false);
  });

  it("disables uploader keys when DEJAML_ALLOW_UPLOADER_KEYS=0", () => {
    expect(publicProviders(loadProviderConfig({ DEJAML_ALLOW_UPLOADER_KEYS: "0" }))).toEqual([]);
  });

  it("configures all three providers with server keys", () => {
    const config = loadProviderConfig({
      DEJAML_OPENAI_API_KEY: OPENAI_KEY,
      DEJAML_OPENAI_MODELS: "gpt-fixture-1, gpt-fixture-2",
      DEJAML_ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      DEJAML_ANTHROPIC_MODELS: "claude-sonnet-5-5",
      DEJAML_CUSTOM_BASE_URL: "https://llm.internal.example.test/v1/",
      DEJAML_CUSTOM_MODELS: "org/model-7b:q4",
      DEJAML_CUSTOM_API_KEY: CUSTOM_KEY,
      DEJAML_CUSTOM_LABEL: "Lab GPU cluster",
      DEJAML_MODEL_PRICES: '{"gpt-fixture-1":{"inputPerMTok":1,"outputPerMTok":2}}',
    });
    const pub = publicProviders(config);
    expect(pub).toEqual([
      { id: "openai", label: "OpenAI", models: ["gpt-fixture-1", "gpt-fixture-2"], keySource: "server" },
      { id: "anthropic", label: "Anthropic", models: ["claude-sonnet-5-5"], keySource: "server" },
      { id: "custom", label: "Lab GPU cluster", models: ["org/model-7b:q4"], keySource: "server" },
    ]);
    const serialized = JSON.stringify(pub);
    for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, CUSTOM_KEY, "llm.internal.example.test", "https://"]) {
      expect(serialized).not.toContain(secret);
    }
    // Keys are not stored on the config objects either.
    const all = JSON.stringify(config);
    for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, CUSTOM_KEY]) expect(all).not.toContain(secret);
    expect(config.prices["gpt-fixture-1"]).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
    expect(config.prices["claude-opus-5-5"]).toBeUndefined();
  });

  it("lists every problem at once without echoing keys or URLs", () => {
    const problems = problemsOf({
      DEJAML_ALLOW_UPLOADER_KEYS: "yes",
      DEJAML_OPENAI_API_KEY: "short",
      DEJAML_OPENAI_BASE_URL: "http://api.openai.example.test/v1",
      DEJAML_ANTHROPIC_MODELS: "claude-opus-5-5,bad model!",
      DEJAML_CUSTOM_BASE_URL: "https://user:pw@llm.example.test/v1?x=1#frag",
      DEJAML_MODEL_PRICES: "{",
    });
    expect(problems).toEqual([
      'DEJAML_ALLOW_UPLOADER_KEYS must be "1" or "0"',
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

  it("allows local plain http for custom only with DEJAML_CUSTOM_ALLOW_LOCAL_HTTP=1", () => {
    for (const url of ["http://127.0.0.1:8000/v1", "http://localhost:11434/v1", "http://[::1]:8080/v1"]) {
      expect(problemsOf({ DEJAML_CUSTOM_BASE_URL: url, DEJAML_CUSTOM_MODELS: "m1" })).toEqual(["DEJAML_CUSTOM_BASE_URL must use https"]);
      const config = loadProviderConfig({ DEJAML_CUSTOM_BASE_URL: url, DEJAML_CUSTOM_MODELS: "m1", DEJAML_CUSTOM_ALLOW_LOCAL_HTTP: "1" });
      expect(config.providers.find((p) => p.id === "custom")?.available).toBe(true);
    }
    expect(
      problemsOf({ DEJAML_CUSTOM_BASE_URL: "http://10.0.0.5/v1", DEJAML_CUSTOM_MODELS: "m1", DEJAML_CUSTOM_ALLOW_LOCAL_HTTP: "1" }),
    ).toEqual(["DEJAML_CUSTOM_BASE_URL must use https (plain http is only allowed for 127.0.0.1, localhost or [::1])"]);
  });

  it("requires a model list when an OpenAI key is set", () => {
    expect(problemsOf({ DEJAML_OPENAI_API_KEY: OPENAI_KEY })).toEqual([
      "DEJAML_OPENAI_MODELS is required when DEJAML_OPENAI_API_KEY is set",
    ]);
  });
});

describe("createChatProvider", () => {
  const env = {
    DEJAML_OPENAI_MODELS: "gpt-fixture-1",
    DEJAML_ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    DEJAML_CUSTOM_BASE_URL: "https://llm.internal.example.test/v1",
    DEJAML_CUSTOM_MODELS: "local-model",
  };

  it("uses the server key and the model allowlist", async () => {
    const config = loadProviderConfig(env);
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("anthropic/message-text.json"))]);
    const provider = createChatProvider(config, "anthropic", "claude-opus-5-5", { fetchImpl });
    expect(provider.kind).toBe("anthropic");
    const res = await provider.chat({ model: "claude-opus-5-5", system: "", messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 10 });
    expect(calls[0]?.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(res.costUsd).toBeNull(); // no price configured for this model
    expect(() => createChatProvider(config, "anthropic", "claude-haiku-4-5")).toThrow(ProviderSelectionError);
    expect(() => createChatProvider(config, "gemini", "x")).toThrow(ProviderSelectionError);
  });

  it("uses an uploader key only where allowed and validates it", async () => {
    const config = loadProviderConfig(env);
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("openai/chat-text.json"))]);
    const provider = createChatProvider(config, "openai", "gpt-fixture-1", { uploaderKey: UPLOADER_KEY, fetchImpl });
    await provider.chat({ model: "gpt-fixture-1", system: "", messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 10 });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${UPLOADER_KEY}`);

    expect(() => createChatProvider(config, "openai", "gpt-fixture-1")).toThrow(/uploader key is required/);
    for (const bad of ["short", "has space in-it-000", "tab\tkey-000000", "x".repeat(513)]) {
      let message = "";
      try {
        createChatProvider(config, "openai", "gpt-fixture-1", { uploaderKey: bad });
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderSelectionError);
        message = (err as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(bad);
    }
    expect(() => createChatProvider(config, "custom", "local-model", { uploaderKey: UPLOADER_KEY })).toThrow(/does not accept uploader/);

    const noUploads = loadProviderConfig({ ...env, DEJAML_ALLOW_UPLOADER_KEYS: "0" });
    expect(() => createChatProvider(noUploads, "anthropic", "claude-opus-5-5", { uploaderKey: UPLOADER_KEY })).toThrow(ProviderSelectionError);
  });

  it("builds the custom OpenAI-compatible adapter against the administrator endpoint", async () => {
    const config = loadProviderConfig(env);
    const { fetchImpl, calls } = fakeFetch([() => jsonResponse(fixture("openai/chat-text.json"))]);
    const provider = createChatProvider(config, "custom", "local-model", { fetchImpl });
    expect(provider.kind).toBe("openai_compatible");
    expect(provider.id).toBe("custom");
    await provider.chat({ model: "local-model", system: "", messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 10 });
    expect(calls[0]?.url).toBe("https://llm.internal.example.test/v1/chat/completions");
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
  });
});
