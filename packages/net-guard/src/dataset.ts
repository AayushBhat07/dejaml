import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { type ArchiveFormat, type ArchiveLimits, extractArchive, type ExtractedFile } from "./archive.js";
import { DatasetError } from "./dataset-errors.js";
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

// ---------------------------------------------------------------------------
// Lab datasets: fetched by the trusted host, verified, optionally extracted,
// sealed read-only for a bind mount, and described by an immutable identity.

export interface LabDatasetOptions {
  /** Display name from the claim contract; recorded in the identity. */
  readonly name: string;
  readonly url: string;
  readonly policy: FetchPolicy;
  /** Expected sha256 from the approved claim contract. */
  readonly expectedSha256?: string;
  /** Refuse (policy_blocked) before any request when no expected checksum is given. */
  readonly requireChecksum?: boolean;
  /**
   * Absolute directory to create (must not exist; its parent must, created by
   * the caller with 0711). Layout: `download/<fileName>` and, when extracted,
   * `extracted/...`. Sealed to files 0444, directories 0555.
   */
  readonly destinationDir: string;
  /** Defaults to the basename of the final (post-redirect) URL path. */
  readonly fileName?: string;
  /** Extract a zip, tar, tar.gz or gzip download; anything else fails with `archive_unsupported`. */
  readonly extract?: boolean;
  readonly archiveLimits?: Partial<ArchiveLimits>;
  readonly signal?: AbortSignal;
  readonly resolver?: Resolver;
  readonly now?: () => Date;
  /** Test seams; see `SafeDownloadOptions`. */
  readonly transport?: HttpsTransport;
  readonly addressPolicy?: AddressPolicy;
}

export interface DatasetExtraction {
  readonly format: ArchiveFormat;
  /** Regular files, sorted by UTF-8 byte order of path. */
  readonly files: readonly ExtractedFile[];
  readonly totalBytes: number;
  readonly fileCount: number;
  /** sha256 of the canonical sorted listing (see `listingDigest`). */
  readonly listingDigest: string;
}

/** Evidence record for one acquired dataset. Deeply frozen. */
export interface DatasetIdentity {
  readonly name: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly redirects: readonly string[];
  readonly host: string;
  readonly resolvedAddress: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly expectedSha256: string | null;
  readonly bytes: number;
  readonly contentType: string | null;
  readonly fetchedAt: string;
  /** False when no expected checksum was supplied: not reproducible-grade. */
  readonly checksumVerified: boolean;
  readonly extracted: DatasetExtraction | null;
}

export interface LabDataset {
  readonly identity: DatasetIdentity;
  /** The sealed directory to bind-mount read-only. */
  readonly root: string;
  /** Host path of the downloaded file. */
  readonly filePath: string;
  /** Relative to `root`. */
  readonly downloadPath: string;
  /** Relative to `root`, or null when not extracted. */
  readonly extractedPath: string | null;
}

export interface CleanupReceipt {
  readonly path: string;
  readonly removed: boolean;
  readonly verifiedAbsent: boolean;
  readonly errors: string[];
}

export const LAB_DATASET_DOWNLOAD_DIR = "download";
export const LAB_DATASET_EXTRACTED_DIR = "extracted";
const MAX_NAME_LENGTH = 200;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function toDatasetError(error: unknown, signal: AbortSignal | undefined): DatasetError {
  if (error instanceof DatasetError) {
    return error;
  }
  if (error instanceof NetGuardError) {
    return new DatasetError(error.code, error.message, { cause: error });
  }
  if (signal?.aborted) {
    return new DatasetError("cancelled", "Dataset acquisition was cancelled", { cause: error });
  }
  return new DatasetError("request_failed", "Dataset acquisition failed", { cause: error });
}

/** Sets files to 0444 and directories to 0555, bottom-up; refuses anything else. */
async function sealReadOnly(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await sealReadOnly(path);
    } else if (entry.isFile()) {
      await chmod(path, 0o444);
    } else {
      throw new DatasetError("archive_unsafe_path", `Unexpected non-regular file in dataset: ${path}`);
    }
  }
  await chmod(dir, 0o555);
}

function gzipMemberName(fileName: string): string {
  const stripped = fileName.replace(/\.(?:gz|gzip)$/i, "");
  return stripped !== fileName && isSafeFileName(stripped) ? stripped : "data";
}

/**
 * Acquires one dataset for the offline lab. The fetch reuses `safeDownload`
 * (allowlist, SSRF and DNS-rebinding defences, per-hop redirect checks, size
 * and time limits, cancellation). Failures throw `DatasetError`, whose
 * `policy` says whether the outcome is `policy_blocked` or `inconclusive`;
 * nothing is left on disk and no data is ever substituted.
 */
