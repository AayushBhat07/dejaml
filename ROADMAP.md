# DéjàML Demo Roadmap

This roadmap decomposes the overnight demo into phases and independently restorable sub-phases. A sub-phase is complete only when its acceptance checks pass and its completion note exists.

## Status legend

- `DONE` — implemented, verified, and documented
- `IN PROGRESS` — active work; do not assume restorable completion
- `PENDING` — not started
- `BLOCKED` — requires an explicit dependency or decision

## Phase 0 — Foundation

### 0.1 Curated case feasibility — `DONE`

Prove that one real paper, repository, dataset, claim, and CPU experiment are suitable for the demo.

**Exit criteria:**

- paper directly links the repository;
- numeric paper claim identified;
- repository and dataset inspected;
- smallest matching experiment executed;
- nondeterminism and discrepancies recorded.

### 0.2 Architecture baseline — `DONE`

Define product promise, roles, trust boundaries, contracts, state machine, security posture, and acceptance tests.

### 0.3 Repository and restoration conventions — `DONE`

Initialize the repository, directory skeleton, phase-note template, restoration runbook, license, and public remote.

## Phase 1 — Deterministic reproduction core

### 1.1 Curated case package — `DONE`

Add the Urban Land Cover case manifest, dataset acquisition metadata, deterministic Random Forest runner, metric output, and case-level verification.

### 1.2 Shared contracts — `DONE`

Implement validated schemas for `Claim`, `CodeMapping`, `ExperimentPlan`, `RunEvent`, `Attempt`, `Metric`, and `Assessment`.

### 1.3 Run store and event fixture — `DONE`

Implement append-only run/event persistence and create a deterministic full-run fixture for the frontend.

## Phase 2 — Intake and research analysis

### 2.1 PDF intake — `DONE`

Validate uploads, hash the PDF, extract page-anchored text, and store extraction evidence.

### 2.2 Repository discovery and acquisition — `DONE`

Extract candidate GitHub URLs, validate targets, shallow-clone the selected repository, and pin its commit.

### 2.3 Parallel analysts — `DONE`

Implement Paper Analyst and Code Analyst as independent structured sessions with narrow capabilities.

### 2.4 Lead Researcher and policy gate — `DONE`

Reconcile both analyses, produce one `ExperimentPlan`, and reject unsupported or unsafe plans deterministically.

## Phase 3 — Disposable lab

### 3.1 Python CPU image — `DONE`

Build and pin a minimal image for the curated experiment.

### 3.2 Lab Manager — `DONE`

Implement create, prepare, execute, cancel, artifact-read, and destroy operations with resource limits and cleanup receipts.

### 3.3 Live Lab observer — `DONE`

Stream terminal output, resource telemetry, artifact changes, and approved lab actions. For genuine GUI/browser workloads, provide an authenticated read-only noVNC observer; do not simulate clicks for terminal-only experiments.

### 3.4 Metric verification — `DONE`

Extract the observed metric, normalize units, calculate differences, and generate an assessment.

## Phase 4 — Product interface

### 4.1 New Study and application shell — `DONE`

Build the PDF submission experience and common visual system.

### 4.2 Research Team — `DONE`

Render Paper Analyst, Code Analyst, and Lead Researcher progress with evidence-bearing events.

### 4.3 Virtual Lab and Findings — `DONE`

Stream bounded command output and display the paper-versus-observed comparison, discrepancy findings, cleanup status, and report download.

## Phase 5 — Integration and demo hardening

### 5.1 End-to-end vertical slice — `DONE`

Connect the uploaded PDF to real repository discovery, analysis, execution, comparison, and reporting.

Verified in the cloud with stand-ins for the model, GitHub, and Docker; the real-model run is a Mac acceptance check (see the phase note).

### 5.2 Failure and cleanup verification — `DONE`

Prove cancellation, timeout, invalid input, unsupported repository, metric failure, and orphan-lab cleanup.

### 5.3 Demo freeze — `IN PROGRESS`

Rehearse repeatedly, cache permitted inputs, retain a labelled prior-run report and backup recording, and stop feature work.

Tooling and runbook done; the real rehearsals, recording, and freeze run on the development Mac (see the phase note and `docs/runbooks/DEMO.md`).

## Phase 6 — Semantic audit and future auto-execution

### 6.1 Audit Agent — `DONE`

Add an LLM-based post-run step that checks whether the measured metric semantically matches what the paper claimed, beyond the seven deterministic comparability checks.

The agent is non-fatal: a model or network error does not abort the run. The `dejaml-audit` OpenClaw agent must be created on the Mac before production runs can call a real model.

> **Note (2026-09-30):** No longer applies. OpenClaw is not required and not used; the Audit Agent's model calls go through DéjàML's native provider adapters.

See `docs/phases/phase-06/subphase-06-01-audit-agent.md`.

### 6.2 Auto-execution (host preparation) — `REGRESSED / BLOCKED`

Allow reviewed dependency installation and notebook conversion before the offline lab is created, so more papers can run without hand-written adapters.

The initial unproven plumbing was removed in commit `0b4168a`: model-proposed steps bypassed the deterministic policy, referenced a checkout after it was deleted, and required tools intentionally absent from the locked lab image. Reimplementation requires a separately pinned preparation image, exact allowlisted inputs and paths, resource limits, network policy, tests, and a real end-to-end case.

See `docs/phases/phase-06/subphase-06-02-auto-execution.md`.

The dependency trust zone in 6.4 (egress-restricted wheel downloads and an offline install in the lab) meets these requirements for Python wheels.

### 6.3 Autonomous multi-agent lab (offline) — `SUPERSEDED`

An autonomous Lab Agent with a Planner, Engineer and Debugger inside each offline lab, three replicas and a Lab Reviewer. Superseded by 6.4 in the same pull request: the API now runs separate agents through the bounded agent runtime. The 6.3 library code and its Docker proof remain in `packages/research-runtime`, but the API no longer calls them.

See `docs/phases/phase-06/subphase-06-03-autonomous-lab-agent.md`.

### 6.4 Secure multi-agent study — `IN PROGRESS`

Seven separate agents (Paper Analyst, Repository Analyst, Reproduction Planner, Lab Engineers, Debugger, Independent Reviewer, Supervisor) coordinate through a typed evidence board. Four trust zones handle repository acquisition, Python wheels, datasets and offline execution, and the final status is decided from evidence. Real OpenAI, Anthropic and custom-endpoint providers have server-side keys.

The stage machine is persisted and resumes after a restart, the claim contract and policy review are deterministic, and the PlatformSpec keeps images, wheels and labs on the host platform (Apple Silicon arm64, Intel and AWS amd64). Infrastructure is verified with real Docker, GitHub and PyPI, including the whole study on the pyts paper with a scripted model. The real-model acceptance run (`acceptance/cases/pyts-boss-gunpoint.json`) needs a provider key and is pending.

See `docs/phases/phase-06/subphase-06-04-multi-agent-study.md`.

## Change rule

If a completed sub-phase is later reverted or materially changed:

1. update its completion note status to `RESTORED`, `SUPERSEDED`, or `REGRESSED`;
2. record the commit that changed it;
3. state which acceptance checks must be rerun;
4. update this roadmap;
5. never delete the historical completion note.
