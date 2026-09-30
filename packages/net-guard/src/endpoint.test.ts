import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedAddress, Resolver } from "./dns.js";
import {
  createGuardedFetch,
  type EndpointAccess,
  endpointAddressAllowed,
  type EndpointPolicy,
  type EndpointTransport,
  validateEndpointUrl,
} from "./endpoint.js";
import { NetGuardError, type NetGuardErrorCode } from "./errors.js";

function code(fn: () => unknown): NetGuardErrorCode | "ok" {
  try {
    fn();
    return "ok";
  } catch (error) {
    expect(error).toBeInstanceOf(NetGuardError);
    return (error as NetGuardError).code;
  }
}

async function failure(promise: Promise<unknown>): Promise<NetGuardErrorCode> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NetGuardError);
    return (error as NetGuardError).code;
  }
  throw new Error("expected the request to fail");
}

function resolverFrom(table: Record<string, ResolvedAddress[]>): Resolver {
  return async (hostname) => {
    const answers = table[hostname];
    if (answers === undefined) throw new Error(`ENOTFOUND ${hostname}`);
    return answers;
  };
}

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

describe("validateEndpointUrl (public access, the production policy)", () => {
  const pub = { access: "public" as const };

  it("accepts public https endpoints and normalizes them", () => {
    expect(validateEndpointUrl("https://API.Example.com./v1#frag", pub).href).toBe("https://api.example.com/v1");
    expect(validateEndpointUrl("https://llm.example.com:8443/v1", pub).port).toBe("8443");
    expect(code(() => validateEndpointUrl("https://8.8.8.8/v1", pub))).toBe("ok");
    expect(code(() => validateEndpointUrl("https://[2606:4700:4700::1111]/v1", pub))).toBe("ok");
  });

  it("requires https, even when allowHttp is set", () => {
    expect(code(() => validateEndpointUrl("http://api.example.com/v1", pub))).toBe("scheme_not_allowed");
    expect(code(() => validateEndpointUrl("http://api.example.com/v1", { access: "public", allowHttp: true }))).toBe("scheme_not_allowed");
    expect(code(() => validateEndpointUrl("ftp://api.example.com/", pub))).toBe("scheme_not_allowed");
    expect(code(() => validateEndpointUrl("https:api.example.com/v1", pub))).toBe("invalid_url");
  });

  it.each([
    ["IPv4 loopback", "https://127.0.0.1/v1"],
    ["IPv4 loopback (other)", "https://127.8.9.10/v1"],
    ["RFC 1918 10/8", "https://10.0.0.5/v1"],
    ["RFC 1918 172.16/12", "https://172.16.3.4/v1"],
    ["RFC 1918 192.168/16", "https://192.168.1.1/v1"],
    ["CGNAT 100.64/10", "https://100.64.0.1/v1"],
    ["link-local", "https://169.254.10.10/v1"],
    ["metadata IPv4", "https://169.254.169.254/latest/meta-data"],
    ["multicast IPv4", "https://224.0.0.1/"],
    ["unspecified IPv4", "https://0.0.0.0/"],
    ["broadcast", "https://255.255.255.255/"],
    ["IPv6 loopback", "https://[::1]/v1"],
    ["IPv6 unspecified", "https://[::]/v1"],
    ["IPv6 link-local", "https://[fe80::1]/v1"],
    ["IPv6 ULA fc00::/7", "https://[fc00::1]/v1"],
    ["IPv6 ULA fd", "https://[fd12:3456::1]/v1"],
    ["IPv6 metadata", "https://[fd00:ec2::254]/"],
    ["IPv6 multicast", "https://[ff02::1]/"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/v1"],
    ["IPv4-mapped private", "https://[::ffff:10.0.0.1]/v1"],
    ["IPv4-mapped metadata", "https://[::ffff:169.254.169.254]/"],
    ["IPv4-mapped hex form", "https://[::ffff:a9fe:a9fe]/"],
    ["NAT64 of loopback", "https://[64:ff9b::7f00:1]/"],
  ])("refuses %s", (_name, url) => {
    expect(code(() => validateEndpointUrl(url, pub))).toBe("private_address");
  });

  it.each([
    "https://localhost/v1",
    "https://app.localhost/v1",
    "https://metadata.google.internal/computeMetadata/v1",
    "https://gpu.internal/v1",
    "https://printer.local/v1",
    "https://intranet/v1",
    "https://router.home.arpa/",
    "https://api.svc/",
  ])("refuses the internal name %s", (url) => {
    expect(code(() => validateEndpointUrl(url, pub))).toBe("unsafe_hostname");
  });

  it("refuses non-canonical IPv4 forms, credentials and unix sockets", () => {
    for (const url of ["https://0x7f.1/", "https://2130706433/", "https://0177.0.0.1/", "https://127.1/", "https://0xa9fea9fe/"]) {
      expect(code(() => validateEndpointUrl(url, pub))).toBe("ip_literal_not_allowed");
    }
    expect(code(() => validateEndpointUrl("https://user:pw@api.example.com/", pub))).toBe("credentials_in_url");
    expect(code(() => validateEndpointUrl("http+unix://%2Fvar%2Frun%2Fx.sock/", pub))).toBe("unix_socket");
    expect(code(() => validateEndpointUrl("https://api.example.com/\\evil", pub))).toBe("invalid_url");
  });
});

describe("validateEndpointUrl (development access levels)", () => {
  it("loopback access allows localhost and loopback literals, and http only with allowHttp", () => {
    const loop = { access: "loopback" as const, allowHttp: true };
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8080/v1", "https://[::ffff:127.0.0.1]/"]) {
      expect(code(() => validateEndpointUrl(url, loop))).toBe("ok");
    }
    expect(code(() => validateEndpointUrl("http://localhost/v1", { access: "loopback" }))).toBe("scheme_not_allowed");
    expect(code(() => validateEndpointUrl("http://10.0.0.5/v1", loop))).toBe("private_address");
    expect(code(() => validateEndpointUrl("http://gpu.internal/v1", loop))).toBe("unsafe_hostname");
  });

  it("private access allows internal networks but never metadata, multicast or unspecified", () => {
    const priv = { access: "private" as const };
    for (const url of [
      "https://ollama:8443/v1",
      "https://gpu.internal/v1",
      "https://box.local/v1",
      "https://10.0.0.5/v1",
      "https://100.64.1.1/v1",
      "https://[fd12::1]/v1",
      "https://[fe80::1]/v1",
      "https://[::ffff:192.168.0.2]/v1",
    ]) {
      expect(code(() => validateEndpointUrl(url, priv))).toBe("ok");
    }
    for (const url of [
      "https://169.254.169.254/",
      "https://[fd00:ec2::254]/",
      "https://[::ffff:169.254.169.254]/",
      "https://224.0.0.1/",
      "https://0.0.0.0/",
      "https://[::]/",
    ]) {
      expect(code(() => validateEndpointUrl(url, priv))).toBe("private_address");
    }
    expect(code(() => validateEndpointUrl("https://metadata.google.internal/", priv))).toBe("unsafe_hostname");
    expect(code(() => validateEndpointUrl("https://metadata/", priv))).toBe("unsafe_hostname");
  });

  it("classifies resolved addresses by access level", () => {
    const table: Array<[string, Record<EndpointAccess, boolean>]> = [
      ["93.184.216.34", { public: true, loopback: true, private: true }],
      ["2606:4700:4700::1111", { public: true, loopback: true, private: true }],
      ["127.0.0.1", { public: false, loopback: true, private: true }],
      ["::1", { public: false, loopback: true, private: true }],
      ["::ffff:127.0.0.1", { public: false, loopback: true, private: true }],
      ["10.1.2.3", { public: false, loopback: false, private: true }],
      ["fd12::5", { public: false, loopback: false, private: true }],
      ["169.254.169.254", { public: false, loopback: false, private: false }],
      ["fd00:ec2::254", { public: false, loopback: false, private: false }],
      ["::ffff:169.254.169.254", { public: false, loopback: false, private: false }],
      ["::ffff:8.8.8.8", { public: false, loopback: false, private: false }],
      ["0.0.0.0", { public: false, loopback: false, private: false }],
      ["ff02::1", { public: false, loopback: false, private: false }],
      ["fe80::1%eth0", { public: false, loopback: false, private: false }],
    ];
    for (const [ip, expected] of table) {
      for (const access of ["public", "loopback", "private"] as const) {
        expect([ip, access, endpointAddressAllowed(ip, access)]).toEqual([ip, access, expected[access]]);
      }
    }
  });
});

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

