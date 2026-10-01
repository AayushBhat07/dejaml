import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectRepository } from "./projection.js";

const SENTINEL = 0.3141592653589793;
const sealed = { value: SENTINEL, unit: "fraction" as const };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dejaml-projection-"));
  const repo = join(dir, "repo");
  await mkdir(join(repo, "notebooks"), { recursive: true });
  await writeFile(
    join(repo, "notebooks/eval.ipynb"),
    JSON.stringify({
      cells: [
        { cell_type: "markdown", metadata: {}, source: ["# Results\n", "BOSS reaches 31.42% on GunPoint.\n"] },
        {
          cell_type: "code",
          execution_count: 7,
          metadata: {},
          source: ["acc = evaluate()\n", "print(f'Accuracy on the test set: {acc:.4f}')"],
          outputs: [{ output_type: "stream", name: "stdout", text: ["Accuracy on the test set: 0.3142\n"] }],
        },
      ],
      metadata: { widgets: { state: "0.3142" }, kernelspec: { name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5,
    }),
  );
  await writeFile(join(repo, "README.md"), "# Repro\nThe paper reports 0.314159 accuracy.\nRun `python run.py`.\n");
  await writeFile(join(repo, "run.py"), "THRESHOLD = 0.3142  # an innocent constant\nprint('run')\n");
  await writeFile(join(repo, "data.csv"), "x,y\n0.3142,1\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("execution projection", () => {
  it("strips every notebook output and withholds the value from documentation, leaving code and data byte for byte", async () => {
    const projection = await projectRepository({ sourceDir: join(dir, "repo"), destinationDir: join(dir, "p1"), sealed });
    const notebook = JSON.parse(await readFile(join(dir, "p1/notebooks/eval.ipynb"), "utf8")) as {
      cells: Array<{ cell_type: string; source: string | string[]; outputs?: unknown[]; execution_count?: number | null }>;
      metadata: Record<string, unknown>;
    };
    const code = notebook.cells.find((cell) => cell.cell_type === "code")!;
    expect(code.outputs).toEqual([]);
    expect(code.execution_count).toBeNull();
    expect(code.source).toEqual(["acc = evaluate()\n", "print(f'Accuracy on the test set: {acc:.4f}')"]);
    expect(notebook.metadata.widgets).toBeUndefined();
    expect(JSON.stringify(notebook)).not.toMatch(/0\.3142|31\.42/u);
    expect(await readFile(join(dir, "p1/README.md"), "utf8")).toBe(
      "# Repro\nThe paper reports [withheld] accuracy.\nRun `python run.py`.\n",
    );
    // Scientific inputs are never altered; a code file that happens to hold the value is reported, not changed.
    expect(await readFile(join(dir, "p1/run.py"), "utf8")).toContain("0.3142");
    expect(await readFile(join(dir, "p1/data.csv"), "utf8")).toBe("x,y\n0.3142,1\n");
    expect(projection.notebooksStripped).toEqual([{ path: "notebooks/eval.ipynb", outputsRemoved: 1 }]);
    expect(projection.documentsWithheld).toEqual([{ path: "README.md" }]);
    expect(projection.staticFindings.map((item) => item.path).sort()).toEqual(["data.csv", "run.py"]);
    expect(projection.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("is deterministic, so a resumed study recomputes the same projection hash", async () => {
    const first = await projectRepository({ sourceDir: join(dir, "repo"), destinationDir: join(dir, "p1"), sealed });
    const second = await projectRepository({ sourceDir: join(dir, "repo"), destinationDir: join(dir, "p2"), sealed });
    expect(second.sha256).toBe(first.sha256);
  });

  it("strips outputs even before a value is sealed", async () => {
    await projectRepository({ sourceDir: join(dir, "repo"), destinationDir: join(dir, "p3"), sealed: null });
    expect(await readFile(join(dir, "p3/notebooks/eval.ipynb"), "utf8")).not.toContain("Accuracy on the test set: 0.3142");
  });
});
