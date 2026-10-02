import { PrepError, type AcceleratorRefusalEvidence } from "./errors.js";
import { normalizePackageName, type ParsedRequirement } from "./requirements.js";

/**
 * CPU-only policy. Every PlatformSpec today has `accelerator: "cpu_only"`,
 * and there is deliberately no configuration that turns accelerator packages
 * back on: CUDA, ROCm, TPU and vendor GPU runtimes are refused both when they
 * are requested and when the resolver pulls them in transitively (PyPI's
 * `torch` on linux/x86_64 depends on a dozen `nvidia-*` wheels).
 */

export type AcceleratorFinding = {
  /** PEP 503 normalized name. */
  name: string;
  /** What was requested or resolved, e.g. `torch==2.3.0+cu121` or `nvidia-cublas-cu12==12.1.3.1`. */
  spec: string;
  reason: string;
  /** `requested` when the repository or caller asked for it, `resolved` when it arrived transitively. */
  origin: "requested" | "resolved" | "constraint";
};

const NAME_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^nvidia-/u, "NVIDIA CUDA runtime or library package"],
  [/^cuda-/u, "CUDA toolkit package"],
  [/^pycuda$/u, "CUDA binding"],
  [/^cupy-(cuda|rocm)/u, "CuPy GPU build"],
  [/(^|-)cuda\d*x?(-|$)/u, "CUDA-specific package"],
  [/-cu\d{2,3}x?$/u, "CUDA-specific build variant"],
  [/^rocm-|(^|-)rocm\d*(-|$)/u, "ROCm package"],
  [/^(triton|pytorch-triton|pytorch-triton-rocm|pytorch-triton-xpu)$/u, "Triton GPU compiler"],
  [/^tensorflow-gpu$/u, "TensorFlow GPU build"],
  [/-gpu$/u, "GPU build variant"],
  [/^onnxruntime-(rocm|directml|migraphx|training)$/u, "ONNX Runtime accelerator build"],
  [/^(tensorrt|tensorrt-.+|torch-tensorrt)$/u, "NVIDIA TensorRT"],
  [/^libtpu(-nightly)?$/u, "TPU runtime"],
  [/^(intel-sycl-rt|intel-opencl-rt|dpcpp-cpp-rt|level-zero|intel-level-zero-gpu|intel-pti)$/u, "Intel GPU runtime"],
];

/** Local version labels of accelerator builds: torch==2.3.0+cu121, torch==2.3.0+rocm6.0, ipex+xpu. */
const LOCAL_VERSION = /\+(cu\d+|cuda\d*|rocm[\d.]*|xpu|gpu)/iu;
/** Extras that select accelerator builds: jax[cuda12], tensorflow[and-cuda], intel-extension-for-tensorflow[xpu]. */
const EXTRA = /^(and-)?(cuda|rocm|gpu|tpu|xpu)/u;

/**
 * The same denylist as regular-expression sources for the download guard that runs inside the
 * preparation container (`pip-entry.ts`); the sources use only syntax Python's `re` shares.
 */
export const ACCELERATOR_PATTERN_SOURCES: { names: [string, string][]; localVersion: string } = {
  names: NAME_RULES.map(([pattern, reason]) => [pattern.source, reason]),
  localVersion: LOCAL_VERSION.source,
};

/** Why this package is refused under the CPU-only policy, or null when it is allowed. */
export function acceleratorReason(name: string, version: string | null = null, extras: readonly string[] = []): string | null {
  const normalized = normalizePackageName(name);
  for (const [pattern, reason] of NAME_RULES) if (pattern.test(normalized)) return reason;
  if (version && LOCAL_VERSION.test(version)) return `accelerator build (${version})`;
  const extra = extras.map(normalizePackageName).find((value) => EXTRA.test(value));
  if (extra) return `accelerator extra [${extra}]`;
  return null;
}

/** Accelerator requirements among the requested ones (checked before anything is downloaded). */
export function findAcceleratorRequirements(
  requirements: readonly Pick<ParsedRequirement, "name" | "extras" | "specifiers" | "spec">[],
  origin: "requested" | "constraint" = "requested",
): AcceleratorFinding[] {
  const findings: AcceleratorFinding[] = [];
  for (const requirement of requirements) {
    let reason = acceleratorReason(requirement.name, null, requirement.extras);
    if (!reason) {
      const local = requirement.specifiers.find((specifier) => LOCAL_VERSION.test(specifier.version));
      if (local) reason = `accelerator build (${local.version})`;
    }
    if (reason) findings.push({ name: requirement.name, spec: requirement.spec, reason, origin });
  }
  return findings;
}

/** Accelerator packages in a resolved (transitive) set. */
export function findAcceleratorPackages(packages: readonly { name: string; version: string }[]): AcceleratorFinding[] {
  return packages.flatMap((pkg) => {
    const reason = acceleratorReason(pkg.name, pkg.version);
    return reason
      ? [{ name: normalizePackageName(pkg.name), spec: `${pkg.name}==${pkg.version}`, reason, origin: "resolved" as const }]
      : [];
  });
}

export { isAcceleratorIndexUrl } from "./requirements.js";

/** Accelerator packages named in a failed pip run (the package it could not find, or a dependency it reported). */
export function findAcceleratorPackagesInPipOutput(stderr: string): AcceleratorFinding[] {
  const findings = new Map<string, AcceleratorFinding>();
  const pattern =
    /(?:No matching distribution found for|Could not find a version that satisfies the requirement|depends on)\s+([A-Za-z0-9][A-Za-z0-9._-]*)([^\s;)]*)(?:\s+\(from ([A-Za-z0-9][A-Za-z0-9._-]*))?/gu;
  for (const match of stderr.matchAll(pattern)) {
    const raw = match[1] ?? "";
    const name = normalizePackageName(raw);
    const reason = acceleratorReason(name);
    if (!reason || findings.has(name)) continue;
    const parent = match[3] ? ` (dependency of ${normalizePackageName(match[3])})` : "";
    findings.set(name, { name, spec: `${raw}${match[2] ?? ""}${parent}`.slice(0, 200), reason, origin: "resolved" });
  }
  return [...findings.values()];
}

export function acceleratorError(
  findings: readonly AcceleratorFinding[],
  options: { stage?: AcceleratorRefusalEvidence["stage"]; detail?: string } = {},
): PrepError {
  const names = [...new Set(findings.map((finding) => finding.name))].sort();
  const listed = findings
    .slice(0, 20)
    .map((finding) => `${finding.spec} (${finding.origin}: ${finding.reason})`)
    .join("; ");
  const transitive = findings.some((finding) => finding.origin === "resolved");
  return new PrepError(
    "accelerator_package_refused",
    `the CPU-only policy refuses accelerator packages${transitive ? " (including transitive dependencies)" : ""}: ${listed}` +
      (findings.length > 20 ? `; and ${findings.length - 20} more` : "") +
      ". Nothing was downloaded. Use a CPU build of the package or an approved prebuilt image.",
    {
      refused: names,
      ...(names[0] ? { requirement: names[0] } : {}),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      evidence: {
        kind: "accelerator_refusal",
        stage: options.stage ?? (transitive ? "resolution_report" : "before_resolution"),
        findings: findings.map((finding) => ({ ...finding })),
        platform: null,
        platformKey: null,
        resolverMode: null,
        image: null,
        wheelsDownloaded: 0,
      },
    },
  );
}
