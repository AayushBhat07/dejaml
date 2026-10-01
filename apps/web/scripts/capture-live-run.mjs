#!/usr/bin/env node
// Captures the Live Run Dashboard of one real, live study as proof screenshots.
//
//   node apps/web/scripts/capture-live-run.mjs <baseUrl> <runId> <outDir> [--timeout-min=240] [--stand-in]
//
// Open it right after starting a study on a live DéjàML server (the API serving
// a `VITE_DEJAML_API=live` build). It follows the run's SSE stream and saves a
// screenshot of the dashboard when it observes, live, each step of the blinded study:
//   01-target-sealed                        target_sealed
//   02-analysts-running                     agent_started of the Paper / Repository Analysts (both started)
//   03-planner-active                       agent_started of the Reproduction Planner
//   04-lab-engineer-terminal                the first lab_output
//   05-observation-locked-target-hidden     observation_locked
//   06-blind-reviewer-active                agent_started of an Independent Reviewer
//   07-target-revealed-final-comparison     deterministic_comparison (or final_status)
//   08-cleanup-verified                     study_cleanup, completed
// plus manifest.json listing what was captured, from which event, and what was missed.
// Once the target is revealed, it checks that no screenshot taken before the
// reveal had the paper's value anywhere in the page text (manifest "blinding").
//
// It refuses anything that is not a live run on that server: a replay build
// (no API, or the page in replay mode), a replay run id, or a run it cannot
// find. A server driven by scripted stand-ins (model "stand-in" or provider
// "scripted") is refused too, unless --stand-in is given; then every
// screenshot is stamped STAND-IN and named stand-in-*, and is never proof.
//
// Playwright: uses the `playwright` package if it resolves from here, otherwise
// a global install (npm root -g). Browsers come from PLAYWRIGHT_BROWSERS_PATH.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RUN_ID = /^run_[a-f0-9-]{36}$/u;
const STAND_IN_MODELS = new Set(["stand-in"]);
const STAND_IN_PROVIDERS = new Set(["scripted"]);

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write("usage: node apps/web/scripts/capture-live-run.mjs <baseUrl> <runId> <outDir> [--timeout-min=240] [--stand-in]\n");
  process.exit(2);
}

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(3);
}

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const flags = new Map(
  args
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [name, value] = arg.slice(2).split("=");
      return [name, value ?? "true"];
    }),
);
if (positional.length !== 3) usage();
const [rawBase, runId, outDir] = positional;
const standIn = flags.get("stand-in") === "true";
const timeoutMs = Number(flags.get("timeout-min") ?? "240") * 60_000;
let base;
try {
  base = new URL(rawBase).origin;
} catch {
  usage(`not a URL: ${rawBase}`);
}

async function loadPlaywright() {
  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve("playwright"));
  } catch {
    // Not a dependency of this repository.
  }
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    candidates.push(createRequire(join(root, "noop.js")).resolve("playwright"));
  } catch {
    // No global install either.
  }
  for (const candidate of candidates) {
    try {
      const module = await import(pathToFileURL(candidate).href);
      return module.chromium ?? module.default?.chromium;
    } catch {
      // Try the next one.
    }
  }
  refuse("Playwright is not installed (npm i -g playwright, and set PLAYWRIGHT_BROWSERS_PATH)");
}

// ---------------------------------------------------------------------------
// 1. Is this a live run on a live server?

