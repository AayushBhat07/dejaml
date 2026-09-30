export type NetGuardErrorCode =
  | "invalid_url"
  | "scheme_not_allowed"
  | "credentials_in_url"
  | "host_not_allowed"
  | "ip_literal_not_allowed"
  | "port_not_allowed"
  | "unsafe_hostname"
  | "unix_socket"
  | "private_address"
  | "dns_failed"
  | "pinning_violation"
  | "too_many_redirects"
  | "http_error"
  | "response_too_large"
  | "timeout"
  | "cancelled"
  | "request_failed"
  | "tls_failed"
  | "checksum_mismatch"
  | "invalid_checksum"
  | "destination_exists"
  | "unsafe_file_name"
  | "invalid_allowlist"
  | "invalid_policy";

/** Every refusal or failure at the network boundary carries a stable code. */
export class NetGuardError extends Error {
  constructor(
    readonly code: NetGuardErrorCode,
    message: string = code,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "NetGuardError";
  }
}
