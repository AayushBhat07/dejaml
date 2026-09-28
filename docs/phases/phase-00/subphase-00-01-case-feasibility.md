# Sub-phase 0.1 — Curated Case Feasibility

**Status:** `DONE`  
**Completed:** `2026-09-28`  
**Commit:** `initial repository commit; resolve with git log`  
**Owner:** `Codex`

## Objective

Prove that a real lightweight paper, linked repository, public dataset, numeric claim, and CPU experiment can anchor the DéjàML demo.

## Delivered

- Selected *Tabular Deep Learning vs Classical Machine Learning for Urban Land Cover Classification*.
- Verified that the paper directly links `https://github.com/mtesha/tdl-vs-ml-urbanlandcover`.
- Identified the Random Forest claim: `81.66%` test accuracy and `0.81` macro F1.
- Downloaded and inspected the official UCI Urban Land Cover dataset.
- Confirmed 168 training rows, 507 test rows, 147 features, and 9 classes.
- Shallow-cloned and inspected the repository notebook and dependency file.
- Executed the notebook-equivalent Random Forest logic on CPU.
- Identified a filename mismatch between the repository and official dataset.
- Identified that the paper states fixed seeds while the notebook leaves the validation split seed unspecified.
- Repeated the fast experiment ten times and observed test accuracy from `77.12%` to `81.85%`.
- Ran a deterministic seed-42 attempt and observed `79.88%` accuracy.

## Source evidence

- Paper: `https://arxiv.org/abs/2609.19010`
- Repository: `https://github.com/mtesha/tdl-vs-ml-urbanlandcover`
- Dataset: `https://archive.ics.uci.edu/dataset/295/urban+land+cover`
- Paper Table 2: Random Forest accuracy `81.66%`, precision `0.81`, recall `0.83`, F1 `0.81`, AUC `0.97`.

## Decisions and deviations

- The demo will report the deterministic seed-42 attempt rather than search for a seed that happens to match the paper.
- The system will record the official-to-repository filename adaptation as a preparation change.
- Result variability is a product finding, not an error to conceal.
- The initial case reproduces only the Random Forest claim, not every model in the paper.

## Verification

The feasibility spike used an ephemeral environment with `pandas`, `scipy`, and `scikit-learn`. The deterministic seed-42 run produced:

```text
accuracy=79.88%
```

Ten notebook-style runs with an unspecified validation seed produced:

```text
78.70 81.46 79.49 80.08 77.12 81.85 80.28 79.29 80.67 80.87
```

## Known limitations

- The spike did not execute inside the final Docker lab because the local Docker daemon was not available during initial validation.
- The upstream notebook contains interactive plotting and environment assumptions that should not be used directly as the production runner.
- The paper does not identify the exact validation-split seed used for the reported value.

## Restore procedure

1. Download paper `2609.19010` from arXiv.
2. Shallow-clone the linked repository.
3. Download UCI dataset 295.
4. Install the case dependencies in an isolated environment.
5. Run the deterministic case runner once with seed 42.
6. Confirm that the output contains a numeric accuracy and records the paper/repository discrepancy.
7. When Docker is available, repeat through the pinned lab image before treating the demo as fully restored.

## Remaining work

- Package the case manifest and deterministic runner.
- Pin the upstream repository commit and dataset digest.
- Prove the same result through the Lab Manager.

## Next sub-phase

`0.2 — Architecture baseline`
