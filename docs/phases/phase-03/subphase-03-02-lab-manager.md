# Sub-phase 3.2 — Lab Manager

**Status:** `DONE`
**Completed:** `2026-09-28`
**Commit:** `40ac7db`
**Owner:** `Claude`

## Objective

Implement the trusted Lab Manager: create, prepare, execute, cancel, artifact-read, and destroy operations with resource limits and cleanup receipts.

## Delivered

- Added `@dejaml/lab-manager` under `services/`, the only component that drives Docker.
- `createLab` verifies the exact local image ID and a non-root image user, rehashes the execution adapter against its reviewed SHA-256, and starts one long-lived container with no network, a read-only root, all capabilities dropped, `no-new-privileges`, `--init`, CPU/memory/PID limits with swap disabled, and a bounded `noexec` `/tmp`.
- Inputs are mounted read-only; only a private host artifact directory is writable.
- `executeAttempt` runs the approved argv with host-enforced wall time, returns a schema-valid `Attempt`, bounded stdout/stderr with truncation flags, duration, and SHA-256 digests of every artifact. An `onOutput` callback exposes live output for Phase 3.3.
- Timeout and cancellation kill the container, terminating the full process tree; the attempt records `timedOut` or `cancelled` and the lab refuses further attempts.
- `readArtifact` exports one regular file from the artifact directory with size limits and a digest. Symlinks, traversal, and other workspace paths are refused.
- `destroyLab` and `withLab` always produce a cleanup receipt that proves the container is absent. `cleanupOrphans` removes labelled containers and lab directories left by a crashed process.
- Every operation emits `lab_engineer` events that `RunStore.appendEvent` accepts.
- `labSpecFromPlan` turns an approved plan into a lab specification.
- Fixed the root `build`, `typecheck`, and `test` scripts to run workspaces in dependency order. `npm run check` previously failed on a fresh clone because `research-runtime` built before `run-store`.

## Files changed

- `services/lab-manager/src/runtime.ts` — Docker CLI runtime, argv only, with bounded capture and abort.
- `services/lab-manager/src/spec.ts` — lab spec schema, path rules, and `labSpecFromPlan`.
- `services/lab-manager/src/manager.ts` — lifecycle operations, events, receipts, orphan cleanup.
- `services/lab-manager/src/*.test.ts` — 14 unit tests against a simulated runtime.
- `services/lab-manager/scripts/verify-docker.mjs` — real Docker lifecycle proof.
- `services/lab-manager/scripts/verify-curated.mjs` — curated experiment through the Lab Manager.
- `services/lab-manager/README.md` — operations, isolation, and verification.
- `scripts/run-workspaces.mjs`, `package.json` — dependency-ordered workspace scripts.
- `docs/decisions/0010-lab-manager-boundary.md` — boundary decision.

## Decisions and deviations

- A lab is one container kept alive with `sleep infinity`; attempts use `docker exec`. This keeps preparation and attempts in the same disposable environment while the host keeps control of timeouts.
- `install` preparation steps are rejected rather than given temporary network access. The curated case needs none, and dependencies belong in the pinned image.
- Artifact size limits are enforced when artifacts are enumerated and read, not by a disk quota during execution.

## Verification

```bash
npm ci
npm run check
npm audit --audit-level=moderate
npm run build
npm run verify:docker --workspace @dejaml/lab-manager
docker ps --all --filter label=dejaml.lab --quiet
git diff --check
```

**Observed result** (Linux amd64 cloud container, Docker 29.3.1, Node 22.22.2):

```text
npm run check: 7 test files across 6 workspaces, 56 tests passed (14 new)
npm audit: 0 vulnerabilities
verify:docker, using a non-root image built from the pinned Python 3.13.15 base:
  isolation probe: uid/gid 10001:10001, network blocked, root read-only,
                   inputs read-only, no Docker socket; exit 0 in 220 ms
  wall-time limit 2 s: timedOut=true, stopped after 2034 ms
  cancellation after 1.5 s: cancelled=true, stopped after 1533 ms
  memory limit 256 MiB: allocation loop killed with exit 137
  orphan lab from a discarded manager: removed, verifiedAbsent=true
  every receipt: containerRemoved, artifactDirectoryRemoved, verifiedAbsent all true
  22 ordered lab_engineer events stored through RunStore
Remaining dejaml.lab containers: 0
```

**Not executed here:** `verify:curated`. The cloud container cannot build `dejaml/python-cpu:0.1.0` (PyPI TLS is intercepted by its proxy) or download the UCI dataset (blocked by network policy). It fails fast with `image_missing`, as designed. Run it on the Phase 3.1 machine to prove the 79.88% result through the Lab Manager.

## Known limitations

- `verify:curated` still needs one run on a machine with the pinned image and dataset.
- Artifact disk use is bounded at read time rather than by a filesystem quota.
- Out-of-memory kills are reported as exit code 137, not as a named memory-limit outcome.
- The image ID in `image-lock.json` is platform specific (`linux/arm64`). Other platforms must rebuild and set `DEJAML_EXPECTED_IMAGE_ID`.
- The Lab Manager keeps lab records in memory. After a backend restart, labs are recovered only through `cleanupOrphans`, never resumed.

## Restore procedure

1. Install Node and Docker with a healthy Linux engine.
2. Run `npm ci` and `npm run check`; require all 56 tests to pass.
3. Run `npm run build` and `npm run verify:docker --workspace @dejaml/lab-manager`; require every assertion to pass and `remainingLabContainers: 0`.
4. With the Phase 3.1 image and dataset present, run `npm run verify:curated --workspace @dejaml/lab-manager` and require `accuracyPercent: 79.88` with a verified receipt.
5. If a lab container survives a crash, run `cleanupOrphans()` or `docker rm --force $(docker ps --all --quiet --filter label=dejaml.lab)`.

## Remaining work

- Turn live output and container telemetry into public events (3.3).
- Extract and compare the metric from the exported artifact (3.4).
- Call `cleanupOrphans` on API startup (5.x).

## Next sub-phase

`3.3 — Live Lab observer`
