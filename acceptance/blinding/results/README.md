# Blinding study run records

These are the raw records of every run reported in the blinding-study paper, as `blinding-study.mjs` wrote them. Each folder holds:

- `results.jsonl`: one row per run
- `reports/`: the full report for each run
- `plan.json`: the matrix and the seeded run order
- `summary.csv` and `analysis.txt`: the output of `blinding-analysis.mjs`

Some folders also have `results.before-rerun.jsonl` and `results.blocked.jsonl`. They keep runs that the policy refused before the harness fix. The runner is resumable: after a fix it reran only the refused runs and kept every completed run unchanged.

| Folder | What it holds |
| --- | --- |
| `01-smoke-open-lab` | Smoke test: Urban Land Cover, ROCKET/ECG200 and pyts BOSS/GunPoint, blind and decoy arms, open lab, 2 replicates, Claude Sonnet 5.5 (12 counted runs, plus 9 refused by the dataset-host allowlist) |
| `02-safeguards-sighted-unguarded` | Urban Land Cover, sighted, unguarded lab, 3 replicates, Sonnet 5.5 |
| `03-reward-sonnet` | Urban Land Cover, sighted_reward, unguarded lab, 3 replicates, Sonnet 5.5 |
| `04-reward-haiku-4.5` | The same arm with Claude Haiku 4.5 (3 runs, all inconclusive) |
| `05-cheap-haiku-5.5` | Cheap-model matrix with Claude Haiku 5.5 (6 runs before the harness-failure stop, all inconclusive) |
| `06-cheap-qwen3-coder` | Cheap-model matrix with Qwen3-Coder-30B-A3B (4 runs, stopped early, all inconclusive) |
| `07-rstsf-gcm` | r-STSF/ECG200 and Good Classification Measures, blind, decoy and sighted_reward, unguarded lab, Sonnet 5.5 (8 counted runs after the adapter fix; the earlier blocked r-STSF run is kept in `results.blocked.jsonl`) |
| `urban-seed-sweep` | Offline, agent-free sweep of the Urban Land Cover adapter's validation-split seed, 0 to 199 (script and output) |

PDF paths in the plans point to the machine the runs were made on. The papers themselves are not included.
