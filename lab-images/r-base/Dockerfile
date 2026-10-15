# DéjàML R lab base image: rocker/r-ver (Ubuntu 24.04) for one R version,
# pinned by digest, with the non-root lab user and Python 3 for the lab's own
# tools (file listing, integrity checks, the repository copy).
#
# Build arguments (see bases.lock.json; ImageReadiness passes all three):
#   R_BASE           docker.io/rocker/r-ver:<ver>@sha256:<multi-platform index digest>
#   R_VERSION_MINOR  the R minor version the base must contain, such as 4.5
#   APT_SNAPSHOT     the Ubuntu archive snapshot Python comes from, such as 20260901T000000Z
#
# Build for one platform at a time with `docker build --platform linux/amd64|linux/arm64`.
# A study's CRAN packages are prepared outside the lab as prebuilt binaries
# and mounted read-only at /workspace/case/rlib, so the image needs no network
# tools and the lab never installs or compiles anything.
ARG R_BASE
FROM ${R_BASE}

ARG R_VERSION_MINOR
ARG APT_SNAPSHOT

LABEL org.opencontainers.image.title="DéjàML R lab base" \
      org.opencontainers.image.description="Minimal non-root R runtime for offline DéjàML labs" \
      org.opencontainers.image.source="https://github.com/AayushBhat07/dejaml" \
      org.opencontainers.image.version="0.1.0" \
      dejaml.r-version="${R_VERSION_MINOR}"

ENV HOME=/tmp \
    R_LIBS_SITE=/workspace/case/rlib:/usr/local/lib/R/site-library \
    R_LIBS_USER=/workspace/case/rlib \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1

RUN set -eu; \
    test -n "${R_VERSION_MINOR}"; \
    test -n "${APT_SNAPSHOT}"; \
    actual="$(Rscript -e 'cat(R.version$major, strsplit(R.version$minor, ".", fixed = TRUE)[[1]][1], sep = ".")')"; \
    if [ "${actual}" != "${R_VERSION_MINOR}" ]; then echo "base has R ${actual}, expected ${R_VERSION_MINOR}" >&2; exit 1; fi; \
    apt-get -o APT::Snapshot="${APT_SNAPSHOT}" update; \
    DEBIAN_FRONTEND=noninteractive apt-get -o APT::Snapshot="${APT_SNAPSHOT}" install -y --no-install-recommends python3 python-is-python3; \
    python -c 'import hashlib, json, os, shutil, sys; assert sys.version_info[:2] == (3, 12), sys.version'; \
    if python -c 'import pip' 2>/dev/null; then echo "pip is importable" >&2; exit 1; fi; \
    groupadd --gid 10001 dejaml; \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dejaml; \
    install --directory --owner=10001 --group=10001 --mode=0750 /workspace/case; \
    rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

USER 10001:10001
WORKDIR /workspace/case

CMD ["Rscript", "--version"]
