import { describe, expect, it } from "vitest";
import { backoffDelay, httpError, parseRetryAfter, readSse, statusToCode, withRetries } from "./retry.js";
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
