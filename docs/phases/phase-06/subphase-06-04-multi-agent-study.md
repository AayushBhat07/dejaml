# Sub-phase 6.4 — Secure multi-agent study

**Status:** `IN PROGRESS` (everything but the real-model acceptance run is built and verified; that run needs a provider key and is pending)
**Completed:** `—`
**Commit:** `fill after the real-model acceptance run`
**Owner:** `Claude`

Requirement-by-requirement map: [`subphase-06-04-requirements.md`](subphase-06-04-requirements.md).
Deployment design: [`../../AWS_DEPLOYMENT_DESIGN.md`](../../AWS_DEPLOYMENT_DESIGN.md).

## Objective

A paper with no reviewed case is studied by separate agents working in four
trust zones. Code drives the stages; the final status comes from evidence, not
from any agent's word.

## Architecture

**Runtime path:** DéjàML native agent runtime (`packages/agent-runtime`) →
DéjàML provider adapter (`providers/openai.ts`, `anthropic.ts`, or one
administrator-configured OpenAI-compatible endpoint) → the provider's API.
**OpenClaw is not required and not used.** No OpenClaw package, binary,
gateway, session or localhost bridge is on any path; `npm run check:native`
fails if one appears, and `installNativeRuntimeGuard` refuses one at run time.
Claude Code only edits and tests the repository; it is not part of the runtime.

**Stage machine** (`packages/run-store/src/stages.ts`, persisted in SQLite):
`ingesting → analyzing_paper ∥ analyzing_repository → reconciling →
policy_review → preparing → executing (→ debugging) → reviewing → deciding →`
one of `completed`, `inconclusive`, `policy_blocked`, `failed`, `cancelled`.

- One owner holds a stage's lease; a second concurrent claim is refused.
- A completed stage returns its stored output and never reruns unless it is
  invalidated with a typed reason (which invalidates everything after it).
- Retries and re-plans carry typed reasons (`dependency_failure_replan`,
  `execution_failed_replan`, `reviewer_rejected_replan`, `process_restart`).
- After a restart, running stages fail with `process_restart`, completed stages
  are kept, the study resumes (`ApiServer.resume`), and each agent resumes its
  own saved conversation under its stable id instead of starting a duplicate.
- A terminal study is immutable.

**Agents** (`apps/api/src/study/roles.ts`, launched by `study.ts`): Paper
Analyst and Repository Analyst (concurrently), Reproduction Planner, Lab
Engineer (1–3, each in its own lab), Debugger (on request, at most two per
Engineer), Independent Reviewer (one per submission), Supervisor.

- Each is a separate runtime participant with its own `agt_` id, persisted
  conversation, tool grants, budgets (tokens, turns, wall time, tool calls),
  failure state, lifecycle events and tool receipts.
- They share only the typed evidence board, explicit typed messages, immutable
  source references, the approved plan, and bounded artifacts and receipts.
- The board hides Engineer and Debugger prose from the Reviewer.
- The Supervisor reads the board and answers at checkpoints (continue,
  re-plan with a typed reason, stop) and proposes a final status that can only
  keep or lower the computed one.
- No model can skip policy review, create a lab, or set the status.

**Claim contract** (`apps/api/src/study/contract.ts`): the reconciler combines
the Paper Analyst's claim and the Planner's plan into one contract: method,
dataset and source, split, preprocessing, seed policy, metric and unit,
reported value, page/location/excerpt, repository URL and commit, entry point,
exact argv and cwd, PlatformSpec with the plan's Python, requirements, trusted
compatibility constraints, expected runtime, metric parser, tolerance (by unit)
and stop conditions. The excerpt must appear verbatim on the cited page and
hold the reported value. Policy review is deterministic and its plan digest
(canonical-JSON SHA-256) is recorded.

