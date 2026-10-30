// Page logic for the Research Road: the stops, the progress line in the top bar, and the parts of the cards filled from progress.json.
// Shares one module scope with 20_road.js (exports: $, $$, RM, sstep, root, secs, STOPS, NOW_I, stopIndexOf, setHere).
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const root = document.documentElement;
const secs = $$('main .sec');

// the stops on the road, in order; each has a section with the same id
const STOPS = [
  { id: 'brief', date: 'Sep 2026', label: 'Hackathon brief' },
  { id: 'plan', date: '28 Sep', label: 'Plan and principles' },
  { id: 'slice', date: '28 to 29 Sep', label: 'First working slice' },
  { id: 'shortcut', date: '29 Sep', label: 'Shortcut taken out' },
  { id: 'blind', date: '2 Oct', label: 'Blind agent team' },
  { id: 'results', date: 'Oct', label: 'Three real results' },
  { id: 'show', date: '8 to 30 Oct', label: 'Showing the work' },
  { id: 'open', date: 'From 15 Oct', label: 'Any lightweight paper' },
  { id: 'question', date: '28 Oct', label: 'The research question' },
  { id: 'now', date: '30 Oct', label: 'Smoke test' },
  { id: 'pilot', date: 'Next', label: '90-run pilot' },
  { id: 'full', date: 'Then', label: 'Full study' },
  { id: 'paper', date: 'Goal', label: 'The paper' },
];
const stopIndexOf = (id) => STOPS.findIndex((s) => s.id === id);
const NOW_I = Math.max(0, stopIndexOf(PROGRESS.now));
STOPS.forEach((s, i) => { s.state = i < NOW_I ? 'done' : i === NOW_I ? 'now' : 'plan'; });

// the progress line in the top bar: a few milestones, done / today / planned, and the one the reader is at
const PHASES = [['Start', 'brief'], ['First build', 'slice'], ['Agents', 'blind'], ['Results', 'results'], ['Open papers', 'open'],
  ['Question', 'question'], ['Smoke test', 'now'], ['Pilot', 'pilot'], ['Full study', 'full'], ['Paper', 'paper']];
const lineEl = $('#line');
lineEl.innerHTML = PHASES.map(([name, id]) => {
  const i = stopIndexOf(id), cls = i < NOW_I ? 'done' : i === NOW_I ? 'today' : 'plan';
  return `<li class="${cls}" data-i="${i}"><a href="#${id}"><i></i><span>${name}</span></a></li>`;
}).join('');
const phaseEls = $$('li', lineEl);
let hereI = -2;
function setHere(stopI) { // stopI: the stop the reader is at (-1 = hero, STOPS.length = the end)
  if (stopI === hereI) return; hereI = stopI;
  let k = -1; phaseEls.forEach((li, j) => { if (+li.dataset.i <= stopI) k = j; });
  phaseEls.forEach((li, j) => li.classList.toggle('here', j === k));
}
setHere(-1);

// dates
const fmt = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
$$('[data-updated]').forEach((el) => { el.textContent = fmt(PROGRESS.updated); });
$$('[data-days]').forEach((el) => { el.textContent = String(Math.round((Date.parse(PROGRESS.updated) - Date.parse('2026-09-28')) / 864e5)); });

// the smoke test card
{
  const { total, done, note } = PROGRESS.smoke;
  $('#smoke-runs').innerHTML = Array.from({ length: total }, (_, i) => `<i class="${i < done ? 'd' : ''}"></i>`).join('');
  $('#smoke-runs').setAttribute('aria-label', `${done} of ${total} smoke-test runs finished`);
  $('#smoke-text').textContent = `${done} of ${total} runs finished`;
  $('#smoke-note').textContent = note || '';
}
// the paper's steps
{
  const label = { done: 'Done', now: 'Now', next: 'Planned' };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('#paper-steps').innerHTML = PROGRESS.paper.map((p) =>
    `<li><span class="st ${p.status}">${label[p.status] || esc(p.status)}</span><span><b>${esc(p.label)}</b>${p.when ? ` <em>· ${esc(p.when)}</em>` : ''}</span></li>`).join('');
}
