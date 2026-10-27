import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Adapter } from "./roles.js";

/**
 * Project-owned adapters any study may use by id, so common repository shapes
 * run without per-paper code. Each file is pinned by its SHA-256 here and
 * refused at start-up if it changed. An adapter still caps the result at
 * `partially_reproduced`, and the blind Reviewer sees its text and differences.
 */

export type BuiltinAdapter = Adapter & {
  id: string;
  sha256: string;
  /** How a plan runs it, for the Planner. */
  usage: string;
};

type BuiltinAdapterFile = Omit<BuiltinAdapter, "content"> & { file: string };

export const BUILTIN_ADAPTER_FILES: readonly BuiltinAdapterFile[] = [
  {
    id: "notebook-runner",
    file: "config/builtin-adapters/notebook_runner.py",
    sha256: "6e8b4803c8d4c784d23234e14edea94b6ffadf8d4b695236c803903e7bfbb3cd",
    path: "work/adapter/notebook_runner.py",
    usage:
      "For an experiment that exists only as a Jupyter notebook: entrypoint is the .ipynb path, cwd `work/repo` (notebooks often write files), argv [`python`, `../adapter/notebook_runner.py`, `--notebook`, `<notebook path relative to the repository root>`]. It prints each cell's last expression like Jupyter, so a stdout metricParser can read the metric the notebook displays.",
    why: "The repository publishes this experiment only as a Jupyter notebook, and the offline lab has no Jupyter kernel.",
    source:
      "DéjàML built-in notebook runner: executes the notebook's own code cells in order in one namespace from the notebook's directory.",
    differences: [
      "IPython magics (%, %%) and shell escapes (!) are skipped and listed on stderr instead of run",
      "cells run in a plain Python process, not a Jupyter kernel; a cell's last bare expression is printed with repr()",
      "matplotlib uses the non-interactive Agg backend and plt.show() does nothing",
      "saved notebook outputs are never read",
    ],
  },
];

export class BuiltinAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuiltinAdapterError";
  }
}

/** Reads every built-in adapter from the project and refuses one whose file does not match its pinned hash. */
export async function loadBuiltinAdapters(projectRoot: string): Promise<BuiltinAdapter[]> {
  return Promise.all(
    BUILTIN_ADAPTER_FILES.map(async ({ file, ...adapter }) => {
      const content = await readFile(join(projectRoot, file), "utf8").catch(() => {
        throw new BuiltinAdapterError(`built-in adapter ${adapter.id}: ${file} is missing`);
      });
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== adapter.sha256)
        throw new BuiltinAdapterError(`built-in adapter ${adapter.id}: ${file} does not match its pinned hash (${digest})`);
      return Object.freeze({ ...adapter, content });
    }),
  );
}

/** What the Planner is told about each built-in adapter. */
export function builtinAdapterView(adapter: BuiltinAdapter): Record<string, unknown> {
  return {
    id: adapter.id,
    path: adapter.path,
    usage: adapter.usage,
    why: adapter.why,
    differences: adapter.differences,
  };
}
