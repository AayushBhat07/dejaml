import { createGuardedFetch, NetGuardError, type EndpointAccess, type EndpointTransport, type Resolver } from "@dejaml/net-guard";

import { ProviderError, type ModelPrice, type ProviderErrorCode } from "./types.js";

/**
 * Shared HTTP plumbing for provider adapters: bounded retries with full-jitter
 * exponential backoff, `retry-after` handling, a per-request timeout distinct
 * from caller cancellation, and mapping of HTTP failures to `ProviderError`.
 *
 * Nothing here ever formats request headers into an error message; adapters
 * additionally pass their API key so it can be scrubbed from any provider
 * error text that happens to echo it.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal | undefined;
  sleep?: SleepFn;
  random?: () => number;
  /** Observes each scheduled retry (after a failed attempt, before sleeping). */
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
};

export const DEFAULT_RETRY = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 20_000 } as const;
export const DEFAULT_TIMEOUT_MS = 180_000;
/** Deadline for DNS, TCP and TLS setup of one attempt. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** Cap on bytes read from one response body, JSON or SSE. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Error bodies are only read for their message; anything longer is cut. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE = 500;

/** Options shared by every HTTP adapter. */
export type ProviderHttpOptions = {
  /** Injected fetch (tests); defaults to net-guard's guarded fetch under the public-address policy. */
  fetchImpl?: FetchLike;
  /** Per-attempt total timeout in ms (covers the whole body, including streams). Default 180000. */
  timeoutMs?: number;
  /** Per-attempt DNS + TCP + TLS setup deadline in ms (guarded fetch only). Default 15000. */
  connectTimeoutMs?: number;
  /** Cap on bytes read from one response body (JSON or SSE). Default 8 MiB. */
  maxResponseBytes?: number;
  /** Allowed model ids; a request for any other model fails before any network call. */
  models?: readonly string[];
  /** Retry policy overrides (`signal` comes from each request). */
  retry?: Omit<RetryOptions, "signal">;
  /** Price table used to fill `costUsd`; defaults to `DEFAULT_PRICES`. */
  prices?: Readonly<Record<string, ModelPrice>>;
};

/** Refuses a model outside the allowlist without touching the network. */
export function assertModelAllowed(models: readonly string[] | null, model: string, providerLabel: string): void {
  if (models !== null && !models.includes(model)) {
    throw new ProviderError(
      "model_not_allowed",
      truncate(`${providerLabel} model ${JSON.stringify(model.slice(0, 128))} is not in the configured model list`),
      {
        retryable: false,
      },
    );
  }
}

/** Test seams for the guarded HTTP client. Never wired to configuration. */
export type NetGuardSeams = {
  resolver?: Resolver;
  transport?: EndpointTransport;
  addressPolicy?: (ip: string) => boolean;
};

/**
 * The HTTP client every adapter uses unless a test injects one: net-guard's
 * guarded fetch, which validates the URL and every resolved address, pins the
 * socket to the validated address, refuses redirects, and enforces connect,
 * total and size limits below the adapter's own checks.
 */
export function guardedProviderFetch(options: {
  access: EndpointAccess;
  allowHttp?: boolean;
  timeoutMs: number;
  connectTimeoutMs: number;
  maxResponseBytes: number;
  seams?: NetGuardSeams | undefined;
}): FetchLike {
  const guarded = createGuardedFetch({
    policy: {
      access: options.access,
      allowHttp: options.allowHttp === true,
      maxBytes: options.maxResponseBytes,
      connectTimeoutMs: options.connectTimeoutMs,
      timeoutMs: options.timeoutMs,
    },
    ...(options.seams?.resolver !== undefined ? { resolver: options.seams.resolver } : {}),
    ...(options.seams?.transport !== undefined ? { transport: options.seams.transport } : {}),
    ...(options.seams?.addressPolicy !== undefined ? { addressPolicy: options.seams.addressPolicy } : {}),
  });
  return (input, init) => guarded(input, init);
}

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function cancelledError(): ProviderError {
  return new ProviderError("cancelled", "Request cancelled by caller", { retryable: false });
}

/** Sleeps, but rejects with `cancelled` as soon as `signal` fires (even with an injected sleep). */
function abortableSleep(sleep: SleepFn, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms, signal).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(cancelledError());
        else resolve();
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof ProviderError ? err : cancelledError());
      },
    );
  });
}

