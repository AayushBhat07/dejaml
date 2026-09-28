# ADR 0003 — TypeScript and Zod Contract Foundation

**Status:** Accepted  
**Date:** 2026-09-28

## Context

The API, research orchestration, lab boundary, report generator, and web interface need one shared schema source. The overnight build also needs a package workflow already available on the machine.

## Decision

Use npm workspaces, strict TypeScript, and Zod schemas in `@dejaml/contracts`. Use Node.js 24 or newer. Keep the curated experiment runner in Python because the source experiment is Python-based.

## Consequences

- Runtime validation and static types derive from the same definitions.
- The frontend and backend can share immutable contracts.
- npm avoids adding a package-manager prerequisite that is not currently installed.
- Python remains confined to experiment execution rather than becoming an additional web backend.

