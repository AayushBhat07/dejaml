export type PrepErrorCode =
  | "no_compatible_wheel"
  | "resolution_conflict"
  | "egress_denied"
  | "limit_exceeded"
  | "timeout"
  | "cancelled"
  | "invalid_requirement"
  | "invalid_policy"
  | "image_mismatch"
  | "integrity_error"
  /** The preparation image for the requested Python version and platform is not available locally (and was not pulled). */
  | "image_unavailable"
  /** A wheel, image, or interpreter does not match the requested PlatformSpec. */
  | "platform_mismatch"
  /** CPU-only policy: a CUDA, ROCm, or other accelerator package was requested or resolved. */
  | "accelerator_package_refused"
  /** Not enough free disk space, or the per-run byte/inode quota was exceeded. */
  | "insufficient_preparation_space"
  | "runtime_error";

/** One package the CPU-only policy refused, and why. */
export type AcceleratorFindingRecord = {
  name: string;
  spec: string;
  reason: string;
  origin: "requested" | "resolved" | "constraint";
};

/**
 * Typed evidence attached to every `accelerator_package_refused` error: what was refused, at
 * which stage, for which platform and preparation image, and that no wheel was downloaded.
 */
export type AcceleratorRefusalEvidence = {
  kind: "accelerator_refusal";
  /**
   * `before_resolution`: requested or constrained by name, refused before any container existed;
   * `resolution_report`: in the resolver's transitive set; `resolver_failure`: the resolver failed on an
   * accelerator dependency (for example no wheel of `nvidia-…` for this platform); `download_guard`: the
   * guard inside the preparation container stopped pip before it fetched an accelerator wheel; `before_download`:
   * re-validation of a resolution handed to `downloadWheels`.
   */
  stage: "before_resolution" | "resolution_report" | "resolver_failure" | "download_guard" | "before_download";
  findings: AcceleratorFindingRecord[];
  platform: string | null;
  platformKey: string | null;
  resolverMode: string | null;
  image: { digest: string; platformDigest: string | null; platform: string } | null;
  /** Always 0: refusals happen before any wheel reaches the download directory or the cache. */
  wheelsDownloaded: 0;
};

export type PrepCleanupReceipt = {
  prepId: string;
  containersRemoved: string[];
  networkRemoved: boolean;
  tempRemoved: boolean;
  /** `docker ps -a` and `docker network ls` filtered by the prep label both came back empty. */
  verifiedAbsent: boolean;
};

export type PrepErrorOptions = {
  /** Last 4 KB of pip stderr, or other diagnostic text. */
  detail?: string;
  /** Normalized requirement name the failure is about, when known. */
  requirement?: string;
  cleanup?: PrepCleanupReceipt;
  /** Normalized names of the packages a policy refused (accelerator or platform checks). */
  refused?: string[];
  evidence?: AcceleratorRefusalEvidence;
};

export class PrepError extends Error {
  readonly code: PrepErrorCode;
  readonly detail: string | undefined;
  readonly requirement: string | undefined;
  readonly refused: string[];
  cleanup: PrepCleanupReceipt | undefined;
  evidence: AcceleratorRefusalEvidence | undefined;

  constructor(code: PrepErrorCode, message: string, options: PrepErrorOptions = {}) {
    super(message);
    this.name = "PrepError";
    this.code = code;
    this.detail = options.detail;
    this.requirement = options.requirement;
    this.refused = options.refused ?? [];
    this.cleanup = options.cleanup;
    this.evidence = options.evidence;
  }
}
