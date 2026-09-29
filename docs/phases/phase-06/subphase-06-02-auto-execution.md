# Sub-phase 6.2 — Auto-execution (host preparation)

**Status:** `REGRESSED / BLOCKED`
**Completed:** `2026-09-28`
**Regressed:** `2026-09-29` in commit `0b4168a`
**Owner:** `Claude`

## Objective

Allow the Lead Researcher to specify host-side preparation steps (pip install, notebook conversion) that run before the sandboxed lab is created, so papers with notebooks or unpackaged dependencies can be executed without a hand-written adapter.

## Historical implementation

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

## Why it was removed

The merge review found that this path did not meet DéjàML's deterministic approval boundary:

- the Lead Researcher could propose steps that the policy gate did not validate or allowlist;
- the repository checkout was deleted before the preparation code ran;
- the locked lab image intentionally has no `pip`, `ensurepip`, or Jupyter;
- model-provided paths and package specifications were not bounded;
- the preparation containers lacked the lab's CPU, memory, PID, capability, and `no-new-privileges` controls;
- the dependency-install step enabled general outbound network access.

The schema and execution path were removed rather than shipping a feature that was both unproven and outside the reviewed trust boundary. The curated adapter flow remains unchanged and offline.

## Regression files

- `packages/contracts/src/index.ts` — removed `HostPreparationStepSchema` and the plan field.
- `apps/api/src/pipeline.ts` — removed the host-preparation execution path.
- `ROADMAP.md` — restored the feature to blocked status.

## Requirements before restoration

Before this sub-phase can return to `DONE`, it needs:

1. a separate, digest-pinned preparation image with only the required tools;
2. an exact case-policy allowlist for every step, package, checksum, input path, and output path;
3. traversal-safe path schemas and argument validation;
4. CPU, memory, PID, timeout, capability, filesystem, and egress limits;
5. immutable dependency inputs or a recorded lock artifact;
6. unit, policy-tampering, real-Docker, cleanup, and end-to-end case proofs.

## Verification

After removal, rerun `npm run check`, `npm audit --audit-level=moderate`, the Lab Manager Docker verification, and the API failure-path verification. A future restoration must add dedicated preparation-container tests rather than relying on the general suite.
