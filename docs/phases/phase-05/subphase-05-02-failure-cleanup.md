# Sub-phase 5.2 — Failure and cleanup verification

**Status:** `DONE`
**Completed:** `2026-09-28`
**Commit:** `9e65b84`
**Owner:** `Claude`

## Objective

Prove cancellation, timeout, invalid input, unsupported repository, metric failure, and orphan-lab cleanup.

## Delivered

- **`npm run verify:failures --workspace @dejaml/api`** drives the real API over HTTP, the pipeline, and the Lab Manager on a real Docker engine. Only the model and GitHub are stand-ins.
  - The reviewed runner is replaced by a stub in a private copy of the case. Its policy carries the stub's digest, so the adapter check still runs.
  - The stub's input file selects its behaviour.
  - After every scenario the script requires that no `dejaml.lab` container remains, the lab directories are gone, and no repository checkout is left.

| Scenario | Required outcome |
| --- | --- |
| Success | `completed`, 79.88, `different_result`, cleanup verified |
| Exit 0 without a result | `inconclusive`, no metric, cleanup verified |
| Exit 3 with a traceback | `inconclusive`, stderr kept in the report, cleanup verified |
| Cancel while running | `cancelled`, output before the cancel kept, cleanup verified |
| 3 s wall-time limit | `timed_out` between 3 and 10 s, cleanup verified |
| API killed with SIGKILL mid-attempt | lab and checkout folder left behind; on restart, 1 orphan lab and 1 stale checkout removed, run marked `failed` |
| Paper without a repository link | `inconclusive`, no lab |
| Non-PDF upload | `inconclusive` ("file does not have a valid PDF header"), no lab |

- New API tests (stand-in runtime):
  - no metric;
  - non-zero exit;
  - repository moved past the reviewed commit (no lab, checkout removed);
  - plan edited beyond policy (policy rejects it, no lab);
  - restart recovery removing stale checkouts.
- **Fix found by the proof:** a killed API process left its empty `checkouts-*` folder in the data directory. `recoverAfterRestart` now takes `workRoot` and removes those folders, and `main.ts` passes it.

## Files changed

- `apps/api/scripts/verify-failures.mjs` — new real-Docker proof; `package.json` — `verify:failures`.
- `apps/api/src/server.ts`, `main.ts` — stale checkout recovery.
- `apps/api/src/stand-ins.ts` — `no_metric` and `crash` modes, plan editing, acquired commit override.
- `apps/api/src/api.test.ts` — 4 new tests and an extended recovery test.
- `apps/api/README.md`, `docs/runbooks/RESTORE.md`, `ROADMAP.md`.

## Decisions and deviations

- The proof builds its own small image (Python slim with UID/GID 10001), as `verify:docker` does, because the pinned lab image and dataset are not in the cloud. The Lab Manager's isolation settings and the pipeline are exactly the production ones.
- The memory limit is proven by `verify:docker` (256 MiB), not repeated here at the case's 2 GiB.
- A missing metric or a non-zero exit ends as `inconclusive`, not `failed`: the study ran correctly and could not compare. `failed` is kept for internal errors and interrupted runs.

## Verification

```bash
find packages services apps -name dist -maxdepth 2 -exec rm -rf {} +
npm run check
npm audit --audit-level=moderate
git diff --check
npm run verify:docker --workspace @dejaml/lab-manager
npm run verify:failures --workspace @dejaml/api
```

**Observed result** (Linux amd64 cloud container, Node 22.22.2, Docker 29.3.1):

```text
npm run check: 9 workspaces, 103 tests passed (api 10)
npm audit: 0 vulnerabilities
verify:docker: all checks passed, remainingLabContainers 0
verify:failures: 8 scenarios passed
  success     completed / different_result, exit 0, cleanup verified
  no_metric   inconclusive, exit 0, cleanup verified
  crash       inconclusive, exit 3, cleanup verified
  cancel      cancelled after 1582 ms, cleanup verified
  timeout     timed_out after 3041 ms, cleanup verified
  restart     1 orphan lab and 1 stale checkout after SIGKILL; recovery removed both; run failed
  unsupported inconclusive, no lab
  not a PDF   inconclusive, no lab
  remainingLabContainers 0
```

## Known limitations

- The dataset digest stop condition is recorded in the policy but not yet checked before a lab starts. The case adapter reads the data files as given.
- These scenarios use a stub runner. The real curated run is still the Mac acceptance check from 5.1.

## Restore procedure

1. Run `npm ci` and `npm run check`; require 103 passing tests.
2. With Docker running, run `npm run verify:failures --workspace @dejaml/api` and require all 8 scenarios and `remainingLabContainers: 0`.
3. If a run is interrupted by hand, restart the API and confirm its log line reports the recovered run and orphan lab.

## Remaining work

- Record a real-run fixture, rehearse, and freeze the demo (5.3).

## Next sub-phase

`5.3 — Demo freeze`
