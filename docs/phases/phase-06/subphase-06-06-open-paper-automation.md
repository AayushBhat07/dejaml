# Sub-phase 6.6 — Any lightweight paper, with no per-paper code

**Status:** `IN PROGRESS` (built and verified with deterministic tests and real Docker; the real-model runs on new papers are pending on the owner's Mac)
**Completed:** `—`
**Commit:** `fill after the real-model runs`
**Owner:** `Claude`

## Objective

A person uploads any lightweight ML paper whose code is public, and the study
runs it with nothing written for that paper: no reviewed case, runner, adapter
or case file. The agents choose the claim, find the code and data, plan the
environment and command, run it in the offline lab and compare the result with
the sealed claim. A paper that cannot be run ends with an evidence-backed
`policy_blocked`, `inconclusive` or `failed`, never a guess.

"Any paper" means any paper whose claim can run on a CPU in minutes, with
Python code in a public GitHub repository and data in the repository, in a
pinned package, or at a public HTTPS archive.

## What blocked open studies before

The 15 October no-target runs (seven papers, real model, no reviewed case)
ended one `partially_reproduced` and six `policy_blocked`. The refusals were
correct, but most were caused by the platform, not the papers:

| Cause | Papers | Fix in this sub-phase |
|---|---|---|
| A download needs a SHA-256 and the Planner had no way to get one | MINIROCKET, MultiRocket, Confound-leakage, RRL | `dataset_probe` tool |
| Nothing was downloadable unless an administrator listed hosts | all downloads | Default research-data allowlist |
| The agents picked large or many-dataset claims over runnable ones | MINIROCKET, MultiRocket, RRL | Claim-feasibility guidance for the Paper Analyst |
| A GitHub link split around `//` or a line break was missed | MultiRocket, envsca | `rejoinGithubLinks` |
| Picking "None" for a paper with a reviewed case was ignored | (bug) | Explicit `reviewedCaseId=none` |
| Skipped stages showed green ticks | (bug) | `stage_skipped` event |
| An out-of-credit provider ended the study `inconclusive` | (bug) | Provider errors end it `failed` |

Notebook-only repositories (common for small papers, and the reason the Urban
Land Cover case needed a hand-written runner) now have a built-in adapter.
R-only and GPU-only code still ends `policy_blocked`, by design.

## Architecture

### Dataset probe (trust zone 3 for the Planner)

`dataset_probe {url, extract}` (`apps/api/src/study/tools.ts`, granted only to
the Reproduction Planner) downloads a dataset once through the same port the
lab's data uses (`localDatasetPort`, net-guard: HTTPS only, allowlisted hosts,
SSRF and redirect checks, 200 MB and time limits, safe extraction). It returns
the SHA-256, size and up to 100 extracted files, posts a `dataset_receipt`
with `probe: true` to the board, emits `dataset_probed`, and deletes the copy.
At most three probes per study.

Policy review (`contract.ts#reviewPolicy`) now takes the study's probes. In an
open study a download is approved only when its URL and SHA-256 match a probe:
a hash a model wrote down is refused before anything is downloaded
(`the dataset's SHA-256 was not observed by DéjàML`). An approved download
carries the warning that it is pinned to the hash DéjàML observed on first
fetch. Preparation downloads again and refuses any other bytes, so the data in
the lab is exactly what the Planner probed. Reviewed targets keep their
reviewed hashes. Host matching now honours `*.suffix` entries, as net-guard
already did.

### Default research-data allowlist

`DEJAML_DATASET_ALLOWED_HOSTS` unset or empty now means
`RESEARCH_DATASET_HOSTS` (`packages/net-guard/src/dataset.ts`): UCI, the UCR/UEA
archive, Zenodo, figshare, GitHub raw and release assets, Hugging Face,
OpenML, the Toronto CIFAR host, PyTorch's MNIST mirror, Google Cloud Storage,
Harvard Dataverse, Dryad, PhysioNet and Kaggle. `none` turns downloads off, and
`default,host.example` extends the list. The lab itself stays offline: only the
host-side dataset zone fetches, and the bytes are hash-pinned and mounted
read-only.

### Built-in adapters

`apps/api/src/study/builtin-adapters.ts` registers project-owned adapters any
plan may name with `adapter: {reviewedAdapterId: "<id>"}`. Each file is pinned
by SHA-256 and the server refuses to start if it changed. The Planner sees each
adapter's id, path, usage and listed differences (`builtinAdapters` input);
code substitutes the hash-checked text, policy and blinding checks run on it
as on any adapter, the blind Reviewer sees its text and differences, and the
result is capped at `partially_reproduced`.

