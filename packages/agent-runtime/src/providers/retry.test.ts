import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  httpError,
  parseRateLimitReset,
  parseResetDuration,
  parseRetryAfter,
  readBoundedText,
  readErrorBody,
  readSse,
  statusToCode,
  withRetries,
} from "./retry.js";
import { recordingSleep, sseResponse } from "./test-helpers.js";
import { ProviderError } from "./types.js";

describe("parseRetryAfter", () => {
  it("reads retry-after-ms, delta seconds and HTTP dates", () => {
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "250" }))).toBe(250);
    expect(parseRetryAfter(new Headers({ "retry-after": "2" }))).toBe(2000);
    expect(parseRetryAfter(new Headers({ "retry-after": "1.5" }))).toBe(1500);
    const now = Date.parse("Wed, 30 Sep 2026 12:00:00 GMT");
    expect(parseRetryAfter(new Headers({ "retry-after": "Wed, 30 Sep 2026 12:00:05 GMT" }), () => now)).toBe(5000);
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "100", "retry-after": "9" }))).toBe(100);
    expect(parseRetryAfter(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });
});

describe("rate-limit reset headers", () => {
  it("parses OpenAI reset durations", () => {
    expect(parseResetDuration("20ms")).toBe(20);
    expect(parseResetDuration("1s")).toBe(1000);
    expect(parseResetDuration("1.5s")).toBe(1500);
    expect(parseResetDuration("6m0s")).toBe(360_000);
    expect(parseResetDuration("1h2m3s")).toBe(3_723_000);
    expect(parseResetDuration("")).toBeUndefined();
    expect(parseResetDuration("soon")).toBeUndefined();
  });

  it("uses only exhausted limits and takes the longest wait", () => {
    const now = () => Date.parse("2026-09-30T12:00:00Z");
    const headers = new Headers({
      "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-requests-reset": "2026-09-30T12:00:02Z",
      "anthropic-ratelimit-input-tokens-remaining": "0",
      "anthropic-ratelimit-input-tokens-reset": "2026-09-30T12:00:07Z",
      "anthropic-ratelimit-output-tokens-remaining": "900",
      "anthropic-ratelimit-output-tokens-reset": "2026-09-30T12:01:00Z",
    });
    expect(parseRateLimitReset(headers, now)).toBe(7000);
    expect(parseRateLimitReset(new Headers({ "anthropic-ratelimit-tokens-reset": "2026-09-30T12:00:07Z" }), now)).toBeUndefined();
    expect(parseRateLimitReset(new Headers({ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "250ms" }), now)).toBe(250);
    // A reset already in the past means "now", not a negative wait.
    expect(
      parseRateLimitReset(new Headers({ "anthropic-ratelimit-tokens-remaining": "0", "anthropic-ratelimit-tokens-reset": "2026-09-30T11:59:00Z" }), now),
    ).toBe(0);
  });
});

describe("bounded body reads", () => {
  it("returns small bodies, refuses oversize ones, and cuts error bodies instead of failing", async () => {
    expect(await readBoundedText(new Response("hello"), 10, "Test")).toBe("hello");
    await expect(readBoundedText(new Response("x".repeat(11)), 10, "Test")).rejects.toMatchObject({ code: "response_too_large" });
    const huge = "e".repeat(200 * 1024);
    const cut = await readErrorBody(new Response(huge, { status: 500 }), "Test");
    expect(cut.length).toBe(64 * 1024);
  });
});

describe("backoffDelay", () => {
  it("is full jitter under an exponential, capped ceiling", () => {
    expect(backoffDelay(1, 500, 20_000, () => 0.999)).toBe(499);
    expect(backoffDelay(3, 500, 20_000, () => 0.5)).toBe(1000);
    expect(backoffDelay(10, 500, 20_000, () => 0.5)).toBe(10_000);
    expect(backoffDelay(4, 500, 20_000, () => 0)).toBe(0);
  });
});

describe("statusToCode / httpError", () => {
  it("maps statuses", () => {
    expect([401, 403, 404, 400, 422, 429, 529, 500, 502, 503, 504, 408].map(statusToCode)).toEqual([
      "authentication",
      "permission",
      "not_found",
      "invalid_request",
      "invalid_request",
      "rate_limited",
      "overloaded",
      "server_error",
      "server_error",
      "server_error",
      "server_error",
      "timeout",
    ]);
  });

  it("marks only transient statuses retryable and truncates to 500 chars", () => {
    for (const s of [408, 409, 429, 500, 502, 503, 504, 529]) expect(httpError("X", s, "", new Headers(), []).details.retryable).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(httpError("X", s, "", new Headers(), []).details.retryable).toBe(false);
    const long = JSON.stringify({ error: { type: "invalid_request_error", message: "x".repeat(2000) } });
    expect(httpError("X", 400, long, new Headers(), []).message.length).toBe(500);
  });

  it("redacts secrets echoed in error bodies", () => {
    const e = httpError("X", 401, '{"error":{"message":"bad key sk-SECRET-12345"}}', new Headers(), ["sk-SECRET-12345"]);
    expect(e.message).toBe("X HTTP 401: bad key [redacted]");
  });
});

describe("withRetries", () => {
  it("never retries cancellation or non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetries(async () => {
        calls++;
        throw new ProviderError("cancelled", "c");
      }),
    ).rejects.toMatchObject({ code: "cancelled", details: { attempts: 1 } });
    await expect(
      withRetries(async () => {
        calls++;
        throw new ProviderError("malformed_response", "m");
      }),
    ).rejects.toMatchObject({ code: "malformed_response" });
    expect(calls).toBe(2);
  });

  it("does not start when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    let calls = 0;
    await expect(withRetries(async () => ++calls, { signal: c.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(0);
  });

  it("returns the attempt count", async () => {
    const { sleep, delays } = recordingSleep();
    let n = 0;
    const out = await withRetries(
      async () => {
        if (++n < 3) throw new ProviderError("network", "down", { retryable: true });
        return "ok";
      },
      { sleep, random: () => 1, baseDelayMs: 100 },
    );
    expect(out).toEqual({ value: "ok", attempts: 3 });
    expect(delays).toEqual([100, 200]);
  });
});

describe("readSse", () => {
  it("handles CRLF, comments, multi-line data and a missing final blank line", async () => {
    const res = sseResponse(': keepalive\r\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata: last', 3);
    const out = [];
    for await (const ev of readSse(res.body!, new AbortController().signal)) out.push(ev);
    expect(out).toEqual([
      { event: "a", data: "1\n2" },
      { event: null, data: "last" },
    ]);
  });
});
