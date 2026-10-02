import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ArchiveLimits, detectArchiveFormat, extractArchive, listingDigest, normalizeEntryPath } from "./archive.js";
import { DatasetError, type DatasetErrorCode } from "./dataset-errors.js";
import { buildTar, buildZip, paxRecord } from "./test-archives.js";

const sha = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------------------

describe("extractArchive", () => {
  let workDir: string;
  let dest: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "net-guard-archive-"));
    dest = join(workDir, "out");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function failure(archive: Buffer, limits: Partial<ArchiveLimits> = {}): Promise<DatasetErrorCode> {
    try {
      await extractArchive(archive, dest, { limits });
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetError);
      expect(existsSync(dest)).toBe(false);
      return (error as DatasetError).code;
    }
    throw new Error("expected extraction to fail");
  }

  it("extracts stored and deflated zip entries with 0644/0755 perms and a canonical listing digest", async () => {
    const csv = Buffer.from("a,b\n1,2\n".repeat(50));
    const inner = buildZip([{ name: "nested.txt", data: Buffer.from("x") }]);
    const archive = buildZip([
      { name: "data/", method: 0 },
      { name: "data/train.csv", data: csv },
      { name: "README", data: Buffer.from("hello"), method: 0 },
      { name: "data/inner.zip", data: inner, method: 0 },
    ]);
    expect(detectArchiveFormat(archive)).toBe("zip");
    const result = await extractArchive(archive, dest);
    expect(result.format).toBe("zip");
    expect(result.files.map((file) => file.path)).toEqual(["README", "data/inner.zip", "data/train.csv"]);
    expect(result.fileCount).toBe(3);
    expect(result.totalBytes).toBe(csv.length + 5 + inner.length);
    expect(result.files[2]).toEqual({ path: "data/train.csv", sha256: sha(csv), bytes: csv.length });
    const expectedListing =
      "dejaml-dataset-listing-v1\n" +
      `${sha("hello")} 5 README\n` +
      `${sha(inner)} ${inner.length} data/inner.zip\n` +
      `${sha(csv)} ${csv.length} data/train.csv\n`;
    expect(result.listingDigest).toBe(sha(expectedListing));
    expect(listingDigest([...result.files].reverse())).toBe(result.listingDigest);
    expect(await readFile(join(dest, "data", "train.csv"))).toEqual(csv);
    // Nested archives are left as files.
    expect(await readdir(join(dest, "data"))).toEqual(["inner.zip", "train.csv"]);
    expect((await stat(join(dest, "README"))).mode & 0o7777).toBe(0o644);
    expect((await stat(join(dest, "data"))).mode & 0o7777).toBe(0o755);
    expect((await stat(dest)).mode & 0o7777).toBe(0o755);
  });

  it("refuses to extract into an existing directory", async () => {
    await extractArchive(buildZip([{ name: "a", data: Buffer.from("1") }]), dest);
    await expect(extractArchive(buildZip([{ name: "b", data: Buffer.from("1") }]), dest)).rejects.toMatchObject({
      code: "destination_exists",
    });
  });

  it.each(["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/evil.txt", "a\\..\\evil.txt", "a//b", "a/./b", "a\u0000b"])(
    "refuses zip-slip path %j",
    async (name) => {
      const archive = buildZip([
        { name: "ok.txt", data: Buffer.from("fine") },
        { name, data: Buffer.from("pwned") },
      ]);
      expect(await failure(archive)).toBe("archive_unsafe_path");
      expect(existsSync(join(workDir, "evil.txt"))).toBe(false);
    },
  );

  it("refuses zip symlink entries", async () => {
    const archive = buildZip([{ name: "link", data: Buffer.from("/etc/passwd"), method: 0, unixMode: 0o120777 }]);
    expect(await failure(archive)).toBe("archive_unsafe_path");
  });

  it("refuses duplicate and case-colliding entries and file/directory conflicts", async () => {
    expect(
      await failure(
        buildZip([
          { name: "a.csv", data: Buffer.from("1") },
          { name: "a.csv", data: Buffer.from("2") },
        ]),
      ),
    ).toBe("archive_unsafe_path");
    expect(
      await failure(
        buildZip([
          { name: "A.csv", data: Buffer.from("1") },
          { name: "a.csv", data: Buffer.from("2") },
        ]),
      ),
    ).toBe("archive_unsafe_path");
    expect(
      await failure(
        buildZip([
          { name: "a", data: Buffer.from("1") },
          { name: "a/b", data: Buffer.from("2") },
        ]),
      ),
    ).toBe("archive_unsafe_path");
    expect(
      await failure(
        buildZip([
          { name: "a/b", data: Buffer.from("1") },
          { name: "a", data: Buffer.from("2") },
        ]),
      ),
    ).toBe("archive_unsafe_path");
  });

  it("refuses a zip bomb by compression ratio before inflating", async () => {
    const archive = buildZip([{ name: "zeros.bin", data: Buffer.alloc(4 * 1024 * 1024) }]);
    expect(archive.length).toBeLessThan(40 * 1024);
    expect(await failure(archive)).toBe("archive_ratio_exceeded");
  });

  it("refuses too many files", async () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({ name: `f${index}.txt`, data: Buffer.from("x") }));
    expect(await failure(buildZip(entries), { maxFiles: 5 })).toBe("archive_too_many_files");
  });

  it("enforces per-file and total extracted-size limits", async () => {
    const big = Buffer.alloc(2048, 7);
    expect(await failure(buildZip([{ name: "big", data: big, method: 0 }]), { maxFileBytes: 1024 })).toBe("archive_too_large");
    const two = buildZip([
      { name: "a", data: big, method: 0 },
      { name: "b", data: big, method: 0 },
    ]);
    expect(await failure(two, { maxTotalBytes: 3000 })).toBe("archive_too_large");
  });

  it("refuses corrupt, encrypted, and non-archive input", async () => {
    expect(await failure(buildZip([{ name: "a", data: Buffer.from("abc"), crc: 1 }]))).toBe("archive_corrupt");
    const good = buildZip([{ name: "a", data: Buffer.from("abc") }]);
    expect(await failure(good.subarray(0, good.length - 3))).toBe("archive_corrupt");
    expect(await failure(buildZip([{ name: "a", data: Buffer.from("abc"), flags: 1 }]))).toBe("archive_unsupported");
    expect(await failure(Buffer.from("just,a,csv\n"))).toBe("archive_unsupported");
  });

  it("extracts tar with ./ prefixes, pax long paths, and strips setuid bits", async () => {
    const long = `${"d".repeat(120)}/file.csv`;
    const pax = Buffer.from(paxRecord("path", long));
    const archive = buildTar([
      { name: "./", type: "5", mode: 0o755 },
      { name: "./bin/", type: "5", mode: 0o7777 },
      { name: "./bin/tool", data: Buffer.from("#!/bin/sh\n"), mode: 0o4755 },
      { name: "PaxHeader", type: "x", data: pax },
      { name: "truncated-name", data: Buffer.from("long") },
    ]);
    expect(detectArchiveFormat(archive)).toBe("tar");
    const result = await extractArchive(archive, dest);
    expect(result.format).toBe("tar");
    expect(result.files.map((file) => file.path)).toEqual(["bin/tool", long]);
    expect((await stat(join(dest, "bin", "tool"))).mode & 0o7777).toBe(0o644);
    expect((await stat(join(dest, "bin"))).mode & 0o7777).toBe(0o755);
    expect(await readFile(join(dest, ...long.split("/")), "utf8")).toBe("long");
  });

  it.each([
    ["symlink", { name: "link", type: "2", linkname: "/etc/passwd" }],
    ["hardlink", { name: "hard", type: "1", linkname: "../outside" }],
    ["char device", { name: "dev", type: "3" }],
    ["fifo", { name: "fifo", type: "6" }],
    ["traversal", { name: "../../evil", data: Buffer.from("x") }],
  ] as const)("refuses a tar %s entry", async (_label, entry) => {
    expect(await failure(buildTar([{ name: "ok.txt", data: Buffer.from("ok") }, entry]))).toBe("archive_unsafe_path");
  });

  it("refuses a tar header with a bad checksum", async () => {
    const archive = buildTar([{ name: "a.txt", data: Buffer.from("abc") }]);
    archive[0] = 0x62;
    expect(await failure(archive)).toBe("archive_corrupt");
  });

  it("extracts tar.gz and single-file gzip", async () => {
    const tgz = gzipSync(buildTar([{ name: "x/y.csv", data: Buffer.from("1,2\n") }]));
    expect(detectArchiveFormat(tgz)).toBe("gzip");
    const result = await extractArchive(tgz, dest);
    expect(result.format).toBe("tar.gz");
    expect(result.files).toEqual([{ path: "x/y.csv", sha256: sha("1,2\n"), bytes: 4 }]);

    const single = await extractArchive(gzipSync(Buffer.from("plain")), join(workDir, "single"), {
      gzipMemberName: "table.csv",
    });
    expect(single.format).toBe("gzip");
    expect(single.files).toEqual([{ path: "table.csv", sha256: sha("plain"), bytes: 5 }]);
  });

  it("refuses a gzip bomb", async () => {
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));
    expect(await failure(bomb)).toBe("archive_ratio_exceeded");
    expect(await failure(gzipSync(Buffer.alloc(4096, 1)), { maxTotalBytes: 1024, maxFiles: 1, maxRatio: 1e9 })).toBe("archive_too_large");
  });

  it("honours cancellation before writing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractArchive(buildZip([{ name: "a", data: Buffer.from("1") }]), dest, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled", policy: "inconclusive" });
    expect(existsSync(dest)).toBe(false);
  });
});

describe("normalizeEntryPath", () => {
  const limits = { maxDepth: 4, maxPathLength: 64 };

  it("normalizes safe paths", () => {
    expect(normalizeEntryPath("a/b.csv", limits)).toBe("a/b.csv");
    expect(normalizeEntryPath("./a/b/", limits)).toBe("a/b");
    expect(normalizeEntryPath("./", limits)).toBe("");
  });

  it.each(["", "/a", "..", "a/..", "a/../b", "C:x", "c:\\x", "a\\b", "a//b", "a/./b", "a/b/c/d/e", "x".repeat(65), "a\nb"])(
    "refuses %j",
    (raw) => {
      expect(() => normalizeEntryPath(raw, limits)).toThrow(DatasetError);
    },
  );
});
