# Sub-phase 2.2 — Repository Discovery and Acquisition

**Status:** `DONE`  
**Completed:** `2026-09-28`  
**Commit:** `resolve with git log for repository discovery and acquisition`  
**Owner:** `Codex`

## Objective

Find GitHub repository links in the extracted paper, retain page evidence, safely acquire one approved public repository, and pin its immutable commit without executing repository code.

## Delivered

- Added the `@dejaml/repository-intake` package.
- Extracted GitHub links from page-anchored paper text.
- Canonicalized HTTP, `www`, `.git`, and deeper repository paths to one HTTPS repository identity.
- Deduplicated repeated links while preserving every page occurrence.
- Rejected lookalike hosts, credentials, reserved GitHub routes, ports, SSH targets, and local-file targets.
- Queried only the fixed GitHub repository API with redirects disabled.
- Rejected private repositories and repositories larger than 100,000 KiB before Git execution.
- Added bounded, non-shell Git acquisition with shallow single-branch cloning, blob filtering, no tags, no submodules, disabled credentials, disabled repository hooks/LFS smudge commands, and disabled local-file transport.
- Capped Git time/output and checked-out file count/bytes.
- Verified the cloned origin and recorded the full HEAD commit SHA.
- Added guarded cleanup limited to internally named directories under the configured acquisition root.
- Added reusable repository candidate and acquisition contracts.

## Files changed

- `packages/repository-intake/src/index.ts` — discovery, validation, acquisition, verification, and cleanup.
- `packages/repository-intake/src/index.test.ts` — discovery and acquisition policy tests.
- `packages/repository-intake/scripts/verify-curated.mjs` — live curated-repository proof.
- `packages/repository-intake/README.md` — package policy and operation.
- `packages/contracts/src/index.ts` — strict GitHub URL and repository receipt schemas.
- `docs/decisions/0006-guarded-github-acquisition.md` — security decision.
- `ARCHITECTURE.md`, `ROADMAP.md`, `README.md`, and restoration documentation.

## Decisions and deviations

- Discovery is tolerant of legacy HTTP paper links, but acquisition requires the canonical HTTPS form.
- GitHub metadata is checked before cloning so privacy and advertised-size limits fail early.
- Repository contents remain untrusted even after a successful clone. No dependency installation or code execution occurs here.
- Redirected or renamed repository identities fail rather than silently changing the paper's source.

## Verification

```bash
npm run check
npm audit --audit-level=moderate
npm run verify:curated --workspace @dejaml/repository-intake
git diff --check
```

**Observed result:**

```text
Contracts: 4 tests passed
Paper intake: 4 tests passed
Repository intake: 5 tests passed
Run store and fixture: 6 tests passed
Total: 19 tests passed
Audit: 0 vulnerabilities
Curated repository: 6,124 KiB, main branch
Pinned commit: 49ece7ff4cc43fd4cb258678d44854f1cb2a417d
Cleanup: confirmed
```

## Known limitations

- GitHub is the only supported repository host.
- Anonymous GitHub API rate limits apply.
- Multiple candidates are returned for later selection; the Lead Researcher policy is not implemented yet.
- A repository renamed after paper publication ends as unavailable instead of being followed automatically.
- Repository ZIP upload remains outside this sub-phase.

## Restore procedure

1. Use Node.js 24 or newer with Git available on `PATH`.
2. Run `npm install` and `npm run check`.
3. Run `npm audit --audit-level=moderate` and require zero findings.
4. Run `npm run verify:curated --workspace @dejaml/repository-intake` with network access.
5. Confirm the expected commit and cleanup receipt shown above.
6. Confirm no `dejaml-repo-*` checkout remains under the temporary verification root.

## Remaining work

- Persist the selected repository receipt with the run.
- Give the Paper Analyst and Code Analyst narrow, separate read capabilities.
- Reconcile multiple repository candidates through the Lead Researcher policy gate.

## Next sub-phase

`2.3 — Parallel analysts`
