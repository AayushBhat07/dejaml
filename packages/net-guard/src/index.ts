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
export { type FetchPolicy, hostMatchesAllowlist, isPlainDnsName, MAX_URL_LENGTH, validateFetchUrl } from "./url-policy.js";
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
  createGuardedFetch,
  DEFAULT_ENDPOINT_USER_AGENT,
  type EndpointAccess,
  endpointAddressAllowed,
  type EndpointPolicy,
  type EndpointTransport,
  type GuardedFetch,
  type GuardedFetchOptions,
  validateEndpointUrl,
} from "./endpoint.js";
export {
  acquireDataset,
  type AcquireDatasetOptions,
  DATASET_MAX_BYTES,
  type DatasetReceipt,
  DEFAULT_DATASET_POLICY,
  isSafeFileName,
  parseAllowedHosts,
} from "./dataset.js";
export {
  acquireLabDataset,
  cleanupDataset,
  type CleanupReceipt,
  type DatasetExtraction,
  type DatasetIdentity,
  LAB_DATASET_DOWNLOAD_DIR,
  LAB_DATASET_EXTRACTED_DIR,
  type LabDataset,
  type LabDatasetOptions,
} from "./dataset.js";
export {
  type ArchiveErrorCode,
  DatasetError,
  type DatasetErrorCode,
  datasetFailurePolicy,
  type DatasetFailurePolicy,
} from "./dataset-errors.js";
export {
  type ArchiveFormat,
  type ArchiveLimits,
  crc32,
  DEFAULT_ARCHIVE_LIMITS,
  detectArchiveFormat,
  extractArchive,
  type ExtractArchiveOptions,
  type ExtractedFile,
  type ExtractionResult,
  listingDigest,
  normalizeEntryPath,
} from "./archive.js";
