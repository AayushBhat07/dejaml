import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { type PaperDocument, type RepositoryCandidate } from "@dejaml/contracts";

export const MAX_PAPER_EVIDENCE_CHARS = 180_000;
export const MAX_PAPER_PAGE_CHARS = 24_000;
export const MAX_REPOSITORY_EVIDENCE_CHARS = 500_000;
export const MAX_REPOSITORY_FILES = 80;
export const MAX_REPOSITORY_FILE_BYTES = 250_000;
export const MAX_NOTEBOOK_FILE_BYTES = 10 * 1024 * 1024;

export type PaperEvidenceBundle = {
  text: string;
  includedPages: number[];
  omittedPages: number[];
};

export type RepositoryEvidenceFile = {
  path: string;
  sha256: string;
  content: string;
  truncated: boolean;
};

export type RepositoryEvidenceBundle = {
  files: RepositoryEvidenceFile[];
  omittedFiles: string[];
  warnings: string[];
};

function pageScore(text: string, hasRepositoryLink: boolean): number {
  const lowered = text.toLowerCase();
  const terms = [
    "result",
    "accuracy",
    "precision",
    "recall",
    "f1",
    "dataset",
    "experiment",
    "random forest",
    "hyperparameter",
    "table",
    "github.com",
  ];
  return terms.reduce((score, term) => score + (lowered.includes(term) ? 1 : 0), hasRepositoryLink ? 20 : 0);
}

export function buildPaperEvidenceBundle(document: PaperDocument, candidates: RepositoryCandidate[]): PaperEvidenceBundle {
  const candidatePages = new Set(candidates.flatMap((candidate) => candidate.occurrences.map((item) => item.pageNumber)));
  const ranked = [...document.pages].sort((left, right) => {
    const scoreDifference =
      pageScore(right.text, candidatePages.has(right.pageNumber)) - pageScore(left.text, candidatePages.has(left.pageNumber));
    return scoreDifference || left.pageNumber - right.pageNumber;
  });

  const included: Array<{ pageNumber: number; text: string }> = [];
  const omittedPages: number[] = [];
  let used = 0;
  for (const page of ranked) {
    const text = redactLikelySecrets(page.text.slice(0, MAX_PAPER_PAGE_CHARS));
    const section = `\n--- PAPER PAGE ${page.pageNumber} ---\n${text}\n`;
    if (used + section.length > MAX_PAPER_EVIDENCE_CHARS) {
      omittedPages.push(page.pageNumber);
      continue;
    }
    included.push({ pageNumber: page.pageNumber, text });
    used += section.length;
  }
  included.sort((left, right) => left.pageNumber - right.pageNumber);

  return {
    text: included.map((page) => `--- PAPER PAGE ${page.pageNumber} ---\n${page.text}`).join("\n\n"),
    includedPages: included.map((page) => page.pageNumber),
    omittedPages: omittedPages.sort((left, right) => left - right),
  };
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".github",
  ".idea",
  ".venv",
  ".vscode",
  "artifacts",
  "build",
  "data",
  "dist",
  "node_modules",
  "outputs",
  "results",
  "venv",
]);
const EXCLUDED_FILES = /(^|\/)(\.env(?:\..*)?|credentials?|secrets?|.*\.(?:key|pem|p12|pfx))$/iu;
const RELEVANT_FILE =
  /(^|\/)(readme[^/]*|requirements[^/]*\.txt|pyproject\.toml|setup\.(?:py|cfg)|environment\.ya?ml|conda\.ya?ml|package\.json|dockerfile|[^/]+\.(?:py|ipynb|r|jl|md|toml|ya?ml|json))$/iu;

function filePriority(path: string): number {
  const lowered = path.toLowerCase();
  let score = 0;
  if (/(^|\/)readme/.test(lowered)) score += 100;
  if (/requirements|pyproject|environment|setup\.(py|cfg)/.test(lowered)) score += 90;
  if (/train|eval|test|experiment|model|main|run/.test(lowered)) score += 30;
  if (lowered.endsWith(".py")) score += 20;
  if (lowered.endsWith(".ipynb")) score += 15;
  return score;
}

