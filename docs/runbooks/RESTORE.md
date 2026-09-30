# DéjàML Restoration Runbook

Use this runbook after a new clone, interrupted session, machine restart, or regression.

## 1. Establish the source of truth

1. Read `ARCHITECTURE.md`.
2. Read `ROADMAP.md`.
3. Find the latest completed note under `docs/phases/`.
4. Inspect `git status`, the current branch, and recent commits.
5. Do not assume a directory or partially written file means its sub-phase is complete.

## 2. Verify repository integrity

```bash
git status --short
git log --oneline --decorate -10
```

After project tooling exists, also run the root `check` command documented in `README.md`.

## 3. Restore external prerequisites

- Git and GitHub CLI
- supported Node.js runtime
- Python/uv for the curated-case runner
- Docker Desktop or another approved container runtime
- cloud model credentials through server-side secret configuration

Never paste provider credentials into Markdown files, committed environment files, logs, or experiment containers.

## 4. Restore the curated case

Follow `docs/phases/phase-00/subphase-00-01-case-feasibility.md`, then the latest Phase 1 case-package note. Verify the pinned repository commit, dataset digest, deterministic seed, and metric output.

## 5. Restore interrupted runs

- Preserve append-only run events.
- Mark an interrupted active attempt explicitly.
- Clean up any orphan lab before retrying.
- Start a new attempt record; never overwrite an interrupted attempt.

## 6. Verify paper intake

Run `npm run check`, then confirm the paper-intake tests cover a text-readable PDF, invalid input, an oversized upload, and a PDF without extractable text. Paper bytes must be hashed before parsing, and extracted text must retain page numbers for later evidence citations.

## 7. Verify repository acquisition

```bash
npm run build
npm run verify:curated --workspace @dejaml/repository-intake
```

The receipt must report commit `49ece7ff4cc43fd4cb258678d44854f1cb2a417d` and `cleanedUp: true`. A commit mismatch means the curated case or acquisition policy must be reviewed before continuing.

## 8. Restore parallel analysts

Configure a provider for the API process: list its models
(`DEJAML_ANTHROPIC_MODELS`, `DEJAML_OPENAI_MODELS`, or `DEJAML_CUSTOM_BASE_URL`
with `DEJAML_CUSTOM_MODELS`) and pass its `DEJAML_*_API_KEY` through the secret
environment. The legacy `DEJAML_MODEL`, `DEJAML_MODEL_BASE_URL` and
`DEJAML_MODEL_API_KEY` values still work and are mapped onto the OpenAI or
custom provider. The API creates a separate agent, with its own conversation,
for each analyst and lab role. No visitor or operator OpenClaw installation or
agent creation is part of the application path. Run `npm run check` for the
deterministic runtime tests, then exercise the live API in section 13 with the
curated paper.

OpenClaw is not required and not used. The old `verify:curated:live` scripts
and the legacy OpenClaw adapters were removed on 2026-09-30; `npm run
check:native` fails if any OpenClaw or localhost-bridge path returns.

## 9. Restore Lead Researcher and policy gate

1. Verify `cases/urban-land-cover/policy.json` pins the expected repository commit, dataset checksum, trusted adapter checksum, exact argv command, offline resource ceilings, metric rule, and stop conditions.
2. Verify the adapter digest:

```bash
shasum -a 256 cases/urban-land-cover/runner.py
```

Require `276fa3d9b5d4677139c20ab71ceee491b7c849b74278b9a655c122ade8460f6b` unless both the adapter and reviewed policy were deliberately updated together.
3. Run a live study through the API with the curated paper. Require all three
role statuses to be `ready`, `policyApproved: true`, no failed policy checks, a
SHA-256 plan digest, and ordered public events. Confirm the temporary repository
checkout was removed. (The legacy `verify:curated:plan:live` command was
removed on 2026-09-30 with the OpenClaw adapter it used.)

## 10. Restore the Python CPU lab image

1. Start Docker and confirm its Linux engine is healthy.
2. Fetch the already approved dataset if it is absent:

```bash
python3 cases/urban-land-cover/fetch_data.py
```

3. Build and execute the image proof:

```bash
npm run verify:lab-image
```

Require UID/GID `10001:10001`, workdir `/workspace/case`, exact locked dependency versions, network disabled during execution, observed accuracy `79.88`, and no remaining stopped containers.

## 11. Restore the Lab Manager

1. Run `npm run build`.
2. Prove the lifecycle against the real engine:

```bash
npm run verify:docker --workspace @dejaml/lab-manager
```

Require the isolation probe (UID/GID `10001:10001`, network blocked, read-only root and inputs, no Docker socket), timeout, cancellation, memory-limit, live-observation, and orphan-recovery assertions to pass with `remainingLabContainers: 0`.

3. With the lab image and dataset from section 10 present, run:

```bash
npm run verify:curated --workspace @dejaml/lab-manager
```

Require `accuracyPercent: 79.88`, `verdict: different_result`, `signedDifference: -1.78`, and a receipt with `verifiedAbsent: true`. On a platform other than `linux/arm64`, set `DEJAML_EXPECTED_IMAGE_ID` to the locally built image ID.

4. Remove any lab left by a crash with `docker rm --force $(docker ps --all --quiet --filter label=dejaml.lab)`.

## 12. Restore the web app

```bash
npm run dev --workspace @dejaml/web
```

Without a backend the app runs as a labelled example replay. Choose any PDF, start, and require the stepper to reach Findings with a `Different result` verdict at −1.78 pp and a working report download. To use the Run API instead, see section 13.

## 13. Restore the Run API

```bash
npm run build
VITE_DEJAML_API=live npm run build --workspace @dejaml/web
npm run verify:stack --workspace @dejaml/api   # stand-ins for model, GitHub, Docker
```

Open `http://127.0.0.1:8787`, upload the sample paper the command prints, and require Findings `Different result` at −1.78 pp, a server report download, and that a reload mid-run resumes the same study.

For the real local service, with sections 8–11 in place, set the server model
environment and run `npm start` (set `DEJAML_EXPECTED_IMAGE_ID` off
`linux/arm64`), upload the case paper, and require the same verdict with
`cleanup.verifiedAbsent: true` in the report. The service removes orphan labs
and stale checkouts, and marks interrupted runs `failed`, on start. This
loopback API has no authentication and is not ready to expose directly online.

With Docker running, prove the failure paths:

```bash
npm run verify:failures --workspace @dejaml/api
```

Require success, missing metric, crash, cancel, timeout, killed-process recovery, unsupported paper, and non-PDF scenarios to pass with `remainingLabContainers: 0`.

## 14. Demo

Follow [DEMO.md](DEMO.md): cache inputs, pre-flight, rehearse with `npm run rehearse --workspace @dejaml/api`, record the fallback with `npm run record-fixture --workspace @dejaml/api`, and freeze.

## 15. Resume development

Resume only from the first `PENDING`, `IN PROGRESS`, or `REGRESSED` sub-phase in `ROADMAP.md`. When it passes, create or update its phase note before moving on.
