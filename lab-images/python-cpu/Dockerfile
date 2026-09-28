# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b

LABEL org.opencontainers.image.title="DéjàML Python CPU Lab" \
      org.opencontainers.image.description="Minimal non-root runtime for the curated CPU reproduction case" \
      org.opencontainers.image.source="https://github.com/AayushBhat07/dejaml" \
      org.opencontainers.image.version="0.1.0"

ENV HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    MKL_NUM_THREADS=2

RUN groupadd --gid 10001 dejaml \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dejaml \
    && install --directory --owner=10001 --group=10001 --mode=0750 /workspace/case

COPY lab-images/python-cpu/requirements.lock.txt /tmp/requirements.lock.txt
RUN python -m pip install --only-binary=:all: --require-hashes -r /tmp/requirements.lock.txt \
    && python -m pip check \
    && rm /tmp/requirements.lock.txt \
    && rm -rf /usr/local/lib/python3.13/site-packages/pip \
              /usr/local/lib/python3.13/site-packages/pip-*.dist-info \
              /usr/local/lib/python3.13/ensurepip \
              /usr/local/bin/pip \
              /usr/local/bin/pip3 \
              /usr/local/bin/pip3.13 \
    && apt-get purge -y --allow-remove-essential perl-base \
    && rm -rf /var/lib/apt/lists/*

USER 10001:10001
WORKDIR /workspace/case

CMD ["python", "--version"]
