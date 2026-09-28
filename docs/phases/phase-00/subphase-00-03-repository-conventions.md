# Sub-phase 0.3 — Repository and Restoration Conventions

**Status:** `DONE`  
**Completed:** `2026-09-28`  
**Commit:** `initial repository commit 0646f32 plus this completion update`  
**Owner:** `Codex`

## Objective

Create a safe local Git repository, public GitHub remote, documentation layout, restoration runbook, and durable completion-note convention.

## Delivered

- Created the local repository at `/Users/aayush07/Projects/dejaml`.
- Created the public repository `https://github.com/AayushBhat07/dejaml`.
- Verified that the default branch is `main` and visibility is `PUBLIC`.
- Added MIT licensing, ignore rules, README, architecture, roadmap, ADRs, phase-note template, and restoration runbook.
- Established the rule that each completed sub-phase must have an evidence and recovery note.

## Files changed

- `.gitignore`
- `LICENSE`
- `README.md`
- `ROADMAP.md`
- `ARCHITECTURE.md`
- `docs/decisions/`
- `docs/phases/`
- `docs/runbooks/RESTORE.md`

## Decisions and deviations

- The local folder uses lowercase `dejaml` for shell and repository compatibility; the product name remains DéjàML.
- Phase notes are committed alongside the implementation they describe whenever practical.

## Verification

```text
gh repo view AayushBhat07/dejaml --json nameWithOwner,visibility,url,defaultBranchRef
```

**Observed result:** Repository `AayushBhat07/dejaml`, visibility `PUBLIC`, default branch `main`.

## Known limitations

- Branch protection and CI are not configured yet.
- The public repository currently has a single maintainer.

## Restore procedure

1. Clone `https://github.com/AayushBhat07/dejaml`.
2. Check out `main`.
3. Read `ARCHITECTURE.md`, `ROADMAP.md`, and the latest phase note.
4. Run `git status --short` and `git log --oneline -10`.
5. Continue from the first non-`DONE` roadmap item.

## Remaining work

- Add executable project checks and CI after package tooling exists.
- Consider branch protection after the overnight demo stabilizes.

## Next sub-phase

`1.1 — Curated case package`

