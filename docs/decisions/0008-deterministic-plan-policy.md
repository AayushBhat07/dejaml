# ADR 0008 — Deterministic Experiment Plan Policy

**Status:** Accepted  
**Date:** 2026-09-28

## Context

Lead Researcher must reconcile probabilistic model outputs into one experiment proposal. A model cannot safely approve its own generated command, resource requests, dataset, or metric rule. The curated notebook also needs a small DéjàML-owned adapter to produce deterministic machine-readable output; that adapter is not part of the paper repository.

## Decision

Treat Lead Researcher output as an untrusted proposal. Validate it in ordinary TypeScript against a committed, schema-validated case policy before any lab is created.

The policy pins:

- case ID, repository URL, full commit, and approved repository entry point;
- paper claim identity and reported metric;
- dataset URL, SHA-256, and expected paths;
- exact preparation list, argv command, working directory, and environment;
- CPU, RAM, process, wall-time, and offline-execution ceilings;
- exact metric artifact and extraction key;
- maximum attempts and required/allowed stop conditions;
- the DéjàML-owned execution adapter path and SHA-256.

The gate emits per-check public results and a canonical plan SHA-256 only when every check passes. Any widening, mismatch, or missing evidence ends the run as `Inconclusive`.

## Adapter provenance

The Code Analyst maps repository logic; it does not claim the project-owned `runner.py` exists in the repository. The reviewed policy separately identifies that adapter as control-plane code. A future Lab Manager must verify its checksum before copying it into the disposable lab.

## Consequences

- The model can explain and reconcile evidence but cannot authorize execution.
- A malicious or mistaken generated command cannot bypass the exact allowlist.
- Adapter provenance is honest and independently verifiable.
- Supporting a new paper for execution requires a reviewed case policy; unsupported papers may still be analyzed but stop as `Inconclusive`.
