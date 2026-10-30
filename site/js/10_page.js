// Page logic: the live seal, the policy gate, the supervisor ladder, the study strip, the section menu.
// Shares one module scope with 20_campus.js (build.mjs concatenates them). 20_campus.js uses:
//   $, $$, RM, sstep, root, secs, renderChip(ch, force), revealSeal(), gateBlocked, gateOutcome, lastChapter.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const root = document.documentElement;

// ───────────── the live seal: DéjàML's sealTarget(), in the browser ─────────────
// canonicalJson sorts object keys at every level, exactly like apps/api/src/study/contract.ts
const canonicalJson = (v) => JSON.stringify(v, (_k, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
const TARGET = { schemaVersion: 1, caseId: 'rocket-ecg200', caseVersion: 'f2fa87bfcba0d2b75b81f871d8a4d46c9bc8d7febf15117f8b68f5fa3a03d55c',
  paperSha256: 'b58acd66dbd188978fc379f6949a4ea26c3c97aeaf6a27f5f16ccc182628df7a',
  claimLocator: { page: 25, location: 'Table 1, row ECG200, column Rocket' },
  metric: { name: 'mean test accuracy across 10 runs', unit: 'fraction' },
  reportedValue: 0.906, tolerance: 0.0053, comparisonRule: 'absolute_difference_within_tolerance', nonce };
const canonical = canonicalJson(TARGET);
let commitment = null;
sha256Hex(canonical).then((h) => {
  commitment = h;
  $$('[data-commit-full]').forEach((el) => { el.textContent = h; });
  renderChip(lastChapter, true);
}).catch(() => { $$('[data-commit-full]').forEach((el) => { el.textContent = 'unavailable in this browser'; }); });
let verified = false;
async function revealSeal() {
  if (verified || !commitment) return;
  verified = true;
  const again = await sha256Hex(canonical);       // revealTarget(): recompute and compare
  const ok = again === commitment;
  $$('[data-verify]').forEach((el) => { el.innerHTML = ok
    ? `<span class="ok-line">✓ matches the fingerprint</span><code>${again.slice(0, 16)}…${again.slice(-8)}</code><span>revealed: 0.906 ± 0.0053, page 25</span>`
    : '<span class="bad-line">The revealed value does not match its fingerprint.</span><span>The study would fail here.</span>'; });
  $$('[data-nonce]').forEach((el) => { el.textContent = nonce.slice(0, 24) + '…'; });
}

// ───────────── the policy gate (DéjàML's deterministic checks, in miniature) ─────────────
const PLAN = {
  repository: { url: 'https://github.com/angus924/rocket', commitSha: '36bd908b4f38e9ea8ca1a3ee6caaf71d405faf86' },
  command: { argv: ['python', '../work/adapter/rocket_ecg200_runner.py', '--rocket-functions', 'code/rocket_functions.py', '--training', '../data/extracted/ECG200_TRAIN.txt',
    '--testing', '../data/extracted/ECG200_TEST.txt', '--runs', '10', '--kernels', '10000', '--output', '../artifacts/result.json'], cwd: 'repo' },
  python: '3.11', requirements: ['numpy==1.23.5', 'scipy==1.9.3', 'scikit-learn==1.1.3', 'joblib==1.2.0', 'threadpoolctl==3.1.0', 'numba==0.57.1', 'llvmlite==0.40.1'],
  dataset: { url: 'https://timeseriesclassification.com/aeon-toolkit/ECG200.zip', sha256: '755937ea37849346ea20033666b19d17345bb039971e8fa33458b16b62c09380' },
  metricParser: { source: 'json', path: 'artifacts/result.json', key: 'metrics.accuracyMean' },
  expectedRuntimeSeconds: 120,
  resources: { cpus: 2, memoryMb: 4096, pids: 256, timeoutSeconds: 1800, networkDuringRun: false },
};
const RULES = {   // [outcome, reason, change]; outcomes as in contract.ts reviewPolicy()
  gpu: ['block', 'cupy-cuda12x: GPU packages (CUDA, ROCm) are refused; labs are CPU-only', (p) => { p.requirements.push('cupy-cuda12x==13.3.0'); }],
  host: ['block', 'the dataset host is not on the administrator\'s allowlist', (p) => { p.dataset.url = 'https://files.example-mirror.net/ECG200.zip'; }],
  time: ['block', 'the expected runtime (7200 s) exceeds the lab\'s command limit (900 s)', (p) => { p.expectedRuntimeSeconds = 7200; }],
  adapter: ['refuse', 'the plan\'s helper script is not the reviewed one', (p) => { p.adapter = { path: 'adapter.py', sha256: null }; }],
  expect: ['refuse', 'the command contains a value it must not know', (p) => { p.command.argv.push('--expected', '0.906'); }],
};
const gateOut = $('#gate-out');
let gateBlocked = false, gateOutcome = 'pass';   // 20_campus.js reads both
async function checkGate() {
  const plan = JSON.parse(JSON.stringify(PLAN)), block = [], refuse = [];
  for (const box of $$('#gate input')) if (box.checked) { const [outcome, why, apply] = RULES[box.dataset.rule]; apply(plan); (outcome === 'block' ? block : refuse).push(why); }
  gateBlocked = block.length + refuse.length > 0;
  gateOutcome = block.length ? 'block' : refuse.length ? 'refuse' : 'pass';
  const reasons = [...block, ...refuse].map((b) => '· ' + b).join('<br>');
  if (gateOutcome === 'block') { gateOut.className = 'gate-out block'; gateOut.innerHTML = `<b>Policy blocked</b>${reasons}<br>Nothing runs. The study ends as “Policy blocked”.`; return; }
  if (gateOutcome === 'refuse') { gateOut.className = 'gate-out refuse'; gateOut.innerHTML = `<b>Plan refused</b>${reasons}<br>Nothing runs. The plan is unusable, so the study ends as “Inconclusive”.`; return; }
  let digest = '';
  try { digest = (await sha256Hex(canonicalJson(plan))).slice(0, 16); } catch { digest = 'n/a'; }
  if (gateOutcome !== 'pass') return;   // a box changed while hashing
  gateOut.className = 'gate-out pass'; gateOut.innerHTML = `<b>Approved</b>Every check passed. Fingerprint of the plan shown: ${digest}…. DéjàML re-checks its own plan's fingerprint at every later stage, so any change is caught.`;
}
$$('#gate input').forEach((b) => b.addEventListener('change', checkGate)); checkGate();

// ───────────── the supervisor's one-way ladder (DOWNGRADES in verdict.ts) ─────────────
const DOWNGRADES = { reproduced: ['partially_reproduced', 'inconclusive'], partially_reproduced: ['inconclusive'], not_reproduced: ['inconclusive'] };
$$('#ladder [data-p]').forEach((b) => b.addEventListener('click', () => {
  const p = b.dataset.p, ok = DOWNGRADES.partially_reproduced.includes(p), out = $('#ladder output');
  const steps = $$('#ladder .track li'), at = (st) => steps.find((li) => li.dataset.st === st);
  steps.forEach((li) => { li.classList.remove('final', 'refused'); li.querySelector('small.res')?.remove(); });
  const mark = (li, cls, txt) => { li.classList.add(cls); const s = document.createElement('small'); s.className = 'res'; s.textContent = txt; li.append(s); };
  if (ok) {
    mark(at(p), 'final', 'final, after the Supervisor');
    out.innerHTML = '<span style="color: var(--warn)">Accepted.</span> Lowered to Inconclusive, the only step down allowed from Partially reproduced.';
  } else {
    void at(p).offsetWidth; mark(at(p), 'refused', 'refused');
    out.innerHTML = '<span style="color: var(--neg)">Refused.</span> The status stays Partially reproduced: a Supervisor can never raise a verdict.';
  }
}));

// ───────────── term definitions: a tooltip kept on screen, and a description for screen readers ─────────────
$$('.def[data-def]').forEach((d, i) => {
  const s = document.createElement('span'); s.id = `def-${i}`; s.hidden = true; s.textContent = d.dataset.def; d.after(s); d.setAttribute('aria-describedby', s.id);
  const fit = () => { const r = d.getBoundingClientRect(), w = Math.min(260, innerWidth - 32), c = r.left + r.width / 2;
    d.style.setProperty('--dx', `${Math.round(Math.min(innerWidth - 16 - w / 2, Math.max(16 + w / 2, c)) - c)}px`); };
  d.addEventListener('pointerenter', fit); d.addEventListener('focus', fit);
});

// ───────────── the section menu (narrow screens) ─────────────
const menu = $('.menu');
if (menu) {
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) menu.open = false; });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
  addEventListener('pointerdown', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
}

