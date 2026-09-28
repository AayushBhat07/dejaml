# DéjàML Run API

Node HTTP service that runs one study end to end and serves the web app from the same origin.

## Run it

```bash
npm run build
VITE_DEJAML_API=live npm run build --workspace @dejaml/web
npm start            # http://127.0.0.1:8787
```

The real service needs the OpenClaw gateway agents (`dejaml-paper`, `dejaml-code`, `dejaml-lead`), Docker with the pinned `dejaml/python-cpu:0.1.0` image, and the case dataset in `cases/urban-land-cover/data/` (see `docs/runbooks/RESTORE.md`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address. |
| `DEJAML_DATA_DIR` | `artifacts/api` | SQLite run store, lab directories, and reports. |
| `DEJAML_EXPECTED_IMAGE_ID` | image lock | Override on a platform other than `linux/arm64`. |
| `OPENCLAW_BIN`, `DEJAML_PAPER_AGENT`, `DEJAML_CODE_AGENT`, `DEJAML_LEAD_AGENT` | `openclaw`, `dejaml-*` | Model gateway. |

To drive the full UI without a model, GitHub, or Docker, run the stand-in stack. It uses the real API, pipeline, policy gate, Lab Manager, and Result Verifier, with scripted stand-ins only for those three services:

```bash
npm run verify:stack --workspace @dejaml/api
```

## Routes

| Method and path | Result |
| --- | --- |
| `POST /api/runs` | Multipart upload with a `paper` field. `202 {runId}`; `413` over 20 MB; `415` not multipart; `409` while another study runs. |
| `GET /api/runs/:id` | Run snapshot. |
| `GET /api/runs/:id/events?after=n` | Server-sent events, replayed from sequence `n` (or `Last-Event-ID`), then live. |
| `POST /api/runs/:id/cancel` | `202` while running, `409` once finished. |
| `GET /api/runs/:id/report` | JSON report download once the study finishes. |
| `GET /*` | Built web app with SPA fallback. |

## Pipeline

`runStudy` in `src/pipeline.ts`: paper intake, repository discovery restricted to reviewed cases, acquisition pinned to the reviewed commit, parallel Paper and Code Analysts, Lead Researcher and the deterministic policy gate, one baseline attempt in a disposable lab with live observation, result verification, and cleanup. Every terminal state (`completed`, `inconclusive`, `cancelled`, `timed_out`, `failed`) emits `run_finished` and writes `reports/<runId>.json`. When a lab was created, its cleanup receipt is in the report.

On start, `recoverAfterRestart` removes orphan labs and marks interrupted runs `failed`. An interrupted attempt is never resumed.

## Tests

```bash
npm test --workspace @dejaml/api
```
