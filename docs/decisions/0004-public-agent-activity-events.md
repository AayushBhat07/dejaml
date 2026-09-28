# ADR 0004 — Show Public Agent Activity, Not Private Reasoning

**Status:** Accepted  
**Date:** 2026-09-28

## Context

Judges need to understand that Paper Analyst and Code Analyst work concurrently, but raw model reasoning is private, noisy, and not reliable evidence.

## Decision

Persist and stream a shared sequence of public activity events. Each event names the research role, status, concise action summary, public payload, and evidence pointers. The browser replays stored events after refresh and then subscribes to new events.

The Research Team screen will render Paper Analyst and Code Analyst as parallel lanes. Lead Researcher remains visibly waiting until both analysts finish, then begins reconciliation. Lab Engineer and Result Verifier appear as subsequent stages.

## Consequences

- Judges see genuine concurrency and progress in real time.
- Refresh and reconnect preserve the timeline.
- Evidence is inspectable without exposing chain-of-thought, provider secrets, or framework-specific transcripts.
- The backend must assign monotonic per-run sequence numbers and support replay from a last-seen sequence.

