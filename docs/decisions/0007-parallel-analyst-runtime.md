# ADR 0007 — Parallel Analyst Runtime

**Status:** Accepted  
**Date:** 2026-09-28

## Context

Paper analysis and repository analysis are independent until reconciliation. The demo must show both working at the same time without granting a model general host, repository, browser, messaging, or execution access. The operator's available OpenAI credential is an OAuth profile intentionally unavailable to isolated `agent exec` temporary state.

## Decision

Use two dedicated OpenClaw Gateway agents for the OAuth-backed local demo:

- `dejaml-paper` with product identity `Paper Analyst`;
- `dejaml-code` with product identity `Code Analyst`.

Each agent has a separate workspace, no channel binding, a distinct per-run session key, and only the `session_status` tool. The orchestrator starts both model requests before awaiting either. Product events expose research roles and public evidence, never OpenClaw branding or chain-of-thought.

For API-key or local providers, retain a second adapter using the isolated `openclaw agent exec --json` contract. Both adapters implement the same `StructuredModelClient` interface.

## Evidence boundary

- Paper evidence is page-anchored and character bounded.
- Repository evidence is file/hash anchored and character bounded.
- Symlinks, credential-like files, datasets, generated output folders, and binaries are omitted.
- Notebook outputs are removed before transmission; larger notebook containers may be read only within a 10 MiB raw bound.
- Common token formats are redacted.
- Model JSON is schema validated and cross-checked against deterministic source facts.

## OpenClaw integration boundary

The demo pins the installed OpenClaw CLI contract at version `2026.9.5` (`ec9c1a1`). No upstream source is copied into this repository. This is a deliberate overnight-demo deviation from the PRD's possible source-extraction path: the maintained CLI boundary is smaller and was live-proven, while source extraction and vendoring would require a separate dependency/license review.

## Consequences

- Judges can see honest parallel role events.
- OAuth credentials stay in OpenClaw's store and never enter DéjàML prompts, logs, repository checkouts, or workspace files.
- A provider or schema failure is isolated to its analyst lane and the run ends explicitly rather than fabricating the missing result.
- Restoring the demo requires recreating the two dedicated agent entries or selecting the isolated API-key/local adapter.
