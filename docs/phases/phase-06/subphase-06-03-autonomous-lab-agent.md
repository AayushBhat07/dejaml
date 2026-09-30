# Sub-phase 6.3 — Autonomous multi-agent lab (offline)

**Status:** `SUPERSEDED` by 6.4 (`docs/phases/phase-06/subphase-06-04-multi-agent-study.md`)
**Completed:** `2026-09-30`
**Commit:** `fill after commit`
**Owner:** `Claude`

> **Superseded.** 6.4 replaced this path in the API, in the same pull request. It accepted arbitrary model base URLs from uploaders, and its roles were not persisted agents with their own tools, receipts, cancellation and resume. It also had no controlled path for packages or datasets. The library code and `verify:autonomous:docker` still pass, but the API no longer calls them. Rerun the 6.4 checks instead.

## Objective

Let the Lab Agent reproduce a paper that has no reviewed case, without a hand-written runner. It works on its own inside the disposable lab. The lab's isolation is the safety boundary, and nothing leaves the lab without host-side provenance checks.

## Delivered

- **Lab Manager tools.** A lab can have an optional writable `scratchDir` next to its inputs and artifacts. `runCommand` runs any argv under its own in-container `timeout`, so a slow step fails without destroying the lab. It streams output, telemetry, and artifact changes, and returns the artifacts afterwards. `writeScratchFile` writes an agent file from inside the container as the lab user with `O_NOFOLLOW`, so a planted symlink cannot redirect it onto the host. `freezeLab` pauses the container before export.
- **Autonomous Lab Agent** (`runAutonomousLabAgent`). The model chooses one action per turn: `run`, `write_file`, `submit`, or `give_up`. The first prompt is a brief: the Paper Analyst's claim, the Code Analyst's hints, the workspace layout, the installed packages, and the budget. Later prompts carry the latest observation and a one-line summary of recent steps. Budgets cover steps, wall time, per-command time, and three invalid actions in a row.
- **Provenance rules for `submit`.** The metric file must sit under `artifacts/`, and its current digest must come from a successful `run` step that was not a plain writer (`echo`, `cp`, `tee`, and similar). The measured value must not appear literally in the producing command or in any agent-written file. Only then is the lab paused and the file exported. The producing step becomes the recorded baseline attempt.
- **Pipeline path.** When a paper links a GitHub repository that no reviewed case covers and `DEJAML_AUTONOMOUS` is on (the default), the API acquires the repository at its current commit. It runs both analysts without a target hint, records an `autonomy_boundary` event, and mounts the checkout read-only at `repo/` beside `work/` and `artifacts/`. The agent then runs, the Result Verifier compares its metric with the claim (tolerance 2 percentage points, or 0.02 for fractions and scores), and the Audit Agent receives the agent's files and steps. The report gains an `autonomous` section with the transcript, the agent's files, and the submission.
- **Independent agent team.** An autonomous study runs three Lab Agents by default (`DEJAML_LAB_REPLICAS`, 1 to 5). Each gets its own freshly created sealed lab and its own model session, and none sees another's files or results. A **Lab Reviewer** agent reads each submission: the agent's files, the producing command, the metric file, and its steps. It approves only a metric computed honestly on the claimed setup. `findConsensus` then looks for the largest group of approved values within tolerance of each other. A majority must agree (2 of 3); the median agent of that group is verified against the paper and audited. Otherwise the study ends `inconclusive`. The report's `autonomous` section lists every replica with its review, value, transcript, files, and cleanup receipt, plus the consensus.
- **A team inside each lab.** Each lab's agent works as a Planner, an Engineer, and a Debugger. The Planner reads the claim, the analysts' hints, and a listing of the repository, and writes the plan (`planLabWork`). The Engineer carries it out with the lab tools. After a failed command, the Debugger reads the output and the Engineer's files and proposes a fix (`diagnoseLabFailure`, at most six times per lab). Each role has its own model session, and the plan and diagnoses appear in the report.
- **Uploader's own model key.** The website asks for a provider (OpenAI, Anthropic, OpenRouter, Groq, a local Ollama model, or any OpenAI-compatible API), a model name, and an API key before a study can start, unless the server has its own model configured. `GET /api/config` tells the page which applies. The key goes with the upload, is used only in memory by that study's model client, and is never stored, logged, or written to a report; it never enters the lab. Only HTTPS endpoints are accepted, except for a model on localhost.
- **Repository URL field.** The uploader can name the paper's GitHub repository when the PDF doesn't link it. It is validated before anything runs and recorded as provided by the user.
- The Result Verifier and Audit Agent accept the narrower plan they actually read (`claim`, `dataset.name`, `metricExtraction`), so an autonomous run is not dressed up as a reviewed plan.

## Files changed

