#!/usr/bin/env python3
"""Run the deterministic DéjàML Urban Land Cover Random Forest case."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import scipy
import sklearn
from scipy.stats import zscore
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, precision_recall_fscore_support
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def existing_csv(value: str) -> Path:
    path = Path(value).resolve()
    if not path.is_file() or path.suffix.lower() != ".csv":
        raise argparse.ArgumentTypeError(f"expected an existing CSV file: {value}")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--training", required=True, type=existing_csv)
    parser.add_argument("--testing", required=True, type=existing_csv)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    started = time.monotonic()

    training = pd.read_csv(args.training)
    testing = pd.read_csv(args.testing)
    if "class" not in training.columns or "class" not in testing.columns:
        raise ValueError("both datasets must contain a 'class' target column")
    if list(training.columns) != list(testing.columns):
        raise ValueError("training and testing columns do not match")

    encoder = LabelEncoder()
    y_full = encoder.fit_transform(training["class"])
    y_test = encoder.transform(testing["class"])
    x_full = training.drop(columns=["class"])
    x_test = testing.drop(columns=["class"])

    x_train, _, y_train, _ = train_test_split(
        x_full,
        y_full,
        test_size=0.1,
        random_state=args.seed,
        stratify=None,
    )

    # This deliberately mirrors the repository notebook. The paper describes
    # reuse of training statistics, while the notebook normalizes each split
    # independently. DéjàML reports that mismatch instead of silently fixing it.
    x_train_scaled = pd.DataFrame(
        x_train.apply(zscore, axis=0), columns=x_train.columns
    )
    x_test_scaled = pd.DataFrame(
        x_test.apply(zscore, axis=0), columns=x_test.columns
    )

    model = RandomForestClassifier(
        n_estimators=30,
        max_depth=5,
        min_samples_split=5,
        min_samples_leaf=3,
        max_features="log2",
        bootstrap=True,
        random_state=42,
    )
    model.fit(x_train_scaled, y_train)
    predictions = model.predict(x_test_scaled)

    accuracy = accuracy_score(y_test, predictions)
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_test, predictions, average="macro", zero_division=0
    )

    result = {
        "schemaVersion": 1,
        "caseId": "urban-land-cover-random-forest",
        "protocol": "repository-deterministic",
        "seed": args.seed,
        "inputs": {
            "training": {
                "rows": len(training),
                "sha256": sha256_file(args.training),
            },
            "testing": {
                "rows": len(testing),
                "sha256": sha256_file(args.testing),
            },
            "features": len(training.columns) - 1,
            "classes": len(encoder.classes_),
        },
        "metrics": {
            "accuracy": float(accuracy),
            "accuracyPercent": round(float(accuracy) * 100, 2),
            "macroPrecision": round(float(precision), 4),
            "macroRecall": round(float(recall), 4),
            "macroF1": round(float(f1), 4),
        },
        "paperComparison": {
            "paperAccuracyPercent": 81.66,
            "signedDifferencePercentagePoints": round(
                float(accuracy) * 100 - 81.66, 2
            ),
        },
        "runtime": {
            "durationSeconds": round(time.monotonic() - started, 3),
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scipy": scipy.__version__,
            "scikitLearn": sklearn.__version__,
        },
        "warnings": [
            "Validation split seed 42 is a DéjàML choice; the upstream notebook leaves it unspecified.",
            "Validation splitting and scaling mirror repository code, including documented paper/code discrepancies.",
        ],
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
    except Exception as error:  # Keep the lab's terminal failure explicit.
        print(f"DEJAML_ERROR={type(error).__name__}: {error}", file=sys.stderr)
        raise

