# Sub-phase 6.2 — Auto-execution (host preparation)

**Status:** `DONE (schema and pipeline plumbing); end-to-end demo unproven`
**Completed:** `2026-09-28`
**Owner:** `Claude`

## Objective

Allow the Lead Researcher to specify host-side preparation steps (pip install, notebook conversion) that run before the sandboxed lab is created, so papers with notebooks or unpackaged dependencies can be executed without a hand-written adapter.

## Delivered

- **`HostPreparationStepSchema`** in `@dejaml/contracts`:
  - `pip_install`: installs packages from a `requirementsPath` (path relative to repo root) or an explicit `packages` list using `pip install --target site-packages`;
  - `nbconvert`: converts a `notebookPath` notebook to a Python script, writing output to `outputPath/../` (or `converted/` by default).
- **`hostPreparation`** optional field on `ExperimentPlanSchema`.
- **Host preparation phase (4a)** in `apps/api/src/pipeline.ts` (`runHostPreparation`):
  - runs **before** `createLab` so the lab never needs network access;
  - each step runs inside a **disposable Docker container** (`docker run --rm`) using the lab image, keeping untrusted repo code off the host machine;
  - `pip_install` uses `--network bridge` (needs PyPI) and installs to `/repo/site-packages` via `--target`;
  - `nbconvert` uses `--network none` and outputs the converted script into the repo tree;
  - the prep container is destroyed before the offline lab container is created;
  - if any step fails the run ends as `inconclusive` before any lab is created.
- Events: `host_preparation_started`, `host_preparation_completed`, `host_preparation_failed`.

## Security model

The original implementation called `pip` and `jupyter` directly on the Mac, which would have executed untrusted code from the cloned repository with full host access. The Docker-based replacement gives each step only:
- read/write access to the cloned repo directory (bind-mounted as `/repo`);
- outbound network (pip_install only);
- the lab image's Python environment.

No step can read host files outside the repo directory or write to the host outside it.

## Files changed

- `packages/contracts/src/index.ts` — `HostPreparationStepSchema`, `hostPreparation` field on `ExperimentPlanSchema`.
- `apps/api/src/pipeline.ts` — phase 4a (`runHostPreparation`) with Docker-based execution.

## Not yet proven end-to-end

No paper has actually exercised `hostPreparation` yet. The `urban-land-cover` case uses a hand-written `runner.py` and has no notebook or extra dependencies. For a real auto-execution case:

1. The Lead Researcher must emit a plan with `hostPreparation` steps.
2. The lab image must have `pip` and `jupyter` installed.
3. The `runner.py` (or auto-detected entry point) must add `site-packages` to `sys.path` when using pip-installed dependencies.
4. A new case file with `policy.json` and `case.json` must be curated for the target paper.

The `dejaml-lead` agent prompt does not yet instruct the Lead Researcher to emit `hostPreparation`. That update is the next step toward fully automatic execution.

## Verification

```bash
npm run check   # all 59 tests pass, full typecheck clean
# No new test for runHostPreparation because it shells out to Docker,
# which is not available in the cloud CI environment.
```
