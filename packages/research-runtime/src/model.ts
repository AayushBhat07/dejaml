import { z } from "zod";

export type AnalystRole = "paper_analyst" | "code_analyst";

export type StructuredCompletion<T> = {
  value: T;
  provider?: string;
  model?: string;
  usage?: { input?: number; output?: number; total?: number };
};

export type StructuredCompletionRequest<T> = {
  sessionId: string;
  role: AnalystRole;
  systemPrompt: string;
  prompt: string;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
};

export interface StructuredModelClient {
  complete<T>(request: StructuredCompletionRequest<T>): Promise<StructuredCompletion<T>>;
}

export function parseStructuredJson<T>(text: string, schema: z.ZodType<T>): T {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(
      `model response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return schema.parse(parsed);
}

export function schemaInstruction(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema), null, 2);
}
