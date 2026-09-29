# ADR 0013 — Web Shell and Labelled Replay

**Status:** Accepted
**Date:** 2026-09-28

## Context

Phase 4 builds the interface before the Run API exists (Phase 5.1). The screens need realistic events to develop against, but the architecture forbids presenting anything as a live experiment when it is not one.

## Decision

- Build `apps/web` with React 19 and Vite, with no UI framework. The visual system is a set of CSS custom properties with light and dark values and a few shared classes.
- The app depends only on the `RunClient` interface. `HttpRunClient` implements the Run API from ARCHITECTURE.md §6.2, with SSE replay from the last sequence. `ReplayRunClient` replays the committed event fixture.
- Replay is the default until the API exists. While it is active, a persistent banner states that the run is a recorded replay and that nothing is executed. `VITE_DEJAML_API=live` switches to the API.
- The browser checks the file quickly (size, PDF header) and shows a SHA-256 fingerprint, but all authoritative validation stays on the server.
- Every incoming event is validated with the shared `RunEventSchema`.

## Consequences

- Phases 4.2 and 4.3 can build their screens against the same event stream the API will serve.
- The replay fixture must be kept consistent with real event types as they evolve.
