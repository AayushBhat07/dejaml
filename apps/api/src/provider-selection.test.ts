import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProviderConfig, ProviderSelectionError } from "@dejaml/agent-runtime";
import { LabManager } from "@dejaml/lab-manager";
import { RunStore } from "@dejaml/run-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer, type ApiServer } from "./server.js";
import { paperPdf, ScriptedModel, ScriptedRuntime, STAND_IN_IMAGE_ID } from "./stand-ins.js";

/*
 * Provider selection under server-only keys: the browser picks a configured
 * provider id and one of its models, and nothing else. Keys and endpoints are
 * server configuration; an upload carrying either is refused before a run is
 * created. The provider factory records what it was asked for and then
 * refuses, so no study (and no model call) ever starts in these tests.
 */

const SERVER_OPENAI_KEY = "sk-test-FIXTURE-server-openai-0001";
const SERVER_ANTHROPIC_KEY = "sk-ant-test-FIXTURE-server-0002";
const SENT_KEY = "sk-test-FIXTURE-browser-key-9999";

let work: string;
let store: RunStore;
let api: ApiServer | null = null;
let base: string;
let selections: unknown[][];

async function start(env: Record<string, string>): Promise<void> {
  store = new RunStore();
  const labs = new LabManager({ runtime: new ScriptedRuntime(), labRoot: join(work, "labs"), events: (event) => store.appendEvent(event) });
  selections = [];
  api = createApiServer({
    store,
    labs,
    providers: loadProviderConfig(env),
    providerFactory: (...args: unknown[]) => {
      selections.push(args);
      throw new ProviderSelectionError("stand-in factory: no study is started in this test");
    },
    structuredModel: () => new ScriptedModel(undefined as never, 60, 0),
    cases: [],
    projectRoot: work,
    workRoot: join(work, "data"),
    image: { name: "dejaml/python-cpu:0.1.0", expectedImageId: STAND_IN_IMAGE_ID },
  });
  await new Promise<void>((resolve) => api!.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
}

async function upload(fields: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; error: string }> {
  const form = new FormData();
  form.append("paper", new Blob([new Uint8Array(await paperPdf())]), "paper.pdf");
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await fetch(`${base}/api/runs`, { method: "POST", body: form, headers });
  const body = (await response.json()) as { error?: string };
  return { status: response.status, error: body.error ?? "" };
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "dejaml-provider-selection-"));
});

afterEach(async () => {
  if (api) await api.close();
  api = null;
  await rm(work, { recursive: true, force: true });
});

describe("GET /api/config", () => {
  it("lists only providers with a server key, as ids, labels and models", async () => {
    await start({
      DEJAML_OPENAI_API_KEY: SERVER_OPENAI_KEY,
      DEJAML_OPENAI_MODELS: "gpt-fixture-1,gpt-fixture-2",
      // Anthropic has models but no key: it must not be offered.
      DEJAML_ANTHROPIC_MODELS: "claude-opus-5-5",
      DEJAML_CUSTOM_BASE_URL: "https://llm.lab.example.test/v1",
      DEJAML_CUSTOM_MODELS: "lab-model",
      DEJAML_CUSTOM_API_KEY: "custom-FIXTURE-key-3333",
    });
    const response = await fetch(`${base}/api/config`);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      providers: [
        { id: "openai", label: "OpenAI", models: ["gpt-fixture-1", "gpt-fixture-2"] },
        { id: "custom", label: "Custom endpoint", models: ["lab-model"] },
      ],
      reviewedCases: [],
    });
    for (const secret of [SERVER_OPENAI_KEY, "custom-FIXTURE-key-3333", "llm.lab.example.test", "keySource", "baseUrl", "apiKey"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("is empty when no provider key is configured", async () => {
    await start({ DEJAML_ANTHROPIC_MODELS: "claude-opus-5-5", DEJAML_OPENAI_MODELS: "gpt-fixture-1" });
    expect(await (await fetch(`${base}/api/config`)).json()).toEqual({ providers: [], reviewedCases: [] });
    const refused = await upload({ providerId: "anthropic", modelName: "claude-opus-5-5" });
    expect(refused.status).toBe(400);
    expect(refused.error).toBe("Choose one of the configured model providers.");
    expect(selections).toEqual([]);
  });
});

describe("POST /api/runs provider selection", () => {
  const env = {
    DEJAML_OPENAI_API_KEY: SERVER_OPENAI_KEY,
    DEJAML_OPENAI_MODELS: "gpt-fixture-1",
    DEJAML_ANTHROPIC_API_KEY: SERVER_ANTHROPIC_KEY,
  };

  it("passes only the provider id and model name to the provider factory", async () => {
    await start(env);
    const result = await upload({ providerId: "anthropic", modelName: "claude-sonnet-5-5" });
    expect(result.status).toBe(400); // the stand-in factory refuses after recording
    expect(selections).toEqual([["anthropic", "claude-sonnet-5-5"]]);
  });

  it.each([
    ["apiKey", "API keys are configured on the server; do not send one with a study."],
    ["api_key", "API keys are configured on the server; do not send one with a study."],
    ["openaiApiKey", "API keys are configured on the server; do not send one with a study."],
    ["token", "API keys are configured on the server; do not send one with a study."],
    ["authorization", "API keys are configured on the server; do not send one with a study."],
    ["modelBaseUrl", "Model endpoints are configured by the server administrator; choose one of the listed providers."],
    ["baseUrl", "Model endpoints are configured by the server administrator; choose one of the listed providers."],
    ["base_url", "Model endpoints are configured by the server administrator; choose one of the listed providers."],
    ["endpoint", "Model endpoints are configured by the server administrator; choose one of the listed providers."],
    ["headers", 'The upload has an unexpected field "headers".'],
    ["x-custom-header", 'The upload has an unexpected field "x-custom-header".'],
  ])("refuses an upload carrying %s with 400 and never echoes the value", async (field, message) => {
    await start(env);
    const result = await upload({ providerId: "openai", modelName: "gpt-fixture-1", [field]: SENT_KEY });
    expect(result).toEqual({ status: 400, error: message });
    expect(selections).toEqual([]);
  });

  it("refuses an empty key field too: its presence is the problem", async () => {
    await start(env);
    expect((await upload({ providerId: "openai", apiKey: "" })).status).toBe(400);
    expect(selections).toEqual([]);
  });

  it("refuses provider-key request headers", async () => {
    await start(env);
    for (const header of ["x-api-key", "api-key", "anthropic-api-key"]) {
      const result = await upload({ providerId: "openai" }, { [header]: SENT_KEY });
      expect(result).toEqual({ status: 400, error: "API keys are configured on the server; do not send one with a study." });
    }
    expect(selections).toEqual([]);
  });

  it("accepts only configured provider ids and their listed models", async () => {
    await start(env);
    expect((await upload({ providerId: "gemini" })).status).toBe(400);
    expect((await upload({ providerId: "custom", modelName: "llama" })).status).toBe(400);
    const unlisted = await upload({ providerId: "openai", modelName: "gpt-unlisted" });
    expect(unlisted).toEqual({ status: 400, error: "Choose one of the models listed for this provider." });
    expect(selections).toEqual([]);
  });
});
