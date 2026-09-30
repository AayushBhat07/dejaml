import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { acquireLabDataset, cleanupDataset, type LabDatasetOptions } from "./dataset.js";
import { DatasetError, datasetFailurePolicy, type DatasetFailurePolicy } from "./dataset-errors.js";
import type { ResolvedAddress, Resolver } from "./dns.js";
import type { HttpsTransport } from "./fetch.js";
import { isPublicAddress } from "./ip.js";
import { buildTar, buildZip } from "./test-archives.js";
import type { FetchPolicy } from "./url-policy.js";

/*
 * Same harness as fetch.test.ts: a real TLS server on 127.0.0.1 with a
 * throwaway certificate for *.example.test, a fake resolver, a transport that
 * only adds that certificate as a trusted CA, and an address policy widened to
 * 127.0.0.1 for these tests only.
 */

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const sha = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const CSV = Buffer.from("x,y\n1,2\n3,4\n");
const ZIP = buildZip([
  { name: "iris/", method: 0 },
  { name: "iris/train.csv", data: CSV },
  { name: "iris/LICENSE", data: Buffer.from("CC-BY"), method: 0 },
]);
const LAB_UID_OTHER_READ = 0o004;

describe.skipIf(!hasOpenssl())("acquireLabDataset against a local TLS server", () => {
  let certDir: string;
  let cert: Buffer;
  let server: https.Server;
  let port: number;
  let stall: TcpServer;
  let stallPort: number;
  const stalledSockets = new Set<Socket>();
  let handler: Handler;
  let hits: string[];
  let workDir: string;
  let parentDir: string;

  const loopbackAllowed = (ip: string): boolean => ip === "127.0.0.1" || isPublicAddress(ip);
  const trustTestCa: HttpsTransport = (options, callback) => https.request({ ...options, ca: cert }, callback);

  function resolverFrom(table: Record<string, ResolvedAddress[]>): Resolver {
    return async (hostname) => {
      const answers = table[hostname];
      if (answers === undefined) {
        throw new Error(`ENOTFOUND ${hostname}`);
      }
      return answers;
    };
  }
  const loopback: ResolvedAddress[] = [{ address: "127.0.0.1", family: 4 }];
  const resolver = resolverFrom({
    "data.example.test": loopback,
    "mirror.example.test": loopback,
    "stall.example.test": loopback,
  });

  function policy(overrides: Partial<FetchPolicy> = {}): FetchPolicy {
    return {
      allowedHosts: ["data.example.test", "*.mirrors.example.test", "mirror.example.test", "stall.example.test"],
      allowedPorts: [port, stallPort],
      maxRedirects: 3,
      maxBytes: 64 * 1024,
      timeoutMs: 5_000,
      ...overrides,
    };
  }

  function url(path: string, host = "data.example.test", onPort = port): string {
    return `https://${host}:${onPort}${path}`;
  }

  function options(overrides: Partial<LabDatasetOptions> & { url: string }): LabDatasetOptions {
    return {
      name: "iris",
      policy: policy(),
      destinationDir: join(parentDir, "ds-1"),
      resolver,
      transport: trustTestCa,
      addressPolicy: loopbackAllowed,
      now: () => new Date("2026-09-30T12:00:00Z"),
      ...overrides,
    };
  }

  async function failure(overrides: Partial<LabDatasetOptions> & { url: string }): Promise<[string, DatasetFailurePolicy]> {
    const resolved = options(overrides);
    try {
      await acquireLabDataset(resolved);
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetError);
      // Nothing is ever left behind, so nothing can be substituted.
      expect(existsSync(resolved.destinationDir)).toBe(false);
      const { code, policy: verdict } = error as DatasetError;
      return [code, verdict];
    }
    throw new Error("expected acquisition to fail");
  }

  beforeAll(async () => {
    certDir = await mkdtemp(join(tmpdir(), "net-guard-ds-cert-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=data.example.test",
        "-addext",
        "subjectAltName=DNS:data.example.test,DNS:*.example.test,DNS:*.mirrors.example.test",
        "-keyout",
        join(certDir, "key.pem"),
        "-out",
        join(certDir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    cert = await readFile(join(certDir, "cert.pem"));
    const key = await readFile(join(certDir, "key.pem"));
    server = https.createServer({ key, cert }, (request, response) => {
      hits.push(`${request.headers.host ?? ""}${request.url ?? ""}`);
      handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    // Accepts TCP but never speaks TLS: exercises the connect/handshake timeout.
    stall = createTcpServer((socket) => {
      stalledSockets.add(socket);
      socket.on("close", () => stalledSockets.delete(socket));
    });
    await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", resolve));
    stallPort = (stall.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of stalledSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => stall.close(() => resolve()));
    await rm(certDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    hits = [];
    handler = (_request, response) => {
      response.writeHead(404).end();
    };
    workDir = await mkdtemp(join(tmpdir(), "net-guard-ds-"));
    parentDir = join(workDir, "datasets");
    await mkdir(parentDir, { mode: 0o711 });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await rm(workDir, { recursive: true, force: true });
  });

  it("downloads, verifies, extracts and seals a zip; records an immutable identity; cleans up", async () => {
    handler = (request, response) => {
      if (request.url === "/latest") {
        response.writeHead(302, { Location: `https://mirror.example.test:${port}/v2/iris.zip` }).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": ZIP.length }).end(ZIP);
    };
    const dataset = await acquireLabDataset(options({ url: url("/latest"), expectedSha256: sha(ZIP), extract: true }));
    const listing = "dejaml-dataset-listing-v1\n" + `${sha("CC-BY")} 5 iris/LICENSE\n` + `${sha(CSV)} ${CSV.length} iris/train.csv\n`;
    expect(dataset.identity).toEqual({
      name: "iris",
      requestedUrl: url("/latest"),
      finalUrl: url("/v2/iris.zip", "mirror.example.test"),
      redirects: [url("/v2/iris.zip", "mirror.example.test")],
      host: "mirror.example.test",
      resolvedAddress: "127.0.0.1",
      fileName: "iris.zip",
      sha256: sha(ZIP),
      expectedSha256: sha(ZIP),
      bytes: ZIP.length,
      contentType: "application/zip",
      fetchedAt: "2026-09-30T12:00:00.000Z",
      checksumVerified: true,
      extracted: {
        format: "zip",
        files: [
          { path: "iris/LICENSE", sha256: sha("CC-BY"), bytes: 5 },
          { path: "iris/train.csv", sha256: sha(CSV), bytes: CSV.length },
        ],
        totalBytes: 5 + CSV.length,
        fileCount: 2,
        listingDigest: sha(listing),
      },
    });
    expect(Object.isFrozen(dataset.identity)).toBe(true);
    expect(Object.isFrozen(dataset.identity.extracted?.files[0])).toBe(true);
    expect(() => {
      (dataset.identity as { sha256: string }).sha256 = "0";
    }).toThrow(TypeError);

    const root = dataset.root;
    expect(dataset.downloadPath).toBe("download/iris.zip");
    expect(dataset.extractedPath).toBe("extracted");
    expect(await readdir(root)).toEqual(["download", "extracted"]);
    expect(await readFile(join(root, "extracted", "iris", "train.csv"))).toEqual(CSV);
    for (const path of [join(root, "download", "iris.zip"), join(root, "extracted", "iris", "train.csv")]) {
      const mode = (await stat(path)).mode & 0o7777;
      expect(mode).toBe(0o444);
      expect(mode & LAB_UID_OTHER_READ).toBeTruthy();
    }
    for (const path of [root, join(root, "download"), join(root, "extracted"), join(root, "extracted", "iris")]) {
      expect((await stat(path)).mode & 0o7777).toBe(0o555);
    }

    const receipt = await cleanupDataset(dataset);
    expect(receipt).toEqual({ path: root, removed: true, verifiedAbsent: true, errors: [] });
    expect(existsSync(root)).toBe(false);
    expect(await cleanupDataset(root)).toEqual({ path: root, removed: false, verifiedAbsent: true, errors: [] });
  });

  it("marks a dataset without an expected checksum as not verified and never invents one", async () => {
    handler = (_request, response) => response.writeHead(200, { "Content-Type": "text/csv" }).end(CSV);
    const dataset = await acquireLabDataset(options({ url: url("/iris.csv") }));
    expect(dataset.identity.checksumVerified).toBe(false);
    expect(dataset.identity.expectedSha256).toBeNull();
    expect(dataset.identity.sha256).toBe(sha(CSV));
    expect(dataset.identity.extracted).toBeNull();
    expect(dataset.extractedPath).toBeNull();
  });

  it("refuses when a checksum is required but missing, before any request", async () => {
    handler = (_request, response) => response.writeHead(200).end(CSV);
    expect(await failure({ url: url("/iris.csv"), requireChecksum: true })).toEqual(["checksum_required", "policy_blocked"]);
    expect(hits).toEqual([]);
  });

  it("maps a changed dataset (checksum mismatch) to inconclusive and removes the file", async () => {
    handler = (_request, response) => response.writeHead(200, { "Content-Length": CSV.length }).end(CSV);
    expect(await failure({ url: url("/iris.csv"), expectedSha256: "a".repeat(64), requireChecksum: true })).toEqual([
      "checksum_mismatch",
      "inconclusive",
    ]);
    expect(hits).toHaveLength(1);
  });

  it("maps an unavailable dataset (HTTP 404) to inconclusive", async () => {
    expect(await failure({ url: url("/missing.csv") })).toEqual(["http_error", "inconclusive"]);
  });

  it.each([
    ["IPv4 RFC 1918", [{ address: "10.0.0.8", family: 4 }]],
    ["IPv4 metadata", [{ address: "169.254.169.254", family: 4 }]],
    ["IPv4 unspecified", [{ address: "0.0.0.0", family: 4 }]],
    ["IPv6 loopback", [{ address: "::1", family: 6 }]],
    ["IPv6 ULA", [{ address: "fd00::1", family: 6 }]],
    ["IPv6 link-local", [{ address: "fe80::1", family: 6 }]],
    ["IPv6 multicast", [{ address: "ff02::1", family: 6 }]],
    ["IPv4-mapped IPv6", [{ address: "::ffff:127.0.0.1", family: 6 }]],
  ] as const)("refuses a host resolving to %s", async (_label, answers) => {
    const privateResolver = resolverFrom({ "data.example.test": [...answers] });
    expect(await failure({ url: url("/x.csv"), resolver: privateResolver })).toEqual(["private_address", "policy_blocked"]);
    expect(hits).toEqual([]);
  });

  it("refuses loopback under the production address policy", async () => {
    const { addressPolicy: _dropped, ...rest } = options({ url: url("/x.csv") });
    try {
      await acquireLabDataset(rest);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "private_address", policy: "policy_blocked" });
    }
    expect(hits).toEqual([]);
  });

  it.each([
    ["https://[::1]/x.csv", "ip_literal_not_allowed"],
    ["https://[::ffff:10.0.0.1]/x.csv", "ip_literal_not_allowed"],
    ["https://127.0.0.1/x.csv", "ip_literal_not_allowed"],
    ["https://metadata.google.internal/x.csv", "unsafe_hostname"],
    ["https://files.localhost/x.csv", "unsafe_hostname"],
    ["http://data.example.test/x.csv", "scheme_not_allowed"],
    ["https://other.example.org/x.csv", "host_not_allowed"],
  ])("refuses %s as %s", async (target, code) => {
    expect(await failure({ url: target })).toEqual([code, "policy_blocked"]);
    expect(hits).toEqual([]);
  });

  it("refuses DNS rebinding between hops", async () => {
    handler = (_request, response) => response.writeHead(302, { Location: "/second.csv" }).end();
    let calls = 0;
    const rebinding: Resolver = async () => {
      calls += 1;
      return calls === 1 ? loopback : [{ address: "192.168.1.5", family: 4 }];
    };
    expect(await failure({ url: url("/first.csv"), resolver: rebinding })).toEqual(["private_address", "policy_blocked"]);
    expect(calls).toBe(2);
    expect(hits).toHaveLength(1);
  });

  it("revalidates every redirect hop against the allowlist and the IP policy", async () => {
    handler = (_request, response) => response.writeHead(302, { Location: "https://evil.example.org/x.csv" }).end();
    expect(await failure({ url: url("/r") })).toEqual(["host_not_allowed", "policy_blocked"]);
    handler = (_request, response) => response.writeHead(302, { Location: "https://169.254.169.254/latest/" }).end();
    expect(await failure({ url: url("/r") })).toEqual(["ip_literal_not_allowed", "policy_blocked"]);
    handler = (_request, response) => response.writeHead(302, { Location: "https://[fd00::1]/x" }).end();
    expect(await failure({ url: url("/r") })).toEqual(["ip_literal_not_allowed", "policy_blocked"]);
    handler = (request, response) => response.writeHead(302, { Location: `${request.url ?? "/"}x` }).end();
    expect(await failure({ url: url("/r"), policy: policy({ maxRedirects: 2 }) })).toEqual(["too_many_redirects", "policy_blocked"]);
  });

  it("refuses an oversized declared Content-Length before reading the body", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Length": 1024 * 1024 });
      response.write(Buffer.alloc(16));
    };
    expect(await failure({ url: url("/big.bin") })).toEqual(["response_too_large", "policy_blocked"]);
  });

  it("aborts an oversized streamed body without Content-Length", async () => {
    handler = (_request, response) => {
      response.writeHead(200);
      for (let index = 0; index < 20; index += 1) {
        response.write(Buffer.alloc(4096, 1));
      }
      response.end();
    };
    expect(await failure({ url: url("/stream.bin"), policy: policy({ maxBytes: 16 * 1024 }) })).toEqual([
      "response_too_large",
      "policy_blocked",
    ]);
  });

  it("enforces the connect/handshake timeout", async () => {
    const started = Date.now();
    expect(
      await failure({
        url: url("/x.csv", "stall.example.test", stallPort),
        policy: policy({ timeoutMs: 5_000, idleTimeoutMs: 200 }),
      }),
    ).toEqual(["timeout", "inconclusive"]);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("enforces the total timeout on a stalled body", async () => {
    handler = (_request, response) => {
      response.writeHead(200);
      response.write(Buffer.alloc(8));
      const keepAlive = setInterval(() => response.write(Buffer.alloc(1)), 50);
      response.on("close", () => clearInterval(keepAlive));
    };
    expect(await failure({ url: url("/slow.csv"), policy: policy({ timeoutMs: 400 }) })).toEqual(["timeout", "inconclusive"]);
  });

  it("cancels via AbortSignal", async () => {
    handler = (_request, response) => {
      response.writeHead(200);
      response.write(Buffer.alloc(8));
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    expect(await failure({ url: url("/hang.csv"), signal: controller.signal })).toEqual(["cancelled", "inconclusive"]);
  });

  it("refuses a zip-slip archive and leaves nothing behind", async () => {
    const evil = buildZip([{ name: "../../escape.txt", data: Buffer.from("pwned") }]);
    handler = (_request, response) => response.writeHead(200).end(evil);
    expect(await failure({ url: url("/evil.zip"), expectedSha256: sha(evil), extract: true })).toEqual([
      "archive_unsafe_path",
      "policy_blocked",
    ]);
    expect(existsSync(join(parentDir, "escape.txt"))).toBe(false);
    expect(existsSync(join(workDir, "escape.txt"))).toBe(false);
  });

  it("refuses a tar symlink entry", async () => {
    const evil = buildTar([{ name: "passwd", type: "2", linkname: "/etc/passwd" }]);
    handler = (_request, response) => response.writeHead(200).end(evil);
    expect(await failure({ url: url("/evil.tar"), extract: true })).toEqual(["archive_unsafe_path", "policy_blocked"]);
  });

  it("refuses a zip bomb", async () => {
    const bomb = buildZip([{ name: "zeros.bin", data: Buffer.alloc(4 * 1024 * 1024) }]);
    handler = (_request, response) => response.writeHead(200).end(bomb);
    expect(await failure({ url: url("/bomb.zip"), extract: true })).toEqual(["archive_ratio_exceeded", "policy_blocked"]);
  });

  it("refuses an archive with too many files", async () => {
    const many = buildZip(Array.from({ length: 12 }, (_, index) => ({ name: `f${index}`, data: Buffer.from("1") })));
    handler = (_request, response) => response.writeHead(200).end(many);
    expect(await failure({ url: url("/many.zip"), extract: true, archiveLimits: { maxFiles: 10 } })).toEqual([
      "archive_too_many_files",
      "policy_blocked",
    ]);
  });

  it("refuses extraction of a non-archive", async () => {
    handler = (_request, response) => response.writeHead(200).end(CSV);
    expect(await failure({ url: url("/iris.csv"), extract: true })).toEqual(["archive_unsupported", "policy_blocked"]);
  });

  it("refuses an existing destination directory without touching it", async () => {
    const destinationDir = join(parentDir, "taken");
    await mkdir(destinationDir);
    await expect(acquireLabDataset(options({ url: url("/x.csv"), destinationDir }))).rejects.toMatchObject({
      code: "destination_exists",
    });
    expect(existsSync(destinationDir)).toBe(true);
    expect(hits).toEqual([]);
  });

  it("refuses unsafe names and paths before any request", async () => {
    for (const bad of [
      { fileName: "../x" },
      { destinationDir: "relative/dir" },
      { destinationDir: `${parentDir}/a/../b` },
      { name: "" },
      { name: "bad\nname" },
    ]) {
      await expect(acquireLabDataset(options({ url: url("/x.csv"), ...bad }))).rejects.toMatchObject({
        policy: "policy_blocked",
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("cleanupDataset", () => {
  it("refuses relative, non-normalized and root paths", async () => {
    for (const path of ["", "relative", "/tmp/../tmp/x", "/"]) {
      const receipt = await cleanupDataset(path);
      expect(receipt.removed).toBe(false);
      expect(receipt.verifiedAbsent).toBe(false);
      expect(receipt.errors).toHaveLength(1);
    }
  });
});

describe("datasetFailurePolicy", () => {
  it.each([
    ["host_not_allowed", "policy_blocked"],
    ["private_address", "policy_blocked"],
    ["response_too_large", "policy_blocked"],
    ["checksum_required", "policy_blocked"],
    ["archive_unsafe_path", "policy_blocked"],
    ["archive_corrupt", "policy_blocked"],
    ["http_error", "inconclusive"],
    ["dns_failed", "inconclusive"],
    ["timeout", "inconclusive"],
    ["request_failed", "inconclusive"],
    ["checksum_mismatch", "inconclusive"],
  ] as const)("%s is %s", (code, verdict) => {
    expect(datasetFailurePolicy(code)).toBe(verdict);
    expect(new DatasetError(code).policy).toBe(verdict);
  });
});
