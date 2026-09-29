# DéjàML

**Same claim. One more run.**

Public repository: <https://github.com/AayushBhat07/dejaml>

DéjàML is a hackathon-scale research reproducibility demo. It reads one lightweight ML paper, discovers the public repository cited by the paper, maps one numeric claim to code, runs one bounded CPU experiment in a disposable lab, and produces an evidence-backed comparison.

## One-command quick start

On macOS or Linux, install **Node.js 24+**, **Python 3**, and a running **Docker** engine, then run:

```bash
git clone https://github.com/AayushBhat07/dejaml.git
cd dejaml
npm run bootstrap
```

The bootstrap is idempotent and performs the complete machine-local setup for the included Urban Land Cover paper:

1. installs the locked JavaScript dependencies;
2. builds, type-checks, and tests the repository;
3. downloads and checksum-verifies the public UCI dataset;
4. builds the pinned Python CPU image for the local Docker platform;
5. runs the real experiment offline in a non-root disposable lab;
6. verifies the expected `79.88%` result and cleanup receipt;
7. downloads the example paper to `artifacts/demo/paper.pdf`;
8. writes a non-secret `.env.local` with the machine-specific image ID; and
9. builds the web app in live-API mode.

No model account is required for that deterministic reproduction. To inspect the product flow using the clearly labelled example replay:

```bash
npm run demo:replay
```

Open <http://localhost:5173>. The replay does not execute a new study; the bootstrap already ran the real curated experiment and left its result at `cases/urban-land-cover/artifacts/result.json`.

### Complete live-agent run

The live research flow additionally requires the pinned OpenClaw CLI (`2026.9.5`), a configured model provider, and dedicated no-binding agents named `dejaml-paper`, `dejaml-code`, and `dejaml-lead`. `dejaml-audit` is optional and adds the semantic audit card. Provider credentials stay in OpenClaw and are never written by the bootstrap.

If OpenClaw is installed outside the active shell's `PATH`, rerun the bootstrap once with its absolute path so `.env.local` records it:

```bash
OPENCLAW_BIN=/absolute/path/to/openclaw npm run bootstrap
```

Once those agents exist, run:

```bash
npm run start:local
```

Open <http://127.0.0.1:8787> and upload `artifacts/demo/paper.pdf`. The command reads `.env.local`, verifies the local image identity and required files, and starts the real API. The API is intentionally bound to loopback because it has no authentication.

If the bootstrap stops, fix the first reported prerequisite and rerun the same command. See [Restoration and troubleshooting](docs/runbooks/RESTORE.md) for individual verification commands.

## Current status

The project is being built as one reliable vertical slice around the Urban Land Cover Random Forest result. See:

- [Architecture](ARCHITECTURE.md)
- [Roadmap](ROADMAP.md)
- [Phase notes](docs/phases/README.md)
- [Restoration runbook](docs/runbooks/RESTORE.md)
- [Demo runbook](docs/runbooks/DEMO.md)
- [Curated case](cases/urban-land-cover/README.md)
- [Paper intake](packages/paper-intake/README.md)
- [Repository intake](packages/repository-intake/README.md)
- [Parallel research runtime](packages/research-runtime/README.md)
- [Real-time run store](packages/run-store/README.md)
- [Lab Manager](services/lab-manager/README.md)
- [Result Verifier](packages/result-verifier/README.md)
- [Web app](apps/web/README.md)
- [Run API](apps/api/README.md)

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

The backend foundation now includes validated shared contracts, bounded PDF validation and page-level text extraction, immutable source hashing, page-anchored GitHub discovery, guarded public-repository acquisition with commit pinning, real concurrent Paper/Code Analyst sessions with bounded evidence and live events, Lead Researcher reconciliation, an exact deterministic execution-policy gate, a deterministic curated experiment, an append-only refresh-safe run store, and a trusted Lab Manager that runs approved attempts in disposable offline containers with enforced time limits, cancellation, bounded artifacts, and verified cleanup receipts, live output and telemetry events, and a deterministic Result Verifier that turns the exported metric into a tolerance verdict with labelled hypotheses, and a Run API that connects an uploaded paper to all of it with live events, cancellation, restart recovery, and a downloadable report.
