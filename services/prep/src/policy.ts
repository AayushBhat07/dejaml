import { isAbsolute } from "node:path";

import { z } from "zod";

import { PrepError } from "./errors.js";

const MIB = 1024 * 1024;
const HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z][a-z0-9-]*[a-z0-9]$/u;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u;

export const AllowedHostSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().regex(HOST_PATTERN, "allowed hosts must be DNS names (no IP literals, ports or wildcards)"));

export const PrepPolicySchema = z
  .object({
    /** Downloader image. It must already be present locally: pulls are never implicit. */
    image: z.string().regex(IMAGE_PATTERN).default("python:3.13.15-slim-trixie"),
    /** When set, the image's `docker image inspect` ID must equal this before anything runs. */
    expectedImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
    indexUrl: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:", "the package index must use https")
      .refine((value) => {
        const url = new URL(value);
        return url.username === "" && url.password === "" && url.port === "";
      }, "the package index URL must not contain credentials or a port")
      .default("https://pypi.org/simple"),
    allowedHosts: z.array(AllowedHostSchema).min(1).max(16).default(["pypi.org", "files.pythonhosted.org"]),
    maxPackages: z.number().int().min(1).max(2000).default(150),
    maxFileBytes: z.number().int().min(1).max(4096 * MIB).default(150 * MIB),
    maxTotalBytes: z.number().int().min(1).max(64 * 1024 * MIB).default(800 * MIB),
    timeoutSeconds: z.number().int().min(10).max(7200).default(600),
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
    const host = new URL(policy.indexUrl).hostname.toLowerCase();
    if (!policy.allowedHosts.includes(host)) {
      context.addIssue({ code: "custom", message: `index host ${host} must be in allowedHosts`, path: ["indexUrl"] });
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

function positiveInteger(name: string, value: string): number {
  if (!/^\d{1,9}$/u.test(value.trim())) throw new PrepError("invalid_policy", `${name} must be a positive integer`);
  return Number(value.trim());
}

/**
 * Build the policy from operator environment variables:
 * DEJAML_PREP_IMAGE, DEJAML_PREP_IMAGE_ID, DEJAML_PREP_INDEX_URL (https only),
 * DEJAML_PREP_ALLOWED_HOSTS (comma separated), DEJAML_PREP_MAX_PACKAGES,
 * DEJAML_PREP_MAX_TOTAL_MB, DEJAML_PREP_CA_BUNDLE.
 */
export function loadPrepPolicy(env: Record<string, string | undefined> = process.env): PrepPolicy {
  const input: Record<string, unknown> = {};
  const read = (key: string): string | undefined => {
    const value = env[key];
    return value === undefined || value.trim() === "" ? undefined : value.trim();
  };
  const image = read("DEJAML_PREP_IMAGE");
  if (image) input.image = image;
  const imageId = read("DEJAML_PREP_IMAGE_ID");
  if (imageId) input.expectedImageId = imageId;
  const indexUrl = read("DEJAML_PREP_INDEX_URL");
  if (indexUrl) input.indexUrl = indexUrl;
  const hosts = read("DEJAML_PREP_ALLOWED_HOSTS");
  if (hosts) input.allowedHosts = hosts.split(",").map((host) => host.trim()).filter((host) => host !== "");
  const maxPackages = read("DEJAML_PREP_MAX_PACKAGES");
  if (maxPackages) input.maxPackages = positiveInteger("DEJAML_PREP_MAX_PACKAGES", maxPackages);
  const maxTotal = read("DEJAML_PREP_MAX_TOTAL_MB");
  if (maxTotal) input.maxTotalBytes = positiveInteger("DEJAML_PREP_MAX_TOTAL_MB", maxTotal) * MIB;
  const caBundle = read("DEJAML_PREP_CA_BUNDLE");
  if (caBundle) input.caBundlePath = caBundle;
  return parsePrepPolicy(input as PrepPolicyInput);
}
