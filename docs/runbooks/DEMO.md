# Demo Runbook

The live demo runs on the development Mac. Everything here assumes the setup in [RESTORE.md](RESTORE.md) sections 1–13 is complete: the server-side model environment, Docker with `dejaml/python-cpu:0.1.0`, and the dataset in `cases/urban-land-cover/data/`. Visitors do not configure agents or API keys.

## 1. Cache the inputs

Keep these local so the demo depends on the network only for the model and the GitHub clone:

- the paper PDF (`https://arxiv.org/pdf/2609.19010`) saved as `artifacts/demo/paper.pdf`;
- the lab image, checked with `docker image inspect dejaml/python-cpu:0.1.0 --format '{{.Id}}'` against `lab-images/python-cpu/image-lock.json` or `DEJAML_EXPECTED_IMAGE_ID`;
- the dataset, checked with `npm run verify:lab-image` (observed accuracy 79.88).

## 2. Pre-flight (before every rehearsal and before going on stage)

```bash
npm ci && npm run check
VITE_DEJAML_API=live npm run build --workspace @dejaml/web
docker ps --all --filter label=dejaml.lab          # must be empty
npm run verify:docker --workspace @dejaml/lab-manager
npm start                                          # http://127.0.0.1:8787
```

Confirm the start line reports `recovered 0 interrupted run(s), 0 orphan lab(s)`.

## 3. Rehearse

With the API running, in a second terminal:

```bash
npm run rehearse --workspace @dejaml/api -- --paper artifacts/demo/paper.pdf --runs 3
```

Each rehearsal must print `PASS completed 79.88 different_result … real`. The script applies the demo acceptance test (ARCHITECTURE.md §15): repository discovered from the paper, claim with page evidence, pinned commit, isolated attempt, parsed accuracy, comparison, seed finding, cleanup receipt, complete report, and the case's rehearsal baseline. It also checks that no lab container remains. Reports and `summary.json` are kept under `artifacts/rehearsals/<time>/`. Rehearse again after any change.

## 4. Record the fallback

From a passing rehearsal:

```bash
npm run record-fixture --workspace @dejaml/api -- artifacts/rehearsals/<time>/<runId>.json
npm run build --workspace @dejaml/web
```

This replaces the prepared replay with the real run's events (`fixtures/events/urban-land-cover-success.json` and `.meta.json`) and keeps the report as the labelled prior-run report (`fixtures/reports/urban-land-cover-prior-run.json`). The replay banner then reads "Recorded replay … recorded on <date>. Nothing is executed now." The script refuses a report that fails the acceptance test or used another image. Commit these files.

Also make a screen recording of one full rehearsal in the browser as the backup video.

## 5. On stage

1. Open `http://127.0.0.1:8787`, drop `artifacts/demo/paper.pdf`, and press **Start study**.
2. Narrate Research Team (both analysts in parallel, then the Lead Researcher and the policy gate), Virtual Lab (network off, live output, limits), and Findings (81.66% vs 79.88%, −1.78 pp outside the ±1 pp threshold, the unstated seed hypothesis, "Lab removed").
3. Download the report.

## 6. If something fails

| Symptom | Action |
| --- | --- |
| Model provider error or analysts time out | Press **New study** and retry once. If it fails again, switch to the fallback. |
| GitHub clone fails (network) | Switch to the fallback. |
| Lab stuck | Press **Cancel**; the lab is destroyed. Retry once. |
| API crashed | `npm start` again. It removes orphan labs and marks the interrupted run failed. Retry. |
| Anything else | Use the fallback. |

**Fallback:** stop the API and run `npm run dev --workspace @dejaml/web` (or serve the default `npm run build --workspace @dejaml/web` output). The app replays the recorded run with its banner visible. Say that it is a recorded run. Then show the prior-run report or the backup video.

## 7. Freeze

After the final passing rehearsal, make no feature changes. Only fixes for failures seen in rehearsal are allowed, and each fix is followed by §2 and §3 again.
