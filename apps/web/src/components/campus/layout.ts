import type { CampusAgent, Carry, Tone, Zone } from "../../lib/campus";

/**
 * The campus floor plan, in floor units: rooms, walkways, trees, and the
 * walkway graph agents follow when they carry work from one room to the next.
 * `x` runs along one side of the campus and `y` along the other; the 3D scene
 * maps them to its X and Z axes.
 */

export type Point = readonly [number, number];

export type Edge = "x1" | "x2" | "y1" | "y2";

export type Room = {
  id: Zone;
  x: number;
  y: number;
  w: number;
  d: number;
  name: string;
  glass?: boolean;
  /** Door gaps: the wall they are in (`x2` is the wall at x + w) and where along it. */
  doors: Array<[Edge, number]>;
};

export const ROOMS: Room[] = [
  { id: "read", x: 4, y: 4, w: 8, d: 7, name: "Reading Room", doors: [["x2", 7.6]] },
  { id: "plan", x: 17, y: 4, w: 8, d: 7, name: "Planning Room", doors: [["y2", 21.5]] },
  { id: "repo", x: 4, y: 17, w: 8, d: 7, name: "Repo Room", doors: [["x2", 20.6]] },
  {
    id: "lab",
    x: 17,
    y: 17,
    w: 9,
    d: 8,
    name: "Disposable Lab",
    glass: true,
    doors: [
      ["y1", 21.5],
      ["x2", 21.4],
    ],
  },
  { id: "ver", x: 30, y: 9, w: 7, d: 8, name: "Verification Desk", doors: [["y2", 33]] },
  { id: "store", x: 30, y: 21, w: 6, d: 6, name: "Run Store", doors: [["y2", 33]] },
];

export const ROOM_ICON: Record<Zone, string> = { read: "P", repo: "C", plan: "R", lab: "L", ver: "V", store: "S" };
export const ROOM_TONE: Record<Zone, Tone> = { read: "paper", repo: "code", plan: "lead", lab: "lab", ver: "ver", store: "paper" };

export const GROUND = { x: -2, y: -2, w: 44, d: 36 };

export const TREES: Point[] = [
  [1, 2],
  [1, 9],
  [0.5, 15],
  [1.5, 26],
  [2, 30],
  [8, 29],
  [13, 28],
  [18, 29],
  [24, 29.5],
  [27, 2],
  [29, 5],
  [33, 4],
  [38, 6],
  [39.5, 12],
  [39, 20],
  [38.5, 27],
  [38, 31],
  [15.5, 1.5],
  [10, 1],
  [25.5, 15.5],
  [13, 15.5],
];

/** Walkway graph. Each zone's own node is where its agents stand; walks follow the corridors. */
export const NODES: Record<string, Point> = {
  read: [8, 7.6],
  readDoor: [12, 7.6],
  a: [14.5, 7.6],
  repo: [8, 20.6],
  repoDoor: [12, 20.6],
  c: [14.5, 20.6],
  b: [14.5, 13.6],
  plan: [21.6, 8],
  planDoor: [21.5, 11],
  d: [21.5, 13.6],
  labTop: [21.5, 17],
  lab: [22.2, 21.4],
  labDoor: [26, 21.4],
  e: [28.5, 21.4],
  f: [28.5, 13.6],
  g: [28.5, 18.6],
  verDoor: [33, 17],
  ver: [33.6, 12.6],
  h: [28.5, 28.6],
  storeDoor: [33, 27],
  store: [33, 24.4],
};

const EDGES: Array<[string, string]> = [
  ["read", "readDoor"],
  ["readDoor", "a"],
  ["a", "b"],
  ["b", "c"],
  ["c", "repoDoor"],
  ["repoDoor", "repo"],
  ["b", "d"],
  ["d", "planDoor"],
  ["planDoor", "plan"],
  ["d", "labTop"],
  ["labTop", "lab"],
  ["lab", "labDoor"],
  ["labDoor", "e"],
  ["d", "f"],
  ["f", "g"],
  ["g", "e"],
  ["e", "h"],
  ["g", "verDoor"],
  ["verDoor", "ver"],
  ["h", "storeDoor"],
  ["storeDoor", "store"],
];

/** Paved walkways as [x, y, w, d]. */
export const WALKWAYS: Array<[number, number, number, number]> = [
  [13.6, 6.6, 1.8, 15],
  [13.6, 12.6, 16, 2],
  [27.6, 12.6, 1.8, 17],
  [27.6, 17.6, 7, 1.9],
  [27.6, 27.6, 7, 1.9],
  [12, 6.6, 2, 1.9],
  [12, 19.6, 2, 1.9],
  [20, 11, 3, 2],
  [21, 14, 1.2, 3.2],
  [26, 20.5, 2, 1.9],
  [32.2, 17, 1.6, 1.3],
  [32.2, 27, 1.6, 1.3],
];

/** Where the n-th agent of a room stands, relative to the room's own node. */
const SLOTS: Point[] = [
  [0, 0],
  [-1.6, 1.3],
  [1.4, -1.3],
  [-1.7, -1.2],
  [1.5, 1.4],
  [0, 2.2],
];

export const SPEED = 4.5; // floor units per second
export const DWELL = 1.1; // seconds spent handing over
export const FRESH_MS = 20_000; // a handoff older than this when first seen is history, not something to animate
export const FADE = 1.6; // seconds for the lab to build up or dissolve

export const BUBBLES: Record<Carry, string> = {
  claim: "claim handed to planning",
  code: "code map delivered",
  plan: "approved plan to the lab",
  metric: "result handed to review",
  report: "evidence filed",
};

export const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function shortestPath(from: string, to: string): Point[] {
  const neighbours = new Map<string, string[]>();
  for (const [a, b] of EDGES) {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  const cost = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, string>();
  const open = new Set([from]);
  while (open.size > 0) {
    let current = "";
    for (const node of open) if (!current || cost.get(node)! < cost.get(current)!) current = node;
    open.delete(current);
    if (current === to) break;
    for (const next of neighbours.get(current) ?? []) {
      const total = cost.get(current)! + distance(NODES[current]!, NODES[next]!);
      if (total < (cost.get(next) ?? Infinity)) {
        cost.set(next, total);
        previous.set(next, current);
        open.add(next);
      }
    }
  }
  const path: Point[] = [];
  for (let node: string | undefined = to; node; node = previous.get(node)) path.unshift(NODES[node]!);
  return path;
}

export function pathLength(path: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += distance(path[i - 1]!, path[i]!);
  return total;
}

export function along(path: readonly Point[], at: number): { x: number; y: number; dx: number; dy: number } {
  let left = at;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const step = distance(a, b);
    if (left <= step && step > 0) {
      const f = left / step;
      return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, dx: b[0] - a[0], dy: b[1] - a[1] };
    }
    left -= step;
  }
  const end = path.at(-1)!;
  const before = path.at(-2) ?? end;
  return { x: end[0], y: end[1], dx: end[0] - before[0], dy: end[1] - before[1] };
}

export function homeOf(agent: Pick<CampusAgent, "zone" | "slot">): Point {
  const base = NODES[agent.zone]!;
  const slot = SLOTS[agent.slot % SLOTS.length]!;
  return [base[0] + slot[0], base[1] + slot[1]];
}
