# DéjàML Python CPU lab image

This image supplies only the reviewed Python runtime and CPU dependencies for the curated case. It contains no paper, repository checkout, dataset, runner, credentials, Docker client, Python package installer, Perl runtime, shell wrapper, or network configuration.

The patched Python 3.13.15 slim-trixie base is pinned by multi-platform registry digest. Python dependencies are version- and hash-pinned in `requirements.lock.txt`. The process runs as UID/GID `10001:10001` with `/workspace/case` as its working directory.

Build and verify from the repository root:

```bash
node lab-images/python-cpu/verify.mjs
```

The verifier builds `dejaml/python-cpu:0.1.0`, checks image metadata and dependency versions, then executes the curated runner with a read-only root filesystem, no network, no Linux capabilities, `no-new-privileges`, and bounded CPU, memory, and process counts. It writes the result only to a temporary host directory and removes that directory afterward.
