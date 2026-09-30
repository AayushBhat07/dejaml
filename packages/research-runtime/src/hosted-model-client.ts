import { z } from "zod";

import {
  parseStructuredJson,
  schemaInstruction,
  type StructuredCompletion,
  type StructuredCompletionRequest,
  type StructuredModelClient,
} from "./model.js";

const ResponseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  }).optional(),
});

type Message = { role: "system" | "user" | "assistant"; content: string };

/**
 * In-process model adapter for the hosted agent worker. No OpenClaw binary,
 * gateway, global profile, or manually created agent is required.
 */
export class HostedModelClient implements StructuredModelClient {
  readonly #endpoint: URL;
  readonly #model: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #sessions = new Map<string, Message[]>();
  readonly #timeoutMs: number;

  constructor(input: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    const url = new URL(input.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("model base URL must be an HTTP(S) origin/path without credentials or query");
    }
    this.#endpoint = new URL(`${url.pathname.replace(/\/$/u, "")}/chat/completions`, url);
    this.#model = input.model.trim();
    if (!this.#model) throw new Error("DEJAML_MODEL is required");
    this.#apiKey = input.apiKey;
    this.#fetch = input.fetchImpl ?? fetch;
    this.#timeoutMs = input.timeoutMs ?? 180_000;
  }

  async complete<T>(request: StructuredCompletionRequest<T>): Promise<StructuredCompletion<T>> {
    const previous = this.#sessions.get(request.sessionId) ?? [];
    const messages: Message[] = [
      ...(previous.length ? previous : [{ role: "system" as const, content: request.systemPrompt }]),
      {
        role: "user",
        content: `${request.prompt}\n\nReturn only JSON matching this schema:\n${schemaInstruction(request.schema)}`,
      },
    ];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.#model, messages, stream: false }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`model provider returned HTTP ${response.status}`);
      const result = ResponseSchema.parse(await response.json());
      const content = result.choices[0]!.message.content;
      if (!content) throw new Error("model provider returned no text");
      const value = parseStructuredJson(content, request.schema);
      // Preserve a separate transcript for each role. Commit it only after a
      // valid response, so a failed turn cannot poison the next attempt.
      this.#sessions.set(request.sessionId, [...messages, { role: "assistant", content }]);
      return {
        value,
        provider: "hosted",
        model: result.model ?? this.#model,
        ...(result.usage ? {
          usage: {
            ...(result.usage.prompt_tokens !== undefined ? { input: result.usage.prompt_tokens } : {}),
            ...(result.usage.completion_tokens !== undefined ? { output: result.usage.completion_tokens } : {}),
            ...(result.usage.total_tokens !== undefined ? { total: result.usage.total_tokens } : {}),
          },
        } : {}),
      };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}
