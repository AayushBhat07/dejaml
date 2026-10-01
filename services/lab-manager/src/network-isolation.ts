/**
 * What a process inside a `--network none` lab can observe about its network
 * namespace, and the rule that decides whether that namespace is isolated.
 *
 * Docker Desktop (macOS, Windows) runs containers in a LinuxKit VM whose kernel
 * has the IP tunnel drivers built in. Such a kernel creates the drivers'
 * fallback devices (`tunl0`, `ip6tnl0`, `sit0`, `gre0`, …) in every new network
 * namespace, including a `--network none` one, so `/sys/class/net` there is not
 * just `lo`. Those devices are administratively down, have no address and no
 * route, and cannot carry a packet. Docker Engine on most Linux hosts loads
 * the tunnel modules on demand (or not at all), so its listing is only `lo`.
 *
 * Isolation is therefore judged on what makes traffic possible, not on one
 * exact listing: besides loopback, only known fallback tunnel devices may
 * exist, and every one must be down, without addresses and without routes.
 * Any other device, or any device other than `lo` that is up, has an address
 * or has a route, is a violation.
 */

/** Fallback devices that built-in tunnel drivers create in every network namespace. */
export const FALLBACK_TUNNEL_DEVICES: ReadonlySet<string> = new Set([
  "tunl0", // ipip
  "sit0", // sit (IPv6-in-IPv4)
  "ip6tnl0", // ip6_tunnel
  "gre0", // ip_gre
  "gretap0", // ip_gre
  "erspan0", // ip_gre
  "ip6gre0", // ip6_gre
  "ip_vti0", // ip_vti
  "ip6_vti0", // ip6_vti
]);

const IFF_UP = 0x1;
const IFF_RUNNING = 0x40;
const IFF_LOWER_UP = 0x10000;
const ARPHRD_LOOPBACK = 772;

export type ObservedInterface = {
  name: string;
  /** `/sys/class/net/<name>/flags` as a number, or null when unreadable. */
  flags: number | null;
  /** `/sys/class/net/<name>/operstate`. */
  operstate: string;
  /** `/sys/class/net/<name>/type` (ARPHRD_*), or null when unreadable. */
  type: number | null;
  /** The interface's IPv4 address (SIOCGIFADDR), if any. */
  ipv4: string[];
  /** The interface's IPv6 addresses (`/proc/net/if_inet6`), if any. */
  ipv6: string[];
};

export type ObservedRoute = { family: 4 | 6; device: string; destination: string };

export type NetworkObservation = {
  interfaces: ObservedInterface[];
  /** IPv4 main-table routes (`/proc/net/route`) and IPv6 routes of every table (`/proc/net/ipv6_route`). */
  routes: ObservedRoute[];
};

export type NetworkIsolationVerdict = {
  isolated: boolean;
  violations: string[];
  /** Non-loopback devices that were present but proven inert (down, no address, no route). */
  inertDevices: string[];
};

function isLoopbackAddress(address: string): boolean {
  return /^127\./u.test(address) || address === "::1" || address === "0000:0000:0000:0000:0000:0000:0000:0001";
}

/** Applies the isolation rule to an observation taken inside the lab. */
export function evaluateNetworkIsolation(observation: NetworkObservation): NetworkIsolationVerdict {
  const violations: string[] = [];
  const inertDevices: string[] = [];
  const names = new Set(observation.interfaces.map((item) => item.name));
  if (!names.has("lo")) violations.push("no loopback interface");
  for (const route of observation.routes) {
    if (route.device !== "lo") {
      violations.push(`IPv${route.family} route ${route.destination} via ${route.device}`);
    } else if (route.family === 4) {
      // The IPv4 main table of a none-mode namespace is empty; loopback routes live in the local table.
      violations.push(`IPv4 main-table route ${route.destination} via lo`);
    }
  }
  for (const item of observation.interfaces) {
    if (item.name === "lo") {
      if (item.type !== null && item.type !== ARPHRD_LOOPBACK) violations.push(`lo is not a loopback device (type ${item.type})`);
      for (const address of [...item.ipv4, ...item.ipv6]) {
        if (!isLoopbackAddress(address)) violations.push(`lo has non-loopback address ${address}`);
      }
      continue;
    }
    const problems: string[] = [];
    if (!FALLBACK_TUNNEL_DEVICES.has(item.name)) problems.push("is not a known fallback tunnel device");
    if (item.flags === null) problems.push("has unreadable flags");
    else if ((item.flags & (IFF_UP | IFF_RUNNING | IFF_LOWER_UP)) !== 0) problems.push(`is up (flags 0x${item.flags.toString(16)})`);
    if (item.operstate !== "down") problems.push(`has operstate ${item.operstate}`);
    if (item.ipv4.length > 0 || item.ipv6.length > 0) problems.push(`has addresses ${[...item.ipv4, ...item.ipv6].join(", ")}`);
    if (observation.routes.some((route) => route.device === item.name)) problems.push("has routes");
    if (problems.length > 0) violations.push(`interface ${item.name} ${problems.join(", ")}`);
    else inertDevices.push(item.name);
  }
  return { isolated: violations.length === 0, violations, inertDevices: inertDevices.sort() };
}

/**
 * A Python (standard library only) function, `observe_network()`, that returns
 * a `NetworkObservation` as a dict. It reads sysfs and procfs and uses one
 * `SIOCGIFADDR` ioctl per interface; it sends no packet.
 */
export const NETWORK_OBSERVER_PY = String.raw`
def observe_network():
    import fcntl, os, socket, struct
    def sysfs(name, key):
        try:
            with open(f"/sys/class/net/{name}/{key}") as handle:
                return handle.read().strip()
        except OSError:
            return None
    def number(text, base=10):
        try:
            return int(text, base)
        except (TypeError, ValueError):
            return None
    inet6 = {}
    try:
        for line in open("/proc/net/if_inet6").read().splitlines():
            parts = line.split()
            if len(parts) >= 6:
                raw = parts[0]
                inet6.setdefault(parts[5], []).append(":".join(raw[i:i + 4] for i in range(0, 32, 4)))
    except OSError:
        pass
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    interfaces = []
    for name in sorted(os.listdir("/sys/class/net")):
        ipv4 = []
        try:
            packed = fcntl.ioctl(probe.fileno(), 0x8915, struct.pack("256s", name[:15].encode()))
            ipv4.append(socket.inet_ntoa(packed[20:24]))
        except OSError:
            pass
        interfaces.append({
            "name": name,
            "flags": number(sysfs(name, "flags"), 16),
            "operstate": sysfs(name, "operstate") or "unreadable",
            "type": number(sysfs(name, "type")),
            "ipv4": ipv4,
            "ipv6": inet6.get(name, []),
        })
    probe.close()
    routes = []
    try:
        for line in open("/proc/net/route").read().splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 8:
                destination = socket.inet_ntoa(struct.pack("<I", int(parts[1], 16)))
                mask = bin(int(parts[7], 16)).count("1")
                routes.append({"family": 4, "device": parts[0], "destination": f"{destination}/{mask}"})
    except OSError:
        pass
    try:
        for line in open("/proc/net/ipv6_route").read().splitlines():
            parts = line.split()
            if len(parts) >= 10:
                routes.append({"family": 6, "device": parts[9], "destination": f"{parts[0]}/{int(parts[1], 16)}"})
    except OSError:
        pass
    return {"interfaces": interfaces, "routes": routes}
`;
