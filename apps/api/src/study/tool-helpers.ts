import type { ToolResult } from "@dejaml/agent-runtime";
import { z } from "zod";

export const MAX_READ_BYTES = 24_000;

export const MAX_SEARCH_MATCHES = 60;
const EXCERPT_BYTES = 4_000;

export const RelativePathInput = z
  .string()
  .max(300)
  .describe("Path relative to the root, such as `.` or `src/train.py`.");

export function ok(summary: string, content: unknown, output?: Record<string, unknown>): ToolResult {
  return {
    summary,
    content: typeof content === "string" ? content : JSON.stringify(content, null, 1),
    ...(output ? { output } : {}),
  };
}

export function failed(summary: string, content: unknown, output?: Record<string, unknown>): ToolResult {
  return { ...ok(summary, content, output), isError: true, status: "error" };
}

export function tail(text: string, bytes = EXCERPT_BYTES): string {
  return text.length <= bytes ? text : `…${text.slice(-bytes)}`;
}
