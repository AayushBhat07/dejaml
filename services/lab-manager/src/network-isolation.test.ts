import { describe, expect, it } from "vitest";

import { evaluateNetworkIsolation, type NetworkObservation, type ObservedInterface } from "./network-isolation.js";

const LO: ObservedInterface = { name: "lo", flags: 0x9, operstate: "unknown", type: 772, ipv4: ["127.0.0.1"], ipv6: [] };
const LO_V6_ROUTES = [
  { family: 6 as const, device: "lo", destination: "00000000000000000000000000000001/128" },
  { family: 6 as const, device: "lo", destination: "00000000000000000000000000000000/0" },
];

/** A fallback tunnel device as Docker Desktop's LinuxKit kernel creates it: NOARP, down, no address. */
function tunnel(name: string, type: number, overrides: Partial<ObservedInterface> = {}): ObservedInterface {
  return { name, flags: 0x80, operstate: "down", type, ipv4: [], ipv6: [], ...overrides };
}

const DOCKER_DESKTOP: NetworkObservation = {
  interfaces: [LO, tunnel("ip6tnl0", 769), tunnel("tunl0", 768), tunnel("sit0", 776), tunnel("gre0", 778)],
  routes: LO_V6_ROUTES,
};

describe("evaluateNetworkIsolation", () => {
  it("accepts Linux Docker Engine's none-mode namespace: loopback only", () => {
    expect(evaluateNetworkIsolation({ interfaces: [LO], routes: [] })).toEqual({ isolated: true, violations: [], inertDevices: [] });
  });

  it("accepts Docker Desktop's inert fallback tunnel devices", () => {
    expect(evaluateNetworkIsolation(DOCKER_DESKTOP)).toEqual({
      isolated: true,
      violations: [],
      inertDevices: ["gre0", "ip6tnl0", "sit0", "tunl0"],
    });
  });

  it("refuses a fallback tunnel device that is up, addressed or routed", () => {
    const cases: [ObservedInterface, NetworkObservation["routes"], RegExp][] = [
      [tunnel("tunl0", 768, { flags: 0x81 }), [], /tunl0 is up/u],
      [tunnel("tunl0", 768, { flags: 0x10080 }), [], /tunl0 is up/u],
      [tunnel("tunl0", 768, { operstate: "unknown" }), [], /tunl0 has operstate unknown/u],
      [tunnel("tunl0", 768, { ipv4: ["10.0.0.2"] }), [], /tunl0 has addresses 10\.0\.0\.2/u],
      [tunnel("ip6tnl0", 769, { ipv6: ["fe80:0000:0000:0000:0000:0000:0000:0001"] }), [], /ip6tnl0 has addresses/u],
      [tunnel("sit0", 776), [{ family: 6, device: "sit0", destination: "::/0" }], /IPv6 route ::\/0 via sit0/u],
      [tunnel("tunl0", 768, { flags: null }), [], /tunl0 has unreadable flags/u],
    ];
    for (const [device, routes, pattern] of cases) {
      const verdict = evaluateNetworkIsolation({ interfaces: [LO, device], routes: [...LO_V6_ROUTES, ...routes] });
      expect(verdict.isolated).toBe(false);
      expect(verdict.violations.join("; ")).toMatch(pattern);
    }
  });

  it("refuses any other device, even when it is down and unaddressed", () => {
    const verdict = evaluateNetworkIsolation({ interfaces: [LO, tunnel("eth0", 1)], routes: [] });
    expect(verdict).toMatchObject({ isolated: false, violations: ["interface eth0 is not a known fallback tunnel device"] });
  });

  it("refuses a bridge attachment: eth0 up with an address and a default route", () => {
    const verdict = evaluateNetworkIsolation({
      interfaces: [LO, { name: "eth0", flags: 0x1003, operstate: "up", type: 1, ipv4: ["172.17.0.2"], ipv6: [] }],
      routes: [
        { family: 4, device: "eth0", destination: "0.0.0.0/0" },
        { family: 4, device: "eth0", destination: "172.17.0.0/16" },
      ],
    });
    expect(verdict.isolated).toBe(false);
    expect(verdict.violations).toEqual([
      "IPv4 route 0.0.0.0/0 via eth0",
      "IPv4 route 172.17.0.0/16 via eth0",
      "interface eth0 is not a known fallback tunnel device, is up (flags 0x1003), has operstate up, has addresses 172.17.0.2, has routes",
    ]);
  });

  it("refuses a missing loopback, a non-loopback address on lo and an IPv4 main-table route", () => {
    expect(evaluateNetworkIsolation({ interfaces: [], routes: [] }).violations).toEqual(["no loopback interface"]);
    const verdict = evaluateNetworkIsolation({
      interfaces: [{ ...LO, ipv4: ["192.0.2.1"] }],
      routes: [{ family: 4, device: "lo", destination: "0.0.0.0/0" }],
    });
    expect(verdict.violations).toEqual(["IPv4 main-table route 0.0.0.0/0 via lo", "lo has non-loopback address 192.0.2.1"]);
  });
});
