# DéjàML Lab Manager

The Lab Manager is the only trusted component that talks to the container engine. It turns an approved `ExperimentPlan` into one disposable, offline CPU lab, runs bounded attempts inside it, exports hashed artifacts, and always leaves a verified cleanup receipt.

## Operations

| Operation | Behavior |
| --- | --- |
| `createLab(spec)` | Verifies the pinned image ID and non-root user, rehashes digest-pinned inputs, creates and starts an isolated container. |
| `prepareLab(labId, steps)` | Records preparation steps and runs any command steps offline. `install` steps are rejected. |
| `executeAttempt(labId, request)` | Runs one argv command with host-enforced wall time, bounded logs, optional live output callback, and artifact digests. Returns a schema-valid `Attempt`. |
| `readArtifact(labId, path)` | Exports one regular file from the artifact directory with size limits and SHA-256. Symlinks and paths outside the directory are refused. |
| `cancelLab(labId)` | Kills the lab's process tree if an attempt is running. |
| `destroyLab(labId, reason)` | Removes the container and host lab directory, then proves absence. Idempotent. |
| `withLab(spec, work)` | Creates a lab, runs `work`, and destroys the lab in every outcome. |
| `cleanupOrphans()` | Removes labelled lab containers and lab directories this process does not own. |

`labSpecFromPlan` maps an approved plan to a lab: the DéjàML execution adapter and dataset files are mounted read-only from the curated case directory, and the metric artifact's directory is the only writable path.

## Live observation

Pass `observe: true` (or options) to `executeAttempt` to publish events while the attempt runs:

- `lab_output`: sanitized stdout/stderr lines in batches, with a per-attempt character budget;
- `lab_telemetry`: CPU %, memory, PIDs, and elapsed time from a streaming `docker stats`;
- `artifact_changed`: created or resized artifact files.

Terminal control sequences are stripped, so output is safe to render as plain text. There is no virtual desktop; see ADR 0011.

## Isolation

Every lab runs with `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, `--init`, CPU, memory (swap disabled), and PID limits, and a bounded `noexec` `/tmp`. No Docker socket, host home directory, credential, or repository checkout is mounted. Events use the `lab_engineer` role and can be passed straight to `RunStore.appendEvent`.

## Verification

```bash
npm run check

# Real Docker lifecycle proof: isolation probes, success, timeout,
# cancellation, memory limit, live observation, orphan recovery.
npm run build
npm run verify:docker --workspace @dejaml/lab-manager

# Curated experiment through the Lab Manager. Requires the built
# dejaml/python-cpu:0.1.0 image and the fetched dataset.
npm run verify:lab-image
npm run verify:curated --workspace @dejaml/lab-manager
```

`verify:curated` expects the image ID in `lab-images/python-cpu/image-lock.json`, which was recorded on `linux/arm64`. On another platform, rebuild the image and set `DEJAML_EXPECTED_IMAGE_ID` to the locally built ID.
