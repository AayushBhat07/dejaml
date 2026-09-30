# DéjàML Research Runtime

Runs Paper Analyst and Code Analyst concurrently, reconciles their validated outputs through Lead Researcher, and applies a deterministic experiment-policy gate without exposing private reasoning.

## Runtime choices

- `HostedModelClient` is the application path. It connects to a
  server-configured OpenAI-compatible endpoint and keeps separate in-process
  transcripts per run/role; no OpenClaw installation or agent setup is needed.
- `OpenClawGatewayStructuredClient` and `OpenClawStructuredClient` remain
  legacy adapters for explicit compatibility experiments. The API does not use
  them.
- The Lab Agent chooses bounded lab actions through the application loop;
  the Lab Manager owns execution and validates the approved plan.

OpenClaw source has not yet been embedded. The next runtime extraction must
preserve upstream and third-party notices.

Curated examples may provide a visible model/dataset/metric target hint to both concurrent analysts. The hint narrows selection but never overrides evidence; either analyst must return `inconclusive` when the target is unsupported.

## Evidence limits

- prioritized paper evidence: 180,000 characters total, 24,000 per page;
- repository evidence: 500,000 transmitted characters and 80 files; ordinary files are capped at 250,000 raw bytes, while notebooks may be up to 10 MiB before outputs are stripped;
- ignore symlinks, data/output/build directories, credential-like files, and binary files;
- strip notebook outputs and redact common token formats;
- cross-check returned page references, repository identity, commit, file paths, and file hashes.

## Autonomous Lab Agent

`runAutonomousLabAgent` drives one disposable lab for a paper that has no reviewed case. Each turn the model returns one action:

- `run`: any argv inside the lab, wrapped in its own `timeout` so a hung step fails without killing the lab;
- `write_file`: a file under the scratch folder, written inside the container with `O_NOFOLLOW` so a planted symlink cannot reach the host;
- `submit`: the JSON metric file under `artifacts/` and the key holding the value;
- `give_up`: a concrete reason.

The lab holds the repository read-only at `repo/`, a writable `work/`, and `artifacts/`. It has no network, a read-only root, no capabilities, and fixed CPU, memory, PID, step, and wall-time budgets.

A submission is accepted only when a successful `run` step produced the file's current digest, that step was not a plain writer such as `echo` or `cp`, and the measured value does not appear literally in the agent's command or files. The lab is paused before the file is exported. The verifier then compares the value with the paper, and the Audit Agent receives the agent's files and steps.

### Independent agents and the Lab Reviewer

The API runs several agents per study (`DEJAML_LAB_REPLICAS`, default 3), each in a fresh lab with its own model session (`agentName`). `reviewLabSubmission` gives each submission to a Lab Reviewer that approves or rejects it. `findConsensus` then requires a majority of approved values within tolerance of each other and picks the median agent as the representative.

Inside each lab the agent works as a team (`team: true`, the API default). After a first look at the repository, the Planner (`planLabWork`) writes the plan the Engineer follows. When a command fails, the Debugger (`diagnoseLabFailure`) reads the output and the Engineer's files and proposes a fix, up to six times per lab. Each role has its own model session.

## Verification

```bash
npm run check
```

The older `verify:curated:live` scripts explicitly exercise the legacy
OpenClaw adapter and are not part of the hosted application path.

To prove the autonomous tools against real Docker with a scripted model (isolation, symlink escape, per-command timeout, failed command, adapter run, freeze, cleanup):

```bash
npm run verify:autonomous:docker --workspace @dejaml/research-runtime
```

With `DEJAML_MODEL`, `DEJAML_MODEL_BASE_URL`, and `DEJAML_MODEL_API_KEY` set, `verify:autonomous:live` lets a real model drive the same lab.
