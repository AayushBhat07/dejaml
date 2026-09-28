# DéjàML

**Same claim. One more run.**

Public repository: <https://github.com/AayushBhat07/dejaml>

DéjàML is a hackathon-scale research reproducibility demo. It reads one lightweight ML paper, discovers the public repository cited by the paper, maps one numeric claim to code, runs one bounded CPU experiment in a disposable lab, and produces an evidence-backed comparison.

## Current status

The project is being built as one reliable vertical slice around the Urban Land Cover Random Forest result. See:

- [Architecture](ARCHITECTURE.md)
- [Roadmap](ROADMAP.md)
- [Phase notes](docs/phases/README.md)
- [Restoration runbook](docs/runbooks/RESTORE.md)
- [Curated case](cases/urban-land-cover/README.md)
- [Paper intake](packages/paper-intake/README.md)
- [Repository intake](packages/repository-intake/README.md)
- [Parallel research runtime](packages/research-runtime/README.md)
- [Real-time run store](packages/run-store/README.md)
- [Lab Manager](services/lab-manager/README.md)
- [Result Verifier](packages/result-verifier/README.md)

## Product roles

- Paper Analyst
- Code Analyst
- Lead Researcher
- Lab Engineer
- Result Verifier

Implementation-framework names remain internal to the technical architecture.

## Scope of the first demo

- text-readable PDF;
- public GitHub repository linked by the paper;
- one curated public dataset;
- one CPU-compatible Random Forest experiment;
- live evidence events;
- paper-versus-observed metric comparison;
- explicit cleanup and downloadable report.

## Repository state

Do not infer readiness from directory presence. The authoritative implementation status is recorded in `docs/phases/` and each completed sub-phase contains a restore checklist.

## Backend progress

The backend foundation now includes validated shared contracts, bounded PDF validation and page-level text extraction, immutable source hashing, page-anchored GitHub discovery, guarded public-repository acquisition with commit pinning, real concurrent Paper/Code Analyst sessions with bounded evidence and live events, Lead Researcher reconciliation, an exact deterministic execution-policy gate, a deterministic curated experiment, an append-only refresh-safe run store, and a trusted Lab Manager that runs approved attempts in disposable offline containers with enforced time limits, cancellation, bounded artifacts, and verified cleanup receipts, live output and telemetry events, and a deterministic Result Verifier that turns the exported metric into a tolerance verdict with labelled hypotheses.
