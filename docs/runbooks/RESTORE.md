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

## 6. Resume development

Resume only from the first `PENDING`, `IN PROGRESS`, or `REGRESSED` sub-phase in `ROADMAP.md`. When it passes, create or update its phase note before moving on.

