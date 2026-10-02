# Sub-phase 3.1 — Python CPU Image

**Status:** `DONE`
**Completed:** `2026-09-28`
**Commit:** `dc17654`
**Owner:** `Codex`

> **Note (2026-09-30):** OpenClaw is not required and not used. The `OPENCLAW_BIN` check mentioned below no longer exists. DéjàML runs its own native agents (`packages/agent-runtime`) and reaches OpenAI or Anthropic through its own provider adapters; the OpenClaw adapters and scripts referenced below were removed. This historical note is otherwise unchanged.

## Objective

Build and prove a minimal, pinned, non-root Python image capable of running the approved Urban Land Cover experiment under the planned isolation controls.

## Delivered

- Added `dejaml/python-cpu:0.1.0` from a digest-pinned official Python 3.13.15 slim-trixie base.
- Pinned the Dockerfile frontend and all direct/transitive Python packages by SHA-256.
- Added a non-root UID/GID `10001:10001` and fixed `/workspace/case` working directory.
- Kept runner code, data, repository contents, credentials, Docker tooling, and orchestration tooling out of the image.
- Added an image verifier that builds the image, checks metadata and dependency versions, and runs the real curated experiment under offline, read-only, capability-dropped resource limits.
- Restricted the Docker build context to the dependency lock file.
- Added a fail-fast error for an empty `OPENCLAW_BIN` path after the prior runtime regression.

## Verification

```bash
npm run verify:lab-image
npm run check
npm audit --audit-level=moderate
docker scout cves --only-severity critical,high local://dejaml/python-cpu:0.1.0
git diff --check
```

**Observed image proof:**

```text
Image: dejaml/python-cpu:0.1.0
Verified image ID: sha256:630cac03bfdbd7207c225148a3a0e26a92b0ed3af1063a76e5a1794a373e9920
Platform: linux/arm64
User: 10001:10001
Working directory: /workspace/case
Network during run: disabled
Observed accuracy: 79.88%
Python: 3.13.15
NumPy: 2.5.3
Pandas: 3.0.6
SciPy: 1.18.1
scikit-learn: 1.9.1
Stopped containers remaining: 0
Docker Scout: 0 critical, 1 high (zlib; no fixed version listed)
```

## Security outcome

- The experiment ran with `--network none`, `--read-only`, `--cap-drop ALL`, and `no-new-privileges`.
- CPU, RAM, and process limits matched the approved case ceiling.
- Runner and dataset mounts were read-only; only a fresh temporary artifact directory was writable.
- The temporary artifact directory was removed in a `finally` path.
- Docker build history contained no private credential material. The official Python base exposes its public package-signing GPG key, which is not a secret.
- The initially selected September 2025 base was rejected after scanning found 5 critical and 46 high findings. The image was moved to the current patched trixie base, then pip/ensurepip and unused Perl were removed. The final scan found 0 critical and 1 high zlib advisory with no fixed Debian package listed.

## Known limitations

- The image is verified and pinned locally; it is not published to a container registry.
- The verifier is a Phase 3.1 proof harness, not the production Lab Manager.
- Wall-clock timeout, cancellation, log streaming, artifact size limits, cleanup receipts, and orphan recovery belong to Phase 3.2.
- The current proof was performed on `linux/arm64` through Docker Desktop on Apple Silicon.
- The final scanner still reports one high zlib advisory with no fixed version. The lab is offline, has no inbound service, and runs with a read-only root and dropped capabilities; repin immediately when Debian publishes a fix.

## Restore procedure

1. Install Docker with a healthy Linux engine.
2. Ensure the curated dataset exists by running `python3 cases/urban-land-cover/fetch_data.py`.
3. Run `npm run verify:lab-image`.
4. Require the non-root metadata, exact dependency versions, `79.88%` result, and no stopped containers.
5. If any pinned dependency changes, regenerate the hash lock, review the change, and rerun the complete proof.

## Remaining work

- Implement the trusted Lab Manager lifecycle and stable image identity check.
- Enforce wall timeout and cancellation from the host.
- Bound logs and artifacts and emit cleanup receipts.
- Add telemetry and the read-only live lab observer.

## Next sub-phase

`3.2 — Lab Manager`