if (!RUN_ID.test(runId)) refuse(`"${runId}" is not a live run id (replays use replay_… ids; live runs are run_<uuid>)`);
const configResponse = await fetch(`${base}/api/config`).catch(() => null);
const config = configResponse?.ok ? await configResponse.json().catch(() => null) : null;
if (!config || !Array.isArray(config.providers)) refuse(`${base} has no live Run API (/api/config); a replay build cannot be captured`);
const runResponse = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`).catch(() => null);
const snapshot = runResponse?.ok ? await runResponse.json().catch(() => null) : null;
if (!snapshot || snapshot.id !== runId) refuse(`run ${runId} does not exist on ${base}`);
const TERMINAL = new Set(["completed", "inconclusive", "failed", "cancelled", "timed_out"]);
const finishedBeforeStart = TERMINAL.has(snapshot.status);

// ---------------------------------------------------------------------------
// 2. Follow the run's events (the same SSE stream the page reads).

const startedAt = Date.now();
const state = {
  provider: null,
  model: null,
  running: new Map(), // agentId -> role
  analystsStarted: new Set(),
  revealed: null, // the target_revealed payload, once seen
  finished: false,
  lastSequence: 0,
};
const shots = [];
const missed = [];
/** Page text of each screenshot taken before the reveal, checked for the paper value once it is revealed. */
const preRevealTexts = [];
const MILESTONES = [
  { id: "01-target-sealed", title: "Paper target sealed" },
  { id: "02-analysts-running", title: "Paper and Repository Analysts running" },
  { id: "03-planner-active", title: "Reproduction Planner active" },
  { id: "04-lab-engineer-terminal", title: "Lab Engineer with live terminal output" },
  { id: "05-observation-locked-target-hidden", title: "Observation locked, paper target still hidden" },
  { id: "06-blind-reviewer-active", title: "Blind Independent Reviewer active" },
  { id: "07-target-revealed-final-comparison", title: "Target revealed and final comparison" },
  { id: "08-cleanup-verified", title: "Cleanup verified" },
];
const FULL_PAGE = new Set(["07-target-revealed-final-comparison", "08-cleanup-verified"]);
const pending = [];
const done = new Set();

function roleOf(event) {
  return typeof event.publicPayload?.role === "string" ? event.publicPayload.role : event.actor;
}

function observe(event, live) {
  if (String(event.id).startsWith("replay_")) refuse("the stream carries replay events");
  state.lastSequence = event.sequence;
  const payload = event.publicPayload ?? {};
  if ((event.type === "model_connection" || event.type === "study_team" || event.type === "agent_started") && payload.model) {
    state.provider = payload.provider ?? state.provider;
    state.model = payload.model;
    if (!standIn && (STAND_IN_MODELS.has(state.model) || STAND_IN_PROVIDERS.has(state.provider))) {
      refuse(`this run uses scripted stand-ins (provider ${state.provider}, model ${state.model}); it is not a real study`);
    }
  }
  const role = roleOf(event);
  if (event.type === "agent_started") state.running.set(payload.agentId, role);
  if (event.type === "agent_finished") state.running.delete(payload.agentId);
  if (event.type === "run_finished") state.finished = true;
  if (event.type === "target_revealed" && event.actor === "system") state.revealed = payload;
  const want = (id) => {
    if (done.has(id)) return;
    done.add(id);
    if (live) pending.push({ id, event });
    else missed.push({ id, reason: `already past when capture started (event ${event.sequence})` });
  };
  const system = event.actor === "system";
  if (system && event.type === "target_sealed") want("01-target-sealed");
  if (event.type === "agent_started" && (role === "paper_analyst" || role === "repository_analyst")) {
    state.analystsStarted.add(role);
    if (state.analystsStarted.size === 2) want("02-analysts-running");
  }
  if (event.type === "agent_started" && role === "reproduction_planner") want("03-planner-active");
  if (event.type === "lab_output" && event.status !== "warning") want("04-lab-engineer-terminal");
  if (system && event.type === "observation_locked") want("05-observation-locked-target-hidden");
  if (event.type === "agent_started" && role === "independent_reviewer") want("06-blind-reviewer-active");
  if (system && (event.type === "deterministic_comparison" || event.type === "final_status")) want("07-target-revealed-final-comparison");
  if (system && event.type === "study_cleanup" && event.status === "completed") want("08-cleanup-verified");
}

async function follow() {
  const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events?after=0`);
  if (!response.ok || !response.body) refuse(`the event stream for ${runId} is not available`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!state.finished) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      // Events from before the capture began are history: they update state but are not "observed live".
      const live = !finishedBeforeStart && Date.parse(event.timestamp) >= startedAt - 2_000;
      observe(event, live || event.type === "run_finished");
    }
  }
  await reader.cancel().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// 3. The page.

// Start following before the browser launches so early milestones are queued, not missed.
const following = follow();
const chromium = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(`${base}/?run=${encodeURIComponent(runId)}`, { waitUntil: "domcontentloaded" }); // The page holds an SSE stream open, so the network never idles.
const dashboard = page.getByTestId("live-run");
await dashboard.waitFor({ timeout: 30_000 }).catch(() => refuse("the page did not show the Live Run Dashboard"));
if ((await dashboard.getAttribute("data-mode")) !== "live") refuse("the page is in replay mode; only a live run can be captured");
if ((await page.locator('.banner[role="note"]').count()) > 0) refuse("the page shows a replay banner; only a live run can be captured");

