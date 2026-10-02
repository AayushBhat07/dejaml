import { z } from "zod";

import { acceleratorError, findAcceleratorPackagesInPipOutput } from "./accelerator.js";
import { PrepError, type PrepErrorCode } from "./errors.js";
import { parseAcceleratorGuard } from "./pip-entry.js";
import type { PrepPolicy } from "./policy.js";
import { normalizePackageName } from "./requirements.js";

/** One package pinned by the resolver: exactly one wheel, its URL and sha256. */
export const ResolvedPackageSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
    version: z.string().regex(/^[A-Za-z0-9.+!_-]{1,64}$/u),
    filename: z.string().regex(/^[A-Za-z0-9_.+!-]+\.whl$/u),
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    requested: z.boolean(),
  })
  .strict();
export type ResolvedPackage = z.infer<typeof ResolvedPackageSchema>;

const PipReportSchema = z.object({
  version: z.string(),
  environment: z.record(z.string(), z.unknown()).optional(),
  install: z
    .array(
      z
        .object({
          metadata: z.object({ name: z.string().min(1).max(200), version: z.string().min(1).max(64) }).passthrough(),
          download_info: z
            .object({
              url: z.string().min(1).max(2048),
              archive_info: z
                .object({
                  hash: z.string().optional(),
                  hashes: z.record(z.string(), z.string()).optional(),
                })
                .passthrough()
                .optional(),
              dir_info: z.unknown().optional(),
              vcs_info: z.unknown().optional(),
            })
            .passthrough(),
          is_direct: z.boolean().optional(),
          requested: z.boolean().optional(),
        })
        .passthrough(),
    )
    .max(10_000),
});

export type ParsedPipReport = {
  packages: ResolvedPackage[];
  pythonVersion: string | null;
  /** `python_version` marker value of the resolver's interpreter, e.g. `3.11`. */
  pythonMinor: string | null;
  /** `platform_machine` of the resolver's interpreter (the host's machine in cross mode). */
  platform: string | null;
};

/** Parse a wheel file name into its distribution and version parts (PEP 427). */
export function parseWheelFilename(filename: string): { name: string; version: string } | null {
  if (!/^[A-Za-z0-9_.+!-]+\.whl$/u.test(filename)) return null;
  const parts = filename.slice(0, -4).split("-");
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [name, version] = parts;
  if (!name || !version) return null;
  return { name: normalizePackageName(name), version };
}

function sameVersion(a: string, b: string): boolean {
  return a.toLowerCase().replace(/-/gu, "_") === b.toLowerCase().replace(/-/gu, "_");
}

function reject(message: string, code: PrepErrorCode = "runtime_error"): never {
  throw new PrepError(code, message);
}

/**
 * Validate `pip install --dry-run --report` output against the policy: every
 * install item must be a registry wheel from an allowlisted https host with a
 * sha256, and there may be at most `maxPackages` of them.
 */
