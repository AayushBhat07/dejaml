import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { DatasetError, type DatasetErrorCode } from "./dataset-errors.js";

/**
 * A bounded, non-streaming archive reader for zip, tar, tar.gz and single-file
 * gzip. The whole archive is held in memory (its size is already capped by the
 * fetch policy); every entry is validated before anything is written, then
 * files are decompressed one at a time under hard output limits into a fresh
 * directory. Links, devices, unsafe paths, duplicates and bombs are refused.
 * Archives inside the archive are written as plain files, never extracted.
 */

export interface ArchiveLimits {
  /** Maximum number of entries (files and directories). */
  readonly maxFiles: number;
  /** Maximum sum of extracted file sizes. */
  readonly maxTotalBytes: number;
  /** Maximum size of one extracted file. */
  readonly maxFileBytes: number;
  /** Maximum uncompressed/compressed ratio, per entry and for the whole archive. */
  readonly maxRatio: number;
  /** The ratio limit applies only once the uncompressed size reaches this many bytes. */
  readonly ratioFloorBytes: number;
  readonly maxDepth: number;
  /** Maximum entry path length in UTF-16 code units. */
  readonly maxPathLength: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxFiles: 10_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxRatio: 100,
  ratioFloorBytes: 1024 * 1024,
  maxDepth: 32,
  maxPathLength: 1024,
});

export type ArchiveFormat = "zip" | "tar" | "tar.gz" | "gzip";

export interface ExtractedFile {
  /** POSIX relative path inside the extraction directory. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ExtractionResult {
  readonly format: ArchiveFormat;
  /** Regular files only, sorted by UTF-8 byte order of `path`. */
  readonly files: readonly ExtractedFile[];
  readonly totalBytes: number;
  readonly fileCount: number;
  /** See `listingDigest`. */
  readonly listingDigest: string;
}

export interface ExtractArchiveOptions {
  readonly limits?: Partial<ArchiveLimits>;
  /** Defaults to detection by magic bytes. */
  readonly format?: ArchiveFormat;
  /** File name for the single member of a plain (non-tar) gzip file. */
  readonly gzipMemberName?: string;
  readonly signal?: AbortSignal;
}

const LISTING_HEADER = "dejaml-dataset-listing-v1\n";

/**
 * SHA-256 over a canonical listing: a version line, then one
 * `<sha256> <bytes> <path>\n` line per file in UTF-8 byte order of path.
 * Paths never contain control characters, so the encoding is unambiguous.
 */
export function listingDigest(files: readonly ExtractedFile[]): string {
  const hash = createHash("sha256").update(LISTING_HEADER);
  for (const file of sortFiles(files)) {
    hash.update(`${file.sha256} ${file.bytes} ${file.path}\n`);
  }
  return hash.digest("hex");
}

function sortFiles(files: readonly ExtractedFile[]): ExtractedFile[] {
  return [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
}

export function detectArchiveFormat(data: Buffer): ArchiveFormat | null {
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) {
    const sig = data.readUInt32LE(0);
    if (sig === ZIP_LOCAL_SIG || sig === ZIP_EOCD_SIG) {
      return "zip";
    }
  }
  if (data.length >= 3 && data[0] === 0x1f && data[1] === 0x8b && data[2] === 0x08) {
    return "gzip";
  }
  if (isTar(data)) {
    return "tar";
  }
  return null;
}

function isTar(data: Buffer): boolean {
  return data.length >= 512 && data.toString("latin1", 257, 262) === "ustar";
}

function fail(code: DatasetErrorCode, message: string, cause?: unknown): never {
  throw new DatasetError(code, message, cause === undefined ? undefined : { cause });
}

// ---------------------------------------------------------------------------
// Entry paths

const FORBIDDEN_PATH_CHARS = /[\u0000-\u001f\u007f\\:]/u;
const MAX_SEGMENT_BYTES = 255;

