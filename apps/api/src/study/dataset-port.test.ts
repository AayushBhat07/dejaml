import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloads = vi.hoisted(() => ({ count: 0, body: "a,b\n1,2\n", contentType: "text/csv" as string | null }));

vi.mock("@dejaml/net-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dejaml/net-guard")>();
  return {
    ...actual,
    // Stands in for the network: writes a fixed file where the real fetch would.
    acquireLabDataset: vi.fn(async (options: { name: string; url: string; destinationDir: string; expectedSha256?: string }) => {
      downloads.count += 1;
      await mkdir(join(options.destinationDir, "download"), { recursive: true });
      await writeFile(join(options.destinationDir, "download", "data.csv"), downloads.body);
      return {
        identity: {
          name: options.name,
          requestedUrl: options.url,
          finalUrl: options.url,
          sha256: "ab".repeat(32),
          expectedSha256: options.expectedSha256 ?? null,
          bytes: Buffer.byteLength(downloads.body),
          contentType: downloads.contentType,
          checksumVerified: options.expectedSha256 !== undefined,
          extracted: null,
          fetchedAt: "2026-10-15T00:00:00.000Z",
        },
        root: options.destinationDir,
        filePath: join(options.destinationDir, "download", "data.csv"),
        downloadPath: "download/data.csv",
        extractedPath: null,
      };
    }),
  };
});

const { DEFAULT_DATASET_POLICY } = await import("@dejaml/net-guard");
const { localDatasetPort } = await import("./ports.js");

describe("local dataset port", () => {
  let work: string;
  const signal = new AbortController().signal;
  const url = "https://archive.ics.uci.edu/data.csv";

  beforeEach(async () => {
    downloads.count = 0;
    downloads.body = "a,b\n1,2\n";
    downloads.contentType = "text/csv";
    work = await mkdtemp(join(tmpdir(), "dataset-port-"));
  });
  afterEach(async () => {
    // The port seals a reused dataset's root read-only; reopen it so cleanup works without root.
    await chmod(join(work, "d0"), 0o755).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  });

  it("reuses the probed download when the plan names the same URL and hash", async () => {
    const port = localDatasetPort(DEFAULT_DATASET_POLICY);
    const probe = await port.probe({ url, extract: false, destinationDir: join(work, "probe"), signal });
    const acquired = await port.acquire({
      runId: "run_1",
      name: "wine",
      url,
      sha256: probe.sha256.toUpperCase(),
      extract: false,
      destinationDir: join(work, "d0"),
      signal,
    });
    expect(downloads.count).toBe(1);
    expect(existsSync(join(work, "probe"))).toBe(false);
    expect(acquired.root).toBe(join(work, "d0"));
    expect(acquired.identity).toMatchObject({ name: "wine", checksumVerified: true });
    expect(await readFile(join(work, "d0", "download", "data.csv"), "utf8")).toBe("a,b\n1,2\n");
  });

  it.each([
    ["a short error message", "404: Not Found", "text/plain"],
    ["a web page", "<!DOCTYPE html><html><body>Moved</body></html>", null],
    ["an HTML response", "x".repeat(5000), "text/html; charset=utf-8"],
  ])("refuses %s instead of reporting its hash", async (_label, body, contentType) => {
    downloads.body = body;
    downloads.contentType = contentType;
    const port = localDatasetPort(DEFAULT_DATASET_POLICY);
    await expect(port.probe({ url, extract: false, destinationDir: join(work, "probe"), signal })).rejects.toMatchObject({
      code: "dataset_error_page",
    });
    expect(existsSync(join(work, "probe"))).toBe(false);
  });

  it("downloads again when the hash differs, and keeps at most two probes", async () => {
    const port = localDatasetPort(DEFAULT_DATASET_POLICY);
    for (const name of ["p1", "p2", "p3"]) {
      await port.probe({ url, extract: false, destinationDir: join(work, name), signal });
    }
    expect([existsSync(join(work, "p1")), existsSync(join(work, "p2")), existsSync(join(work, "p3"))]).toEqual([false, true, true]);
    await port.acquire({
      runId: "run_1",
      name: "wine",
      url,
      sha256: "cd".repeat(32),
      extract: false,
      destinationDir: join(work, "d0"),
      signal,
    });
    expect(downloads.count).toBe(4);
  });
});
