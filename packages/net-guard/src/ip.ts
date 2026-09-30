/**
 * Strict IP literal parsing and address classification.
 *
 * Only canonical dotted-quad IPv4 and RFC 4291 IPv6 text forms are accepted.
 * Anything a resolver or URL parser might *interpret* as an IPv4 address
 * (octal, hex, integer, short forms, leading zeros) is reported by
 * `looksLikeIpv4Variant` so callers can refuse it outright.
 */

export type IpFamily = 4 | 6;

export interface ParsedIp {
  readonly family: IpFamily;
  readonly bytes: Uint8Array;
}

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "unique_local"
  | "multicast"
  | "unspecified"
  | "broadcast"
  | "reserved"
  | "cloud_metadata"
  | "carrier_nat"
  | "documentation"
  | "benchmark"
  | "ipv4_mapped_blocked"
  | "invalid";

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)";
const IPV4_PATTERN = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const IPV6_CHARS = /^[0-9A-Fa-f:.]+$/;
const IPV6_GROUP = /^[0-9A-Fa-f]{1,4}$/;
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/i;

function parseIpv4(text: string): Uint8Array | null {
  if (!IPV4_PATTERN.test(text)) {
    return null;
  }
  return Uint8Array.from(text.split(".").map(Number));
}

function parseIpv6Groups(parts: string[], allowTrailingIpv4: boolean): number[] | null {
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.includes(".")) {
      if (!allowTrailingIpv4 || index !== parts.length - 1) {
        return null;
      }
      const v4 = parseIpv4(part);
      if (v4 === null) {
        return null;
      }
      groups.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      continue;
    }
    if (!IPV6_GROUP.test(part)) {
      return null;
    }
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function parseIpv6(text: string): Uint8Array | null {
  // Zone ids ("%eth0"), brackets and anything else outside the alphabet fail here.
  if (text.length < 2 || text.length > 45 || !IPV6_CHARS.test(text)) {
    return null;
  }
  const gap = text.indexOf("::");
  if (gap !== -1 && text.indexOf("::", gap + 1) !== -1) {
    return null;
  }

  let groups: number[];
  if (gap === -1) {
    const parsed = parseIpv6Groups(text.split(":"), true);
    if (parsed === null || parsed.length !== 8) {
      return null;
    }
    groups = parsed;
  } else {
    const headText = text.slice(0, gap);
    const tailText = text.slice(gap + 2);
    const head = parseIpv6Groups(headText === "" ? [] : headText.split(":"), false);
    const tail = parseIpv6Groups(tailText === "" ? [] : tailText.split(":"), true);
    if (head === null || tail === null || head.length + tail.length > 7) {
      return null;
    }
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/** Parses a canonical IPv4 dotted quad or an IPv6 literal (without brackets). */
export function parseIpLiteral(host: string): ParsedIp | null {
  if (host.includes(":")) {
    const bytes = parseIpv6(host);
    return bytes === null ? null : { family: 6, bytes };
  }
  const bytes = parseIpv4(host);
  return bytes === null ? null : { family: 4, bytes };
}

/**
 * True for hosts that are not canonical dotted quads but that URL parsers or
 * libc `inet_aton` may still read as IPv4: `0177.0.0.1`, `0x7f.1`,
 * `2130706433`, `127.1`, `127.000.000.001`. Mirrors the WHATWG rule that a
 * host whose last label is numeric is parsed as IPv4.
 */
export function looksLikeIpv4Variant(host: string): boolean {
  const lowered = host.toLowerCase();
  if (IPV4_PATTERN.test(lowered)) {
    return false;
  }
  const trimmed = lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
  if (trimmed === "") {
    return false;
  }
  const labels = trimmed.split(".");
  const last = labels[labels.length - 1] ?? "";
  return NUMERIC_LABEL.test(last);
}

type Rule = readonly [prefix: readonly number[], length: number, cls: AddressClass];

// Ordered most-specific first.
const IPV4_RULES: readonly Rule[] = [
  [[169, 254, 169, 254], 32, "cloud_metadata"], // AWS/GCP/Azure/OCI IMDS
  [[168, 63, 129, 16], 32, "cloud_metadata"], // Azure WireServer
  [[100, 100, 100, 200], 32, "cloud_metadata"], // Alibaba Cloud metadata
  [[255, 255, 255, 255], 32, "broadcast"],
  [[0], 8, "unspecified"],
  [[10], 8, "private"],
  [[100, 64], 10, "carrier_nat"],
  [[127], 8, "loopback"],
  [[169, 254], 16, "link_local"],
  [[172, 16], 12, "private"],
  [[192, 0, 0], 24, "reserved"],
  [[192, 0, 2], 24, "documentation"],
  [[192, 31, 196], 24, "reserved"],
  [[192, 52, 193], 24, "reserved"],
  [[192, 88, 99], 24, "reserved"],
  [[192, 168], 16, "private"],
  [[192, 175, 48], 24, "reserved"],
  [[198, 18], 15, "benchmark"],
  [[198, 51, 100], 24, "documentation"],
  [[203, 0, 113], 24, "documentation"],
  [[224], 4, "multicast"],
  [[240], 4, "reserved"],
];

function hexPrefix(groups: readonly number[]): number[] {
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

const IPV6_RULES: readonly Rule[] = [
  [hexPrefix([0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254]), 128, "cloud_metadata"], // AWS IMDS v6
  [hexPrefix([0x0064, 0xff9b, 0x0001]), 48, "reserved"], // local-use NAT64
  [hexPrefix([0x0100, 0, 0, 0]), 64, "reserved"], // discard-only
  [hexPrefix([0x2001, 0x0002, 0]), 48, "benchmark"],
  [hexPrefix([0x2001, 0x0db8]), 32, "documentation"],
  [hexPrefix([0x3fff, 0x0000]), 20, "documentation"],
  [hexPrefix([0x2001, 0x0000]), 23, "reserved"], // IETF assignments incl. Teredo, ORCHID
  [hexPrefix([0x5f00]), 16, "reserved"], // SRv6 SIDs
  [hexPrefix([0xfe80]), 10, "link_local"],
  [hexPrefix([0xfec0]), 10, "reserved"], // deprecated site-local
  [hexPrefix([0xfc00]), 7, "unique_local"],
  [hexPrefix([0xff00]), 8, "multicast"],
];

function inPrefix(bytes: Uint8Array, prefix: readonly number[], length: number): boolean {
  let remaining = length;
  for (let index = 0; remaining > 0; index += 1) {
    const want = prefix[index] ?? 0;
    const have = bytes[index] ?? 0;
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((want & mask) !== (have & mask)) {
      return false;
    }
    remaining -= bits;
  }
  return true;
}

function classifyIpv4(bytes: Uint8Array): AddressClass {
  for (const [prefix, length, cls] of IPV4_RULES) {
    if (inPrefix(bytes, prefix, length)) {
      return cls;
    }
  }
  return "public";
}

function allZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    if (bytes[index] !== 0) {
      return false;
    }
  }
  return true;
}

function classifyIpv6(bytes: Uint8Array): AddressClass {
  if (allZero(bytes, 0, 16)) {
    return "unspecified";
  }
  if (allZero(bytes, 0, 15) && bytes[15] === 1) {
    return "loopback";
  }
  // ::ffff:0:0/96 IPv4-mapped: never public, even when the embedded address is.
  if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const embedded = classifyIpv4(bytes.subarray(12, 16));
    return embedded === "public" ? "ipv4_mapped_blocked" : embedded;
  }
  // 64:ff9b::/96 NAT64 well-known prefix: judged by the embedded IPv4.
  if (inPrefix(bytes, hexPrefix([0x0064, 0xff9b, 0, 0, 0, 0]), 96)) {
    return classifyIpv4(bytes.subarray(12, 16));
  }
  // 2002::/16 6to4: judged by the embedded IPv4.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return classifyIpv4(bytes.subarray(2, 6));
  }
  for (const [prefix, length, cls] of IPV6_RULES) {
    if (inPrefix(bytes, prefix, length)) {
      return cls;
    }
  }
  // Only 2000::/3 is global unicast; everything else (incl. ::/8 IPv4-compatible) is reserved.
  if (((bytes[0] ?? 0) & 0xe0) !== 0x20) {
    return "reserved";
  }
  return "public";
}

/** Classifies an address; unparseable input (including IPv6 zone ids) is `invalid`. */
export function classifyAddress(ip: string | ParsedIp): AddressClass {
  const parsed = typeof ip === "string" ? parseIpLiteral(ip) : ip;
  if (parsed === null) {
    return "invalid";
  }
  if (parsed.family === 4 && parsed.bytes.length === 4) {
    return classifyIpv4(parsed.bytes);
  }
  if (parsed.family === 6 && parsed.bytes.length === 16) {
    return classifyIpv6(parsed.bytes);
  }
  return "invalid";
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string | ParsedIp): boolean {
  return classifyAddress(ip) === "public";
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes",
]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".internal",
  ".local",
  ".localdomain",
  ".home.arpa",
  ".arpa",
  ".svc",
];

/**
 * True for names that point at the local machine, cloud metadata services or
 * private naming zones regardless of what DNS says.
 */
export function isBlockedHostname(host: string): boolean {
  let name = host.toLowerCase();
  while (name.endsWith(".")) {
    name = name.slice(0, -1);
  }
  if (name === "" || BLOCKED_HOSTNAMES.has(name)) {
    return true;
  }
  return BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
