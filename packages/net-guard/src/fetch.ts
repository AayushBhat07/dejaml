import { createHash } from "node:crypto";
import { type FileHandle, lstat, open, rename, rm } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import https, { type RequestOptions } from "node:https";

import { type AddressPolicy, createPinnedLookup, defaultResolver, type ResolvedHost, type Resolver, resolvePublic } from "./dns.js";
import { NetGuardError } from "./errors.js";
import { isPublicAddress, parseIpLiteral } from "./ip.js";
import { type FetchPolicy, validateFetchUrl } from "./url-policy.js";

export const DEFAULT_USER_AGENT = "DejaML-NetGuard/0.1";
export const MAX_POLICY_REDIRECTS = 20;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Same shape as `https.request(options, callback)`. */
export type HttpsTransport = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

export interface SafeDownloadOptions {
  readonly url: string;
  readonly policy: FetchPolicy;
  /** Absolute path of the final file; must not exist yet. */
  readonly destinationFile: string;
  /** Lowercase or uppercase hex SHA-256 the body must match. */
  readonly expectedSha256?: string;
  readonly resolver?: Resolver;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /**
   * Test seam: replaces `https.request`. Receives the fully built options
   * (pinned `lookup`, `servername`, `rejectUnauthorized: true`) and must pass
   * them through. The connected peer is still checked against the pinned IP.
   */
  readonly transport?: HttpsTransport;
  /**
   * Test seam: which resolved addresses may be contacted. Defaults to
   * `isPublicAddress`. Never wire this to configuration.
   */
  readonly addressPolicy?: AddressPolicy;
}

export interface DownloadReceipt {
  readonly sourceUrl: string;
  readonly finalUrl: string;
  /** Every validated redirect target, in order. */
  readonly redirects: string[];
  readonly resolvedAddress: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string | null;
  readonly fetchedAt: string;
  readonly expectedSha256: string | null;
  readonly checksumVerified: boolean;
}

function assertPolicy(policy: FetchPolicy): void {
  const positiveInt = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (
    !Array.isArray(policy.allowedHosts) ||
    !Number.isSafeInteger(policy.maxRedirects) ||
    policy.maxRedirects < 0 ||
    policy.maxRedirects > MAX_POLICY_REDIRECTS ||
    !positiveInt(policy.maxBytes) ||
    !positiveInt(policy.timeoutMs) ||
    (policy.maxDeclaredBytes !== undefined && !positiveInt(policy.maxDeclaredBytes)) ||
    (policy.idleTimeoutMs !== undefined && !positiveInt(policy.idleTimeoutMs))
  ) {
    throw new NetGuardError("invalid_policy", "Fetch policy limits are invalid");
  }
}

function normalizeExpectedSha256(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new NetGuardError("invalid_checksum", "expectedSha256 must be 64 hex characters");
  }
  return normalized;
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new NetGuardError("destination_exists", `Destination already exists: ${path}`);
}

function sameAddress(left: string | undefined, right: string): boolean {
  if (left === undefined) {
    return false;
  }
  const a = parseIpLiteral(left);
  const b = parseIpLiteral(right);
  return a !== null && b !== null && a.family === b.family && Buffer.compare(a.bytes, b.bytes) === 0;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
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

interface RequestContext {
  readonly policy: FetchPolicy;
  readonly transport: HttpsTransport;
  readonly signal: AbortSignal;
  readonly abort: (reason: NetGuardError) => void;
}

function sendRequest(url: URL, resolved: ResolvedHost, context: RequestContext): Promise<IncomingMessage> {
  const { policy, transport, signal, abort } = context;
  return new Promise<IncomingMessage>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const request = transport(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "User-Agent": policy.userAgent ?? DEFAULT_USER_AGENT,
          Accept: "*/*",
          "Accept-Encoding": "identity",
          Connection: "close",
        },
        agent: false,
        lookup: createPinnedLookup(url.hostname, resolved.pinned),
        family: resolved.pinned.family,
        servername: url.hostname,
        rejectUnauthorized: true,
        timeout: policy.idleTimeoutMs ?? Math.min(policy.timeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
        signal,
      },
      (response) => {
        if (!sameAddress(response.socket.remoteAddress, resolved.pinned.address)) {
          const error = new NetGuardError(
            "pinning_violation",
            `Connected to ${response.socket.remoteAddress ?? "unknown"}, expected ${resolved.pinned.address}`,
          );
          response.destroy(error);
          request.destroy(error);
          reject(error);
          return;
        }
        resolve(response);
      },
    );
    request.on("timeout", () => abort(new NetGuardError("timeout", "Socket was idle for too long")));
    request.on("error", reject);
    request.end();
  });
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

const TLS_ERROR_CODES = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_OSSL_)/;

