import { isAbsolute } from "node:path";

import { PythonVersionSchema, type PackageIndexProfile, type PythonVersion } from "@dejaml/contracts";
import { z } from "zod";

import { PrepError } from "./errors.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HOST_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z][a-z0-9-]*[a-z0-9]$/u;
/** `name[:tag]@sha256:<64 hex>`: preparation images are always pinned by digest. */
const PINNED_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/:-]{0,200}@sha256:[a-f0-9]{64}$/u;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;

/**
 * Official `python:<version>-slim-trixie` images, pinned by the digest of
 * their multi-platform index (linux/amd64 and linux/arm64), looked up with
 * `docker buildx imagetools inspect` on 2026-09-30:
 * 3.10.21, 3.11.16, 3.12.14 and 3.13.15.
 */
export const DEFAULT_PREP_IMAGES: Record<PythonVersion, string> = {
  "3.10": "python:3.10-slim-trixie@sha256:9d53d8d4c0e882f61913025db53b3aec4ef74336082a9ab47d8a14e9e8329b00",
  "3.11": "python:3.11-slim-trixie@sha256:e41613d42d4891e4930f79523f93f81bbc7632584ec65e36ab055f41a800b41e",
  "3.12": "python:3.12-slim-trixie@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f",
  "3.13": "python:3.13-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b",
};

export const AllowedHostSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().regex(HOST_PATTERN, "allowed hosts must be DNS names (no IP literals, ports or wildcards)"));

const HttpsIndexSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", "the package index must use https")
  .refine((value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.port === "";
  }, "the package index URL must not contain credentials or a port");

export const PrepPolicySchema = z
  .object({
    /** Digest-pinned preparation image per Python version (`python:<version>-slim-trixie@sha256:…`). */
    images: z
      .partialRecord(
        PythonVersionSchema,
        z.string().regex(PINNED_IMAGE_PATTERN, "preparation images must be pinned by digest (name:tag@sha256:<64 hex>)"),
      )
      .default(DEFAULT_PREP_IMAGES),
    /** Optional `docker image inspect --platform` ID each version's image must have. */
    expectedImageIds: z.partialRecord(PythonVersionSchema, z.string().regex(IMAGE_ID_PATTERN)).default({}),
    /** Pull a missing preparation image (by digest, for the exact platform). Off by default: nothing is pulled implicitly. */
    pullImages: z.boolean().default(false),
    /**
     * `auto` runs pip natively when the Docker engine is the target platform,
     * under emulation when the engine can execute it, and otherwise resolves
     * across platforms with pip's target options. `native` refuses anything
     * but a container of the target platform.
     */
    resolverMode: z.enum(["auto", "native"]).default("auto"),
    /**
     * When set, the platform's package index profile must use exactly this
     * index. The index and egress hosts themselves come from
     * `PlatformSpec.packageIndex`.
     */
    indexUrl: HttpsIndexSchema.optional(),
    /** Upper bound on egress: every host of the platform's package index profile must be listed here. */
    allowedHosts: z.array(AllowedHostSchema).min(1).max(16).default(["pypi.org", "files.pythonhosted.org"]),
    maxPackages: z.number().int().min(1).max(2000).default(150),
    maxFileBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * GIB)
      .default(1 * GIB),
    maxTotalBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * GIB)
      .default(3 * GIB),
    /** Byte quota of the per-run, disk-backed temp directory (pip's /tmp, the report and the downloads). */
    maxTempBytes: z
      .number()
      .int()
      .min(1)
      .max(256 * GIB)
      .default(6 * GIB),
    /** File-count quota of the per-run temp directory. */
    maxTempInodes: z.number().int().min(1).max(10_000_000).default(200_000),
    /** Free space that must remain on the work, cache and wheelhouse filesystems. */
    minFreeBytes: z
      .number()
      .int()
      .min(0)
      .max(1024 * GIB)
      .default(1 * GIB),
    /** How often the temp directory is measured while a worker runs. */
    diskPollMs: z.number().int().min(20).max(60_000).default(1000),
    timeoutSeconds: z.number().int().min(1).max(7200).default(600),
    cpus: z.number().min(0.1).max(64).default(2),
    memoryMb: z.number().int().min(256).max(65536).default(2048),
    pids: z.number().int().min(32).max(4096).default(256),
    /**
     * Operator setting for networks whose TLS is intercepted by a proxy: a PEM
     * bundle on the host, mounted read-only into the downloader as PIP_CERT.
     * It widens what the downloader trusts, so it is never set by an agent.
     */
    caBundlePath: z
      .string()
      .refine((value) => isAbsolute(value) && !value.includes(","), "caBundlePath must be an absolute path without commas")
      .optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.indexUrl) {
      const host = new URL(policy.indexUrl).hostname.toLowerCase();
      if (!policy.allowedHosts.includes(host)) {
        context.addIssue({ code: "custom", message: `index host ${host} must be in allowedHosts`, path: ["indexUrl"] });
      }
    }
  });