export function parsePipReport(raw: unknown, policy: Pick<PrepPolicy, "allowedHosts" | "maxPackages">): ParsedPipReport {
  const parsed = PipReportSchema.safeParse(raw);
  if (!parsed.success) reject(`pip report has an unexpected shape: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const report = parsed.data;
  if (report.install.length > policy.maxPackages) {
    reject(`resolution needs ${report.install.length} packages; the policy allows ${policy.maxPackages}`, "limit_exceeded");
  }
  const seen = new Set<string>();
  const packages = report.install.map((item): ResolvedPackage => {
    const name = normalizePackageName(item.metadata.name);
    const label = `${name}==${item.metadata.version}`;
    if (item.is_direct === true || item.download_info.dir_info !== undefined || item.download_info.vcs_info !== undefined) {
      reject(`${label} resolved to a direct/VCS/local reference`, "invalid_requirement");
    }
    let url: URL;
    try {
      url = new URL(item.download_info.url);
    } catch {
      return reject(`${label} has an unparseable download URL`);
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || (url.port !== "" && url.port !== "443")) {
      reject(`${label} download URL must be plain https`, "egress_denied");
    }
    if (!policy.allowedHosts.includes(url.hostname.toLowerCase())) {
      reject(`${label} would download from ${url.hostname}, which is not an allowed host`, "egress_denied");
    }
    const filename = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (!filename.endsWith(".whl")) {
      reject(
        `${label} resolved to ${filename || "a non-wheel"}; only binary wheels are accepted (sdists are never built)`,
        "no_compatible_wheel",
      );
    }
    const wheel = parseWheelFilename(filename);
    if (!wheel || wheel.name !== name || !sameVersion(wheel.version, item.metadata.version)) {
      reject(`${label} wheel file name ${filename} does not match the resolved name/version`);
    }
    const archive = item.download_info.archive_info;
    let sha256 = archive?.hashes?.sha256;
    if (!sha256 && archive?.hash?.startsWith("sha256=")) sha256 = archive.hash.slice("sha256=".length);
    sha256 = sha256?.toLowerCase();
    if (!sha256 || !/^[a-f0-9]{64}$/u.test(sha256)) reject(`${label} has no sha256 hash in the index response`);
    if (seen.has(name)) reject(`${name} appears twice in the resolution`);
    seen.add(name);
    return ResolvedPackageSchema.parse({
      name,
      version: item.metadata.version,
      filename,
      url: url.toString(),
      sha256,
      requested: item.requested === true,
    });
  });
  const env = report.environment ?? {};
  return {
    packages,
    pythonVersion: typeof env.python_full_version === "string" ? env.python_full_version : null,
    pythonMinor: typeof env.python_version === "string" ? env.python_version : null,
    platform: typeof env.platform_machine === "string" ? env.platform_machine : null,
  };
}

export type ProxyLogEntry = {
  event: string;
  host?: string | null;
  ip?: string | null;
  allowed?: boolean;
  reason?: string;
  bytes_up?: number;
  bytes_down?: number;
  ms?: number;
  [key: string]: unknown;
};

export function parseProxyLog(text: string): ProxyLogEntry[] {
  const entries: ProxyLogEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === "object" && typeof (value as { event?: unknown }).event === "string") {
        entries.push(value as ProxyLogEntry);
      }
    } catch {
      // not a log line
    }
  }
  return entries;
}

export const DETAIL_BYTES = 4096;

export function tail(text: string, bytes = DETAIL_BYTES): string {
  const buffer = Buffer.from(text, "utf8");
  return buffer.length <= bytes ? text : buffer.subarray(buffer.length - bytes).toString("utf8");
}

export type PipFailureContext = {
  stderr: string;
  proxyLog: ProxyLogEntry[];
  exitCode: number | null;
  oomKilled?: boolean;
};

/** Map a failed pip run to a typed error (timeouts/cancellation are decided by the caller). */
export function classifyPipFailure(context: PipFailureContext): PrepError {
  const detail = tail(context.stderr);
  // The in-container guard stopped pip before it downloaded an accelerator wheel.
  const guarded = parseAcceleratorGuard(context.stderr);
  if (guarded !== null && guarded.length > 0) return acceleratorError(guarded, { stage: "download_guard", detail });
  if (/^DEJAML_PIP_UNSUPPORTED /mu.test(context.stderr)) {
    return new PrepError("runtime_error", "the preparation image's pip is not supported by the CPU-only download guard", { detail });
  }
  // CPU-only policy: a resolution that failed on an accelerator dependency (for example torch's nvidia-*
  // wheels on a platform without them) is a policy refusal, not a missing CPU wheel or a runtime fault.
  const accelerator = findAcceleratorPackagesInPipOutput(context.stderr);
  if (accelerator.length > 0) return acceleratorError(accelerator, { stage: "resolver_failure", detail });
  if (context.proxyLog.some((entry) => entry.event === "budget_exceeded")) {
    return new PrepError("limit_exceeded", "the preparation byte budget was exceeded at the egress proxy", { detail });
  }
  if (context.oomKilled) {
    return new PrepError("limit_exceeded", "the downloader ran out of memory", { detail });
  }
  const missing =
    /No matching distribution found for ([^\s]+)/u.exec(context.stderr) ??
    /Could not find a version that satisfies the requirement ([^\s]+)/u.exec(context.stderr);
  if (missing?.[1]) {
    const requirement = missing[1];
    const name = normalizePackageName(/^[A-Za-z0-9._-]+/u.exec(requirement)?.[0] ?? requirement);
    return new PrepError(
      "no_compatible_wheel",
      `no compatible CPU binary wheel for ${requirement} on the target platform; source distributions are never built, ` +
        "so this needs explicit approval or a prebuilt lab image",
      { detail, requirement: name },
    );
  }
  if (
    /ResolutionImpossible|conflicting dependencies|Cannot install .* because these package versions have conflicting/u.test(context.stderr)
  ) {
    return new PrepError("resolution_conflict", "the requirements have conflicting dependencies", { detail });
  }
  const denied = context.proxyLog.filter((entry) => entry.event === "connect" && entry.allowed === false);
  if (denied.length > 0) {
    const hosts = [...new Set(denied.map((entry) => `${entry.host ?? "?"} (${entry.reason ?? "denied"})`))].join(", ");
    return new PrepError("egress_denied", `the egress proxy denied: ${hosts}`, { detail });
  }
  if (/Invalid requirement|InvalidRequirement/u.test(context.stderr)) {
    return new PrepError("invalid_requirement", "pip rejected a requirement", { detail });
  }
  return new PrepError("runtime_error", `pip exited with code ${context.exitCode ?? "unknown"}`, { detail });
}