**Reviewed claim targets** (`apps/api/src/study/targets.ts`,
`config/reviewed-targets/*.json`): a server-owned registry of claims a person
checked against a paper and its repository. An upload may name one by
`reviewedCaseId` and nothing else; a request can never carry a claim,
command, parser, commit, adapter, dependency set or expected answer. The
server refuses an unknown id, a paper whose SHA-256 differs from the reviewed
one, and a different repository; at start-up it refuses a target whose
excerpt lacks its value or whose adapter file does not match its reviewed
hash, and before any agent starts it checks the excerpt is verbatim on the
cited page. A target tells the Paper Analyst which claim to verify (never
the excerpt), the Repository Analyst which pinned repository and claim to
map (never the paper analysis), and the Planner the reviewed limits; the
Engineers, Reviewers and Supervisor never see it, and it holds no observed
value. Each agent may still reject the target: a Paper Analyst claim that is
not the target (`claimMismatch`) stops the study before planning, and policy
review refuses any plan outside the target (entry point, requirements,
constraints, dataset source, parser, runtime ceiling, adapter by hash) on top
of every normal check. A plan names the reviewed adapter by id and code
substitutes the hash-checked file. The target's `maximumVerdict` caps the
computed status (`partially_reproduced` for pyts, because of the adapter).
Without a target, the agents choose one claim themselves as before.

**Status** (`verdict.ts`): computed from the official run's parsed metric, the
Reviewers' verdicts, Engineer consensus and the policy. An adapter, a trusted
compatibility constraint, or Reviewer-declared minor deviations cap the result
at `partially_reproduced`. Final states: `reproduced`, `partially_reproduced`,
`not_reproduced`, `inconclusive`, `policy_blocked`, `failed`, `cancelled`.

## Trust zones

1. **Repository acquisition** (`packages/repository-intake`): GitHub HTTPS
   only, owner/name validation, no credentials, redirect checks, no hooks, pinned
   commit, symlink and path-escape refusal, size/file/time bounds.
2. **Python packages** (`services/prep`, `ports.ts#preparerPort`): short-lived
   egress-restricted containers from a digest-pinned image for the platform;
   binary wheels only, hashed, platform-tag-checked, transitive resolution,
   CPU-only (CUDA/ROCm/accelerator packages and indexes refused, typed
   `accelerator_package_refused`), disk-backed temp storage with byte/inode
   quotas and `insufficient_preparation_space`, `no_compatible_wheel` instead of
   a source build. Constraints come only from `config/compatibility-constraints.txt`.
3. **Datasets** (`packages/net-guard`, `ports.ts#localDatasetPort`): HTTPS
   allowlist, SSRF defenses, redirect checks, size limits, timeouts, required
   checksum, safe extraction, identity in evidence, read-only mount. Data
   bundled in an exactly pinned wheel is identified by that wheel's hash.
4. **Offline lab** (`services/lab-manager`): no network, non-root, read-only
   root, all capabilities dropped, no-new-privileges, no Docker socket or
   credentials, CPU/RAM/PID limits, per-command and lab timeouts, read-only
   repository/wheelhouse/dataset mounts, one writable artifact directory,
   bounded output, telemetry, and guaranteed cleanup. The created container is
   read back and audited before it starts. Agents use narrow lab tools
   (`lab-tools.ts`); `lab_run_official` runs only the approved argv, after an
   integrity check of the code, the plan's data, the adapter and the venv.

## Platform

`DEJAML_PLATFORM=auto` picks the Docker host's platform: Apple Silicon →
`linux/arm64`, Intel Mac or x86-64 Linux → `linux/amd64`; `aws-cpu` →
`linux/amd64`. The PlatformSpec (`packages/contracts/src/platform.ts`) drives
the prep image, wheel resolution and tag validation, cache keys, lab image
(`lab-images/python-base`, one per Python version and platform, base pinned by
digest), container creation, the plan and every receipt. Nothing runs under
emulation; amd64 wheels never reach an arm64 lab or the reverse.

## Local Mac setup

1. Install Docker Desktop and Node 24; `npm ci && npm run build`.
2. Put a key in the server environment only: `export DEJAML_ANTHROPIC_API_KEY=…`
   (or `DEJAML_OPENAI_API_KEY` with `DEJAML_OPENAI_MODELS`). Never in the
   browser, a file in the repository, or a Docker build argument.
3. `npm run start:local`, open <http://127.0.0.1:8787>, or run the acceptance
   script below. The first study builds the lab base image for your platform.

## Verification

```text
npm run check                                   # build, typecheck, lint, format, native scan, all unit/integration tests
npm run verify:docker   -w @dejaml/lab-manager  # sealed lab against real Docker
npm run verify:images   -w @dejaml/lab-manager  # image readiness against real Docker
npm run verify:docker   -w @dejaml/prep         # wheel zone against real Docker and PyPI
npm run verify:failures -w @dejaml/api          # API failure scenarios against real Docker
node apps/api/scripts/verify-study-docker.mjs   # the whole study on the pyts paper, scripted model
npm audit
```