/** Full-jitter exponential backoff: uniform in [0, min(max, base * 2^(attempt-1))]. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}

/**
 * Runs `fn(attempt)` until it succeeds, a non-retryable error is thrown, or
 * `maxAttempts` is reached. Returns the value and the number of attempts made.
 * The thrown error carries `details.attempts`.
 */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<{ value: T; attempts: number }> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_RETRY.maxAttempts);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const signal = options.signal;

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw withAttempts(cancelledError(), attempt - 1);
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (raw) {
      const error = toProviderError(raw, signal);
      if (!error.details.retryable || attempt >= maxAttempts) throw withAttempts(error, attempt);
      let delayMs: number;
      if (error.details.retryAfterMs !== undefined) {
        if (error.details.retryAfterMs > maxDelayMs) {
          throw withAttempts(
            new ProviderError(
              "rate_limited",
              `${error.message} (server asked to retry after ${Math.ceil(error.details.retryAfterMs / 1000)}s, above the ${Math.ceil(maxDelayMs / 1000)}s cap)`,
              {
                retryable: false,
                retryAfterMs: error.details.retryAfterMs,
                ...(error.details.status !== undefined ? { status: error.details.status } : {}),
              },
            ),
            attempt,
          );
        }
        delayMs = error.details.retryAfterMs;
      } else {
        delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      }
      options.onRetry?.({ attempt, delayMs, error });
      try {
        await abortableSleep(sleep, delayMs, signal);
      } catch (sleepErr) {
        throw withAttempts(toProviderError(sleepErr, signal), attempt);
      }
    }
  }
}

function withAttempts(error: ProviderError, attempts: number): ProviderError {
  return new ProviderError(error.code, error.message, { ...error.details, attempts });
}

function toProviderError(raw: unknown, signal: AbortSignal | undefined): ProviderError {
  if (raw instanceof ProviderError) return raw;
  if (signal?.aborted) return cancelledError();
  if (raw instanceof NetGuardError) return fromNetGuardError(raw);
  const message = raw instanceof Error ? raw.message : String(raw);
  return new ProviderError("network", truncate(`Network error: ${message}`), { retryable: true });
}

/**
 * Maps a network-boundary failure. Policy refusals (private address, internal
 * name, redirect, pinning) and oversize bodies are final; timeouts and
 * transport failures (resets, DNS hiccups) are retryable.
 */
export function fromNetGuardError(error: NetGuardError): ProviderError {
  const message = truncate(`Network guard: ${error.message}`);
  switch (error.code) {
    case "timeout":
      return new ProviderError("timeout", message, { retryable: true });
    case "cancelled":
      return cancelledError();
    case "response_too_large":
      return new ProviderError("response_too_large", message, { retryable: false });
    case "request_failed":
    case "dns_failed":
      return new ProviderError("network", message, { retryable: true });
    case "tls_failed":
      return new ProviderError("network", message, { retryable: false });
    default:
      return new ProviderError("blocked_endpoint", message, { retryable: false });
  }
}

/** Parses `retry-after-ms`, then `retry-after` (delta-seconds or HTTP date). */
export function parseRetryAfter(headers: Headers, now: () => number = Date.now): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "") {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  }
  const ra = headers.get("retry-after");
  if (ra === null || ra.trim() === "") return undefined;
  const seconds = Number(ra);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
  const date = Date.parse(ra);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now());
}

const ANTHROPIC_LIMITS = ["requests", "tokens", "input-tokens", "output-tokens"] as const;
const OPENAI_LIMITS = ["requests", "tokens"] as const;

/** Parses OpenAI reset durations such as `20ms`, `1s`, `6m0s`, `1h2m3.5s`. */
export function parseResetDuration(text: string): number | undefined {
  const t = text.trim();
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(t);
  if (!match || t === "") return undefined;
  const [, h, m, sec, ms] = match;
  return Math.ceil(Number(h ?? 0) * 3_600_000 + Number(m ?? 0) * 60_000 + Number(sec ?? 0) * 1000 + Number(ms ?? 0));
}

/**
 * When a 429 carries no `retry-after`, derives a wait from the rate-limit
 * headers of an exhausted limit: Anthropic's `anthropic-ratelimit-*-reset`
 * (RFC 3339 time) or OpenAI's `x-ratelimit-reset-*` (duration). Returns the
 * longest such wait, or undefined when no limit reports zero remaining.
 */
