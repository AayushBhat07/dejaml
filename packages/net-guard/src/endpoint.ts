import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";

import { type AddressPolicy, createPinnedLookup, defaultResolver, type ResolvedAddress, type Resolver, resolvePublic } from "./dns.js";
import { NetGuardError } from "./errors.js";
import { classifyAddress, isBlockedHostname, looksLikeIpv4Variant, parseIpLiteral } from "./ip.js";
import { isPlainDnsName, MAX_URL_LENGTH } from "./url-policy.js";

/**
 * Guarded HTTP client for administrator-configured API endpoints (model
 * providers). Unlike `safeDownload` there is no host allowlist: the endpoint
 * is whatever the operator configured, so the guard is about *where* it may
 * point. Every request re-validates the URL, resolves the host, requires every
 * answer to be acceptable for the policy's access level, pins the socket to
 * the validated address, refuses redirects, and bounds time and body size.
 */

/**
 * Which destinations an endpoint may reach.
 * - `public`: globally routable addresses only (production).
 * - `loopback`: public plus loopback (`localhost`, 127/8, ::1). Development only.
 * - `private`: loopback plus RFC 1918, CGNAT, link-local, ULA and internal
 *   names. Development only.
 * Cloud metadata endpoints, multicast, broadcast, unspecified and reserved
 * ranges are refused at every level.
 */
export type EndpointAccess = "public" | "loopback" | "private";

export interface EndpointPolicy {
  readonly access: EndpointAccess;
  /** Allow plain `http:`; honored only when `access` is not `public`. */
  readonly allowHttp?: boolean;
  /** Hard cap on response body bytes (declared or streamed). */
  readonly maxBytes: number;
  /** Deadline for DNS, TCP and TLS setup. */
  readonly connectTimeoutMs: number;
  /** Overall deadline from the call until the body is fully read. */
  readonly timeoutMs: number;
  /** Socket inactivity limit; defaults to `timeoutMs`. */
  readonly idleTimeoutMs?: number;
  readonly userAgent?: string;
}

export const DEFAULT_ENDPOINT_USER_AGENT = "DejaML/0.1";

/** Same shape as `http.request` / `https.request` with a callback. */
export type EndpointTransport = (
  options: RequestOptions & { rejectUnauthorized?: boolean; servername?: string },
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface GuardedFetchOptions {
  readonly policy: EndpointPolicy;
  readonly resolver?: Resolver;
  /**
   * Test seam: replaces `http.request`/`https.request`. Receives the fully
   * built options (pinned `lookup`, `servername`, `rejectUnauthorized: true`)
   * and must pass them through. The connected peer is still checked.
   */
  readonly transport?: EndpointTransport;
  /**
   * Test seam: which resolved addresses may be contacted, replacing the
   * access-level check. Never wire this to configuration.
   */
  readonly addressPolicy?: AddressPolicy;
}

/** A `fetch`-shaped function; only string bodies and byte arrays are supported. */
export type GuardedFetch = (input: string, init?: RequestInit) => Promise<Response>;

const FORBIDDEN_RAW = /[\s\u0000-\u001f\u007f\\]/u;
const SOCKET_SCHEMES = /^[a-z][a-z0-9+.-]*\+unix:|^unix:/i;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOOPBACK_NAMES = /^(?:localhost|[a-z0-9-]+\.localhost)$/;
// Refused at every access level, whatever DNS says.
const METADATA_NAMES = new Set(["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal"]);
const SKIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
]);

/** Whether an address class may be contacted at an access level. */
export function endpointAddressAllowed(ip: string, access: EndpointAccess): boolean {
  const cls = classifyAddress(ip);
  if (cls === "public") return true;
  if (access === "loopback") return cls === "loopback";
  if (access === "private") {
    return cls === "loopback" || cls === "private" || cls === "link_local" || cls === "unique_local" || cls === "carrier_nat";
  }
  return false;
}

