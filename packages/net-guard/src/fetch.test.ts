import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { acquireDataset, DEFAULT_DATASET_POLICY, parseAllowedHosts } from "./dataset.js";
import type { ResolvedAddress, Resolver } from "./dns.js";
import { NetGuardError, type NetGuardErrorCode } from "./errors.js";
import { type HttpsTransport, safeDownload, type SafeDownloadOptions } from "./fetch.js";
import { isPublicAddress } from "./ip.js";
import type { FetchPolicy } from "./url-policy.js";

/*
 * Tests run a real TLS server bound to 127.0.0.1 with a throwaway self-signed
 * certificate for *.example.test. A fake resolver maps test hostnames to
 * 127.0.0.1, the injected transport only adds that certificate as a trusted CA
 * (verification stays on), and `addressPolicy` widens "public" to 127.0.0.1
 * for these tests only. Separate cases prove the default policy refuses it.
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

const BODY = Buffer.from("sepal_length,sepal_width\n5.1,3.5\n4.9,3.0\n");
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");

describe.skipIf(!hasOpenssl())("safeDownload against a local TLS server", () => {
  let certDir: string;
  let cert: Buffer;
  let server: https.Server;
  let port: number;
  let handler: Handler;
  let hits: string[];
  let workDir: string;

  const loopbackAllowed = (ip: string): boolean => ip === "127.0.0.1" || ip === "127.0.0.2" || isPublicAddress(ip);
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
  const loopback = [{ address: "127.0.0.1", family: 4 as const }];
  const defaultResolver = resolverFrom({
    "data.example.test": loopback,
    "mirror.example.test": loopback,
    "evil.example.test": [{ address: "10.0.0.8", family: 4 }],
  });

  function policy(overrides: Partial<FetchPolicy> = {}): FetchPolicy {
    return {
      allowedHosts: ["*.example.test"],
      allowedPorts: [port],
      maxRedirects: 3,
      maxBytes: 1024,
      timeoutMs: 5_000,
      ...overrides,
    };
  }

  function url(path: string, host = "data.example.test"): string {
    return `https://${host}:${port}${path}`;
  }

  function options(overrides: Partial<SafeDownloadOptions> & { url: string }): SafeDownloadOptions {
    return {
      policy: policy(),
      destinationFile: join(workDir, "out.bin"),
      resolver: defaultResolver,
      transport: trustTestCa,
      addressPolicy: loopbackAllowed,
      ...overrides,
    };
  }

  async function failure(promise: Promise<unknown>): Promise<NetGuardErrorCode> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(NetGuardError);
      return (error as NetGuardError).code;
    }
    throw new Error("expected download to fail");
  }

  async function expectNoFiles(): Promise<void> {
    expect(await readdir(workDir)).toEqual([]);
  }

  beforeAll(async () => {
    certDir = await mkdtemp(join(tmpdir(), "net-guard-cert-"));
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
        "subjectAltName=DNS:data.example.test,DNS:*.example.test",
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
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(certDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    hits = [];
    handler = (_request, response) => {
      response.writeHead(404).end();
    };
    workDir = await mkdtemp(join(tmpdir(), "net-guard-work-"));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await rm(workDir, { recursive: true, force: true });
  });

  it("downloads and records sourceUrl, finalUrl, sha256, bytes, mimeType and the redirect chain", async () => {
    let userAgent: string | undefined;
    let cookie: string | undefined;
    let authorization: string | undefined;
    handler = (request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { Location: `https://mirror.example.test:${port}/files/iris.csv` }).end();
        return;
      }
      userAgent = request.headers["user-agent"];
      cookie = request.headers.cookie;
      authorization = request.headers.authorization;
      response.writeHead(200, { "Content-Type": "Text/CSV; charset=utf-8", "Content-Length": BODY.length }).end(BODY);
    };
    const destinationFile = join(workDir, "iris.csv");
    const receipt = await safeDownload(
      options({
        url: url("/start"),
        destinationFile,
        expectedSha256: BODY_SHA256.toUpperCase(),
        now: () => new Date("2026-09-30T12:00:00Z"),
      }),
    );
    expect(receipt).toEqual({
      sourceUrl: url("/start"),
      finalUrl: url("/files/iris.csv", "mirror.example.test"),
      redirects: [url("/files/iris.csv", "mirror.example.test")],
      resolvedAddress: "127.0.0.1",
      sha256: BODY_SHA256,
      bytes: BODY.length,
      mimeType: "text/csv",
      fetchedAt: "2026-09-30T12:00:00.000Z",
      expectedSha256: BODY_SHA256,
      checksumVerified: true,
    });
    expect(await readFile(destinationFile)).toEqual(BODY);
    expect((await stat(destinationFile)).mode & 0o777).toBe(0o600);
    expect(existsSync(`${destinationFile}.partial`)).toBe(false);
    expect(userAgent).toBe("DejaML-NetGuard/0.1");
    expect(cookie).toBeUndefined();
    expect(authorization).toBeUndefined();
  });

  it("rejects loopback targets under the default address policy", async () => {
    handler = (_request, response) => response.writeHead(200).end(BODY);
    const { addressPolicy: _ignored, ...rest } = options({ url: url("/data.csv") });
    expect(await failure(safeDownload(rest))).toBe("private_address");
    expect(hits).toEqual([]);
    await expectNoFiles();
  });

  it("keeps TLS verification on (untrusted certificate fails)", async () => {
    handler = (_request, response) => response.writeHead(200).end(BODY);
    expect(await failure(safeDownload(options({ url: url("/data.csv"), transport: https.request })))).toBe("tls_failed");
    await expectNoFiles();
  });

  it("rejects a host that is not on the allowlist before resolving it", async () => {
    let resolved = false;
    const resolver: Resolver = async () => {
      resolved = true;
      return loopback;
    };
    expect(
      await failure(safeDownload(options({ url: url("/x"), resolver, policy: policy({ allowedHosts: ["other.example.test"] }) }))),
    ).toBe("host_not_allowed");
    expect(resolved).toBe(false);
  });

  it("rejects a hostname whose resolver returns a private address", async () => {
    expect(await failure(safeDownload(options({ url: url("/x", "evil.example.test") })))).toBe("private_address");
    expect(hits).toEqual([]);
  });

  it("rejects a hostname that resolves to one public and one private address", async () => {
    const resolver = resolverFrom({
      "data.example.test": [
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.0.10", family: 4 },
      ],
    });
    expect(await failure(safeDownload(options({ url: url("/x"), resolver })))).toBe("private_address");
    expect(hits).toEqual([]);
  });

  it("re-resolves on every hop and rejects DNS rebinding to a private address", async () => {
    handler = (request, response) => {
      if (request.url === "/first") {
        response.writeHead(302, { Location: "/second" }).end();
        return;
      }
      response.writeHead(200).end(BODY);
    };
    let calls = 0;
    const rebinding: Resolver = async () => {
      calls += 1;
      return calls === 1 ? loopback : [{ address: "10.1.2.3", family: 4 }];
    };
    expect(await failure(safeDownload(options({ url: url("/first"), resolver: rebinding })))).toBe("private_address");
    expect(calls).toBe(2);
    expect(hits).toHaveLength(1);
    await expectNoFiles();
  });

  it("connects only to the pinned address even if the transport tries another", async () => {
    handler = (_request, response) => response.writeHead(200).end(BODY);
    const resolver = resolverFrom({ "data.example.test": [{ address: "127.0.0.2", family: 4 }] });
    const hijack: HttpsTransport = (requestOptions, callback) =>
      https.request(
        {
          ...requestOptions,
          ca: cert,
          lookup: (_host, lookupOptions, cb) => {
            if (lookupOptions.all === true) {
              process.nextTick(cb, null, [{ address: "127.0.0.1", family: 4 }]);
            } else {
              process.nextTick(cb, null, "127.0.0.1", 4);
            }
          },
        },
        callback,
      );
    expect(await failure(safeDownload(options({ url: url("/x"), resolver, transport: hijack })))).toBe("pinning_violation");
    await expectNoFiles();
  });

  it("rejects a redirect from an allowed host to https://127.0.0.1/", async () => {
    handler = (_request, response) => response.writeHead(302, { Location: "https://127.0.0.1/" }).end();
    expect(await failure(safeDownload(options({ url: url("/r") })))).toBe("ip_literal_not_allowed");
    expect(hits).toHaveLength(1);
  });

  it("rejects a redirect to https://169.254.169.254/", async () => {
    handler = (_request, response) => response.writeHead(301, { Location: "https://169.254.169.254/latest/meta-data/" }).end();
    expect(await failure(safeDownload(options({ url: url("/r") })))).toBe("ip_literal_not_allowed");
  });

  it("rejects a redirect to a private-resolving hostname", async () => {
    handler = (_request, response) => response.writeHead(307, { Location: `https://evil.example.test:${port}/steal` }).end();
    expect(await failure(safeDownload(options({ url: url("/r") })))).toBe("private_address");
    expect(hits).toHaveLength(1);
  });

  it("rejects a redirect to plain http", async () => {
    handler = (_request, response) => response.writeHead(302, { Location: `http://data.example.test:${port}/x` }).end();
    expect(await failure(safeDownload(options({ url: url("/r") })))).toBe("scheme_not_allowed");
  });

  it("rejects a redirect to a non-allowlisted host", async () => {
    handler = (_request, response) => response.writeHead(302, { Location: "https://example.org/x" }).end();
    expect(await failure(safeDownload(options({ url: url("/r") })))).toBe("host_not_allowed");
  });

  it("rejects too many redirects", async () => {
    handler = (request, response) => {
      const step = Number((request.url ?? "/0").slice(1));
      response.writeHead(302, { Location: `/${step + 1}` }).end();
    };
    expect(await failure(safeDownload(options({ url: url("/0"), policy: policy({ maxRedirects: 2 }) })))).toBe("too_many_redirects");
    expect(hits).toHaveLength(3);
    await expectNoFiles();
  });

  it("rejects a declared content-length over the limit before reading", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Length": 4096 });
      response.write(Buffer.alloc(16));
    };
    expect(await failure(safeDownload(options({ url: url("/big") })))).toBe("response_too_large");
    await expectNoFiles();
  });

  it("aborts a streamed body over the limit when content-length is omitted and removes the partial file", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      for (let index = 0; index < 8; index += 1) {
        response.write(Buffer.alloc(512, 1));
      }
      response.end();
    };
    const destinationFile = join(workDir, "stream.bin");
    expect(await failure(safeDownload(options({ url: url("/stream"), destinationFile })))).toBe("response_too_large");
    expect(existsSync(`${destinationFile}.partial`)).toBe(false);
    expect(existsSync(destinationFile)).toBe(false);
    await expectNoFiles();
  });

  it("rejects a checksum mismatch and removes the file", async () => {
    handler = (_request, response) => response.writeHead(200, { "Content-Length": BODY.length }).end(BODY);
    const destinationFile = join(workDir, "data.csv");
    expect(await failure(safeDownload(options({ url: url("/data.csv"), destinationFile, expectedSha256: "0".repeat(64) })))).toBe(
      "checksum_mismatch",
    );
    expect(existsSync(destinationFile)).toBe(false);
    await expectNoFiles();
  });

  it("times out a stalled response and removes the partial file", async () => {
    handler = (_request, response) => {
      response.writeHead(200);
      response.write(Buffer.alloc(8));
    };
    expect(await failure(safeDownload(options({ url: url("/slow"), policy: policy({ timeoutMs: 300 }) })))).toBe("timeout");
    await expectNoFiles();
  });

  it("enforces the socket idle timeout", async () => {
    handler = () => undefined;
    expect(await failure(safeDownload(options({ url: url("/idle"), policy: policy({ timeoutMs: 5_000, idleTimeoutMs: 200 }) })))).toBe(
      "timeout",
    );
  });

  it("cancels via AbortSignal and removes the partial file", async () => {
    handler = (_request, response) => {
      response.writeHead(200);
      response.write(Buffer.alloc(8));
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    expect(await failure(safeDownload(options({ url: url("/hang"), signal: controller.signal })))).toBe("cancelled");
    await expectNoFiles();
  });

  it("maps non-2xx responses to http_error", async () => {
    handler = (_request, response) => response.writeHead(500).end("boom");
    expect(await failure(safeDownload(options({ url: url("/err") })))).toBe("http_error");
    await expectNoFiles();
  });

  it("refuses to overwrite an existing destination", async () => {
    handler = (_request, response) => response.writeHead(200).end(BODY);
    const first = await safeDownload(options({ url: url("/a") }));
    expect(first.bytes).toBe(BODY.length);
    expect(await failure(safeDownload(options({ url: url("/a") })))).toBe("destination_exists");
  });

  describe("acquireDataset", () => {
    it("derives the file name from the final URL and creates the directory 0o700", async () => {
      handler = (request, response) => {
        if (request.url === "/latest") {
          response.writeHead(302, { Location: "/files/iris-v2.csv?download=1" }).end();
          return;
        }
        response.writeHead(200, { "Content-Type": "text/csv" }).end(BODY);
      };
      const destinationDir = join(workDir, "datasets", "run-1");
      const receipt = await acquireDataset({
        url: url("/latest"),
        policy: policy(),
        destinationDir,
        expectedSha256: BODY_SHA256,
        resolver: defaultResolver,
        transport: trustTestCa,
        addressPolicy: loopbackAllowed,
      });
      expect(receipt.fileName).toBe("iris-v2.csv");
      expect(receipt.path).toBe(join(destinationDir, "iris-v2.csv"));
      expect(await readFile(receipt.path)).toEqual(BODY);
      expect((await stat(destinationDir)).mode & 0o777).toBe(0o700);
      expect(await readdir(destinationDir)).toEqual(["iris-v2.csv"]);
    });

    it("rejects an unsafe derived file name and leaves nothing behind", async () => {
      handler = (_request, response) => response.writeHead(200).end(BODY);
      const destinationDir = join(workDir, "d");
      expect(
        await failure(
          acquireDataset({
            url: url("/files/.bashrc"),
            policy: policy(),
            destinationDir,
            resolver: defaultResolver,
            transport: trustTestCa,
            addressPolicy: loopbackAllowed,
          }),
        ),
      ).toBe("unsafe_file_name");
      expect(await readdir(destinationDir)).toEqual([]);
    });

    it("rejects unsafe explicit file names before any request", async () => {
      for (const fileName of ["../x", ".hidden", "a/b", "", "x".repeat(129)]) {
        expect(await failure(acquireDataset({ url: url("/x"), policy: policy(), destinationDir: join(workDir, "d"), fileName }))).toBe(
          "unsafe_file_name",
        );
      }
      expect(hits).toEqual([]);
    });
  });
});

describe("dataset policy defaults", () => {
  it("allows nothing until hosts are configured", async () => {
    expect(DEFAULT_DATASET_POLICY.allowedHosts).toEqual([]);
    expect(DEFAULT_DATASET_POLICY.maxRedirects).toBe(3);
    expect(DEFAULT_DATASET_POLICY.maxBytes).toBe(200 * 1024 * 1024);
    expect(DEFAULT_DATASET_POLICY.timeoutMs).toBe(120_000);
    await expect(
      safeDownload({ url: "https://archive.ics.uci.edu/x.zip", policy: DEFAULT_DATASET_POLICY, destinationFile: "/nonexistent/x" }),
    ).rejects.toMatchObject({ code: "host_not_allowed" });
  });

  it("parses an administrator allowlist", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts(" Archive.ICS.uci.edu, *.zenodo.org ,raw.githubusercontent.com,,")).toEqual([
      "archive.ics.uci.edu",
      "*.zenodo.org",
      "raw.githubusercontent.com",
    ]);
  });

  it.each([
    "127.0.0.1",
    "[::1]",
    "::1",
    "0x7f000001",
    "*",
    "*.com",
    "foo.*.org",
    "a*.zenodo.org",
    "localhost",
    "metadata.google.internal",
    "zenodo.org:443",
    "zenodo.org/path",
    "https://zenodo.org",
  ])("rejects allowlist entry %j", (entry) => {
    expect(() => parseAllowedHosts(`zenodo.org,${entry}`)).toThrow(NetGuardError);
  });
});