- `services/lab-manager/src/spec.ts` — optional `scratchDir` with overlap checks.
- `services/lab-manager/src/manager.ts` — scratch mount, `runCommand`, `writeScratchFile`, `freezeLab`.
- `services/lab-manager/src/spec.test.ts` — scratch spec tests.
- `packages/research-runtime/src/autonomous-lab-agent.ts` — the agent loop, action schema, and provenance rules.
- `packages/research-runtime/src/autonomous-lab-agent.test.ts` — agent tests against a real Lab Manager on a simulated runtime.
- `packages/research-runtime/src/lab-reviewer.ts`, `lab-reviewer.test.ts` — Lab Reviewer agent and consensus.
- `packages/research-runtime/src/lab-team.ts`, `model.ts`, `openclaw-client.ts` — Planner and Debugger roles.
- `packages/contracts/src/index.ts`, `apps/web/src/lib/roles.ts` — `lab_reviewer` actor.
- `packages/research-runtime/src/audit.ts`, `prompts.ts` — optional lab-session evidence for the Audit Agent.
- `packages/research-runtime/scripts/verify-autonomous-docker.mjs` — real-Docker proof, plus `--live` for a real model.
- `packages/result-verifier/src/extract.ts`, `assess.ts` — `VerificationPlan` input type.
- `apps/api/src/pipeline.ts` — autonomous study path and report section.
- `apps/api/src/main.ts` — `DEJAML_AUTONOMOUS`, `DEJAML_LAB_REPLICAS`, an optional server model, and the installed package list from the image lock.
- `apps/api/src/server.ts` — `GET /api/config`, uploader model settings, and the repository URL field.
- `apps/web/src/screens/NewStudy.tsx`, `App.tsx`, `lib/run-client.ts`, `styles.css`, `App.test.tsx` — model and key form, repository field.
- `apps/api/src/stand-ins.ts`, `api.test.ts`, `scripts/verify-stack.mjs` — stand-in support and end-to-end API tests, including a key that is required and never persisted.
- `ROADMAP.md`, `.env.example`, `apps/api/README.md`, `packages/research-runtime/README.md` — documentation.

## Decisions and deviations

- **Offline first** (chosen by aayush on 2026-09-30). The lab never gets network access, so the agent cannot install packages or download data. This keeps the reviewed isolation from 6.2's regression intact. A PyPI and dataset allowlist in a separate preparation container is future work.
- The lab's isolation replaces the per-case command policy on this path. Model-chosen commands can only touch the lab: no network, a read-only root and repository, no capabilities, `no-new-privileges`, and CPU, memory, and PID limits.
- The literal-value check is a heuristic. It ignores values with fewer than three significant digits to avoid false alarms on constants such as `0.5`. The Audit Agent is the second line of review for fabricated metrics.
- Curated cases keep their reviewed path unchanged; the autonomous path runs only when no case matches.

## Verification

```text
npm run check
npm run verify:autonomous:docker --workspace @dejaml/research-runtime
npm run verify:docker --workspace @dejaml/lab-manager
npm run verify:failures --workspace @dejaml/api
```

**Observed result (cloud container, Docker 29.3.1, x86_64):**

- `npm run check`: 127 tests passed, typecheck clean. The API tests confirm the uploader's key appears in no event, report, or stored file.
- `verify:autonomous:docker` passed. Inside the lab the agent ran as UID 10001; network, repository writes, root writes, and the Docker socket were all blocked. A write through a symlink planted toward a host file was refused, and the host file stayed untouched. `sleep 30` with a 2-second limit exited 137 after 2.1 s and the lab continued. A failing command reported exit 2 with its error. The agent-written adapter ran the repository's model and produced `test_accuracy` 0.96 at step 9. The lab was paused before export, and cleanup was verified with no remaining container. Two more agents then ran at the same time in separate containers, each starting with empty `work/` and `artifacts/` and using its own model session. All three measured 0.96, and consensus reported agreement.
- The New Study form was checked in a browser against the stand-in stack with no server model: it asks for provider, model, and API key, and Start stays disabled until they are filled.
- `verify:docker` and `verify:failures` still pass with 0 remaining lab containers.

## Known limitations

- One claim per study. The brief asks about individual experiments; several claims per paper is not done yet.
- Offline only: papers that need extra packages, a GPU, or a dataset download end as `inconclusive` with the agent's reason.
- No run with a real model has happened yet; the proofs use a scripted model, including for the Lab Reviewer.
- Replicas in the API run one after another, so an autonomous study takes about three times as long as one agent. Run `verify:autonomous:live` with model credentials to check real agent behaviour.
- The repository is acquired at its current commit, not a reviewed one.
- Honest metric computation is checked by provenance rules and the Audit Agent, not proven.

## Restore procedure

1. Start Docker and build the workspaces with `npm run build`.
2. Run `npm run check`.
3. Run `npm run verify:autonomous:docker --workspace @dejaml/research-runtime`.
4. Expect "Autonomous Lab Agent Docker proof passed." and `verifiedAbsent: true`.

## Remaining work

- Run the agent with a real model on a second lightweight paper whose repository bundles its data.
- A separately pinned preparation container with a PyPI and dataset allowlist (see 6.2's requirements).
- Web UI: show the agent's steps and files on the Virtual Lab screen. Today they arrive as generic lab events.

## Next sub-phase

`6.4 — Allowlisted preparation container`
