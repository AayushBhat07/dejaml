# ADR 0001 — Build One Curated Vertical Slice First

**Status:** Accepted  
**Date:** 2026-09-28

## Context

General ML-paper reproduction involves inconsistent repositories, unavailable datasets, expensive training, missing seeds, and unsafe code. An overnight demo cannot solve that entire problem reliably.

## Decision

The first DéjàML demo supports one curated, CPU-compatible claim from the Urban Land Cover paper. Unknown cases may be analyzed but execution remains gated.

## Consequences

- The live demo can be rehearsed and measured end to end.
- Architecture preserves extension points for more cases.
- Breadth is intentionally deferred.
- Product copy must not imply arbitrary-paper execution.

