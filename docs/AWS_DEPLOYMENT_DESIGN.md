# AWS deployment design (not deployed)

Status: design only. Nothing here has been deployed, and no AWS SDK is a
dependency. The code already separates the pieces below behind interfaces
with local implementations, so a deployment adds adapters without changing
the orchestrator.

## Mapping

| Concern | Local implementation (today) | Interface | AWS target |
|---|---|---|---|
| Web/API | `apps/api` Node server on 127.0.0.1 | HTTP API | ECS Fargate service behind an ALB (authenticated) |
| Job dispatch | `InProcessJobDispatcher` (`apps/api/src/boundaries.ts`) | `JobDispatcher` | SQS standard queue plus a dead-letter queue |
| Agent workers | same process as the API | `runMultiAgentStudy` | ECS service consuming the queue |
| Lab creation | `LabManager` with the Docker CLI | `LabWorker` (`services/lab-manager/src/worker.ts`) | dedicated EC2 capacity (ECS on EC2 or plain EC2), one lab host role |
| Artifacts | `LocalArtifactStore` (files under the data dir) | `ArtifactStore` | S3 bucket, SSE-KMS, per-run prefix |
| Metadata | SQLite `RunStore` (runs, events, ledger, stages) | `RunStore` | PostgreSQL on RDS (same tables) |
| Provider keys | process environment | `SecretProvider` (`withSecrets`) | AWS Secrets Manager, read by the agent worker only |
| Wheel preparation | `DependencyPreparer` (Docker) | `DependencyPort` | runs on the lab hosts, in its own egress-restricted network |
| Datasets | `localDatasetPort` (net-guard) | `DatasetPort` | runs on the lab hosts; allowlisted HTTPS egress only |
| Lab images | `ImageReadiness` | `LabImagePort` | ECR repository with immutable tags; digests pinned |

The API process never needs the Docker socket: every Docker call is behind
`LabWorker`, `DependencyPort` and `LabImagePort`, which run on lab hosts. The
local leak check in `study.ts` (a `docker ps` after cleanup) moves to the lab
worker with them.

## IAM boundaries

- **API task role:** send to the job queue; read and write run metadata; read
  artifacts under `runs/*` for reports. No Secrets Manager access, no ECR
  push, no EC2 control.
- **Agent worker task role:** receive and delete from the job queue; read the
  two provider-key secrets (`dejaml/openai`, `dejaml/anthropic`) by ARN; write
  run metadata; call the lab worker API. It cannot reach Docker.
- **Lab host instance role:** pull from ECR (read only); write artifacts under
  its run's prefix; no Secrets Manager, no metadata-database credentials beyond
  its own lab-status table if one is added. IMDSv2 required with hop limit 1,
  so containers cannot reach instance credentials.
- **Humans:** break-glass role with MFA; no long-lived access keys.

## VPC boundaries

- Private subnets for everything but the ALB. No public IPs on tasks or hosts.
- Security groups: ALB → API only; API → RDS and the queue endpoint; agent
  workers → RDS, SQS, Secrets Manager (VPC endpoints) and the provider APIs
  through the egress proxy; lab hosts → ECR/S3 endpoints and, for the prep and
  dataset zones only, the egress proxy.
- Lab containers run with `--network none`; they have no route anywhere.
- Prep containers run on an internal Docker network whose only exit is the
  egress proxy (as today).

## Egress policy

- One egress proxy (for example an ECS service running an allowlisting proxy,
  or AWS Network Firewall with domain lists):
  - agent workers: `api.openai.com`, `api.anthropic.com`, the configured custom
    endpoint, and `github.com` for repository acquisition;
  - prep containers: the administrator's package index hosts only
    (`pypi.org`, `files.pythonhosted.org` by default);
  - dataset fetcher: the administrator's dataset host allowlist only.
- No other outbound traffic. The instance metadata service is unreachable from
  containers.

## Queue semantics

- One message per job (`{runId, kind: "study" | "resume"}`); the paper and
  inputs live in the metadata store and S3, not in the message.
- Visibility timeout longer than a stage lease; workers extend it while the
  study runs (heartbeat), matching the stage lease in `StudyStages`.
- A crashed worker's message becomes visible again; the next worker calls
  `recoverAfterRestart` semantics for that run: running stages fail with
  `process_restart`, completed stages are kept, and the study resumes.
- The stage machine makes redelivery safe: a completed stage is never rerun
  without a typed invalidation, and one owner holds each stage's lease.
- After three receives the message goes to the dead-letter queue and the run
  is marked `failed` by a small reaper.
- Cancellation is a metadata flag plus a message to the owning worker; the
  worker aborts its signal, which propagates to agents, prep, datasets and labs.

## Cleanup

- Every lab, prep container and network is labelled with its run id; the lab
  host runs `cleanupOrphans` at start and on a timer, and after each job.
- S3 lifecycle rules expire exported artifacts after the retention period;
  wheelhouses and dataset copies never leave the lab host and are removed at
  the end of each study (as today).
- A per-run cleanup receipt is stored with the report.

## Observability

- Structured run events (already persisted) are also emitted to CloudWatch
  Logs, without payloads that could hold secrets (keys are never in events).
- Metrics: queue depth, study duration by stage, lab CPU/RAM samples (already
  collected), provider tokens and cost, cleanup failures.
- Alarms: DLQ not empty, cleanup verification failed, lab host disk above
  threshold, provider error rate.
- The `/api/health` diagnostics (image readiness, platform) become a worker
  health check.

## Budgets

- AWS Budgets alert on monthly spend; per-environment tags.
- Per-study limits already enforced in code: wall clock, tokens, tool calls,
  CPU, RAM, PIDs, disk quotas for preparation. Provider cost is counted when
  prices are configured.
- A daily study cap per deployment, enforced by the API before enqueueing.

## Incident containment

- A suspected lab escape: drain and terminate the lab host (it holds no
  secrets), rotate nothing else; labs have no credentials to steal.
- A leaked provider key: rotate it in Secrets Manager; only agent workers read
  it, and it never reaches reports, events, the browser or labs.
- A malicious repository or dataset: the run is cancelled, its artifacts are
  quarantined under the run prefix, and the host is recycled.
- All actions are auditable through CloudTrail and the run ledger.

## Platform

Production defaults to `DEJAML_PLATFORM=aws-cpu` (linux/amd64). Graviton
(linux/arm64) is possible by choosing arm64 lab hosts and `linux/arm64`; the
PlatformSpec keeps wheels, images and caches consistent with that choice.