function toNetGuardError(error: unknown, signal: AbortSignal): NetGuardError {
  if (signal.aborted && signal.reason instanceof NetGuardError) {
    return signal.reason;
  }
  if (error instanceof NetGuardError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (code === "EEXIST") {
    return new NetGuardError("destination_exists", "Destination or partial file already exists", { cause: error });
  }
  if (TLS_ERROR_CODES.test(code)) {
    return new NetGuardError("tls_failed", `TLS verification failed (${code})`, { cause: error });
  }
  return new NetGuardError("request_failed", `Download failed${code ? ` (${code})` : ""}`, { cause: error });
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (!/^\d{1,16}$/.test(value.trim())) {
    throw new NetGuardError("request_failed", "Response has a malformed content-length");
  }
  return Number(value.trim());
}

/**
 * Downloads one untrusted URL under the policy: https only, allowlisted hosts,
 * every hop re-validated and re-resolved, the socket pinned to the validated
 * address, size/time limits enforced, and the file written atomically.
 */
export async function safeDownload(options: SafeDownloadOptions): Promise<DownloadReceipt> {
  const { policy, destinationFile } = options;
  assertPolicy(policy);
  const expectedSha256 = normalizeExpectedSha256(options.expectedSha256);
  const resolver = options.resolver ?? defaultResolver;
  const addressPolicy = options.addressPolicy ?? isPublicAddress;
  const transport = options.transport ?? https.request;
  const partialFile = `${destinationFile}.partial`;

  let current = validateFetchUrl(options.url, policy);
  const sourceUrl = current.href;
  await assertAbsent(destinationFile);

  const controller = new AbortController();
  const abort = (reason: NetGuardError): void => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };
  const onCallerAbort = (): void => abort(new NetGuardError("cancelled", "Download was cancelled"));
  if (options.signal?.aborted) {
    onCallerAbort();
  } else {
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => abort(new NetGuardError("timeout", `Download exceeded ${policy.timeoutMs} ms`)), policy.timeoutMs);

  let response: IncomingMessage | undefined;
  const destroyResponse = (): void => {
    response?.destroy(controller.signal.reason as Error);
  };
  controller.signal.addEventListener("abort", destroyResponse, { once: true });

  let handle: FileHandle | undefined;
  let partialCreated = false;
  const context: RequestContext = { policy, transport, signal: controller.signal, abort };

  try {
    const redirects: string[] = [];
    let resolved: ResolvedHost;
    for (;;) {
      resolved = await abortable(resolvePublic(current.hostname, resolver, addressPolicy), controller.signal);
      response = await sendRequest(current, resolved, context);
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && status !== 304) {
        const location = response.headers.location;
        response.destroy();
        response = undefined;
        if (location === undefined || location === "") {
          throw new NetGuardError("http_error", `Redirect ${status} without a Location header`);
        }
        if (redirects.length >= policy.maxRedirects) {
          throw new NetGuardError("too_many_redirects", `More than ${policy.maxRedirects} redirects`);
        }
        let next: string;
        try {
          next = new URL(location, current).href;
        } catch (cause) {
          throw new NetGuardError("invalid_url", "Redirect Location could not be parsed", { cause });
        }
        current = validateFetchUrl(next, policy);
        redirects.push(current.href);
        continue;
      }
      if (status < 200 || status >= 300) {
        throw new NetGuardError("http_error", `Upstream responded with HTTP ${status}`);
      }
      break;
    }

    const declared = parseContentLength(response.headers["content-length"]);
    const declaredLimit = Math.min(policy.maxDeclaredBytes ?? policy.maxBytes, policy.maxBytes);
    if (declared !== null && declared > declaredLimit) {
      throw new NetGuardError("response_too_large", `Declared size ${declared} exceeds ${declaredLimit} bytes`);
    }

    handle = await open(partialFile, "wx", 0o600);
    partialCreated = true;
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > policy.maxBytes) {
        throw new NetGuardError("response_too_large", `Body exceeds ${policy.maxBytes} bytes`);
      }
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
    if (!response.complete || (declared !== null && bytes !== declared)) {
      throw new NetGuardError("request_failed", "Response body was truncated");
    }
    const sha256 = hash.digest("hex");
    if (expectedSha256 !== null && sha256 !== expectedSha256) {
      throw new NetGuardError("checksum_mismatch", `Expected sha256 ${expectedSha256}, got ${sha256}`);
    }

    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertAbsent(destinationFile);
    await rename(partialFile, destinationFile);
    partialCreated = false;

    const contentType = response.headers["content-type"];
    const mimeType = contentType?.split(";")[0]?.trim().toLowerCase() || null;
    return {
      sourceUrl,
      finalUrl: current.href,
      redirects,
      resolvedAddress: resolved.pinned.address,
      sha256,
      bytes,
      mimeType,
      fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
      expectedSha256,
      checksumVerified: expectedSha256 !== null,
    };
  } catch (error) {
    response?.destroy();
    throw toNetGuardError(error, controller.signal);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    controller.signal.removeEventListener("abort", destroyResponse);
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (partialCreated) {
      await rm(partialFile, { force: true });
    }
  }
}
