import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HostedModelClient } from "./hosted-model-client.js";

const schema = z.object({ action: z.enum(["inspect", "finish"]) });

describe("HostedModelClient", () => {
  it("keeps each agent session separate and sends the operator credential", async () => {
    const calls: Array<{ headers: HeadersInit; body: { messages: Array<{ role: string; content: string }> } }> = [];
    const client = new HostedModelClient({
      baseUrl: "https://provider.example/v1",
      model: "configured-model",
      apiKey: "operator-secret",
      fetchImpl: (async (_url, init) => {
        calls.push({
          headers: init?.headers ?? {},
          body: JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> },
        });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"inspect"}' } }] }), {
          status: 200,
        });
      }) as typeof fetch,
    });
    const base = { systemPrompt: "Follow the lab policy", prompt: "Choose the next action", schema };
    await client.complete({ ...base, role: "lab_agent", sessionId: "run-1:lab" });
    await client.complete({ ...base, role: "lab_agent", sessionId: "run-1:lab" });
    await client.complete({ ...base, role: "paper_analyst", sessionId: "run-1:paper" });

    expect(calls.map((call) => call.body.messages.length)).toEqual([2, 4, 2]);
    expect(calls[1]!.body.messages[2]).toEqual({ role: "assistant", content: '{"action":"inspect"}' });
    expect(calls[2]!.body.messages[0]?.content).toBe("Follow the lab policy");
    expect(new Headers(calls[0]!.headers).get("Authorization")).toBe("Bearer operator-secret");
  });

  it("does not expose provider response bodies or credentials on HTTP failure", async () => {
    const client = new HostedModelClient({
      baseUrl: "https://provider.example/v1",
      model: "configured-model",
      apiKey: "operator-secret",
      fetchImpl: (async () => new Response("operator-secret and sensitive response", { status: 401 })) as typeof fetch,
    });
    await expect(client.complete({
      role: "lab_agent", sessionId: "run-1:lab", systemPrompt: "policy", prompt: "next", schema,
    })).rejects.toThrow("model provider returned HTTP 401");
  });
});
