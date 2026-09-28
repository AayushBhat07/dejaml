# Sub-phase 0.2 — Architecture Baseline

**Status:** `DONE`  
**Completed:** `2026-09-28`  
**Commit:** `initial repository commit; resolve with git log`  
**Owner:** `Codex`

## Objective

Define a buildable overnight-demo architecture with explicit evidence, security, execution, recovery, and scope boundaries.

## Delivered

- Defined the one-claim curated-demo promise.
- Defined the Paper Analyst, Code Analyst, Lead Researcher, Lab Engineer, and Result Verifier roles.
- Defined trusted control-plane and untrusted execution-plane boundaries.
- Defined the API surface, run state machine, public event contract, and core entities.
- Defined deterministic plan validation and disposable-lab requirements.
- Defined failure handling, observability, testing, repository layout, and demo acceptance criteria.
- Recorded deferred features to protect the overnight schedule.

## Files changed

- `ARCHITECTURE.md` — authoritative architecture baseline.
- `ROADMAP.md` — phased execution plan.
- `README.md` — project entry point.
- `docs/phases/` — completion and recovery record system.

## Decisions and deviations

- The product UI uses research-role names; internal orchestration technology appears only in technical documentation.
- Unknown repositories may be analyzed but are not automatically executed in the overnight demo.
- A model may propose an experiment plan, but deterministic code must validate it.
- A completed run must include a lab-cleanup receipt.

## Verification

```text
Review ARCHITECTURE.md headings, Mermaid syntax, internal links, and roadmap coverage.
```

Automated Markdown and repository checks are added in sub-phase 0.3.

## Known limitations

- Implementation technologies are proposed but not yet pinned by lockfile or ADR.
- The initial architecture assumes a locally available container runtime.

## Restore procedure

1. Read `ARCHITECTURE.md` before changing application code.
2. Read `ROADMAP.md` and the latest phase notes to determine actual implementation state.
3. Confirm that the active scope remains one curated CPU experiment.
4. Record any architecture change in `docs/decisions/` and update the relevant phase note.

## Remaining work

- Finish repository conventions and publish the public remote.
- Pin stack decisions through ADRs.

## Next sub-phase

`0.3 — Repository and restoration conventions`
