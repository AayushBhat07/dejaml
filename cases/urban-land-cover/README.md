# Urban Land Cover Random Forest Case

This case reproduces one claim from *Tabular Deep Learning vs Classical Machine Learning for Urban Land Cover Classification*.

## Claim

- Random Forest
- official UCI Urban Land Cover test set
- paper accuracy: `81.66%`
- paper macro F1: `0.81`

## Run locally

From this directory:

```bash
python fetch_data.py
uv run --with-requirements requirements.lock.txt python runner.py \
  --training data/training.csv \
  --testing data/testing.csv \
  --output artifacts/result.json
```

The data and generated artifacts are ignored by Git.

## Interpretation

The deterministic runner intentionally follows the upstream notebook's validation and scaling behavior while fixing its unspecified validation-split seed to `42`. It does not search for a seed that recreates the paper value. Paper/code discrepancies are recorded in `case.json` and in the generated result warnings.

