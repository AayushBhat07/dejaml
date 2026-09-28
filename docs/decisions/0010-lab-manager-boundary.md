# ADR 0010 — Lab Manager Container Boundary

**Status:** Accepted
**Date:** 2026-09-28

## Context

Phase 3.1 proved that the pinned image can run the curated experiment offline, but the proof harness built its own `docker run` command and had no wall-time limit, cancellation, bounded logs, artifact limits, or cleanup receipt. Only one trusted component may talk to the container engine, and every terminal outcome must leave a verifiable cleanup record.

## Decision

Add `@dejaml/lab-manager` under `services/` as the only code that drives Docker. It exposes `createLab`, `prepareLab`, `executeAttempt`, `readArtifact`, `cancelLab`, `destroyLab`, `withLab`, and `cleanupOrphans`.

- The Docker CLI is invoked with argv arrays through a `ContainerRuntime` interface. No shell is used, and the child process receives only `PATH`, `HOME`, and Docker connection variables.
- `createLab` refuses to start unless the local image ID equals the expected pinned ID and the image declares a non-root user. Digest-pinned inputs, such as the DéjàML execution adapter, are rehashed before mounting.
- A lab is one long-lived container (`sleep infinity` under `--init`) with `--network none`, a read-only root, `--cap-drop ALL`, `no-new-privileges`, CPU/memory/swap/PID limits, a bounded `noexec` `/tmp`, read-only input binds, and one writable artifact bind in a private host directory.
- Attempts run through `docker exec` with the approved argv, working directory, and allowlisted environment. Loader and interpreter-path variables are refused.
- The host enforces wall time. Timeout and cancellation kill the whole container, which terminates the process tree; the lab then accepts artifact reads and destruction but no further attempts.
- Logs are captured up to a byte limit with a truncation flag. Artifacts are enumerated without following symlinks, bounded by file count, per-file bytes, and total bytes, and exported with SHA-256 digests.
- Containers are labelled `dejaml.lab` and `dejaml.run`. `destroyLab` removes the container and host directory, then re-queries Docker to prove absence. `cleanupOrphans` applies the same procedure to labelled containers and lab directories not owned by the current process.
- Every operation emits `lab_engineer` events shaped for `RunStore.appendEvent`.

## Consequences

- Preparation steps of kind `install` are rejected, because labs never receive network access after creation. Dependencies belong in the pinned image.
- Artifact disk usage is bounded when artifacts are read, not while the experiment writes them. The memory and PID limits and the short wall time bound the damage in the meantime.
- An out-of-memory kill appears as exit code 137. It is reported as a failed attempt but is not yet labelled as a memory-limit event.
- Live output streaming is available through an `onOutput` callback; turning it into public events and telemetry belongs to Phase 3.3.
