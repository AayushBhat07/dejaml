import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

/**
 * Process-wide proof that DéjàML runs its own agents. While installed, the
 * guard records every child process and outbound destination, and refuses
 * (throws or rejects) anything that would reach OpenClaw or a localhost model
 * bridge: an `openclaw` executable, the OpenClaw Gateway port 18789, a host or
 * URL naming openclaw, or an OpenAI-compatible `/v1` endpoint on loopback.
 *
 * It wraps `globalThis.fetch`, the `node:child_process` launchers, the
 * `node:http`/`node:https` request functions, and `net.Socket.prototype.connect`
 * (which every TCP and TLS client, including fetch, goes through). Built-in
 * named ESM exports are re-synced, so `import { spawn } from "node:child_process"`
 * sees the guard too. It is an acceptance-test instrument, not a sandbox: code
 * that already holds a reference to an original function bypasses it.
 */

export const OPENCLAW_GATEWAY_PORT = 18789;

export type NativeRuntimeGuardOptions = {
  /**
   * Destinations or command lines that are recorded but never blocked. A
   * string matches exactly or as a prefix; a RegExp is tested against the
   * recorded form (`https://host/path`, `tcp://host:port`, or the command line).
   */
  allow?: readonly (string | RegExp)[];
};

export type NativeRuntimeGuardReport = {
  /** Every child process launch attempt, as its command line. */
  processes: string[];
  /** Unique outbound destinations in first-seen order (no query strings). */
  destinations: string[];
  /** Every refused attempt, as `<what>: <reason>`. */
  blocked: string[];
};

export type NativeRuntimeGuard = NativeRuntimeGuardReport & {
  /** A copy of the report at this moment. */
  snapshot(): NativeRuntimeGuardReport;
  /** Restores the original functions. Idempotent. */
  uninstall(): void;
  [Symbol.dispose](): void;
};

export class NativeRuntimeViolation extends Error {
  readonly code = "native_runtime_violation";
  constructor(readonly target: string, readonly reason: string) {
    super(`native runtime guard blocked ${target}: ${reason}`);
    this.name = "NativeRuntimeViolation";
  }
}

type AnyFunction = (...args: unknown[]) => unknown;
type Patch = { target: Record<string, unknown>; key: string; original: unknown };

const CHILD_PROCESS_LAUNCHERS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
const COMMAND_STRING_LAUNCHERS = new Set<string>(["exec", "execSync"]);
const MAX_RECORD_LENGTH = 300;

let active: NativeRuntimeGuard | undefined;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/** Why a URL must not be reached, or undefined when it may. */
export function nativeRuntimeUrlViolation(url: URL): string | undefined {
  if (/openclaw/iu.test(url.hostname) || /openclaw/iu.test(url.pathname)) return "OpenClaw endpoint";
  const port = url.port ? Number(url.port) : undefined;
  if (port === OPENCLAW_GATEWAY_PORT) return "OpenClaw Gateway port";
  if (/^\/v1\/agent(?:\/|$)/u.test(url.pathname) && isLoopbackHost(url.hostname)) return "OpenClaw Gateway agent endpoint";
  if (isLoopbackHost(url.hostname) && /^\/v1(?:\/|$)/u.test(url.pathname)) return "localhost compatibility bridge";
  return undefined;
}

/** Why a command line must not run, or undefined when it may. */
export function nativeRuntimeCommandViolation(argv: readonly string[]): string | undefined {
  return argv.some((part) => /openclaw/iu.test(part)) ? "OpenClaw executable" : undefined;
}

function describeUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function clip(value: string): string {
  return value.length > MAX_RECORD_LENGTH ? `${value.slice(0, MAX_RECORD_LENGTH)}…` : value;
}

function fetchUrl(input: unknown): URL | undefined {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url);
  } catch {
    return undefined;
  }
  return undefined;
}

