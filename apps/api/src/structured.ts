import type { ChatMessage, ChatProvider } from "@dejaml/agent-runtime";
import {
  parseStructuredJson,
  schemaInstruction,
  type StructuredCompletion,
  type StructuredCompletionRequest,
  type StructuredModelClient,
} from "@dejaml/research-runtime";

/**
 * The curated path's structured JSON calls, served by a configured chat
 * provider (OpenAI, Anthropic, or the administrator's endpoint). Each session
 * keeps its own history, as the hosted client did.
 */
export class ChatStructuredClient implements StructuredModelClient {
  readonly #provider: ChatProvider;
  readonly #model: string;
  readonly #sessions = new Map<string, { system: string; messages: ChatMessage[] }>();

  constructor(provider: ChatProvider, model: string) {
    this.#provider = provider;
    this.#model = model;
  }

  async complete<T>(request: StructuredCompletionRequest<T>): Promise<StructuredCompletion<T>> {
    const session = this.#sessions.get(request.sessionId) ?? { system: request.systemPrompt, messages: [] };
    const messages: ChatMessage[] = [
      ...session.messages,
      { role: "user", content: `${request.prompt}\n\nReturn only JSON matching this schema:\n${schemaInstruction(request.schema)}` },
    ];
    const response = await this.#provider.chat({
      model: this.#model,
      system: session.system,
      messages,
      tools: [],
      maxOutputTokens: 8_000,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const value = parseStructuredJson(response.text ?? "", request.schema);
    this.#sessions.set(request.sessionId, {
      system: session.system,
      messages: [...messages, { role: "assistant", text: response.text, toolCalls: [], ...(response.providerContent ? { providerContent: response.providerContent } : {}) }],
    });
    return {
      value,
      provider: this.#provider.id,
      model: response.model,
      usage: { input: response.usage.inputTokens, output: response.usage.outputTokens, total: response.usage.inputTokens + response.usage.outputTokens },
    };
  }
}