/**
 * Validates an archive entry name and returns its normalized POSIX form.
 * Refuses absolute paths, drive letters, backslashes, colons, control
 * characters, `..`, `.` (except a leading `./`), empty segments and
 * over-long or over-deep paths.
 */
export function normalizeEntryPath(raw: string, limits: Pick<ArchiveLimits, "maxDepth" | "maxPathLength">): string {
  const show = JSON.stringify(raw.slice(0, 200));
  if (raw.length === 0 || raw.length > limits.maxPathLength) {
    fail("archive_unsafe_path", `Entry path is empty or too long: ${show}`);
  }
  if (FORBIDDEN_PATH_CHARS.test(raw)) {
    fail("archive_unsafe_path", `Entry path has a backslash, colon or control character: ${show}`);
  }
  if (raw.startsWith("/")) {
    fail("archive_unsafe_path", `Entry path is absolute: ${show}`);
  }
  let path = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  if (path === "" || path === ".") {
    return "";
  }
  const segments = path.split("/");
  if (segments.length > limits.maxDepth) {
    fail("archive_unsafe_path", `Entry path is nested too deeply: ${show}`);
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      fail("archive_unsafe_path", `Entry path has an empty, "." or ".." segment: ${show}`);
    }
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) {
      fail("archive_unsafe_path", `Entry path segment is too long: ${show}`);
    }
  }
  return segments.join("/");
}

// ---------------------------------------------------------------------------
// Planning: every entry is validated before anything touches the disk.

interface PlannedFile {
  readonly kind: "file";
  readonly path: string;
  readonly size: number;
  readonly read: () => Buffer;
}
interface PlannedDir {
  readonly kind: "dir";
  readonly path: string;
}
type PlannedEntry = PlannedFile | PlannedDir;

class Plan {
  readonly entries: PlannedEntry[] = [];
  private readonly kinds = new Map<string, "file" | "dir" | "implied">();
  private total = 0;

  constructor(private readonly limits: ArchiveLimits) {}

  add(rawPath: string, entry: { kind: "dir" } | { kind: "file"; size: number; read: () => Buffer }): void {
    if (this.entries.length >= this.limits.maxFiles) {
      fail("archive_too_many_files", `Archive has more than ${this.limits.maxFiles} entries`);
    }
    const path = normalizeEntryPath(rawPath, this.limits);
    if (path === "") {
      if (entry.kind === "dir") {
        return;
      }
      fail("archive_unsafe_path", "File entry has an empty path");
    }
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const key = this.key(segments.slice(0, depth).join("/"));
      const existing = this.kinds.get(key);
      if (existing === "file") {
        fail("archive_unsafe_path", `Entry ${JSON.stringify(path)} is inside a file entry`);
      }
      if (existing === undefined) {
        this.kinds.set(key, "implied");
      }
    }
    const key = this.key(path);
    const existing = this.kinds.get(key);
    if (existing === "file" || existing === "dir" || (existing === "implied" && entry.kind === "file")) {
      fail("archive_unsafe_path", `Duplicate or conflicting entry: ${JSON.stringify(path)}`);
    }
    this.kinds.set(key, entry.kind);
    if (entry.kind === "dir") {
      this.entries.push({ kind: "dir", path });
      return;
    }
    if (entry.size > this.limits.maxFileBytes) {
      fail("archive_too_large", `Entry ${JSON.stringify(path)} is ${entry.size} bytes (limit ${this.limits.maxFileBytes})`);
    }
    this.total += entry.size;
    if (this.total > this.limits.maxTotalBytes) {
      fail("archive_too_large", `Archive expands beyond ${this.limits.maxTotalBytes} bytes`);
    }
    this.entries.push({ kind: "file", path, size: entry.size, read: entry.read });
  }

  get totalBytes(): number {
    return this.total;
  }

  /** Case- and normalization-insensitive key so no two entries can alias on any filesystem. */
  private key(path: string): string {
    return path.normalize("NFC").toLowerCase();
  }
}