/** http.request(url | options, [options], [callback]) → the URL it targets. */
function httpRequestUrl(defaultProtocol: string, args: unknown[]): URL | undefined {
  const [first, second] = args;
  try {
    if (typeof first === "string" || first instanceof URL) {
      const url = new URL(first);
      if (second && typeof second === "object") applyRequestOptions(url, second as http.RequestOptions);
      return url;
    }
    if (first && typeof first === "object") {
      const url = new URL(`${defaultProtocol}//localhost`);
      applyRequestOptions(url, first as http.RequestOptions);
      return url;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function applyRequestOptions(url: URL, options: http.RequestOptions): void {
  if (options.protocol) url.protocol = options.protocol;
  const host = options.hostname ?? options.host;
  if (host) url.hostname = host.replace(/:\d+$/u, "");
  if (options.port !== undefined && options.port !== null) url.port = String(options.port);
  if (options.path) {
    const [pathname] = options.path.split("?");
    url.pathname = pathname ?? "/";
  }
}

/** net.Socket#connect(options | port[, host] | path, [listener]) → host and port. */
function socketTarget(args: unknown[]): { host: string; port: number | undefined } | { path: string } | undefined {
  let [first, second] = args;
  // net.connect passes its already-normalized arguments as one array.
  if (Array.isArray(first)) [first, second] = first as unknown[];
  if (first && typeof first === "object") {
    const options = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof options.path === "string") return { path: options.path };
    const port = options.port === undefined ? undefined : Number(options.port);
    return { host: typeof options.host === "string" ? options.host : "localhost", port };
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/u.test(first))) {
    return { host: typeof second === "string" ? second : "localhost", port: Number(first) };
  }
  if (typeof first === "string") return { path: first };
  return undefined;
}

function commandLine(name: string, args: unknown[]): string[] {
  const [file, rest] = args;
  if (typeof file !== "string") return [];
  if (COMMAND_STRING_LAUNCHERS.has(name)) return [file];
  const argv = Array.isArray(rest) ? rest.filter((part): part is string => typeof part === "string") : [];
  // fork(modulePath) runs node on that module.
  return name === "fork" ? [process.execPath, file, ...argv] : [file, ...argv];
}

/**
 * Installs the guard for this process until `uninstall()` is called. Only one
 * guard may be active at a time.
 */
export function installNativeRuntimeGuard(options: NativeRuntimeGuardOptions = {}): NativeRuntimeGuard {
  if (active) throw new Error("a native runtime guard is already installed");
  const allow = options.allow ?? [];
  const processes: string[] = [];
  const destinations: string[] = [];
  const blocked: string[] = [];
  const seen = new Set<string>();
  const patches: Patch[] = [];

  const allowed = (recorded: string): boolean =>
    allow.some((rule) => (typeof rule === "string" ? recorded === rule || recorded.startsWith(rule) : rule.test(recorded)));

  const recordDestination = (recorded: string): void => {
    if (seen.has(recorded)) return;
    seen.add(recorded);
    destinations.push(recorded);
  };

  /** Records a destination; throws when it is forbidden and not allowlisted. */
  const checkUrl = (url: URL): void => {
    const recorded = describeUrl(url);
    recordDestination(recorded);
    const reason = nativeRuntimeUrlViolation(url);
    if (reason && !allowed(recorded)) {
      blocked.push(`${recorded}: ${reason}`);
      throw new NativeRuntimeViolation(recorded, reason);
    }
  };

  const patch = (target: object, key: string, replacement: (original: AnyFunction) => AnyFunction): void => {
    const record = target as Record<string, unknown>;
    const original = record[key];
    if (typeof original !== "function") return;
    patches.push({ target: record, key, original });
    record[key] = replacement(original as AnyFunction);
  };

  if (typeof globalThis.fetch === "function") {
    patch(globalThis, "fetch", (original) =>
      function guardedFetch(this: unknown, ...args: unknown[]) {
        const url = fetchUrl(args[0]);
        try {
          if (url) checkUrl(url);
        } catch (error) {
          return Promise.reject(error);
        }
        return original.apply(this, args);
      },
    );
  }

  for (const name of CHILD_PROCESS_LAUNCHERS) {
    patch(childProcess, name, (original) =>
      function guardedLaunch(this: unknown, ...args: unknown[]) {
        const argv = commandLine(name, args);
        const recorded = clip(argv.join(" "));
        processes.push(recorded);
        const reason = nativeRuntimeCommandViolation(argv);
        if (reason && !allowed(recorded)) {
          blocked.push(`${recorded}: ${reason}`);
          throw new NativeRuntimeViolation(recorded, reason);
        }
        return original.apply(this, args);
      },
    );
  }

  for (const [module, protocol] of [[http, "http:"], [https, "https:"]] as const) {
    for (const name of ["request", "get"]) {
      patch(module, name, (original) =>
        function guardedRequest(this: unknown, ...args: unknown[]) {
          const url = httpRequestUrl(protocol, args);
          if (url) checkUrl(url);
          return original.apply(this, args);
        },
      );
    }
  }

  patch(net.Socket.prototype, "connect", (original) =>
    function guardedConnect(this: unknown, ...args: unknown[]) {
      const target = socketTarget(args);
      if (target && "path" in target) {
        recordDestination(`ipc:${target.path}`);
      } else if (target) {
        const recorded = `tcp://${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port ?? "?"}`;
        recordDestination(recorded);
        const reason =
          target.port === OPENCLAW_GATEWAY_PORT ? "OpenClaw Gateway port" : /openclaw/iu.test(target.host) ? "OpenClaw host" : undefined;
        if (reason && !allowed(recorded)) {
          blocked.push(`${recorded}: ${reason}`);
          throw new NativeRuntimeViolation(recorded, reason);
        }
      }
      return original.apply(this, args);
    },
  );

  syncBuiltinESMExports();

  let installed = true;
  const uninstall = (): void => {
    if (!installed) return;
    installed = false;
    for (const { target, key, original } of patches.reverse()) target[key] = original;
    syncBuiltinESMExports();
    if (active === guard) active = undefined;
  };
  const guard: NativeRuntimeGuard = {
    processes,
    destinations,
    blocked,
    snapshot: () => ({ processes: [...processes], destinations: [...destinations], blocked: [...blocked] }),
    uninstall,
    [Symbol.dispose]: uninstall,
  };
  active = guard;
  return guard;
}
