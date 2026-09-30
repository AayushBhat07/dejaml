import childProcess, { execFile, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installNativeRuntimeGuard, type NativeRuntimeGuard, NativeRuntimeViolation } from "./native-guard.js";

let guard: NativeRuntimeGuard | undefined;

function install(...args: Parameters<typeof installNativeRuntimeGuard>): NativeRuntimeGuard {
  guard = installNativeRuntimeGuard(...args);
  return guard;
}

afterEach(() => {
  guard?.uninstall();
  guard = undefined;
  vi.unstubAllGlobals();
});

function stubFetch() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return new Response("{}", { status: 200 });
  });
  return calls;
}

describe("native runtime guard", () => {
  it("blocks launching an openclaw binary through every import form", () => {
    const report = install();
    expect(() => spawn("openclaw", ["agent", "--json"])).toThrow(NativeRuntimeViolation);
    expect(() => childProcess.spawn("/usr/local/bin/openclaw", [])).toThrow(/OpenClaw executable/u);
    expect(() => execFile("openclaw", ["gateway", "status"])).toThrow(NativeRuntimeViolation);
    expect(() => childProcess.execSync("openclaw agents list --json")).toThrow(NativeRuntimeViolation);
    expect(report.blocked).toHaveLength(4);
    expect(report.processes[0]).toBe("openclaw agent --json");
  });

  it("records permitted child processes", async () => {
    const report = install();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => child.on("close", resolve));
    expect(report.processes).toEqual([`${process.execPath} -e process.exit(0)`]);
    expect(report.blocked).toEqual([]);
  });

  it("rejects the OpenClaw Gateway and a localhost compatibility bridge", async () => {
    const calls = stubFetch();
    const report = install();
    await expect(fetch("http://127.0.0.1:18789/v1/agent")).rejects.toThrow(/OpenClaw Gateway port/u);
    await expect(fetch("http://localhost:8080/v1/chat/completions")).rejects.toThrow(/localhost compatibility bridge/u);
    await expect(fetch(new URL("http://[::1]:11434/v1/models"))).rejects.toThrow(NativeRuntimeViolation);
    await expect(fetch("https://gateway.openclaw.ai/api")).rejects.toThrow(/OpenClaw endpoint/u);
    expect(calls).toEqual([]);
    expect(report.blocked).toEqual([
      "http://127.0.0.1:18789/v1/agent: OpenClaw Gateway port",
      "http://localhost:8080/v1/chat/completions: localhost compatibility bridge",
      "http://[::1]:11434/v1/models: localhost compatibility bridge",
      "https://gateway.openclaw.ai/api: OpenClaw endpoint",
    ]);
  });

  it("allows the OpenAI and Anthropic APIs and records them without query strings", async () => {
    const calls = stubFetch();
    const report = install();
    await fetch("https://api.anthropic.com/v1/messages");
    await fetch(new Request("https://api.openai.com/v1/chat/completions?trace=1", { method: "POST", body: "{}" }));
    await fetch("https://api.anthropic.com/v1/messages");
    expect(calls).toHaveLength(3);
    expect(report.destinations).toEqual(["https://api.anthropic.com/v1/messages", "https://api.openai.com/v1/chat/completions"]);
    expect(report.blocked).toEqual([]);
  });

  it("lets a test allowlist a destination explicitly", async () => {
    stubFetch();
    const report = install({ allow: ["http://127.0.0.1:8080/v1/"] });
    await expect(fetch("http://127.0.0.1:8080/v1/chat/completions")).resolves.toBeInstanceOf(Response);
    expect(report.destinations).toEqual(["http://127.0.0.1:8080/v1/chat/completions"]);
    expect(report.blocked).toEqual([]);
  });

  it("refuses raw sockets to the Gateway port and http requests to a bridge", () => {
    const report = install();
    expect(() => net.connect({ host: "127.0.0.1", port: 18789 })).toThrow(NativeRuntimeViolation);
    expect(() => new net.Socket().connect(18789, "localhost")).toThrow(NativeRuntimeViolation);
    expect(() => http.request("http://127.0.0.1:1234/v1/chat/completions")).toThrow(/localhost compatibility bridge/u);
    expect(() => http.request({ hostname: "localhost", port: 9000, path: "/v1/models?x=1" })).toThrow(NativeRuntimeViolation);
    expect(report.destinations).toEqual([
      "tcp://127.0.0.1:18789",
      "tcp://localhost:18789",
      "http://127.0.0.1:1234/v1/chat/completions",
      "http://localhost:9000/v1/models",
    ]);
  });

  it("records permitted sockets", async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const report = install();
    const socket = net.connect({ host: "127.0.0.1", port });
    await new Promise((resolve) => socket.on("close", resolve));
    await new Promise((resolve) => server.close(resolve));
    expect(report.destinations).toEqual([`tcp://127.0.0.1:${port}`]);
  });

  it("restores the originals on uninstall and allows only one guard at a time", () => {
    const originalSpawn = childProcess.spawn;
    const originalConnect = net.Socket.prototype.connect;
    const first = install();
    expect(childProcess.spawn).not.toBe(originalSpawn);
    expect(spawn).toBe(childProcess.spawn);
    expect(() => installNativeRuntimeGuard()).toThrow(/already installed/u);
    first.uninstall();
    first.uninstall();
    expect(childProcess.spawn).toBe(originalSpawn);
    expect(spawn).toBe(originalSpawn);
    expect(net.Socket.prototype.connect).toBe(originalConnect);
    const snapshot = first.snapshot();
    install();
    expect(snapshot).toEqual({ processes: [], destinations: [], blocked: [] });
  });
});
