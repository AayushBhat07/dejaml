# Sub-phase 1.2 — Shared Contracts

**Status:** `DONE`  
**Completed:** `2026-09-28`  
**Commit:** `resolve with git log for shared contracts`  
**Owner:** `Codex`

## Objective

Freeze validated data contracts shared by the API, research roles, lab boundary, result verifier, and future web interface.

## Delivered

- Added npm workspace and strict TypeScript configuration.
- Added `@dejaml/contracts` with Zod schemas and inferred TypeScript types.
- Defined run statuses, evidence pointers, claims, code mappings, argv commands, datasets, preparation steps, resource budgets, metric extraction, experiment plans, public events, attempts, metrics, and assessments.
- Enforced no network during experiment execution at the schema level.
- Added contract tests for a valid curated plan, unsafe-network rejection, event timestamps, and a different-result assessment.
- Upgraded Vitest to the fixed major release after audit identified a moderate advisory in the initially selected version.

## Files changed

- `package.json`
- `package-lock.json`
- `tsconfig.base.json`
- `packages/contracts/package.json`
- `packages/contracts/tsconfig.json`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/index.test.ts`
- `docs/decisions/0003-typescript-contract-foundation.md`

## Decisions and deviations

- npm workspaces are used because npm is already present and pnpm was not installed.
- Zod is the single runtime-validation and type-inference source.
- Vitest 5 is pinned through the lockfile to avoid the disclosed path-traversal issue in earlier versions.

## Verification

```bash
npm run check
npm audit --audit-level=moderate
```

**Observed result:**

```text
TypeScript: passed
Test files: 1 passed
Tests: 4 passed
Audit: 0 vulnerabilities
```

## Known limitations

- The contracts are not yet generated as OpenAPI or JSON Schema.
- Command policy validation beyond structural validation belongs to Phase 2.4.
- Schema migration/versioning is limited to explicit `schemaVersion` fields for the overnight demo.

## Restore procedure

1. Use Node.js 24 or newer.
2. Run `npm install` at the repository root.
3. Run `npm run check`.
4. Run `npm audit --audit-level=moderate`.
5. Treat any type, test, or audit failure as a regression before resuming dependent work.

## Remaining work

- Implement the append-only run store.
- Create a deterministic full-run event fixture.
- Connect contracts to API and UI packages.

## Next sub-phase

`1.3 — Run store and event fixture`

