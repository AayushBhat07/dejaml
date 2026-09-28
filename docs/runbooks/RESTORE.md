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

1. Install OpenClaw `2026.9.5` or review and re-pin the adapter against a newer version.
2. Create dedicated agents `dejaml-paper`, `dejaml-code`, and `dejaml-lead` with separate workspaces and no channel bindings.
3. Configure all three with the chosen model/runtime and `tools: { profile: "minimal", allow: ["session_status"] }`.
4. Confirm the operator's general-purpose agent is not used by DéjàML.
5. Run:

```bash
OPENCLAW_BIN=/absolute/path/to/openclaw \
  npm run verify:curated:live --workspace @dejaml/research-runtime
```

Require `paperStatus: ready`, `codeStatus: ready`, the Random Forest 81.66% claim, the notebook entry point, two started events before the two completed events, and final run state `planning`.

## 9. Restore Lead Researcher and policy gate

1. Verify `cases/urban-land-cover/policy.json` pins the expected repository commit, dataset checksum, trusted adapter checksum, exact argv command, offline resource ceilings, metric rule, and stop conditions.
2. Verify the adapter digest:

```bash
shasum -a 256 cases/urban-land-cover/runner.py
```

Require `276fa3d9b5d4677139c20ab71ceee491b7c849b74278b9a655c122ade8460f6b` unless both the adapter and reviewed policy were deliberately updated together.
3. Run:

```bash
OPENCLAW_BIN=/absolute/path/to/openclaw \
  npm run verify:curated:plan:live --workspace @dejaml/research-runtime
```

Require all three role statuses to be `ready`, `policyApproved: true`, no failed policy checks, a SHA-256 plan digest, final state `preparing_lab`, and eight ordered public events. Confirm the temporary repository checkout was removed.

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

Without a backend the app runs as a labelled example replay. Choose any PDF, start, and require the stepper to reach Findings with a `Different result` verdict at −1.78 pp and a working report download. Set `VITE_DEJAML_API=live` once the Run API exists.

## 13. Resume development

Resume only from the first `PENDING`, `IN PROGRESS`, or `REGRESSED` sub-phase in `ROADMAP.md`. When it passes, create or update its phase note before moving on.
