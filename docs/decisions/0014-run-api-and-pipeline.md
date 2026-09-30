# ADR 0014 — Run API and Study Pipeline

**Status:** Accepted
**Date:** 2026-09-28

> **Note (2026-09-30):** OpenClaw is not required and not used. The real end-to-end run needs no OpenClaw agents. DéjàML runs its own native agents (`packages/agent-runtime`) and reaches OpenAI or Anthropic through its own provider adapters; the OpenClaw adapters and scripts referenced below were removed. This historical note is otherwise unchanged.

## Context

Phases 1 to 4 built each stage and the interface separately. Phase 5.1 connects an uploaded PDF to every stage and serves the result to the web app.

## Decision

- `apps/api` uses `node:http` with no web framework. Multipart uploads are parsed with the platform `Request.formData()` after a bounded body read.
- One study runs at a time. A second upload gets `409` (ARCHITECTURE.md §17: no parallel labs).
- Only a repository that matches a reviewed case in `cases/` may proceed, and only at its reviewed commit. Anything else ends as `inconclusive` without a lab.
- The pipeline creates the lab itself and destroys it in a `finally` block, so every outcome after lab creation has a cleanup receipt. Cancelling aborts one `AbortSignal` shared by the analysts, the Lead Researcher, and the running attempt.
- Events stream over SSE from the run store. The stream subscribes before replaying and drops duplicates by sequence, so a reconnect with `after` or `Last-Event-ID` loses nothing.
- Every terminal state writes a JSON report under the data directory. The web app links to it in live mode.
- On start, orphan labs are removed and interrupted runs are marked `failed`, never resumed.
- The web app stores the live run ID in `?run=` so a refresh resumes the same study.
- Stand-ins for the model, GitHub, and Docker live in `src/stand-ins.ts` and are used only by tests and `verify:stack`. They are never wired into `main.ts`.

## Consequences

- The whole flow can be tested in CI and the cloud without external services, and the tests run the same code as production except for those three boundaries.
- The real end-to-end run depends on the OpenClaw agents, the pinned image, and the dataset, which exist only on the development Mac.
