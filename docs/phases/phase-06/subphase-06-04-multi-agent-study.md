# Sub-phase 6.4 — Secure multi-agent study

**Status:** `IN PROGRESS` (infrastructure verified with real Docker, GitHub and PyPI; the real-model acceptance run is still to do)
**Completed:** `—`
**Commit:** `fill after commit`
**Owner:** `Claude`

## Objective

A paper with no reviewed case is studied by separate agents working in four
trust zones. The final status comes from evidence, not from any agent's word.

## Delivered

- **Bounded autonomous agent runtime** (`packages/agent-runtime`). Each agent has:
  - a unique `agt_` id;
  - its own persisted conversation, tool grants and loop;
  - limits on iterations, tool calls, tokens, wall time and context;
  - cancellation, and resume after a restart.
  Agents share only the typed evidence board and explicit messages. Every
  model call and tool call is persisted as a receipt in the run's `AgentLedger`.
  This is DéjàML's own runtime, not OpenClaw.
- **Seven roles** (`apps/api/src/study/roles.ts`):
  - Paper Analyst
  - Repository Analyst
  - Reproduction Planner
  - Lab Engineer (1 to 4, each in its own lab)
  - Debugger (a child agent started by an Engineer)
  - Independent Reviewer (one per submission)
  - Supervisor, which drives the stages through `delegate` with per-stage caps

  The board's visibility table keeps the Engineer's diagnoses and notes away
  from the Reviewer.
- **Trust zone 1, repository acquisition.**
  - Only the paper's candidate GitHub repositories are accepted, over HTTPS.
  - Each is pinned to a commit SHA, with size and file limits.
  - Nothing from the repository is executed during acquisition.
  - A receipt is recorded with the manifest digest.
  - Host-side read tools refuse traversal and never follow symlinks.
- **Trust zone 2, Python dependencies** (`services/prep`).
  - Steps: `discover`, `resolvePython`, `downloadWheels`, `installOffline` and `inspectEnvironment`.
  - Downloads use binary wheels only, from a pinned prep image whose egress proxy allows only the package registries.
  - Wheel hashes are recorded in a manifest.
  - The lab installs offline from a read-only wheelhouse.
  - An impossible pin fails as a typed error (for example `no_compatible_wheel`).
- **Trust zone 3, datasets** (`packages/net-guard`).
  - Downloads go only to hosts on an HTTPS allowlist.
  - Every redirect is revalidated.
  - Private, loopback, link-local and metadata addresses are refused, and the connection is pinned to the checked address.
  - Datasets are mounted read-only.
  - With no allowed host, a download request records a policy block.
- **Trust zone 4, the offline lab** (`services/lab-manager`).
  - The container runs with `--network none`, a read-only root, all capabilities dropped and `no-new-privileges`, as a non-root user.
  - It has CPU, memory and PID limits, per-command timeouts, and a reaper for background processes.
  - Commands take a bare argv, and a relative `cwd` without `..`.
  - No provider keys, GitHub credentials, host environment or Docker credentials enter a container.
- **Evidence-based status** (`apps/api/src/study/verdict.ts`).
  - Provenance checks:
    - the producing command belongs to the Engineer and exited 0;
    - the artifact digest matches what that command wrote;
    - the value is read from the exported file;
    - the value never appears typed into a command or a written file;
    - adapters are declared.
  - Statuses:
    - `reproduced` needs a majority of independent Engineers to agree within tolerance, equivalent reviews, and no adapters or deviations;
    - `partially_reproduced` covers approved results with adapters or minor deviations;
    - `not_reproduced` covers agreed values outside tolerance;
    - anything else is `inconclusive` or `policy_blocked`.
  - A toy example, approximation, changed dataset, reduced sample or replacement metric is never `reproduced`.
  - The Supervisor can only make the status more cautious.
- **Providers** (`packages/agent-runtime/src/providers`).
  - Real Anthropic and OpenAI clients, and one administrator-configured OpenAI-compatible endpoint.
  - Retries with backoff, abort support, and token tracking.
  - Cost only when `DEJAML_MODEL_PRICES` lists the model.
  - Keys stay server-side. `/api/config` returns only provider ids, labels, models and key source.
  - The upload form sends a provider id and model, and the server refuses a base URL.
  - An uploader's key, when allowed, is used in memory and never stored.
