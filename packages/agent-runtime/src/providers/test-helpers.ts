/** Test-only helpers: fixture loading and a recording fake `fetch`. Never touches the network. */
import { readFileSync } from "node:fs";
import type { FetchLike } from "./retry.js";

export function fixture(path: string): string {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
}

export function fixtureJson(path: string): unknown {
  return JSON.parse(fixture(path)) as unknown;
}

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
};

export type Responder = (req: RecordedRequest) => Response | Promise<Response>;

export function fakeFetch(responders: Responder[]): { fetchImpl: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req: RecordedRequest = {
      url: input,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : init.body,
      signal: init.signal ?? undefined,
    };
    calls.push(req);
    const responder = responders[calls.length - 1];
    if (!responder) throw new Error(`unexpected request #${calls.length}`);
    return await responder(req);
  };
  return { fetchImpl, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Streams `text` in fixed-size byte chunks so SSE lines split across reads. */
export function sseResponse(text: string, chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A response that never arrives; rejects when the request signal aborts. */
export function hang(req: RecordedRequest): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = req.signal;
    if (!signal) return;
    if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

/** Fake sleep that records requested delays and resolves immediately. */
export function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}