export type PrepPolicy = z.infer<typeof PrepPolicySchema>;
export type PrepPolicyInput = z.input<typeof PrepPolicySchema>;

export const DEFAULT_PREP_POLICY: PrepPolicy = PrepPolicySchema.parse({});

export function parsePrepPolicy(input: PrepPolicyInput = {}): PrepPolicy {
  const result = PrepPolicySchema.safeParse(input);
  if (!result.success) {
    throw new PrepError(
      "invalid_policy",
      `invalid preparation policy: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.data;
}

/** The index profile a run may use, validated against the administrator's policy. */
export function effectivePackageIndex(policy: PrepPolicy, profile: PackageIndexProfile): { indexUrl: string; allowedHosts: string[] } {
  const index = HttpsIndexSchema.safeParse(profile.indexUrl);
  if (!index.success)
    throw new PrepError("invalid_policy", `package index profile ${profile.id}: ${index.error.issues[0]?.message ?? "invalid index URL"}`);
  const hosts: string[] = [];
  for (const raw of profile.allowedHosts) {
    const host = AllowedHostSchema.safeParse(raw);
    if (!host.success)
      throw new PrepError("invalid_policy", `package index profile ${profile.id}: ${host.error.issues[0]?.message ?? "invalid host"}`);
    if (!policy.allowedHosts.includes(host.data)) {
      throw new PrepError(
        "invalid_policy",
        `package index profile ${profile.id} allows ${host.data}, which the administrator's DEJAML_PREP_ALLOWED_HOSTS does not`,
      );
    }
    if (!hosts.includes(host.data)) hosts.push(host.data);
  }
  const indexHost = new URL(profile.indexUrl).hostname.toLowerCase();
  if (!hosts.includes(indexHost))
    throw new PrepError("invalid_policy", `package index profile ${profile.id}: index host ${indexHost} must be one of its allowed hosts`);
  if (policy.indexUrl && policy.indexUrl.replace(/\/+$/u, "") !== profile.indexUrl.replace(/\/+$/u, "")) {
    throw new PrepError(
      "invalid_policy",
      `package index profile ${profile.id} uses ${profile.indexUrl}, but the administrator requires ${policy.indexUrl}`,
    );
  }
  if (profile.cpuOnly !== true) throw new PrepError("invalid_policy", "only CPU-only package index profiles are supported");
  return { indexUrl: profile.indexUrl, allowedHosts: hosts };
}

function positiveInteger(name: string, value: string): number {
  if (!/^\d{1,9}$/u.test(value.trim())) throw new PrepError("invalid_policy", `${name} must be a positive integer`);
  return Number(value.trim());
}

function flag(name: string, value: string): boolean {
  if (/^(1|true|yes)$/iu.test(value)) return true;
  if (/^(0|false|no)$/iu.test(value)) return false;
  throw new PrepError("invalid_policy", `${name} must be 1 or 0`);
}

/**
 * Build the policy from operator environment variables:
 * DEJAML_PREP_IMAGES (`3.11=python:3.11-slim-trixie@sha256:…,3.13=…`),
 * DEJAML_PREP_IMAGE (legacy single image, see below), DEJAML_PREP_IMAGE_ID,
 * DEJAML_PREP_PULL, DEJAML_PREP_RESOLVER_MODE, DEJAML_PREP_INDEX_URL,
 * DEJAML_PREP_ALLOWED_HOSTS (comma separated), DEJAML_PREP_MAX_PACKAGES,
 * DEJAML_PREP_MAX_FILE_MB, DEJAML_PREP_MAX_TOTAL_MB, DEJAML_PREP_MAX_TEMP_MB,
 * DEJAML_PREP_MAX_TEMP_INODES, DEJAML_PREP_MIN_FREE_MB, DEJAML_PREP_CA_BUNDLE.
 *
 * DEJAML_PREP_IMAGE is accepted for compatibility when it names an official
 * `python:3.X…-slim-trixie` image: pinned by digest, it replaces that
 * version's image; unpinned, the pinned default of the same Python line is
 * used (the preparer never runs a mutable tag). DEJAML_PREP_IMAGE_ID then
 * applies to that version.
 */
