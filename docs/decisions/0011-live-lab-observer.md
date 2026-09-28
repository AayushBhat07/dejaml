# ADR 0011 — Live Lab Observer Events

**Status:** Accepted
**Date:** 2026-09-28

## Context

ADR 0005 commits DéjàML to an honest live lab view: real terminal output, resource use, and artifact changes, with a virtual desktop only for experiments that genuinely use a GUI. The Lab Manager (ADR 0010) already captures bounded logs, but only returns them when an attempt ends.

## Decision

Observation is an opt-in mode of `executeAttempt` (`observe: true` or options). While the attempt runs, the Lab Manager publishes three `lab_engineer` event types through the same sink as every other lab event:

- `lab_output` carries complete lines, batched per stream at a fixed interval. Lines are treated as untrusted display text: ANSI and other control sequences are removed, carriage-return progress bars collapse to their last frame, long lines are cut, and runaway lines without newlines are split. A per-attempt character budget caps what is published; after it is reached, one warning records how many lines exist only in the bounded attempt log.
- `lab_telemetry` carries CPU percent, memory bytes and limit, memory percent, PID count, elapsed time, and the approved limits. One streaming `docker stats` process runs per attempt, because `--no-stream` takes about a second per sample and misses most of a short run. Samples are thinned to a minimum interval.
- `artifact_changed` reports created or resized files in the artifact directory, without following symlinks. Digests are still computed only once, when the attempt ends.

Events never include commands the plan did not approve; the approved argv is already public in the `attempt` started event.

## Not built

The noVNC desktop observer is not implemented. The only supported case is a terminal-only experiment, and ADR 0005 forbids simulating a desktop for it. Adding one requires a GUI workload, a display in the lab image, and an authenticated proxy in the future API.

## Consequences

- The UI (Phase 4.3) can render the lab from the run event stream alone, including after a page refresh.
- The SSE endpoint that delivers these events belongs to the API in Phase 5.1.
- Output events are best effort at the batching interval; the authoritative log is the bounded attempt log.
