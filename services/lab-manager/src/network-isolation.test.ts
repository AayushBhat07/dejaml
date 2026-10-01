import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evaluateNetworkIsolation, NETWORK_OBSERVER_PY, type NetworkObservation, type ObservedInterface } from "./network-isolation.js";

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

describe("evaluateNetworkIsolation with kernel and sysfs listings", () => {
  it("refuses a device the kernel reports but the observation lacks, and a skipped entry that is a device", () => {
    expect(evaluateNetworkIsolation({ interfaces: [LO], routes: [], kernelInterfaces: ["lo", "eth0"] }).violations).toEqual([
      "the kernel reports interface eth0, which was not observed",
    ]);
    const skipped = evaluateNetworkIsolation({
      interfaces: [LO],
      routes: [],
      kernelInterfaces: ["lo", "bond0"],
      ignoredEntries: [{ name: "bond0", reason: "regular file" }],
    });
    expect(skipped.violations).toEqual([
      "the kernel reports interface bond0, which was not observed",
      "sysfs entry bond0 was skipped but is a network interface",
    ]);
  });
});

const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;

/** Runs the in-lab observer against a fake /sys/class/net and /proc/net, with the kernel's device list given. */
function observe(netDir: string, procDir: string, kernel: string[]): NetworkObservation {
  const code = `import json\n${NETWORK_OBSERVER_PY}\nprint(json.dumps(observe_network(${JSON.stringify(netDir)}, ${JSON.stringify(procDir)}, ${JSON.stringify(kernel)})))`;
  const result = spawnSync(python!, ["-c", code], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as NetworkObservation;
}

describe.skipIf(python === null)("the in-lab network observer", () => {
  let root: string;
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A device as sysfs shows it: /sys/class/net/<name> is a symlink to a device directory with ifindex. */
  async function device(name: string, flags: string, operstate: string, type: number): Promise<void> {
    const target = join(root, "devices", name);
    await mkdir(target, { recursive: true });
    for (const [key, value] of [
      ["ifindex", "1"],
      ["flags", flags],
      ["operstate", operstate],
      ["type", String(type)],
    ] as const)
      await writeFile(join(target, key), `${value}\n`);
    await symlink(target, join(root, "net", name));
  }

  async function setUp(): Promise<{ net: string; proc: string }> {
    root = await mkdtemp(join(tmpdir(), "dejaml-netobs-"));
    await mkdir(join(root, "net"));
    await mkdir(join(root, "proc"));
    await device("lo", "0x9", "unknown", 772);
    await device("tunl0", "0x80", "down", 768);
    // The bonding driver's control attribute: a regular file, not a device.
    await writeFile(join(root, "net", "bonding_masters"), "\n");
    return { net: join(root, "net"), proc: join(root, "proc") };
  }

  it("ignores non-device control files such as bonding_masters and still evaluates every device", async () => {
    const { net, proc } = await setUp();
    const observation = observe(net, proc, ["lo", "tunl0"]);
    expect(observation.interfaces.map((item) => item.name)).toEqual(["lo", "tunl0"]);
    expect(observation.ignoredEntries).toEqual([
      { name: "bonding_masters", reason: "regular file in /sys/class/net, not a network device" },
    ]);
    expect(evaluateNetworkIsolation(observation)).toEqual({ isolated: true, violations: [], inertDevices: ["tunl0"] });
  });

  it("still fails on an unknown genuine interface, even one the kernel list omits", async () => {
    const { net, proc } = await setUp();
    await device("eth1", "0x1002", "down", 1);
    const verdict = evaluateNetworkIsolation(observe(net, proc, ["lo", "tunl0"]));
    expect(verdict.isolated).toBe(false);
    expect(verdict.violations).toEqual(["interface eth1 is not a known fallback tunnel device"]);
  });

  it("evaluates a kernel-listed device that sysfs does not show, and never skips a file the kernel names", async () => {
    const { net, proc } = await setUp();
    const hidden = evaluateNetworkIsolation(observe(net, proc, ["lo", "tunl0", "veth9"]));
    expect(hidden.violations.join("; ")).toMatch(
      /interface veth9 is not a known fallback tunnel device, has unreadable flags, has operstate unreadable/u,
    );
    const named = observe(net, proc, ["lo", "tunl0", "bonding_masters"]);
    expect(named.ignoredEntries).toEqual([]);
    expect(evaluateNetworkIsolation(named).isolated).toBe(false);
  });
});
