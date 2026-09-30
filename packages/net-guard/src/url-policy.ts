import { NetGuardError } from "./errors.js";
import { isBlockedHostname, looksLikeIpv4Variant, parseIpLiteral } from "./ip.js";

/** Administrator-controlled limits for one class of outbound download. */
export interface FetchPolicy {
  /** Exact lowercase hostnames or `*.suffix` patterns (subdomains only). */
  readonly allowedHosts: readonly string[];
  readonly maxRedirects: number;
  /** Hard cap on streamed body bytes. */
  readonly maxBytes: number;
  /** Cap on a declared `content-length`; defaults to `maxBytes`. */
  readonly maxDeclaredBytes?: number;
  /** Overall deadline for resolution, connection, redirects and body. */
  readonly timeoutMs: number;
  /** Socket inactivity limit; defaults to min(timeoutMs, 30s). */
  readonly idleTimeoutMs?: number;
  /** Defaults to `[443]`. */
  readonly allowedPorts?: readonly number[];
  readonly userAgent?: string;
}

export const MAX_URL_LENGTH = 4096;
const DEFAULT_PORTS: readonly number[] = [443];
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN_RAW = /[\s\u0000-\u001f\u007f\\]/u;
const SOCKET_SCHEMES = /^[a-z][a-z0-9+.-]*\+unix:|^unix:/i;

/** Lowercase hostname is syntactically a plain multi-label DNS name. */
export function isPlainDnsName(host: string): boolean {
  if (host.length === 0 || host.length > 253) {
    return false;
  }
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((label) => HOST_LABEL.test(label));
}

/** Matches a normalized hostname against exact names and `*.suffix` patterns. */
export function hostMatchesAllowlist(host: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

function rawAuthorityHost(raw: string): string | null {
  const start = raw.indexOf("//");
  if (start === -1) {
    return null;
  }
  const rest = raw.slice(start + 2);
  const end = rest.search(/[/?#]/);
  let authority = end === -1 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    authority = authority.slice(at + 1);
  }
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    return close === -1 ? authority : authority.slice(0, close + 1);
  }
  const colon = authority.indexOf(":");
  return colon === -1 ? authority : authority.slice(0, colon);
}

function rejectIpLike(host: string): void {
  const bare = host.startsWith("[") ? host.slice(1, host.endsWith("]") ? -1 : undefined) : host;
  if (host.startsWith("[") || parseIpLiteral(bare) !== null || looksLikeIpv4Variant(bare)) {
    throw new NetGuardError("ip_literal_not_allowed", `IP-literal hosts are not allowed: ${host}`);
  }
}

/**
 * Parses and validates an untrusted URL against the policy. Returns a
 * normalized URL (trailing dot and fragment removed) or throws `NetGuardError`.
 */
export function validateFetchUrl(raw: string, policy: FetchPolicy): URL {
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
  if (url.protocol !== "https:") {
    throw new NetGuardError("scheme_not_allowed", `Scheme ${url.protocol} is not allowed; only https:`);
  }
  // WHATWG tolerates "https:host" and "https:/host"; require the explicit authority form.
  if (!/^https:\/\//i.test(raw)) {
    throw new NetGuardError("invalid_url", "URL must start with https://");
  }
  if (url.username !== "" || url.password !== "") {
    throw new NetGuardError("credentials_in_url", "Credentials in URLs are not allowed");
  }

  const rawHost = rawAuthorityHost(raw);
  if (rawHost !== null) {
    rejectIpLike(rawHost);
  }
  rejectIpLike(url.hostname);

  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  if (!isPlainDnsName(host)) {
    throw new NetGuardError("unsafe_hostname", `Hostname is not a plain public DNS name: ${url.hostname}`);
  }
  if (isBlockedHostname(host)) {
    throw new NetGuardError("unsafe_hostname", `Hostname is reserved for local or metadata use: ${host}`);
  }
  if (host !== url.hostname) {
    url.hostname = host;
  }

  if (!hostMatchesAllowlist(host, policy.allowedHosts)) {
    throw new NetGuardError("host_not_allowed", `Host is not on the download allowlist: ${host}`);
  }
  const port = url.port === "" ? 443 : Number(url.port);
  if (!(policy.allowedPorts ?? DEFAULT_PORTS).includes(port)) {
    throw new NetGuardError("port_not_allowed", `Port ${port} is not allowed`);
  }

  url.hash = "";
  return url;
}
