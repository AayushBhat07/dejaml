# DéjàML Run API

Node HTTP service that runs one study end to end and serves the web app from the same origin.

## Run it

```bash
npm run build
VITE_DEJAML_API=live npm run build --workspace @dejaml/web
npm start            # http://127.0.0.1:8787
```

The real service needs a server-configured model endpoint, Docker with the
pinned `dejaml/python-cpu:0.1.0` image, and the case dataset in
`cases/urban-land-cover/data/`. Visitors need no local setup.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address. |
| `DEJAML_DATA_DIR` | `artifacts/api` | SQLite run store, lab directories, and reports. |
| `DEJAML_EXPECTED_IMAGE_ID` | image lock | Override on a platform other than `linux/arm64`. |
| `DEJAML_ANTHROPIC_MODELS` / `DEJAML_ANTHROPIC_API_KEY` | `claude-opus-5-5,claude-sonnet-5-5` / unset | Anthropic models the website may offer, and the server key. |
| `DEJAML_OPENAI_MODELS` / `DEJAML_OPENAI_API_KEY` | unset | OpenAI models and the server key. |
| `DEJAML_CHEAPER_INFERENCE_MODELS` / `DEJAML_CHEAPER_INFERENCE_API_KEY` | `claude-sonnet-5.5` / unset | Cheaper Inference, a trusted third-party gateway (see below). `claude-sonnet-5.5` is the only permitted model. |
| `DEJAML_CUSTOM_BASE_URL` / `_MODELS` / `_API_KEY` / `_LABEL` | unset | One administrator-configured OpenAI-compatible endpoint (HTTPS; plain HTTP only for localhost with `DEJAML_CUSTOM_ALLOW_LOCAL_HTTP=1`). |
| `DEJAML_MODEL_PRICES` | unset | JSON price table for cost tracking. No prices are built in. |
| `DEJAML_LAB_AGENT_ENABLED` | enabled | Set to `0` for the original deterministic lab path. |
| `DEJAML_AUTONOMOUS` | enabled | Papers without a reviewed case go to the multi-agent study. Set to `0` to keep them inconclusive. |
| `DEJAML_PLATFORM` / `DEJAML_PYTHON_VERSION` | `auto` / `3.11` | Lab platform (`auto` = the Docker host: Apple Silicon → `linux/arm64`, Intel → `linux/amd64`; or `linux/amd64`, `linux/arm64`, `apple-silicon-dev`, `intel-dev`, `aws-cpu`). |
| `DEJAML_LAB_ENGINEERS` / `DEJAML_MAX_REPLANS` | `1` / `2` | Independent Lab Engineers per study (1 to 3), each in its own offline lab; typed re-plans per study. |
| `DEJAML_STUDY_MAX_MINUTES` / `DEJAML_COMMAND_TIMEOUT_SECONDS` / `DEJAML_LAB_TIMEOUT_SECONDS` | `180` / `900` / `1800` | Study deadline, per-command limit, and lab lifetime. |
| `DEJAML_PREP_ENABLED`, `DEJAML_PREP_IMAGES`, `DEJAML_PREP_PULL`, `DEJAML_PREP_RESOLVER_MODE`, `DEJAML_PREP_MAX_*_MB`, `DEJAML_PREP_MIN_FREE_MB`, `DEJAML_PREP_ALLOWED_HOSTS`, `DEJAML_PREP_CA_BUNDLE` | enabled | The egress-restricted, CPU-only, digest-pinned wheel download zone and its disk bounds. Compatibility constraints come only from `config/compatibility-constraints.txt`. |
| `DEJAML_DATASET_ALLOWED_HOSTS` | empty | Dataset hosts the study may download from over HTTPS. Empty refuses every download. |

`GET /api/health` (loopback clients only) reports the platform and lab image readiness, and for each available
provider its `id`, `kind`, `endpointHost`, `official`, `https` and `route`: `official` (the default
`api.openai.com` / `api.anthropic.com` endpoints), `trusted_gateway` (Cheaper Inference) or `custom` (the custom
endpoint or an overridden OpenAI base URL). It never includes a key. `GET /api/config` lists only provider ids,
labels and allowed models.

### Cheaper Inference

Cheaper Inference (provider id `cheaper_inference`, label "Cheaper Inference") is a trusted third-party
OpenAI-compatible gateway in front of Claude. It is **not** the official Anthropic API, and health reports it as
`route: "trusted_gateway"`, `official: false`. Its endpoint, `https://api.cheaperinference.com/v1`, is fixed in
server code and no setting can change it; requests use the same guarded OpenAI-compatible adapter as the custom
endpoint (public addresses only, no redirects, bounded retries and response sizes). Its key stays on the server.

The owner's catalog check reported its discounted route at about 23.08% discounted pricing with
zero-data-retention **disabled**: prompts and paper content sent through it may be retained by the gateway. Enable
it only for papers you may share with that third party. `apps/api/scripts/accept-real-paper.mjs` accepts it only
on that host over HTTPS with `claude-sonnet-5.5`, and labels such runs "trusted third-party gateway", never a
direct Anthropic run.

To prove the multi-agent study on the real pyts paper against real Docker, GitHub and PyPI with a scripted model (infrastructure only; it is never an acceptance run):

```bash
node apps/api/scripts/verify-study-docker.mjs
```

To drive the full UI without a model, GitHub, or Docker, run the stand-in stack. It uses the real API, pipeline, policy gate, Lab Manager, and Result Verifier, with scripted stand-ins only for those three services:

```bash
npm run verify:stack --workspace @dejaml/api
```

To prove the failure and cleanup paths against a real Docker engine (success, missing metric, crash, cancel, timeout, a killed API process, unsupported paper, non-PDF):

```bash
npm run verify:failures --workspace @dejaml/api
```

## Demo tooling

- `npm run rehearse --workspace @dejaml/api -- --paper <pdf> [--runs 3]` rehearses against a running API and applies the demo acceptance test (`src/acceptance.ts`) to each report. A run counts as real only when it used the expected lab image.
- `npm run record-fixture --workspace @dejaml/api -- <report.json>` turns a passing real report into the web app's recorded replay and keeps it as the prior-run report.

See `docs/runbooks/DEMO.md`.

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

On start, `recoverAfterRestart` removes orphan labs and stale checkout folders, and marks interrupted runs `failed`. An interrupted attempt is never resumed.

## Tests

```bash
npm test --workspace @dejaml/api
```
