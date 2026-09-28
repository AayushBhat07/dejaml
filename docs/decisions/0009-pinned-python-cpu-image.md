# ADR 0009 — Pinned Python CPU Lab Image

**Status:** Accepted
**Date:** 2026-09-28

## Context

The approved experiment must not run in the host Python environment. The runtime needs compatible scientific Python wheels while excluding the paper, repository, dataset, credentials, Docker control socket, and orchestration tools from the image.

## Decision

Use a dedicated `dejaml/python-cpu:0.1.0` image built from the current patched official Python `3.13.15-slim-trixie` multi-platform digest. Pin the Dockerfile frontend by digest and pin every direct and transitive Python dependency by version and distribution hash.

The image contains dependencies only. It runs as UID/GID `10001:10001`, uses `/workspace/case`, and has no privileged entrypoint. At execution time, the trusted Lab Manager must add the reviewed runner and dataset as read-only mounts and a distinct writable artifact target.

After dependency installation, the image removes pip, ensurepip, their vendored packages, and the unused Perl runtime. Docker Scout then reports zero critical findings and one high zlib finding for which the scanner lists no fixed Debian trixie package. The remaining exposure is documented and reduced by offline execution, a read-only root, dropped capabilities, and the absence of an inbound service.

The required runtime policy is:

- no network during the experiment;
- read-only root filesystem;
- all Linux capabilities dropped;
- `no-new-privileges` enabled;
- CPU, memory, process, and wall-time limits enforced by the host;
- no Docker socket, host workspace, credentials, or agent runtime mounted;
- explicit cleanup after every terminal outcome.

## Consequences

- Dependency installation happens at image-build time, not while running untrusted experiment code.
- The exact locally verified image ID is recorded in the Phase 3.1 note; a distributable immutable image digest will require publishing the image to a registry, which this phase intentionally does not do.
- Local proof builds disable nondeterministic BuildKit provenance attestations so repeated builds of the same pinned inputs retain a stable platform-image ID.
- Container lifecycle, cancellation, artifact extraction, and cleanup receipts remain the responsibility of Phase 3.2.
- A newly fixed zlib package should trigger a reviewed base-image repin and rebuild.