function checkRatio(uncompressed: number, compressed: number, limits: ArchiveLimits, what: string): void {
  if (uncompressed >= limits.ratioFloorBytes && uncompressed > compressed * limits.maxRatio) {
    fail(
      "archive_ratio_exceeded",
      `${what} expands ${uncompressed} bytes from ${compressed} (ratio limit ${limits.maxRatio})`,
    );
  }
}

// ---------------------------------------------------------------------------
// ZIP (no zip64, no encryption, stored or deflate only)

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const EOCD_SIZE = 22;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (data[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch (cause) {
    return fail("archive_corrupt", "Entry name is not valid UTF-8", cause);
  }
}

function findEocd(data: Buffer): number {
  const earliest = Math.max(0, data.length - EOCD_SIZE - 0xffff);
  for (let offset = data.length - EOCD_SIZE; offset >= earliest; offset -= 1) {
    if (data.readUInt32LE(offset) === ZIP_EOCD_SIG && offset + EOCD_SIZE + data.readUInt16LE(offset + 20) === data.length) {
      return offset;
    }
  }
  return fail("archive_corrupt", "Zip end-of-central-directory record not found");
}

function planZip(data: Buffer, plan: Plan, limits: ArchiveLimits): void {
  if (data.length < EOCD_SIZE) {
    fail("archive_corrupt", "Zip archive is truncated");
  }
  const eocd = findEocd(data);
  if (eocd >= 20 && data.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) {
    fail("archive_unsupported", "Zip64 archives are not supported");
  }
  const disk = data.readUInt16LE(eocd + 4);
  const cdDisk = data.readUInt16LE(eocd + 6);
  const diskEntries = data.readUInt16LE(eocd + 8);
  const totalEntries = data.readUInt16LE(eocd + 10);
  const cdSize = data.readUInt32LE(eocd + 12);
  const cdOffset = data.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    fail("archive_unsupported", "Zip64 archives are not supported");
  }
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== totalEntries) {
    fail("archive_unsupported", "Multi-disk zip archives are not supported");
  }
  if (totalEntries > limits.maxFiles) {
    fail("archive_too_many_files", `Archive has ${totalEntries} entries (limit ${limits.maxFiles})`);
  }
  if (cdOffset + cdSize !== eocd) {
    fail("archive_corrupt", "Zip central directory does not end at the end record (prepended or trailing data)");
  }

  const ranges: Array<[number, number]> = [];
  let declaredTotal = 0;
  let cursor = cdOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || data.readUInt32LE(cursor) !== ZIP_CENTRAL_SIG) {
      fail("archive_corrupt", "Zip central directory entry is malformed");
    }
    const madeBy = data.readUInt16LE(cursor + 4);
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const crc = data.readUInt32LE(cursor + 16);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const size = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const startDisk = data.readUInt16LE(cursor + 34);
    const externalAttributes = data.readUInt32LE(cursor + 38);
    const localOffset = data.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    const next = nameEnd + extraLength + commentLength;
    if (next > eocd) {
      fail("archive_corrupt", "Zip central directory entry overruns the directory");
    }
    const nameBytes = data.subarray(cursor + 46, nameEnd);
    const name = decodeName(nameBytes);
    cursor = next;

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff || startDisk !== 0) {
      fail("archive_unsupported", "Zip64 entries are not supported");
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      fail("archive_unsupported", `Encrypted zip entry: ${JSON.stringify(name)}`);
    }
    if (method !== 0 && method !== 8) {
      fail("archive_unsupported", `Zip compression method ${method} is not supported`);
    }
    const host = madeBy >> 8;
    const unixType = (externalAttributes >>> 16) & S_IFMT;
    if ((host === 3 || host === 19) && unixType !== 0 && unixType !== S_IFREG && unixType !== S_IFDIR) {
      fail("archive_unsafe_path", `Zip entry is a symlink or special file: ${JSON.stringify(name)}`);
    }

    if (localOffset + 30 > cdOffset || data.readUInt32LE(localOffset) !== ZIP_LOCAL_SIG) {
      fail("archive_corrupt", `Zip local header is missing for ${JSON.stringify(name)}`);
    }
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) {
      fail("archive_corrupt", `Zip entry data overruns the archive: ${JSON.stringify(name)}`);
    }
    if (!data.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) {
      fail("archive_corrupt", `Zip local and central names differ for ${JSON.stringify(name)}`);
    }
    ranges.push([localOffset, dataEnd]);

    if (name.endsWith("/") || unixType === S_IFDIR) {
      if (size !== 0 || !name.endsWith("/")) {
        fail("archive_corrupt", `Zip directory entry is malformed: ${JSON.stringify(name)}`);
      }
      plan.add(name, { kind: "dir" });
      continue;
    }
    if (method === 0 && compressedSize !== size) {
      fail("archive_corrupt", `Stored zip entry has mismatched sizes: ${JSON.stringify(name)}`);
    }
    checkRatio(size, compressedSize, limits, `Zip entry ${JSON.stringify(name)}`);
    declaredTotal += size;
    const compressed = data.subarray(dataStart, dataEnd);
    plan.add(name, {
      kind: "file",
      size,
      read: () => inflateZipEntry(compressed, method, size, crc, name),
    });
  }
  if (cursor !== eocd) {
    fail("archive_corrupt", "Zip central directory size does not match its entries");
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if ((ranges[index] as [number, number])[0] < (ranges[index - 1] as [number, number])[1]) {
      fail("archive_corrupt", "Zip entries overlap");
    }
  }
  checkRatio(declaredTotal, data.length, limits, "Archive");
}

