// The 3D Research Campus: scene, robot agents, labels, camera stations and the scroll-driven story.
// Shares one module scope with 10_page.js (uses: $, $$, RM, sstep, root, secs, renderChip, revealSeal, gateBlocked, gateOutcome?, lastChapter, commitment)
// and with build.mjs's ROBOT_GLB_B64 (RobotExpressive by Tomás Laulhé / Quaternius, CC0, from the three.js r169 examples).
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
// ───────────── the Research Campus ─────────────
const fontsReady = Promise.race([
  Promise.all(['500 40px "Newsreader"', '600 20px "JetBrains Mono"', '600 20px "Schibsted Grotesk"'].map((f) => document.fonts.load(f))),
  new Promise((r) => setTimeout(r, 2500)),
]).catch(() => {});
fontsReady.then(start3D).catch((err) => { console.warn('3D campus unavailable:', err); root.classList.add('no-gl'); fallbackScroll(); });

function fallbackScroll() { // no WebGL: still drive the strip, the chip and the reveal from scroll
  const tick = () => { const mid = innerHeight * 0.5; let ch = 0; secs.forEach((s, i) => { if (s.getBoundingClientRect().top < mid) ch = i; });
    root.classList.toggle('revealed', ch >= 9); if (ch >= 9) revealSeal(); renderChip(ch); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
// the policy gate's outcome, read defensively (10_page.js may expose gateOutcome: 'pass' | 'block' | 'refuse')
const gateState = () => (typeof gateOutcome !== 'undefined' ? gateOutcome : (gateBlocked ? 'block' : 'pass'));

async function start3D() {
  const canvas = $('#stage');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 required');
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const SMALL = Math.min(innerWidth, innerHeight) < 600;
  const BG = 0xeceef4;
  renderer.setClearColor(BG, 1);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BG, 150, 360);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 500);
  scene.add(new THREE.HemisphereLight(0xf7f8ff, 0xbcc2d3, 1.25));
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.9); sun.position.set(36, 58, 32); sun.target.position.set(16, 0, 15);
  sun.castShadow = true; const SM = SMALL ? 1024 : 2048; sun.shadow.mapSize.set(SM, SM);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 180 }); sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.025;
  const fill = new THREE.DirectionalLight(0xdfe6ff, 0.6); fill.position.set(-30, 22, -24); fill.target.position.set(16, 0, 15);
  scene.add(sun, sun.target, fill, fill.target);

  // ── palette: an architectural model in the page's colours (DéjàML's own campus look, warmer)
  const C = { ground: 0xdde1eb, base: 0xe9ebf3, side: 0xcbd1de, walk: 0xf9fafc, wall: 0xfcfdff, cap: 0xd9dee9, ink: 0x151a2d, indigo: 0x3a4fd8, indigoSoft: 0xe5e9fd,
    seal: 0xd9480f, manila: 0xf0e3cb, manilaDark: 0xe2d1b1, glass: 0x7fd6c9, desk: 0xf4f5f9, leg: 0xc5cbd8, dark: 0x2a2f42, slate: 0x3b4256, wood: 0xb08a63,
    leaf1: 0x5aa77e, leaf2: 0x4a9670, leaf3: 0x78bd92, trunk: 0x9c7552, pot: 0xd9c7b0,
    p: 0x3a5be0, c: 0x7655d6, r: 0xc18a0b, l: 0x0f9b8e, d: 0x64748b, v: 0xd6336c, s: 0x334155, skin: 0xf0dac4, hair: 0x2b2f3f };
  const CSS = { p: '#3a5be0', c: '#7655d6', r: '#c18a0b', l: '#0f9b8e', d: '#64748b', v: '#d6336c', s: '#334155' };
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.86, metalness: 0, ...o.extra });
  const M = { base: std(C.base), side: std(C.side), walk: std(C.walk, { rough: 0.95 }), wall: std(C.wall), cap: std(C.cap), desk: std(C.desk), leg: std(C.leg), dark: std(C.dark, { rough: 0.6 }),
    slate: std(C.slate, { rough: 0.7 }), ink: std(C.ink), indigo: std(C.indigo, { rough: 0.6 }), seal: std(C.seal, { rough: 0.5 }), manila: std(C.manila), manilaDark: std(C.manilaDark),
    white: std(0xffffff), wood: std(C.wood, { rough: 0.8 }), pot: std(C.pot), skin: std(C.skin, { rough: 0.8 }), hair: std(C.hair, { rough: 0.9 }) };
  const UNIT = new THREE.BoxGeometry(1, 1, 1);
  const mesh = (geo, mat, parent = scene, pos = [0, 0, 0], rot = [0, 0, 0], shadow = true) => {
    const o = new THREE.Mesh(geo, mat); o.position.set(...pos); o.rotation.set(...rot); o.castShadow = shadow; o.receiveShadow = true; parent.add(o); return o;
  };
  // a box resting on y (w × h × d), on a shared unit geometry
  const box = (w, h, d, mat, x, y, z, parent = scene, ry = 0, shadow = true) => { const o = mesh(UNIT, mat, parent, [x, y + h / 2, z], [0, ry, 0], shadow); o.scale.set(w, h, d); return o; };
  function tex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); draw(g, w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.userData = { c, g }; return t; }
  const FD = '"Newsreader", Georgia, serif', FM = '"JetBrains Mono", Menlo, monospace', FB = '"Schibsted Grotesk", system-ui, sans-serif';
  const texMat = (t, o = {}) => new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, transparent: !!o.transparent, side: o.side ?? THREE.FrontSide, depthWrite: o.depthWrite ?? true });
  const plane = (w, h, t, parent, pos, rot, opts = {}) => mesh(new THREE.PlaneGeometry(w, h), texMat(t, opts), parent, pos, rot, !!opts.shadow);
  // flat, unlit cards (tags, numbers, carried documents): always crisp, never shaded
  const card = (w, h, t, parent = scene) => { const o = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }));
    o.position.y = -20; o.renderOrder = 4; parent.add(o); return o; };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const roundRect = (g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const DESK_H = 0.6, DESK_TOP = DESK_H + 0.07;   // desks sized for the robots

  // ── the ground, the model base, the walkways
  mesh(new THREE.PlaneGeometry(600, 600), std(C.ground), scene, [16, -0.62, 15], [-Math.PI / 2, 0, 0], false);
  const BX0 = -14, BX1 = 46, BZ0 = -7, BZ1 = 37;
  box(BX1 - BX0, 0.6, BZ1 - BZ0, [M.side, M.side, M.base, M.side, M.side, M.side], (BX0 + BX1) / 2, -0.6, (BZ0 + BZ1) / 2, scene, 0, false);
  { // a faint survey grid and the campus name, painted on the base
    const W = 4096, H = Math.round(4096 * (BZ1 - BZ0) / (BX1 - BX0)), u = W / (BX1 - BX0);
    const X = (x) => (x - BX0) * u, Z = (z) => (z - BZ0) * u;
    const t = tex(W, H, (g) => {
      g.fillStyle = '#e9ebf3'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(58,79,216,0.06)'; g.lineWidth = 2;
      for (let x = Math.ceil(BX0); x <= BX1; x += 2) { g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), H); g.stroke(); }
      for (let z = Math.ceil(BZ0); z <= BZ1; z += 2) { g.beginPath(); g.moveTo(0, Z(z)); g.lineTo(W, Z(z)); g.stroke(); }
      g.fillStyle = '#8a92a9'; g.font = `600 ${u * 0.7}px ${FM}`; g.fillText('DÉJÀML · RESEARCH CAMPUS', X(-11.5), Z(35.6));
      g.fillStyle = '#a5acc0'; g.font = `500 ${u * 0.45}px ${FM}`;
      g.fillText('INTAKE + SEAL', X(-8.7), Z(19.3)); g.fillText('POLICY GATE', X(23.2), Z(16.4)); g.fillText('PREP · APPROVED SITES ONLY', X(17.6), Z(35.4));
    });
    mesh(new THREE.PlaneGeometry(BX1 - BX0, BZ1 - BZ0), texMat(t), scene, [(BX0 + BX1) / 2, 0.002, (BZ0 + BZ1) / 2], [-Math.PI / 2, 0, 0], false);
  }
  const WALKS = [[-9, 13.2, 41, 14.8], [13.7, 2, 15.3, 29.5], [12, 6.9, 13.7, 8.3], [12, 19.9, 13.7, 21.3], [20.8, 11, 22.2, 13.2], [20.8, 14.8, 22.2, 17],
    [26, 20.7, 27.9, 22.1], [27.9, 14.8, 29.5, 29.5], [29.5, 17, 33.7, 18.6], [29.5, 27.9, 33.7, 29.5], [32.3, 27, 33.7, 27.9], [20.8, 25, 22.2, 29.6]];
  WALKS.forEach(([x0, z0, x1, z1], i) => box(x1 - x0, 0.03 + i * 0.0004, z1 - z0, M.walk, (x0 + x1) / 2, 0, (z0 + z1) / 2, scene, 0, false));

  // ── rooms, from DéjàML's own floor plan (apps/web/src/components/campus/layout.ts)
  const ROOMS = [
    { id: 'read', x: 4, y: 4, w: 8, d: 7, tint: 0xdbe2ff, doors: [['x2', 7.6]] },
    { id: 'plan', x: 17, y: 4, w: 8, d: 7, tint: 0xfbe7c6, doors: [['y2', 21.5]] },
    { id: 'repo', x: 4, y: 17, w: 8, d: 7, tint: 0xe6dcfb, doors: [['x2', 20.6]] },
    { id: 'lab', x: 17, y: 17, w: 9, d: 8, tint: 0xcdeee6, glass: true, doors: [['y1', 21.5], ['x2', 21.4]] },
    { id: 'ver', x: 30, y: 9, w: 7, d: 8, tint: 0xfbd8e2, doors: [['y2', 33]] },
    { id: 'store', x: 30, y: 21, w: 6, d: 6, tint: 0xdbe2ff, doors: [['y2', 33]] },
  ];
  const glassM = new THREE.MeshStandardMaterial({ color: C.glass, transparent: true, opacity: 0.18, roughness: 0.15, depthWrite: false, side: THREE.DoubleSide });
  const edgeM = new THREE.LineBasicMaterial({ color: 0x4fae9f });
  const wallH = 1.2, wallT = 0.22, gap = 1.7;
  const EDGES_UNIT = new THREE.EdgesGeometry(UNIT);
  for (const r of ROOMS) {
    box(r.w, 0.07, r.d, std(r.tint), r.x + r.w / 2, 0, r.y + r.d / 2, scene, 0, false);
    const edges = { y1: [[r.x, r.y], [r.x + r.w, r.y]], y2: [[r.x, r.y + r.d], [r.x + r.w, r.y + r.d]], x1: [[r.x, r.y], [r.x, r.y + r.d]], x2: [[r.x + r.w, r.y], [r.x + r.w, r.y + r.d]] };
    for (const [e, [[ax, az], [bx, bz]]] of Object.entries(edges)) {
      const along = e[0] === 'y' ? 'x' : 'z', a0 = along === 'x' ? ax : az, a1 = along === 'x' ? bx : bz;
      const cuts = r.doors.filter(([de]) => de === e).map(([, p]) => p).sort((p, q) => p - q);
      let s = a0; const segs = [];
      for (const p of cuts) { segs.push([s, p - gap / 2]); s = p + gap / 2; }
      segs.push([s, a1]);
      for (const [p0, p1] of segs) {
        if (p1 - p0 < 0.05) continue;
        const len = p1 - p0 + (r.glass ? 0 : wallT), mid = (p0 + p1) / 2, h = r.glass ? 2.1 : wallH;
        const [w, d] = along === 'x' ? [len, wallT] : [wallT, len];
        const [cx, cz] = along === 'x' ? [mid, az] : [ax, mid];
        if (r.glass) {
          const g = new THREE.Mesh(UNIT, glassM); g.scale.set(w, h, d); g.position.set(cx, h / 2, cz); scene.add(g);
          const l = new THREE.LineSegments(EDGES_UNIT, edgeM); l.scale.copy(g.scale); l.position.copy(g.position); scene.add(l);
        } else { box(w, h, d, M.wall, cx, 0, cz); box(w + 0.05, 0.05, d + 0.05, M.cap, cx, h, cz, scene, 0, false); }
      }
    }
  }

  // ── trees around the campus (DéjàML's TREES, plus a ring at the edge of the model)
  {
    const pts = [[1, 2], [1, 9], [0.5, 15], [1.5, 26], [2, 30], [8, 29], [13, 28], [18, 29], [24, 29.5], [27, 2], [29, 5], [33, 4], [38, 6], [39.5, 12], [39, 20], [38.5, 27], [38, 31], [15.5, 1.5], [10, 1], [25.5, 15.5],
      [-11.5, 3], [-10.5, 31], [-4, 33.5], [3.5, 34.5], [42.5, 33], [44, 22], [43.5, 9], [-1, -4.5], [8, -5.2], [19, -5.5], [31, -4.8], [41, -3.5], [-12.5, -3], [44, -4]];
    const blocked = (x, z) => ROOMS.some((r) => x > r.x - 0.8 && x < r.x + r.w + 0.8 && z > r.y - 0.8 && z < r.y + r.d + 0.8)
      || WALKS.some(([x0, z0, x1, z1]) => x > x0 - 0.7 && x < x1 + 0.7 && z > z0 - 0.7 && z < z1 + 0.7)
      || Math.hypot(x + 6, z - 14) < 4.6 || (x > 18 && x < 25.5 && z > 28.5 && z < 35);
    const spots = pts.filter(([x, z]) => !blocked(x, z) && x > BX0 + 0.8 && x < BX1 - 0.8 && z > BZ0 + 0.8 && z < BZ1 - 0.8);
    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.16, 1, 6).translate(0, 0.5, 0);
    const crownGeo = new THREE.IcosahedronGeometry(1, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, std(C.trunk, { rough: 0.9 }), spots.length);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true }), spots.length * 2);
    trunks.castShadow = crowns.castShadow = true; trunks.receiveShadow = crowns.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), leaves = [C.leaf1, C.leaf2, C.leaf3].map((c) => new THREE.Color(c));
    spots.forEach(([x, z], i) => {
      const s = 0.85 + ((i * 37) % 10) / 22, th = 1.0 + ((i * 13) % 7) / 10;
      m4.compose(V(x, 0, z), q.identity(), V(s, th * s, s)); trunks.setMatrixAt(i, m4);
      q.setFromEuler(e.set(0.2 * (i % 3), i * 1.7, 0.15 * (i % 2)));
      m4.compose(V(x, th * s + 0.75 * s, z), q, V(0.95 * s, 1.05 * s, 0.95 * s)); crowns.setMatrixAt(i * 2, m4); crowns.setColorAt(i * 2, leaves[i % 3]);
      m4.compose(V(x + 0.18 * s, th * s + 1.45 * s, z - 0.1 * s), q, V(0.62 * s, 0.7 * s, 0.62 * s)); crowns.setMatrixAt(i * 2 + 1, m4); crowns.setColorAt(i * 2 + 1, leaves[(i + 1) % 3]);
    });
    scene.add(trunks, crowns);
  }

  // ── furniture
  function desk(x, z, w = 2.2, d = 1.0, ry = 0, parent = scene) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; parent.add(g);
    box(w, 0.07, d, M.desk, 0, DESK_H, 0, g); box(0.07, DESK_H, d * 0.86, M.leg, -w / 2 + 0.12, 0, 0, g); box(0.07, DESK_H, d * 0.86, M.leg, w / 2 - 0.12, 0, 0, g);
    return g;
  }
  function chair(x, z, ry, color = 0x9aa3ba, parent = scene) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; parent.add(g);
    const m = std(color, { rough: 0.7 });
    box(0.46, 0.06, 0.46, m, 0, 0.4, 0, g); box(0.46, 0.46, 0.06, m, 0, 0.46, -0.2, g); box(0.05, 0.4, 0.05, M.leg, 0, 0, 0, g);
    return g;
  }
  function plant(x, z, s = 1) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(s); scene.add(g);
    mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.36, 10), M.pot, g, [0, 0.18, 0]);
    const lm = new THREE.MeshStandardMaterial({ color: C.leaf2, roughness: 0.85, flatShading: true });
    mesh(new THREE.IcosahedronGeometry(0.32, 0), lm, g, [0, 0.62, 0]); mesh(new THREE.IcosahedronGeometry(0.22, 0), lm, g, [0.12, 0.88, 0.04]);
    return g;
  }
  // a monitor whose stand rests at pos (pos.y = the desk top)
  function screen(parent, t, w, h, pos, ry = 0) {
    const g = new THREE.Group(); g.position.set(...pos); g.rotation.y = ry; parent.add(g);
    box(0.3, 0.03, 0.2, M.dark, 0, 0, 0, g); box(0.06, 0.24, 0.06, M.dark, 0, 0, 0, g); box(w + 0.08, h + 0.08, 0.06, M.dark, 0, 0.24, 0, g);
    mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, toneMapped: false }), g, [0, 0.24 + (h + 0.08) / 2, 0.035], [0, 0, 0], false);
    return g;
  }
  const termTex = (lines, head) => tex(512, 320, (g, w, h) => {
    g.fillStyle = '#11141d'; g.fillRect(0, 0, w, h); g.fillStyle = '#8fa2ff'; g.font = `600 20px ${FM}`; g.fillText(head, 18, 34);
    g.fillStyle = '#d7dde8'; g.font = `400 17px ${FM}`; lines.forEach((l, i) => g.fillText(l, 18, 70 + i * 28));
  });
  const rug = (x, z, w, d, color) => mesh(new THREE.PlaneGeometry(w, d), std(color, { rough: 1 }), scene, [x, 0.075, z], [-Math.PI / 2, 0, 0], false);

  // the paper (real excerpt: ROCKET, page 25, Table 1, row ECG200)
  const pageTex = tex(1024, 1320, (g, w, h) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#151a2d'; g.font = `500 46px ${FD}`;
    ['ROCKET: Exceptionally Fast and Accurate', 'Time Series Classification Using', 'Random Convolutional Kernels'].forEach((l, i) => g.fillText(l, 70, 124 + i * 56));
    g.fillStyle = '#d6dbe7'; for (let i = 0; i < 9; i++) g.fillRect(70, 330 + i * 30, 880 - (i % 3) * 120, 12);
    g.fillStyle = '#586078'; g.font = `600 30px ${FM}`; g.fillText('Table 1 · page 25', 70, 690);
    g.fillStyle = '#c9cfdd'; g.fillRect(70, 712, 884, 3); g.fillRect(70, 860, 884, 3);
    g.fillStyle = '#151a2d'; g.font = `500 31px ${FM}`; g.fillText('ECG200', 80, 800);
    g.fillStyle = '#fdeae0'; g.fillRect(290, 760, 140, 58); g.strokeStyle = '#d9480f'; g.lineWidth = 5; g.strokeRect(290, 760, 140, 58);
    g.fillStyle = '#d9480f'; g.font = `600 31px ${FM}`; g.fillText('0.9060', 300, 800);
    g.fillStyle = '#586078'; g.font = `400 31px ${FM}`; g.fillText('0.8700  0.8300  0.8500', 460, 800);
    g.fillStyle = '#d6dbe7'; for (let i = 0; i < 10; i++) g.fillRect(70, 920 + i * 30, 880 - ((i + 1) % 3) * 140, 12);
  });
  const paperLit = (o) => { o.material.emissive = new THREE.Color(0xffffff); o.material.emissiveMap = pageTex; o.material.emissiveIntensity = 0.3; return o; };

  // Reading Room: shelves, a reading desk with the paper, a lamp, plants
  {
    const shelfTex = tex(512, 256, (g, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); const cols = ['#3a5be0', '#7655d6', '#c18a0b', '#0f9b8e', '#d6336c', '#334155', '#9aa2b8'];
      for (let row = 0; row < 3; row++) for (let x = 10, i = 0; x < w - 20; i++) { const bw = 14 + ((i * 37 + row * 11) % 18); g.fillStyle = cols[(i + row * 3) % cols.length]; g.fillRect(x, 12 + row * 82, bw, 66 - ((i * 13) % 20)); x += bw + 4; } });
    const sm = texMat(shelfTex);
    for (const x of [5.6, 8.0, 10.4]) box(2.2, 2.0, 0.5, [M.wall, M.wall, M.cap, M.wall, sm, M.wall], x, 0, 4.45);
    rug(8, 8.0, 3.8, 2.8, 0xc9d3fb);
    const d = desk(8, 8.2, 2.6, 1.2); paperLit(plane(0.9, 1.16, pageTex, d, [-0.25, DESK_TOP + 0.005, 0.0], [-Math.PI / 2, 0, 0.18]));
    paperLit(plane(0.62, 0.8, pageTex, d, [0.75, DESK_TOP + 0.006, 0.05], [-Math.PI / 2, 0, -0.25]));
    chair(6.3, 9.45, Math.PI - 0.4, 0x8fa0e8);
    box(0.06, 0.5, 0.06, M.dark, 9.0, DESK_TOP, 7.8); mesh(new THREE.ConeGeometry(0.2, 0.22, 16, 1, true), std(0xf2c14e, { extra: { side: THREE.DoubleSide } }), scene, [9.0, DESK_TOP + 0.58, 7.8]);
    plant(4.8, 10.2, 1.1); plant(11.2, 5.4, 0.9);
  }
  // Repo Room: two server racks, a desk whose screen shows the file tree
  {
    const rack = tex(256, 512, (g, w, h) => { g.fillStyle = '#262b3d'; g.fillRect(0, 0, w, h); for (let i = 0; i < 10; i++) { g.fillStyle = '#353b52'; g.fillRect(16, 20 + i * 48, w - 32, 36); g.fillStyle = i % 3 ? '#4cc38a' : '#8fa2ff'; g.fillRect(28, 34 + i * 48, 10, 8); g.fillRect(46, 34 + i * 48, 10, 8); } });
    const rm = texMat(rack);
    for (const x of [10.0, 11.15]) box(1.0, 2.2, 0.85, [M.dark, M.dark, M.dark, M.dark, rm, M.dark], x, 0, 18.0);
    rug(7.6, 21.2, 3.8, 2.6, 0xd6c8f6);
    const d = desk(7.3, 21.7, 2.6, 1.0, -0.45);
    screen(d, termTex(['code/', '  reproduce_experiments_ucr.py', '  rocket_functions.py', 'README.md', '! versions not pinned'], 'angus924/rocket @ 36bd908'), 1.2, 0.74, [-0.25, DESK_TOP, 0.05], 0);
    plant(4.8, 23.2, 1.0);
  }
  // Planning Room: long table, the plan on a board
  {
    rug(21, 7.4, 4.2, 2.6, 0xf6d9a3);
    desk(21, 7.4, 3.2, 1.3);
    for (const [x, z, ry] of [[19.9, 8.45, Math.PI], [22.1, 8.45, Math.PI], [19.9, 6.35, 0], [22.1, 6.35, 0]]) chair(x, z, ry, 0xe0b45a);
    const board = tex(1024, 640, (g, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.strokeStyle = '#d6dbe7'; g.lineWidth = 6; g.strokeRect(6, 6, w - 12, h - 12);
      g.fillStyle = '#c18a0b'; g.font = `600 34px ${FM}`; g.fillText('EXPERIMENT PLAN', 40, 70);
      g.fillStyle = '#151a2d'; g.font = `400 27px ${FM}`;
      ['python 3.11 · 7 pinned wheels', 'ECG200.zip  sha256 755937ea…', 'runner --runs 10 --kernels 10000', 'parse metrics.accuracyMean', 'stop if exit ≠ 0 or no result.json', 'expected result: (never stated)'].forEach((l, i) => g.fillText(l, 40, 140 + i * 74)); });
    const st = new THREE.Group(); st.position.set(20.6, 0, 4.75); scene.add(st);
    box(0.08, 1.25, 0.08, M.dark, -1.15, 0, 0, st); box(0.08, 1.25, 0.08, M.dark, 1.15, 0, 0, st);
    plane(2.4, 1.5, board, st, [0, 1.98, 0.05], [0, 0, 0]);
    paperLit(plane(0.7, 0.9, pageTex, scene, [20.4, DESK_TOP + 0.005, 7.4], [-Math.PI / 2, 0, 0.3]));
    plant(24.3, 10.3, 0.9); plant(17.7, 10.3, 0.8);
  }
  const BOARD_PT = V(20.2, 2.15, 4.86), BOARD_PT2 = V(21.0, 2.0, 4.86);
  // Disposable Lab: three engineer pods (glass on three sides, open to the north), a cut network cable
  const pods = [], podScreens = [];
  {
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group(); g.position.set(18.6 + i * 2.9, 0, 22.6); scene.add(g);
      for (const [w, x, z, ry] of [[2.5, 0, 1.3, 0], [2.6, -1.25, 0, Math.PI / 2], [2.6, 1.25, 0, Math.PI / 2]]) {
        const p = new THREE.Mesh(UNIT, glassM); p.scale.set(w, 1.7, 0.05); p.position.set(x, 0.85, z); p.rotation.y = ry; g.add(p);
        const l = new THREE.LineSegments(EDGES_UNIT, edgeM); l.scale.copy(p.scale); l.position.copy(p.position); l.rotation.y = ry; g.add(l);
      }
      box(2.4, 0.03, 2.5, std(0xb5e2d8), 0, 0.07, 0, g, 0, false);
      const d = desk(-0.25, 0.6, 1.6, 0.66, 0, g);
      const t = termTex(['$ python rocket_ecg200_runner.py', '  --runs 10 --kernels 10000'], `lab ${i + 1} · network: none`);
      screen(d, t, 0.9, 0.56, [-0.2, DESK_TOP, -0.02], 0.22);
      pods.push(g); podScreens.push(t);
    }
    const cable = new THREE.CatmullRomCurve3([V(16.75, 1.5, 19.2), V(16.1, 1.35, 19.4), V(15.6, 0.55, 19.9), V(15.3, 0.08, 20.6), V(14.95, 0.08, 21.25)]);
    mesh(new THREE.TubeGeometry(cable, 32, 0.05, 8), M.dark);
    mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.24, 12), M.seal, scene, [14.9, 0.09, 21.38], [Math.PI / 2, 0, 0.4]);
    const sign = tex(512, 160, (g, w, h) => { g.fillStyle = '#ffffff'; roundRect(g, 4, 4, w - 8, h - 8, 22); g.fill(); g.strokeStyle = '#d9480f'; g.lineWidth = 6; g.stroke();
      g.fillStyle = '#d9480f'; g.font = `700 44px ${FM}`; g.textAlign = 'center'; g.fillText('--network none', w / 2, 98); });
    const sg = new THREE.Group(); sg.position.set(16.4, 0, 18.3); sg.rotation.y = -0.6; scene.add(sg);
    box(0.05, 0.9, 0.05, M.dark, 0, 0, 0, sg); plane(1.2, 0.38, sign, sg, [0, 1.05, 0.03], [0, 0, 0]);
  }
  // Verification Desk: a balance with the observation and, later, the sealed envelope
  const scale = new THREE.Group(); scale.position.set(33.5, DESK_TOP, 12.6); scene.add(scale);
  const beam = new THREE.Group(); beam.position.y = 1.08; scale.add(beam);
  const pans = [];
  {
    rug(33.5, 12.6, 4.6, 3.2, 0xf7c4d3);
    desk(33.5, 12.6, 3.2, 1.4);
    mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.08, 24), M.dark, scale, [0, 0.04, 0]);
    mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.08, 10), M.dark, scale, [0, 0.56, 0]);
    mesh(new THREE.ConeGeometry(0.09, 0.16, 12), M.dark, scale, [0, 1.17, 0]);
    box(2.5, 0.06, 0.08, M.dark, 0, -0.03, 0, beam);
    for (const s of [-1, 1]) {
      const hang = new THREE.Group(); hang.position.set(s * 1.15, 0, 0); beam.add(hang);
      mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.52, 6), M.dark, hang, [0, -0.26, 0]);
      const pan = mesh(new THREE.CylinderGeometry(0.6, 0.5, 0.05, 32), M.white, hang, [0, -0.54, 0]);
      pans.push({ hang, pan });
    }
    plant(36.3, 9.9, 0.9); plant(30.7, 16.1, 0.85);
    box(0.06, 0.5, 0.06, M.dark, 34.75, DESK_TOP, 12.1); mesh(new THREE.ConeGeometry(0.2, 0.22, 16, 1, true), std(0xf2c14e, { extra: { side: THREE.DoubleSide } }), scene, [34.75, DESK_TOP + 0.58, 12.1]);
  }
  const numTex = (txt, color) => tex(512, 200, (g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = color; g.font = `500 150px ${FD}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, w / 2, h / 2 + 8); });
  const obsBox = box(0.52, 0.38, 0.52, M.indigo, 0, -0.52, 0, pans[0].hang);
  const obsNum = card(1.25, 0.49, numTex('0.904', '#3a4fd8'), pans[0].hang); obsNum.position.set(0, 0.5, 0);
  // Run Store: shelves of receipts, the report stack
  const reports = [];
  {
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Group(); s.position.set(31.3 + i * 1.7, 0, 22.0); scene.add(s);
      box(1.4, 1.95, 0.6, M.wall, 0, 0, 0, s); box(1.45, 0.05, 0.65, M.cap, 0, 1.95, 0, s, 0, false);
      for (let k = 0; k < 4; k++) for (let j = 0; j < 3; j++) box(0.36, 0.3, 0.42, std([0xd9e0ff, 0xe6dcfb, 0xfbe7c6, 0xcdeee6][(i + k + j) % 4]), -0.42 + j * 0.42, 0.12 + k * 0.45, 0.12, s);
    }
    desk(33, 25.2, 2.4, 1.0);
    for (let i = 0; i < 8; i++) reports.push(box(0.8, 0.05, 1.0, M.white, 32.45 + (i % 2) * 0.05, DESK_TOP + i * 0.055, 25.2, scene, (i % 3 - 1) * 0.05));
    plant(35.3, 26.2, 0.85);
  }
  const STACK_PT = V(32.47, DESK_TOP + 0.5, 25.2);

  // ── intake: the paper on its easel, the sealing table, the envelope, the stamp
  const INTAKE = V(-6, 0, 14);
  mesh(new THREE.CylinderGeometry(3.45, 3.55, 0.14, 56), std(C.indigoSoft), scene, [INTAKE.x, 0.07, INTAKE.z], [0, 0, 0], false);
  mesh(new THREE.TorusGeometry(3.45, 0.045, 6, 72), M.indigo, scene, [INTAKE.x, 0.145, INTAKE.z], [Math.PI / 2, 0, 0], false);
  const easel = new THREE.Group(); easel.position.set(INTAKE.x - 1.0, 0, INTAKE.z - 0.6); scene.add(easel);
  easel.lookAt(V(2.5, 0, 24)); // face the intake cameras (south-east)
  {
    // legs stand behind the board, so they never cross the page
    box(0.08, 3.5, 0.08, M.wood, -0.95, 0, -0.22, easel, 0); box(0.08, 3.5, 0.08, M.wood, 0.95, 0, -0.22, easel, 0); box(0.08, 3.3, 0.08, M.wood, 0, 0, -0.95, easel, 0);
    const board = new THREE.Group(); board.position.set(0, 2.35, 0.2); board.rotation.x = -0.1; easel.add(board);
    box(2.66, 3.36, 0.07, M.slate, 0, -1.68, -0.04, board);
    box(2.7, 0.08, 0.22, M.wood, 0, -1.72, 0.06, board);
    easel.userData.page = paperLit(plane(2.44, 3.14, pageTex, board, [0, 0, 0.0], [0, 0, 0], { shadow: true }));
  }
  // the page cell holding 0.9060, in the page's own coordinates (canvas 290..430 × 760..818 of 1024 × 1320)
  const CELL = V((360 / 1024 - 0.5) * 2.44, (0.5 - 789 / 1320) * 3.14, 0.03);
  const sealTable = new THREE.Group(); sealTable.position.set(INTAKE.x + 1.55, 0, INTAKE.z + 0.9); scene.add(sealTable);
  sealTable.rotation.y = -0.5;
  { box(1.7, 0.07, 1.1, M.desk, 0, 0.86, 0, sealTable); box(0.07, 0.86, 0.95, M.leg, -0.75, 0, 0, sealTable); box(0.07, 0.86, 0.95, M.leg, 0.75, 0, 0, sealTable); }
  const envFront = tex(512, 340, (g, w, h) => { g.fillStyle = '#f0e3cb'; g.fillRect(0, 0, w, h); g.fillStyle = '#9b6a2c'; g.font = `600 30px ${FM}`; g.fillText('SEALED · SHA-256', 30, 230); g.fillStyle = '#b07f45'; g.font = `500 26px ${FM}`; g.fillText('commitment pending…', 30, 278); });
  const env = new THREE.Group(); scene.add(env);
  {
    box(1.0, 0.04, 0.66, [M.manila, M.manila, texMat(envFront), M.manila, M.manila, M.manila], 0, 0, 0, env);
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0, 0, 0.4], 3)); fg.computeVertexNormals();
    env.userData.hinge = new THREE.Group(); env.userData.hinge.position.set(0, 0.042, -0.33); env.add(env.userData.hinge);
    mesh(fg, std(C.manilaDark, { extra: { side: THREE.DoubleSide } }), env.userData.hinge);
    env.userData.wax = mesh(new THREE.CylinderGeometry(0.13, 0.14, 0.05, 24), M.seal, env.userData.hinge, [0, 0.025, 0.37]);
  }
  let envHashDrawn = false;
  function drawEnvelopeHash() { // once the page has computed the commitment, print it on the envelope
    if (envHashDrawn || typeof commitment === 'undefined' || !commitment) return;
    envHashDrawn = true; const g = envFront.userData.g;
    g.fillStyle = '#f0e3cb'; g.fillRect(0, 250, 512, 60); g.fillStyle = '#7a4d16'; g.font = `600 27px ${FM}`; g.fillText(commitment.slice(0, 22) + '…', 30, 278); envFront.needsUpdate = true;
  }
  const stamp = new THREE.Group(); scene.add(stamp);
  { mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.12, 24), M.seal, stamp, [0, 0.06, 0]); mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.36, 12), M.wood, stamp, [0, 0.3, 0]); mesh(new THREE.SphereGeometry(0.13, 16, 12), M.wood, stamp, [0, 0.52, 0]); }
  const flyNum = card(1.0, 0.39, numTex('0.906', '#d9480f')); flyNum.renderOrder = 5;
  // ingest: a scan bar over the page, and two tags that pop out of it (the PDF hash, the cited repository)
  const scanBar = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.06), new THREE.MeshBasicMaterial({ color: C.indigo, transparent: true, opacity: 0.75, depthWrite: false }));
  easel.userData.page.parent.add(scanBar); scanBar.position.z = 0.02;
  const tagTex = (k, v, color) => tex(640, 150, (g, w, h) => { g.fillStyle = '#ffffff'; roundRect(g, 4, 4, w - 8, h - 8, 26); g.fill(); g.strokeStyle = '#d6dbe7'; g.lineWidth = 4; g.stroke();
    g.fillStyle = color; roundRect(g, 4, 4, 22, h - 8, 10); g.fill();
    g.fillStyle = '#586078'; g.font = `600 30px ${FM}`; g.fillText(k, 50, 60); g.fillStyle = '#151a2d'; g.font = `600 34px ${FM}`; g.fillText(v, 50, 108); });
  const tagHash = card(1.6, 0.375, tagTex('PDF SHA-256', 'b58acd66dbd18897…', '#3a4fd8'));
  const tagRepo = card(1.6, 0.375, tagTex('REPOSITORY', 'angus924/rocket', '#7655d6'));
  scene.updateMatrixWorld(true);
  const PAGE_CELL = easel.userData.page.localToWorld(CELL.clone());
  const PAGE_RIGHT = easel.userData.page.localToWorld(V(2.15, 0.95, 0.25)), PAGE_RIGHT2 = easel.userData.page.localToWorld(V(2.2, 0.42, 0.3));
  const ENV_DESK = sealTable.localToWorld(V(0.15, 0.92, 0.05));
  const STAMP_UP = ENV_DESK.clone().add(V(0.05, 1.0, 0.18)), STAMP_DOWN = ENV_DESK.clone().add(V(0.05, 0.08, 0.18)), STAMP_REST = sealTable.localToWorld(V(-0.55, 0.9, -0.25));
  const ENV_HOVER = V(19, 9.5, 14.5), ENV_LIFT = ENV_DESK.clone().add(V(0, 2.1, 0));
  const ENV_VER = (() => { const v = V(0, 0, 0); pans[1].pan.updateWorldMatrix(true, false); pans[1].pan.getWorldPosition(v); return v.add(V(0, 0.05, 0)); })();
  const PAN0_PT = (() => { const v = V(0, 0, 0); pans[0].pan.getWorldPosition(v); return v.add(V(0, 0.25, 0)); })();
  const REPO_DOOR = V(12.4, 1.4, 20.6);

  // ── policy gate on the walkway between Planning and the Lab
  const GATE = V(21.5, 0, 14);
  const gateLight = new THREE.MeshStandardMaterial({ color: 0x1ea672, emissive: 0x1ea672, emissiveIntensity: 1.0, roughness: 0.4 });
  const scanM = new THREE.MeshBasicMaterial({ color: C.indigo, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
  let scanPlane;
  {
    for (const s of [-1, 1]) { box(0.34, 2.9, 0.34, M.dark, GATE.x + s * 1.4, 0, GATE.z); box(0.5, 0.12, 0.5, M.slate, GATE.x + s * 1.4, 0, GATE.z); }
    box(3.2, 0.34, 0.4, M.dark, GATE.x, 2.9, GATE.z);
    mesh(new THREE.SphereGeometry(0.18, 18, 12), gateLight, scene, [GATE.x, 3.48, GATE.z]);
    scanPlane = mesh(new THREE.PlaneGeometry(2.45, 0.1), scanM, scene, [GATE.x, 1.5, GATE.z], [0, 0, 0], false);
  }
  const GATE_MID = V(GATE.x, 1.3, GATE.z), LAB_IN = V(21.0, 1.3, 21.0);
  // ── prep container south of the lab, with the wheels and the dataset
  const PREP = V(21.5, 0, 31);
  const crates = [];
  {
    const lab = tex(1024, 400, (g, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.fillStyle = '#151a2d'; g.font = `600 64px ${FM}`; g.fillText('PREP', 40, 110);
      g.fillStyle = '#586078'; g.font = `500 36px ${FM}`; g.fillText('approved sites only · short-lived', 40, 190); g.fillText('hash-verified inputs only', 40, 250); });
    const pm = std(0xd7dcea);
    box(3.4, 2.0, 2.2, [pm, pm, M.cap, pm, texMat(lab), pm], PREP.x, 0, PREP.z + 1.4);
    box(2.8, 0.12, 1.4, M.slate, PREP.x + 3.1, 0, PREP.z + 1.2); // a loading pallet, on the side the cameras see
    const names = ['numpy', 'scipy', 'sklearn', 'joblib', 'threadpool', 'numba', 'llvmlite', 'ECG200'];
    names.forEach((n, i) => {
      const data = n === 'ECG200';
      const t = tex(256, 128, (g, w, h) => { g.fillStyle = data ? '#fdeae0' : '#e7eafd'; g.fillRect(0, 0, w, h); g.fillStyle = data ? '#d9480f' : '#3a4fd8'; g.font = `600 30px ${FM}`; g.textAlign = 'center'; g.fillText(n, w / 2, 62); g.font = `500 22px ${FM}`; g.fillText('sha256 ✓', w / 2, 100); });
      const m = box(0.6, 0.4, 0.48, [M.manila, M.manila, M.manila, M.manila, texMat(t), M.manila], 0, 0, 0);
      m.userData.home = V(PREP.x + 3.1 - 0.99 + (i % 4) * 0.66, 0.12 + (i > 3 ? 0.4 : 0), PREP.z + 1.2);
      m.userData.dest = V(18.6 + (i % 3) * 2.9 - 0.8, Math.floor(i / 3) * 0.4 + 0.08, 22.6 - 0.75);
      crates.push(m);
    });
  }

  // ── agents: DéjàML's seven roles as small robots in their role colours. Simple figures stand in until the model is parsed (and stay if it can't be).
  const AGENTS = [];
  const BOT_S = 0.34, BOT_H = 4.77 * BOT_S;   // RobotExpressive is ≈ 4.77 units tall
  const FIG = { leg: new THREE.CapsuleGeometry(0.075, 0.34, 3, 8), torso: new THREE.CapsuleGeometry(0.2, 0.3, 4, 12), arm: new THREE.CapsuleGeometry(0.055, 0.32, 3, 8),
    head: new THREE.SphereGeometry(0.17, 18, 14), hair: new THREE.SphereGeometry(0.178, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.55) };
  const PROXY = new THREE.CapsuleGeometry(0.36, 0.95, 2, 8), proxyM = new THREE.MeshBasicMaterial();   // invisible hit capsules keep tooltips cheap
  const ringGeo = new THREE.RingGeometry(0.42, 0.56, 36);
  const badgeTex = (txt, color) => tex(128, 152, (g, w) => {
    g.fillStyle = color; g.beginPath(); g.moveTo(w / 2 - 15, 108); g.lineTo(w / 2, 146); g.lineTo(w / 2 + 15, 108); g.fill();
    g.beginPath(); g.arc(w / 2, 62, 54, 0, Math.PI * 2); g.fill(); g.lineWidth = 8; g.strokeStyle = '#ffffff'; g.stroke();
    g.fillStyle = '#ffffff'; g.font = `700 ${txt.length > 1 ? 46 : 60}px ${FM}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, w / 2, 66);
  });
  function figure(key, name, room, pos, ry, info, letter) {
    const g = new THREE.Group(); g.position.copy(pos); g.rotation.y = ry; scene.add(g);
    const color = C[key], cm = std(color, { rough: 0.7 }), dm = std(new THREE.Color(color).multiplyScalar(0.82).getHex(), { rough: 0.7 });
    const simple = new THREE.Group(); g.add(simple);
    for (const s of [-1, 1]) mesh(FIG.leg, M.slate, simple, [s * 0.09, 0.25, 0]);
    const body = mesh(FIG.torso, cm, simple, [0, 0.74, 0]);
    const arms = [-1, 1].map((s) => { const a = new THREE.Group(); a.position.set(s * 0.25, 0.95, 0); simple.add(a); mesh(FIG.arm, dm, a, [0, -0.2, 0]); a.rotation.z = s * 0.12; return a; });
    const headG = new THREE.Group(); headG.position.set(0, 1.17, 0); simple.add(headG);
    mesh(FIG.head, M.skin, headG); mesh(FIG.hair, M.hair, headG, [0, 0.02, -0.015], [-0.25, 0, 0]);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.09; g.add(ring);
    const proxy = new THREE.Mesh(PROXY, proxyM); proxy.position.y = 0.82; proxy.visible = false; g.add(proxy);
    const badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTex(letter, CSS[key]), depthWrite: false, toneMapped: false }));
    badge.scale.set(0.34, 0.4, 1); badge.position.y = 1.75; badge.renderOrder = 3; g.add(badge);
    const a = { key, name, room, g, simple, body, headG, arms, ring, proxy, badge, info, phase: (AGENTS.length * 1.37) % 6.28,
      home: { pos: pos.clone(), ry }, ry, c: 0, legs: null, moving: false, walkD: 0, speed: 0, bot: null, cur: null, emote: null, emoteEnd: 0, pose: '', poseT: 0, beats: [], nextNod: 2 + AGENTS.length * 0.7 };
    proxy.userData.agent = a; AGENTS.push(a); return a;
  }
  const INFO = {
    P: { tools: ['paper_list_pages', 'paper_read_page', 'paper_search'], limits: '20 steps · 30 tool calls · 10 min', note: 'The one agent that reads the paper, and so sees its number.' },
    C: { tools: ['repo_acquire', 'repo_list', 'repo_read', 'repo_search', 'dependency_discover'], limits: '25 steps · 40 tool calls · 10 min', note: 'Blind. Can only download the repository the paper cites.' },
    R: { tools: ['board_read', 'repo_list', 'repo_read', 'repo_search', 'dependency_discover', 'dependency_check'], limits: '30 steps · 40 tool calls · 20 min', note: 'Blind. A plan that states an expected value is refused.' },
    L: { tools: ['lab_run_official', 'lab_run', 'lab_logs', 'lab_artifacts', 'lab_list', 'lab_read', 'lab_search', 'dependency_request', 'request_debugging', 'lab_destroy', '+3 more'], limits: '40 steps · 60 tool calls · 60 min', note: 'Blind. Works only inside its own sealed lab, with no host shell.' },
    D: { tools: ['board_read', 'lab_list', 'lab_read', 'lab_search', 'lab_logs'], limits: '12 steps · 20 tool calls · 8 min', note: 'Blind. Called in by an engineer when a run fails.' },
    V: { tools: ['board_read', 'repo_list', 'repo_read', 'artifact_read', 'logs_read'], limits: '20 steps · 30 tool calls · 10 min', note: 'Blind. Judges how faithfully the run followed the method.' },
    S: { tools: ['board_read'], limits: '8 steps · 10 tool calls · 5 min', note: 'Blind until the reveal. Can lower the computed verdict, never raise it.' },
  };
  const A_P = figure('p', 'Paper Analyst', 'read', V(8.75, 0, 7.0), -0.42, INFO.P, 'P');
  const A_C = figure('c', 'Repository Analyst', 'repo', V(8.75, 0, 20.85), -0.5, INFO.C, 'C');
  const A_R = figure('r', 'Reproduction Planner', 'plan', V(22.55, 0, 5.55), 0.45, INFO.R, 'R');
  const A_L = [0, 1, 2].map((i) => figure('l', `Lab Engineer ${i + 1}`, 'lab', V(19.05 + i * 2.9, 0, 22.45), -0.3, INFO.L, 'L' + (i + 1)));
  const A_D = figure('d', 'Debugger', 'lab', V(24.7, 0, 18.7), -0.75, INFO.D, 'D');
  const A_V = figure('v', 'Independent Reviewer', 'ver', V(31.0, 0, 12.75), 1.0, INFO.V, 'V');
  const A_S = figure('s', 'Supervisor', 'ver', V(35.75, 0, 11.6), -0.25, INFO.S, 'S');

  // ── walks: every hand-off is carried along the walkways, timed by the chapter coordinate CL
  const route = (pts) => { const v = pts.map(([x, z]) => V(x, 0, z)), cum = [0];
    for (let i = 1; i < v.length; i++) cum.push(cum[i - 1] + v[i].distanceTo(v[i - 1])); return { v, cum, len: cum[cum.length - 1] }; };
  const along = (r, d, out) => { // the point at distance d along r; returns the heading there
    d = Math.max(0, Math.min(r.len, d)); let i = 1;
    while (i < r.v.length - 1 && r.cum[i] < d) i++;
    const a = r.v[i - 1], b = r.v[i]; out.lerpVectors(a, b, (d - r.cum[i - 1]) / Math.max(1e-6, r.cum[i] - r.cum[i - 1]));
    return Math.atan2(b.x - a.x, b.z - a.z);
  };
  const rev = (p) => p.slice().reverse();
  const leg = (a, b, pts, ry, skip) => ({ a, b, r: route(pts), ry, skip });
  const P_GO = [[8.75, 7.0], [11.2, 7.6], [14.5, 7.6], [14.5, 13.35], [20.45, 13.35], [20.45, 12.3]];
  const C_GO = [[8.75, 20.85], [11.2, 20.6], [14.5, 20.6], [14.5, 13.45], [22.45, 13.45], [22.45, 12.3]];
  const R_GO = [[22.55, 5.55], [23.6, 6.2], [23.6, 9.6], [21.5, 10.3], [21.5, 12.75]];
  const L1_GO = [[19.05, 22.45], [19.05, 20.4], [25.6, 20.4], [26.6, 21.4], [28.7, 21.4], [28.7, 17.8], [33.0, 17.8], [33.0, 16.0], [32.55, 13.95]];
  const V_GO = [[31.0, 12.75], [31.1, 14.3], [33.0, 15.2], [33.0, 17.8], [28.7, 17.8], [28.7, 28.7], [33.0, 28.7], [33.0, 27.0], [33.3, 26.2]];
  const OUT = (i) => [[19.05 + i * 2.9, 22.45], [19.05 + i * 2.9, 20.6], [18.85 + i * 2.9, 19.75]];
  const gateRed = () => gateState() !== 'pass';
  A_P.legs = [leg(4.15, 4.6, P_GO, Math.PI), leg(4.7, 5.12, rev(P_GO), A_P.home.ry)];
  A_C.legs = [leg(4.18, 4.62, C_GO, Math.PI), leg(4.72, 5.15, rev(C_GO), A_C.home.ry)];
  A_R.legs = [leg(4.74, 4.98, R_GO, 0), leg(5.3, 5.75, rev(R_GO), A_R.home.ry, gateRed)];
  A_L[0].legs = [leg(7.3, 7.82, L1_GO, Math.PI), leg(8.05, 8.55, rev(L1_GO), A_L[0].home.ry), leg(9.45, 9.75, OUT(0), 0.1)];
  A_L[1].legs = [leg(9.47, 9.77, OUT(1), 0)]; A_L[2].legs = [leg(9.49, 9.79, OUT(2), -0.15)];
  A_V.legs = [leg(9.3, 9.85, V_GO, Math.PI)];
  // one-time gestures: [from, to, clip] (played once when the agent's story time enters the window; held as a still frame with reduced motion)
  const LOG_AT = (i, k) => 6.72 + 0.11 * k + 0.05 * i;   // lab i prints log line k
  A_P.beats = [[3.88, 4.14, 'Wave']]; A_C.beats = [[3.9, 4.16, 'Wave']];
  A_R.beats = [[4.98, 5.2, 'Wave']];
  A_L.forEach((a, i) => { a.beats = [[6.6 + i * 0.03, 6.7, 'Wave'], [LOG_AT(i, 2), LOG_AT(i, 2) + 0.3, 'ThumbsUp']]; });
  A_D.beats = [[6.62, 6.75, 'Wave']];
  A_V.beats = [[7.88, 8.12, 'Wave'], [8.96, 9.3, 'ThumbsUp']]; A_S.beats = [[7.9, 8.14, 'Wave']];
  for (const a of AGENTS) a.beats = a.beats.map(([b0, b1, clip]) => ({ b0, b1, clip, fired: false }));
  const WORK_CH = { p: 4, c: 4, r: 5, l: 7, d: -1, v: 8, s: -1 };
  function place(a, c, out) { // where agent a stands at story time c; returns its facing and sets a.moving / a.walkD
    a.moving = false;
    let L = null;
    if (a.legs) for (const l of a.legs) { if (c > l.a && !(l.skip && l.skip())) L = l; else if (c <= l.a) break; }
    if (!L) { out.copy(a.home.pos); return a.home.ry; }
    if (c >= L.b) { out.copy(L.r.v[L.r.v.length - 1]); return L.ry; }
    a.moving = true; a.walkD = sstep(L.a, L.b, c) * L.r.len;
    return along(L.r, a.walkD, out);
  }
  const atLegEnd = (a, i) => a.legs[i].r.v[a.legs[i].r.v.length - 1];

  // ── documents carried between rooms (a card in the carrier's hands, then a short hop to where it goes) with a dashed trail on the walkway
  const docTex = (label, color) => tex(256, 320, (g, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.fillStyle = color; g.fillRect(0, 0, w, 60);
    g.fillStyle = '#ffffff'; g.font = `700 ${label.length > 6 ? 30 : 34}px ${FM}`; g.fillText(label, 16, 42); g.fillStyle = '#d6dbe7'; for (let i = 0; i < 7; i++) g.fillRect(18, 92 + i * 30, 200 - (i % 3) * 40, 10);
    g.strokeStyle = color; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8); });
  const tmpA = V(0, 0, 0), tmpB = V(0, 0, 0), tmpOff = V(0, 0, 0), tmpP = V(0, 0, 0);
  const lerpV = (a, b, k, out) => out.lerpVectors(a, b, k);
  const arc = (a, b, k, h, out) => { lerpV(a, b, k, out); out.y += Math.sin(Math.PI * k) * h; return out; };
  const DOCS = [
    { who: A_P, leg: 0, to: BOARD_PT, hop: [4.6, 4.72], t: docTex('CLAIM', '#3a5be0'), c: C.p },
    { who: A_C, leg: 0, to: BOARD_PT2, hop: [4.62, 4.74], t: docTex('CODE MAP', '#7655d6'), c: C.c },
    { who: A_R, leg: 0, gate: true, t: docTex('PLAN', '#c18a0b'), c: C.r },
    { who: A_L[0], leg: 0, to: PAN0_PT, hop: [7.82, 7.9], t: docTex('LOCKED', '#3a4fd8'), c: C.indigo },
    { who: A_V, leg: 0, to: STACK_PT, hop: [9.85, 9.93], t: docTex('REPORT', '#127a4a'), c: 0x127a4a },
  ];
  const TRAIL_STEP = 0.25;
  for (const dc of DOCS) {
    dc.m = card(0.5, 0.62, dc.t);
    const L = dc.who.legs[dc.leg], n = Math.max(2, Math.ceil(L.r.len / TRAIL_STEP)), pts = [];
    for (let i = 0; i <= n; i++) { along(L.r, (i / n) * L.r.len, tmpA); pts.push(V(tmpA.x, 0.07, tmpA.z)); }
    dc.n = n;
    dc.trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: dc.c, dashSize: 0.32, gapSize: 0.2, transparent: true, opacity: 0.9 }));
    dc.trail.computeLineDistances(); dc.trail.visible = false; scene.add(dc.trail);
  }
  const hands = (a, out) => { // in front of the robot's chest
    out.set(Math.sin(a.ry), 0, Math.cos(a.ry)).multiplyScalar(0.36).add(a.g.position); out.y = (a.bot ? 0.86 : 0.8); return out;
  };

  // ── DOM labels, like the campus app's room cards
  const LAB = [
    { id: 'intake', at: V(INTAKE.x - 0.6, 4.6, INTAKE.z - 0.4), badge: 'S', c: 'var(--seal)', name: 'Intake + Seal' },
    { id: 'read', at: V(8, 2.7, 7.5), badge: 'P', c: 'var(--r-p)', name: 'Reading Room' },
    { id: 'repo', at: V(8, 2.7, 20.5), badge: 'C', c: 'var(--r-c)', name: 'Repo Room' },
    { id: 'plan', at: V(21, 3.6, 7.5), badge: 'R', c: 'var(--r-r)', name: 'Planning Room' },
    { id: 'gate', at: V(GATE.x, 4.1, GATE.z), badge: '✓', c: 'var(--ink)', name: 'Policy Gate' },
    { id: 'prep', at: V(PREP.x, 2.8, PREP.z + 1.4), badge: '#', c: 'var(--muted)', name: 'Prep' },
    { id: 'lab', at: V(21.5, 2.9, 21), badge: 'L', c: 'var(--r-l)', name: 'Disposable Lab' },
    { id: 'ver', at: V(33.5, 3.3, 12.6), badge: 'V', c: 'var(--r-v)', name: 'Verification Desk' },
    { id: 'store', at: V(33, 2.9, 23.8), badge: 'S', c: 'var(--indigo)', name: 'Run Store' },
  ];
  const labelsEl = $('#labels');
  for (const l of LAB) {
    l.el = document.createElement('div'); l.el.className = 'rl'; l.el.style.setProperty('--c', l.c);
    l.el.innerHTML = `<i>${l.badge}</i><div><b>${l.name}</b><span></span></div><em hidden></em>`;
    l.span = l.el.querySelector('span'); l.em = l.el.querySelector('em'); labelsEl.append(l.el);
  }
  // what each room is doing at each chapter (0 hero … 12 build)
  function roomState(id, ch, revealed, c) {
    switch (id) {
      case 'intake': return ch < 2 ? ['waiting for a paper', 0] : ch === 2 ? ['hashing the PDF', 1] : ch === 3 ? ['sealing the value', 1] : [revealed ? 'seal opened' : 'number sealed', 0];
      case 'read': return ch < 4 ? ['Paper Analyst · not started', 0] : ch === 4 ? ['Paper Analyst · reading p.25', 1] : ['Paper Analyst · done', 0];
      case 'repo': return ch < 4 ? ['Repository Analyst · not started', 0] : ch === 4 ? ['Repository Analyst · mapping code', 1] : ['Repository Analyst · done', 0];
      case 'plan': return ch < 5 ? ['Planner · waiting', 0] : ch === 5 ? ['Planner · writing the plan', 1] : ['Planner · done', 0];
      case 'gate': { if (ch < 5) return ['idle', 0]; const o = gateState(), t = o === 'block' ? 'blocked' : o === 'refuse' ? 'plan refused' : ch === 5 ? 'checking the plan' : 'passed'; return [t, ch === 5 ? 1 : 0]; }
      case 'prep': return ch < 6 ? ['idle', 0] : ch === 6 ? ['checking fingerprints', 1] : ['inputs delivered', 0];
      case 'lab': return ch < 7 ? ['up to 3 engineers · waiting', 0] : ch === 7 ? ['running · no internet', 1] : ch < 10 ? ['finished · no errors', 0] : ['labs destroyed ✓', 0];
      case 'ver': return ch < 8 ? ['Reviewer · waiting', 0] : ch === 8 ? ['reviewing blind', 1] : ch === 9 && c < 9.0 ? ['comparing in code', 1] : ['verdict: partially reproduced', ch === 9 ? 1 : 0];
      case 'store': return ch < 10 ? ['keeps every record', 0] : ch === 10 ? ['filing the report', 1] : ['report filed', 0];
    }
    return ['', 0];
  }
  const BLIND_ROOMS = new Set(['repo', 'plan', 'lab', 'ver']);

  // ── agent tooltip (raycast against the invisible hit capsules)
  const tip = $('#tip'), ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), ptr = { x: 0, y: 0, over: false, moved: false };
  addEventListener('pointermove', (e) => { ptr.x = e.clientX; ptr.y = e.clientY; ptr.over = e.target === canvas && e.pointerType === 'mouse'; ptr.moved = true; }, { passive: true });
  const hits = AGENTS.map((a) => a.proxy), hitList = [];
  let hovered = null;
  function showTip(a) {
    if (!a) { tip.hidden = true; hovered = null; canvas.style.cursor = ''; return; }
    if (hovered !== a) {
      const css = `var(--r-${a.key})`;
      tip.innerHTML = `<p class="who" style="--c:${css}"><i>${a.key.toUpperCase()}</i>${a.name}</p>${a.info.note}<div class="tools" style="--c:${css}">${a.info.tools.map((t) => `<code>${t}</code>`).join('')}</div><small>budget: ${a.info.limits}</small>`;
      hovered = a;
    }
    tip.hidden = false; canvas.style.cursor = 'help';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.transform = `translate(${Math.min(innerWidth - w - 12, ptr.x + 16)}px, ${Math.max(12, Math.min(innerHeight - h - 12, ptr.y - h / 2))}px)`;
  }

  // ── the robots: RobotExpressive, cloned per agent, Main tinted with the role colour, Grey lightened to a clean trim
  const CLIPS = ['Idle', 'Walking', 'Wave', 'Yes', 'No', 'ThumbsUp'];
  const PEAK = { Wave: 0.62, Yes: 0.5, No: 0.6, ThumbsUp: 0.5 };   // the frame held for a gesture with reduced motion
  function loadRobots() {
    if (typeof ROBOT_GLB_B64 === 'undefined') return;
    let buf;
    try { const s = atob(ROBOT_GLB_B64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); buf = u.buffer; } catch (err) { console.warn('robot model unreadable, keeping simple figures:', err); return; }
    new GLTFLoader().parse(buf, '', (gltf) => {
      try { makeRobots(gltf); } catch (err) { console.warn('robots unavailable, keeping simple figures:', err); }
    }, (err) => console.warn('robot model failed to parse, keeping simple figures:', err));
  }
  function makeRobots(gltf) {
    const clips = {}; gltf.animations.forEach((cl) => { clips[cl.name] = cl; });
    if (CLIPS.some((n) => !clips[n])) throw new Error('robot clips missing');
    const trim = new THREE.MeshStandardMaterial({ color: 0xe9ebf2, roughness: 0.5, metalness: 0.05 }), mains = {};
    const built = AGENTS.map((a) => {
      const bot = SkeletonUtils.clone(gltf.scene); bot.scale.setScalar(BOT_S);
      const main = mains[a.key] || (mains[a.key] = new THREE.MeshStandardMaterial({ color: C[a.key], roughness: 0.5, metalness: 0.05 }));
      const faces = [], swap = (m) => (m.name === 'Main' ? main : m.name === 'Grey' ? trim : m);
      bot.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = false; if (o.isSkinnedMesh) o.frustumCulled = false;
        o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
        if (o.morphTargetDictionary) faces.push(o);
      });
      const mixer = new THREE.AnimationMixer(bot), acts = {};
      for (const n of CLIPS) acts[n] = mixer.clipAction(clips[n]);
      return { a, bot, mixer, acts, faces };
    });
    built.forEach(({ a, bot, mixer, acts, faces }, i) => { // swap the figures out only once every robot is ready
      a.simple.visible = false; a.g.add(bot); a.bot = bot; a.mixer = mixer; a.acts = acts; a.faces = faces;
      a.morph = faces.length ? faces[0].morphTargetDictionary : null; a.idleT = (i * 0.73) % clips.Idle.duration;
      a.badge.position.y = BOT_H + 0.34; a.proxy.position.y = 0.86;
    });
  }
  function play(a, name, fade = 0.3) { // crossfade into a looping state
    if (a.cur === name) return;
    if (a.pose) { a.mixer.stopAllAction(); a.pose = ''; a.cur = null; }
    const next = a.acts[name], prev = a.cur ? a.acts[a.cur] : null;
    next.reset(); next.setLoop(THREE.LoopRepeat, Infinity); next.clampWhenFinished = false;
    if (name === 'Idle') next.time = a.idleT;
    next.setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(prev ? fade : 0).play();
    if (prev && prev !== next) prev.fadeOut(fade);
    a.cur = name; a.emote = null;
  }
  function gesture(a, name) { // a one-shot, then back to the state
    if (a.pose) { a.mixer.stopAllAction(); a.pose = ''; a.cur = null; }
    const next = a.acts[name], prev = a.cur ? a.acts[a.cur] : null;
    next.reset(); next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true;
    next.setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.22).play();
    if (prev && prev !== next) prev.fadeOut(0.22);
    a.cur = name; a.emote = name; a.emoteEnd = T + next.getClip().duration - 0.25;
  }
  function hold(a, name, time) { // reduced motion: one still frame of a clip
    const q = Math.round(time * 100);
    if (a.pose === name && a.poseT === q) return;
    a.pose = name; a.poseT = q; a.cur = null; a.emote = null;
    a.mixer.stopAllAction(); const act = a.acts[name]; act.reset(); act.setLoop(THREE.LoopRepeat, Infinity); act.play(); act.time = time; a.mixer.update(0);
  }
  // the Supervisor answers the visitor's ladder: it can lower a verdict, never raise it
  let ladderAsk = null, ladderAt = -9;
  $$('#ladder [data-p]').forEach((b) => b.addEventListener('click', () => { ladderAsk = b.dataset.p; }));

  // ── camera stations (one per chapter). off = view offset (fraction of the screen): desktop shifts the subject right of the card,
  //    phones (offM) lift it into the band above the card. hold = how long the camera lingers before leaving for the next chapter.
  const ST = {
    hero:     { pos: V(2, 47, 75), look: V(18.5, 0, 15), off: [-0.17, 0.03], offM: [0, -0.24], fov: 34, m: 1.0 },
    problem:  { pos: V(0.6, 3.9, 21.8), look: V(-6.2, 2.1, 13.4), off: [-0.2, 0], offM: [0, 0.27], fov: 34, m: 1.5 },
    ingest:   { pos: V(-1.5, 3.4, 23.2), look: V(-6.6, 2.3, 13.6), off: [-0.2, 0], offM: [0, 0.27], fov: 34, m: 1.5 },
    seal:     { pos: V(2.9, 3.7, 20.9), look: V(-4.6, 1.75, 14.3), off: [-0.2, 0], offM: [0, 0.27], fov: 34, m: 1.45, hold: [0.32, 0.92] },
    analyse:  { pos: V(-3.5, 11.5, 30.5), look: V(9.2, 0.9, 15.4), off: [-0.2, 0], offM: [0, 0.27], fov: 34, m: 1.75 },
    plan:     { pos: V(32, 13.5, 27), look: V(21.4, 0.9, 10.2), off: [-0.2, 0], offM: [0, 0.27], fov: 34, m: 1.55 },
    prepare:  { pos: V(34, 9.5, 43), look: V(22.8, 0.8, 30.4), off: [-0.2, 0], offM: [0, 0.27], fov: 34, m: 1.55 },
    lab:      { pos: V(22.6, 10.2, 35.2), look: V(21.6, 0.75, 21.3), off: [-0.2, 0], offM: [0, 0.27], fov: 34, m: 1.5 },
    review:   { pos: V(43, 10.5, 25), look: V(33.4, 1.0, 12.8), off: [-0.2, 0], offM: [0, 0.27], fov: 34, m: 1.5 },
    reveal:   { pos: V(38.7, 5.0, 21.4), look: V(33.8, 1.45, 12.4), off: [-0.2, 0], offM: [0, 0.27], fov: 34, m: 1.5 },
    receipts: { pos: V(46, 12.5, 38), look: V(30.8, 0.7, 23), off: [-0.2, 0], offM: [0, 0.27], fov: 34, m: 1.5 },
    verdicts: { pos: V(8, 60, 46), look: V(16, 0, 14.5), off: [-0.18, 0], offM: [0, 0.24], fov: 34, m: 1.25 },
    build:    { pos: V(64, 35, 56), look: V(15, 0, 14), off: [-0.18, 0], offM: [0, 0.24], fov: 34, m: 1.25 },
  };
  { // debug: ?cam=x,y,z,lx,ly,lz,offx[,station] overrides one station (default hero) to tune framing
    const q = new URLSearchParams(location.search).get('cam');
    if (q) { const v = q.split(','), n = v.slice(0, 7).map(Number), k = v[7] || 'hero'; ST[k] = { ...ST[k], pos: V(n[0], n[1], n[2]), look: V(n[3], n[4], n[5]), off: [n[6], ST[k].off[1]] }; }
  }
  const FOCUS = { problem: 'intake', ingest: 'intake', seal: 'intake', analyse: 'read', plan: 'plan', prepare: 'prep', lab: 'lab', review: 'ver', reveal: 'ver', receipts: 'store' };
  const cam = { pos: ST.hero.pos.clone(), look: ST.hero.look.clone(), off: [0, 0], fov: 34 }, tgt = { pos: V(0, 0, 0), look: V(0, 0, 0), off: [0, 0], fov: 34 };
  let CH = 0, CL = 0;   // current chapter (int), linear chapter coordinate
  const MOB = new Map();
  function stationFor(s, mobile) {
    if (!mobile) return s;
    let m = MOB.get(s);
    if (!m) { // phones: step back along the view line, widen the lens, lift the subject above the card
      const d = s.pos.clone().sub(s.look).multiplyScalar(s.m ?? 1.5);
      m = { pos: s.look.clone().add(d), look: s.look, off: s.offM, fov: s.fov + 14, hold: s.hold }; MOB.set(s, m);
    }
    return m;
  }
  const pts = secs.map(() => ({ st: null, y: 0 }));
  function computeTarget() {
    const vh = innerHeight, mobile = innerWidth < 761, y = scrollY;
    secs.forEach((s, j) => { const r = s.getBoundingClientRect(); pts[j].st = stationFor(ST[s.dataset.station], mobile); pts[j].y = r.top + y + Math.min(r.height, vh * 1.4) / 2 - vh / 2; });
    let i = 0, k = 0, f = 0;
    if (y > pts[0].y) for (i = 0; i < pts.length - 1; i++) {
      if (y <= pts[i + 1].y || i === pts.length - 2) {
        f = Math.min(1, Math.max(0, (y - pts[i].y) / Math.max(1, pts[i + 1].y - pts[i].y)));
        const h = pts[i].st.hold ?? [0.12, 0.88]; k = sstep(h[0], h[1], f); break;
      }
    }
    const a = pts[i].st, b = pts[Math.min(i + 1, pts.length - 1)].st;
    tgt.pos.lerpVectors(a.pos, b.pos, k); tgt.pos.y += a.pos.distanceTo(b.pos) * 0.14 * Math.sin(Math.PI * k);
    tgt.look.lerpVectors(a.look, b.look, k);
    tgt.off[0] = a.off[0] + (b.off[0] - a.off[0]) * k; tgt.off[1] = a.off[1] + (b.off[1] - a.off[1]) * k; tgt.fov = a.fov + (b.fov - a.fov) * k;
    CL = i + f; CH = Math.round(CL);
    const navMap = { seal: '#seal', analyse: '#analyse', plan: '#analyse', prepare: '#lab', lab: '#lab', review: '#lab', reveal: '#reveal' };
    const cur = secs[Math.min(secs.length - 1, Math.max(0, CH))].id;
    $$('.mast nav a').forEach((l) => l.setAttribute('aria-current', String(l.getAttribute('href') === navMap[cur])));
  }

  // ── sizing
  const MAX_DPR = Math.min(devicePixelRatio || 1, SMALL ? 1.5 : 1.75);
  let DPR = MAX_DPR;
  function resize() { renderer.setPixelRatio(DPR); renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; }
  addEventListener('resize', resize); resize();
  const perf = { acc: 0, n: 0, cool: 2 };
  function adapt(dt) {
    perf.cool -= dt; perf.acc += dt; perf.n++; if (perf.acc < 1.2) return;
    const avg = perf.acc / perf.n; perf.acc = 0; perf.n = 0; if (perf.cool > 0) return;
    let next = DPR; if (avg > 1 / 40 && DPR > 0.75) next = Math.max(0.75, DPR - 0.25); else if (avg < 1 / 58 && DPR < MAX_DPR) next = Math.min(MAX_DPR, DPR + 0.25);
    if (next !== DPR) { DPR = next; resize(); perf.cool = 2.5; }
  }

  // ── the story, driven by the chapter coordinate CL (chapter i sits at CL = i)
  const LOG = ['DEJAML_RESULT={"accuracyMean":…}', 'DEJAML_ARTIFACT=…/artifacts/result.json', 'exit 0'];
  let logKey = -1;
  const logN = [0, 0, 0];
  function drawLogs(c, t) {
    const running = c > 6.55, blink = RM.matches ? 1 : Math.floor(t * 2.4) % 2;
    let key = (running ? 1 : 0) + blink * 2;
    for (let i = 0; i < 3; i++) { let n = 0; for (let k = 0; k < LOG.length; k++) if (c >= LOG_AT(i, k)) n = k + 1; logN[i] = n; key += n * 4 ** (i + 1); }
    if (key === logKey) return; logKey = key;
    podScreens.forEach((tx, i) => {
      const g = tx.userData.g, w = tx.userData.c.width, h = tx.userData.c.height, n = logN[i];
      g.fillStyle = '#11141d'; g.fillRect(0, 50, w, h - 50); g.font = `400 17px ${FM}`; g.fillStyle = '#d7dde8';
      g.fillText('$ python rocket_ecg200_runner.py', 18, 80); g.fillText('  --runs 10 --kernels 10000', 18, 108);
      for (let k = 0; k < n; k++) { g.fillStyle = LOG[k] === 'exit 0' ? '#4cc38a' : '#9aa3ae'; g.font = LOG[k] === 'exit 0' ? `700 19px ${FM}` : `400 17px ${FM}`; g.fillText(LOG[k], 18, 150 + k * 32); }
      if (running && n < LOG.length && blink) { g.fillStyle = '#8fa2ff'; g.fillRect(20, 134 + n * 32, 11, 20); }
      tx.needsUpdate = true;
    });
  }
  const showAt = (o, on) => { o.visible = on; };
  function story(t) {
    const c = CL, still = RM.matches;
    const revealed = c >= 8.75;
    if (root.classList.contains('revealed') !== revealed) root.classList.toggle('revealed', revealed);
    if (revealed) revealSeal();
    renderChip(CH);
    drawEnvelopeHash();

    // ingest (§02): a scan bar sweeps the page; the hash and the repository pop out beside it
    const kScan = c > 1.45 && c < 2.6 ? 1 : 0;
    scanBar.visible = !!kScan; if (kScan) scanBar.position.y = 1.5 - (((still ? 0.45 : t * 0.45) + (c - 1.45)) % 1) * 3.0;
    const kTag = sstep(1.62, 1.95, c);
    showAt(tagHash, kTag > 0.01 && c < 3.35);
    if (tagHash.visible) { tagHash.position.copy(PAGE_RIGHT); tagHash.position.y += 0.25 * (1 - kTag); tagHash.scale.setScalar(Math.max(0.01, kTag)); tagHash.quaternion.copy(camera.quaternion); }
    // the repository tag travels to the Repo Room when the analysts start (§03 → §04)
    const kRepo = sstep(3.45, 4.1, c);
    showAt(tagRepo, kTag > 0.01 && c < 4.1);
    if (tagRepo.visible) { arc(PAGE_RIGHT2, REPO_DOOR, kRepo, 4.5, tagRepo.position); tagRepo.scale.setScalar(Math.max(0.01, kTag * (1 - 0.4 * kRepo))); tagRepo.quaternion.copy(camera.quaternion); }

    // seal (§03): the number lifts off the page into the envelope; the flap closes; the stamp presses the wax; the envelope rises out of reach
    const kLift = sstep(2.42, 2.78, c), kClose = sstep(2.76, 2.88, c), kPress = sstep(2.86, 2.99, c), kWax = sstep(2.93, 2.96, c), kUp = sstep(2.99, 3.12, c), kRise1 = sstep(3.02, 3.3, c), kRise = sstep(3.3, 3.95, c);
    const kDown = sstep(8.3, 8.75, c), kOpen = sstep(8.75, 8.95, c), kOut = sstep(8.85, 9.12, c);
    if (c < 2.8) {
      showAt(flyNum, c > 2.3);
      arc(PAGE_CELL, tmpA.copy(ENV_DESK).add(tmpOff.set(0, 0.12, 0)), kLift, 0.8, flyNum.position);
      flyNum.scale.setScalar(1 - 0.55 * kLift);
    } else if (c < 8.85) showAt(flyNum, false);
    else { showAt(flyNum, true); arc(ENV_VER, tmpA.copy(ENV_VER).add(tmpOff.set(-0.1, 1.2, 0)), kOut, 0.2, flyNum.position); flyNum.scale.setScalar(0.45 + 0.75 * kOut); }
    if (flyNum.visible) flyNum.quaternion.copy(camera.quaternion);
    if (kDown > 0) { arc(ENV_HOVER, ENV_VER, kDown, 0.6, env.position); env.scale.setScalar(1.9 - 1.0 * kDown); }
    else if (kRise <= 0) { env.position.copy(ENV_DESK); env.position.y += 2.1 * kRise1; env.scale.setScalar(1 + 0.35 * kRise1); }
    else { lerpV(ENV_LIFT, ENV_HOVER, kRise, env.position); env.position.y += Math.sin(Math.PI * kRise) * 1.2; env.scale.setScalar(1.35 + 0.55 * kRise); }
    const hovering = kRise > 0.98 && kDown === 0;
    env.rotation.set(0, sealTable.rotation.y * (1 - kRise) + kRise1 * 0.6 * (1 - kRise) + (still ? 0 : kRise * (1 - kDown) * t * 0.35), 0);
    if (hovering && !still) env.position.y += Math.sin(t * 1.2) * 0.18;
    env.userData.hinge.rotation.x = c < 8.75 ? -2.25 * (1 - kClose) : -2.25 * kOpen;
    env.userData.wax.scale.setScalar(c < 8.75 ? Math.max(0.001, kWax) : Math.max(0.001, 1 - kOpen));
    // the stamp: rests on the table, lifts over the envelope, presses down, lifts away
    if (c < 2.7) stamp.position.copy(STAMP_REST);
    else if (c < 2.86) lerpV(STAMP_REST, STAMP_UP, sstep(2.7, 2.86, c), stamp.position);
    else if (c < 2.99) lerpV(STAMP_UP, STAMP_DOWN, kPress, stamp.position);
    else lerpV(STAMP_DOWN, STAMP_REST, kUp, stamp.position);
    if (c >= 2.99 && kUp < 1) stamp.position.y += Math.sin(Math.PI * kUp) * 0.8;

    // the observation box lands on the scale once the run is locked; the beam settles nearly level at the reveal (0.002 apart)
    const kObs = sstep(7.86, 8.0, c);
    obsBox.scale.set(0.52 * Math.max(0.002, kObs), 0.38 * Math.max(0.002, kObs), 0.52 * Math.max(0.002, kObs));
    showAt(obsNum, kObs > 0.5); if (obsNum.visible) obsNum.quaternion.copy(camera.quaternion);
    const tilt = c < 8.75 ? 0.2 * kObs : 0.2 * (1 - sstep(8.95, 9.3, c)) + 0.01;
    beam.rotation.z = tilt; pans[0].hang.rotation.z = -tilt; pans[1].hang.rotation.z = -tilt;

    // gate: scanning while the plan is checked; red if the visitor's plan is blocked or refused
    const red = gateRed() && c > 4.5 && c < 6.2;
    showAt(scanPlane, c > 4.9 && c < (red ? 6.2 : 5.3));
    scanPlane.position.y = 0.35 + (Math.sin((still ? 1 : t) * 2.6) * 0.5 + 0.5) * 2.3;
    gateLight.color.setHex(red ? 0xd63b2f : 0x1ea672); gateLight.emissive.setHex(red ? 0xd63b2f : 0x1ea672);
    scanM.color.setHex(red ? 0xd63b2f : C.indigo);
    // documents in hand, then a hop to where they go
    for (const dc of DOCS) {
      const a = dc.who, L = a.legs[dc.leg], ac = a.c;
      let on = false;
      if (ac > L.a && ac < L.b) { on = true; hands(a, dc.m.position); }
      else if (dc.gate && ac >= L.b) {
        // the plan goes into the gate, is scanned, then flies on into the lab (or stays, red, if the visitor blocks it)
        hands(a, tmpA);
        if (c < 5.08) { on = true; lerpV(tmpA, GATE_MID, sstep(4.98, 5.08, c), dc.m.position); }
        else if (red) { on = true; dc.m.position.copy(GATE_MID); }
        else if (c < 5.45) { on = true; if (c < 5.2) dc.m.position.copy(GATE_MID); else arc(GATE_MID, LAB_IN, sstep(5.2, 5.45, c), 1.6, dc.m.position); }
      } else if (dc.hop && ac >= L.b && c < dc.hop[1]) { on = true; hands(a, tmpA); arc(tmpA, dc.to, sstep(dc.hop[0], dc.hop[1], c), 0.9, dc.m.position); }
      showAt(dc.m, on);
      if (on) { dc.m.quaternion.copy(camera.quaternion); dc.m.material.color.setHex(dc.gate && red && c >= 5.0 ? 0xffb4ac : 0xffffff); }
      const k = (ac - L.a) / (L.b - L.a);
      dc.trail.visible = k > 0 && k < 1.25;
      if (dc.trail.visible) { dc.trail.geometry.setDrawRange(0, Math.max(2, Math.round(Math.min(1, sstep(0, 1, k)) * dc.n) + 1)); dc.trail.material.opacity = 0.9 * (1 - sstep(1, 1.25, k)); }
    }
    // prep: crates roll into the lab (§06 → §07)
    const kCr = sstep(6.1, 6.6, c);
    for (let i = 0; i < crates.length; i++) { const m = crates[i], k = sstep(i * 0.05, 0.65 + i * 0.05, kCr); arc(m.userData.home, m.userData.dest, k, 2.4, m.position); m.visible = c < 9.8; }
    // lab logs print during execution; pods are destroyed at cleanup, after their engineers step out
    drawLogs(c, t);
    const kDie = sstep(9.8, 10.3, c);
    for (let i = 0; i < pods.length; i++) { const p = pods[i], s = Math.max(0.001, 1 - sstep(i * 0.15, 0.7 + i * 0.15, kDie)); p.scale.set(s, s, s); p.visible = s > 0.002; }
    // the report stack grows in the Run Store once the Reviewer has filed it
    for (let i = 0; i < reports.length; i++) reports[i].visible = c > 9.88 + i * 0.012;
  }

  // ── the agents each frame: walk the scripted legs, then idle, work, or gesture
  const wrapA = (x) => Math.atan2(Math.sin(x), Math.cos(x));
  let agentsInit = false;
  function updateAgents(dt, c, t) {
    const still = RM.matches;
    const kC = still || !agentsInit ? 1 : 1 - Math.exp(-dt * 4), kP = still || !agentsInit ? 1 : 1 - Math.exp(-dt * 14), kR = still || !agentsInit ? 1 : 1 - Math.exp(-dt * 9);
    agentsInit = true;
    for (const a of AGENTS) {
      a.c += (c - a.c) * kC; if (Math.abs(c - a.c) < 1e-4) a.c = c;
      const ry = place(a, a.c, tmpP);
      tmpB.copy(a.g.position); a.g.position.lerp(tmpP, kP);
      a.speed = dt > 0 ? a.g.position.distanceTo(tmpB) / dt : 0;
      a.ry += wrapA(ry - a.ry) * kR; a.g.rotation.y = a.ry;
      const working = CH === WORK_CH[a.key] && !a.moving;
      a.ring.material.opacity += ((working || a.moving ? 0.85 : 0) - a.ring.material.opacity) * (still ? 1 : 0.15);
      if (still) a.badge.position.y = (a.bot ? BOT_H + 0.34 : 1.75);
      else a.badge.position.y = (a.bot ? BOT_H + 0.34 : 1.75) + Math.sin(t * 2 + a.phase) * 0.03;
      if (a.bot) animateBot(a, dt, c, t, working, still); else animateFigure(a, t, working, still);
    }
    ladderAsk = null;
  }
  function animateBot(a, dt, c, t, working, still) {
    // faces: the Reviewer's déjà vu (Surprised); the Supervisor frowns when asked to raise a verdict (Angry)
    if (a.morph) {
      const sur = a === A_V ? sstep(8.82, 8.95, c) * (1 - sstep(9.5, 9.8, c)) : 0;
      const ang = a === A_S && T - ladderAt < 1.8 && a.lastAsk === 'reproduced' ? 0.8 : 0;
      for (const f of a.faces) { f.morphTargetInfluences[a.morph.Surprised] = sur; f.morphTargetInfluences[a.morph.Angry] = ang; }
    }
    // which gesture belongs to this moment?
    let beat = null;
    for (let i = 0; i < a.beats.length; i++) {
      const bt = a.beats[i];
      if (a.c >= bt.b0 && a.c < bt.b1) { beat = bt.clip; if (!still && !bt.fired && Math.abs(a.c - c) < 0.2) { bt.fired = true; if (!a.moving) gesture(a, bt.clip); } }
      else if (a.c < bt.b0 - 0.1 || a.c > bt.b1 + 1.2) bt.fired = false;
    }
    if (a === A_S && ladderAsk) { a.lastAsk = ladderAsk; ladderAt = T; if (!still) gesture(a, ladderAsk === 'reproduced' ? 'No' : 'Yes'); }
    if (still) { // reduced motion: hold still frames; walking legs follow the scroll, not the clock
      const W = a.acts.Walking;
      if (a.moving) hold(a, 'Walking', ((a.walkD / 1.15) % 1) * W.getClip().duration);
      else if (a === A_S && T - ladderAt < 2.5) hold(a, a.lastAsk === 'reproduced' ? 'No' : 'Yes', 0.6);
      else if (beat && beat !== 'Wave') hold(a, beat, PEAK[beat]);
      else hold(a, 'Idle', 0);
      return;
    }
    if (a.moving && a.speed > 0.15) {
      play(a, 'Walking', 0.2);
      a.acts.Walking.setEffectiveTimeScale(Math.min(2.4, Math.max(0.8, a.speed / 1.3)));
    } else if (a.emote) {
      if (T >= a.emoteEnd) play(a, 'Idle', 0.35);
    } else {
      play(a, 'Idle', 0.3);
      // at work: a nod now and then; the Planner shakes its head at a blocked plan
      if (T > a.nextNod && !a.moving) {
        if (a === A_R && gateRed() && a.c > 4.98 && a.c < 6.2) { gesture(a, 'No'); a.nextNod = T + 2.6; }
        else if (working) { gesture(a, 'Yes'); a.nextNod = T + 3.2 + (a.phase % 1.5); }
        else a.nextNod = T + 1;
      }
    }
    a.mixer.update(dt);
  }
  function animateFigure(a, t, working, still) { // the fallback figures: breathe, and nod while working
    const tt = t + a.phase, on = working || a.moving;
    const bob = still ? 0 : Math.sin(tt * (on ? 5 : 1.3)) * (on ? 0.035 : 0.012);
    a.body.position.y = 0.74 + bob; a.headG.position.y = 1.17 + bob * 1.3;
    a.headG.rotation.y = still ? 0 : Math.sin(tt * 0.5) * (on ? 0.12 : 0.35);
    a.headG.rotation.x = still ? 0 : (working ? 0.18 + Math.sin(tt * 4) * 0.05 : 0);
    const swing = a.moving ? Math.sin(a.walkD * 5) * 0.6 : working ? -0.75 + (still ? 0 : Math.sin(tt * 9) * 0.08) : 0;
    a.arms[0].rotation.x = swing; a.arms[1].rotation.x = a.moving ? -swing : swing;
  }

  // ── labels each frame
  const pv = V(0, 0, 0);
  const mastEl = document.querySelector('.mast');
  function updateLabels() {
    const W = innerWidth, H = innerHeight, mobile = W < 761, focus = FOCUS[secs[CH]?.dataset.station];
    const revealed = root.classList.contains('revealed');
    const mastBottom = mastEl ? mastEl.getBoundingClientRect().bottom : 0;
    for (const l of LAB) {
      pv.copy(l.at).project(camera);
      const show = pv.z < 1 && Math.abs(pv.x) < 1.05 && Math.abs(pv.y) < 1.05 && (!mobile || l.id === focus) && CH > 0 && CH < 11;
      if (!show) { l.el.style.opacity = '0'; continue; }
      const [txt, on] = roomState(l.id, CH, revealed, CL);
      if (l.span.textContent !== txt) l.span.textContent = txt;
      const blind = CH >= 3 && !revealed && BLIND_ROOMS.has(l.id), reads = CH >= 3 && l.id === 'read';
      l.em.hidden = !(blind || reads); l.em.textContent = reads ? 'knows the number' : 'blind'; l.em.classList.toggle('reads', reads);
      l.el.classList.toggle('on', !!on);
      const d = camera.position.distanceTo(l.at), op = l.id === focus ? 1 : Math.max(0, Math.min(1, 1.6 - d / 40));
      l.el.style.opacity = String(op);
      // keep every card fully on screen and clear of the masthead (labels anchor at their bottom centre)
      const lw = l.el.offsetWidth, lh = l.el.offsetHeight;
      const lx = Math.min(W - lw / 2 - 8, Math.max(lw / 2 + 8, (pv.x + 1) / 2 * W));
      const ly = Math.min(H - 8, Math.max(mastBottom + lh + 6, (1 - pv.y) / 2 * H));
      l.el.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  // ── loop
  let last = performance.now(), T = 0;
  const drift = V(0, 0, 0);
  loadRobots();
  if (/[?&]debug\b/.test(location.search)) window.__campus = { renderer, scene, agents: AGENTS };   // for QA: draw calls, robot state
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; T += dt;
    computeTarget();
    const k = RM.matches ? 1 : 1 - Math.exp(-dt * 4.2);
    cam.pos.lerp(tgt.pos, k); cam.look.lerp(tgt.look, k);
    cam.off[0] += (tgt.off[0] - cam.off[0]) * k; cam.off[1] += (tgt.off[1] - cam.off[1]) * k; cam.fov += (tgt.fov - cam.fov) * k;
    camera.position.copy(cam.pos);
    if (!RM.matches) camera.position.add(drift.set(Math.sin(T * 0.12) * 0.5, Math.sin(T * 0.16) * 0.25, 0));
    camera.lookAt(cam.look); camera.fov = cam.fov;
    camera.setViewOffset(innerWidth, innerHeight, cam.off[0] * innerWidth, cam.off[1] * innerHeight, innerWidth, innerHeight);
    camera.updateProjectionMatrix();
    updateAgents(dt, CL, T);
    story(T);
    if (ptr.over && (ptr.moved || hovered)) {
      ndc.set(ptr.x / innerWidth * 2 - 1, -(ptr.y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
      hitList.length = 0; ray.intersectObjects(hits, false, hitList);
      const hit = hitList.find((h) => h.object.userData.agent.g.visible);
      showTip(hit ? hit.object.userData.agent : null); ptr.moved = false;
    } else if (!ptr.over && hovered) showTip(null);
    renderer.render(scene, camera);
    updateLabels();
    adapt(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
