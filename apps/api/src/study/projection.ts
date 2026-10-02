import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { findValue, type SealedTarget, withholdValue } from "./blinding.js";

/**
 * The execution projection of a pinned checkout: what every agent after the
 * Paper Analyst reads, and what labs mount as the repository.
 *
 * - Notebooks keep their code cells unchanged; every output and execution
 *   count is removed, because a saved output is a historical result (often
 *   the paper's own number).
 * - Documentation (Markdown, reStructuredText, plain text, and notebook
 *   Markdown cells) has every form of the sealed value withheld.
 * - Code, data, and configuration are copied byte for byte: scientific inputs
 *   are never altered.
 *
 * The original checkout keeps its manifest hash; the projection records its
 * own, so the report shows exactly what the agents and labs saw.
 */

const DOC_EXTENSIONS = [".md", ".markdown", ".rst", ".txt"];

export type Projection = {
  dir: string;
  /** SHA-256 over the sorted `path\0sha256` lines of every projected file. */
  sha256: string;
  notebooksStripped: Array<{ path: string; outputsRemoved: number }>;
  documentsWithheld: Array<{ path: string }>;
  /** Code or data files that contain a form of the sealed value (copied unchanged; reported, never shown). */
  staticFindings: Array<{ path: string }>;
  fileCount: number;
};

type SealedValue = { value: number; unit: SealedTarget["metric"]["unit"] };
type Sealed = SealedValue | ReadonlyArray<SealedValue> | null;

function sealedValues(sealed: Sealed): ReadonlyArray<SealedValue> {
  return sealed === null ? [] : Array.isArray(sealed) ? sealed : [sealed as SealedValue];
}

function withholdAll(sealed: Sealed, text: string): string {
  return sealedValues(sealed).reduce((current, item) => withholdValue(item.value, item.unit, current), text);
}

function containsAny(sealed: Sealed, text: string): boolean {
  return sealedValues(sealed).some((item) => findValue(item.value, item.unit, text) !== null);
}

type Notebook = { cells?: Array<Record<string, unknown>>; metadata?: Record<string, unknown> };

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A notebook with its outputs removed and its Markdown withheld; code cells unchanged. */
export function stripNotebook(text: string, sealed: Sealed): { text: string; outputsRemoved: number } | null {
  let notebook: Notebook;
  try {
    notebook = JSON.parse(text) as Notebook;
  } catch {
    return null;
  }
  if (!notebook || typeof notebook !== "object" || !Array.isArray(notebook.cells)) return null;
  let outputsRemoved = 0;
  const cells = notebook.cells.map((cell) => {
    const next: Record<string, unknown> = { ...cell };
    if (cell.cell_type === "code") {
      outputsRemoved += Array.isArray(cell.outputs) ? cell.outputs.length : 0;
      next.outputs = [];
      next.execution_count = null;
    } else if (cell.cell_type === "markdown" && sealedValues(sealed).length) {
      const source = Array.isArray(cell.source) ? (cell.source as string[]).join("") : String(cell.source ?? "");
      next.source = withholdAll(sealed, source);
    }
    delete next.attachments;
    return next;
  });
  const metadata = { ...(notebook.metadata ?? {}) };
  delete metadata.widgets;
  return { text: `${JSON.stringify({ ...notebook, metadata, cells }, null, 1)}\n`, outputsRemoved };
}

export async function projectRepository(input: { sourceDir: string; destinationDir: string; sealed: Sealed }): Promise<Projection> {
  const { sourceDir, destinationDir, sealed } = input;
  const lines: string[] = [];
  const projection: Omit<Projection, "sha256" | "fileCount"> = {
    dir: destinationDir,
    notebooksStripped: [],
    documentsWithheld: [],
    staticFindings: [],
  };
  await mkdir(destinationDir, { recursive: true, mode: 0o755 });
  const walk = async (dir: string): Promise<void> => {
    const items = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const from = join(dir, item.name);
      const rel = relative(sourceDir, from).split(sep).join("/");
      const to = join(destinationDir, rel);
      if (item.isSymbolicLink()) {
        const link = await readlink(from);
        await symlink(link, to);
        lines.push(`${rel}\0L:${link}`);
      } else if (item.isDirectory()) {
        await mkdir(to, { mode: 0o755 });
        await chmod(to, 0o755);
        await walk(from);
      } else if (item.isFile()) {
        const raw = await readFile(from);
        let out: Uint8Array = raw;
        const binary = raw.subarray(0, 1024).includes(0);
        const lower = rel.toLowerCase();
        if (!binary && lower.endsWith(".ipynb")) {
          const stripped = stripNotebook(raw.toString("utf8"), sealed);
          if (stripped) {
            out = Buffer.from(stripped.text, "utf8");
            projection.notebooksStripped.push({ path: rel, outputsRemoved: stripped.outputsRemoved });
          } else if (sealedValues(sealed).length) {
            // Not a readable notebook: nothing can execute it, so it is withheld like a document.
            out = Buffer.from(withholdAll(sealed, raw.toString("utf8")), "utf8");
          }
        } else if (!binary && sealedValues(sealed).length && DOC_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
          const text = raw.toString("utf8");
          const withheld = withholdAll(sealed, text);
          if (withheld !== text) {
            out = Buffer.from(withheld, "utf8");
            projection.documentsWithheld.push({ path: rel });
          }
        } else if (!binary && sealedValues(sealed).length && containsAny(sealed, raw.toString("utf8"))) {
          projection.staticFindings.push({ path: rel });
        }
        await writeFile(to, out, { mode: 0o644 });
        await chmod(to, (await lstat(from)).mode & 0o111 ? 0o755 : 0o644);
        lines.push(`${rel}\0${sha256(out)}`);
      }
    }
  };
  await walk(sourceDir);
  await chmod(destinationDir, 0o755);
  lines.sort();
  return { ...projection, sha256: sha256(`${lines.join("\n")}\n`), fileCount: lines.length };
}
