# Sub-phase 4.3 — Virtual Lab and Findings

**Status:** `DONE`
**Completed:** `2026-09-28`
**Commit:** `fd245bb`
**Owner:** `Claude`

## Objective

Stream bounded command output and display the paper-versus-observed comparison, discrepancy findings, cleanup status, and report download.

## Delivered

- **Virtual Lab** screen, built only from `lab_engineer` events:
  - lab phase (preparing, running, finished, failed, timed out, cancelled) and a Cancel action while active;
  - the approved argv and working directory;
  - isolation facts (image, network off, read-only root, limits);
  - sanitized stdout/stderr, auto-scrolled and capped at 500 lines on screen, with a count of held-back lines;
  - CPU, memory, and process meters against the approved limits;
  - artifacts with size and digest;
  - cleanup status.
- **Findings** screen, built from the Result Verifier's assessment:
  - verdict with a plain explanation;
  - paper value, observed value, signed difference, and tolerance;
  - the summary sentence and evidence;
  - every comparability check;
  - discrepancy hypotheses, each labelled "Hypothesis" and described as untested;
  - limitations and cleanup outcome;
  - **Download report** (the server report link in live mode, or a JSON report built in the browser and marked as an example replay).
- `verifyResult` now includes the full `Assessment` and unit in its `comparison_completed` payload.
- The replay fixture's lab and verification events (sequence 11–23) are now produced by the real `LabManager` and `verifyResult` against a scripted runtime (`fixtures/events/build-urban-land-cover-success.mjs`). The replay therefore has exactly the event shapes the live system emits.
- Cancelling a replay mirrors the Lab Manager's cancel events, so the screen ends in a cancelled, cleaned-up state.
- The replay banner now reads "Example replay … prepared run … built from the verified Phase 3 results. Nothing is executed."

## Files changed

- `apps/web/src/lib/lab.ts` — lab view, findings, and report builders.
- `apps/web/src/lib/roles.ts` — role labels and status tones (moved from the removed interim activity list).
- `apps/web/src/screens/VirtualLab.tsx`, `Findings.tsx` — new screens.
- `apps/web/src/lib/run-client.ts` — `reportUrl` and replay cancellation.
- `apps/web/src/App.tsx`, `components/Shell.tsx`, `styles.css` — wiring, banner, styles.
- `apps/web/src/**/*.test.ts(x)` — 8 new tests.
- `packages/result-verifier/src/assess.ts` — assessment in the event payload.
- `fixtures/events/build-urban-land-cover-success.mjs`, `urban-land-cover-success.json` — regenerated fixture.
- `package.json` — root dev dependencies for the fixture builder.

## Decisions and deviations

- Fixture lab output is abbreviated to two lines (`DEJAML_RESULT` with the accuracy only, and `DEJAML_ARTIFACT`). The replay uses only the verified value 79.88% and does not invent the other metrics. Telemetry values in the fixture are illustrative. A fixture recorded from a real run should replace it in 5.3.
- The Findings screen never shows a numeric verdict for an inconclusive assessment. It shows dashes and the failed check.

## Verification

```bash
npm run build && node fixtures/events/build-urban-land-cover-success.mjs
find packages services apps -name dist -maxdepth 2 -exec rm -rf {} +
npm run check
npm audit --audit-level=moderate
git diff --check
# Playwright (Chromium) against vite preview, light 1280×900 and dark 390×844:
# start a replay, screenshot the running lab, wait for Findings, download the
# report and parse it, reopen Virtual Lab from the stepper.
```

**Observed result** (Linux amd64 cloud container, Node 22.22.2, Chromium 1194):

```text
Fixture builder: 23 schema-valid events; lab events 11–19, verifier 20–22, cleanup 23
npm run check: 8 workspaces, 91 tests passed (18 web tests)
npm audit: 0 vulnerabilities
Browser, both layouts:
  Virtual Lab "Running" with Cancel, the approved argv, network Off, Read-only root
  Findings "Different result": 81.66% vs 79.88%, −1.78 pp, ±1 pp, 8 checks (seed flagged),
    5 labelled hypotheses, "Lab removed"
  Downloaded report: verdict different_result, source "example replay (nothing was executed)", 23 events
  0 console errors
```

## Known limitations

- The live report link depends on the Run API (5.1).
- The browser-built report contains the public events and assessment only, not the full bounded logs.
- Telemetry is shown as current meters without a history chart.

## Restore procedure

1. Run `npm ci` and `npm run check`; require 91 passing tests.
2. If event shapes change, run `npm run build && node fixtures/events/build-urban-land-cover-success.mjs` and review the diff.
3. Run `npm run dev --workspace @dejaml/web`, start a replay, and confirm the Virtual Lab and Findings screens and the report download.

## Remaining work

- Serve real runs to this UI (5.1), then prove failure paths (5.2).

## Next sub-phase

`5.1 — End-to-end vertical slice`
