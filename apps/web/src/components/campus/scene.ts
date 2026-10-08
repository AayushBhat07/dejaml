import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

import type { CampusAgent, CampusModel, Carry, Handoff, Tone, Zone } from "../../lib/campus";
import { formatElapsed } from "../../lib/live-run";
import {
  along,
  BUBBLES,
  DWELL,
  FADE,
  FRESH_MS,
  GROUND,
  homeOf,
  pathLength,
  type Edge,
  type Point,
  type Room,
  ROOM_ICON,
  ROOM_TONE,
  ROOMS,
  shortestPath,
  SPEED,
  TREES,
  WALKWAYS,
} from "./layout";

/**
 * The research campus in 3D (three.js). It draws whatever the latest
 * `CampusModel` says: which agents exist and what they are doing, whether a
 * lab exists, runs, or was destroyed. The only thing it adds is motion: when a
 * new handoff event arrives, the agent that carried the work walks it to the
 * next room and back. Handoffs already in the history when the page loads are
 * not replayed as walks. Drag to orbit, right-drag (or two fingers) to pan,
 * and scroll or pinch to zoom.
 */

type Palette = {
  sky: string;
  ground: string;
  grid: string;
  walkway: string;
  dash: string;
  wall: string;
  wallTop: string;
  rooms: Record<Zone, string>;
  furniture: string;
  dark: string;
  screen: string;
  crate: string;
  crateFiled: string;
  trunk: string;
  leaf: string;
  head: string;
  visor: string;
  hemiSky: string;
  hemiGround: string;
  tones: Record<Tone, string>;
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
  sky: "#eef2fa",
  ground: "#e3e9f5",
  grid: "#c3cde3",
  walkway: "#f7f9fd",
  dash: "#9db0ef",
  wall: "#ffffff",
  wallTop: "#f1f4fa",
  rooms: { read: "#e8eefc", plan: "#fbefdc", repo: "#eee9fc", lab: "#dcf3f0", ver: "#fbe5eb", store: "#e8edf5" },
  furniture: "#ffffff",
  dark: "#2a3352",
  screen: "#1d2540",
  crate: "#e6ebf4",
  crateFiled: "#9fb8ff",
  trunk: "#b9a68a",
  leaf: "#5fbf8a",
  head: "#ffffff",
  visor: "#1f2846",
  hemiSky: "#ffffff",
  hemiGround: "#c9d2e4",
  tones: TONES,
};

const DARK: Palette = {
  sky: "#0e1119",
  ground: "#1a2030",
  grid: "#2a3349",
  walkway: "#262f43",
  dash: "#5a6bd8",
  wall: "#353e55",
  wallTop: "#414b64",
  rooms: { read: "#232c47", plan: "#3a3122", repo: "#2b2549", lab: "#163c38", ver: "#3b232d", store: "#262c3c" },
  furniture: "#46506a",
  dark: "#141927",
  screen: "#0b0f18",
  crate: "#3a4560",
  crateFiled: "#5a74d8",
  trunk: "#7d6d58",
  leaf: "#3f9466",
  head: "#e8ebf2",
  visor: "#1a2033",
  hemiSky: "#c9d3ff",
  hemiGround: "#1a2030",
  tones: { ...TONES, paper: "#6f8cf0", code: "#9b80ea", system: "#7a8296" },
};

const CX = 20;
const CY = 16;
/** Floor units to scene coordinates: x and y lie on the ground, z goes up. */
const at = (x: number, y: number, z = 0) => new THREE.Vector3(x - CX, z, y - CY);

const DEFAULT_OFFSET = new THREE.Vector3(1, 1.05, 1).normalize();
const DEFAULT_DISTANCE = 70;

type Walk = { handoff: Handoff; start: number; there: Point[]; back: Point[]; length: number };

type AgentView = {
  agent: CampusAgent;
  group: THREE.Group;
  body: THREE.MeshStandardMaterial;
  tip: THREE.MeshStandardMaterial;
  legs: [THREE.Object3D, THREE.Object3D];
  carry: THREE.Group;
  band: THREE.MeshStandardMaterial;
  dots: THREE.Mesh[];
  hit: THREE.Mesh;
  bubble: CSS2DObject;
};

export type SceneLabels = { statusLabel: (status: string) => string };

