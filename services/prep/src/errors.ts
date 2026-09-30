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
};

export class PrepError extends Error {
  readonly code: PrepErrorCode;
  readonly detail: string | undefined;
  readonly requirement: string | undefined;
  readonly refused: string[];
  cleanup: PrepCleanupReceipt | undefined;

  constructor(code: PrepErrorCode, message: string, options: PrepErrorOptions = {}) {
    super(message);
    this.name = "PrepError";
    this.code = code;
    this.detail = options.detail;
    this.requirement = options.requirement;
    this.refused = options.refused ?? [];
    this.cleanup = options.cleanup;
  }
}
