# Hosted agent worker: implementation boundary

This document records the next build stages after the experimental Lab Agent
tool loop. It does not claim that DéjàML is deployed or supports unknown papers.

## Deployment shape

- Public web/API: authenticated upload, run lookup, and event stream; never
  mounts a Docker socket. Serve only over HTTPS.
- Durable job queue and run store: persists input references, status, and
  evidence so a browser disconnect or API restart does not lose a run.
- Isolated lab worker: the only service allowed to control the container
  runtime. It owns approved inputs, CPU/memory/time budgets, cancellation,
  artifact export, and verified cleanup.
- Object storage: paper PDFs, approved repository snapshots, logs, reports,
  and artifact hashes. No provider credentials enter experiment containers.
- Agent worker: separate paper, code, lead, lab, and verifier sessions. One
  server-side provider is the default. Per-user provider keys are later work.

The initial hosted service should run only one lab at a time. More agents do
not imply more simultaneous training jobs.

## Migration checkpoints

1. The API now uses an in-process model client and creates isolated run
   sessions automatically. Evaluate which OpenClaw runtime source modules
   can be reused in the agent worker without bringing its CLI, Gateway,
   channel system, or global user configuration into the deployed app.
   Pin the source revision and preserve upstream/third-party notices.
   *(2026-09-30: superseded. DéjàML's own runtime, `packages/agent-runtime`,
   is the agent worker; OpenClaw is not required and not used.)*
2. Move Lab Agent's typed actions to that runtime's native tool registration surface.
   Keep the Lab Manager as the policy-enforcing executor. Do not expose the
   host shell or Docker socket to the model.
3. Move HTTP request processing off the long-running experiment: enqueue a
   run, return its ID, and let the worker publish append-only events.
4. Make the upload and evidence artifacts durable, add authentication and
   quotas, then deploy web/API and lab worker separately.
5. Add a second reviewed CPU case before widening plan policy. A new case
   must demonstrate the agent selecting a different entry point and interpreting
   a real failed attempt. Repairs need an explicit preparation image, pinned
   dependencies, a bounded change policy, and baseline/retry separation.

## Hosted acceptance

A fresh browser session can upload a paper and obtain an evidence-backed
report without installing Node, Docker, Python, or OpenClaw locally. A server
restart during a run leaves a recoverable job; cancellation removes the lab.
The report identifies the actual provider, repository commit, image digest,
exact command, outputs, metric source, and cleanup receipt.