function inflateZipEntry(compressed: Buffer, method: number, size: number, crc: number, name: string): Buffer {
  let output: Buffer;
  if (method === 0) {
    output = compressed;
  } else {
    try {
      // One extra byte of headroom so an understated size is detected, not truncated.
      output = inflateRawSync(compressed, { maxOutputLength: size + 1 });
    } catch (cause) {
      return fail("archive_corrupt", `Zip entry does not inflate to its declared size: ${JSON.stringify(name)}`, cause);
    }
  }
  if (output.length !== size) {
    fail("archive_corrupt", `Zip entry size differs from its header: ${JSON.stringify(name)}`);
  }
  if (crc32(output) !== crc) {
    fail("archive_corrupt", `Zip entry CRC mismatch: ${JSON.stringify(name)}`);
  }
  return output;
}

// ---------------------------------------------------------------------------
// TAR (POSIX ustar / pax / GNU long names)

const BLOCK = 512;
const MAX_PAX_BYTES = 64 * 1024;

function cString(data: Buffer, start: number, length: number): Buffer {
  const field = data.subarray(start, start + length);
  const nul = field.indexOf(0);
  return nul === -1 ? field : field.subarray(0, nul);
}

function parseOctal(data: Buffer, start: number, length: number, what: string): number {
  if (((data[start] as number) & 0x80) !== 0) {
    return fail("archive_too_large", `Tar ${what} uses base-256 encoding`);
  }
  const text = cString(data, start, length).toString("latin1").trim();
  if (text === "") {
    return 0;
  }
  if (!/^[0-7]{1,12}$/.test(text)) {
    return fail("archive_corrupt", `Tar ${what} field is malformed`);
  }
  return Number.parseInt(text, 8);
}

function parsePax(data: Buffer): { path?: string; size?: number } {
  const result: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const lengthText = space === -1 ? "" : data.toString("latin1", offset, space);
    if (!/^\d{1,6}$/.test(lengthText)) {
      fail("archive_corrupt", "Tar pax record is malformed");
    }
    const end = offset + Number(lengthText);
    if (end > data.length || end <= space + 1 || data[end - 1] !== 0x0a) {
      fail("archive_corrupt", "Tar pax record is truncated");
    }
    const body = decodeName(data.subarray(space + 1, end - 1));
    const equals = body.indexOf("=");
    if (equals <= 0) {
      fail("archive_corrupt", "Tar pax record has no key");
    }
    const key = body.slice(0, equals);
    const value = body.slice(equals + 1);
    if (key === "path") {
      result.path = value;
    } else if (key === "size") {
      if (!/^\d{1,16}$/.test(value)) {
        fail("archive_corrupt", "Tar pax size is malformed");
      }
      result.size = Number(value);
    }
    offset = end;
  }
  return result;
}

