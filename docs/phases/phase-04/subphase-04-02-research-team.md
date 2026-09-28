# Sub-phase 4.2 — Research Team

**Status:** `DONE`
**Completed:** `2026-09-28`
**Commit:** `e68f890`
**Owner:** `Claude`

## Objective

Render Paper Analyst, Code Analyst, and Lead Researcher progress with evidence-bearing events.

## Delivered

- Research Team screen with Paper Analyst and Code Analyst as side-by-side lanes and the Lead Researcher below them (ADR 0004).
- Each lane derives its status (Waiting, Working, Done, Failed) and warning count from the public event stream only. Each event shows its summary, time, warning or failure badge, and evidence pointers labelled Paper, Code, Log, or Artifact, with quoted excerpts.
- An "Analysts working in parallel" badge appears only when both analysts were active at the same moment in the stream.
- The Lead Researcher lane names which analyst it is still waiting for.
- The stepper lets viewers revisit any stage the run has reached, and clicking the live stage resumes following it. Steps keep accessible names when labels collapse on narrow screens.

## Files changed

- `apps/web/src/lib/lanes.ts` — lane status and overlap detection.
- `apps/web/src/components/Evidence.tsx` — evidence pointer list.
- `apps/web/src/screens/ResearchTeam.tsx` — Research Team screen.
- `apps/web/src/components/Stepper.tsx`, `Shell.tsx`, `App.tsx` — stage navigation.
- `apps/web/src/styles.css` — lane, timeline, and evidence styles.
- `apps/web/src/screens/ResearchTeam.test.tsx`, `App.test.tsx` — tests.

## Decisions and deviations

- The parallel badge is computed from the events, not assumed, so a sequential run never claims concurrency.
- Virtual Lab and Findings still use the interim activity list until 4.3.

## Verification

```bash
find packages services apps -name dist -maxdepth 2 -exec rm -rf {} +
npm run check
git diff --check
# Playwright (Chromium) against vite preview: start a replay, screenshot mid-run
# and after completion, revisit Research Team from the stepper; light 1280×900
# and dark 390×844.
```

**Observed result** (Linux amd64 cloud container, Node 22.22.2, Chromium 1194):

```text
npm run check: 83 tests passed (10 web tests)
Mid-run: Paper Analyst Done with page 1 and page 4 excerpts, Code Analyst Working,
  "Analysts working in parallel" shown, Lead "Waiting for Code Analyst to finish."
After completion: Code Analyst Done with 1 warning (train_test_split evidence),
  Lead Done with experiment-plan.json; Research Team reopened from the stepper
0 console errors
```

The browser pass found that on phones the stepper buttons had no accessible name once labels were hidden. Each step now carries `aria-label`. Time stamps and badges were also set not to wrap.

## Known limitations

- Evidence pointers are shown as references. Opening the cited paper page or repository file needs the report service (5.1).
- Times use the viewer's locale and clock.

## Restore procedure

1. Run `npm ci` and `npm run check`; require 83 passing tests.
2. Run `npm run dev --workspace @dejaml/web`, start a replay, and confirm both analyst lanes fill in with evidence while the Lead waits.

## Remaining work

- Virtual Lab and Findings screens (4.3).

## Next sub-phase

`4.3 — Virtual Lab and Findings`
