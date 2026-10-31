"""DéjàML reviewed adapter (project-owned, NOT official repository code) for the
Good Classification Measures Table 4 Acc-vs-BA claim.

It runs the OFFICIAL script meteo_inversion_matrix.py (yandex-research/
classification-measures at 210fbc107d5f41e64cc4e6990f0b970973d25995) unchanged,
with the argument "full" (all 12 forecast horizons), from the repository root.
The script prints the number of compared cases and a matrix of discordant counts;
the adapter reads the same two quantities from the script's namespace and writes
100 x (Acc-vs-BA discordant cases) / (all cases) to the JSON file named by --output.
"""

from __future__ import annotations

import argparse
import json
import os
import runpy
import sys
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", default="meteo_inversion_matrix.py")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    started = time.time()
    sys.argv = [args.script, "full"]
    ns = runpy.run_path(args.script, run_name="__main__")
    total = len(ns["found_examples"])
    discordant = len(ns["discr_examples"][("acc", "ba")])
    result = {
        "metrics": {
            "inconsistencyPercent": round(100 * discordant / total, 6),
            "discordantCases": discordant,
            "totalCases": total,
        },
        "wallSeconds": round(time.time() - started, 2),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
    print(f"[dejaml] wrote {args.output}")


if __name__ == "__main__":
    main()