export async function acquireLabDataset(options: LabDatasetOptions): Promise<LabDataset> {
  const { destinationDir, signal } = options;
  if (
    typeof options.name !== "string" ||
    options.name.trim() === "" ||
    options.name.length > MAX_NAME_LENGTH ||
    // eslint-disable-next-line no-control-regex -- rejects control characters
    /[\u0000-\u001f\u007f]/u.test(options.name)
  ) {
    throw new DatasetError("invalid_policy", "Dataset name must be 1-200 printable characters");
  }
  if (!isAbsolute(destinationDir) || resolve(destinationDir) !== destinationDir) {
    throw new DatasetError("unsafe_file_name", "destinationDir must be an absolute, normalized path");
  }
  if (options.fileName !== undefined && !isSafeFileName(options.fileName)) {
    throw new DatasetError("unsafe_file_name", `Unsafe dataset file name: ${JSON.stringify(options.fileName)}`);
  }
  if (options.requireChecksum === true && (options.expectedSha256 ?? "").trim() === "") {
    throw new DatasetError("checksum_required", "An expected sha256 is required for this dataset");
  }
  if (signal?.aborted) {
    throw new DatasetError("cancelled", "Dataset acquisition was cancelled");
  }

  try {
    await mkdir(destinationDir, { mode: 0o700 });
  } catch (cause) {
    throw new DatasetError("destination_exists", `Cannot create a fresh dataset directory: ${destinationDir}`, {
      cause,
    });
  }

  try {
    const receipt = await acquireDataset({
      url: options.url,
      policy: options.policy,
      destinationDir: join(destinationDir, LAB_DATASET_DOWNLOAD_DIR),
      ...(options.fileName === undefined ? {} : { fileName: options.fileName }),
      ...(options.expectedSha256 === undefined ? {} : { expectedSha256: options.expectedSha256 }),
      ...(signal === undefined ? {} : { signal }),
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(options.addressPolicy === undefined ? {} : { addressPolicy: options.addressPolicy }),
    });

    let extracted: DatasetExtraction | null = null;
    if (options.extract === true) {
      const result = await extractArchive(await readFile(receipt.path), join(destinationDir, LAB_DATASET_EXTRACTED_DIR), {
        gzipMemberName: gzipMemberName(receipt.fileName),
        ...(options.archiveLimits === undefined ? {} : { limits: options.archiveLimits }),
        ...(signal === undefined ? {} : { signal }),
      });
      extracted = {
        format: result.format,
        files: result.files,
        totalBytes: result.totalBytes,
        fileCount: result.fileCount,
        listingDigest: result.listingDigest,
      };
    }
    if (signal?.aborted) {
      throw new DatasetError("cancelled", "Dataset acquisition was cancelled");
    }
    await sealReadOnly(destinationDir);

    const identity: DatasetIdentity = deepFreeze({
      name: options.name,
      requestedUrl: receipt.sourceUrl,
      finalUrl: receipt.finalUrl,
      redirects: [...receipt.redirects],
      host: new URL(receipt.finalUrl).hostname,
      resolvedAddress: receipt.resolvedAddress,
      fileName: receipt.fileName,
      sha256: receipt.sha256,
      expectedSha256: receipt.expectedSha256,
      bytes: receipt.bytes,
      contentType: receipt.mimeType,
      fetchedAt: receipt.fetchedAt,
      checksumVerified: receipt.checksumVerified,
      extracted,
    });
    return Object.freeze({
      identity,
      root: destinationDir,
      filePath: receipt.path,
      downloadPath: `${LAB_DATASET_DOWNLOAD_DIR}/${receipt.fileName}`,
      extractedPath: extracted === null ? null : LAB_DATASET_EXTRACTED_DIR,
    });
  } catch (error) {
    await cleanupDataset(destinationDir);
    throw toDatasetError(error, signal);
  }
}

async function makeRemovable(dir: string, errors: string[]): Promise<void> {
  try {
    await chmod(dir, 0o700);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await makeRemovable(join(dir, entry.name), errors);
      }
    }
  } catch (error) {
    errors.push(`${dir}: ${(error as Error).message}`);
  }
}

/**
 * Removes a dataset directory (sealed or partial) and verifies it is gone.
 * Never throws; problems are reported in `errors`. Symlinks are removed, not
 * followed. Relative, non-normalized and filesystem-root paths are refused.
 */
export async function cleanupDataset(target: string | Pick<LabDataset, "root">): Promise<CleanupReceipt> {
  const path = typeof target === "string" ? target : target.root;
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || resolve(path, "..") === path) {
    return {
      path: String(path),
      removed: false,
      verifiedAbsent: false,
      errors: ["refused: path must be absolute, normalized and not a filesystem root"],
    };
  }
  const errors: string[] = [];
  let existed = true;
  try {
    if ((await lstat(path)).isDirectory()) {
      await makeRemovable(path, errors);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      existed = false;
    } else {
      errors.push((error as Error).message);
    }
  }
  if (existed) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  let verifiedAbsent = false;
  try {
    await lstat(path);
    errors.push("path still exists after removal");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      verifiedAbsent = true;
    } else {
      errors.push((error as Error).message);
    }
  }
  return { path, removed: existed && verifiedAbsent, verifiedAbsent, errors };
}