await mkdir(resolve(outDir), { recursive: true });

async function stamp() {
  if (!standIn) return;
  await page.evaluate(() => {
    if (document.getElementById("stand-in-stamp")) return;
    const note = document.createElement("div");
    note.id = "stand-in-stamp";
    note.textContent = "STAND-IN SERVER: scripted model, GitHub and Docker. Layout check only, not evidence of a real study.";
    note.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9999;padding:6px 12px;background:#b42318;color:#fff;font:600 13px system-ui;text-align:center";
    document.body.appendChild(note);
  });
}

async function capture({ id, event }) {
  const milestone = MILESTONES.find((item) => item.id === id);
  // Let the page apply the event (it batches for 40 ms) and paint.
  await page
    .waitForFunction(
      (sequence) => Number(document.querySelector('[data-testid="live-run"]')?.getAttribute("data-last-sequence") ?? "0") >= sequence,
      event.sequence,
      { timeout: 15_000 },
    )
    .catch(() => process.stderr.write(`warning: the page had not shown event ${event.sequence} after 15 s\n`));
  if (id === "07-target-revealed-final-comparison") {
    // A revealed study shows the paper value; one that stayed sealed says so.
    await page
      .waitForFunction(
        () =>
          (document.querySelector('[data-testid="blinding-paper-value"]')?.textContent ?? "–") !== "–" ||
          document.querySelector('[data-testid="stayed-sealed"]') !== null,
        null,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
  }
  await page.waitForTimeout(400);
  await stamp();
  const file = `${standIn ? "stand-in-" : ""}${id}.png`;
  const revealedOnPage = (await page.locator('[data-testid="blinding-panel"][data-revealed="true"]').count()) > 0;
  if (!revealedOnPage) preRevealTexts.push({ file, text: await page.evaluate(() => document.body.innerText) });
  await page.screenshot({ path: join(resolve(outDir), file), fullPage: FULL_PAGE.has(id) });
  shots.push({
    file,
    milestone: milestone?.title ?? id,
    sequence: event.sequence,
    eventType: event.type,
    eventTimestamp: event.timestamp,
    targetRevealedOnPage: revealedOnPage,
  });
  process.stdout.write(`captured ${file} at event ${event.sequence} (${event.type})\n`);
}

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  while (pending.length) await capture(pending.shift());
  if (state.finished && pending.length === 0) break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
}
await following.catch(() => undefined);
while (pending.length) await capture(pending.shift());
for (const milestone of MILESTONES) {
  if (!done.has(milestone.id)) missed.push({ id: milestone.id, reason: state.finished ? "not observed during the run" : "timed out" });
}
await browser.close();

// The paper value, as the page would write it, must not be in any screenshot taken before the reveal.
let blinding = { revealed: false, checked: preRevealTexts.length, leaks: [] };
if (state.revealed && typeof state.revealed.reportedValue === "number") {
  const value = state.revealed.reportedValue;
  // A whole number is checked only with its percent sign, so "100" in a byte count is not mistaken for it.
  const forms = new Set(
    [String(value), String(Math.round(value * 10_000) / 10_000)].map((form) => (form.includes(".") ? form : `${form}%`)),
  );
  const leaks = preRevealTexts.filter(({ text }) => [...forms].some((form) => text.includes(form))).map(({ file }) => file);
  blinding = { revealed: true, checked: preRevealTexts.length, leaks };
  if (leaks.length) process.stderr.write(`BLINDING LEAK: the paper value was on the page before the reveal in ${leaks.join(", ")}\n`);
}

const manifest = {
  kind: standIn ? "stand-in layout check (NOT evidence of a real study)" : "live run capture",
  baseUrl: base,
  runId,
  provider: state.provider,
  model: state.model,
  capturedAt: new Date(startedAt).toISOString(),
  finishedBeforeCapture: finishedBeforeStart,
  shots,
  missed,
  blinding,
};
await writeFile(join(resolve(outDir), `${standIn ? "stand-in-" : ""}manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `${shots.length} screenshot(s) in ${resolve(outDir)}; missed: ${missed.map((item) => item.id).join(", ") || "none"}\n`,
);
process.exit(missed.length || blinding.leaks.length ? 1 : 0);