function sanitizeNotebook(raw: string): string {
  try {
    const notebook = JSON.parse(raw) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
    return (notebook.cells ?? [])
      .filter((cell) => cell.cell_type === "code" || cell.cell_type === "markdown")
      .map((cell, index) => {
        const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
        return `# cell ${index + 1} (${cell.cell_type ?? "unknown"})\n${source}`;
      })
      .join("\n\n");
  } catch {
    return "[Notebook JSON could not be parsed; content omitted.]";
  }
}

export function redactLikelySecrets(text: string): string {
  return text
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED_AWS_ACCESS_KEY]");
}

async function assertContainedDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("repository path must be absolute");
  const resolved = await realpath(path);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("repository path must resolve to a real directory");
  }
  return resolved;
}

export async function snapshotRepositoryForAnalysis(repositoryPath: string): Promise<RepositoryEvidenceBundle> {
  const root = await assertContainedDirectory(repositoryPath);
  const pending = [root];
  const candidates: Array<{ absolutePath: string; path: string; bytes: number }> = [];
  const omittedFiles: string[] = [];
  const warnings: string[] = [];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      const firstSegment = relativePath.split("/")[0]?.toLowerCase() ?? "";
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(firstSegment) && !entry.name.startsWith(".")) {
          pending.push(absolutePath);
        }
        continue;
      }
      if (!entry.isFile() || EXCLUDED_FILES.test(relativePath) || !RELEVANT_FILE.test(relativePath)) {
        continue;
      }
      const metadata = await lstat(absolutePath);
      const maximumBytes = relativePath.toLowerCase().endsWith(".ipynb") ? MAX_NOTEBOOK_FILE_BYTES : MAX_REPOSITORY_FILE_BYTES;
      if (metadata.size > maximumBytes) {
        omittedFiles.push(relativePath);
        continue;
      }
      candidates.push({ absolutePath, path: relativePath, bytes: metadata.size });
    }
  }

  candidates.sort((left, right) => filePriority(right.path) - filePriority(left.path) || left.path.localeCompare(right.path));
  const files: RepositoryEvidenceFile[] = [];
  let usedCharacters = 0;
  for (const candidate of candidates) {
    if (files.length >= MAX_REPOSITORY_FILES) {
      omittedFiles.push(candidate.path);
      continue;
    }
    const raw = await readFile(candidate.absolutePath);
    if (raw.includes(0)) {
      omittedFiles.push(candidate.path);
      continue;
    }
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const decoded = raw.toString("utf8");
    const normalized = candidate.path.toLowerCase().endsWith(".ipynb") ? sanitizeNotebook(decoded) : decoded;
    const sanitized = redactLikelySecrets(normalized);
    const remaining = MAX_REPOSITORY_EVIDENCE_CHARS - usedCharacters;
    if (remaining <= 0) {
      omittedFiles.push(candidate.path);
      continue;
    }
    const content = sanitized.slice(0, remaining);
    files.push({
      path: candidate.path,
      sha256,
      content,
      truncated: content.length < sanitized.length,
    });
    usedCharacters += content.length;
    if (content.length < sanitized.length) warnings.push(`${candidate.path} was truncated`);
  }
  if (omittedFiles.length > 0) warnings.push(`${omittedFiles.length} relevant files were omitted by evidence limits`);
  return { files, omittedFiles: omittedFiles.sort(), warnings };
}

export function formatRepositoryEvidence(bundle: RepositoryEvidenceBundle): string {
  return bundle.files
    .map((file) => `--- REPOSITORY FILE ${file.path} SHA256 ${file.sha256}${file.truncated ? " TRUNCATED" : ""} ---\n${file.content}`)
    .join("\n\n");
}

export function isPathInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}