**Observed (cloud container, Docker 29.3.1, linux/amd64, 2026-09-30):** see the
PR description for the exact head SHA and every result. In short:

- `npm run check` passes: 957 tests in 12 workspaces plus 5 native-scan tests, lint and format clean.
- `verify-study-docker.mjs` passes 15/15 in about 30 s. Deterministic
  infrastructure only (scripted model): the real pyts PDF is ingested,
  `johannfaouzi/pyts-repro` is pinned at `1f8a8285…`, the Python 3.11 lab image
  is made ready by digest for linux/amd64, 8 platform-matched wheels are
  prepared (pyts 0.10.0, numpy 1.23.5, scipy 1.9.3, scikit-learn 1.1.3, numba
  0.57.1, llvmlite 0.40.1, joblib, threadpoolctl), the official BOSS notebook runs
  offline through the declared adapter and prints `Accuracy on the test set:
  1.000`, the lab parses 1.000, the Reviewer approves with minor deviations,
  and the computed status is `partially_reproduced` (adapter and installer
  constraint). Nothing is left behind.

## Real acceptance

```text
export DEJAML_ANTHROPIC_API_KEY=…      # server environment only
npm run build && npm run start:local
node apps/api/scripts/accept-real-paper.mjs acceptance/cases/pyts-boss-gunpoint.json
node apps/api/scripts/accept-real-paper.mjs acceptance/cases/ccs-reproducibility-survey.json <survey-paper.pdf>
```

The positive case sends only `reviewedCaseId=pyts-boss-gunpoint` with the
paper. The script refuses any provider that is not OpenAI or Anthropic at the
vendor's own endpoint (it reads `/api/health`, loopback only, which reports
each provider's endpoint host, never a key).

**First real run (2026-10-01, `run_7c997066…`, anthropic):** the native agents
worked, but the Paper Analyst chose the BOSSVS Listing 1 claim (0.98) instead
of Table 2's BOSS/GunPoint value (1.000), because the script sent only the
paper and repository and the agents were told to pick any claim; policy then
refused the plan. The reviewed target above is the fix: the claim under study
is fixed by the server, while each agent still verifies it independently.

Reports are written to `artifacts/acceptance/<case>-<runId>.json` (sanitized:
ids, lifecycle, messages, receipts, digests, platform, images, wheels, plan and
digest, command, bounded logs, metric, reviews, status, cleanup; no prompts,
keys or environment). Exit code 3 means no provider key was configured.

**Status: pending.** This environment had no provider key, so no real-model run
has happened. The positive case is expected to end `partially_reproduced` (the
official notebook needs an adapter to skip datasets the offline lab cannot
download); the negative case `inconclusive` or `policy_blocked`.

## Security assumptions

- The API is bound to loopback and has no authentication.
- Docker is the isolation boundary for untrusted repository code.
- Provider keys live only in the server environment (or a secret manager behind
  `SecretProvider`); they never reach the browser, reports, events, labs or
  build arguments.
- The package index and dataset hosts on the allowlists are trusted to serve
  what their hashes say.

## Known limitations

- **No real-model run yet** (no key in this environment).
- One bounded claim per paper.
- Papers that need a GPU, a source build, or a non-allowlisted dataset host end
  `policy_blocked` or `inconclusive`.
- The accelerator denylist is by package name and version; quotas are enforced
  by polling; cross-platform resolution evaluates markers on the engine's
  interpreter (wheel tags are still validated).
- pyts 0.10.0's malformed metadata needs the trusted `pip<24.1` installer
  constraint; it is reported as a change.
- The pyts claim is a ceiling value (1.000), which discriminates little.
- The API process still runs Docker locally; `LabWorker`, `DependencyPort` and
  `LabImagePort` are the seams for moving that to lab hosts.

## Recovery procedure

1. Start Docker. `npm ci && npm run build`.
2. Restart the API: interrupted studies resume from their last completed stage;
   orphan labs, prep containers and stale checkouts are removed at startup.
3. Run `npm run check`, then `node apps/api/scripts/verify-study-docker.mjs`
   (set `DEJAML_PREP_CA_BUNDLE` on networks that intercept TLS).
4. Expect `All 15 checks passed` and no containers labelled `dejaml.run` or
   `dejaml.prep`.

## Next sub-phase

`6.5 — Several claims per paper`
