# Sub-phase 5.1 — End-to-end vertical slice

**Status:** `DONE` (cloud-verified with stand-ins; the real-model run is a Mac acceptance check)
**Completed:** `2026-09-28`
**Commit:** `9b21831`
**Owner:** `Claude`

> **Note (2026-09-30):** OpenClaw is not required and not used. The real-model run needs no OpenClaw agents. DéjàML runs its own native agents (`packages/agent-runtime`) and reaches OpenAI or Anthropic through its own provider adapters; the OpenClaw adapters and scripts referenced below were removed. This historical note is otherwise unchanged.

## Objective

Connect the uploaded PDF to real repository discovery, analysis, execution, comparison, and reporting.

## Delivered

- **`@dejaml/api`** (`apps/api`), a `node:http` service:
  - `POST /api/runs` accepts a multipart paper (20 MB limit, `413`/`415`/`400` on bad uploads, `409` while a study is running) and returns `202 {runId}`;
  - `GET /api/runs/:id` returns the snapshot;
  - `GET /api/runs/:id/events` streams SSE with replay from `?after=` or `Last-Event-ID` and a heartbeat;
  - `POST /api/runs/:id/cancel`;
  - `GET /api/runs/:id/report` downloads the JSON report;
  - the built web app is served with an SPA fallback, and path traversal is refused.
- **`runStudy` pipeline**:
  1. paper intake;
  2. GitHub discovery restricted to reviewed cases in `cases/`;
  3. acquisition checked against the reviewed commit;
  4. parallel Paper and Code Analysts;
  5. Lead Researcher and the deterministic policy gate;
  6. checkout removal;
  7. one baseline attempt in a disposable lab with live output and telemetry;
  8. Result Verifier;
  9. lab destruction in every outcome;
  10. `run_finished` and a report file for every terminal state.
- Cancellation aborts one signal shared by the analysts, the Lead Researcher, and the attempt. The analysts and the Lead now end a cancelled run as `cancelled`, not `inconclusive`.
- **Restart recovery**: orphan labs are removed and interrupted runs are marked `failed` with a `run_interrupted` event.
- `RunStore.listActiveRuns()` and `isTerminal()`.
- `cases.ts` loads and cross-checks each case's `policy.json` and `case.json`.
- `main.ts` wires the OpenClaw gateway client, the Docker CLI runtime, and the image lock (`DEJAML_EXPECTED_IMAGE_ID` override). Root `npm start` runs it.
- `stand-ins.ts` and `npm run verify:stack --workspace @dejaml/api` provide the real API and pipeline with scripted stand-ins for only the model, GitHub, and Docker.
- **Web**:
  - live mode keeps the run in `?run=`, so a refresh resumes the same study from the event log;
  - Findings has a **New study** button once the run has finished.

## Files changed

- `apps/api/**` — new workspace: `server.ts`, `pipeline.ts`, `cases.ts`, `main.ts`, `stand-ins.ts`, `index.ts`, `api.test.ts` (6 tests), `scripts/verify-stack.mjs`, README.
- `packages/run-store/src/index.ts`, `index.test.ts` — active-run listing and terminal check.
- `packages/research-runtime/src/orchestrator.ts`, `lead.ts` — `cancelled` on abort.
- `apps/web/src/App.tsx`, `screens/Findings.tsx`, `App.test.tsx` — URL resume, New study, 1 new test.
- `package.json` — `start` script. `package-lock.json` — new workspace.
- `docs/decisions/0014-run-api-and-pipeline.md`.

## Decisions and deviations

- One study at a time, as ARCHITECTURE.md §17 requires. There is no queue; the second upload is told to retry.
- A repository that is not a reviewed case, or has moved past the reviewed commit, ends as `inconclusive` before any lab exists.
- The repository checkout is removed before the lab starts. The lab mounts only the reviewed case adapter and data.
- The stand-ins are for tests and the local stack only. `main.ts` never imports them.

## Verification

```bash
find packages services apps -name dist -maxdepth 2 -exec rm -rf {} +
npm run check
npm audit --audit-level=moderate
git diff --check
VITE_DEJAML_API=live npm run build --workspace @dejaml/web
npm run verify:stack --workspace @dejaml/api
# Playwright (Chromium) against http://127.0.0.1:8787: upload the sample
# paper, wait for Research Team and Virtual Lab, reload mid-run, wait for
# Findings, download the server report, press New study.
```

**Observed result** (Linux amd64 cloud container, Node 22.22.2, Chromium 1194):

```text
npm run check: 9 workspaces, 99 tests passed (api 6, web 19)
npm audit: 0 vulnerabilities
API tests: end to end over HTTP (sequences contiguous, cleanup after comparison,
  report completed / different_result / -1.78 / verifiedAbsent, one checkout
  created and removed, replay from a later sequence), no repository link →
  inconclusive with no lab, cancel mid-attempt → cancelled with lab removed,
  wall-time limit → timed_out with lab removed, 413/415/409/404, restart recovery
Browser: ?run=<id> set on start and kept after reload; the run resumed at
  Virtual Lab and reached Findings "Different result" 81.66% vs 79.88%, −1.78 pp,
  "Lab removed"; downloaded dejaml-report-<id>.json: completed,
  different_result, cleanup verified, 27 events; New study reset the URL;
  no replay banner; 0 console errors
```

## Known limitations

- **The real end-to-end run was not executed in the cloud.** It needs the OpenClaw agents, the pinned `linux/arm64` image, and the UCI dataset, which exist only on the development Mac (GitHub API and UCI are also blocked from the container). Run the acceptance check in the restore procedure there.
- Reports and the SQLite store live under `DEJAML_DATA_DIR` with no retention policy.
- The API binds to `127.0.0.1` and has no authentication. It is a local demo service.

## Restore procedure

1. Run `npm ci` and `npm run check`; require 99 passing tests.
2. Run `VITE_DEJAML_API=live npm run build --workspace @dejaml/web`, then `npm run verify:stack --workspace @dejaml/api`, and complete a study in the browser at `http://127.0.0.1:8787`.
3. **Mac acceptance check:** with the gateway agents, image, and dataset from RESTORE.md sections 8–11, run `npm start`, upload the case paper, and require Findings `Different result` at 79.88% (−1.78 pp), a report with `cleanup.verifiedAbsent: true`, and no `dejaml.lab` containers afterwards.

## Remaining work

- Prove every failure and cleanup path against the real engine (5.2).
- Record a real-run fixture and freeze the demo (5.3).

## Next sub-phase

`5.2 — Failure and cleanup verification`