function verifyTarChecksum(header: Buffer): void {
  const stored = parseOctal(header, 148, 8, "checksum");
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] as number);
  }
  if (sum !== stored) {
    fail("archive_corrupt", "Tar header checksum mismatch");
  }
}

function planTar(data: Buffer, plan: Plan, limits: ArchiveLimits): void {
  let offset = 0;
  let pending: { path?: string; size?: number } = {};
  let headers = 0;
  const maxHeaders = limits.maxFiles * 3 + 16;
  while (offset < data.length) {
    if (offset + BLOCK > data.length) {
      fail("archive_corrupt", "Tar archive is truncated");
    }
    const header = data.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      return;
    }
    headers += 1;
    if (headers > maxHeaders) {
      fail("archive_too_many_files", `Archive has more than ${limits.maxFiles} entries`);
    }
    verifyTarChecksum(header);
    const magic = header.toString("latin1", 257, 263);
    const posix = magic === "ustar\u0000";
    if (!posix && magic !== "ustar ") {
      fail("archive_unsupported", "Only ustar, pax and GNU tar archives are supported");
    }
    const typeByte = header[156] as number;
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const headerSize = parseOctal(header, 124, 12, "size");
    const size = type === "0" || type === "7" ? (pending.size ?? headerSize) : headerSize;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > data.length) {
      fail("archive_corrupt", "Tar entry data overruns the archive");
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    const body = data.subarray(dataStart, dataEnd);

    if (type === "x" || type === "g" || type === "L") {
      if (size > MAX_PAX_BYTES) {
        fail("archive_too_large", "Tar extended header is too large");
      }
      if (type === "x") {
        pending = { ...pending, ...parsePax(body) };
      } else if (type === "L") {
        pending = { ...pending, path: decodeName(cString(body, 0, body.length)) };
      }
      continue;
    }

    let name = pending.path;
    if (name === undefined) {
      name = decodeName(cString(header, 0, 100));
      const prefix = posix ? decodeName(cString(header, 345, 155)) : "";
      if (prefix !== "") {
        name = `${prefix}/${name}`;
      }
    }
    pending = {};

    switch (type) {
      case "0":
      case "7":
        if (name.endsWith("/")) {
          fail("archive_corrupt", `Tar file entry has a directory name: ${JSON.stringify(name)}`);
        }
        plan.add(name, { kind: "file", size, read: () => body });
        break;
      case "5":
        plan.add(name, { kind: "dir" });
        break;
      case "1":
      case "2":
      case "K":
        fail("archive_unsafe_path", `Tar entry is a link: ${JSON.stringify(name)}`);
        break;
      case "3":
      case "4":
      case "6":
        fail("archive_unsafe_path", `Tar entry is a device or FIFO: ${JSON.stringify(name)}`);
        break;
      default:
        fail("archive_unsupported", `Tar entry type ${JSON.stringify(type)} is not supported`);
    }
  }
}

function gunzipBounded(data: Buffer, limits: ArchiveLimits): Buffer {
  const tarOverhead = (limits.maxFiles * 3 + 18) * BLOCK;
  const sizeCap = limits.maxTotalBytes + tarOverhead;
  const ratioCap = Math.max(data.length * limits.maxRatio, limits.ratioFloorBytes);
  const cap = Math.min(sizeCap, ratioCap);
  try {
    return gunzipSync(data, { maxOutputLength: cap });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || cause instanceof RangeError) {
      if (ratioCap < sizeCap) {
        return fail("archive_ratio_exceeded", `Gzip stream expands beyond ${limits.maxRatio}x its size`, cause);
      }
      return fail("archive_too_large", `Gzip stream expands beyond ${sizeCap} bytes`, cause);
    }
    return fail("archive_corrupt", "Gzip stream is corrupt", cause);
  }
}

