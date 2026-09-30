import type { NetGuardErrorCode } from "./errors.js";

export type ArchiveErrorCode =
  | "archive_unsafe_path"
  | "archive_too_large"
  | "archive_too_many_files"
  | "archive_ratio_exceeded"
  | "archive_unsupported"
  | "archive_corrupt";

export type DatasetErrorCode = NetGuardErrorCode | ArchiveErrorCode | "checksum_required" | "cleanup_refused";

/**
 * How the orchestrator must classify a failed acquisition:
 * - `policy_blocked`: the request is outside policy (host, address, scheme,
 *   size, missing required checksum, unsafe archive). Retrying cannot help.
 * - `inconclusive`: the dataset could not be obtained as approved
 *   (unavailable, network failure, checksum changed). Never substitute data.
 */
export type DatasetFailurePolicy = "policy_blocked" | "inconclusive";

const INCONCLUSIVE: ReadonlySet<DatasetErrorCode> = new Set<DatasetErrorCode>([
  "dns_failed",
  "http_error",
  "timeout",
  "cancelled",
  "request_failed",
  "tls_failed",
  "checksum_mismatch",
  "destination_exists",
]);

/** Maps an error code to its orchestrator verdict; unknown codes are treated as policy blocks. */
export function datasetFailurePolicy(code: DatasetErrorCode): DatasetFailurePolicy {
  return INCONCLUSIVE.has(code) ? "inconclusive" : "policy_blocked";
}

/** Every refusal or failure of a dataset acquisition, extraction or cleanup. */
export class DatasetError extends Error {
  readonly policy: DatasetFailurePolicy;

  constructor(
    readonly code: DatasetErrorCode,
    message: string = code,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DatasetError";
    this.policy = datasetFailurePolicy(code);
  }
}
