import { z } from "zod";

/**
 * The execution platform of a study. One PlatformSpec is chosen per run and
 * used everywhere a platform matters: preparation-image selection, wheel
 * resolution, dependency validation, lab creation, cache keys, plan
 * validation, evidence receipts, and cleanup receipts. Nothing resolves wheels
 * for one architecture and runs them on another.
 */

export const ArchitectureSchema = z.enum(["amd64", "arm64"]);
export type Architecture = z.infer<typeof ArchitectureSchema>;

export const ContainerPlatformSchema = z.enum(["linux/amd64", "linux/arm64"]);
export type ContainerPlatform = z.infer<typeof ContainerPlatformSchema>;

/** CPython minor versions a study may run on. */
export const PythonVersionSchema = z.enum(["3.10", "3.11", "3.12", "3.13"]);
export type PythonVersion = z.infer<typeof PythonVersionSchema>;

export const AcceleratorPolicySchema = z.enum(["cpu_only"]);
export type AcceleratorPolicy = z.infer<typeof AcceleratorPolicySchema>;

export const PackageIndexProfileSchema = z.object({
  /** Administrator-chosen profile name, such as `pypi-cpu`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  /** PEP 503 simple index, HTTPS only. */
  indexUrl: z.url().refine((value) => value.startsWith("https://"), "the package index must use HTTPS"),
  /** Hosts the preparation container may reach (the index and its file host). */
  allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(8),
  /** Only CPU packages: CUDA, ROCm and other accelerator runtimes are refused. */
  cpuOnly: z.literal(true),
});
export type PackageIndexProfile = z.infer<typeof PackageIndexProfileSchema>;

export const PlatformSpecSchema = z.object({
  os: z.literal("linux"),
  architecture: ArchitectureSchema,
  containerPlatform: ContainerPlatformSchema,
  python: z.object({
    version: PythonVersionSchema,
    /** The CPython ABI tag, such as `cp311`. */
    abi: z.string().regex(/^cp3\d{2}$/u),
    implementation: z.literal("cp"),
  }),
  /** glibc-based images only; the minimum manylinux glibc the image satisfies. */
  libc: z.object({ family: z.literal("glibc"), version: z.string().regex(/^2\.\d{2}$/u) }),
  accelerator: AcceleratorPolicySchema,
  packageIndex: PackageIndexProfileSchema,
});
export type PlatformSpec = z.infer<typeof PlatformSpecSchema>;

/** The PyPI profile used unless the administrator configures another. */
export const DEFAULT_PACKAGE_INDEX: PackageIndexProfile = {
  id: "pypi-cpu",
  indexUrl: "https://pypi.org/simple",
  allowedHosts: ["pypi.org", "files.pythonhosted.org"],
  cpuOnly: true,
};

/** Debian trixie (the slim Python images) ships glibc 2.41. */
export const DEFAULT_GLIBC = "2.41";

export const PLATFORM_TARGETS = {
  /** Apple Silicon development: arm64 Linux containers. */
  "apple-silicon-dev": { architecture: "arm64" },
  /** Intel development machines: amd64 Linux containers. */
  "intel-dev": { architecture: "amd64" },
  /** AWS CPU production: amd64 by default; Graviton workers may choose arm64. */
  "aws-cpu": { architecture: "amd64" },
} as const satisfies Record<string, { architecture: Architecture }>;
export type PlatformTarget = keyof typeof PLATFORM_TARGETS;

export function containerPlatformFor(architecture: Architecture): ContainerPlatform {
  return architecture === "amd64" ? "linux/amd64" : "linux/arm64";
}

export function pythonAbi(version: PythonVersion): string {
  return `cp${version.replace(".", "")}`;
}

export function buildPlatformSpec(options: {
  architecture: Architecture;
  python: PythonVersion;
  packageIndex?: PackageIndexProfile;
  glibc?: string;
}): PlatformSpec {
  return PlatformSpecSchema.parse({
    os: "linux",
    architecture: options.architecture,
    containerPlatform: containerPlatformFor(options.architecture),
    python: { version: options.python, abi: pythonAbi(options.python), implementation: "cp" },
    libc: { family: "glibc", version: options.glibc ?? DEFAULT_GLIBC },
    accelerator: "cpu_only",
    packageIndex: options.packageIndex ?? DEFAULT_PACKAGE_INDEX,
  });
}

/** The architecture of the machine running Docker, from Node's `process.arch`. */
export function hostArchitecture(nodeArch: string): Architecture | null {
  if (nodeArch === "x64") return "amd64";
  if (nodeArch === "arm64") return "arm64";
  return null;
}