function hostnameAllowed(host: string, access: EndpointAccess): boolean {
  if (host.length === 0 || host.length > 253 || METADATA_NAMES.has(host)) return false;
  if (access === "private") return host.split(".").every((label) => LABEL.test(label));
  if (access === "loopback" && LOOPBACK_NAMES.test(host)) return true;
  // A multi-label public DNS name outside local, internal and reserved zones.
  return isPlainDnsName(host) && !isBlockedHostname(host);
}

/**
 * Validates an endpoint URL for the policy. Returns the normalized URL (no
 * fragment, lowercase host without a trailing dot) or throws `NetGuardError`.
 * IP-literal hosts are allowed only when the address itself is acceptable.
 */
export function validateEndpointUrl(raw: string, policy: Pick<EndpointPolicy, "access" | "allowHttp">): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new NetGuardError("invalid_url", "URL is empty or too long");
  }
  if (FORBIDDEN_RAW.test(raw)) {
    throw new NetGuardError("invalid_url", "URL contains whitespace, control characters or backslashes");
  }
  if (SOCKET_SCHEMES.test(raw)) {
    throw new NetGuardError("unix_socket", "Unix-socket URLs are not allowed");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new NetGuardError("invalid_url", "URL could not be parsed", { cause });
  }
  const httpAllowed = policy.allowHttp === true && policy.access !== "public";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && httpAllowed)) {
    throw new NetGuardError("scheme_not_allowed", `Scheme ${url.protocol} is not allowed; only https:`);
  }
  if (!/^https?:\/\//i.test(raw)) {
    throw new NetGuardError("invalid_url", "URL must start with the scheme followed by //");
  }
  if (url.username !== "" || url.password !== "") {
    throw new NetGuardError("credentials_in_url", "Credentials in URLs are not allowed");
  }

  // WHATWG rewrites 0x7f.1 or 2130706433 to 127.0.0.1, so check the raw authority too.
  const rawHost = rawAuthorityHost(raw);
  if (rawHost !== null && !rawHost.startsWith("[") && looksLikeIpv4Variant(rawHost)) {
    throw new NetGuardError("ip_literal_not_allowed", "Non-canonical IPv4 hosts are not allowed");
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    const ip = host.slice(1, -1);
    if (parseIpLiteral(ip) === null) throw new NetGuardError("invalid_url", "IPv6 literal could not be parsed");
    if (!endpointAddressAllowed(ip, policy.access)) {
      throw new NetGuardError("private_address", `Address ${ip} is not allowed for this endpoint`);
    }
  } else if (parseIpLiteral(host) !== null) {
    if (!endpointAddressAllowed(host, policy.access)) {
      throw new NetGuardError("private_address", `Address ${host} is not allowed for this endpoint`);
    }
  } else {
    if (looksLikeIpv4Variant(host)) {
      throw new NetGuardError("ip_literal_not_allowed", "Non-canonical IPv4 hosts are not allowed");
    }
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (!hostnameAllowed(host, policy.access)) {
      throw new NetGuardError("unsafe_hostname", `Hostname is local, internal or not a plain DNS name: ${host}`);
    }
    if (host !== url.hostname) url.hostname = host;
  }
  url.hash = "";
  return url;
}