// ---------------------------------------------------------------------------
// Writing

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

function inside(root: string, relative: string): string {
  const target = resolve(root, ...relative.split("/"));
  if (!target.startsWith(root + sep)) {
    fail("archive_unsafe_path", `Entry escapes the extraction directory: ${JSON.stringify(relative)}`);
  }
  return target;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    fail("cancelled", "Extraction was cancelled");
  }
}

const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

/**
 * Extracts `archive` into `destinationDir`, which must not exist yet (its
 * parent must). On success files are 0644 and directories 0755; on any
 * failure the directory is removed.
 */
export async function extractArchive(
  archive: Buffer,
  destinationDir: string,
  options: ExtractArchiveOptions = {},
): Promise<ExtractionResult> {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  if (!isAbsolute(destinationDir) || resolve(destinationDir) !== destinationDir) {
    fail("archive_unsafe_path", "destinationDir must be an absolute, normalized path");
  }
  const detected = options.format ?? detectArchiveFormat(archive);
  if (detected === null) {
    fail("archive_unsupported", "Not a zip, tar, or gzip archive");
  }

  const plan = new Plan(limits);
  let format: ArchiveFormat = detected;
  if (detected === "zip") {
    planZip(archive, plan, limits);
  } else if (detected === "tar") {
    planTar(archive, plan, limits);
  } else {
    const inflated = gunzipBounded(archive, limits);
    if (isTar(inflated)) {
      format = "tar.gz";
      planTar(inflated, plan, limits);
    } else {
      format = "gzip";
      const memberName = options.gzipMemberName ?? "data";
      checkRatio(inflated.length, archive.length, limits, "Gzip stream");
      plan.add(memberName, { kind: "file", size: inflated.length, read: () => inflated });
    }
  }
  checkAborted(options.signal);

  try {
    await mkdir(destinationDir, { mode: 0o700 });
  } catch (cause) {
    fail("destination_exists", `Cannot create a fresh extraction directory: ${destinationDir}`, cause);
  }
  const files: ExtractedFile[] = [];
  const dirs = new Set<string>();
  try {
    const ensureDir = async (relative: string): Promise<void> => {
      const segments = relative.split("/");
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const part = segments.slice(0, depth).join("/");
        if (!dirs.has(part)) {
          await mkdir(inside(destinationDir, part), { mode: 0o700 });
          dirs.add(part);
        }
      }
    };

    let total = 0;
    for (const entry of plan.entries) {
      checkAborted(options.signal);
      if (entry.kind === "dir") {
        await ensureDir(entry.path);
        continue;
      }
      const slash = entry.path.lastIndexOf("/");
      if (slash !== -1) {
        await ensureDir(entry.path.slice(0, slash));
      }
      const content = entry.read();
      if (content.length !== entry.size || content.length > limits.maxFileBytes) {
        fail("archive_corrupt", `Entry ${JSON.stringify(entry.path)} changed size while extracting`);
      }
      total += content.length;
      if (total > limits.maxTotalBytes) {
        fail("archive_too_large", `Archive expands beyond ${limits.maxTotalBytes} bytes`);
      }
      const handle = await open(inside(destinationDir, entry.path), WRITE_FLAGS, 0o600);
      try {
        await writeAll(handle, content);
        await handle.chmod(0o644);
      } finally {
        await handle.close();
      }
      files.push({
        path: entry.path,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.length,
      });
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
      await chmod(inside(destinationDir, dir), 0o755);
    }
    await chmod(destinationDir, 0o755);

    const sorted = sortFiles(files);
    return {
      format,
      files: sorted,
      totalBytes: total,
      fileCount: sorted.length,
      listingDigest: listingDigest(sorted),
    };
  } catch (error) {
    await rm(destinationDir, { recursive: true, force: true });
    if (error instanceof DatasetError) {
      throw error;
    }
    throw new DatasetError("archive_corrupt", "Extraction failed while writing", { cause: error });
  }
}
