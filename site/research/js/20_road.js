// The Research Road: one raised walkway across the model table, a stop for each chapter, an indigo line drawn up to "now" as you scroll,
// and a robot walking it. Past "now" the road is a dashed plan and the props are drawn as see-through models.
// Shares one module scope with 10_page.js (uses: $, $$, RM, sstep, root, secs, STOPS, NOW_I, stopIndexOf, setHere)
// and with build.mjs's ROBOT_GLB_B64 (RobotExpressive by Tomás Laulhé / Quaternius, CC0, from the three.js r169 examples).
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const fontsReady = Promise.race([
  Promise.all(['500 40px "Newsreader"', '600 20px "JetBrains Mono"', '600 20px "Schibsted Grotesk"'].map((f) => document.fonts.load(f))),
  new Promise((r) => setTimeout(r, 2500)),
]).catch(() => {});
fontsReady.then(start3D).catch((err) => { console.warn('3D road unavailable:', err); root.classList.add('no-gl'); fallbackScroll(); });

function currentStop() { // which stop the middle of the screen is in (-1 = hero, STOPS.length = the end)
  const mid = innerHeight * 0.5; let id = 'top';
  secs.forEach((s) => { if (s.getBoundingClientRect().top < mid) id = s.id; });
  return id === 'top' ? -1 : id === 'end' ? STOPS.length : stopIndexOf(id);
}
function fallbackScroll() { // no WebGL: the progress line still follows the scroll
  const tick = () => { setHere(currentStop()); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

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
  scene.fog = new THREE.Fog(BG, 160, 420);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 700);
  scene.add(new THREE.HemisphereLight(0xf7f8ff, 0xbcc2d3, 1.25));
  const SUN = new THREE.Vector3(36, 58, 32);
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.9); sun.castShadow = true; const SM = SMALL ? 1024 : 2048; sun.shadow.mapSize.set(SM, SM);
  Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 180 }); sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.025;
  const fill = new THREE.DirectionalLight(0xdfe6ff, 0.6); fill.position.set(-30, 22, -24);
  scene.add(sun, sun.target, fill, fill.target);

  // ── palette and helpers (the campus page's architectural-model look)
  const C = { ground: 0xdde1eb, base: 0xe9ebf3, side: 0xcbd1de, walk: 0xf9fafc, plan: 0xe1e4ee, wall: 0xfcfdff, cap: 0xd9dee9, ink: 0x151a2d, indigo: 0x3a4fd8,
    seal: 0xd9480f, manila: 0xf0e3cb, glass: 0x7fd6c9, dark: 0x2a2f42, slate: 0x3b4256, ok: 0x1f9d63, neg: 0xd64545, amber: 0xc99212,
    leaf1: 0x5aa77e, leaf2: 0x4a9670, leaf3: 0x78bd92, trunk: 0x9c7552,
    blind: 0x3a4fd8, sighted: 0xd9480f, rule: 0xc18a0b, decoy: 0xb5357a, p: 0x3a5be0, l: 0x0f9b8e, v: 0xd6336c };
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.86, metalness: 0, ...o.extra });
  const M = { base: std(C.base), side: std(C.side), walk: std(C.walk, { rough: 0.95 }), plan: std(C.plan, { rough: 0.95 }), wall: std(C.wall), cap: std(C.cap),
    ink: std(C.ink), indigo: std(C.indigo, { rough: 0.55 }), seal: std(C.seal, { rough: 0.5 }), manila: std(C.manila), white: std(0xffffff), dark: std(C.dark, { rough: 0.6 }),
    slate: std(C.slate, { rough: 0.7 }), ok: std(C.ok, { rough: 0.6 }), neg: std(C.neg, { rough: 0.6 }), trunk: std(C.trunk, { rough: 0.9 }) };
  const UNIT = new THREE.BoxGeometry(1, 1, 1);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const mesh = (geo, mat, parent = scene, pos = [0, 0, 0], rot = [0, 0, 0], shadow = true) => {
    const o = new THREE.Mesh(geo, mat); o.position.set(...pos); o.rotation.set(...rot); o.castShadow = shadow; o.receiveShadow = true; parent.add(o); return o;
  };
  const box = (w, h, d, mat, x, y, z, parent = scene, ry = 0, shadow = true) => { const o = mesh(UNIT, mat, parent, [x, y + h / 2, z], [0, ry, 0], shadow); o.scale.set(w, h, d); return o; };
  const cyl = (r, h, mat, x, y, z, parent = scene, seg = 28) => mesh(new THREE.CylinderGeometry(r, r, h, seg), mat, parent, [x, y + h / 2, z]);
  function tex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); draw(g, w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }
  const FD = '"Newsreader", Georgia, serif', FM = '"JetBrains Mono", Menlo, monospace', FB = '"Schibsted Grotesk", system-ui, sans-serif';
  const texMat = (t, o = {}) => new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, transparent: !!o.transparent, side: o.side ?? THREE.FrontSide });
  const plane = (w, h, t, parent, pos, rot = [0, 0, 0], o = {}) => mesh(new THREE.PlaneGeometry(w, h), texMat(t, o), parent, pos, rot, !!o.shadow);
  const roundRect = (g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  // a sheet of paper with a title and grey text lines
  const sheetTex = (title, lines = 6, o = {}) => tex(512, 680, (g, w, h) => {
    g.fillStyle = o.bg || '#fdfdfb'; g.fillRect(0, 0, w, h);
    g.fillStyle = o.ink || '#151a2d'; g.font = `600 ${o.ts || 40}px ${o.tf || FB}`;
    String(title).split('\n').forEach((t, i) => g.fillText(t, 44, 92 + i * (o.ts || 40) * 1.25));
    const y0 = 92 + String(title).split('\n').length * (o.ts || 40) * 1.25 + 26;
    g.fillStyle = '#c9cedb'; for (let i = 0; i < lines; i++) g.fillRect(44, y0 + i * 44, (i % 3 === 2 ? 0.62 : 0.86) * (w - 88), 14);
    if (o.extra) o.extra(g, w, h);
  });

  // ── "plan" props: everything past the "now" stop is drawn as a see-through model with outlined edges
  const ghostM = new THREE.MeshStandardMaterial({ color: 0xf7f8fc, transparent: true, opacity: 0.5, roughness: 0.9, depthWrite: false });
  const edgeM = new THREE.LineBasicMaterial({ color: 0x8e97b0, transparent: true, opacity: 0.85 });
  function ghost(group) {
    const list = []; group.traverse((o) => { if (o.isMesh) list.push(o); });
    for (const o of list) {
      o.castShadow = false;
      if (o.isInstancedMesh) { o.material = ghostM; continue; }
      o.material = o.material.map ? new THREE.MeshStandardMaterial({ map: o.material.map, transparent: true, opacity: 0.55, depthWrite: false, roughness: 0.9 }) : ghostM;
      o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 25), edgeM));
    }
  }

  // ── the ground and the model base
  mesh(new THREE.PlaneGeometry(1200, 1200), std(C.ground), scene, [90, -0.62, 0], [-Math.PI / 2, 0, 0], false);
  const BX0 = -24, BX1 = 200, BZ0 = -30, BZ1 = 28;
  box(BX1 - BX0, 0.6, BZ1 - BZ0, [M.side, M.side, M.base, M.side, M.side, M.side], (BX0 + BX1) / 2, -0.6, (BZ0 + BZ1) / 2, scene, 0, false);

  // ── the road: a centripetal Catmull-Rom curve through one point per stop (plus a lead-in and a tail), measured by arc length
  const RP = [[-14, 8], [0, 0], [15, -8], [30, 3], [45, -6], [60, 4], [75, -5], [90, 5], [105, -6], [121, 1], [139, -5], [154, 4], [169, -5], [184, 1], [196, 7]];
  const curve = new THREE.CatmullRomCurve3(RP.map(([x, z]) => V(x, 0, z)), false, 'centripetal');
  const PER = 120, NS = (RP.length - 1) * PER, SP = [], SL = [0];
  for (let k = 0; k <= NS; k++) SP.push(curve.getPoint(k / NS));
  for (let k = 1; k <= NS; k++) SL.push(SL[k - 1] + SP[k].distanceTo(SP[k - 1]));
  const LEN = SL[NS];
  const stopS = STOPS.map((_, i) => SL[(i + 1) * PER]);
  const S_NOW = stopS[NOW_I];
  const _t = V(0, 0, 0);
  function at(s, outP, outT = _t) {
    s = Math.max(0, Math.min(LEN, s)); let lo = 0, hi = NS;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (SL[m] <= s) lo = m; else hi = m; }
    const f = (s - SL[lo]) / Math.max(1e-6, SL[hi] - SL[lo]);
    outP.lerpVectors(SP[lo], SP[hi], f); outT.subVectors(SP[hi], SP[lo]).normalize(); return outP;
  }
  const nrm = (t, out = V(0, 0, 0)) => out.set(t.z, 0, -t.x);   // the road's left side (toward −z when it runs along +x): where the stops stand
  const ROAD_W = 1.5, ROAD_H = 0.22;
  // a strip along the road between s0 and s1, half-width hw at height y, shifted sideways by lat(s); with walls down to the base if sides
  function strip(s0, s1, hw, y, { lat = null, sides = false, step = 0.35 } = {}) {
    const n = Math.max(2, Math.ceil((s1 - s0) / step) + 1), pos = [], idx = [], P = V(0, 0, 0), T = V(0, 0, 0), N = V(0, 0, 0), c = V(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const s = s0 + (s1 - s0) * i / (n - 1); at(s, P, T); nrm(T, N); c.copy(P).addScaledVector(N, lat ? lat(s) : 0);
      pos.push(c.x + N.x * hw, y, c.z + N.z * hw, c.x - N.x * hw, y, c.z - N.z * hw);
      if (sides) pos.push(c.x + N.x * hw, 0, c.z + N.z * hw, c.x - N.x * hw, 0, c.z - N.z * hw);
    }
    const st = sides ? 4 : 2;
    for (let i = 0; i < n - 1; i++) {
      const a = i * st, b = (i + 1) * st;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
      if (sides) idx.push(a, b, a + 2, b, b + 2, a + 2, a + 1, a + 3, b + 1, b + 1, a + 3, b + 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    g.userData.segs = n - 1;
    return g;
  }
  const flat = (g) => { const o = g.toNonIndexed(); o.computeVertexNormals(); return o; };
  { // the walkway: solid up to "now", a paler planned road after it
    const done = mesh(flat(strip(0, S_NOW, ROAD_W, ROAD_H, { sides: true })), new THREE.MeshStandardMaterial({ color: C.walk, roughness: 0.95, side: THREE.DoubleSide }));
    const plan = mesh(flat(strip(S_NOW, LEN, ROAD_W, ROAD_H - 0.002, { sides: true })), new THREE.MeshStandardMaterial({ color: C.plan, roughness: 0.95, side: THREE.DoubleSide }));
    done.castShadow = plan.castShadow = false;
    // dashes down the middle of the planned road
    const n = Math.floor((LEN - S_NOW - 3) / 1.6), dash = new THREE.InstancedMesh(new THREE.BoxGeometry(0.75, 0.02, 0.16), std(0x9aa3ba), n);
    const P = V(0, 0, 0), T = V(0, 0, 0), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = V(0, 1, 0);
    for (let i = 0; i < n; i++) { at(S_NOW + 2.4 + i * 1.6, P, T); q.setFromAxisAngle(up, Math.atan2(-T.z, T.x)); m4.compose(P.setY(ROAD_H + 0.01), q, V(1, 1, 1)); dash.setMatrixAt(i, m4); }
    dash.receiveShadow = true; scene.add(dash);
  }
  // the indigo progress line, drawn by scroll (drawRange) up to where the robot stands
  const lineGeo = strip(0, S_NOW, 0.42, ROAD_H + 0.012, { step: 0.25 });
  const LINE_SEGS = lineGeo.userData.segs;
  const progLine = mesh(lineGeo, new THREE.MeshStandardMaterial({ color: C.indigo, roughness: 0.5, emissive: C.indigo, emissiveIntensity: 0.18 }), scene, [0, 0, 0], [0, 0, 0], false);
  progLine.geometry.computeVertexNormals();
  const setLine = (s) => { progLine.geometry.setDrawRange(0, Math.round(Math.max(0, Math.min(1, s / S_NOW)) * LINE_SEGS) * 6); };

  // ── the fork: between the research question and "now" the four conditions run as four lanes beside the road, then rejoin it
  const CONDS = [['blind', 'BLIND', -7.6], ['sighted', 'SIGHTED', -4.6], ['rule', 'SIGHTED + RULE', 4.6], ['decoy', 'DECOY', 7.6]];
  const fs0 = stopS[stopIndexOf('question')] + 2.5, fs1 = stopS[stopIndexOf('now')] - 2.5;
  const bump = (s) => { const u = (s - fs0) / (fs1 - fs0); return Math.sin(Math.PI * Math.max(0, Math.min(1, u))) ** 0.7; };
  const lanes = new THREE.Group(); scene.add(lanes);
  for (const [key, name, off] of CONDS) {
    const g = flat(strip(fs0, fs1, 0.55, 0.1, { lat: (s) => off * bump(s), sides: true }));
    mesh(g, new THREE.MeshStandardMaterial({ color: C[key], roughness: 0.6, side: THREE.DoubleSide }), lanes, [0, 0, 0], [0, 0, 0], false);
    // a small standing card halfway along each lane: what the agents are shown
    const sMid = (fs0 + fs1) / 2, P = at(sMid, V(0, 0, 0), _t.clone()), N = nrm(_t.clone()), c = P.clone().addScaledVector(N, off);
    const shown = { blind: '• • •', sighted: '0.906', rule: '0.906', decoy: '0.731' }[key];
    const t = tex(320, 420, (g, w, h) => {
      g.fillStyle = key === 'blind' ? '#f0e3cb' : '#fdfdfb'; roundRect(g, 6, 6, w - 12, h - 12, 18); g.fill();
      g.strokeStyle = `#${C[key].toString(16).padStart(6, '0')}`; g.lineWidth = 10; roundRect(g, 6, 6, w - 12, h - 12, 18); g.stroke();
      g.fillStyle = g.strokeStyle; g.font = `600 30px ${FM}`; g.textAlign = 'center'; g.fillText(name, w / 2, 70);
      if (key === 'blind') { g.beginPath(); g.arc(w / 2, 230, 62, 0, 7); g.fillStyle = '#d9480f'; g.fill(); g.fillStyle = '#fff'; g.font = `600 30px ${FM}`; g.fillText('SEALED', w / 2, 242); }
      else { g.fillStyle = key === 'decoy' ? '#b5357a' : '#d9480f'; g.font = `600 84px ${FM}`; g.fillText(shown, w / 2, 262); }
      if (key === 'rule') { g.fillStyle = '#586078'; g.font = `500 24px ${FB}`; g.fillText('"do not tune to it"', w / 2, 340); }
      if (key === 'decoy') { g.fillStyle = '#586078'; g.font = `500 24px ${FB}`; g.fillText('(a wrong number)', w / 2, 340); }
    });
    const holder = new THREE.Group(); holder.position.copy(c); holder.rotation.y = 0; lanes.add(holder);
    box(0.08, 1.1, 0.08, M.slate, 0, 0.1, 0, holder);
    plane(1.5, 1.97, t, holder, [0, 2.15, 0.06], [-0.12, 0, 0], { side: THREE.DoubleSide, shadow: true });
  }

  // ── stops: a disc on the road, a round pad beside it, a short path between, and the stop's own model on the pad
  const PAD_R = 3.4, PAD_D = 6.4;
  const pads = STOPS.map((st, i) => {
    const P = at(stopS[i], V(0, 0, 0), _t.clone()), T = _t.clone(), N = nrm(T);
    const c = P.clone().addScaledVector(N, PAD_D);
    const plan = st.state === 'plan';
    const g = new THREE.Group(); g.position.copy(c); scene.add(g);
    const padTop = new THREE.Group(); padTop.position.y = ROAD_H; g.add(padTop);
    const pad = cyl(PAD_R, ROAD_H, plan ? M.plan : M.walk, 0, -ROAD_H, 0, padTop, 48); pad.castShadow = false;
    const rim = mesh(new THREE.TorusGeometry(PAD_R, 0.05, 6, 64), plan ? std(0xb4bbcc) : st.state === 'now' ? M.indigo : std(C.cap), padTop, [0, 0, 0], [Math.PI / 2, 0, 0], false);
    void rim;
    const link = box(1.3, ROAD_H - 0.004, PAD_D - PAD_R - ROAD_W + 0.4, plan ? M.plan : M.walk, 0, 0, 0, scene, Math.atan2(N.x, N.z), false);
    link.position.copy(P).addScaledVector(N, (ROAD_W + PAD_D - PAD_R) / 2).setY((ROAD_H - 0.004) / 2);
    const disc = cyl(0.95, 0.04, st.state === 'plan' ? std(0xffffff) : M.indigo, P.x, ROAD_H, P.z, scene, 36); disc.castShadow = false;
    if (plan) mesh(new THREE.TorusGeometry(0.95, 0.045, 6, 48), std(0x9aa3ba), scene, [P.x, ROAD_H + 0.045, P.z], [Math.PI / 2, 0, 0], false);
    const props = new THREE.Group(); padTop.add(props);
    return { st, i, road: P, c, g, props, top: 4.2, plan };
  });
  const PAD = Object.fromEntries(pads.map((p) => [p.st.id, p]));

  // 01 the brief: a notice board with the four asks, and a pile of papers
  { const p = PAD.brief.props;
    const t = tex(640, 820, (g, w, h) => {
      g.fillStyle = '#fdfdfb'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#3a4fd8'; g.font = `600 30px ${FM}`; g.fillText('HACKATHON BRIEF', 48, 84);
      g.fillStyle = '#151a2d'; g.font = `500 56px ${FD}`; g.fillText('Build a platform', 48, 170); g.fillText('that…', 48, 236);
      const asks = ['takes an ML paper PDF', 'finds its repository', 'runs it on CPU, isolated', 'gives an evidence-backed', '   reproducibility verdict'];
      g.font = `500 34px ${FB}`; asks.forEach((a, i) => { if (!a.startsWith(' ')) { g.fillStyle = '#3a4fd8'; g.fillText(String([1, 2, 3, 4][i] ?? ''), 48, 330 + i * 70); }
        g.fillStyle = '#151a2d'; g.fillText(a.trim(), 100, 330 + i * 70 - (a.startsWith(' ') ? 22 : 0)); });
    });
    box(0.12, 3.2, 0.12, M.slate, -1.2, 0, 0.1, p); box(0.12, 3.2, 0.12, M.slate, 1.2, 0, 0.1, p);
    box(2.9, 3.6, 0.1, M.wall, 0, 0.9, 0, p);
    plane(2.7, 3.46, t, p, [0, 2.7, 0.06]);
    for (let k = 0; k < 6; k++) box(1.1, 0.07, 1.45, k % 2 ? M.white : M.manila, 2.0 + (k % 2) * 0.04, k * 0.075, 1.3, p, 0.2 + k * 0.17);
    PAD.brief.top = 5.3;
  }
  // 02 the plan: three pillars, evidence · isolation · blind, and the rolled-up roadmap
  { const p = PAD.plan.props;
    [['EVIDENCE', -1.9, M.white], ['ISOLATION', 0, M.white], ['BLIND', 1.9, M.white]].forEach(([name, x, m], k) => {
      cyl(0.62, 0.22, M.cap, x, 0, -0.3, p); cyl(0.42, 2.6, m, x, 0.22, -0.3, p); box(1.3, 0.24, 1.3, M.cap, x, 2.82, -0.3, p);
      const t = tex(300, 90, (g, w, h) => { g.fillStyle = '#151a2d'; roundRect(g, 0, 0, w, h, 14); g.fill(); g.fillStyle = '#fff'; g.font = `600 36px ${FM}`; g.textAlign = 'center'; g.fillText(name, w / 2, 60); });
      plane(1.22, 0.37, t, p, [x, 1.5, 0.14]);
      if (k === 2) { const e = box(0.62, 0.05, 0.42, M.manila, x, 3.06, -0.3, p); void e; cyl(0.1, 0.06, M.seal, x, 3.11, -0.3, p, 16); }
    });
    const roll = mesh(new THREE.CylinderGeometry(0.22, 0.22, 2.2, 20), std(0x6f86e8, { rough: 0.7 }), p, [0.3, 0.22, 1.9], [0, 0, Math.PI / 2]); void roll;
    PAD.plan.top = 4.6;
  }
  // 03 the first slice: a glass lab with a small "random forest" inside, a green gate in front of it, and the paper going in
  { const p = PAD.slice.props;
    const glassM = new THREE.MeshStandardMaterial({ color: C.glass, transparent: true, opacity: 0.2, roughness: 0.15, depthWrite: false, side: THREE.DoubleSide });
    const lab = new THREE.Mesh(UNIT, glassM); lab.scale.set(3.4, 2.1, 2.4); lab.position.set(0.6, 1.05, -0.5); p.add(lab);
    const le = new THREE.LineSegments(new THREE.EdgesGeometry(UNIT), new THREE.LineBasicMaterial({ color: 0x4fae9f })); le.scale.copy(lab.scale); le.position.copy(lab.position); p.add(le);
    box(3.4, 0.06, 2.4, std(0xcdeee6), 0.6, 0, -0.5, p, 0, false);
    const crownGeo = new THREE.IcosahedronGeometry(0.42, 0), leaves = [C.leaf1, C.leaf2, C.leaf3];
    [[-0.3, -0.9], [0.6, -0.2], [1.5, -0.9], [0.1, 0.25], [1.2, 0.3]].forEach(([x, z], k) => {
      cyl(0.06, 0.55, M.trunk, x, 0.06, z, p, 6); mesh(crownGeo, new THREE.MeshStandardMaterial({ color: leaves[k % 3], roughness: 0.85, flatShading: true }), p, [x, 0.95, z], [0.2 * k, k, 0]);
    });
    // the policy gate: two posts and a bar
    box(0.16, 1.7, 0.16, M.slate, -2.1, 0, 1.3, p); box(0.16, 1.7, 0.16, M.slate, -2.1, 0, -0.5, p); box(0.14, 0.14, 2.0, M.ok, -2.1, 1.7, 0.4, p);
    const sh = plane(0.62, 0.82, sheetTex('PAPER\n.pdf', 5, { ts: 64 }), p, [-2.9, 0.62, 0.5], [0, 0.5, 0], { shadow: true }); void sh;
    PAD.slice.top = 3.6;
  }
  // 04 the shortcut: a side path off the road that ends at a barrier
  { const p = PAD.shortcut.props;
    const stripes = tex(256, 64, (g, w, h) => { for (let k = 0; k < 8; k++) { g.fillStyle = k % 2 ? '#ffffff' : '#d64545'; g.beginPath(); g.moveTo(k * 40 - 30, h); g.lineTo(k * 40, 0); g.lineTo(k * 40 + 40, 0); g.lineTo(k * 40 + 10, h); g.fill(); } });
    box(1.2, 0.06, 4.2, M.walk, 0.9, 0, 0.4, p, 0.35, false);
    for (const x of [-1.3, 1.5]) box(0.16, 1.5, 0.16, M.slate, x, 0, -1.4, p);
    for (const y of [0.75, 1.25]) { const b = box(3.1, 0.32, 0.08, std(0xffffff, { extra: { map: stripes } }), 0.1, y, -1.32, p); b.material.map = stripes; }
    const sign = tex(256, 256, (g) => { g.fillStyle = '#d64545'; g.beginPath(); g.arc(128, 128, 120, 0, 7); g.fill(); g.fillStyle = '#fff'; g.fillRect(48, 108, 160, 40); });
    box(0.1, 2.6, 0.1, M.slate, 1.9, 0, -0.4, p);
    plane(1.0, 1.0, sign, p, [1.9, 2.9, -0.34], [0, -0.3, 0], { transparent: true, side: THREE.DoubleSide });
    PAD.shortcut.top = 4.2;
  }
  // 05 the blind team: four trust zones, the sealed envelope, and three agents who never see inside it
  { const p = PAD.blind.props;
    [[0xdbe2ff, -1.25, -1.0], [0xe6dcfb, 1.25, -1.0], [0xcdeee6, -1.25, 1.1], [0xfbd8e2, 1.25, 1.1]].forEach(([c, x, z]) => box(2.3, 0.04, 2.0, std(c), x, 0.004, z, p, 0, false));
    // the envelope stands upright on a small stand, its face drawn flat (flap folds, address lines) with the wax seal in 3D at the flap's tip
    const env = new THREE.Group(); env.position.set(0.1, 0.04, -1.2); env.rotation.y = -0.12; p.add(env);
    box(0.5, 0.36, 0.42, M.cap, -0.7, 0, 0.05, env); box(0.5, 0.36, 0.42, M.cap, 0.7, 0, 0.05, env);
    box(2.4, 1.6, 0.08, M.manila, 0, 0.36, 0, env);
    const face = tex(600, 400, (g, w, h) => {
      g.fillStyle = '#f0e3cb'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#e6d5b6'; g.beginPath(); g.moveTo(0, h); g.lineTo(w / 2, h * 0.5); g.lineTo(w, h); g.fill();
      g.fillStyle = '#e8d8ba'; g.beginPath(); g.moveTo(0, 0); g.lineTo(w / 2, h * 0.56); g.lineTo(w, 0); g.fill();
      g.strokeStyle = '#c9b48f'; g.lineWidth = 4; g.beginPath(); g.moveTo(0, 0); g.lineTo(w / 2, h * 0.56); g.lineTo(w, 0); g.moveTo(0, h); g.lineTo(w / 2, h * 0.5); g.lineTo(w, h); g.stroke();
      g.strokeStyle = '#c9b48f'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
    });
    plane(2.4, 1.6, face, env, [0, 1.16, 0.041]);
    mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.08, 24), M.seal, env, [0, 1.16 + 0.8 - 1.6 * 0.56, 0.09], [Math.PI / 2, 0, 0]);
    PAD.blind.top = 4.0;
  }
  // 06 three results: paper's value (seal orange) beside the measured value (indigo), to scale
  { const p = PAD.results.props;
    const R = [['ROCKET', 0.906, 0.904, '0.906 · 0.904'], ['pyts BOSS', 1.0, 1.0, '1.000 · 1.000'], ['Urban RF', 0.8166, 0.7988, '81.66 · 79.88']];
    R.forEach(([name, a, b, txt], k) => {
      const x = (k - 1) * 2.0, H = 3.0;
      box(0.55, H * a, 0.55, M.seal, x - 0.32, 0, -0.4, p); box(0.55, H * b, 0.55, M.indigo, x + 0.32, 0, -0.4, p);
      const t = tex(360, 150, (g, w) => { g.fillStyle = '#fbfcfe'; roundRect(g, 4, 4, w - 8, 142, 16); g.fill(); g.strokeStyle = '#d6dbe7'; g.lineWidth = 4; g.stroke();
        g.textAlign = 'center'; g.fillStyle = '#151a2d'; g.font = `600 36px ${FB}`; g.fillText(name, w / 2, 58); g.font = `500 32px ${FM}`; g.fillStyle = '#586078'; g.fillText(txt, w / 2, 112); });
      plane(1.7, 0.71, t, p, [x, 0.55, 0.5], [-0.25, 0, 0], { transparent: true });
    });
    box(6.0, 0.03, 0.04, std(0x9aa3ba), 0, 3.0, -0.4, p, 0, false);   // the 1.0 line
    PAD.results.top = 4.6;
  }
  // 07 showing the work: a small model of the campus and a screen with the README
  { const p = PAD.show.props;
    box(3.0, 0.18, 2.2, M.cap, -0.9, 0, 0.1, p);
    [[0xdbe2ff, -1.85, -0.5], [0xfbe7c6, -0.9, -0.5], [0xe6dcfb, 0.05, -0.5], [0xcdeee6, -1.85, 0.6], [0xfbd8e2, -0.9, 0.6], [0xdbe2ff, 0.05, 0.6]].forEach(([c, x, z]) => {
      box(0.8, 0.05, 0.85, std(c), x, 0.18, z, p, 0, false); box(0.8, 0.22, 0.05, M.wall, x, 0.18, z - 0.42, p); box(0.05, 0.22, 0.85, M.wall, x - 0.4, 0.18, z, p);
    });
    for (let k = 0; k < 3; k++) cyl(0.07, 0.24, std([C.p, C.l, C.v][k]), -1.6 + k * 0.9, 0.23, 0.1, p, 10);
    const t = tex(560, 400, (g, w, h) => { g.fillStyle = '#11141d'; g.fillRect(0, 0, w, h); g.fillStyle = '#8fa2ff'; g.font = `600 34px ${FM}`; g.fillText('README.md', 30, 60);
      g.fillStyle = '#e9ebf3'; g.font = `500 44px ${FD}`; g.fillText('DéjàML', 30, 128); g.fillStyle = '#3a4c6e';
      for (let i = 0; i < 6; i++) g.fillRect(30, 168 + i * 34, (i % 3 === 2 ? 0.55 : 0.85) * (w - 60), 14); });
    box(0.12, 1.3, 0.12, M.slate, 1.9, 0, -0.6, p); box(2.0, 1.45, 0.1, M.dark, 1.9, 1.25, -0.62, p);
    plane(1.88, 1.34, t, p, [1.9, 1.975, -0.565]);
    PAD.show.top = 3.8;
  }
  // 08 any paper: seven new papers on stands; one went through, six were stopped by the gate
  { const p = PAD.open.props;
    const okT = sheetTex('✓ partially\nreproduced', 5, { ts: 52, extra: (g, w) => { g.fillStyle = '#1f9d63'; g.fillRect(0, 0, w, 18); } });
    const noT = sheetTex('policy\nblocked', 5, { ts: 52, ink: '#b42318', extra: (g, w) => { g.fillStyle = '#d64545'; g.fillRect(0, 0, w, 18); } });
    for (let k = 0; k < 7; k++) {
      const a = -0.95 + k * (1.9 / 6), x = Math.sin(a) * 2.4, z = -Math.cos(a) * 2.4 + 1.3;
      const st = new THREE.Group(); st.position.set(x, 0, z); st.rotation.y = -a; p.add(st);
      box(0.06, 0.55, 0.06, M.slate, 0, 0, 0, st);
      plane(0.86, 1.14, k === 3 ? okT : noT, st, [0, 1.15, 0.04], [-0.08, 0, 0], { side: THREE.DoubleSide, shadow: true });
    }
    PAD.open.top = 3.4;
  }
  // 09 the question: a signpost with one arm per condition
  { const p = PAD.question.props;
    cyl(0.12, 4.0, M.slate, 0, 0, 0, p, 12); cyl(0.5, 0.15, M.cap, 0, 0, 0, p);
    CONDS.forEach(([key, name], k) => {
      const t = tex(420, 80, (g, w, h) => { g.fillStyle = `#${C[key].toString(16).padStart(6, '0')}`; g.beginPath(); g.moveTo(0, 0); g.lineTo(w - 40, 0); g.lineTo(w, h / 2); g.lineTo(w - 40, h); g.lineTo(0, h); g.fill();
        g.fillStyle = '#fff'; g.font = `600 34px ${FM}`; g.fillText(name, 22, 54); });
      const arm = new THREE.Group(); arm.position.set(0, 3.55 - k * 0.55, 0); arm.rotation.y = [0.5, 0.15, -0.2, -0.55][k] + (k % 2 ? Math.PI : 0) * 0; p.add(arm);
      plane(2.3, 0.44, t, arm, [1.15, 0, 0.0], [0, 0, 0], { side: THREE.DoubleSide, shadow: true });
    });
    const q = tex(200, 200, (g) => { g.fillStyle = '#151a2d'; g.font = `500 190px ${FD}`; g.textAlign = 'center'; g.fillText('?', 100, 170); });
    plane(1.1, 1.1, q, p, [-1.9, 1.6, 0.6], [0, 0.4, 0], { transparent: true, side: THREE.DoubleSide });
    PAD.question.top = 5.0;
  }
  // 10 now: the smoke test, one block per run (filled = finished), and a beacon
  const beacon = new THREE.Group();
  { const p = PAD.now.props, { total, done } = PROGRESS.smoke, cols = 6;
    for (let k = 0; k < total; k++) {
      const x = (k % cols - (cols - 1) / 2) * 0.82, z = Math.floor(k / cols) * 0.82 - 0.2;
      const b = box(0.62, 0.62, 0.62, k < done ? M.indigo : new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }), x, 0, z, p);
      if (k >= done) b.add(new THREE.LineSegments(new THREE.EdgesGeometry(UNIT), edgeM));
    }
    const t = tex(400, 110, (g, w) => { g.fillStyle = '#3a4fd8'; roundRect(g, 0, 0, w, 110, 18); g.fill(); g.fillStyle = '#fff'; g.font = `600 44px ${FM}`; g.textAlign = 'center'; g.fillText(`${done} / ${total} RUNS`, w / 2, 70); });
    box(0.1, 1.5, 0.1, M.slate, 0, 0, -1.7, p);
    plane(1.8, 0.5, t, p, [0, 1.75, -1.64]);
    // the beacon on the road: a pulsing ring where the line ends
    const P = PAD.now.road; beacon.position.set(P.x, ROAD_H + 0.02, P.z); scene.add(beacon);
    for (let k = 0; k < 2; k++) { const r = mesh(new THREE.RingGeometry(1.1, 1.3, 48), new THREE.MeshBasicMaterial({ color: C.indigo, transparent: true, opacity: 0.6, depthWrite: false }), beacon, [0, 0.01 + k * 0.002, 0], [-Math.PI / 2, 0, 0], false); r.userData.k = k; }
    PAD.now.top = 3.6;
  }
  // 11 pilot: 90 runs, five papers
  { const p = PAD.pilot.props;
    const n = 90, im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), M.white, n), m4 = new THREE.Matrix4();
    for (let k = 0; k < n; k++) { const x = (k % 15 - 7) * 0.4, z = Math.floor(k / 15) * 0.4 - 1.2; m4.makeTranslation(x, 0.15, z); im.setMatrixAt(k, m4); }
    p.add(im);
    const t = tex(400, 110, (g, w) => { g.strokeStyle = '#8e97b0'; g.setLineDash([14, 10]); g.lineWidth = 6; roundRect(g, 4, 4, w - 8, 102, 18); g.stroke(); g.fillStyle = '#586078'; g.font = `600 44px ${FM}`; g.textAlign = 'center'; g.fillText('90 RUNS', w / 2, 72); });
    plane(1.8, 0.5, t, p, [0, 1.55, -1.6]); box(0.1, 1.3, 0.1, M.slate, 0, 0, -1.66, p);
    ghost(p); PAD.pilot.top = 3.4;
  }
  // 12 full study: about 600 runs, two model families
  { const p = PAD.full.props;
    const n = 600, im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), M.white, n), m4 = new THREE.Matrix4();
    for (let k = 0; k < n; k++) { const x = (k % 30 - 14.5) * 0.18, z = Math.floor(k / 30) * 0.18 - 1.6; m4.makeTranslation(x, 0.07, z); im.setMatrixAt(k, m4); }
    p.add(im);
    for (const [x, c] of [[-2.2, 0x6f86e8], [2.2, 0x0f9b8e]]) { box(0.08, 2.6, 0.08, M.slate, x, 0, 2.0, p); box(0.9, 0.55, 0.03, std(c), x + 0.49, 1.95, 2.0, p); }
    ghost(p); PAD.full.top = 3.6;
  }
  // 13 the paper: a tall sheet on a plinth
  { const p = PAD.paper.props;
    box(2.6, 0.5, 1.2, M.cap, 0, 0, -0.4, p);
    const t = sheetTex('Does seeing the\nnumber bias the\nagent?', 9, { ts: 50, tf: FD, extra: (g, w, h) => { g.fillStyle = '#8a91a6'; g.font = `500 22px ${FM}`; g.fillText('WORKSHOP PAPER · DRAFT', 44, h - 44); } });
    const sh = new THREE.Group(); sh.position.set(0, 0.5, -0.4); sh.rotation.x = -0.08; p.add(sh);
    box(2.3, 3.1, 0.06, M.white, 0, 0, 0, sh); plane(2.2, 2.92, t, sh, [0, 1.55, 0.035]);
    ghost(p); PAD.paper.top = 5.0;
  }
  // a few trees along the edges of the model, kept clear of the road and the pads
  {
    const spots = [], P = V(0, 0, 0), T = V(0, 0, 0), N = V(0, 0, 0);
    for (let s = 6; s < LEN - 4; s += 7.3) for (const side of [1]) {
      at(s, P, T); nrm(T, N); const d = 12.5 + ((s * 7) % 6);
      const x = P.x + N.x * d, z = P.z + N.z * d;
      if (z < BZ0 + 1.5 || z > BZ1 - 1.5) continue;
      if (pads.some((pd) => Math.hypot(pd.c.x - x, pd.c.z - z) < PAD_R + 1.8)) continue;
      if (Math.abs(s - (fs0 + fs1) / 2) < (fs1 - fs0) / 2 + 2) continue;
      let near = false; for (let u = Math.max(0, s - 12); u < Math.min(LEN, s + 12); u += 0.8) { at(u, T); if (Math.hypot(T.x - x, T.z - z) < ROAD_W + 1.6) { near = true; break; } }
      if (!near && (s * 13) % 3 < 2.2) spots.push([x, z]);
    }
    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.16, 1, 6).translate(0, 0.5, 0), crownGeo = new THREE.IcosahedronGeometry(1, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, M.trunk, spots.length);
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
  { // the start of the road and its name, painted on the base
    const t = tex(1024, 128, (g) => { g.fillStyle = '#8a92a9'; g.font = `600 64px ${FM}`; g.fillText('DÉJÀML · RESEARCH ROAD', 10, 86); });
    const o = new THREE.Mesh(new THREE.PlaneGeometry(16, 2), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false })); o.rotation.x = -Math.PI / 2; o.position.set(-10, 0.01, 17); scene.add(o);
  }

  // ── the robots: the walker (DéjàML's indigo) and, at the blind stop, three agents around the sealed envelope
  const BOT_S = 0.4, CLIPS = ['Idle', 'Walking', 'Wave', 'Yes', 'ThumbsUp'];
  const walker = { g: new THREE.Group(), s: 0, lastS: 0, speed: 0, bot: null, mixer: null, acts: null, cur: '', waved: false };
  scene.add(walker.g);
  { // a simple stand-in until the robot model is ready (and if it never is)
    const f = new THREE.Group(); walker.g.add(f); walker.simple = f;
    mesh(new THREE.CapsuleGeometry(0.32, 0.7, 4, 12), M.indigo, f, [0, 0.75, 0]); mesh(new THREE.SphereGeometry(0.26, 16, 12), M.white, f, [0, 1.55, 0]);
  }
  const extras = [[C.p, -1.5, 0.5, 2.6], [C.l, 1.6, 0.4, -2.6], [C.v, 0.1, 1.5, 3.14]].map(([c, x, z, ry]) => ({ c, x, z, ry, mixer: null }));
  function loadRobots() {
    if (typeof ROBOT_GLB_B64 === 'undefined') return;
    let buf;
    try { const s = atob(ROBOT_GLB_B64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); buf = u.buffer; } catch (err) { console.warn('robot model unreadable:', err); return; }
    new GLTFLoader().parse(buf, '', (gltf) => {
      try {
        const clips = {}; gltf.animations.forEach((cl) => { clips[cl.name] = cl; });
        if (CLIPS.some((n) => !clips[n])) throw new Error('robot clips missing');
        const trim = new THREE.MeshStandardMaterial({ color: 0xe9ebf2, roughness: 0.5, metalness: 0.05 });
        const make = (color, scale) => {
          const bot = SkeletonUtils.clone(gltf.scene); bot.scale.setScalar(scale);
          const main = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 }), swap = (m) => (m.name === 'Main' ? main : m.name === 'Grey' ? trim : m);
          bot.traverse((o) => { if (!o.isMesh) return; o.castShadow = true; o.receiveShadow = false; if (o.isSkinnedMesh) o.frustumCulled = false; o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material); });
          const mixer = new THREE.AnimationMixer(bot), acts = {}; for (const n of CLIPS) acts[n] = mixer.clipAction(clips[n]);
          return { bot, mixer, acts };
        };
        const w = make(C.indigo, BOT_S); walker.simple.visible = false; walker.g.add(w.bot); Object.assign(walker, { bot: w.bot, mixer: w.mixer, acts: w.acts });
        for (const e of extras) { const r = make(e.c, 0.3); r.bot.position.set(e.x, 0, e.z); r.bot.rotation.y = e.ry; PAD.blind.props.add(r.bot);
          const a = r.acts.Idle; a.play(); a.time = (e.x + 3) % 2; e.mixer = r.mixer; e.acts = r.acts; }
      } catch (err) { console.warn('robots unavailable, keeping simple figures:', err); }
    }, (err) => console.warn('robot model failed to parse:', err));
  }
  function play(name, fade = 0.3, once = false) {
    if (!walker.acts || walker.cur === name) return;
    const next = walker.acts[name], prev = walker.cur ? walker.acts[walker.cur] : null;
    next.reset(); next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity); next.clampWhenFinished = once;
    next.setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(prev ? fade : 0).play();
    if (prev && prev !== next) prev.fadeOut(fade);
    walker.cur = name; walker.until = once ? T + next.getClip().duration - 0.25 : 0;
  }

  // ── camera: one view per section. look = between the road and the stop's pad; pos = look + off.
  //    off2 = desktop view offset (shifts the subject right of the card); phones lift it above the card, step back and widen the lens.
  const VIEWS = {};
  for (const pd of pads) {
    const look = pd.road.clone().lerp(pd.c, 0.62).setY(1.3);
    const off = { question: V(-2, 17, 21), now: V(6, 9, 14.5), pilot: V(-1, 9, 15), full: V(-1, 12, 16), paper: V(-1.5, 7.5, 15.5), results: V(-1.5, 7.5, 15.5) }[pd.st.id] || V(-2.5, 8.2, 15.5);
    if (pd.st.id === 'question') look.lerp(at((fs0 + fs1) / 2, V(0, 0, 0)), 0.45).setY(1.0);
    VIEWS[pd.st.id] = { pos: look.clone().add(off), look, off: [-0.2, 0], offM: [0, 0.25], fov: 34, m: 1.45 };
  }
  VIEWS.hero = { pos: V(22, 66, 104), look: V(84, 0, -4), off: [-0.15, 0.02], offM: [0, -0.2], fov: 34, m: 1.15 };
  VIEWS.end = { pos: V(150, 96, 130), look: V(96, 0, -2), off: [-0.17, 0.02], offM: [0, 0.22], fov: 34, m: 1.15 };
  { const q = new URLSearchParams(location.search).get('cam'); // debug: ?cam=x,y,z,lx,ly,lz,offx,view
    if (q) { const v = q.split(','), n = v.slice(0, 7).map(Number), k = v[7] || 'hero'; VIEWS[k] = { ...VIEWS[k], pos: V(n[0], n[1], n[2]), look: V(n[3], n[4], n[5]), off: [n[6], VIEWS[k].off[1]] }; } }
  const MOB = new Map();
  function viewFor(id, mobile) {
    const s = VIEWS[id]; if (!mobile) return s;
    let m = MOB.get(s);
    if (!m) { const d = s.pos.clone().sub(s.look).multiplyScalar(s.m ?? 1.45); m = { pos: s.look.clone().add(d), look: s.look, off: s.offM, fov: s.fov + 14 }; MOB.set(s, m); }
    return m;
  }
  // where the robot should stand for each section: at its stop, never past "now"
  const robotAt = (id) => id === 'top' ? 2 : id === 'end' || id === 'now' ? S_NOW : Math.min(S_NOW, stopS[stopIndexOf(id)] - 3.4);   // just short of the stop, so it doesn't hide the model
  const cam = { pos: VIEWS.hero.pos.clone(), look: VIEWS.hero.look.clone(), off: [...VIEWS.hero.off], fov: 34 }, tgt = { pos: V(0, 0, 0), look: V(0, 0, 0), off: [0, 0], fov: 34, s: 0 };
  const anchors = secs.map(() => ({ v: null, y: 0, s: 0 }));
  let CL = 0;
  function computeTarget() {
    const vh = innerHeight, mobile = innerWidth < 761, y = scrollY;
    secs.forEach((s, j) => { const r = s.getBoundingClientRect(); anchors[j].v = viewFor(s.dataset.at, mobile); anchors[j].s = robotAt(s.id); anchors[j].y = r.top + y + Math.min(r.height, vh * 1.4) / 2 - vh / 2; });
    let i = 0, f = 0, k = 0;
    if (y > anchors[0].y) for (i = 0; i < anchors.length - 1; i++) {
      if (y <= anchors[i + 1].y || i === anchors.length - 2) { f = Math.min(1, Math.max(0, (y - anchors[i].y) / Math.max(1, anchors[i + 1].y - anchors[i].y))); k = sstep(0.12, 0.88, f); break; }
    }
    const a = anchors[i], b = anchors[Math.min(i + 1, anchors.length - 1)];
    tgt.pos.lerpVectors(a.v.pos, b.v.pos, k); tgt.pos.y += Math.min(14, a.v.pos.distanceTo(b.v.pos) * 0.1) * Math.sin(Math.PI * k);
    tgt.look.lerpVectors(a.v.look, b.v.look, k);
    tgt.off[0] = a.v.off[0] + (b.v.off[0] - a.v.off[0]) * k; tgt.off[1] = a.v.off[1] + (b.v.off[1] - a.v.off[1]) * k; tgt.fov = a.v.fov + (b.v.fov - a.v.fov) * k;
    tgt.s = a.s + (b.s - a.s) * k;
    CL = i + f;
    const ch = Math.round(CL), id = secs[Math.min(secs.length - 1, ch)].id;
    setHere(id === 'top' ? -1 : id === 'end' ? STOPS.length : stopIndexOf(id));
    return id;
  }

  // ── pins: the date and name of each stop, projected from 3D
  const pinsEl = $('#pins');
  const PINS = pads.map((pd) => {
    const el = document.createElement('div'); el.className = 'pin' + (pd.st.state === 'plan' ? ' plan' : pd.st.state === 'now' ? ' now' : '');
    el.innerHTML = `<b></b><span></span>`; el.querySelector('b').textContent = pd.st.label;
    el.querySelector('span').textContent = pd.st.state === 'now' ? `We are here · ${pd.st.date}` : pd.st.date;
    pinsEl.appendChild(el); return { el, at: pd.c.clone().setY(pd.top + ROAD_H), id: pd.st.id };
  });
  const pv = V(0, 0, 0), mastEl = $('.mast');
  function updatePins(cur) {
    const W = innerWidth, H = innerHeight, mobile = W < 761, mastBottom = mastEl ? mastEl.getBoundingClientRect().bottom : 0, wide = cur === 'top' || cur === 'end';
    for (const p of PINS) {
      pv.copy(p.at).project(camera);
      const isNow = STOPS[stopIndexOf(p.id)].state === 'now';
      const show = pv.z < 1 && Math.abs(pv.x) < 1.05 && Math.abs(pv.y) < 1.05 && (cur === 'top' ? isNow : !mobile || p.id === cur || (wide && isNow));
      if (!show) { p.el.style.opacity = '0'; continue; }
      const d = camera.position.distanceTo(p.at), op = p.id === cur ? 1 : wide ? 0.92 : Math.max(0, Math.min(1, 1.5 - d / 45));
      p.el.style.opacity = String(op); p.el.classList.toggle('on', p.id === cur);
      const lw = p.el.offsetWidth, lh = p.el.offsetHeight;
      const lx = Math.min(W - lw / 2 - 8, Math.max(lw / 2 + 8, (pv.x + 1) / 2 * W)), ly = Math.min(H - 8, Math.max(mastBottom + lh + 6, (1 - pv.y) / 2 * H));
      p.el.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px) translate(-50%, -100%)`;
    }
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

  // ── loop
  let last = performance.now(), T = 0;
  const drift = V(0, 0, 0), RPOS = V(0, 0, 0), RTAN = V(0, 0, 0);
  loadRobots();
  if (/[?&]debug\b/.test(location.search)) window.__road = { renderer, scene, walker, LEN, S_NOW };
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; T += dt;
    const cur = computeTarget(), still = RM.matches;
    const k = still ? 1 : 1 - Math.exp(-dt * 4.2);
    cam.pos.lerp(tgt.pos, k); cam.look.lerp(tgt.look, k);
    cam.off[0] += (tgt.off[0] - cam.off[0]) * k; cam.off[1] += (tgt.off[1] - cam.off[1]) * k; cam.fov += (tgt.fov - cam.fov) * k;
    camera.position.copy(cam.pos);
    if (!still) camera.position.add(drift.set(Math.sin(T * 0.12) * 0.5, Math.sin(T * 0.16) * 0.25, 0));
    camera.lookAt(cam.look); camera.fov = cam.fov;
    camera.setViewOffset(innerWidth, innerHeight, cam.off[0] * innerWidth, cam.off[1] * innerHeight, innerWidth, innerHeight);
    camera.updateProjectionMatrix();
    sun.position.copy(cam.look).add(SUN); sun.target.position.copy(cam.look); fill.target.position.copy(cam.look); fill.position.copy(cam.look).add(V(-30, 22, -24));
    // the walker follows the scroll along the road; the line is drawn up to its feet
    const ks = still ? 1 : 1 - Math.exp(-dt * 3.2);
    walker.s += (tgt.s - walker.s) * ks;
    walker.speed = Math.abs(walker.s - walker.lastS) / Math.max(dt, 1e-3); const dir = Math.sign(walker.s - walker.lastS); walker.lastS = walker.s;
    at(walker.s, RPOS, RTAN); walker.g.position.set(RPOS.x, ROAD_H, RPOS.z);
    const face = Math.atan2(RTAN.x, RTAN.z) + (dir < 0 && walker.speed > 0.3 ? Math.PI : 0), atNow = Math.abs(walker.s - S_NOW) < 0.6;
    const want = walker.speed > 0.3 ? face : atNow ? 0.35 : face;
    let dr = want - walker.g.rotation.y; dr = Math.atan2(Math.sin(dr), Math.cos(dr)); walker.g.rotation.y += dr * (still ? 1 : Math.min(1, dt * 8));
    setLine(walker.s);
    if (walker.acts) {
      if (still) { walker.mixer.stopAllAction(); const a = walker.acts[walker.speed > 0.3 ? 'Walking' : 'Idle']; a.reset().play(); a.time = walker.speed > 0.3 ? (walker.s / 1.4) % a.getClip().duration : 0; walker.mixer.update(0); walker.cur = ''; }
      else {
        if (walker.speed > 0.3) { play('Walking', 0.2); walker.acts.Walking.setEffectiveTimeScale(Math.min(2.6, Math.max(0.8, walker.speed / 1.6))); walker.waved = false; }
        else if (walker.until && T < walker.until) { /* finishing a wave */ }
        else if (atNow && !walker.waved) { walker.waved = true; play('Wave', 0.25, true); }
        else play('Idle', 0.35);
        walker.mixer.update(dt);
      }
      for (const e of extras) if (e.mixer) e.mixer.update(still ? 0 : dt);
    } else if (walker.simple && !still) walker.simple.position.y = walker.speed > 0.3 ? Math.abs(Math.sin(T * 9)) * 0.08 : 0;
    // the beacon's rings pulse outward
    beacon.children.forEach((r) => { const u = still ? 0.5 : ((T * 0.55 + r.userData.k * 0.5) % 1); r.scale.setScalar(0.8 + u * 1.4); r.material.opacity = 0.65 * (1 - u); });
    renderer.render(scene, camera);
    updatePins(cur);
    adapt(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
