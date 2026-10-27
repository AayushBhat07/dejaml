#!/usr/bin/env python3
"""DéjàML built-in adapter (project-owned, NOT official repository code):
runs a repository's Jupyter notebook as a script, offline and headless.

Many lightweight papers publish their experiment only as a notebook. This
adapter executes the notebook's own code cells, in order, in one namespace,
the way a kernel would. It changes nothing in the method, data or metric:

- IPython magics (`%...`, `%%...`) and shell escapes (`!...`) are skipped and
  listed on stderr, because the lab has no IPython and no network;
- like a notebook, the value of a cell's last bare expression is printed;
- matplotlib uses the non-interactive Agg backend, so plots never block;
- the notebook runs from its own directory, so its relative paths resolve.

Saved outputs in the notebook are never read: only code cells are executed.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys
from pathlib import Path


def code_cells(notebook: Path) -> list[str]:
    document = json.loads(notebook.read_text(encoding="utf-8"))
    cells = document.get("cells")
    if cells is None:
        # nbformat 3 keeps cells under worksheets.
        cells = [cell for sheet in document.get("worksheets", []) for cell in sheet.get("cells", [])]
    sources = []
    for cell in cells:
        if cell.get("cell_type") != "code":
            continue
        source = cell.get("source", cell.get("input", ""))
        sources.append("".join(source) if isinstance(source, list) else str(source))
    return sources


def strip_magics(source: str, index: int) -> str:
    lines = source.splitlines()
    if lines and lines[0].lstrip().startswith("%%"):
        print(f"[notebook-runner] cell {index}: skipped cell magic {lines[0].strip()!r}", file=sys.stderr)
        return ""
    kept = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith(("%", "!")) or "get_ipython()" in stripped:
            print(f"[notebook-runner] cell {index}: skipped {stripped[:120]!r}", file=sys.stderr)
            # Keep the indentation valid inside blocks.
            kept.append(line[: len(line) - len(stripped)] + "pass")
        else:
            kept.append(line)
    return "\n".join(kept)


def run_cell(source: str, index: int, namespace: dict) -> None:
    tree = ast.parse(source, filename=f"<cell {index}>", mode="exec")
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    exec(compile(tree, f"<cell {index}>", "exec"), namespace)
    if last is not None:
        value = eval(compile(last, f"<cell {index}>", "eval"), namespace)
        if value is not None:
            print(repr(value))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--notebook", required=True, help="path to the .ipynb file")
    arguments = parser.parse_args()

    notebook = Path(arguments.notebook).resolve()
    if notebook.suffix != ".ipynb" or not notebook.is_file():
        print(f"[notebook-runner] not a notebook file: {arguments.notebook}", file=sys.stderr)
        return 2

    os.environ.setdefault("MPLBACKEND", "Agg")
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        plt.show = lambda *args, **kwargs: None
    except ImportError:
        pass

    os.chdir(notebook.parent)
    sys.path.insert(0, str(notebook.parent))
    namespace: dict = {"__name__": "__main__", "__file__": str(notebook)}
    cells = code_cells(notebook)
    print(f"[notebook-runner] {notebook.name}: {len(cells)} code cells", file=sys.stderr)
    for index, source in enumerate(cells, start=1):
        code = strip_magics(source, index)
        if not code.strip():
            continue
        try:
            run_cell(code, index, namespace)
        except SystemExit as stop:
            if stop.code not in (None, 0):
                raise
        except BaseException:
            print(f"[notebook-runner] cell {index} failed", file=sys.stderr)
            raise
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