function rawAuthorityHost(raw: string): string | null {
  const start = raw.indexOf("//");
  if (start === -1) return null;
  const rest = raw.slice(start + 2);
  const end = rest.search(/[/?#]/);
  let authority = end === -1 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    return (close === -1 ? authority : authority.slice(0, close + 1)).toLowerCase();
  }
  const colon = authority.indexOf(":");
  return (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
}

function assertEndpointPolicy(policy: EndpointPolicy): void {
  const positiveInt = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (
    !["public", "loopback", "private"].includes(policy.access) ||
    !positiveInt(policy.maxBytes) ||
    !positiveInt(policy.connectTimeoutMs) ||
    !positiveInt(policy.timeoutMs) ||
    (policy.idleTimeoutMs !== undefined && !positiveInt(policy.idleTimeoutMs))
  ) {
    throw new NetGuardError("invalid_policy", "Endpoint policy limits are invalid");
  }
}

function sameAddress(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const a = parseIpLiteral(left);
  const b = parseIpLiteral(right);
  return a !== null && b !== null && a.family === b.family && Buffer.compare(a.bytes, b.bytes) === 0;
}

const TLS_ERROR_CODES = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_OSSL_)/;

function toNetGuardError(error: unknown, signal: AbortSignal): NetGuardError {
  if (signal.aborted && signal.reason instanceof NetGuardError) return signal.reason;
  if (error instanceof NetGuardError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (TLS_ERROR_CODES.test(code)) {
    return new NetGuardError("tls_failed", `TLS verification failed (${code})`, { cause: error });
  }
  return new NetGuardError("request_failed", `Request failed${code ? ` (${code})` : ""}`, { cause: error });
}

function requestBody(body: RequestInit["body"]): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new NetGuardError("invalid_policy", "Only string or byte request bodies are supported");
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d{1,16}$/.test(value.trim())) throw new NetGuardError("request_failed", "Response has a malformed content-length");
  return Number(value.trim());
}

/**
 * Builds a `fetch`-shaped client bound to an endpoint policy. The returned
 * `Response` streams its body; reading past `maxBytes` errors the stream with
 * `response_too_large`. Redirects are never followed (`redirect_refused`).
 */
