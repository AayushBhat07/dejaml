# Sub-phase 6.4: requirement → source → test map

Starting SHA of this pass: `ba84a9e532f113751397c2bb273dea7deecde15c` (PR #4 head
on 2026-09-30; the PR's base is `feat/lab-agent-tool-loop`). Each row names where the requirement
lives and what proves it. "Docker" rows are real-Docker scripts; "live" rows
need a real provider key.

## A. Independent agents

| Requirement | Source | Proof |
|---|---|---|
| Separate runtime instances per role (7 roles) | `packages/agent-runtime/src/runtime.ts`, `apps/api/src/study/roles.ts`, `study.ts` (`launch`) | `independence.test.ts`; `api.test.ts` "runs a paper … separate, independent agents" |
| Unique ID, own history, state, failure | `AgentLedger` (`packages/run-store/src/ledger.ts`) | `independence.test.ts` 1, 7, 10 |
| Role tool allowlists | `ROLE_CAPABILITIES` (`packages/agent-runtime/src/tools.ts`) | `independence.test.ts` 3 |
| Own token/turn/time/tool budgets | `limitExceeded` in `runtime.ts` | `independence.test.ts` "keeps budgets per agent" |
| Cancellation | `cancelAgent` | `independence.test.ts` 6; `api.test.ts` cancel test |
| Resume after restart | `resumeAgent`, stable IDs (`stableAgentId`) | `runtime.test.ts` "resumes an interrupted agent …"; `stages.test.ts` restart |
| Lifecycle events, receipts | `#runEvent`, `listReceipts` | `independence.test.ts` "emits observable lifecycle …"; `runtime.test.ts` receipts |
| Analysts concurrent; Planner waits for both | `analysis()` in `study.ts`; `StudyStages` prerequisites | `independence.test.ts` 2; `stages.test.ts` "the Planner waits for both analysts" |
| Reviewer sees no hidden reasoning | board visibility (`board.ts`, `BOARD_REDACTIONS`) | `independence.test.ts` 8 |
| Explicit messages | `sendMessage` / `takeMessages` | `independence.test.ts` 4 |
| Supervisor cannot fabricate or raise | `applySupervisor`, `DOWNGRADES` (`verdict.ts`) | `verdict.test.ts`; `api.test.ts` "the Supervisor cannot raise it" and "lets the Supervisor lower" |

## B. No OpenClaw

| Requirement | Source | Proof |
|---|---|---|
| Static scan (imports, binary, gateway, session ids, localhost bridge) | `scripts/check-native-runtime.mjs` | `npm run check:native` (5 tests) |
| Runtime guard | `packages/agent-runtime/src/native-guard.ts` | `native-guard.test.ts` |
| Native acceptance mode | `accept-real-paper.mjs`, `verify-autonomous-docker.mjs --live` | live (pending key) |

## C. Providers

| Requirement | Source | Proof |
|---|---|---|
| OpenAI, Anthropic, custom adapters | `packages/agent-runtime/src/providers/*` | `openai.test.ts`, `anthropic.test.ts`, `hardening.test.ts`, `retry.test.ts` |
| Browser picks only provider + model | `parseSelection` (`server.ts`) | `provider-selection.test.ts` |
| SSRF-guarded custom endpoint (IPv4/IPv6, rebinding, redirects, limits) | `packages/net-guard/src/endpoint.ts`, `ip.ts`, `dns.ts` | `endpoint.test.ts`, `ip.test.ts`, `dns.test.ts`, `fetch.test.ts` |

## D. PlatformSpec

| Requirement | Source | Proof |
|---|---|---|
| Typed spec, targets (apple-silicon-dev, intel-dev, aws-cpu) | `packages/contracts/src/platform.ts` | `platform.test.ts` |
| Used by images, wheels, cache keys, containers, plans, receipts | `ImageReadiness`, `DependencyPreparer`, `LabSpec.platform`, `reconcile` | `images.test.ts`, `downloader.test.ts`, `spec.test.ts`, `verdict.test.ts`; Docker: `verify:images`, `verify:docker -w @dejaml/prep` (arm64 cross-resolution) |

## E. Image readiness

| Requirement | Source | Proof |
|---|---|---|
| Digest identity, dedupe, wait, typed failure, no fallback | `services/lab-manager/src/images.ts`, `services/prep/src/image.ts` | `images.test.ts` (missing, stale, concurrent, pull/build failure, cancel, retry), `image.test.ts`; Docker: `verify:images` |
| Health diagnostics | `/api/health` (`server.ts`, `main.ts`) | `api.test.ts` "serves internal health diagnostics" |

## F. Dependency preparation

| Requirement | Source | Proof |
|---|---|---|
| Repository zone (HTTPS GitHub, pinned commit, symlinks, bounds) | `packages/repository-intake` | `repository-intake/src/index.test.ts` |
| Wheels only, hashes, transitive, offline install, `no_compatible_wheel` | `services/prep` | `downloader.test.ts`, `report.test.ts`; Docker: `verify:docker -w @dejaml/prep` |
| CPU-only policy | `accelerator.ts`, `screenRequirements` (`apps/api/src/study/ports.ts`) | `downloader.test.ts` CPU-only; `ports.test.ts`; `api.test.ts` GPU → policy_blocked |
| Disk quotas, `insufficient_preparation_space` | `space.ts` | `downloader.test.ts` disk-backed temp storage; Docker prep step 7 |
| Trusted constraints file, every change reported | `config/compatibility-constraints.txt`, `reviewPolicy` | `verdict.test.ts` "applies only constraints from the trusted …"; `ports.test.ts` |
| Python version in plan and image identity | `reconcile`, `pythonBaseImageRequest` | `verdict.test.ts`; `ports.test.ts` lab image port |

## G. Datasets

| Requirement | Source | Proof |
|---|---|---|
| Allowlist, SSRF, redirects, limits, checksum, safe extraction, identity, cleanup | `packages/net-guard/src/dataset.ts`, `archive.ts`; `localDatasetPort` | `dataset.test.ts`, `archive.test.ts` |
| Data bundled in a pinned wheel | `package` dataset source (`contracts/src/study.ts`, `reviewPolicy`) | `verdict.test.ts` "accepts data bundled in a package only when … pinned exactly" |

## H. Sealed lab

| Requirement | Source | Proof |
|---|---|---|
| No network, non-root, read-only root, caps dropped, no-new-privileges, limits, read-only mounts | `services/lab-manager/src/manager.ts` (`#auditContainer`) | `manager.test.ts`; Docker: `verify:docker -w @dejaml/lab-manager` |
| Network isolation judged on genuine devices (kernel lists + sysfs structure); control files such as `bonding_masters` skipped, unknown real devices still fail | `services/lab-manager/src/network-isolation.ts` | `network-isolation.test.ts` (fake sysfs: ignored control file, unknown `eth1` fails, kernel-only device fails, kernel-named file fails); Docker: `verify:docker` incl. bridge negative control |
| Narrow lab tools, no host shell | `apps/api/src/study/lab-tools.ts` | `tools.test.ts` |
| Approved command only on unchanged state (code, data, venv, adapter) | `lab_run_official`, `measureIntegrity` | `tools.test.ts`; `api.test.ts` tamper test |

## I. Deterministic orchestration

| Requirement | Source | Proof |
|---|---|---|
| Persisted stages, one owner, typed retries, invalidation, restart, terminal immutability | `packages/run-store/src/stages.ts` | `stages.test.ts` (8 tests) |
| Model cannot skip policy, create labs, or mark reproduced | `study.ts` (code drives stages; `decideStatus`) | `api.test.ts`, `verdict.test.ts` |
| Resume on restart | `recoverAfterRestart`, `ApiServer.resume` | `api.test.ts` restart recovery |
| Cancellation reaches agents, prep, labs | `stopAgents`, dispatcher `cancel` | `api.test.ts` cancel tests; `ports.test.ts` dispatcher |

## J. Claim contract

| Requirement | Source | Proof |
|---|---|---|
| All contract fields, tolerance by unit | `ClaimContractSchema`, `reconcile`, `TOLERANCE` | `verdict.test.ts` |
| Excerpt verbatim on the cited page with the value | `checkExcerpt` | `verdict.test.ts` "requires the claim's excerpt verbatim …" |
| Status from evidence; adapters/constraints cap at partial | `decideStatus` | `verdict.test.ts`; Docker proof (pyts → partially_reproduced) |

## K. Real paper

| Requirement | Source | Proof |
|---|---|---|
| Positive case (pyts, JMLR 2020, Table 2, GunPoint) | `acceptance/cases/pyts-boss-gunpoint.json` | manual run observed 1.000; Docker proof `verify-study-docker.mjs` 14/14 (scripted model) |
| Negative case (CCS survey repository) | `acceptance/cases/ccs-reproducibility-survey.json` | live (pending key) |
| Sanitized acceptance report | `apps/api/scripts/accept-real-paper.mjs` → `artifacts/acceptance/` | live (pending key) |

## K2. Reviewed claim targets

| Requirement | Source | Proof |
|---|---|---|
| Server-owned registry, optional case id or unique exact-paper-hash selection | `config/reviewed-targets/`, `loadReviewedTargets`, `server.ts` (`reviewedCaseId`) | `api.test.ts` reviewed-case refusal, exact-hash auto-selection, and ambiguous-paper tests |
| Paper hash, repository and commit, excerpt on the page with the value | `checkTargetPaper`, `loadClaimTarget`, `targetViolations` | `targets.test.ts` |
| No observed result to Engineers or Reviewers; analysts and Planner get only their view | `paperAnalystTarget`, `repositoryAnalystTarget`, `plannerTarget` | `targets.test.ts`; `api.test.ts` "studies a reviewed claim target …"; Docker proof check 3 |
| Agents may reject the target; no silent claim switch | `TARGETED_INSTRUCTIONS`, `claimMismatch` | `api.test.ts` "stops before planning when the Paper Analyst returns a different claim"; `targets.test.ts` BOSSVS listing |
| Cannot bypass policy, execution or review; never relaxes policy | `reviewPolicy({ target })` | `targets.test.ts` "never relaxes policy" and "refuses a plan that strays …" |
| Maximum honest verdict | `decide` in `study.ts` | Docker proof (pyts → partially_reproduced) |
| Second target: Urban Land Cover RF (paper hash, commit, page/value, adapter hash, dataset URL+hash+extract, cp312 pins, JSON parser, statuses) | `config/reviewed-targets/urban-land-cover-random-forest.json`, `acceptance/cases/urban-land-cover-random-forest.json`, `acceptance/proof/urban_land_cover_runner.py` | `targets.test.ts` "the Urban Land Cover reviewed target"; `check-reviewed-target.mjs`; Docker proof with the case path (Mac) |
| Reviewer gets claim evidence, commit, notebook evidence, adapter text+hash, differences, command, dataset checksum, manifest, logs, artifact, metric | `study.ts` reviewing stage inputs; Reviewer instructions in `roles.ts` | Docker proof "independent review ran"; real acceptance |
| Acceptance refuses before spending tokens when the dataset host is not allowed | `accept-real-paper.mjs` (`/api/health` `datasetHosts`) | manual |

## M. AWS-ready boundaries

| Requirement | Source | Proof |
|---|---|---|
| LabWorker, ArtifactStore, JobDispatcher, SecretProvider with local implementations | `services/lab-manager/src/worker.ts`, `apps/api/src/boundaries.ts` | `ports.test.ts` "deployment boundaries" |
| Design document | `docs/AWS_DEPLOYMENT_DESIGN.md` | review |