/**
 * Resolves the platform from administrator settings. `DEJAML_PLATFORM` is
 * `linux/amd64`, `linux/arm64`, a target name from PLATFORM_TARGETS, or
 * unset for the host architecture. `DEJAML_PYTHON_VERSION` defaults to 3.11.
 */
export function platformFromEnv(env: Record<string, string | undefined>, nodeArch: string): PlatformSpec {
  const raw = env.DEJAML_PLATFORM?.trim();
  let architecture: Architecture | null;
  if (!raw || raw === "auto") {
    architecture = hostArchitecture(nodeArch);
    if (!architecture) throw new Error(`unsupported host architecture ${nodeArch}; set DEJAML_PLATFORM to linux/amd64 or linux/arm64`);
  } else if (raw in PLATFORM_TARGETS) {
    architecture = PLATFORM_TARGETS[raw as PlatformTarget].architecture;
  } else {
    const parsed = ContainerPlatformSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`DEJAML_PLATFORM must be linux/amd64, linux/arm64, auto, or one of ${Object.keys(PLATFORM_TARGETS).join(", ")}`);
    architecture = parsed.data === "linux/amd64" ? "amd64" : "arm64";
  }
  const python = PythonVersionSchema.safeParse(env.DEJAML_PYTHON_VERSION?.trim() || "3.11");
  if (!python.success) throw new Error(`DEJAML_PYTHON_VERSION must be one of ${PythonVersionSchema.options.join(", ")}`);
  return buildPlatformSpec({ architecture, python: python.data });
}

/** The manylinux machine name used in wheel platform tags. */
export function wheelMachine(architecture: Architecture): "x86_64" | "aarch64" {
  return architecture === "amd64" ? "x86_64" : "aarch64";
}

export type WheelTags = { python: string[]; abi: string[]; platform: string[] };

/** Parses the tag triple of a wheel file name (PEP 427). Returns null for a non-wheel name. */
export function parseWheelTags(fileName: string): WheelTags | null {
  if (!fileName.endsWith(".whl")) return null;
  const parts = fileName.slice(0, -4).split("-");
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [pythonTag, abiTag, platformTag] = parts.slice(-3) as [string, string, string];
  return { python: pythonTag.split("."), abi: abiTag.split("."), platform: platformTag.split(".") };
}

/**
 * Whether a wheel can be installed on the platform: pure-Python wheels, or a
 * manylinux wheel for the platform's machine and a glibc no newer than the
 * image's, built for the platform's CPython (or the stable ABI).
 */
export function wheelMatchesPlatform(fileName: string, platform: PlatformSpec): { ok: true } | { ok: false; reason: string } {
  const tags = parseWheelTags(fileName);
  if (!tags) return { ok: false, reason: `${fileName} is not a wheel` };
  const machine = wheelMachine(platform.architecture);
  const [imageMajor, imageMinor] = platform.libc.version.split(".").map(Number) as [number, number];
  const platformOk = tags.platform.some((tag) => {
    if (tag === "any") return true;
    const legacy = /^manylinux(1|2010|2014)_(\w+)$/u.exec(tag);
    if (legacy) {
      const glibc = { "1": [2, 5], "2010": [2, 12], "2014": [2, 17] }[legacy[1] as "1" | "2010" | "2014"] as [number, number];
      return legacy[2] === machine && (glibc[0] < imageMajor || (glibc[0] === imageMajor && glibc[1] <= imageMinor));
    }
    const modern = /^manylinux_(\d+)_(\d+)_(\w+)$/u.exec(tag);
    if (modern) {
      const major = Number(modern[1]);
      const minor = Number(modern[2]);
      return modern[3] === machine && (major < imageMajor || (major === imageMajor && minor <= imageMinor));
    }
    return false;
  });
  if (!platformOk) return { ok: false, reason: `${fileName} is not built for ${platform.containerPlatform} (glibc ${platform.libc.version})` };
  const abi = platform.python.abi;
  const pure = tags.abi.includes("none") && tags.python.some((tag) => tag === "py3" || tag === "py2.py3" || /^py3\d*$/u.test(tag) || tag === abi);
  const exact = tags.abi.includes(abi) && tags.python.includes(abi);
  const stable = tags.abi.includes("abi3") && tags.python.some((tag) => /^cp3\d+$/u.test(tag) && Number(tag.slice(3)) <= Number(abi.slice(3)));
  if (!pure && !exact && !stable) return { ok: false, reason: `${fileName} is not built for CPython ${platform.python.version}` };
  return { ok: true };
}

/** A stable cache-key component, so caches never mix platforms or Python versions. */
export function platformCacheKey(platform: PlatformSpec): string {
  return `${platform.containerPlatform.replace("/", "-")}-${platform.python.abi}-glibc${platform.libc.version}-${platform.accelerator}-${platform.packageIndex.id}`;
}