export function parseRateLimitReset(headers: Headers, now: () => number = Date.now): number | undefined {
  let wait: number | undefined;
  const consider = (ms: number | undefined) => {
    if (ms !== undefined && Number.isFinite(ms)) wait = Math.max(wait ?? 0, Math.max(0, ms));
  };
  for (const limit of ANTHROPIC_LIMITS) {
    if (headers.get(`anthropic-ratelimit-${limit}-remaining`)?.trim() !== "0") continue;
    const reset = headers.get(`anthropic-ratelimit-${limit}-reset`);
    const at = reset === null ? Number.NaN : Date.parse(reset);
    if (!Number.isNaN(at)) consider(Math.ceil(at - now()));
  }
  for (const limit of OPENAI_LIMITS) {
    if (headers.get(`x-ratelimit-remaining-${limit}`)?.trim() !== "0") continue;
    const reset = headers.get(`x-ratelimit-reset-${limit}`);
    if (reset !== null) consider(parseResetDuration(reset));
  }
  return wait;
}

export function truncate(text: string, max = MAX_ERROR_MESSAGE): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Removes every occurrence of each secret from `text`. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length > 0) out = out.split(s).join("[redacted]");
  }
  return out;
}

export function statusToCode(status: number): ProviderErrorCode {
  if (status === 401) return "authentication";
  if (status === 402) return "payment_required";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server_error";
  if (status === 409) return "server_error";
  return "invalid_request";
}

/** Extracts `{type, message}` from Anthropic (`{type:"error", error:{type,message}}`) or OpenAI (`{error:{message,type,code}}`) bodies. */
export function extractProviderError(bodyText: string): { type?: string; message?: string } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const e = (parsed as { error: unknown }).error;
      if (e && typeof e === "object") {
        const obj = e as Record<string, unknown>;
        const type = typeof obj["type"] === "string" ? obj["type"] : typeof obj["code"] === "string" ? obj["code"] : undefined;
        const message = typeof obj["message"] === "string" ? obj["message"] : undefined;
        return { ...(type !== undefined ? { type } : {}), ...(message !== undefined ? { message } : {}) };
      }
      if (typeof e === "string") return { message: e };
    }
  } catch {
    // not JSON
  }
  const trimmed = bodyText.trim();
  return trimmed ? { message: trimmed } : {};
}