export function loadPrepPolicy(env: Record<string, string | undefined> = process.env): PrepPolicy {
  const input: Record<string, unknown> = {};
  const read = (key: string): string | undefined => {
    const value = env[key];
    return value === undefined || value.trim() === "" ? undefined : value.trim();
  };
  const images: Partial<Record<PythonVersion, string>> = { ...DEFAULT_PREP_IMAGES };
  const expectedImageIds: Partial<Record<PythonVersion, string>> = {};
  const legacy = read("DEJAML_PREP_IMAGE");
  if (legacy) {
    const match = /^(?:docker\.io\/)?(?:library\/)?python:(3\.1[0-3])(?:\.\d+)?-slim-trixie(@sha256:[a-f0-9]{64})?$/u.exec(legacy);
    if (!match?.[1]) {
      throw new PrepError(
        "invalid_policy",
        "DEJAML_PREP_IMAGE must be python:3.X[.Y]-slim-trixie[@sha256:…]; use DEJAML_PREP_IMAGES for other images",
      );
    }
    const version = match[1] as PythonVersion;
    if (match[2]) images[version] = legacy;
    const imageId = read("DEJAML_PREP_IMAGE_ID");
    if (imageId) expectedImageIds[version] = imageId;
  } else if (read("DEJAML_PREP_IMAGE_ID")) {
    throw new PrepError("invalid_policy", "DEJAML_PREP_IMAGE_ID needs DEJAML_PREP_IMAGE to say which Python version it pins");
  }
  const configured = read("DEJAML_PREP_IMAGES");
  if (configured) {
    for (const entry of configured
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")) {
      const equals = entry.indexOf("=");
      const version = PythonVersionSchema.safeParse(entry.slice(0, equals).trim());
      if (equals <= 0 || !version.success)
        throw new PrepError("invalid_policy", "DEJAML_PREP_IMAGES entries must look like 3.11=<image>@sha256:<digest>");
      images[version.data] = entry.slice(equals + 1).trim();
    }
  }
  input.images = images;
  input.expectedImageIds = expectedImageIds;
  const pull = read("DEJAML_PREP_PULL");
  if (pull) input.pullImages = flag("DEJAML_PREP_PULL", pull);
  const mode = read("DEJAML_PREP_RESOLVER_MODE");
  if (mode) input.resolverMode = mode;
  const indexUrl = read("DEJAML_PREP_INDEX_URL");
  if (indexUrl) input.indexUrl = indexUrl;
  const hosts = read("DEJAML_PREP_ALLOWED_HOSTS");
  if (hosts)
    input.allowedHosts = hosts
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host !== "");
  const maxPackages = read("DEJAML_PREP_MAX_PACKAGES");
  if (maxPackages) input.maxPackages = positiveInteger("DEJAML_PREP_MAX_PACKAGES", maxPackages);
  const maxFile = read("DEJAML_PREP_MAX_FILE_MB");
  if (maxFile) input.maxFileBytes = positiveInteger("DEJAML_PREP_MAX_FILE_MB", maxFile) * MIB;
  const maxTotal = read("DEJAML_PREP_MAX_TOTAL_MB");
  if (maxTotal) input.maxTotalBytes = positiveInteger("DEJAML_PREP_MAX_TOTAL_MB", maxTotal) * MIB;
  const maxTemp = read("DEJAML_PREP_MAX_TEMP_MB");
  if (maxTemp) input.maxTempBytes = positiveInteger("DEJAML_PREP_MAX_TEMP_MB", maxTemp) * MIB;
  const maxInodes = read("DEJAML_PREP_MAX_TEMP_INODES");
  if (maxInodes) input.maxTempInodes = positiveInteger("DEJAML_PREP_MAX_TEMP_INODES", maxInodes);
  const minFree = read("DEJAML_PREP_MIN_FREE_MB");
  if (minFree) input.minFreeBytes = positiveInteger("DEJAML_PREP_MIN_FREE_MB", minFree) * MIB;
  const caBundle = read("DEJAML_PREP_CA_BUNDLE");
  if (caBundle) input.caBundlePath = caBundle;
  return parsePrepPolicy(input as PrepPolicyInput);
}