// ───────────── the study strip ─────────────
const strip = $('#strip'), chip = $('#chip');
const STAGE_AT = { ingest: 0, seal: 0, analyse: 1, plan: 3, prepare: 4, lab: 5, review: 6, reveal: 7 };
let lastChapter = -1, lastRevealed = null, lastChipKey = '';
const secs = $$('.sec[data-station]');
function renderChip(ch, force) {
  const id = secs[ch]?.id ?? 'top', revealed = root.classList.contains('revealed');
  if (!force && ch === lastChapter && revealed === lastRevealed) return;
  lastChapter = ch; lastRevealed = revealed;
  strip.classList.toggle('off', ch < 2);
  const stageIx = id in STAGE_AT ? STAGE_AT[id] : ch > 9 ? 8 : -1;
  $$('#stages li').forEach((li, i) => {
    li.className = i < stageIx ? 'done' : i === stageIx ? 'now' : '';
    if (i === stageIx) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  // the chip only changes (and is only announced) when the seal's state does
  const state = ch < 3 ? 'open' : revealed ? 'revealed' : 'sealed';
  const key = state + (state === 'sealed' && commitment ? commitment.slice(0, 8) : '');
  if (key === lastChipKey) return;
  lastChipKey = key;
  if (state === 'open') { chip.className = 'chip'; chip.innerHTML = '<span class="ck">Paper value</span> <b>0.906</b> <span class="cs">not sealed yet</span>'; }
  else if (state === 'sealed') { chip.className = 'chip sealed'; chip.innerHTML = `<span class="ck">Paper value</span> <b aria-hidden="true">0.906</b><span class="sr">hidden</span> <span class="cs">· sealed</span>${commitment ? `<span class="ch">, fingerprint <code>${commitment.slice(0, 8)}…</code></span>` : ''}`; }
  else { chip.className = 'chip revealed'; chip.innerHTML = '<span class="ck">Paper value</span> <b>0.906</b> <span class="cs">revealed ✓</span>'; }
}
