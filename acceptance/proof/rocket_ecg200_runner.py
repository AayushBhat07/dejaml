#!/usr/bin/env python3
"""DéjàML reviewed adapter (project-owned, NOT official repository code) for
the ROCKET ECG200 experiment.

The upstream ``reproduce_experiments_ucr.py`` assumes its dataset-name file
contains more than one row: NumPy returns a scalar for a one-row file and the
script fails before running the experiment.  This adapter keeps the upstream
algorithm, estimator, fixed UCR split, number of kernels, number of runs, and
population-standard-deviation calculation, but selects one dataset explicitly
and writes the aggregate and per-run measurements to a JSON artifact.

It imports the pinned repository's ``rocket_functions`` module at runtime, so
the random-kernel transform is still the authors' code.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import platform
import sys
import time
from pathlib import Path
from types import ModuleType

import numba
import numpy as np
import sklearn
from sklearn.linear_model import RidgeClassifierCV


def existing_file(value: str) -> Path:
    path = Path(value).resolve()
    if not path.is_file():
        raise argparse.ArgumentTypeError(f"expected an existing file: {value}")
    return path


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return parsed


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_rocket(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("dejaml_upstream_rocket", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load upstream ROCKET module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rocket-functions", required=True, type=existing_file)
    parser.add_argument("--training", required=True, type=existing_file)
    parser.add_argument("--testing", required=True, type=existing_file)
    parser.add_argument("--runs", type=positive_integer, default=10)
    parser.add_argument("--kernels", type=positive_integer, default=10_000)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    started = time.monotonic()
    rocket = load_rocket(args.rocket_functions)

    training_data = np.loadtxt(args.training)
    testing_data = np.loadtxt(args.testing)
    y_training = training_data[:, 0].astype(np.int32)
    x_training = training_data[:, 1:]
    y_test = testing_data[:, 0].astype(np.int32)
    x_test = testing_data[:, 1:]
    if x_training.shape[1] != x_test.shape[1]:
        raise ValueError("training and test time-series lengths differ")

    accuracies: list[float] = []
    durations: list[float] = []
    for _ in range(args.runs):
        run_started = time.monotonic()
        kernels = rocket.generate_kernels(x_training.shape[-1], args.kernels)
        x_training_transform = rocket.apply_kernels(x_training, kernels)
        x_test_transform = rocket.apply_kernels(x_test, kernels)
        classifier = RidgeClassifierCV(
            alphas=np.logspace(-3, 3, 10), normalize=True
        )
        classifier.fit(x_training_transform, y_training)
        accuracies.append(float(classifier.score(x_test_transform, y_test)))
        durations.append(time.monotonic() - run_started)

    values = np.asarray(accuracies, dtype=np.float64)
    result = {
        "schemaVersion": 1,
        "caseId": "rocket-ecg200",
        "protocol": "upstream ROCKET transform with a reviewed single-dataset adapter",
        "inputs": {
            "training": {
                "rows": int(x_training.shape[0]),
                "seriesLength": int(x_training.shape[1]),
                "sha256": sha256_file(args.training),
            },
            "testing": {
                "rows": int(x_test.shape[0]),
                "seriesLength": int(x_test.shape[1]),
                "sha256": sha256_file(args.testing),
            },
        },
        "experiment": {
            "runs": args.runs,
            "kernelsPerRun": args.kernels,
            "accuracies": accuracies,
        },
        "metrics": {
            "accuracyMean": float(values.mean()),
            "accuracyPopulationStandardDeviation": float(values.std()),
        },
        "runtime": {
            "durationSeconds": round(time.monotonic() - started, 3),
            "perRunSeconds": [round(value, 3) for value in durations],
            "python": platform.python_version(),
            "numpy": np.__version__,
            "numba": numba.__version__,
            "scikitLearn": sklearn.__version__,
        },
    }

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print("DEJAML_RESULT=" + json.dumps(result["metrics"], separators=(",", ":")))
    print(f"DEJAML_ARTIFACT={output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"DEJAML_ERROR={type(error).__name__}: {error}", file=sys.stderr)
        raise
