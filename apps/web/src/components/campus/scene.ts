import type { CampusAgent, CampusModel, Carry, Handoff, Tone, Zone } from "../../lib/campus";
import { formatElapsed } from "../../lib/live-run";

/**
 * The isometric campus, drawn on a canvas. It draws whatever the latest
 * `CampusModel` says: which agents exist and what they are doing, whether a
 * lab exists, runs, or was destroyed. The only thing it adds is motion: when a
 * new handoff event arrives, the agent that carried the work walks it to the
 * next room and back. Handoffs already in the history when the page loads are
 * not replayed as walks.
 */

type Point = readonly [number, number];
type Palette = {
  ground: { top: string; l: string; r: string };
  grid: string;
  walkway: string;
  dash: string;
  wall: { base: string; top: string; l: string; r: string };
  floorSide: { l: string; r: string };
  rooms: Record<Zone, { col: string; tint: string }>;
  desk: { base: string; l: string; r: string; edge: string };
  label: { bg: string; text: string; muted: string; shadow: string };
  shadow: string;
  trunk: string;
  leaf: [string, string];
  screenBody: string;
  screen: string;
  rackOff: string;
  crate: { base: string; top: string; l: string; r: string; filed: string; idle: string };
  head: string;
  visor: string;
  tones: Record<Tone, string>;
  warn: string;
};

const TONES: Record<Tone, string> = {
  paper: "#3d63e8",
  code: "#7a5ae0",
  lead: "#e3952a",
  lab: "#119c93",
  ver: "#de5878",
  system: "#8b95ad",
};

const LIGHT: Palette = {
  ground: { top: "#e6ecf7", l: "#d5ddec", r: "#c9d2e4" },
  grid: "rgba(120,140,190,.08)",
  walkway: "#f4f7fc",
  dash: "rgba(61,99,232,.25)",
  wall: { base: "#ffffff", top: "#f4f6fb", l: "#eef2f9", r: "#e2e8f3" },
  floorSide: { l: "#dfe5f1", r: "#d1d9ea" },
  rooms: {
    read: { col: "#f6f8fe", tint: "#e8eefc" },
    plan: { col: "#fffaf2", tint: "#fbefdc" },
    repo: { col: "#f8f6fe", tint: "#eee9fc" },
    lab: { col: "#f1fbfa", tint: "#dcf3f0" },
    ver: { col: "#fff7f9", tint: "#fbe5eb" },
    store: { col: "#f6f8fb", tint: "#e8edf5" },
  },
  desk: { base: "#ffffff", l: "#e6ebf5", r: "#d8dfee", edge: "rgba(150,165,200,.25)" },
  label: { bg: "#ffffff", text: "#18213b", muted: "#6a7593", shadow: "rgba(24,33,59,.14)" },
  shadow: "rgba(24,33,59,.18)",
  trunk: "#b9a68a",
  leaf: ["#8fd6a6", "#4fae7d"],
  screenBody: "#2a3352",
  screen: "#1d2540",
  rackOff: "#3a4466",
  crate: { base: "#eef2f9", top: "#f7f9fd", l: "#dde4f0", r: "#cfd8e8", filed: "#bcd0ff", idle: "#dbe4f6" },
  head: "#ffffff",
  visor: "#1f2846",
  tones: TONES,
  warn: "#c77a12",
};

const DARK: Palette = {
  ground: { top: "#1a2030", l: "#141a27", r: "#10151f" },
  grid: "rgba(140,160,210,.07)",
  walkway: "#222a3c",
  dash: "rgba(125,140,255,.35)",
  wall: { base: "#2a3246", top: "#323b52", l: "#272f42", r: "#20283a" },
  floorSide: { l: "#1d2433", r: "#181e2b" },
  rooms: {
    read: { col: "#202840", tint: "#232c47" },
    plan: { col: "#2b2620", tint: "#302a20" },
    repo: { col: "#252140", tint: "#282345" },
    lab: { col: "#18302e", tint: "#183532" },
    ver: { col: "#2e2026", tint: "#33222a" },
    store: { col: "#212634", tint: "#252b3a" },
  },
  desk: { base: "#394259", l: "#2f374b", r: "#283043", edge: "rgba(150,165,200,.2)" },
  label: { bg: "#1f2533", text: "#e8ebef", muted: "#9aa3ae", shadow: "rgba(0,0,0,.4)" },
  shadow: "rgba(0,0,0,.35)",
  trunk: "#7d6d58",
  leaf: ["#5fae7d", "#2f7a52"],
  screenBody: "#11151f",
  screen: "#0b0f18",
  rackOff: "#2a3248",
  crate: { base: "#2b3347", top: "#343d54", l: "#252c3e", r: "#1f2535", filed: "#4d63b8", idle: "#3a4560" },
  head: "#e8ebf2",
  visor: "#1a2033",
  tones: { ...TONES, paper: "#6f8cf0", code: "#9b80ea", system: "#7a8296" },
  warn: "#e0a44a",
};

type Room = { id: Zone; x: number; y: number; w: number; d: number; name: string; glass?: boolean; doors: Array<["x" | "y", number]> };

const ROOMS: Room[] = [
  { id: "read", x: 4, y: 4, w: 8, d: 7, name: "Reading Room", doors: [["x", 7.5]] },
  {
    id: "plan",
    x: 17,
    y: 4,
    w: 8,
    d: 7,
    name: "Planning Room",
    doors: [
      ["y", 20.5],
      ["y", 22],
    ],
  },
  { id: "repo", x: 4, y: 17, w: 8, d: 7, name: "Repo Room", doors: [["x", 20.5]] },
  { id: "lab", x: 17, y: 17, w: 9, d: 8, name: "Disposable Lab", glass: true, doors: [["x", 21.5]] },
  { id: "ver", x: 30, y: 9, w: 7, d: 8, name: "Verification Desk", doors: [["y", 33]] },
  { id: "store", x: 30, y: 21, w: 6, d: 6, name: "Run Store", doors: [["y", 33]] },
].sort((a, b) => a.x + a.y - (b.x + b.y)) as Room[];