`notebook-runner` (`config/builtin-adapters/notebook_runner.py`) runs a
repository's `.ipynb` as a script: code cells in order in one namespace from
the notebook's directory, a cell's last bare expression printed as Jupyter
would, magics and shell escapes skipped and listed on stderr, matplotlib on
Agg. Saved outputs are never read (the projection strips them anyway). A plan
uses `cwd: work/repo` and `python ../adapter/notebook_runner.py --notebook
<path>`, with a stdout metric parser.

### Claim choice

The Paper Analyst is told to choose, among checkable claims, the one most
likely to run in minutes on 2 CPUs: a single dataset over a mean of many, the
smallest standard dataset, a classical or small model over deep training, and
few runs over long sweeps; never one that needs a GPU, hours, private data or a
language other than Python. The Planner is told the data order of preference
(repository, pinned package, probed download), that code fetching its own data
at run time must read the probed files instead, and when to use a built-in
adapter.

### Fixes

- **Open study for a reviewed paper.** The browser sends
  `reviewedCaseId=none` when the person picks "None"; the server then skips the
  hash auto-match (`server.ts`). A missing field still auto-matches, so older
  browsers keep their protection.
- **Split GitHub links.** `rejoinGithubLinks`
  (`packages/repository-intake`) rejoins `https:\n//github.com/…`,
  `github.\ncom/…`, `owner/\nrepo` and scheme-less `github.com/owner/repo`
  before candidate discovery; lookalike hosts and e-mail addresses stay out.
- **Skipped stages.** `runStage(..., {skip: true})` emits `stage_skipped`
  instead of `stage_started`, so the run page shows "–" for stages a stopped
  study never ran.
- **Provider errors.** When an agent ends on a model provider error and no
  engineer measured anything, the study ends `failed` ("the model provider
  failed: …") instead of `inconclusive`.

## Verification

```text
npm run check
node apps/api/scripts/verify-study-docker.mjs     # whole pyts study with a scripted model, real Docker
python3 config/builtin-adapters/notebook_runner.py --notebook <any .ipynb>
```

**Observed (cloud container, 2026-10-27):**

- `npm run check` passes: 1,109 tests in 12 workspaces, plus build,
  typecheck, lint, format, the native-runtime scan and the script tests.
- New tests: the dataset probe end to end (one unhashed probe, then a
  hash-checked download, `dataset_probed`, the pinned-hash warning) and the
  refusal of a model-written hash with no download at all; the notebook runner
  by id in an open study, capped at `partially_reproduced`; `none` running an
  open study for a reviewed paper; a provider error ending `failed`; skipped
  stages emitted and shown as skipped; split GitHub links; the default
  allowlist, `none` and `default,…`; built-in adapters loading at their pinned
  hash, refusing a changed file, and passing the rigging check.
- `verify-study-docker.mjs` passes 25/25 against real Docker 29.9.2 on
  linux/amd64 (pyts paper, scripted agents, real GitHub and PyPI), and
  `npm run verify:failures -w @dejaml/api` passes all 7 scenarios.
- The notebook runner ran a notebook in the pinned `python:3.11-slim-trixie`
  base image with `--network none`, a read-only root and mount, and user
  65534, and printed the notebook's metric line and last expression.

## Real runs (pending, owner's Mac)

```text
npm run build && npm run start:local
```

Upload papers with no reviewed case and pick "None: the agents choose the
claim". Good first candidates are the MINIROCKET and MultiRocket papers from
the 15 October runs (UCR data, now probe-able from timeseriesclassification.com),
a notebook-only repository, and a small scikit-learn paper whose data is on
UCI or OpenML. Record each run's status and reasons in this note.

## Security assumptions

- The default allowlist trusts the listed archives to serve public data. A
  host that serves anyone's uploads (GitHub, Zenodo, Google Cloud Storage)
  means a paper author chooses the bytes; they are still hashed, size-bounded,
  extracted safely and mounted read-only into a lab with no network.
- Probes run on the API host's network, as preparation downloads already did.
- A built-in adapter is project code, reviewed in this repository and pinned
  by hash; a changed file stops the server.

## Known limitations

- One claim per study; when the chosen claim is infeasible the study stops
  rather than trying the paper's next claim (that would need a new sealed
  target per attempt).
- R, MATLAB and other non-Python code ends `policy_blocked`.
- GPU-only code, source builds and CUDA wheels stay refused. On linux/amd64
  PyPI's `torch` pulls CUDA wheels and is refused; on Apple Silicon (arm64)
  it is CPU-only.
- Data behind a login (Kaggle competitions, some PhysioNet sets) or on a host
  not on the list is refused; an administrator can extend the list.
- The notebook runner does not emulate IPython display hooks beyond printing a
  cell's last expression.

## Next sub-phase

`6.7 — Try the next feasible claim when the first is blocked`