export function createGuardedFetch(options: GuardedFetchOptions): GuardedFetch {
  const { policy } = options;
  assertEndpointPolicy(policy);
  const resolver = options.resolver ?? defaultResolver;
  const addressPolicy: AddressPolicy = options.addressPolicy ?? ((ip) => endpointAddressAllowed(ip, policy.access));

  return async (input, init = {}) => {
    const url = validateEndpointUrl(input, policy);
    const body = requestBody(init.body);
    const method = (init.method ?? (body === null ? "GET" : "POST")).toUpperCase();

    const controller = new AbortController();
    const signal = controller.signal;
    const abort = (reason: NetGuardError): void => {
      if (!signal.aborted) controller.abort(reason);
    };
    const onCallerAbort = (): void => abort(new NetGuardError("cancelled", "Request was cancelled"));
    const callerSignal = init.signal ?? undefined;
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const totalTimer = setTimeout(() => abort(new NetGuardError("timeout", `Request exceeded ${policy.timeoutMs} ms`)), policy.timeoutMs);
    const connectTimer = setTimeout(
      () => abort(new NetGuardError("timeout", `Connection was not established within ${policy.connectTimeoutMs} ms`)),
      policy.connectTimeoutMs,
    );
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };

    let response: IncomingMessage | undefined;
    let request: ClientRequest | undefined;
    const destroyAll = (): void => {
      const reason = signal.reason as Error;
      request?.destroy(reason);
      response?.destroy(reason);
    };
    signal.addEventListener("abort", destroyAll, { once: true });

    try {
      const bare = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
      let pinned: ResolvedAddress;
      const literal = parseIpLiteral(bare);
      if (literal !== null) {
        if (!addressPolicy(bare)) throw new NetGuardError("private_address", `Address ${bare} is not allowed for this endpoint`);
        pinned = { address: bare, family: literal.family };
      } else {
        pinned = (await abortable(resolvePublic(bare, resolver, addressPolicy), signal)).pinned;
      }

      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        if (!SKIPPED_REQUEST_HEADERS.has(name)) headers[name] = value;
      });
      headers["user-agent"] ??= policy.userAgent ?? DEFAULT_ENDPOINT_USER_AGENT;
      headers["accept-encoding"] = "identity";
      headers["connection"] = "close";
      if (body !== null) headers["content-length"] = String(body.length);

      const secure = url.protocol === "https:";
      const transport: EndpointTransport = options.transport ?? (secure ? https.request : http.request);
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const req = transport(
          {
            protocol: url.protocol,
            hostname: bare,
            port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method,
            headers,
            agent: false,
            lookup: createPinnedLookup(bare, pinned),
            family: pinned.family,
            ...(secure ? { rejectUnauthorized: true, ...(literal === null ? { servername: bare } : {}) } : {}),
            timeout: policy.idleTimeoutMs ?? policy.timeoutMs,
            signal,
          },
          (res) => {
            if (!sameAddress(res.socket.remoteAddress, pinned.address)) {
              const error = new NetGuardError(
                "pinning_violation",
                `Connected to ${res.socket.remoteAddress ?? "unknown"}, expected ${pinned.address}`,
              );
              res.destroy(error);
              req.destroy(error);
              reject(error);
              return;
            }
            resolve(res);
          },
        );
        request = req;
        req.once("socket", (socket: Socket) => {
          socket.once(secure ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
        });
        req.on("timeout", () => abort(new NetGuardError("timeout", "Socket was idle for too long")));
        req.on("error", reject);
        req.end(body ?? undefined);
      });
      clearTimeout(connectTimer);

      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        throw new NetGuardError("redirect_refused", `Endpoint answered with a redirect (HTTP ${status}); redirects are not followed`);
      }
      if (status < 200 || status > 599) throw new NetGuardError("request_failed", `Unexpected HTTP status ${status}`);
      const encoding = response.headers["content-encoding"];
      if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
        throw new NetGuardError("request_failed", `Unexpected content-encoding ${encoding}`);
      }
      const declared = parseContentLength(response.headers["content-length"]);
      if (declared !== null && declared > policy.maxBytes) {
        throw new NetGuardError("response_too_large", `Declared size ${declared} exceeds ${policy.maxBytes} bytes`);
      }

      const responseHeaders = new Headers();
      const raw = response.rawHeaders;
      for (let index = 0; index + 1 < raw.length; index += 2) {
        try {
          responseHeaders.append(raw[index] as string, raw[index + 1] as string);
        } catch {
          // skip header values the Fetch API cannot represent
        }
      }
      if (status === 204 || status === 205) {
        response.resume();
        finish();
        return new Response(null, { status, statusText: response.statusMessage ?? "", headers: responseHeaders });
      }
      const stream = boundedStream(response, policy.maxBytes, signal, (error) => {
        if (error !== null) abort(error);
        finish();
      });
      return new Response(stream, {
        status,
        statusText: response.statusMessage ?? "",
        headers: responseHeaders,
      });
    } catch (error) {
      const failure = toNetGuardError(error, signal);
      abort(failure);
      finish();
      throw failure;
    } finally {
      // From here the body stream owns cancellation, timers and the socket.
      signal.removeEventListener("abort", destroyAll);
    }
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Adapts a Node response to a web stream that errors once `maxBytes` is exceeded. */
function boundedStream(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
  done: (error: NetGuardError | null) => void,
): ReadableStream<Uint8Array> {
  let bytes = 0;
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (error: NetGuardError): void => {
        if (settled) return;
        settled = true;
        done(error);
        response.destroy(error);
        controller.error(error);
      };
      const onAbort = (): void => fail(toNetGuardError(signal.reason, signal));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          fail(new NetGuardError("response_too_large", `Body exceeds ${maxBytes} bytes`));
          return;
        }
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 1) <= 0) response.pause();
      });
      response.on("end", () => {
        if (settled) return;
        if (!response.complete) {
          fail(new NetGuardError("request_failed", "Response body was truncated"));
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        done(null);
        controller.close();
      });
      response.on("error", (error) => fail(toNetGuardError(error, signal)));
      response.on("close", () => {
        if (!settled) fail(toNetGuardError(new Error("connection closed"), signal));
      });
    },
    pull() {
      response.resume();
    },
    cancel() {
      if (settled) return;
      settled = true;
      done(null);
      response.destroy();
    },
  });
}
