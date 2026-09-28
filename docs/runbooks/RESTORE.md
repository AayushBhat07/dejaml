# DéjàML Restoration Runbook

Use this runbook after a new clone, interrupted session, machine restart, or regression.

## 1. Establish the source of truth

1. Read `ARCHITECTURE.md`.
2. Read `ROADMAP.md`.
3. Find the latest completed note under `docs/phases/`.
4. Inspect `git status`, the current branch, and recent commits.
5. Do not assume a directory or partially written file means its sub-phase is complete.

## 2. Verify repository integrity

```bash
git status --short
git log --oneline --decorate -10
```

After project tooling exists, also run the root `check` command documented in `README.md`.

## 3. Restore external prerequisites

- Git and GitHub CLI
- supported Node.js runtime
- Python/uv for the curated-case runner
- Docker Desktop or another approved container runtime
- cloud model credentials through server-side secret configuration

Never paste provider credentials into Markdown files, committed environment files, logs, or experiment containers.

## 4. Restore the curated case

Follow `docs/phases/phase-00/subphase-00-01-case-feasibility.md`, then the latest Phase 1 case-package note. Verify the pinned repository commit, dataset digest, deterministic seed, and metric output.

## 5. Restore interrupted runs

- Preserve append-only run events.
- Mark an interrupted active attempt explicitly.
- Clean up any orphan lab before retrying.
- Start a new attempt record; never overwrite an interrupted attempt.

## 6. Verify paper intake

Run `npm run check`, then confirm the paper-intake tests cover a text-readable PDF, invalid input, an oversized upload, and a PDF without extractable text. Paper bytes must be hashed before parsing, and extracted text must retain page numbers for later evidence citations.

## 7. Verify repository acquisition

```bash
npm run build
npm run verify:curated --workspace @dejaml/repository-intake
```

The receipt must report commit `49ece7ff4cc43fd4cb258678d44854f1cb2a417d` and `cleanedUp: true`. A commit mismatch means the curated case or acquisition policy must be reviewed before continuing.

## 8. Resume development

Resume only from the first `PENDING`, `IN PROGRESS`, or `REGRESSED` sub-phase in `ROADMAP.md`. When it passes, create or update its phase note before moving on.
