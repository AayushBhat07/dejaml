# Sub-phase 1.1 — Curated Case Package

**Status:** `DONE`  
**Completed:** `2026-09-28`  
**Commit:** `resolve with git log for curated case package`  
**Owner:** `Codex`

## Objective

Turn the feasibility spike into a deterministic, restorable, machine-readable case package.

## Delivered

- Added a machine-readable case manifest with paper, repository, dataset, claim, protocol, resource, and discrepancy metadata.
- Pinned the upstream repository commit to `49ece7ff4cc43fd4cb258678d44854f1cb2a417d`.
- Pinned the UCI archive digest to `277a27000a4a4b593f655595b92904ccb30ece48b8bb2a35cf5d3854d7204f79`.
- Added a bounded dataset fetcher that validates archive size and digest and extracts only approved members.
- Added a deterministic seed-42 runner that emits machine-readable JSON.
- Pinned the Python dependencies used for the case-level verification.
- Recorded paper/code discrepancies rather than silently fixing them.

## Files changed

- `cases/urban-land-cover/case.json`
- `cases/urban-land-cover/fetch_data.py`
- `cases/urban-land-cover/runner.py`
- `cases/urban-land-cover/requirements.lock.txt`
- `cases/urban-land-cover/README.md`

## Decisions and deviations

- The runner fixes the previously unspecified validation split to seed 42.
- It follows the repository's non-stratified split and per-split z-score behavior, while reporting that both differ from the paper text.
- It does not attempt to reproduce the paper number by searching seeds.
- The Docker execution proof remains Phase 3; this sub-phase proves the deterministic case logic locally.

## Verification

```bash
cd cases/urban-land-cover
python3 fetch_data.py
uv run --quiet --with-requirements requirements.lock.txt python runner.py \
  --training data/training.csv \
  --testing data/testing.csv \
  --output artifacts/result.json
python3 -m json.tool artifacts/result.json
```

**Observed result:**

```text
accuracyPercent=79.88
paperAccuracyPercent=81.66
signedDifferencePercentagePoints=-1.78
trainingRows=168
testingRows=507
features=147
classes=9
```

## Known limitations

- Verification used local Python 3.14.7; the final container will pin a supported Python image separately.
- AUC is not included in the initial deterministic runner because it is not needed for the primary accuracy comparison.
- The final Lab Manager resource and cleanup receipt are not implemented yet.

## Restore procedure

1. Install `uv` and a compatible Python runtime.
2. Run `python3 fetch_data.py`; it must verify the approved archive digest.
3. Run the documented `uv` command.
4. Confirm `artifacts/result.json` exists and reports `79.88` accuracy for seed 42 with the pinned dependencies.
5. If the value changes, record the environment and treat the case as regressed; do not update the expected result without investigation.

## Remaining work

- Validate the case through the pinned Docker lab image.
- Add the shared contract schemas and report transformation.
- Add a test that rejects a modified dataset digest.

## Next sub-phase

`1.2 — Shared contracts`

