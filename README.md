# DéjàML

**Same claim. One more run.**

DéjàML is a hackathon-scale research reproducibility demo. It reads one lightweight ML paper, discovers the public repository cited by the paper, maps one numeric claim to code, runs one bounded CPU experiment in a disposable lab, and produces an evidence-backed comparison.

## Current status

The project is being built as one reliable vertical slice around the Urban Land Cover Random Forest result. See:

- [Architecture](ARCHITECTURE.md)
- [Roadmap](ROADMAP.md)
- [Phase notes](docs/phases/README.md)
- [Restoration runbook](docs/runbooks/RESTORE.md)

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