export function httpError(
  providerLabel: string,
  status: number,
  bodyText: string,
  headers: Headers,
  secrets: readonly (string | undefined)[],
): ProviderError {
  const { type, message } = extractProviderError(bodyText);
  let code = statusToCode(status);
  if (type === "overloaded_error") code = "overloaded";
  const retryAfterMs = parseRetryAfter(headers) ?? (status === 429 ? parseRateLimitReset(headers) : undefined);
  // Both providers may say explicitly whether a request is worth retrying.
  const shouldRetry = headers.get("x-should-retry")?.trim().toLowerCase();
  const retryable = shouldRetry === "true" ? true : shouldRetry === "false" ? false : RETRYABLE_STATUSES.has(status);
  const text = redact(`${providerLabel} HTTP ${status}${type ? ` ${type}` : ""}${message ? `: ${message}` : ""}`, secrets);
  return new ProviderError(code, truncate(text), {
    status,
    retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export type RequestContext = {
  /** Aborts on caller cancel or timeout; pass to fetch and body reads. */
  signal: AbortSignal;
  /** Converts an exception thrown during fetch/body reading into a ProviderError. */
  classify(err: unknown): ProviderError;
  /** Call once output has reached the caller (e.g. streamed text): later failures are then not retried. */
  markDelivered(): void;
};

/**
 * Runs one HTTP attempt with a timeout that covers both the fetch and the body
 * consumption done by `run`. Timeouts become `timeout` (retryable); caller
 * aborts become `cancelled` (never retried); other throws become `network`.
 */
export async function withTimeout<T>(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  run: (ctx: RequestContext) => Promise<T>,
): Promise<T> {
  if (callerSignal?.aborted) throw cancelledError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  let delivered = false;
  const classifyRaw = (err: unknown): ProviderError => {
    if (callerSignal?.aborted) return cancelledError();
    if (timedOut) return new ProviderError("timeout", `Request timed out after ${timeoutMs}ms`, { retryable: true });
    if (err instanceof ProviderError) return err;
    if (err instanceof NetGuardError) return fromNetGuardError(err);
    const message = err instanceof Error ? err.message : String(err);
    return new ProviderError("network", truncate(`Network error: ${message}`), { retryable: true });
  };
  const classify = (err: unknown): ProviderError => {
    const e = classifyRaw(err);
    if (delivered && e.details.retryable) {
      return new ProviderError(e.code, `${e.message} (after partial output; not retried)`, { ...e.details, retryable: false });
    }
    return e;
  };
  try {
    return await run({
      signal: controller.signal,
      classify,
      markDelivered: () => {
        delivered = true;
      },
    });
  } catch (err) {
    throw classify(err);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

export function tooLarge(providerLabel: string, maxBytes: number): ProviderError {
  return new ProviderError("response_too_large", `${providerLabel} response exceeded ${maxBytes} bytes`, { retryable: false });
}

/**
 * Reads a whole body as UTF-8, refusing more than `maxBytes` (declared or
 * streamed). With `cut`, an oversize body is truncated instead (error bodies).
 */
export async function readBoundedText(
  res: Response,
  maxBytes: number,
  providerLabel: string,
  options: { cut?: boolean } = {},
): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (!options.cut && Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge(providerLabel, maxBytes);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        if (!options.cut) throw tooLarge(providerLabel, maxBytes);
        return text + decoder.decode(value.subarray(0, value.byteLength - (bytes - maxBytes)));
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // nothing to release after cancel
    }
  }
}

/** Reads a failed response's body for its error message (bounded; an oversize body is cut). */
export function readErrorBody(res: Response, providerLabel: string): Promise<string> {
  return readBoundedText(res, MAX_ERROR_BODY_BYTES, providerLabel, { cut: true });
}

/**
 * Yields SSE events (`event` name + joined `data`) from a streaming body.
 * With `limit`, throws `response_too_large` once more than `maxBytes` were read.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limit?: { maxBytes: number; providerLabel: string },
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (!done && limit !== undefined) {
        bytesRead += value.byteLength;
        if (bytesRead > limit.maxBytes) {
          reader.cancel().catch(() => {});
          throw tooLarge(limit.providerLabel, limit.maxBytes);
        }
      }
      if (done) buffer += decoder.decode();
      else buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, idx);
        const sepLen = buffer.startsWith("\r\n", idx) ? 2 : 1;
        buffer = buffer.slice(idx + sepLen);
        if (line === "") {
          if (data.length > 0 || event !== null) {
            yield { event, data: data.join("\n") };
          }
          event = null;
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "event") event = val;
        else if (field === "data") data.push(val);
      }
      if (done) {
        if (buffer !== "") {
          // Unterminated final line: treat as a complete field line.
          const line = buffer;
          buffer = "";
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
        }
        if (data.length > 0) yield { event, data: data.join("\n") };
        return;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // a pending read after cancel can make releaseLock throw; nothing to do
    }
  }
}

export function malformed(providerLabel: string, detail: string): ProviderError {
  return new ProviderError("malformed_response", truncate(`${providerLabel} returned a malformed response: ${detail}`), {
    retryable: false,
  });
}

/** Parses tool-argument JSON; `null` input when the text is not valid JSON. */
export function parseToolInput(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Maps an error `type` delivered inside a stream (no HTTP status) to a ProviderError. */
export function streamError(providerLabel: string, type: string, message: string, secrets: readonly (string | undefined)[]): ProviderError {
  const map: Record<string, { code: ProviderErrorCode; retryable: boolean }> = {
    overloaded_error: { code: "overloaded", retryable: true },
    rate_limit_error: { code: "rate_limited", retryable: true },
    api_error: { code: "server_error", retryable: true },
    server_error: { code: "server_error", retryable: true },
    timeout_error: { code: "timeout", retryable: true },
    authentication_error: { code: "authentication", retryable: false },
    permission_error: { code: "permission", retryable: false },
    not_found_error: { code: "not_found", retryable: false },
  };
  const m = map[type] ?? { code: "invalid_request" as const, retryable: false };
  return new ProviderError(m.code, truncate(redact(`${providerLabel} stream error ${type}: ${message}`, secrets)), {
    retryable: m.retryable,
  });
}
