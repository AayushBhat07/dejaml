# Sub-phase 4.1 — New Study and Application Shell

**Status:** `DONE`
**Completed:** `2026-09-28`
**Commit:** `1277373`
**Owner:** `Claude`

## Objective

Build the PDF submission experience and common visual system.

## Delivered

- New `@dejaml/web` workspace (React 19, Vite 8), built and tested by `npm run check`.
- Application shell with the brand, a four-stage stepper (New Study, Research Team, Virtual Lab, Findings) driven by run events, and a replay banner.
- Visual system: color, spacing, radius, and type tokens with light and dark schemes, plus shared button, card, badge, stepper, drop-zone, and timeline styles. Narrow screens collapse the stepper to numbered steps.
- New Study screen:
  - scope statement;
  - keyboard-accessible drop zone and file picker;
  - client checks for empty, over 20 MB, and non-PDF files, with plain-language errors;
  - file summary with SHA-256 fingerprint;
  - Start and Clear actions.
- `RunClient` with an HTTP implementation for the planned Run API and a labelled replay of the recorded curated run.
- Interim activity list with role names and status badges, which 4.2 and 4.3 replace with dedicated screens.

## Files changed

- `apps/web/` — app, components, screens, libraries, styles, tests, and README.
- `docs/decisions/0013-web-shell-and-replay.md` — web stack and replay decision.

## Decisions and deviations

- **Replay is the default** until the Run API lands in 5.1. It is always labelled on screen, and nothing is executed.
- The API contract (`POST /api/runs` with a `paper` form field, SSE `events?after=n`, `cancel`) is fixed here from ARCHITECTURE.md §6.2 and must be honored by 5.1.

## Verification

```bash
find packages services apps -name dist -maxdepth 2 -exec rm -rf {} +
npm run check
npm audit --audit-level=moderate
npm run build --workspace @dejaml/web && npx vite preview   # in apps/web
# Playwright (Chromium) script: load, pick a PDF, start, wait for completion,
# screenshot at 1280×820 light and 390×844 dark.
```

**Observed result** (Linux amd64 cloud container, Node 22.22.2, Chromium 1194):

```text
npm run check: 8 workspaces, 80 tests passed (7 new web tests); web bundle 328 kB (99.5 kB gzip)
npm audit: 0 vulnerabilities
Browser: New Study rendered in light desktop and dark mobile layouts; the PDF was fingerprinted;
  Start ran the replay to "Disposable lab removed"; the stepper advanced to Findings;
  0 console errors after adding the inline favicon
```

## Known limitations

- There is no backend yet, so live mode is untested end to end (5.1).
- The browser check reads the whole file to hash it. That is fine at 20 MB, but it is not streamed.
- The activity list is an interim view.

## Restore procedure

1. Run `npm ci` and `npm run check`; require 80 passing tests.
2. Run `npm run dev --workspace @dejaml/web` and open the printed URL.
3. Confirm the replay banner, choose any PDF, start, and see the stepper reach Findings.

## Remaining work

- Research Team lanes (4.2), Virtual Lab and Findings (4.3), and the live API (5.1).

## Next sub-phase

`4.2 — Research Team`