describe("createGuardedFetch against a local HTTP server", () => {
  let server: http.Server;
  let port: number;
  let handler: Handler;
  let hits: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;

  const policy = (overrides: Partial<EndpointPolicy> = {}): EndpointPolicy => ({
    access: "loopback",
    allowHttp: true,
    maxBytes: 1024,
    connectTimeoutMs: 2_000,
    timeoutMs: 5_000,
    ...overrides,
  });
  const url = (path: string, host = "llm.example.test"): string => `http://${host}:${port}${path}`;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        hits.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        handler(request, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits = [];
    handler = (_request, response) => response.writeHead(404).end();
  });

  afterEach(() => {
    server.closeAllConnections();
  });

  it("posts a body with caller headers and returns status, headers and body", async () => {
    handler = (_request, response) =>
      response.writeHead(429, { "content-type": "application/json", "retry-after": "3" }).end('{"error":"slow down"}');
    const guarded = createGuardedFetch({ policy: policy(), resolver: resolverFrom({ "llm.example.test": [v4("127.0.0.1")] }) });
    const response = await guarded(url("/v1/chat/completions"), {
      method: "POST",
      headers: { authorization: "Bearer fake-test-key-0000", "content-type": "application/json", host: "evil.example" },
      body: '{"model":"m"}',
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toBe('{"error":"slow down"}');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: "POST", url: "/v1/chat/completions", body: '{"model":"m"}' });
    expect(hits[0]?.headers["authorization"]).toBe("Bearer fake-test-key-0000");
    expect(hits[0]?.headers["host"]).toBe(`llm.example.test:${port}`);
    expect(hits[0]?.headers["accept-encoding"]).toBe("identity");
  });

  it("streams a chunked body (SSE) to the caller", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: one\n\n");
      setTimeout(() => response.end("data: two\n\n"), 20);
    };
    const guarded = createGuardedFetch({ policy: policy(), resolver: resolverFrom({ "llm.example.test": [v4("127.0.0.1")] }) });
    const response = await guarded(url("/stream"), { method: "POST", body: "{}" });
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
  });

  it("refuses a hostname that resolves to a disallowed address before connecting", async () => {
    const resolver = resolverFrom({
      "private.example.test": [v4("10.0.0.8")],
      "mixed.example.test": [v4("127.0.0.1"), v4("192.168.0.9")],
      "mapped.example.test": [v6("::ffff:10.0.0.8")],
      "metadata.example.test": [v4("169.254.169.254")],
      "metadata6.example.test": [v6("fd00:ec2::254")],
    });
    const guarded = createGuardedFetch({ policy: policy(), resolver });
    for (const host of [
      "private.example.test",
      "mixed.example.test",
      "mapped.example.test",
      "metadata.example.test",
      "metadata6.example.test",
    ]) {
      expect(await failure(guarded(url("/v1", host), { method: "POST", body: "{}" }))).toBe("private_address");
    }
    expect(hits).toEqual([]);
  });

  it("refuses loopback under the public (production) policy, and plain http", async () => {
    const resolver = resolverFrom({ "llm.example.test": [v4("127.0.0.1")] });
    const publicGuard = createGuardedFetch({ policy: policy({ access: "public", allowHttp: false }), resolver });
    expect(await failure(publicGuard(url("/v1")))).toBe("scheme_not_allowed");
    expect(await failure(publicGuard(`https://llm.example.test:${port}/v1`))).toBe("private_address");
    expect(await failure(publicGuard(`https://127.0.0.1:${port}/v1`))).toBe("private_address");
    expect(await failure(publicGuard(`https://[::ffff:127.0.0.1]:${port}/v1`))).toBe("private_address");
    expect(hits).toEqual([]);
  });

  it("pins the connection: a resolver that rebinds to a private address is never consulted mid-request", async () => {
    handler = (_request, response) => response.writeHead(200).end("ok");
    // First answer is acceptable; every later answer points inside the network.
    let calls = 0;
    const rebinding: Resolver = async () => {
      calls += 1;
      return calls === 1 ? [v4("127.0.0.1")] : [v4("10.0.0.8")];
    };
    const lookups: string[] = [];
    const observing: EndpointTransport = (options, callback) => {
      const lookup = options.lookup;
      return http.request(
        {
          ...options,
          lookup: (hostname, lookupOptions, cb) => {
            lookups.push(hostname);
            // The socket's lookup is the pinned one: it never re-resolves.
            lookup?.(hostname, lookupOptions, cb);
          },
        },
        callback,
      );
    };
    const guarded = createGuardedFetch({ policy: policy(), resolver: rebinding, transport: observing });
    const first = await guarded(url("/first"));
    expect(await first.text()).toBe("ok");
    expect(calls).toBe(1);
    expect(lookups).toEqual(["llm.example.test"]);
    // A new request re-validates DNS and refuses the rebound answer.
    expect(await failure(guarded(url("/second")))).toBe("private_address");
    expect(calls).toBe(2);
    expect(hits.map((hit) => hit.url)).toEqual(["/first"]);
  });

  it("refuses a connection that lands on an address other than the pinned one", async () => {
    handler = (_request, response) => response.writeHead(200).end("ok");
    const hijack: EndpointTransport = (options, callback) =>
      http.request(
        {
          ...options,
          lookup: (_host, lookupOptions, cb) => {
            if (lookupOptions.all === true) process.nextTick(cb, null, [{ address: "127.0.0.1", family: 4 }]);
            else process.nextTick(cb, null, "127.0.0.1", 4);
          },
        },
        callback,
      );
    const guarded = createGuardedFetch({
      policy: policy(),
      resolver: resolverFrom({ "llm.example.test": [v4("127.0.0.2")] }),
      transport: hijack,
    });
    expect(await failure(guarded(url("/x")))).toBe("pinning_violation");
  });

  it("never follows redirects", async () => {
    handler = (_request, response) => response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
    const guarded = createGuardedFetch({ policy: policy(), resolver: resolverFrom({ "llm.example.test": [v4("127.0.0.1")] }) });
    expect(await failure(guarded(url("/v1"), { method: "POST", body: "{}" }))).toBe("redirect_refused");
    expect(hits).toHaveLength(1);
  });

  it("refuses a declared content-length over the cap", async () => {
    handler = (_request, response) => response.writeHead(200, { "content-length": "4096" }).end("x".repeat(4096));
    const guarded = createGuardedFetch({ policy: policy(), resolver: resolverFrom({ "llm.example.test": [v4("127.0.0.1")] }) });
    expect(await failure(guarded(url("/big")))).toBe("response_too_large");
  });

  it("errors the body stream once a chunked body passes the cap", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const tick = setInterval(() => {
        if (!response.write("data: ".padEnd(200, "x") + "\n\n")) return;
      }, 1);
      response.on("close", () => clearInterval(tick));
    };
    const guarded = createGuardedFetch({ policy: policy(), resolver: resolverFrom({ "llm.example.test": [v4("127.0.0.1")] }) });
    const response = await guarded(url("/endless"));
    expect(await failure(response.text())).toBe("response_too_large");
  });

  it("times out a stalled body with the total deadline", async () => {
    handler = (_request, response) => {
      response.writeHead(200);
      response.write("partial");
    };
    const guarded = createGuardedFetch({
      policy: policy({ timeoutMs: 150 }),
      resolver: resolverFrom({ "llm.example.test": [v4("127.0.0.1")] }),
    });
    const response = await guarded(url("/stall"));
    expect(await failure(response.text())).toBe("timeout");
  });

  it("cancels via AbortSignal before and during the body", async () => {
    handler = (_request, response) => {
      response.writeHead(200);
      response.write("partial");
    };
    const guarded = createGuardedFetch({ policy: policy(), resolver: resolverFrom({ "llm.example.test": [v4("127.0.0.1")] }) });
    const before = new AbortController();
    before.abort();
    expect(await failure(guarded(url("/x"), { signal: before.signal }))).toBe("cancelled");
    const during = new AbortController();
    const response = await guarded(url("/x"), { signal: during.signal });
    setTimeout(() => during.abort(), 20);
    expect(await failure(response.text())).toBe("cancelled");
  });

  it("applies the connect timeout when the TLS handshake never completes", async () => {
    const sockets: net.Socket[] = [];
    // Accepts the TCP connection and never speaks TLS.
    const silent = net.createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const silentPort = (silent.address() as AddressInfo).port;
    try {
      const guarded = createGuardedFetch({
        policy: policy({ connectTimeoutMs: 100, timeoutMs: 5_000 }),
        resolver: resolverFrom({ "llm.example.test": [v4("127.0.0.1")] }),
      });
      const started = Date.now();
      const failed = guarded(`https://llm.example.test:${silentPort}/v1`).catch((error: unknown) => error);
      const error = (await failed) as NetGuardError;
      expect(error).toBeInstanceOf(NetGuardError);
      expect(error.code).toBe("timeout");
      expect(error.message).toMatch(/Connection was not established/);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasOpenssl())("createGuardedFetch over TLS", () => {
  let certDir: string;
  let cert: Buffer;
  let server: https.Server;
  let port: number;

  beforeAll(async () => {
    certDir = await mkdtemp(join(tmpdir(), "net-guard-endpoint-cert-"));
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
        "/CN=llm.example.test",
        "-addext",
        "subjectAltName=DNS:llm.example.test",
        "-keyout",
        join(certDir, "key.pem"),
        "-out",
        join(certDir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    cert = await readFile(join(certDir, "cert.pem"));
    const key = await readFile(join(certDir, "key.pem"));
    server = https.createServer({ key, cert }, (_request, response) => response.writeHead(200).end("secure"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(certDir, { recursive: true, force: true });
  });

  const resolver = resolverFrom({ "llm.example.test": [v4("127.0.0.1")] });
  const policy: EndpointPolicy = { access: "public", maxBytes: 1024, connectTimeoutMs: 2_000, timeoutMs: 5_000 };
  // Test seam: widen "public" to 127.0.0.1 so the local server stands in for a public host.
  const addressPolicy = (ip: string): boolean => ip === "127.0.0.1" || endpointAddressAllowed(ip, "public");

  it("verifies the certificate against the hostname (SNI) and returns the body", async () => {
    const trustTestCa: EndpointTransport = (options, callback) => https.request({ ...options, ca: cert }, callback);
    const guarded = createGuardedFetch({ policy, resolver, addressPolicy, transport: trustTestCa });
    const response = await guarded(`https://llm.example.test:${port}/v1`);
    expect(await response.text()).toBe("secure");
  });

  it("keeps TLS verification on (untrusted certificate fails)", async () => {
    const guarded = createGuardedFetch({ policy, resolver, addressPolicy });
    expect(await failure(guarded(`https://llm.example.test:${port}/v1`))).toBe("tls_failed");
  });
});
