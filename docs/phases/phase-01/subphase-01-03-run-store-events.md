# Sub-phase 1.3 — Run Store and Parallel Activity Events

**Status:** `DONE`  
**Completed:** `2026-09-28`  
**Commit:** `resolve with git log for run store and events`  
**Owner:** `Codex`

## Objective

Persist run progress and support a refresh-safe, real-time view of multiple research roles working concurrently.

## Delivered

- Added an append-only SQLite run and event store using Node's built-in SQLite module.
- Added the allowed run-state transition graph and terminal-state protection.
- Added atomic monotonic sequence assignment per run.
- Added ordered event replay from a caller's last received sequence.
- Added live in-process subscriptions for the future SSE API.
- Added persistence verification across store close and reopen.
- Added a schema-valid 15-event fixture showing Paper Analyst and Code Analyst working concurrently, followed by Lead Researcher, Lab Engineer, and Result Verifier.
- Added an explicit architecture decision to expose public activity summaries and evidence rather than private chain-of-thought.

## Files changed

- `packages/run-store/src/index.ts`
- `packages/run-store/src/index.test.ts`
- `packages/run-store/src/fixture.test.ts`
- `packages/run-store/README.md`
- `fixtures/events/urban-land-cover-success.json`
- `docs/decisions/0004-public-agent-activity-events.md`
- root and workspace package metadata

## Decisions and deviations

- SQLite is used through `node:sqlite`, avoiding a native third-party database dependency.
- Events are globally ordered per run while retaining their actor, allowing the UI to render parallel lanes without separate unsynchronized streams.
- Only public summaries, safe payloads, and evidence pointers are stored; raw reasoning and provider secrets are excluded.
- HTTP Server-Sent Events are the next transport layer; this sub-phase supplies persistence and subscription primitives.

## Verification

```bash
npm run check
npm audit --audit-level=moderate
```

**Observed result:**

```text
Contracts: 4 tests passed
Run store and fixture: 6 tests passed
TypeScript build and typecheck: passed
Audit: 0 vulnerabilities
```

Verified behaviors:

- sequence order and replay after a chosen sequence;
- live subscriber delivery;
- file-backed restoration after reopening SQLite;
- invalid state-transition rejection;
- terminal-state protection;
- event-fixture schema and concurrency ordering.

## Known limitations

- Live subscriptions are process-local; a multi-process deployment would need a broker or database notification layer.
- The SSE HTTP route is not implemented yet.
- Run input is stored as JSON without a dedicated schema; API intake validation will constrain it in Phase 2.1.
- Database migrations use an initial idempotent schema rather than versioned migrations.

## Restore procedure

1. Use Node.js 24 or newer.
2. Run `npm install`.
3. Run `npm run check` and confirm all 10 tests pass.
4. Run `npm audit --audit-level=moderate` and require zero findings.
5. Confirm `fixtures/events/urban-land-cover-success.json` remains valid and visibly interleaves the two analyst roles before either completes.

## Remaining work

- Add the API and SSE route.
- Validate PDF inputs and persist source hashes.
- Wire actual analyst execution to event append operations.

## Next sub-phase

`2.1 — PDF intake`

