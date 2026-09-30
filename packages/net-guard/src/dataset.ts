import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { AddressPolicy, Resolver } from "./dns.js";
import { NetGuardError } from "./errors.js";
import { type DownloadReceipt, type HttpsTransport, safeDownload } from "./fetch.js";
import { isBlockedHostname, looksLikeIpv4Variant, parseIpLiteral } from "./ip.js";
import { type FetchPolicy, isPlainDnsName } from "./url-policy.js";

export const DATASET_MAX_BYTES = 200 * 1024 * 1024;

/** Nothing is downloadable until an administrator configures `allowedHosts`. */
export const DEFAULT_DATASET_POLICY: FetchPolicy = Object.freeze({
  allowedHosts: Object.freeze([]) as readonly string[],
  maxRedirects: 3,
  maxBytes: DATASET_MAX_BYTES,
  timeoutMs: 120_000,
});

const FILE_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** Safe single-component file name: `[A-Za-z0-9._-]{1,128}`, no leading dot. */
export function isSafeFileName(name: string): boolean {
  return FILE_NAME_PATTERN.test(name);
}

function fileNameFromUrl(url: string): string {
  const path = new URL(url).pathname;
  const last = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function requireSafeFileName(name: string): string {
  if (!isSafeFileName(name)) {
    throw new NetGuardError("unsafe_file_name", `Unsafe dataset file name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Parses an administrator allowlist such as
 * `archive.ics.uci.edu,*.zenodo.org,raw.githubusercontent.com`.
 */
export function parseAllowedHosts(env: string | undefined): string[] {
  if (env === undefined || env.trim() === "") {
    return [];
  }
  const hosts = new Set<string>();
  for (const entry of env.split(",")) {
    const pattern = entry.trim().toLowerCase();
    if (pattern === "") {
      continue;
    }
    const wildcard = pattern.startsWith("*.");
    const base = wildcard ? pattern.slice(2) : pattern;
    if (
      base.includes("*") ||
      parseIpLiteral(base) !== null ||
      looksLikeIpv4Variant(base) ||
      !isPlainDnsName(base) ||
      isBlockedHostname(base)
    ) {
      throw new NetGuardError("invalid_allowlist", `Invalid allowed host entry: ${JSON.stringify(entry.trim())}`);
    }
    hosts.add(pattern);
  }
  return [...hosts];
}

export interface AcquireDatasetOptions {
  readonly url: string;
  readonly expectedSha256?: string;
  readonly policy: FetchPolicy;
  /** Absolute directory; created with mode 0o700 if missing. */
  readonly destinationDir: string;
  /** Defaults to the basename of the final (post-redirect) URL path. */
  readonly fileName?: string;
  readonly signal?: AbortSignal;
  readonly resolver?: Resolver;
  readonly now?: () => Date;
  /** Test seams; see `SafeDownloadOptions`. */
  readonly transport?: HttpsTransport;
  readonly addressPolicy?: AddressPolicy;
}

export interface DatasetReceipt extends DownloadReceipt {
  readonly path: string;
  readonly fileName: string;
}

/** Downloads one dataset file into `destinationDir` under the fetch policy. */
export async function acquireDataset(options: AcquireDatasetOptions): Promise<DatasetReceipt> {
  if (!isAbsolute(options.destinationDir)) {
    throw new NetGuardError("unsafe_file_name", "destinationDir must be an absolute path");
  }
  const requestedName = options.fileName === undefined ? undefined : requireSafeFileName(options.fileName);
  await mkdir(options.destinationDir, { recursive: true, mode: 0o700 });

  const downloadName = requestedName ?? `download-${randomUUID()}.tmp`;
  const downloadPath = join(options.destinationDir, downloadName);
  const receipt = await safeDownload({
    url: options.url,
    policy: options.policy,
    destinationFile: downloadPath,
    ...(options.expectedSha256 === undefined ? {} : { expectedSha256: options.expectedSha256 }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.addressPolicy === undefined ? {} : { addressPolicy: options.addressPolicy }),
  });
  if (requestedName !== undefined) {
    return { ...receipt, path: downloadPath, fileName: requestedName };
  }

  try {
    const fileName = requireSafeFileName(fileNameFromUrl(receipt.finalUrl));
    const path = join(options.destinationDir, fileName);
    const existing = await lstat(path).then(
      () => true,
      () => false,
    );
    if (existing) {
      throw new NetGuardError("destination_exists", `Destination already exists: ${path}`);
    }
    await rename(downloadPath, path);
    return { ...receipt, path, fileName };
  } catch (error) {
    await rm(downloadPath, { force: true });
    throw error;
  }
}
