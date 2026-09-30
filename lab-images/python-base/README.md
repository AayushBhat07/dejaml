# DéjàML Python lab base images

The lab image for a study is this base image for the approved Python version
(3.10, 3.11, 3.12 or 3.13) on the selected platform (`linux/amd64` or
`linux/arm64`). It is the official `python:<ver>-slim-trixie` image, pinned by
its multi-platform index digest in `bases.lock.json` (which also records the
per-platform manifest digests), plus:

- user and group 10001, and `/workspace/case` owned by them;
- no pip and no ensurepip: labs install a study's wheels offline by running
  pip from the pip wheel in the prepared wheelhouse
  (`python -m venv --without-pip`, then `<venv>/bin/python <pip wheel>/pip install --no-index …`);
- no network tools, and nothing copied from the build context.

Build one image per Python version and platform through `ImageReadiness`
(`pythonBaseImageRequest` in `@dejaml/lab-manager`), which passes
`--platform`, `PYTHON_BASE` and `PYTHON_VERSION` and tags the result
`dejaml/python-base:0.1.0-py<ver>-<os>-<arch>`. By hand:

```bash
docker build --platform linux/amd64 \
  --build-arg PYTHON_BASE=docker.io/library/python:3.11-slim-trixie@sha256:e41613d42d4891e4930f79523f93f81bbc7632584ec65e36ab055f41a800b41e \
  --build-arg PYTHON_VERSION=3.11 \
  --tag dejaml/python-base:0.1.0-py3.11-linux-amd64 lab-images/python-base
```

The digests pin content, so a registry mirror (for example
`mirror.gcr.io/library/python`) serves the same bytes. To refresh the lock, read
the new digests with `docker buildx imagetools inspect python:<ver>-slim-trixie`.

The curated `dejaml/python-cpu` image (`lab-images/python-cpu`) is separate and
unchanged; it is built from the same 3.13 base.