export class CampusScene {
  readonly #container: HTMLElement;
  readonly #labels: SceneLabels;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #labelRenderer: CSS2DRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(32, 1, 0.5, 400);
  readonly #controls: OrbitControls;
  readonly #themed: Array<[THREE.Color, (palette: Palette) => string]> = [];
  readonly #reduced: boolean;
  readonly #dark: MediaQueryList | null;
  #palette: Palette | null = null;
  #model: CampusModel | null = null;
  #frame = 0;
  #clock = 0;
  #last = 0;
  #compact = false;
  readonly #seen = new Set<string>();
  readonly #queue = new Map<string, Walk[]>();
  readonly #agents = new Map<string, AgentView>();
  #labShownAt: number | null = null;
  #labGoneAt: number | null = null;
  #lastPresence: CampusModel["labPresence"] | null = null;
  // Built once, then updated from the model.
  readonly #lab = new THREE.Group();
  readonly #labGlass: THREE.Material[] = [];
  readonly #racks: Array<{ group: THREE.Group; leds: THREE.MeshStandardMaterial[] }> = [];
  readonly #filedCrate: THREE.Mesh;
  readonly #particles: THREE.Points;
  readonly #roomLabels = new Map<Zone, { name: HTMLElement; sub: HTMLElement; root: HTMLElement }>();
  readonly #labBar: CSS2DObject;
  readonly #tooltip: CSS2DObject;
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2(2, 2);
  #hovered: string | null = null;
  readonly #onPointerMove: (event: PointerEvent) => void;
  readonly #onPointerLeave: () => void;

  /** Creates a scene, or null where the browser cannot draw WebGL (such as a test DOM). */
  static create(container: HTMLElement, labels: SceneLabels): CampusScene | null {
    try {
      return new CampusScene(container, labels);
    } catch {
      return null;
    }
  }

  private constructor(container: HTMLElement, labels: SceneLabels) {
    this.#container = container;
    this.#labels = labels;
    this.#renderer = new THREE.WebGLRenderer({ antialias: true });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.#renderer.shadowMap.enabled = true;
    this.#renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.#renderer.domElement.className = "campus-canvas";
    this.#renderer.domElement.setAttribute("role", "img");
    this.#renderer.domElement.setAttribute(
      "aria-label",
      "3D research campus: the study's agents read the paper, map the code, plan, run the experiment in a disposable lab, and verify the result. Drag to rotate, right-drag to pan, scroll to zoom.",
    );
    this.#labelRenderer = new CSS2DRenderer();
    this.#labelRenderer.domElement.className = "campus-label-layer";
    container.append(this.#renderer.domElement, this.#labelRenderer.domElement);

    this.#reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.#dark = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;

    this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement);
    this.#controls.enableDamping = !this.#reduced;
    this.#controls.dampingFactor = 0.08;
    this.#controls.screenSpacePanning = false;
    this.#controls.minDistance = 12;
    this.#controls.maxDistance = 120;
    this.#controls.maxPolarAngle = Math.PI * 0.46;
    this.#controls.addEventListener("change", () => this.#clampTarget());

    this.#buildLights();
    this.#buildGround();
    for (const room of ROOMS) this.#buildRoom(room);
    for (const [x, y] of TREES) this.#tree(x, y);
    this.#filedCrate = this.#box(30 + 3 + 0.75 * 0, 21 + 3.4 + 0.9 * 2, 0.25, 0.6, 0.7, 0.35, (p) => p.crateFiled);
    this.#filedCrate.visible = false;
    this.#particles = this.#buildParticles();
    this.#scene.add(this.#lab);

    const labRoom = ROOMS.find((room) => room.id === "lab")!;
    const bar = document.createElement("div");
    bar.className = "campus-labbar";
    bar.append(document.createElement("i"));
    this.#labBar = new CSS2DObject(bar);
    this.#labBar.position.copy(at(labRoom.x + labRoom.w / 2, labRoom.y + labRoom.d / 2, 3.2));
    this.#labBar.visible = false;
    this.#scene.add(this.#labBar);

    const tip = document.createElement("div");
    tip.className = "campus-tooltip";
    this.#tooltip = new CSS2DObject(tip);
    this.#tooltip.visible = false;
    this.#scene.add(this.#tooltip);

    this.#onPointerMove = (event) => {
      const rect = this.#renderer.domElement.getBoundingClientRect();
      this.#pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    };
    this.#onPointerLeave = () => this.#pointer.set(2, 2);
    this.#renderer.domElement.addEventListener("pointermove", this.#onPointerMove);
    this.#renderer.domElement.addEventListener("pointerleave", this.#onPointerLeave);

