# DéjàML lab base image: the official CPython slim (Debian trixie) image for one
# Python version, pinned by digest, with the non-root lab user and no pip.
#
# Build arguments (see bases.lock.json; ImageReadiness passes both):
#   PYTHON_BASE     python:<ver>-slim-trixie@sha256:<multi-platform index digest>
#   PYTHON_VERSION  the CPython minor version the base must contain, such as 3.11
#
# Build for one platform at a time with `docker build --platform linux/amd64|linux/arm64`.
# Labs install a study's dependencies offline from a prepared wheelhouse by
# running pip from the pip wheel in that wheelhouse
# (`python -m venv --without-pip` then `<venv>/bin/python <pip wheel>/pip install --no-index ...`),
# so the image itself needs neither pip nor ensurepip, and no network tools.
ARG PYTHON_BASE
FROM ${PYTHON_BASE}

ARG PYTHON_VERSION

LABEL org.opencontainers.image.title="DéjàML Python lab base" \
      org.opencontainers.image.description="Minimal non-root CPython runtime for offline DéjàML labs" \
      org.opencontainers.image.source="https://github.com/AayushBhat07/dejaml" \
      org.opencontainers.image.version="0.1.0" \
      dejaml.python-version="${PYTHON_VERSION}"

ENV HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_NO_INDEX=1

RUN set -eu; \
    test -n "${PYTHON_VERSION}"; \
    actual="$(python -c 'import sys; print("%d.%d" % sys.version_info[:2])')"; \
    if [ "${actual}" != "${PYTHON_VERSION}" ]; then echo "base has Python ${actual}, expected ${PYTHON_VERSION}" >&2; exit 1; fi; \
    groupadd --gid 10001 dejaml; \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dejaml; \
    install --directory --owner=10001 --group=10001 --mode=0750 /workspace/case; \
    purelib="$(python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"; \
    stdlib="$(python -c 'import sysconfig; print(sysconfig.get_paths()["stdlib"])')"; \
    rm -rf "${purelib}"/pip "${purelib}"/pip-*.dist-info "${stdlib}/ensurepip" \
           /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.*; \
    if python -c 'import pip' 2>/dev/null; then echo "pip is still importable" >&2; exit 1; fi; \
    python -c 'import venv'; \
    rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

USER 10001:10001
WORKDIR /workspace/case

CMD ["python", "--version"]
