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
};

export class PrepError extends Error {
  readonly code: PrepErrorCode;
  readonly detail: string | undefined;
  readonly requirement: string | undefined;
  cleanup: PrepCleanupReceipt | undefined;

  constructor(code: PrepErrorCode, message: string, options: PrepErrorOptions = {}) {
    super(message);
    this.name = "PrepError";
    this.code = code;
    this.detail = options.detail;
    this.requirement = options.requirement;
    this.cleanup = options.cleanup;
  }
}