    this.#applyTheme();
    this.resize();
    this.resetView(false);
  }

  // ---------- public ----------

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
      const there = [homeOf(agent), ...shortestPath(handoff.from, handoff.to)];
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
    this.#syncAgents(model);
    this.#syncLabels(model);
  }

  start(): void {
    const tick = (time: number) => {
      const dt = this.#last ? Math.min((time - this.#last) / 1000, 0.1) : 0;
      this.#last = time;
      this.#clock += dt;
      this.#update();
      this.#frame = window.requestAnimationFrame(tick);
    };
    this.#frame = window.requestAnimationFrame(tick);
  }

  stop(): void {
    window.cancelAnimationFrame(this.#frame);
    this.#controls.dispose();
    this.#renderer.domElement.removeEventListener("pointermove", this.#onPointerMove);
    this.#renderer.domElement.removeEventListener("pointerleave", this.#onPointerLeave);
    this.#renderer.dispose();
    this.#renderer.domElement.remove();
    this.#labelRenderer.domElement.remove();
  }

  resize(): void {
    const width = Math.max(1, this.#container.clientWidth);
    const height = Math.max(1, this.#container.clientHeight);
    this.#compact = window.matchMedia?.("(max-width: 1100px)").matches ?? width < 720;
    this.#renderer.setSize(width, height);
    this.#labelRenderer.setSize(width, height);
    this.#camera.aspect = width / height;
    // On wide screens the lab panel covers the right edge: centre the campus in the space left of it.
    if (!this.#compact && width > 900) this.#camera.setViewOffset(width, height, 150, -30, width, height);
    else this.#camera.clearViewOffset();
    this.#camera.updateProjectionMatrix();
  }

  /** Back to the starting view: the whole campus, seen from the corner like the floor plan. */
  resetView(animate = true): void {
    const aspect = this.#camera.aspect || 1.6;
    const distance = DEFAULT_DISTANCE * Math.min(2.2, Math.max(1, 1.55 / aspect));
    const position = DEFAULT_OFFSET.clone().multiplyScalar(distance);
    if (!animate || this.#reduced) {
      this.#controls.target.set(0, 0, 0);
      this.#camera.position.copy(position);
      this.#controls.update();
      return;
    }
    const fromPosition = this.#camera.position.clone();
    const fromTarget = this.#controls.target.clone();
    const startedAt = performance.now();
    const step = () => {
      const f = Math.min(1, (performance.now() - startedAt) / 600);
      const eased = 1 - (1 - f) ** 3;
      this.#camera.position.lerpVectors(fromPosition, position, eased);
      this.#controls.target.lerpVectors(fromTarget, new THREE.Vector3(), eased);
      this.#controls.update();
      if (f < 1) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  }

  /** Zooms by a factor (below 1 moves closer), for the on-screen buttons. */
  zoom(factor: number): void {
    const offset = this.#camera.position.clone().sub(this.#controls.target);
    const length = THREE.MathUtils.clamp(offset.length() * factor, this.#controls.minDistance, this.#controls.maxDistance);
    this.#camera.position.copy(this.#controls.target).add(offset.setLength(length));
    this.#controls.update();
  }

  // ---------- building ----------

  #color(pick: (palette: Palette) => string): THREE.Color {
    const color = new THREE.Color();
    this.#themed.push([color, pick]);
    return color;
  }

  #material(pick: (palette: Palette) => string, options: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...options });
    this.#themed.push([material.color, pick]);
    return material;
  }

  #box(
    x: number,
    y: number,
    z: number,
    w: number,
    d: number,
    h: number,
    pick: ((palette: Palette) => string) | THREE.Material,
    parent: THREE.Object3D = this.#scene,
  ): THREE.Mesh {
    const material = typeof pick === "function" ? this.#material(pick) : pick;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.copy(at(x + w / 2, y + d / 2, z + h / 2));
    mesh.castShadow = h > 0.3;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  #buildLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.6);
    this.#themed.push([hemi.color, (p) => p.hemiSky], [hemi.groundColor, (p) => p.hemiGround]);
    this.#scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-18, 34, -6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -30;
    s.right = 30;
    s.top = 30;
    s.bottom = -30;
    s.near = 1;
    s.far = 90;
    sun.shadow.bias = -0.0005;
    this.#scene.add(sun);
  }

  #buildGround() {
    this.#box(GROUND.x, GROUND.y, -0.5, GROUND.w, GROUND.d, 0.5, (p) => p.ground).castShadow = false;
    const points: THREE.Vector3[] = [];
    for (let i = GROUND.x; i <= GROUND.x + GROUND.w; i += 2) points.push(at(i, GROUND.y, 0.01), at(i, GROUND.y + GROUND.d, 0.01));
    for (let j = GROUND.y; j <= GROUND.y + GROUND.d; j += 2) points.push(at(GROUND.x, j, 0.01), at(GROUND.x + GROUND.w, j, 0.01));
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: this.#color((p) => p.grid), transparent: true, opacity: 0.45 }),
    );
    this.#scene.add(grid);
    for (const [x, y, w, d] of WALKWAYS) this.#box(x, y, 0, w, d, 0.04, (p) => p.walkway).castShadow = false;
    const dashes: Array<[Point, Point]> = [
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
    const dashMaterial = new THREE.LineDashedMaterial({ color: this.#color((p) => p.dash), dashSize: 0.35, gapSize: 0.35 });
    for (const [a, b] of dashes) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([at(a[0], a[1], 0.06), at(b[0], b[1], 0.06)]), dashMaterial);
      line.computeLineDistances();
      this.#scene.add(line);
    }
  }

  #tree(x: number, y: number) {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.13, 1.2, 8),
      this.#material((p) => p.trunk),
    );
    trunk.position.copy(at(x, y, 0.6));
    trunk.castShadow = true;
    const crown = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.85, 1),
      this.#material((p) => p.leaf, { flatShading: true }),
    );
    crown.position.copy(at(x, y, 1.75));
    crown.castShadow = true;
    crown.receiveShadow = true;
    this.#scene.add(trunk, crown);
  }

  /** The stretches of a wall left after cutting its door gaps. */
  #segments(length: number, doors: number[]): Array<[number, number]> {
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
  }

  #walls(room: Room, height: (edge: Edge) => number, material: THREE.Material, parent: THREE.Object3D, thickness = 0.22) {
    const { x, y, w, d } = room;
    const doors = (edge: Edge, origin: number) => room.doors.filter(([e]) => e === edge).map(([, along]) => along - origin);
    for (const [a, b] of this.#segments(w, doors("y1", x)))
      this.#box(x + a, y - thickness, 0, b - a, thickness, height("y1"), material, parent);
    for (const [a, b] of this.#segments(w, doors("y2", x))) this.#box(x + a, y + d, 0, b - a, thickness, height("y2"), material, parent);
    for (const [a, b] of this.#segments(d, doors("x1", y)))
      this.#box(x - thickness, y + a, 0, thickness, b - a, height("x1"), material, parent);
    for (const [a, b] of this.#segments(d, doors("x2", y))) this.#box(x + w, y + a, 0, thickness, b - a, height("x2"), material, parent);
  }

  #monitor(x: number, y: number, tone: Tone, parent: THREE.Object3D = this.#scene) {
    this.#box(x, y, 0.75, 0.12, 0.9, 0.62, (p) => p.dark, parent);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 0.5),
      new THREE.MeshStandardMaterial({
        color: this.#color((p) => p.screen),
        emissive: this.#color((p) => p.tones[tone]),
        emissiveIntensity: 0.55,
      }),
    );
    screen.position.copy(at(x + 0.13, y + 0.45, 1.06));
    screen.rotation.y = Math.PI / 2;
    parent.add(screen);
  }

  #desk(x: number, y: number, w: number, d: number, parent: THREE.Object3D = this.#scene) {
    this.#box(x, y, 0.68, w, d, 0.08, (p) => p.furniture, parent);
    for (const [lx, ly] of [
      [x + 0.1, y + 0.1],
      [x + w - 0.18, y + 0.1],
      [x + 0.1, y + d - 0.18],
      [x + w - 0.18, y + d - 0.18],
    ] as const)
      this.#box(lx, ly, 0, 0.08, 0.08, 0.68, (p) => p.furniture, parent);
  }

  #paper(x: number, y: number, z: number) {
    this.#box(x, y, z, 0.6, 0.45, 0.02, () => "#ffffff").castShadow = false;
  }

  #buildRoom(room: Room) {
    const { x, y, w, d } = room;
    const floor = this.#box(x, y, 0, w, d, 0.25, (p) => p.rooms[room.id]);
    floor.castShadow = false;
    if (room.glass) {
      this.#buildLab(room);
      return;
    }
    const wall = this.#material((p) => p.wall);
    this.#walls(room, (edge) => (edge === "x1" || edge === "y1" ? 2.2 : 0.55), wall, this.#scene);
    const tones: Tone[] = ["paper", "lead", "code", "lab", "ver"];
    if (room.id === "read") {
      // Two bookcases along the back walls, a reading desk with the paper on it.
      this.#box(x + 0.3, y + 0.05, 0.25, 4, 0.6, 1.9, (p) => p.furniture);
      this.#box(x + 0.05, y + 1.2, 0.25, 0.6, 4, 1.9, (p) => p.furniture);
      for (let i = 0; i < 11; i += 1) {
        for (const [row, z] of [
          [0, 0.45],
          [1, 1.15],
        ] as const) {
          const tone = tones[(i + row * 2) % tones.length]!;
          this.#box(x + 0.45 + i * 0.34, y + 0.62, z, 0.22, 0.06, 0.55, (p) => p.tones[tone]).castShadow = false;
          this.#box(
            x + 0.67,
            y + 1.35 + i * 0.34,
            z,
            0.06,
            0.22,
            0.55,
            (p) => p.tones[tones[(i + row * 3 + 1) % tones.length]!],
          ).castShadow = false;
        }
      }
      this.#desk(x + 3, y + 2.4, 2.6, 1.4);
      this.#paper(x + 3.4, y + 2.7, 0.77);
      this.#paper(x + 4.3, y + 2.65, 0.77);
    } else if (room.id === "repo") {
      this.#desk(x + 1, y + 0.6, 1.2, 3.2);
      this.#monitor(x + 1.1, y + 0.75, "code");
      this.#monitor(x + 1.1, y + 2.7, "code");
      this.#desk(x + 4.6, y + 0.6, 1.2, 2.2);
      this.#monitor(x + 4.7, y + 0.8, "paper");
      this.#box(x + 6.6, y + 0.4, 0.25, 0.9, 0.9, 1.6, (p) => p.dark);
    } else if (room.id === "plan") {
      this.#box(x + 0.6, y + 0.02, 0.9, 5, 0.06, 1.1, () => "#ffffff");
      this.#box(x + 1.0, y + 0.09, 1.7, 1.2, 0.02, 0.06, (p) => p.tones.lead).castShadow = false;
      this.#box(x + 1.0, y + 0.09, 1.35, 2.0, 0.02, 0.06, (p) => p.tones.paper).castShadow = false;
      this.#box(x + 3.6, y + 0.09, 1.7, 1.4, 0.02, 0.06, (p) => p.tones.code).castShadow = false;
      this.#box(x + 3.6, y + 0.09, 1.45, 1.0, 0.02, 0.06, (p) => p.tones.code).castShadow = false;
      this.#desk(x + 2.6, y + 2.4, 3.4, 1.6);
      this.#paper(x + 3.4, y + 2.9, 0.77);
    } else if (room.id === "ver") {
      this.#desk(x + 2, y + 1.2, 2.4, 1.3);
      this.#monitor(x + 2.1, y + 1.3, "ver");
      this.#box(x + 0.4, y + 0.4, 0.25, 0.9, 2.2, 1.4, (p) => p.furniture);
      // The balance: one pan for the paper's number, one for the rerun's.
      const post = this.#material(() => "#8a5868");
      this.#box(x + 3.62, y + 1.82, 0.76, 0.06, 0.06, 0.75, post);
      this.#box(x + 3.2, y + 1.82, 1.48, 0.9, 0.06, 0.04, post);
      const pan = (px: number, tone: Tone, z: number) => {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.2, 0.12, 0.08, 16),
          this.#material((p) => p.tones[tone]),
        );
        mesh.position.copy(at(px, y + 1.85, z));
        mesh.castShadow = true;
        this.#scene.add(mesh);
      };
      pan(x + 3.22, "ver", 1.25);
      pan(x + 4.08, "paper", 1.32);
    } else if (room.id === "store") {
      for (let i = 0; i < 4; i += 1) this.#box(x + 0.4 + i * 1.25, y + 0.35, 0.25, 1, 0.9, 1.7, (p) => p.crate);
      for (let j = 0; j < 2; j += 1) this.#box(x + 0.35, y + 1.7 + j * 1.25, 0.25, 0.9, 1, 1.7, (p) => p.crate);
      for (let i = 0; i < 6; i += 1)
        this.#box(x + 3 + (i % 3) * 0.75, y + 3.4 + Math.floor(i / 3) * 0.9, 0.25, 0.6, 0.7, 0.35, (p) => p.crate);
    }
  }

  #buildLab(room: Room) {
    const { x, y, w, d } = room;
    // The lab's footprint stays drawn when no lab exists: a dashed outline and a floor grid.
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([at(x, y, 0.27), at(x + w, y, 0.27), at(x + w, y + d, 0.27), at(x, y + d, 0.27)]),
      new THREE.LineDashedMaterial({ color: this.#color((p) => p.tones.lab), dashSize: 0.4, gapSize: 0.3 }),
    );
    outline.computeLineDistances();
    const gridPoints: THREE.Vector3[] = [];
    for (let i = 1; i < w; i += 1) gridPoints.push(at(x + i, y, 0.26), at(x + i, y + d, 0.26));
    for (let j = 1; j < d; j += 1) gridPoints.push(at(x, y + j, 0.26), at(x + w, y + j, 0.26));
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(gridPoints),
      new THREE.LineBasicMaterial({ color: this.#color((p) => p.tones.lab), transparent: true, opacity: 0.25 }),
    );
    this.#scene.add(outline, grid);

    // Everything below exists only while a lab does: it grows in and dissolves with the real lab.
    const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.16, roughness: 0.1, depthWrite: false });
    this.#themed.push([glass.color, (p) => p.tones.lab]);
    this.#labGlass.push(glass);
    this.#walls(room, () => 2.6, glass, this.#lab, 0.08);
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 2.6, d)),
      new THREE.LineBasicMaterial({ color: this.#color((p) => p.tones.lab), transparent: true, opacity: 0.8 }),
    );
    frame.position.copy(at(x + w / 2, y + d / 2, 1.3 + 0.25));
    this.#labGlass.push(frame.material as THREE.Material);
    this.#lab.add(frame);
    const spots: Point[] = [
      [0.5, 0.5],
      [1.6, 0.5],
      [0.5, 1.6],
    ];
    for (const [sx, sy] of spots) {
      const group = new THREE.Group();
      this.#box(x + sx, y + sy, 0.25, 0.9, 0.9, 1.9, (p) => p.dark, group);
      const leds: THREE.MeshStandardMaterial[] = [];
      for (let i = 0; i < 5; i += 1) {
        for (let j = 0; j < 2; j += 1) {
          const led = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: j ? 0x5ff0c9 : 0x7fb2ff, emissiveIntensity: 0.2 });
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.08, 0.12), led);
          mesh.position.copy(at(x + sx + 0.91, y + sy + 0.25 + j * 0.4, 0.6 + i * 0.32));
          group.add(mesh);
          leds.push(led);
        }
      }
      this.#lab.add(group);
      this.#racks.push({ group, leds });
    }
    this.#desk(x + 4.5, y + 3.6, 2.2, 1.2, this.#lab);
    this.#monitor(x + 4.5, y + 3.75, "lab", this.#lab);
    this.#box(x + 6.3, y + 0.6, 0.25, 1.8, 1.2, 1.0, () => "#cdeee9", this.#lab);
    this.#lab.visible = false;
  }

  #buildParticles(): THREE.Points {
    const room = ROOMS.find((r) => r.id === "lab")!;
    const positions = new Float32Array(60 * 3);
    for (let i = 0; i < 60; i += 1) {
      const p = at(room.x + ((i * 37) % 90) / 10, room.y + ((i * 53) % 80) / 10, 0.3 + ((i * 29) % 26) / 10);
      positions.set([p.x, p.y, p.z], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.userData.base = positions.slice();
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.22, transparent: true, opacity: 0, depthWrite: false }));
    this.#themed.push([(points.material as THREE.PointsMaterial).color, (p) => p.tones.lab]);
    points.visible = false;
    this.#scene.add(points);
    return points;
  }

  #roomLabel(room: Room): { name: HTMLElement; sub: HTMLElement; root: HTMLElement } {
    let label = this.#roomLabels.get(room.id);
    if (label) return label;
    const root = document.createElement("div");
    root.className = "campus-room-label";
    const icon = document.createElement("span");
    icon.className = "campus-icon";
    icon.dataset.tone = ROOM_TONE[room.id];
    icon.textContent = ROOM_ICON[room.id];
    const text = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = room.name;
    const sub = document.createElement("small");
    text.append(name, sub);
    root.append(icon, text);
    const object = new CSS2DObject(root);
    object.position.copy(at(room.x + room.w / 2, room.y + room.d / 2, room.glass ? 4.0 : 3.4));
    this.#scene.add(object);
    label = { name, sub, root };
    this.#roomLabels.set(room.id, label);
    return label;
  }

  // ---------- model → scene ----------

  #makeAgent(agent: CampusAgent): AgentView {
    const group = new THREE.Group();
    const state = () => this.#agents.get(agent.key)?.agent.state ?? agent.state;
    const body = this.#material((p) => (state() === "stopped" ? p.tones.system : p.tones[agent.tone]), { roughness: 0.55 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.32, 6, 14), body);
    torso.position.y = 0.95;
    torso.castShadow = true;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.27, 20, 14),
      this.#material((p) => p.head, { roughness: 0.4 }),
    );
    head.position.y = 1.55;
    head.castShadow = true;
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.12, 0.1),
      this.#material((p) => p.visor, { roughness: 0.3 }),
    );
    visor.position.set(0, 1.57, 0.22);
    const antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.015, 0.2, 6),
      this.#material(() => "#9aa6c4"),
    );
    antenna.position.y = 1.9;
    const tip = this.#material((p) => p.tones[agent.tone], { emissiveIntensity: 0.4 });
    const tipMesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), tip);
    tipMesh.position.y = 2.02;
    const legMaterial = this.#material((p) => new THREE.Color(p.tones[agent.tone]).multiplyScalar(0.55).getStyle());
    const leg = (side: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.11, 0.6, 0);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.5, 8), legMaterial);
      mesh.position.y = -0.25;
      mesh.castShadow = true;
      pivot.add(mesh);
      group.add(pivot);
      return pivot;
    };
    const legs: [THREE.Object3D, THREE.Object3D] = [leg(-1), leg(1)];
    const carry = new THREE.Group();
    const sheet = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.52, 0.03), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    const band = new THREE.MeshStandardMaterial({ color: 0x3d63e8 });
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.035), band);
    stripe.position.y = 0.14;
    carry.add(sheet, stripe);
    carry.position.set(0.3, 1.0, 0.25);
    carry.rotation.y = -0.4;
    carry.visible = false;
    const dots: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i += 1) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), body);
      dot.position.set(-0.18 + i * 0.18, 2.25, 0);
      group.add(dot);
      dots.push(dot);
    }
    // An invisible, larger target so hovering finds the agent easily.
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 2.1, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 1.05;
    hit.userData.key = agent.key;
    group.add(torso, head, visor, antenna, tipMesh, carry, hit);
    const bubbleElement = document.createElement("div");
    bubbleElement.className = "campus-bubble";
    bubbleElement.dataset.tone = agent.tone;
    const bubble = new CSS2DObject(bubbleElement);
    bubble.position.y = 2.7;
    bubble.visible = false;
    group.add(bubble);
    this.#scene.add(group);
    const view: AgentView = { agent, group, body, tip, legs, carry, band, dots, hit, bubble };
    if (this.#palette) this.#applyTheme(true);
    return view;
  }

  #syncAgents(model: CampusModel) {
    const keys = new Set(model.agents.map((agent) => agent.key));
    for (const [key, view] of this.#agents) {
      if (keys.has(key)) continue;
      view.group.removeFromParent();
      view.bubble.element.remove();
      this.#agents.delete(key);
    }
    for (const agent of model.agents) {
      const existing = this.#agents.get(agent.key);
      if (existing) {
        const recolor = existing.agent.state !== agent.state;
        existing.agent = agent;
        if (recolor && this.#palette)
          existing.body.color.set(agent.state === "stopped" ? this.#palette.tones.system : this.#palette.tones[agent.tone]);
      } else {
        this.#agents.set(agent.key, this.#makeAgent(agent));
      }
    }
  }

  #roomSubtitle(room: Room, model: CampusModel): string {
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
    const agents = model.agents.filter((agent) => agent.zone === room.id);
    if (agents.length === 0) return "no agent yet";
    const names = [...new Set(agents.map((agent) => agent.name))];
    const lead = names.length === 1 ? names[0]! : `${agents.length} agents`;
    if (agents.some((agent) => agent.state === "working")) return `${lead} · working`;
    return agents.every((agent) => agent.state === "done") ? `${lead} · done` : lead;
  }

  #syncLabels(model: CampusModel) {
    for (const room of ROOMS) {
      const label = this.#roomLabel(room);
      const sub = this.#roomSubtitle(room, model);
      if (label.sub.textContent !== sub) label.sub.textContent = sub;
      label.root.dataset.active = String(room.id === "lab" && model.lab?.running === true);
    }
    this.#filedCrate.visible = model.status !== null || model.handoffs.some((handoff) => handoff.carry === "report");
    const racks = Math.max(1, Math.min(3, model.labsActive || model.labCount));
    this.#racks.forEach((rack, index) => (rack.group.visible = index < racks));
  }

  // ---------- per frame ----------

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

  #labAlpha(): number {
    const model = this.#model;
    if (!model || model.labPresence === "absent") return 0;
    if (model.labPresence === "active") return Math.min(1, Math.max(0, (this.#clock - (this.#labShownAt ?? -Infinity)) / FADE));
    return Math.max(0, 1 - (this.#clock - (this.#labGoneAt ?? -Infinity)) / FADE);
  }

  #applyTheme(force = false) {
    const palette = this.#dark?.matches ? DARK : LIGHT;
    if (palette === this.#palette && !force) return;
    this.#palette = palette;
    for (const [color, pick] of this.#themed) color.set(pick(palette));
    this.#scene.background = new THREE.Color(palette.sky);
    this.#scene.fog = new THREE.Fog(palette.sky, 90, 190);
  }

  #clampTarget() {
    const target = this.#controls.target;
    const before = target.clone();
    target.x = THREE.MathUtils.clamp(target.x, -GROUND.w / 2, GROUND.w / 2);
    target.z = THREE.MathUtils.clamp(target.z, -GROUND.d / 2, GROUND.d / 2);
    target.y = 0;
    if (!before.equals(target)) this.#camera.position.add(target.clone().sub(before));
  }

  #update() {
    this.#applyTheme();
    this.#controls.update();
    const t = this.#clock;
    const model = this.#model;

    // The lab grows in and dissolves.
    const alpha = this.#labAlpha();
    this.#lab.visible = alpha > 0.001;
    this.#lab.scale.y = Math.max(0.001, alpha);
    this.#labGlass.forEach((material, index) => (material.opacity = (index === 0 ? 0.16 : 0.8) * alpha));
    const running = model?.labPresence === "active" && model.lab?.running === true;
    for (const rack of this.#racks) {
      rack.leds.forEach((led, i) => {
        const on = running ? (Math.floor(t * 8) + i * 3) % 4 !== 0 : i < 2;
        led.emissiveIntensity = on ? 1.6 : 0.15;
      });
    }
    this.#labBar.visible = running && alpha > 0.5;
    if (this.#labBar.visible) {
      const phase = this.#reduced ? 0.35 : (t * 0.6) % 1;
      (this.#labBar.element.firstElementChild as HTMLElement).style.left = `${70 * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2))}%`;
    }
    const gone = model?.labPresence === "removed" && this.#labGoneAt !== null ? (t - this.#labGoneAt) / (FADE + 1.5) : -1;
    this.#particles.visible = gone >= 0 && gone <= 1;
    if (this.#particles.visible) {
      const attribute = this.#particles.geometry.getAttribute("position") as THREE.BufferAttribute;
      const base = this.#particles.geometry.userData.base as Float32Array;
      for (let i = 0; i < attribute.count; i += 1) attribute.setY(i, base[i * 3 + 1]! + gone * 3 * (0.5 + (i % 5) / 5));
      attribute.needsUpdate = true;
      (this.#particles.material as THREE.PointsMaterial).opacity = 1 - gone;
    }

    // Agents: home, or walking a handoff there and back.
    for (const view of this.#agents.values()) {
      const { agent, group } = view;
      const home = homeOf(agent);
      const active = this.#walkOf(agent.key);
      let x = home[0];
      let y = home[1];
      let dx = 1;
      let dy = 1;
      let moving = false;
      let carry: Carry | null = null;
      let arrived: Walk | null = null;
      if (active) {
        const { walk, elapsed } = active;
        const out = walk.length / SPEED;
        const place =
          elapsed < out
            ? along(walk.there, elapsed * SPEED)
            : elapsed < out + DWELL
              ? along(walk.there, walk.length)
              : along(walk.back, (elapsed - out - DWELL) * SPEED);
        ({ x, y, dx, dy } = place);
        moving = elapsed < out || elapsed >= out + DWELL;
        if (elapsed < out) carry = walk.handoff.carry;
        if (!moving) arrived = walk;
      }
      const bob = this.#reduced ? 0 : moving ? Math.abs(Math.sin(t * 10)) * 0.08 : Math.sin(t * 2.2 + agent.slot) * 0.03;
      group.position.copy(at(x, y, 0.25 + bob));
      if (active) group.rotation.y = Math.atan2(dx, dy);
      const swing = moving && !this.#reduced ? Math.sin(t * 10) * 0.5 : 0;
      view.legs[0].rotation.x = swing;
      view.legs[1].rotation.x = -swing;
      view.carry.visible = carry !== null;
      if (carry && this.#palette) {
        const band: Record<Carry, Tone> = { claim: "paper", code: "code", plan: "lead", metric: "lab", report: "ver" };
        view.band.color.set(this.#palette.tones[band[carry]]);
      }
      const working = !moving && agent.state === "working";
      const lit = this.#reduced ? 3 : Math.floor(t * 3) % 4;
      view.dots.forEach((dot, i) => (dot.visible = working && i < Math.max(1, lit)));
      view.tip.emissive.set(
        agent.state === "blocked" ? "#e0a44a" : agent.state === "working" ? this.#palette!.tones[agent.tone] : "#000000",
      );
      view.bubble.visible = arrived !== null;
      if (arrived && view.bubble.element.textContent !== BUBBLES[arrived.handoff.carry])
        view.bubble.element.textContent = BUBBLES[arrived.handoff.carry];
    }

    // Hover: name and activity of the agent under the pointer.
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const hits = this.#raycaster.intersectObjects(
      [...this.#agents.values()].map((view) => view.hit),
      false,
    );
    const key = (hits[0]?.object.userData.key as string | undefined) ?? null;
    if (key !== this.#hovered) {
      this.#hovered = key;
      this.#renderer.domElement.style.cursor = key ? "pointer" : "";
    }
    const hovered = key ? this.#agents.get(key) : undefined;
    this.#tooltip.visible = hovered !== undefined;
    if (hovered) {
      const text = `${hovered.agent.name}${hovered.agent.label ? ` · ${hovered.agent.label}` : ""}\n${hovered.agent.activity || hovered.agent.state}`;
      if (this.#tooltip.element.textContent !== text) this.#tooltip.element.textContent = text;
      this.#tooltip.position.copy(hovered.group.position).add(new THREE.Vector3(0, 2.6, 0));
    }

    if (model && this.#roomLabels.get("lab")) {
      const lab = ROOMS.find((room) => room.id === "lab")!;
      const sub = this.#roomSubtitle(lab, model);
      const label = this.#roomLabels.get("lab")!;
      if (label.sub.textContent !== sub) label.sub.textContent = sub;
    }

    this.#renderer.render(this.#scene, this.#camera);
    this.#labelRenderer.render(this.#scene, this.#camera);
  }
}