const ROOM_ICON: Record<Zone, string> = { read: "P", repo: "C", plan: "R", lab: "L", ver: "V", store: "S" };
const ROOM_TONE: Record<Zone, Tone> = { read: "paper", repo: "code", plan: "lead", lab: "lab", ver: "ver", store: "paper" };

const TREES: Point[] = [
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

/** Walkway graph. Each zone's `home` node is where its agents stand; walks follow the corridors. */
const NODES: Record<string, Point> = {
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
const WALKWAYS: Array<[number, number, number, number]> = [
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
const DASHES: Array<[Point, Point]> = [
  [
    [14.5, 7],
    [14.5, 21],
  ],
  [
    [14.5, 13.6],
    [28.5, 13.6],
  ],
  [
    [28.5, 13.6],
    [28.5, 28.6],
  ],
  [
    [28.5, 18.6],
    [33, 18.6],
  ],
  [
    [28.5, 28.6],
    [33, 28.6],
  ],
];

/** Where the n-th agent of a room stands, relative to the room's home node. */
const SLOTS: Point[] = [
  [0, 0],
  [-1.6, 1.3],
  [1.4, -1.3],
  [-1.7, -1.2],
  [1.5, 1.4],
  [0, 2.2],
];

const SPEED = 4.5; // floor units per second
const DWELL = 1.1; // seconds spent handing over
const FRESH_MS = 20_000; // a handoff older than this when first seen is history, not something to animate
const FADE = 1.6; // seconds for the lab to build up or dissolve

const BUBBLES: Record<Carry, string> = {
  claim: "claim handed to planning",
  code: "code map delivered",
  plan: "approved plan to the lab",
  metric: "result handed to review",
  report: "evidence filed",
};

const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function shortestPath(from: string, to: string): Point[] {
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

function pathLength(path: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += distance(path[i - 1]!, path[i]!);
  return total;
}

function along(path: readonly Point[], at: number): { x: number; y: number; dx: number; dy: number } {
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

function homeOf(agent: Pick<CampusAgent, "zone" | "slot">): Point {
  const base = NODES[agent.zone]!;
  const slot = SLOTS[agent.slot % SLOTS.length]!;
  return [base[0] + slot[0], base[1] + slot[1]];
}

type Walk = { handoff: Handoff; start: number; there: Point[]; back: Point[]; length: number };

function hex(color: string): [number, number, number] {
  const value = color.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}
function shade(color: string, amount: number): string {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount)));
  const [r, g, b] = hex(color);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
function rgba(color: string, alpha: number): string {
  const [r, g, b] = hex(color);
  return `rgba(${r},${g},${b},${alpha})`;
}

export type SceneLabels = { statusLabel: (status: string) => string };

export class CampusScene {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #labels: SceneLabels;
  #model: CampusModel | null = null;
  #palette: Palette = LIGHT;
  #s = 10;
  #ox = 0;
  #oy = 0;
  #w = 0;
  #h = 0;
  #compact = false;
  #frame = 0;
  #clock = 0;
  #last = 0;
  readonly #seen = new Set<string>();
  readonly #queue = new Map<string, Walk[]>();
  #labShownAt: number | null = null;
  #labGoneAt: number | null = null;
  #lastPresence: CampusModel["labPresence"] | null = null;
  readonly #reduced: boolean;
  readonly #dark: MediaQueryList | null;
  #font = "ui-sans-serif, system-ui, sans-serif";
  #mono = "ui-monospace, monospace";

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, labels: SceneLabels) {
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#labels = labels;
    this.#reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.#dark = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    const styles = window.getComputedStyle(document.documentElement);
    this.#font = styles.getPropertyValue("--font-sans").trim() || this.#font;
    this.#mono = styles.getPropertyValue("--font-mono").trim() || this.#mono;
  }

  /** Creates a scene, or null where the canvas cannot draw (such as a test DOM). */
  static create(canvas: HTMLCanvasElement, labels: SceneLabels): CampusScene | null {
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    return ctx ? new CampusScene(canvas, ctx, labels) : null;
  }

  setModel(model: CampusModel): void {
    const now = this.#clock;
    const first = this.#model === null;
    for (const handoff of model.handoffs) {
      if (this.#seen.has(handoff.id)) continue;
      this.#seen.add(handoff.id);
      const age = Date.now() - Date.parse(handoff.at);
      if (first || this.#reduced || !(age < FRESH_MS)) continue;
      const agent = model.agents.find((candidate) => candidate.key === handoff.agentKey);
      if (!agent) continue;
      const home = homeOf(agent);
      const corridor = shortestPath(handoff.from, handoff.to);
      const there = [home, ...corridor];
      const queue = this.#queue.get(handoff.agentKey) ?? [];
      const previous = queue.at(-1);
      const start = previous ? Math.max(now, previous.start + (2 * previous.length) / SPEED + DWELL) : now;
      queue.push({ handoff, start, there, back: [...there].reverse(), length: pathLength(there) });
      this.#queue.set(handoff.agentKey, queue);
    }
    if (model.labPresence !== this.#lastPresence) {
      const live = this.#lastPresence !== null && !this.#reduced;
      if (model.labPresence === "active") this.#labShownAt = live ? now : -Infinity;
      if (model.labPresence === "removed") this.#labGoneAt = live ? now : -Infinity;
      this.#lastPresence = model.labPresence;
    }
    this.#model = model;
    if (this.#reduced) this.#draw();
  }

  start(): void {
    this.resize();
    if (this.#reduced) {
      this.#draw();
      return;
    }
    const tick = (time: number) => {
      const dt = this.#last ? Math.min((time - this.#last) / 1000, 0.1) : 0;
      this.#last = time;
      this.#clock += dt;
      this.#draw();
      this.#frame = window.requestAnimationFrame(tick);
    };
    this.#frame = window.requestAnimationFrame(tick);
  }

  stop(): void {
    window.cancelAnimationFrame(this.#frame);
  }

  resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.#w = rect.width;
    this.#h = rect.height;
    this.#canvas.width = Math.round(rect.width * ratio);
    this.#canvas.height = Math.round(rect.height * ratio);
    this.#compact = window.matchMedia?.("(max-width: 1100px)").matches ?? rect.width < 720;
    const inset = this.#compact ? { l: 4, r: 4, t: 24, b: 4 } : { l: 10, r: 300, t: 70, b: 20 };
    const minX = (-2 - 34) * 0.866;
    const maxX = (42 + 2) * 0.866;
    const minY = (-2 - 2) * 0.5 - 6;
    const maxY = (42 + 34) * 0.5 + 0.5;
    const aw = Math.max(1, this.#w - inset.l - inset.r);
    const ah = Math.max(1, this.#h - inset.t - inset.b);
    this.#s = Math.min(aw / (maxX - minX), ah / (maxY - minY)) * (this.#compact ? 1.05 : 1.08);
    this.#ox = inset.l + (aw - (maxX - minX) * this.#s) / 2 - minX * this.#s;
    this.#oy = inset.t + (ah - (maxY - minY) * this.#s) / 2 - minY * this.#s;
    if (this.#reduced) this.#draw();
  }

  // ---------- geometry ----------
  #p(x: number, y: number, z = 0): [number, number] {
    return [this.#ox + (x - y) * this.#s * 0.866, this.#oy + (x + y) * this.#s * 0.5 - z * this.#s];
  }
  #poly(points: Array<[number, number]>, fill: string | null, stroke?: string, width = 1) {
    const ctx = this.#ctx;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }
  #box(
    x: number,
    y: number,
    z: number,
    w: number,
    d: number,
    h: number,
    col: string,
    opt: { top?: string; l?: string; r?: string; edge?: string } = {},
  ) {
    const top = opt.top ?? col;
    const l = opt.l ?? shade(col, -0.07);
    const r = opt.r ?? shade(col, -0.15);
    const A = this.#p(x, y, z + h);
    const B = this.#p(x + w, y, z + h);
    const C = this.#p(x + w, y + d, z + h);
    const D = this.#p(x, y + d, z + h);
    const B0 = this.#p(x + w, y, z);
    const C0 = this.#p(x + w, y + d, z);
    const D0 = this.#p(x, y + d, z);
    this.#poly([B, C, C0, B0], r, opt.edge, 0.6);
    this.#poly([D, C, C0, D0], l, opt.edge, 0.6);
    this.#poly([A, B, C, D], top, opt.edge, 0.6);
  }
  #rrect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.#ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  #line(a: [number, number], b: [number, number]) {
    const ctx = this.#ctx;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }

  // ---------- state ----------
  #labAlpha(): number {
    const model = this.#model;
    if (!model || model.labPresence === "absent") return 0;
    if (model.labPresence === "active") return Math.min(1, Math.max(0, (this.#clock - (this.#labShownAt ?? -Infinity)) / FADE));
    return Math.max(0, 1 - (this.#clock - (this.#labGoneAt ?? -Infinity)) / FADE);
  }

  #walkOf(key: string): { walk: Walk; elapsed: number } | null {
    const queue = this.#queue.get(key);
    if (!queue) return null;
    while (queue.length > 0) {
      const walk = queue[0]!;
      const elapsed = this.#clock - walk.start;
      if (elapsed < 0) return null;
      if (elapsed <= (2 * walk.length) / SPEED + DWELL) return { walk, elapsed };
      queue.shift();
    }
    return null;
  }

  #position(agent: CampusAgent) {
    const home = homeOf(agent);
    const active = this.#walkOf(agent.key);
    if (!active) return { x: home[0], y: home[1], dx: 1, dy: 0, moving: false, carry: null as Carry | null, arrived: null as Walk | null };
    const { walk, elapsed } = active;
    const out = walk.length / SPEED;
    if (elapsed < out) return { ...along(walk.there, elapsed * SPEED), moving: true, carry: walk.handoff.carry, arrived: null };
    if (elapsed < out + DWELL) return { ...along(walk.there, walk.length), moving: false, carry: null, arrived: walk };
    return { ...along(walk.back, (elapsed - out - DWELL) * SPEED), moving: true, carry: null, arrived: null };
  }

  // ---------- drawing ----------
  #draw() {
    const ctx = this.#ctx;
    const model = this.#model;
    this.#palette = this.#dark?.matches ? DARK : LIGHT;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, this.#w, this.#h);
    this.#ground();
    if (!model) return;
    const placed = model.agents.map((agent) => ({ agent, ...this.#position(agent) }));
    const inRoom = (x: number, y: number) => ROOMS.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.d);
    type Item = { kind: "tree"; x: number; y: number } | { kind: "agent"; x: number; y: number; placed: (typeof placed)[number] };
    const outside: Item[] = [
      ...TREES.map(([x, y]) => ({ kind: "tree" as const, x, y })),
      ...placed.filter((p) => !inRoom(p.x, p.y)).map((p) => ({ kind: "agent" as const, x: p.x, y: p.y, placed: p })),
    ].sort((a, b) => a.x + a.y - (b.x + b.y));
    const before = outside.map((item) => ({ item, room: ROOMS.findIndex((r) => item.x < r.x + r.w && item.y < r.y + r.d) }));
    const drawItem = (item: Item) => (item.kind === "tree" ? this.#tree(item.x, item.y) : this.#agent(item.placed));
    ROOMS.forEach((room, index) => {
      before.filter((entry) => entry.room === index).forEach((entry) => drawItem(entry.item));
      this.#roomBack(room, model);
      placed
        .filter((p) => inRoom(p.x, p.y) === room)
        .sort((a, b) => a.x + a.y - (b.x + b.y))
        .forEach((p) => this.#agent(p));
      this.#roomFront(room);
    });
    before.filter((entry) => entry.room === -1).forEach((entry) => drawItem(entry.item));
    this.#dissolve();
    ROOMS.forEach((room) => this.#label(room, model));
    this.#overlays(model, placed);
  }

  #ground() {
    const ctx = this.#ctx;
    const pal = this.#palette;
    this.#box(-2, -2, -0.5, 44, 36, 0.5, pal.ground.top, { top: pal.ground.top, l: pal.ground.l, r: pal.ground.r });
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    for (let i = -2; i <= 42; i += 2) this.#line(this.#p(i, -2), this.#p(i, 34));
    for (let j = -2; j <= 34; j += 2) this.#line(this.#p(-2, j), this.#p(42, j));
    for (const [x, y, w, d] of WALKWAYS)
      this.#poly([this.#p(x, y), this.#p(x + w, y), this.#p(x + w, y + d), this.#p(x, y + d)], pal.walkway);
    ctx.setLineDash([this.#s * 0.35, this.#s * 0.35]);
    ctx.strokeStyle = pal.dash;
    ctx.lineWidth = 1.2;
    for (const [a, b] of DASHES) this.#line(this.#p(a[0], a[1]), this.#p(b[0], b[1]));
    ctx.setLineDash([]);
  }

  #tree(x: number, y: number) {
    const ctx = this.#ctx;
    const pal = this.#palette;
    const S = this.#s;
    const p = this.#p(x, y, 0);
    ctx.fillStyle = "rgba(40,60,110,.10)";
    ctx.beginPath();
    ctx.ellipse(p[0], p[1], S * 0.9, S * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = pal.trunk;
    ctx.fillRect(p[0] - S * 0.08, p[1] - S * 1.1, S * 0.16, S * 1.1);
    const c = this.#p(x, y, 1.6);
    const sway = this.#reduced ? 0 : Math.sin(this.#clock * 1.3 + x) * S * 0.03;
    const gradient = ctx.createRadialGradient(c[0] - S * 0.3 + sway, c[1] - S * 0.4, S * 0.1, c[0], c[1], S * 0.9);
    gradient.addColorStop(0, pal.leaf[0]);
    gradient.addColorStop(1, pal.leaf[1]);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(c[0] + sway, c[1], S * 0.82, 0, Math.PI * 2);
    ctx.fill();
  }

  #desk(x: number, y: number, w: number, d: number) {
    const desk = this.#palette.desk;
    this.#box(x, y, 0, w, d, 0.75, desk.base, { l: desk.l, r: desk.r, edge: desk.edge });
  }

  #monitor(x: number, y: number, phase: number, color: string) {
    const ctx = this.#ctx;
    const pal = this.#palette;
    this.#box(x, y, 0.75, 0.15, 0.9, 0.65, pal.screenBody, { top: shade(pal.screenBody, 0.12) });
    this.#poly(
      [
        this.#p(x + 0.15, y + 0.08, 0.82),
        this.#p(x + 0.15, y + 0.82, 0.82),
        this.#p(x + 0.15, y + 0.82, 1.35),
        this.#p(x + 0.15, y + 0.08, 1.35),
      ],
      pal.screen,
    );
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = 1.1;
    const t = this.#clock + phase;
    for (let i = 0; i < 4; i += 1) {
      const z = 1.25 - i * 0.11;
      const len = 0.3 + ((i * 7 + Math.floor(t * 3)) % 5) * 0.08;
      this.#line(this.#p(x + 0.16, y + 0.15, z), this.#p(x + 0.16, y + 0.15 + len, z));
    }
  }

  #bookshelf(x: number, y: number, w: number, alongX: boolean) {
    const ctx = this.#ctx;
    const pal = this.#palette;
    const S = this.#s;
    const colors = [TONES.paper, TONES.lead, TONES.code, TONES.lab, TONES.ver, "#9fb2e9"];
    if (alongX) this.#box(x, y, 0, w, 0.6, 1.9, pal.desk.base, { l: pal.desk.l, r: pal.desk.r });
    else this.#box(x, y, 0, 0.6, w, 1.9, pal.desk.base, { l: pal.desk.l, r: pal.desk.r });
    for (let i = 0; i < w * 3; i += 1) {
      for (const z of [0.35, 1.05]) {
        const a = alongX ? this.#p(x + 0.15 + i * 0.33, y + 0.6, z) : this.#p(x + 0.6, y + 0.15 + i * 0.33, z);
        const b = alongX ? this.#p(x + 0.37 + i * 0.33, y + 0.6, z) : this.#p(x + 0.6, y + 0.37 + i * 0.33, z);
        ctx.fillStyle = colors[(i + (z > 1 ? 2 : 0)) % colors.length]!;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.lineTo(b[0], b[1] - S * 0.55);
        ctx.lineTo(a[0], a[1] - S * 0.55);
        ctx.fill();
      }
    }
  }

  #sheet(x: number, y: number, z: number) {
    this.#poly(
      [this.#p(x, y, z), this.#p(x + 0.7, y, z), this.#p(x + 0.7, y + 0.5, z), this.#p(x, y + 0.5, z)],
      "#ffffff",
      "rgba(120,140,190,.4)",
      0.6,
    );
  }

  #whiteboard(x: number, y: number, w: number) {
    const ctx = this.#ctx;
    this.#poly(
      [this.#p(x, y + 0.05, 0.9), this.#p(x + w, y + 0.05, 0.9), this.#p(x + w, y + 0.05, 2.0), this.#p(x, y + 0.05, 2.0)],
      "#ffffff",
      "#c9d3e6",
      1,
    );
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = TONES.lead;
    this.#line(this.#p(x + 0.4, y + 0.06, 1.75), this.#p(x + 1.6, y + 0.06, 1.75));
    ctx.strokeStyle = TONES.paper;
    ctx.beginPath();
    const pts = [
      this.#p(x + 0.4, y + 0.06, 1.4),
      this.#p(x + 1.2, y + 0.06, 1.2),
      this.#p(x + 2.0, y + 0.06, 1.55),
      this.#p(x + 2.8, y + 0.06, 1.3),
    ];
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.stroke();
    ctx.strokeStyle = TONES.code;
    this.#line(this.#p(x + 3.2, y + 0.06, 1.75), this.#p(x + w - 0.4, y + 0.06, 1.75));
    this.#line(this.#p(x + 3.2, y + 0.06, 1.5), this.#p(x + w - 0.8, y + 0.06, 1.5));
  }

  #rack(x: number, y: number, phase: number, running: boolean) {
    const ctx = this.#ctx;
    const pal = this.#palette;
    this.#box(x, y, 0, 0.9, 0.9, 1.9, "#2a3352", { top: "#3c4770", l: "#232b47", r: "#1c2340" });
    const t = this.#clock + phase;
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        const p = this.#p(x + 0.9, y + 0.25 + j * 0.4, 0.35 + i * 0.32);
        const on = running ? (Math.floor(t * 8) + i * 3 + j * 5) % 4 !== 0 : i === 0;
        ctx.fillStyle = on ? (j ? "#5ff0c9" : "#7fb2ff") : pal.rackOff;
        ctx.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3);
      }
    }
  }

  #roomBack(room: Room, model: CampusModel) {
    const ctx = this.#ctx;
    const pal = this.#palette;
    const colors = pal.rooms[room.id];
    const x2 = room.x + room.w;
    const y2 = room.y + room.d;
    this.#box(room.x, room.y, 0, room.w, room.d, 0.25, colors.col, { top: colors.tint, l: pal.floorSide.l, r: pal.floorSide.r });
    if (room.glass) {
      const lab = TONES.lab;
      ctx.save();
      ctx.strokeStyle = rgba(lab, 0.18);
      ctx.lineWidth = 1;
      for (let i = 1; i < room.w; i += 1) this.#line(this.#p(room.x + i, room.y, 0.25), this.#p(room.x + i, y2, 0.25));
      for (let j = 1; j < room.d; j += 1) this.#line(this.#p(room.x, room.y + j, 0.25), this.#p(x2, room.y + j, 0.25));
      ctx.setLineDash([5, 4]);
      this.#poly(
        [this.#p(room.x, room.y, 0.26), this.#p(x2, room.y, 0.26), this.#p(x2, y2, 0.26), this.#p(room.x, y2, 0.26)],
        null,
        rgba(lab, 0.6),
        1.4,
      );
      ctx.setLineDash([]);
      ctx.restore();
      const alpha = this.#labAlpha();
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const h = 2.6 * alpha;
      this.#poly(
        [this.#p(room.x, room.y, 0.25), this.#p(x2, room.y, 0.25), this.#p(x2, room.y, 0.25 + h), this.#p(room.x, room.y, 0.25 + h)],
        rgba(lab, 0.1),
        rgba(lab, 0.45),
        1,
      );
      this.#poly(
        [this.#p(room.x, room.y, 0.25), this.#p(room.x, y2, 0.25), this.#p(room.x, y2, 0.25 + h), this.#p(room.x, room.y, 0.25 + h)],
        rgba(lab, 0.14),
        rgba(lab, 0.45),
        1,
      );
      const running = model.lab?.running ?? false;
      // One rack per live lab (two engineers, two racks), at most three.
      const racks = Math.max(1, Math.min(3, model.labsActive || model.labCount));
      const rackSpots: Point[] = [
        [0.5, 0.5],
        [1.6, 0.5],
        [0.5, 1.6],
      ];
      for (let i = 0; i < racks; i += 1) this.#rack(room.x + rackSpots[i]![0], room.y + rackSpots[i]![1], i * 0.3, running);
      this.#desk(room.x + 4.5, room.y + 3.6, 2.2, 1.2);
      this.#monitor(room.x + 4.5, room.y + 3.75, 0, lab);
      this.#box(room.x + 6.3, room.y + 0.6, 0.25, 1.8, 1.2, 1.0, "#cdeee9", {
        top: "#e5f7f4",
        l: "#b5e3dc",
        r: "#9fd6ce",
        edge: rgba(lab, 0.5),
      });
      ctx.restore();
      return;
    }
    const WH = 2.2;
    const wall = pal.wall;
    this.#box(room.x - 0.25, room.y - 0.25, 0, room.w + 0.25, 0.25, WH, wall.base, { top: wall.top, l: wall.l, r: wall.r });
    this.#box(room.x - 0.25, room.y, 0, 0.25, room.d, WH, wall.base, { top: wall.top, l: wall.l, r: wall.r });
    const { x, y } = room;
    if (room.id === "read") {
      this.#bookshelf(x + 0.3, y + 0.05, 4, true);
      this.#bookshelf(x + 0.05, y + 1.2, 4, false);
      this.#desk(x + 3, y + 2.4, 2.6, 1.4);
      this.#sheet(x + 3.4, y + 2.7, 0.76);
      this.#sheet(x + 4.3, y + 2.6, 0.77);
    } else if (room.id === "repo") {
      this.#desk(x + 1, y + 0.6, 1.2, 3.2);
      this.#monitor(x + 1.1, y + 0.75, 0, TONES.code);
      this.#monitor(x + 1.1, y + 2.7, 1, TONES.code);
      this.#desk(x + 4.6, y + 0.6, 1.2, 2.2);
      this.#monitor(x + 4.7, y + 0.8, 2, TONES.paper);
      this.#box(x + 6.6, y + 0.4, 0, 0.9, 0.9, 1.6, "#2a3352", { top: "#3c4770" });
    } else if (room.id === "plan") {
      this.#whiteboard(x + 0.6, y, 5);
      this.#box(x + 2.6, y + 2.4, 0, 3.4, 1.6, 0.72, pal.desk.base, { l: pal.desk.l, r: pal.desk.r, edge: "rgba(200,170,120,.35)" });
      this.#sheet(x + 3.4, y + 2.9, 0.73);
    } else if (room.id === "ver") {
      this.#desk(x + 2, y + 1.2, 2.4, 1.3);
      this.#monitor(x + 2.1, y + 1.3, 0, TONES.ver);
      this.#box(x + 0.4, y + 0.4, 0, 0.9, 2.2, 1.4, pal.desk.base, { l: pal.desk.l, r: pal.desk.r });
      const c = this.#p(x + 3.7, y + 1.9, 0.75);
      const S = this.#s;
      ctx.strokeStyle = "#8a5868";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      ctx.lineTo(c[0], c[1] - S * 0.8);
      ctx.moveTo(c[0] - S * 0.45, c[1] - S * 0.7);
      ctx.lineTo(c[0] + S * 0.45, c[1] - S * 0.8);
      ctx.stroke();
      ctx.fillStyle = TONES.ver;
      ctx.beginPath();
      ctx.arc(c[0] - S * 0.45, c[1] - S * 0.55, S * 0.15, 0, Math.PI);
      ctx.fill();
      ctx.fillStyle = TONES.paper;
      ctx.beginPath();
      ctx.arc(c[0] + S * 0.45, c[1] - S * 0.65, S * 0.15, 0, Math.PI);
      ctx.fill();
    } else if (room.id === "store") {
      const crate = pal.crate;
      for (let i = 0; i < 4; i += 1)
        this.#box(x + 0.4 + i * 1.25, y + 0.35, 0, 1, 0.9, 1.7, crate.base, { top: crate.top, l: crate.l, r: crate.r });
      for (let j = 0; j < 2; j += 1)
        this.#box(x + 0.35, y + 1.7 + j * 1.25, 0, 0.9, 1, 1.7, crate.base, { top: crate.top, l: crate.l, r: crate.r });
      // One box per filed report: the evidence the run store holds for this study.
      const filed = model.handoffs.some((handoff) => handoff.carry === "report") || model.status !== null;
      const boxes = filed ? 7 : 6;
      for (let i = 0; i < boxes; i += 1) {
        this.#box(x + 3 + (i % 3) * 0.75, y + 3.4 + Math.floor(i / 3) * 0.9, 0.25, 0.6, 0.7, 0.35, i === 6 ? crate.filed : crate.idle);
      }
    }
  }

  #roomFront(room: Room) {
    const ctx = this.#ctx;
    const pal = this.#palette;
    const x2 = room.x + room.w;
    const y2 = room.y + room.d;
    if (room.glass) {
      const alpha = this.#labAlpha();
      if (alpha <= 0) return;
      const lab = TONES.lab;
      ctx.save();
      ctx.globalAlpha = alpha;
      const h = 2.6 * alpha;
      this.#poly(
        [this.#p(x2, room.y, 0.25), this.#p(x2, y2, 0.25), this.#p(x2, y2, 0.25 + h), this.#p(x2, room.y, 0.25 + h)],
        rgba(lab, 0.08),
        rgba(lab, 0.5),
        1,
      );
      this.#poly(
        [this.#p(room.x, y2, 0.25), this.#p(x2, y2, 0.25), this.#p(x2, y2, 0.25 + h), this.#p(room.x, y2, 0.25 + h)],
        rgba(lab, 0.06),
        rgba(lab, 0.5),
        1,
      );
      ctx.strokeStyle = rgba(lab, 0.35);
      ctx.lineWidth = 1;
      for (let i = 1; i < room.w; i += 3) this.#line(this.#p(room.x + i, y2, 0.25), this.#p(room.x + i, y2, 0.25 + h));
      this.#poly(
        [this.#p(room.x, room.y, 0.25 + h), this.#p(x2, room.y, 0.25 + h), this.#p(x2, y2, 0.25 + h), this.#p(room.x, y2, 0.25 + h)],
        rgba(lab, 0.04),
        rgba(lab, 0.7),
        1.4,
      );
      ctx.restore();
      return;
    }
    const segments = (length: number, doors: number[]) => {
      let parts: Array<[number, number]> = [[0, length]];
      for (const door of doors) {
        const next: Array<[number, number]> = [];
        for (const [a, b] of parts) {
          if (door - 0.8 > a) next.push([a, Math.min(b, door - 0.8)]);
          if (door + 0.8 < b) next.push([Math.max(a, door + 0.8), b]);
        }
        parts = next;
      }
      return parts;
    };
    const wall = pal.wall;
    const alongY = room.doors.filter(([axis]) => axis === "x").map(([, at]) => at - room.y);
    const alongX = room.doors.filter(([axis]) => axis === "y").map(([, at]) => at - room.x);
    for (const [a, b] of segments(room.d, alongY))
      this.#box(x2, room.y + a, 0, 0.2, b - a, 0.55, wall.base, { top: wall.top, l: wall.l, r: wall.r });
    for (const [a, b] of segments(room.w, alongX))
      this.#box(room.x + a, y2, 0, b - a, 0.2, 0.55, wall.base, { top: wall.top, l: wall.l, r: wall.r });
  }

  #dissolve() {
    const model = this.#model;
    if (!model || model.labPresence !== "removed" || this.#labGoneAt === null) return;
    const f = (this.#clock - this.#labGoneAt) / (FADE + 1.5);
    if (f < 0 || f > 1) return;
    const ctx = this.#ctx;
    const room = ROOMS.find((r) => r.id === "lab")!;
    for (let i = 0; i < 46; i += 1) {
      const x = room.x + ((i * 37) % 90) / 10;
      const y = room.y + ((i * 53) % 80) / 10;
      const z = 0.3 + ((i * 29) % 26) / 10 + f * 3 * (0.5 + (i % 5) / 5);
      const p = this.#p(x, y, z);
      const size = this.#s * 0.22 * (1 - f);
      ctx.fillStyle = rgba(i % 3 ? TONES.lab : "#7fe0d0", Math.max(0, 1 - f));
      ctx.fillRect(p[0] - size / 2, p[1] - size / 2, size, size);
    }
  }

  #agent(placed: { agent: CampusAgent; x: number; y: number; dx: number; dy: number; moving: boolean; carry: Carry | null }) {
    const ctx = this.#ctx;
    const pal = this.#palette;
    const { agent } = placed;
    const S = this.#s;
    const color = agent.state === "stopped" ? pal.tones.system : pal.tones[agent.tone];
    const p = this.#p(placed.x, placed.y, 0.25);
    const u = S * 1.35;
    const t = this.#clock;
    const bob = this.#reduced
      ? 0
      : placed.moving
        ? Math.abs(Math.sin(t * 10)) * u * 0.08
        : Math.sin(t * 2.2 + agent.slot + agent.key.length) * u * 0.03;
    const face = placed.dx - placed.dy >= 0 ? 1 : -1;
    ctx.fillStyle = pal.shadow;
    ctx.beginPath();
    ctx.ellipse(p[0], p[1], u * 0.42, u * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    const swing = placed.moving && !this.#reduced ? Math.sin(t * 10) * u * 0.16 : 0;
    ctx.strokeStyle = shade(color, -0.45);
    ctx.lineWidth = Math.max(2, u * 0.13);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p[0] - u * 0.1, p[1] - u * 0.45 - bob);
    ctx.lineTo(p[0] - u * 0.1 + swing, p[1] - u * 0.05);
    ctx.moveTo(p[0] + u * 0.1, p[1] - u * 0.45 - bob);
    ctx.lineTo(p[0] + u * 0.1 - swing, p[1] - u * 0.05);
    ctx.stroke();
    const bx = p[0] - u * 0.27;
    const by = p[1] - u * 1.12 - bob;
    this.#rrect(bx, by, u * 0.54, u * 0.72, u * 0.22);
    ctx.fillStyle = color;
    ctx.fill();
    this.#rrect(bx + u * 0.08, by + u * 0.1, u * 0.14, u * 0.4, u * 0.07);
    ctx.fillStyle = shade(color, 0.35);
    ctx.fill();
    const hx = p[0];
    const hy = by - u * 0.22;
    ctx.fillStyle = pal.head;
    ctx.beginPath();
    ctx.arc(hx, hy, u * 0.27, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(24,33,59,.15)";
    ctx.lineWidth = 1;
    ctx.stroke();
    this.#rrect(hx - u * 0.17 + face * u * 0.05, hy - u * 0.08, u * 0.3, u * 0.13, u * 0.06);
    ctx.fillStyle = pal.visor;
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(hx + face * u * 0.12 - u * 0.02, hy - u * 0.06, u * 0.05, u * 0.05);
    ctx.strokeStyle = "#9aa6c4";
    ctx.lineWidth = 1.2;
    this.#line([hx, hy - u * 0.27], [hx, hy - u * 0.45]);
    ctx.fillStyle = agent.state === "blocked" ? pal.warn : color;
    ctx.beginPath();
    ctx.arc(hx, hy - u * 0.48, u * 0.07, 0, Math.PI * 2);
    ctx.fill();
    if (placed.carry) {
      const cx = p[0] + face * u * 0.32;
      const cy = by + u * 0.18;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(face * 0.12);
      this.#rrect(-u * 0.22, -u * 0.28, u * 0.44, u * 0.52, u * 0.05);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "rgba(24,33,59,.25)";
      ctx.stroke();
      const band: Record<Carry, Tone> = { claim: "paper", code: "code", plan: "lead", metric: "lab", report: "ver" };
      ctx.fillStyle = pal.tones[band[placed.carry]];
      ctx.fillRect(-u * 0.14, -u * 0.18, u * 0.28, u * 0.06);
      ctx.fillStyle = "#cfd6e6";
      ctx.fillRect(-u * 0.14, -u * 0.06, u * 0.2, u * 0.04);
      ctx.fillRect(-u * 0.14, u * 0.03, u * 0.24, u * 0.04);
      ctx.restore();
    }
    if (!placed.moving && agent.state === "working") {
      const lit = this.#reduced ? 3 : Math.floor(t * 3) % 4;
      for (let i = 0; i < 3; i += 1) {
        ctx.fillStyle = i < lit ? color : "rgba(24,33,59,.15)";
        ctx.beginPath();
        ctx.arc(hx - u * 0.2 + i * u * 0.2, hy - u * 0.8, u * 0.07, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  #roomSubtitle(room: Room, model: CampusModel): string {
    const who = (zone: Zone) => {
      const agents = model.agents.filter((agent) => agent.zone === zone);
      if (agents.length === 0) return "no agent yet";
      const working = agents.filter((agent) => agent.state === "working").length;
      const names = [...new Set(agents.map((agent) => agent.name))];
      const lead = names.length === 1 ? names[0]! : `${agents.length} agents`;
      return working > 0 ? `${lead} · working` : agents.every((agent) => agent.state === "done") ? `${lead} · done` : lead;
    };
    if (room.id === "lab") {
      const lab = model.lab;
      if (model.labPresence === "absent") return "awaiting the plan";
      if (model.labPresence === "removed") return lab?.state === "cleanup_failed" ? "cleanup failed" : "destroyed · receipt kept";
      if (!lab) return "provisioning";
      if (lab.running) {
        const since = lab.runningSince ? Date.parse(lab.runningSince) : NaN;
        return Number.isFinite(since) ? `running · ${formatElapsed(Date.now() - since)}` : "running";
      }
      if (lab.state === "creating") return "provisioning";
      if (lab.exitCode !== null) return `idle · exit ${lab.exitCode}`;
      return lab.state === "ready" ? "ready" : lab.state.replaceAll("_", " ");
    }
    if (room.id === "store") return model.status ? "report filed" : "evidence & reports";
    if (room.id === "ver" && model.status) return this.#labels.statusLabel(model.status);
    return who(room.id);
  }

  #label(room: Room, model: CampusModel) {
    const ctx = this.#ctx;
    const pal = this.#palette;
    const S = this.#s;
    const p = this.#p(room.x + room.w / 2, room.y + room.d / 2, room.glass ? 4.2 : 3.6);
    if (S < 8) {
      // Too small for words: a room chip only (the panels below name every agent and the lab's state).
      const size = Math.max(14, S * 2.2);
      this.#rrect(p[0] - size / 2, p[1] - size, size, size, 4);
      ctx.fillStyle = pal.tones[ROOM_TONE[room.id]];
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `800 ${Math.round(size * 0.55)}px ${this.#font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(ROOM_ICON[room.id], p[0], p[1] - size / 2 + 1);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      return;
    }
    const sub = this.#roomSubtitle(room, model);
    const titleFont = `700 ${Math.max(10, S * 0.95)}px ${this.#font}`;
    const subFont = `500 ${Math.max(9, S * 0.8)}px ${this.#font}`;
    ctx.font = titleFont;
    const w1 = ctx.measureText(room.name).width;
    ctx.font = subFont;
    const w2 = ctx.measureText(sub).width;
    const pad = S * 0.6;
    const icon = S * 1.5;
    const w = Math.max(w1, w2) + icon + pad * 3;
    const h = S * 2.6;
    const x = p[0] - w / 2;
    const y = p[1] - h;
    ctx.save();
    ctx.shadowColor = pal.label.shadow;
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    this.#rrect(x, y, w, h, S * 0.5);
    ctx.fillStyle = pal.label.bg;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = pal.label.bg;
    ctx.beginPath();
    ctx.moveTo(p[0] - S * 0.4, p[1]);
    ctx.lineTo(p[0], p[1] + S * 0.45);
    ctx.lineTo(p[0] + S * 0.4, p[1]);
    ctx.fill();
    this.#rrect(x + pad, y + (h - icon) / 2, icon, icon, S * 0.35);
    ctx.fillStyle = pal.tones[ROOM_TONE[room.id]];
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 ${Math.max(9, S * 0.8)}px ${this.#font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ROOM_ICON[room.id], x + pad + icon / 2, y + h / 2 + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = pal.label.text;
    ctx.font = titleFont;
    ctx.fillText(room.name, x + pad * 2 + icon, y + h * 0.45);
    ctx.fillStyle = room.id === "lab" && model.lab?.running ? TONES.lab : pal.label.muted;
    ctx.font = subFont;
    ctx.fillText(sub, x + pad * 2 + icon, y + h * 0.82);
  }

  #bubble(p: [number, number], text: string, color: string) {
    const ctx = this.#ctx;
    const S = this.#s;
    if (S < 8) return;
    ctx.font = `700 ${Math.max(10, S * 0.9)}px ${this.#mono}`;
    const w = ctx.measureText(text).width + S * 1.6;
    const h = S * 1.9;
    ctx.save();
    ctx.shadowColor = "rgba(24,33,59,.18)";
    ctx.shadowBlur = 12;
    this.#rrect(p[0] - w / 2, p[1] - h, w, h, S * 0.45);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(p[0] - S * 0.35, p[1]);
    ctx.lineTo(p[0], p[1] + S * 0.4);
    ctx.lineTo(p[0] + S * 0.35, p[1]);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, p[0], p[1] - h / 2 + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  #overlays(model: CampusModel, placed: Array<{ agent: CampusAgent; x: number; y: number; arrived: Walk | null }>) {
    const ctx = this.#ctx;
    const S = this.#s;
    if (model.labPresence === "active" && model.lab?.running) {
      // The lab is busy: an indeterminate shuttle, since no event reports a percentage.
      const room = ROOMS.find((r) => r.id === "lab")!;
      const p = this.#p(room.x + room.w / 2, room.y + room.d / 2, 3.15);
      const w = S * 6;
      this.#rrect(p[0] - w / 2, p[1], w, S * 0.45, S * 0.22);
      ctx.fillStyle = "rgba(255,255,255,.95)";
      ctx.fill();
      const phase = this.#reduced ? 0.35 : (this.#clock * 0.6) % 1;
      const seg = w * 0.3;
      const start = p[0] - w / 2 + (w - seg) * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2));
      this.#rrect(start, p[1], seg, S * 0.45, S * 0.22);
      ctx.fillStyle = TONES.lab;
      ctx.fill();
    }
    for (const p of placed) {
      if (!p.arrived) continue;
      const at = this.#p(p.x, p.y, 3.0);
      this.#bubble(at, BUBBLES[p.arrived.handoff.carry], this.#palette.tones[p.agent.tone]);
    }
  }
}
