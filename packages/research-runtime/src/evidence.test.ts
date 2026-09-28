import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildPaperEvidenceBundle, snapshotRepositoryForAnalysis } from "./evidence.js";

describe("repository evidence snapshot", () => {
  it("reads bounded relevant files, strips notebook outputs, redacts tokens, and skips secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "dejaml-evidence-test-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "README.md"), "Run python src/train.py");
    const syntheticToken = ["sk", "abcdefghijklmnopqrstuvwxyz1234"].join("-");
    await writeFile(
      join(root, "src", "train.py"),
      `TOKEN = '${syntheticToken}'\nprint('accuracy=80')`,
    );
    await writeFile(join(root, ".env"), "OPENAI_API_KEY=do-not-read");
    await writeFile(
      join(root, "Experiment.ipynb"),
      JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ["# Experiment"] },
          { cell_type: "code", source: ["print('fit')"], outputs: [{ text: "secret output" }] },
        ],
      }),
    );
    await symlink("/etc/passwd", join(root, "src", "external.py"));

    const snapshot = await snapshotRepositoryForAnalysis(root);
    expect(snapshot.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["README.md", "src/train.py", "Experiment.ipynb"]),
    );
    expect(snapshot.files.map((file) => file.path)).not.toContain(".env");
    expect(snapshot.files.map((file) => file.path)).not.toContain("src/external.py");
    const source = snapshot.files.find((file) => file.path === "src/train.py");
    expect(source?.content).toContain("[REDACTED_API_KEY]");
    const notebook = snapshot.files.find((file) => file.path === "Experiment.ipynb");
    expect(notebook?.content).toContain("print('fit')");
    expect(notebook?.content).not.toContain("secret output");
  });
});

describe("paper evidence bundle", () => {
  it("redacts common credential formats before provider transmission", () => {
    const token = `sk-${"a".repeat(24)}`;
    const bundle = buildPaperEvidenceBundle(
      {
        schemaVersion: 1,
        file: { originalName: "paper.pdf", bytes: 100, sha256: "a".repeat(64) },
        pageCount: 1,
        pages: [{ pageNumber: 1, text: `accuracy 80 ${token}`, charCount: 36 }],
        totalTextChars: 36,
        warnings: [],
      },
      [],
    );
    expect(bundle.text).toContain("[REDACTED_API_KEY]");
    expect(bundle.text).not.toContain(token);
  });
});
