# Sub-phase 5.3 — Demo freeze

**Status:** `IN PROGRESS` (tooling done and verified in the cloud; rehearsal, recording, and freeze need the development Mac)
**Last updated:** `2026-09-28`
**Commit:** `b0d2f4f`
**Owner:** `Claude`

## Objective

Rehearse repeatedly, cache permitted inputs, retain a labelled prior-run report and backup recording, and stop feature work.

## Delivered

- **Demo acceptance test** (`apps/api/src/acceptance.ts`): `checkDemoAcceptance(report, case, { expectedImageId })` applies ARCHITECTURE.md §15 to a finished report. It checks:
  - repository discovered with page evidence;
  - claim with page evidence;
  - pinned commit;
  - isolated attempt (exit 0, network none, read-only root);
  - parsed metric;
  - comparable verdict;
  - seed hypothesis;
  - cleanup receipt;
  - complete report;
  - the case's new `comparison.rehearsalBaseline` (79.88, `different_result`).

  `realRun` is true only when the lab image is the expected one, so a stand-in run can never count as a real rehearsal.
- **`npm run rehearse --workspace @dejaml/api`** uploads the paper N times to a running API. For each run it:
  - waits for the study and downloads the report;
  - applies the acceptance test;
  - checks that no `dejaml.lab` container remains;
  - keeps every report and a `summary.json` under `artifacts/rehearsals/<time>/`.

  It exits non-zero unless every rehearsal passes and was real (`--allow-stand-in` for testing).
- **`npm run record-fixture --workspace @dejaml/api`** turns a passing real report into:
  - the replay fixture;
  - `urban-land-cover-success.meta.json` with `source: "recorded"`, run ID, and date;
  - the labelled prior-run report `fixtures/reports/urban-land-cover-prior-run.json`.

  It refuses a failing report or another image. It refuses to write a stand-in run into the repository.
- **Web**:
  - The replay banner and the browser-built report now say which kind of replay is playing. Prepared: "Example replay … Nothing is executed." Recorded: "Recorded replay … recorded on <date>. Nothing is executed now."
  - The label is read from the fixture metadata.
  - The fixture builder now refuses to overwrite a recorded fixture.
- **`docs/runbooks/DEMO.md`**:
  - cached inputs;
  - pre-flight;
  - rehearsal;
  - recording the fallback and the backup video;
  - stage script;
  - a failure table with a single fallback (the labelled recorded replay);
  - freeze rules.

## Files changed

- `apps/api/src/acceptance.ts`, `index.ts`, `cases.ts` (baseline schema), `api.test.ts` (acceptance assertions).
- `apps/api/scripts/rehearse.mjs`, `record-fixture.mjs`; `package.json` scripts.
- `cases/urban-land-cover/case.json` — `comparison.rehearsalBaseline`.
- `fixtures/events/urban-land-cover-success.meta.json` (new, `prepared`), `build-urban-land-cover-success.mjs` (guard).
- `apps/web/src/lib/run-client.ts`, `lib/lab.ts`, `components/Shell.tsx`, `App.tsx`, tests (2 new).
- `docs/runbooks/DEMO.md`, `RESTORE.md`, READMEs.

## Decisions and deviations

- The fallback is the recorded replay, not a second live path. It is always labelled, and the presenter says that it is a recording.
- The rehearsal baseline is exact (79.88) because the attempt is deterministic with seed 42. Any other value means the environment changed.
- The committed fixture stays `prepared` until a real run is recorded on the Mac. A stand-in run is never committed as a recording.

## Verification

```bash
find packages services apps -name dist -maxdepth 2 -exec rm -rf {} +
npm run check
npm audit --audit-level=moderate
git diff --check
npm run verify:failures --workspace @dejaml/api
node fixtures/events/build-urban-land-cover-success.mjs    # unchanged fixture
# Stand-in stack (verify:stack), then:
npm run rehearse --workspace @dejaml/api -- --paper <stand-in paper> --runs 3 --allow-stand-in
npm run record-fixture --workspace @dejaml/api -- <report> --allow-stand-in --out-dir <scratch>
# Web replay build with that scratch fixture swapped in temporarily, checked in
# Chromium, then the committed fixture restored.
```

**Observed result** (Linux amd64 cloud container, Node 22.22.2, Docker 29.3.1, Chromium 1194):

```text
npm run check: 9 workspaces, 105 tests passed (api 10, web 21)
npm audit: 0 vulnerabilities
verify:failures: 8 scenarios passed, remainingLabContainers 0
Fixture builder: identical 23-event fixture
rehearse (stand-in): 3 × PASS completed 79.88 different_result, ~1 s each,
  "NOT the expected image"; without --allow-stand-in it exits 1
record-fixture: refuses the stand-in report ("lab image … is not the expected
  sha256:630cac…"); refuses --allow-stand-in into the repository; writes a
  24-event recorded fixture and prior-run report into the scratch directory
Browser (replay build with the scratch recording): banner "Recorded replay: …
  recorded on 2026-09-28. Nothing is executed now."; Findings "Different result",
  "Lab removed"; report source "recorded run run_… from 2026-09-28T15:42:09.838Z,
  replayed (nothing was executed now)"; 0 console errors
```

## Known limitations

- No real rehearsal has run yet. The committed fixture is still the prepared one.
- The backup video is a manual screen recording.
- GitHub is still contacted live during the demo (acquisition at the reviewed commit). If it is unreachable, the runbook falls back to the recorded replay.

## Remaining work (on the development Mac)

1. Cache the inputs and run pre-flight (DEMO.md §1–2).
2. `npm run rehearse --workspace @dejaml/api -- --paper artifacts/demo/paper.pdf --runs 3`: all PASS and real.
3. `npm run record-fixture --workspace @dejaml/api -- <passing report>`, then commit the fixture, metadata, and prior-run report.
4. Record the backup video.
5. Update this note to `DONE` with the rehearsal summary, and freeze.

## Restore procedure

1. Run `npm ci` and `npm run check`; require 105 passing tests.
2. Follow DEMO.md from §2.

## Next sub-phase

None. This is the last roadmap sub-phase.
