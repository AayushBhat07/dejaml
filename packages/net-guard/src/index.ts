export { NetGuardError, type NetGuardErrorCode } from "./errors.js";
export {
  type AddressClass,
  classifyAddress,
  type IpFamily,
  isBlockedHostname,
  isPublicAddress,
  looksLikeIpv4Variant,
  parseIpLiteral,
  type ParsedIp,
} from "./ip.js";
export {
  type FetchPolicy,
  hostMatchesAllowlist,
  isPlainDnsName,
  MAX_URL_LENGTH,
  validateFetchUrl,
} from "./url-policy.js";
export {
  type AddressPolicy,
  createPinnedLookup,
  defaultResolver,
  type ResolvedAddress,
  type ResolvedHost,
  type Resolver,
  resolvePublic,
} from "./dns.js";
export {
  DEFAULT_USER_AGENT,
  type DownloadReceipt,
  type HttpsTransport,
  MAX_POLICY_REDIRECTS,
  safeDownload,
  type SafeDownloadOptions,
} from "./fetch.js";
export {
  acquireDataset,
  type AcquireDatasetOptions,
  DATASET_MAX_BYTES,
  type DatasetReceipt,
  DEFAULT_DATASET_POLICY,
  isSafeFileName,
  parseAllowedHosts,
} from "./dataset.js";
