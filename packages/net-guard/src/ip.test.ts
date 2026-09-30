import { describe, expect, it } from "vitest";

import { type AddressClass, classifyAddress, isBlockedHostname, isPublicAddress, looksLikeIpv4Variant, parseIpLiteral } from "./ip.js";

describe("parseIpLiteral", () => {
  it("parses canonical IPv4", () => {
    expect(parseIpLiteral("192.0.2.1")).toEqual({ family: 4, bytes: Uint8Array.from([192, 0, 2, 1]) });
  });

  it("parses IPv6 forms including :: and embedded IPv4", () => {
    expect(parseIpLiteral("::")?.bytes).toEqual(new Uint8Array(16));
    expect(parseIpLiteral("::1")?.bytes[15]).toBe(1);
    expect(parseIpLiteral("1:2:3:4:5:6:7::")?.family).toBe(6);
    const mapped = parseIpLiteral("::ffff:127.0.0.1");
    expect(mapped?.family).toBe(6);
    expect([...(mapped?.bytes ?? [])].slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    expect(parseIpLiteral("2001:DB8:0:0:0:0:0:1")?.family).toBe(6);
  });

  it.each([
    "::1::",
    "1:2:3:4:5:6:7:8:9",
    "[::1",
    "[::1]",
    "gggg::1",
    ":::1",
    "1:2:3:4:5:6:7:8::",
    ":1:2:3:4:5:6:7",
    "1::2::3",
    "12345::1",
    "fe80::1%eth0",
    "1.2.3.4::",
    "::1.2.3",
    "::ffff:127.0.0.01",
    "",
  ])("rejects malformed IPv6 %j", (text) => {
    expect(parseIpLiteral(text)).toBeNull();
  });

  it.each(["0177.0.0.1", "0x7f.1", "2130706433", "127.1", "127.000.000.001", "01.2.3.4", "256.1.1.1", "1.2.3"])(
    "rejects non-canonical IPv4 %j",
    (text) => {
      expect(parseIpLiteral(text)).toBeNull();
    },
  );
});

describe("looksLikeIpv4Variant", () => {
  it.each(["0177.0.0.1", "0x7f.1", "0x7f000001", "2130706433", "127.1", "127.000.000.001", "127.0.0.1.", "example.123"])(
    "flags %j",
    (host) => {
      expect(looksLikeIpv4Variant(host)).toBe(true);
    },
  );

  it.each(["127.0.0.1", "example.com", "1.2.3.example", "data.example.test"])("does not flag %j", (host) => {
    expect(looksLikeIpv4Variant(host)).toBe(false);
  });
});

describe("classifyAddress", () => {
  const cases: Array<[string, AddressClass]> = [
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["10.0.0.5", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.1", "carrier_nat"],
    ["100.127.255.255", "carrier_nat"],
    ["100.128.0.1", "public"],
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["169.254.1.1", "link_local"],
    ["169.254.169.254", "cloud_metadata"],
    ["172.16.3.4", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.0.0.8", "reserved"],
    ["192.0.2.10", "documentation"],
    ["192.168.1.1", "private"],
    ["198.18.0.1", "benchmark"],
    ["198.19.255.255", "benchmark"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["8.8.8.8", "public"],
    ["93.184.216.34", "public"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fe80::1", "link_local"],
    ["febf::1", "link_local"],
    ["fc00::1", "unique_local"],
    ["fd00::1", "unique_local"],
    ["ff02::1", "multicast"],
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "cloud_metadata"],
    ["64:ff9b::808:808", "public"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.1.2.3", "private"],
    ["::ffff:169.254.169.254", "cloud_metadata"],
    ["::ffff:8.8.8.8", "ipv4_mapped_blocked"],
    ["2001:db8::1", "documentation"],
    ["100::1", "reserved"],
    ["fd00:ec2::254", "cloud_metadata"],
    ["2002:7f00:1::1", "loopback"],
    ["2002:c0a8:101::1", "private"],
    ["2002:808:808::1", "public"],
    ["2001::1", "reserved"],
    ["::127.0.0.1", "reserved"],
    ["2606:4700:4700::1111", "public"],
    ["2a00:1450:4001::1", "public"],
    ["4000::1", "reserved"],
    ["not-an-ip", "invalid"],
    ["fe80::1%eth0", "invalid"],
  ];

  it.each(cases)("classifies %s as %s", (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it("isPublicAddress is true only for public", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isPublicAddress("garbage")).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST.",
    "api.localhost",
    "metadata",
    "metadata.google.internal",
    "instance-data",
    "instance-data.ec2.internal",
    "anything.internal",
    "printer.local",
  ])("blocks %s", (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });

  it.each(["archive.ics.uci.edu", "zenodo.org", "internal.example.com"])("allows %s", (host) => {
    expect(isBlockedHostname(host)).toBe(false);
  });
});
