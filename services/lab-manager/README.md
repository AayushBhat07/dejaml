# DéjàML Lab Manager

The Lab Manager is the only trusted component that talks to the container engine. It turns an approved `ExperimentPlan` into one disposable, offline CPU lab, runs bounded attempts inside it, exports hashed artifacts, and always leaves a verified cleanup receipt.

## Operations

| Operation | Behavior |
| --- | --- |
| `createLab(spec)` | Waits for any in-flight preparation of the image, verifies the pinned image ID, non-root user, the spec's `platform` and an allowlisted image environment, rehashes digest-pinned inputs, creates the container with `--platform` and `--pull never`, audits its effective configuration, then starts it. The handle records `platform`, `imageId` and `imageDigest`. |
| `prepareLab(labId, steps)` | Records preparation steps and runs any command steps offline. `install` steps are rejected. |
| `executeAttempt(labId, request)` | Runs one argv command with host-enforced wall time, bounded logs, optional live output callback, and artifact digests. Returns a schema-valid `Attempt`. |
| `readArtifact(labId, path)` | Exports one regular file from the artifact directory with size limits and SHA-256. Symlinks and paths outside the directory are refused. |
| `cancelLab(labId)` | Kills the lab's process tree if an attempt is running. |
| `destroyLab(labId, reason)` | Removes the container and host lab directory, then proves absence. Idempotent. The receipt records the platform and image ID/digest. |
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

Every lab is created for exactly the `platform` in its spec (`linux/amd64` or `linux/arm64`), from a local image whose ID, user, platform and environment were checked first; a lab never pulls. Before the container starts, its effective configuration is read back and refused (`lab_not_sealed`) unless it is sealed:

- `--network none` (so no DNS, no internet, and no cloud metadata endpoint): no device but loopback can carry traffic (see "Network isolation check");
- `--read-only` root, `--cap-drop ALL`, `no-new-privileges`, not privileged, a non-root user, `--init`;
- CPU, memory (swap disabled) and PID limits; a `noexec` `/tmp` tmpfs sized by `limits.tmpfsMb` (default 64 MB);
- inputs (repository, dataset, wheelhouse) mounted read-only; one fresh writable artifact directory (plus an optional scratch directory); the Docker socket, `/proc`, `/sys`, `/dev`, `/run`, `/etc` and credential directories (`~/.aws`, `~/.docker`, `~/.ssh`, …) can never be mounted, nor any directory containing them;
- an environment made only of `LAB_ENV_ALLOWLIST` names from the image: the manager passes no host variables, the Docker CLI itself runs with a minimal environment, and commands may not set credential-like variables (`*_TOKEN`, `*_API_KEY`, `AWS_*`, `DEJAML_*`, …);
- a per-command time limit, and an overall lab lifetime (`limits.labTimeoutSeconds`, default 6 h) after which the lab is killed;
- bounded stdout/stderr capture, and guaranteed cleanup with a verified receipt.

Events use the `lab_engineer` role and can be passed straight to `RunStore.appendEvent`.

### Network isolation check

`verify:docker` proves isolation from inside the lab and from the engine, not by one exact `/sys/class/net` listing. Docker Desktop (macOS, Windows) runs containers in a LinuxKit VM whose kernel has the IP tunnel drivers built in, and such a kernel creates their fallback devices (`tunl0`, `ip6tnl0`, `sit0`, `gre0`, `gretap0`, `erspan0`, `ip6gre0`, `ip_vti0`, `ip6_vti0`) in every new network namespace, including a `--network none` one. They are down, have no address and no route, and cannot carry a packet; Docker Engine on most Linux hosts shows only `lo`. `evaluateNetworkIsolation` (with the in-lab observer `NETWORK_OBSERVER_PY`) therefore accepts, besides `lo` (loopback addresses only, no IPv4 main-table route), only those fallback devices, and only when each is down (no `IFF_UP`, `IFF_RUNNING` or `IFF_LOWER_UP`, operstate `down`), unaddressed and unrouted. Any other device, or any non-loopback device that is up, addressed or routed, fails. The proof also requires `NetworkMode none` with the `none` network as the only attachment (no address or gateway), no exposed or published port, no host PID/IPC/UTS namespace, a network namespace different from the engine's (read by a `--network host` helper), blocked IPv4 and IPv6 connections, failing DNS and an unreachable metadata endpoint, and it runs the same rule on a bridge-attached helper as a negative control.

## Image readiness

`ImageReadiness` makes a lab image ready deterministically: inspect first (by immutable image ID, for the requested platform), pull only a digest-pinned reference with `--platform` (bounded retries with backoff), or build with `--platform` from a digest-pinned base, then re-inspect and verify platform and expected ID. Stale IDs, wrong platforms, missing images, failed pulls or builds, timeouts and cancellation fail with a typed `ImageNotReadyError`; nothing falls back to another image. Concurrent `ensure` calls for one key and platform share one preparation, `status()` reports readiness for health diagnostics, and a `LabManager` given `images` waits for an in-flight preparation before creating a lab. `pythonBaseImageRequest` describes the lab image for a study: `lab-images/python-base` for the approved Python version on the selected platform. The curated `dejaml/python-cpu` image is unchanged.

## Verification

```bash
npm run check

# Real Docker lifecycle proof: every sealed-lab property, platform checks,
# success, per-command and lab timeouts, cancellation, memory limit,
# bounded output, live observation, orphan recovery.
npm run build
npm run verify:docker --workspace @dejaml/lab-manager

# Real Docker image readiness: pinned pulls for both platforms, the lab base
# image build, dedup under concurrency, typed failures. Cleans up after itself.
npm run verify:images --workspace @dejaml/lab-manager

# Curated experiment through the Lab Manager. Requires the built
# dejaml/python-cpu:0.1.0 image and the fetched dataset.
npm run verify:lab-image
npm run verify:curated --workspace @dejaml/lab-manager
```

The lab platform is `DEJAML_PLATFORM` (default: this host's architecture). `verify:curated` expects the image ID in `lab-images/python-cpu/image-lock.json`, which records the platform it was verified on; on any other platform it stops unless `DEJAML_EXPECTED_IMAGE_ID` names the locally rebuilt ID.