- **Web.** Provider and model pickers, an agent team view, and a study result card.
- **Cleanup.** Labs are destroyed, then the wheelhouse, checkout and study directory are removed. A leak check looks for containers and networks labelled with the run. At startup, stale study directories are removed and unfinished agents are marked `interrupted`.

## Files changed

- `packages/agent-runtime/` — runtime, evidence board, tool plumbing, providers and fixtures.
- `packages/net-guard/` — SSRF-safe HTTPS fetch and dataset acquisition.
- `packages/run-store/src/ledger.ts`, `src/index.ts` — agent, turn and receipt ledger.
- `packages/contracts/src/index.ts` — agent, board and study contracts.
- `packages/repository-intake/` — candidate-only acquisition, receipts and limits.
- `services/prep/` — the dependency trust zone.
- `services/lab-manager/src/manager.ts`, `spec.ts` — read-only input mounts, env wrapper, hardening.
- `apps/api/src/study/` — roles, tools, stages, verdict and tests.
- `apps/api/src/structured.ts`, `pipeline.ts`, `server.ts`, `main.ts`, `stand-ins.ts`, `api.test.ts` — the study path, provider selection and restart recovery.
- `apps/api/scripts/verify-study-docker.mjs`, `accept-real-paper.mjs` — the Docker proof and the real-model acceptance script.
- `apps/web/src/` — provider selection, agent team, study result.
- `README.md`, `apps/api/README.md`, `docs/runbooks/RESTORE.md`, `.env.example`, `ROADMAP.md` — documentation.

## Decisions and deviations

- 6.3's in-API autonomous path is replaced. It accepted arbitrary model base URLs from uploaders and had no persisted per-agent state. Three API tests that relied on it were replaced with multi-agent tests. The 6.3 library code and its Docker proof are kept.
- Source distributions are never built. A package without a compatible wheel fails with a typed error.
- No model prices are built in, so cost is unknown unless the administrator configures prices.
- The literal-value provenance check remains a heuristic, and the Independent Reviewer is the second line of review.

## Verification

```text
npm run check
node apps/api/scripts/verify-study-docker.mjs
npm run verify:failures --workspace @dejaml/api
npm run verify:docker --workspace @dejaml/lab-manager
```

**Observed result (cloud container, Docker 29.3.1, x86_64, 2026-09-30):**

- `npm run check`: 522 tests passed, typecheck and build clean. That includes the SSRF, timeout, cancellation, concurrency, crash-recovery and cleanup tests.
- `verify-study-docker.mjs` passed all 13 checks in 46 s. It uses a real Docker engine, GitHub and PyPI with a scripted model, so it is an infrastructure proof only.
  - Ten separate agents ran: a Supervisor, two analysts, a Planner, two Engineers, two Debuggers and two Reviewers.
  - `reproducibility-sec/reproducibility` was pinned at `b4410c426eed68fff090e3a1a75c86e52762d8a4`.
  - `requirements.txt` was discovered. `numpy==1.19.5` failed with `no_compatible_wheel`.
  - 13 wheels were downloaded and installed offline in both labs.
  - `repo/figure.py` failed from the wrong directory and then ran, after separate Debugger agents diagnosed it.
  - Both Engineers produced 0.43758 from `artifacts/metric.json`.
  - The Reviewers rejected the placeholder claim, so the status was `inconclusive`.
  - No containers, networks, lab directories or prep directories were left.
- `verify:failures` and the Lab Manager `verify:docker` pass with no remaining containers.

## Known limitations

- **No real-model run yet.** The cloud session has no model key, so the real-model acceptance run on a lightweight paper has not happened.
- One claim per study.
- Papers that need a GPU, a source build, or a dataset host that is not allowlisted end as `inconclusive` or `policy_blocked`.
- Honest metric computation is checked by provenance rules and review, not proven.

## Restore procedure

1. Start Docker, build the lab image, and run `npm run build`.
2. Run `npm run check`.
3. Run `node apps/api/scripts/verify-study-docker.mjs`. On a network that intercepts TLS, set `DEJAML_PREP_CA_BUNDLE`.
4. Expect `All 13 checks passed` and no containers labelled `dejaml.run`.

## Remaining work

1. Configure a server key, for example `DEJAML_ANTHROPIC_API_KEY`, and start the API with `npm run start:local`.
2. Run `node apps/api/scripts/accept-real-paper.mjs <paper.pdf> https://github.com/reproducibility-sec/reproducibility`.
3. Record the run id, provider, model, status and the 12 checks here.

## Next sub-phase

`6.5 — Several claims per paper`
