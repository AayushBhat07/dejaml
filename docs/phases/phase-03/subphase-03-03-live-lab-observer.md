# Sub-phase 3.3 — Live Lab Observer

**Status:** `DONE`
**Completed:** `2026-09-28`
**Commit:** `00bcce2`
**Owner:** `Claude`

## Objective

Stream terminal output, resource telemetry, artifact changes, and approved lab actions from a running lab as public run events.

## Delivered

- `executeAttempt(..., { observe })` publishes live events while the attempt runs:
  - `lab_output`: sanitized, batched stdout/stderr lines with a per-attempt character budget and a final warning when lines were held back.
  - `lab_telemetry`: CPU %, memory bytes/limit/%, PIDs, elapsed time, and approved limits from one streaming `docker stats` process.
  - `artifact_changed`: created or resized artifact files, symlinks ignored.
- Approved lab actions (create, prepare, attempt start with argv, cancel, artifact export, cleanup) were already events in 3.2 and now sit in one ordered stream with the live events.
- All output is flushed before the attempt's completion event, so consumers see the full live log before the result.

## Files changed

- `services/lab-manager/src/observer.ts` — line sanitizer, output batcher, docker stats parser, artifact watcher.
- `services/lab-manager/src/manager.ts` — observation wiring in `executeAttempt`.
- `services/lab-manager/src/observer.test.ts`, `manager.test.ts` — 7 new tests.
- `services/lab-manager/scripts/verify-docker.mjs` — live-observation scenario against real Docker.
- `services/lab-manager/README.md` — observation section.
- `docs/decisions/0011-live-lab-observer.md` — event design and the noVNC decision.

## Decisions and deviations

- Telemetry uses one streaming `docker stats` process per attempt. The first implementation polled with `--no-stream`, which took about a second per call and produced one sample in a 3.5 s run; the real-Docker proof caught this.
- **The noVNC virtual desktop was not built.** The roadmap asks for it only for genuine GUI/browser workloads, and the one supported case is terminal-only. ADR 0005 forbids simulating a desktop for it.
- Live events stop at the lab boundary. Serving them over SSE is API work in 5.1.

## Verification

```bash
find packages services -name dist -maxdepth 2 -exec rm -rf {} +
npm run check
npm run build
npm run verify:docker --workspace @dejaml/lab-manager
docker ps --all --filter label=dejaml.lab --quiet
git diff --check
```

**Observed result** (Linux amd64 cloud container, Docker 29.3.1, Node 22.22.2):

```text
npm run check: 63 tests passed across 6 workspaces (21 in lab-manager, 7 new)
verify:docker, all 3.2 scenarios still pass, plus live observation:
  6 colored "epoch n/6" lines and "done" arrived as 7 lab_output events,
  with ANSI color codes removed, before the attempt completion event
  4 telemetry samples at 0.5-2.5 s (up to 14% CPU, 9 MiB, 3 PIDs, limit 512 MiB)
  artifact_changed: "Created artifacts/progress.json" mid-run
  exit 0 in 3310 ms
Remaining dejaml.lab containers: 0
```

## Known limitations

- No noVNC observer (see above).
- The first telemetry sample can arrive before the experiment process starts, so it may show near-zero use.
- Output events are batched at 250 ms by default; they are a live view, not the authoritative log.
- The curated experiment has not been observed live here, because its image and dataset cannot be built or fetched in the cloud container (see 3.2).

## Restore procedure

1. Complete the 3.2 restore procedure.
2. Run `npm run check`; require 63 passing tests.
3. Run `npm run build` and `npm run verify:docker --workspace @dejaml/lab-manager`; require the `observed` block to list the seven lines, at least two telemetry samples, the `progress.json` change, and `remainingLabContainers: 0`.

## Remaining work

- Serve run events over SSE (5.1) and render them in the Virtual Lab screen (4.3).
- Add a noVNC observer only if a GUI workload is ever supported.

## Next sub-phase

`3.4 — Metric verification`
