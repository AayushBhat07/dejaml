# ADR 0005 — Honest Live Lab Observer

**Status:** Accepted  
**Date:** 2026-09-28

## Context

A judge benefits from seeing an experiment happen rather than watching generic loading indicators. Most ML reproduction work, however, runs in a terminal and does not involve clicking a desktop.

## Decision

The default Live Lab view will show real terminal output, the current approved command, elapsed time, resource telemetry, artifact changes, and action events. When a supported workflow genuinely uses a browser or GUI, DéjàML may additionally provide an authenticated, short-lived, read-only noVNC observer.

The product will not simulate cursor movement or fake clicks for terminal-only experiments.

## Security boundary

- no direct public VNC port;
- trusted backend brokers observer access;
- short-lived per-run token;
- read-only by default;
- no host desktop access;
- no credentials exposed to research agents;
- observer closes when the lab is destroyed.

## Consequences

- The demo remains visually understandable without misrepresenting the work.
- The curated Random Forest case uses terminal and telemetry views.
- GUI observation is a later Lab Manager feature, not a dependency for PDF intake or analysis.

