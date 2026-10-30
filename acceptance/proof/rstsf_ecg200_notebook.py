"""DéjàML reviewed adapter (project-owned, NOT official repository code) for the
r-STSF ECG200 claim.

It executes the code cells of the OFFICIAL notebook history_arxiv/code/r-STSF.ipynb
(stevcabello/r-STSF at b094a6bf4c2bf356b27dd5bac2581c3a7b7fdb11) in order, in one
namespace, from history_arxiv/code (where the notebook expects to run; started from the
repository root, the adapter moves there itself).

The only interventions:
1. The notebook's active dataset line, dset_names = ["ItalyPowerDemand"], selects
   the dataset named on the command line instead (ECG200, which the same notebook
   lists in its commented-out alternative and bundles in sampleUCRdatasets/).
2. The last cell, which writes a timestamped CSV under output/, is skipped; the
   per-run accuracies and their mean are written to the JSON file named by
   --output instead.
Seeds, runs (nruns = 10), d, r, representations and the classifier are unchanged.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import sys
import time

DATASET_LINE = 'dset_names = ["ItalyPowerDemand"]'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--notebook", required=True)
    parser.add_argument("--dataset", default="ECG200")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    # The notebook reads sampleUCRdatasets/ relative to history_arxiv/code; from the
    # repository root, move there (the output path is fixed first, so it stays put).
    args.output = os.path.abspath(args.output)
    code_dir = os.path.join("history_arxiv", "code")
    if not os.path.isfile(args.notebook) and os.path.isfile(os.path.join(code_dir, args.notebook)):
        os.chdir(code_dir)

    notebook = json.load(open(args.notebook))
    sys.path.insert(0, os.getcwd())
    ns: dict = {"__name__": "__main__"}
    cells = [cell for cell in notebook["cells"] if cell["cell_type"] == "code"]
    started = time.time()
    replaced = False
    for index, cell in enumerate(cells):
        source = "".join(cell["source"])
        if index == len(cells) - 1 and "to_csv" in source:
            print("[dejaml] skipped the notebook's CSV-writing cell", flush=True)
            continue
        if DATASET_LINE in source:
            source = source.replace(DATASET_LINE, f"dset_names = [{args.dataset!r}]", 1)
            replaced = True
            print(f"[dejaml] dataset restricted to {args.dataset}", flush=True)
        exec(compile(source, f"{args.notebook}#cell{index}", "exec"), ns)
    if not replaced:
        raise SystemExit("the notebook's dataset line was not found; the adapter refuses to guess")

    runs = [float(value) for value in ns["accuracies"][0]]
    result = {
        "dataset": args.dataset,
        "metrics": {
            "accuracyPercentMean": round(100 * sum(runs) / len(runs), 4),
            "accuracyPerRun": runs,
            "runs": len(runs),
        },
        "wallSeconds": round(time.time() - started, 2),
        "peakRssKb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
    print(f"[dejaml] wrote {args.output}")


if __name__ == "__main__":
    main()
