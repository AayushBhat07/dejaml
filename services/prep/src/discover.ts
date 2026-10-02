import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { logicalLines, normalizePackageName, parseRequirementLine, type ParsedRequirement } from "./requirements.js";

/**
 * Host-side dependency discovery. This module only *reads* a checkout: it
 * never executes repository code, never follows symlinks and never reads
 * files larger than {@link MAX_READ_BYTES}.
 */

export const MAX_DEPTH = 4;
export const MAX_ENTRIES = 5000;
export const MAX_READ_BYTES = 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache"]);

export type DependencyFileKind =
  | "requirements"
  | "constraints"
  | "pyproject"
  | "setup.py"
  | "setup.cfg"
  | "Pipfile"
  | "uv.lock"
  | "poetry.lock"
  | "Pipfile.lock"
  | "pylock.toml"
  | "conda"
  | "npm"
  | "cargo"
  | "go"
  | "r-description";

export type LockfileKind = "uv.lock" | "poetry.lock" | "Pipfile.lock" | "pylock.toml" | "pinned-requirements";

export type DiscoveredFile = { path: string; kind: DependencyFileKind; sha256: string };
export type RejectedLine = { file: string; line: number; text: string; reason: string };
export type UnsupportedItem = { path: string; reason: string };

export type DependencyDiscovery = {
  ecosystem: "python" | "unsupported" | "none";
  files: DiscoveredFile[];
  lockfile: { path: string; kind: LockfileKind } | null;
  requirements: ParsedRequirement[];
  rejected: RejectedLine[];
  unsupported: UnsupportedItem[];
  /** True when the walk stopped at {@link MAX_ENTRIES}. */
  truncated: boolean;
  /** Optional-dependency groups the pyproject files declare. */
  optionalGroups: string[];
  /** The groups that were requested (and included when declared). */
  extras: string[];
};

const PYTHON_KINDS = new Set<DependencyFileKind>([
  "requirements",
  "constraints",
  "pyproject",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "pylock.toml",
]);

const UNSUPPORTED_REASONS: Partial<Record<DependencyFileKind, string>> = {
  conda: "conda_environment_unsupported",
  npm: "unsupported_ecosystem:npm",
  cargo: "unsupported_ecosystem:cargo",
  go: "unsupported_ecosystem:go",
  "r-description": "unsupported_ecosystem:r",
};

export function classifyDependencyFile(relativePath: string): DependencyFileKind | null {
  const name = posix.basename(relativePath);
  const lower = name.toLowerCase();
  const parent = posix.basename(posix.dirname(relativePath)).toLowerCase();
  if (/^requirements.*\.txt$/u.test(lower) || (parent === "requirements" && lower.endsWith(".txt"))) {
    return "requirements";
  }
  if (/^constraints.*\.txt$/u.test(lower)) return "constraints";
  if (lower === "pyproject.toml") return "pyproject";
  if (lower === "setup.py") return "setup.py";
  if (lower === "setup.cfg") return "setup.cfg";
  if (name === "Pipfile") return "Pipfile";
  if (lower === "pipfile.lock") return "Pipfile.lock";
  if (lower === "uv.lock") return "uv.lock";
  if (lower === "poetry.lock") return "poetry.lock";
  if (lower === "pylock.toml" || /^pylock\.[^/]+\.toml$/u.test(lower)) return "pylock.toml";
  if (/^(environment|conda|env)[^/]*\.ya?ml$/u.test(lower) || lower === "meta.yaml") return "conda";
  if (lower === "package.json") return "npm";
  if (lower === "cargo.toml") return "cargo";
  if (lower === "go.mod") return "go";
  if (name === "DESCRIPTION") return "r-description";
  return null;
}

type Candidate = { path: string; kind: DependencyFileKind; content: string; depth: number };

export type DiscoverOptions = {
  /** pyproject optional-dependency groups (or poetry extras) to include; none by default. */
  extras?: string[];
};

export async function discoverDependencies(repoDir: string, options: DiscoverOptions = {}): Promise<DependencyDiscovery> {
  const extras = new Set((options.extras ?? []).map(normalizePackageName));
  const groups = new Set<string>();
  const rootStat = await lstat(repoDir);
  if (!rootStat.isDirectory()) throw new Error("repository path must be a directory (symlinks are not followed)");

  const files: DiscoveredFile[] = [];
  const unsupported: UnsupportedItem[] = [];
  const candidates: Candidate[] = [];
  let entries = 0;
  let truncated = false;

  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: repoDir, rel: "", depth: 0 }];
  walk: while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    let listing;
    try {
      listing = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of listing) {
      entries += 1;
      if (entries > MAX_ENTRIES) {
        truncated = true;
        break walk;
      }
      const rel = current.rel === "" ? entry.name : `${current.rel}/${entry.name}`;
      const full = join(current.dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (classifyDependencyFile(rel)) unsupported.push({ path: rel, reason: "symlink_not_followed" });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (current.depth + 1 <= MAX_DEPTH) queue.push({ dir: full, rel, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = classifyDependencyFile(rel);
      if (!kind) continue;
      const stat = await lstat(full);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_READ_BYTES) {
        unsupported.push({ path: rel, reason: "file_too_large" });
        continue;
      }
      const buffer = await readFile(full);
      files.push({ path: rel, kind, sha256: createHash("sha256").update(buffer).digest("hex") });
      const reason = UNSUPPORTED_REASONS[kind];
      if (reason) unsupported.push({ path: rel, reason });
      if (kind === "setup.py" || kind === "setup.cfg") {
        unsupported.push({ path: rel, reason: "executable_build_metadata" });
      }
      if (PYTHON_KINDS.has(kind)) {
        candidates.push({ path: rel, kind, content: buffer.toString("utf8"), depth: current.depth });
      }
    }
  }

  const rejected: RejectedLine[] = [];
  const parsed = new Map<string, { requirements: ParsedRequirement[]; rejectedCount: number; allPinned: boolean }>();
  for (const candidate of candidates) {
    const before = rejected.length;
    const requirements = parseCandidate(candidate, rejected, unsupported, extras, groups);
    parsed.set(candidate.path, {
      requirements,
      rejectedCount: rejected.length - before,
      allPinned: requirements.length > 0 && requirements.every((requirement) => requirement.pinned),
    });
  }

  const byPreference = (a: Candidate, b: Candidate): number => a.depth - b.depth || (a.path < b.path ? -1 : 1);
  let lockfile: DependencyDiscovery["lockfile"] = null;
  for (const kind of ["uv.lock", "poetry.lock", "Pipfile.lock", "pylock.toml"] as const) {
    const found = candidates.filter((candidate) => candidate.kind === kind).sort(byPreference)[0];
    if (found && (parsed.get(found.path)?.requirements.length ?? 0) > 0) {
      lockfile = { path: found.path, kind };
      break;
    }
  }
  if (!lockfile) {
    const pinned = candidates
      .filter((candidate) => {
        const result = parsed.get(candidate.path);
        return candidate.kind === "requirements" && result?.allPinned === true && result.rejectedCount === 0;
      })
      .sort(byPreference)[0];
    if (pinned) lockfile = { path: pinned.path, kind: "pinned-requirements" };
  }

  let requirements: ParsedRequirement[];
  if (lockfile) {
    requirements = parsed.get(lockfile.path)?.requirements ?? [];
  } else {
    requirements = candidates
      .filter((candidate) => candidate.kind === "requirements" || candidate.kind === "pyproject")
      .sort(byPreference)
      .flatMap((candidate) => parsed.get(candidate.path)?.requirements ?? []);
  }

  const hasPython = files.some((file) => PYTHON_KINDS.has(file.kind));
  const hasUnsupported = files.some((file) => UNSUPPORTED_REASONS[file.kind] !== undefined);
  return {
    ecosystem: hasPython ? "python" : hasUnsupported ? "unsupported" : "none",
    files,
    lockfile,
    requirements,
    rejected,
    unsupported,
    truncated,
    optionalGroups: [...groups].sort(),
    extras: [...extras].sort(),
  };
}

function parseCandidate(
  candidate: Candidate,
  rejected: RejectedLine[],
  unsupported: UnsupportedItem[],
  extras: ReadonlySet<string>,
  groups: Set<string>,
): ParsedRequirement[] {
  switch (candidate.kind) {
    case "requirements":
    case "constraints":
      return parseRequirementsText(candidate.path, candidate.content, rejected);
    case "pyproject":
      return parsePyproject(candidate.path, candidate.content, rejected, unsupported, extras, groups);
    case "uv.lock":
    case "poetry.lock":
      return parseLockPackages(candidate.path, candidate.content, "package", rejected);
    case "pylock.toml":
      return parseLockPackages(candidate.path, candidate.content, "packages", rejected);
    case "Pipfile.lock":
      return parsePipfileLock(candidate.path, candidate.content, rejected);
    default:
      return [];
  }
}

function clip(text: string): string {
  // eslint-disable-next-line no-control-regex -- rejects control characters
  const flat = text.replace(/[\u0000-\u001f\u007f]/gu, "?");
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}

function accept(file: string, line: number, text: string, rejected: RejectedLine[], into: ParsedRequirement[]): void {
  const result = parseRequirementLine(text);
  if (!result.ok) {
    rejected.push({ file, line, text: clip(text), reason: result.reason });
    return;
  }
  if (result.requirement) into.push({ ...result.requirement, source: { file, line } });
}

export function parseRequirementsText(file: string, content: string, rejected: RejectedLine[]): ParsedRequirement[] {
  const requirements: ParsedRequirement[] = [];
  for (const { line, text } of logicalLines(content)) accept(file, line, text, rejected, requirements);
  return requirements;
}

// ---------------------------------------------------------------------------
// Minimal TOML reading. Only what the supported files need: table headers,
// `key = "string"`, `key = { inline table }` and multi-line string arrays.
// ---------------------------------------------------------------------------

type TomlLine = { line: number; text: string };

function tomlSections(content: string): { header: string; array: boolean; line: number; body: TomlLine[] }[] {
  const sections: { header: string; array: boolean; line: number; body: TomlLine[] }[] = [{ header: "", array: false, line: 0, body: [] }];
  content.split("\n").forEach((raw, index) => {
    const text = raw.replace(/\r$/u, "");
    const header = /^\s*(\[\[?)\s*([A-Za-z0-9_.\-" ]+?)\s*\]\]?\s*(#.*)?$/u.exec(text);
    if (header?.[1] && header[2] !== undefined) {
      sections.push({
        header: header[2].replace(/"/gu, "").replace(/\s*\.\s*/gu, "."),
        array: header[1] === "[[",
        line: index + 1,
        body: [],
      });
      return;
    }
    sections.at(-1)?.body.push({ line: index + 1, text });
  });
  return sections;
}

function tomlString(value: string): string | null {
  const match = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(#.*)?$/u.exec(value);
  if (!match) return null;
  return match[1] !== undefined ? match[1].replace(/\\(["\\])/gu, "$1") : (match[2] ?? null);
}

/** Collect the quoted strings of `key = [ ... ]`, which may span lines. */
function tomlStringArray(body: TomlLine[], key: string): { line: number; value: string }[] | null {
  const start = body.findIndex((entry) => new RegExp(`^\\s*${key}\\s*=\\s*\\[`, "u").test(entry.text));
  if (start === -1) return null;
  return tomlStringArrayAt(body, start);
}

/** Keys of `key = [ ... ]` entries in a table body (bare or quoted keys). */
function tomlArrayKeys(body: TomlLine[]): { key: string; start: number }[] {
  const keys: { key: string; start: number }[] = [];
  body.forEach((entry, index) => {
    const match = /^\s*(?:"([A-Za-z0-9_.-]+)"|'([A-Za-z0-9_.-]+)'|([A-Za-z0-9_-]+))\s*=\s*\[/u.exec(entry.text);
    const key = match?.[1] ?? match?.[2] ?? match?.[3];
    if (key) keys.push({ key, start: index });
  });
  return keys;
}

function tomlStringArrayAt(body: TomlLine[], start: number): { line: number; value: string }[] {
  const values: { line: number; value: string }[] = [];
  for (let index = start; index < body.length; index += 1) {
    const entry = body[index];
    if (!entry) break;
    let text = index === start ? entry.text.slice(entry.text.indexOf("[") + 1) : entry.text;
    let closed = false;
    const tokens = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\])|(#)/gu;
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(text)) !== null) {
      if (match[4]) break;
      if (match[3]) {
        closed = true;
        break;
      }
      const value = match[1] !== undefined ? match[1].replace(/\\(["\\])/gu, "$1") : (match[2] ?? "");
      values.push({ line: entry.line, value });
    }
    text = "";
    if (closed) break;
  }
  return values;
}

function tomlKeyValues(body: TomlLine[]): { line: number; key: string; value: string }[] {
  const result: { line: number; key: string; value: string }[] = [];
  for (const entry of body) {
    const match = /^\s*("?)([A-Za-z0-9_.-]+)\1\s*=\s*(.+?)\s*$/u.exec(entry.text);
    if (match?.[2] && match[3] !== undefined) result.push({ line: entry.line, key: match[2], value: match[3] });
  }
  return result;
}

function parsePyproject(
  file: string,
  content: string,
  rejected: RejectedLine[],
  unsupported: UnsupportedItem[],
  extras: ReadonlySet<string>,
  groups: Set<string>,
): ParsedRequirement[] {
  const requirements: ParsedRequirement[] = [];
  const sections = tomlSections(content);
  const project = sections.find((section) => section.header === "project" && !section.array);
  if (project) {
    const dynamic = tomlStringArray(project.body, "dynamic");
    if (dynamic?.some((entry) => entry.value === "dependencies")) {
      unsupported.push({ path: file, reason: "dynamic_dependencies" });
    }
    if (extras.size > 0 && dynamic?.some((entry) => entry.value === "optional-dependencies")) {
      unsupported.push({ path: file, reason: "dynamic_optional_dependencies" });
    }
    for (const entry of tomlStringArray(project.body, "dependencies") ?? []) {
      accept(file, entry.line, entry.value, rejected, requirements);
    }
  }
  // [project.optional-dependencies]: only the groups the caller asked for.
  const optional = sections.find((section) => section.header === "project.optional-dependencies" && !section.array);
  const found = new Set<string>();
  for (const { key, start } of optional ? tomlArrayKeys(optional.body) : []) {
    const group = normalizePackageName(key);
    groups.add(group);
    found.add(group);
    if (!extras.has(group)) continue;
    for (const entry of tomlStringArrayAt(optional?.body ?? [], start)) accept(file, entry.line, entry.value, rejected, requirements);
  }
  // Poetry: optional dependencies are installed only through a requested [tool.poetry.extras] group.
  const poetryExtras = sections.find((section) => section.header === "tool.poetry.extras" && !section.array);
  const enabledOptional = new Set<string>();
  for (const { key, start } of poetryExtras ? tomlArrayKeys(poetryExtras.body) : []) {
    const group = normalizePackageName(key);
    groups.add(group);
    found.add(group);
    if (!extras.has(group)) continue;
    for (const entry of tomlStringArrayAt(poetryExtras?.body ?? [], start)) enabledOptional.add(normalizePackageName(entry.value));
  }
  for (const extra of extras) {
    if (!found.has(extra) && (optional || poetryExtras || project))
      unsupported.push({ path: file, reason: `optional_dependency_group_missing:${extra}` });
  }
  const poetry = sections.find((section) => section.header === "tool.poetry.dependencies" && !section.array);
  if (poetry) {
    for (const { line, key, value } of tomlKeyValues(poetry.body)) {
      if (key.toLowerCase() === "python") continue;
      if (/\boptional\s*=\s*true\b/u.test(value) && !enabledOptional.has(normalizePackageName(key))) continue;
      const converted = poetryRequirement(key, value);
      if ("reason" in converted) {
        rejected.push({ file, line, text: clip(`${key} = ${value}`), reason: converted.reason });
        continue;
      }
      accept(file, line, converted.text, rejected, requirements);
    }
  }
  return requirements;
}

function poetryRequirement(name: string, value: string): { text: string } | { reason: string } {
  let constraint: string | null;
  let extras: string[] = [];
  if (value.startsWith("{")) {
    if (/\b(git|path|url|file|develop)\s*=/u.test(value)) {
      return { reason: "poetry git/path/url dependencies are not allowed" };
    }
    const version = /\bversion\s*=\s*("[^"]*"|'[^']*')/u.exec(value)?.[1];
    constraint = version ? tomlString(version) : "*";
    const extrasMatch = /\bextras\s*=\s*\[([^\]]*)\]/u.exec(value)?.[1];
    if (extrasMatch) extras = [...extrasMatch.matchAll(/"([^"]*)"|'([^']*)'/gu)].map((m) => m[1] ?? m[2] ?? "");
  } else if (value.startsWith("[")) {
    return { reason: "poetry multiple-constraint dependencies are not supported" };
  } else {
    constraint = tomlString(value);
  }
  if (constraint === null) return { reason: "unreadable poetry constraint" };
  const specifiers = poetryConstraint(constraint);
  if (specifiers === null) return { reason: "unsupported poetry constraint" };
  return { text: `${name}${extras.length > 0 ? `[${extras.join(",")}]` : ""}${specifiers}` };
}

/** Translate the common Poetry constraint forms to PEP 440 specifiers. */
export function poetryConstraint(constraint: string): string | null {
  const text = constraint.trim();
  if (text === "*" || text === "") return "";
  const caret = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(text);
  if (caret) {
    const parts = [caret[1], caret[2], caret[3]].map((part) => (part === undefined ? undefined : Number(part)));
    const [major = 0, minor, patch] = parts;
    const lower = [major, minor ?? 0, patch ?? 0].join(".");
    let upper: string;
    if (major > 0 || minor === undefined) upper = `${major + 1}.0.0`;
    else if (minor > 0 || patch === undefined) upper = `0.${minor + 1}.0`;
    else upper = `0.0.${patch + 1}`;
    return `>=${lower},<${upper}`;
  }
  const tilde = /^~(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(text);
  if (tilde) {
    const major = Number(tilde[1]);
    const minor = tilde[2] === undefined ? undefined : Number(tilde[2]);
    const lower = [major, minor ?? 0, tilde[3] ?? 0].join(".");
    const upper = minor === undefined ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
    return `>=${lower},<${upper}`;
  }
  if (/^\d[A-Za-z0-9.+!_-]*$/u.test(text)) return `==${text}`;
  if (/^(?:(?:===|==|!=|<=|>=|~=|<|>)\s*[A-Za-z0-9.*+!_-]+\s*,?\s*)+$/u.test(text)) {
    return text.replace(/\s+/gu, "");
  }
  return null;
}

/** `[[package]]` (uv.lock, poetry.lock) or `[[packages]]` (pylock.toml) blocks. */
function parseLockPackages(
  file: string,
  content: string,
  arrayName: "package" | "packages",
  rejected: RejectedLine[],
): ParsedRequirement[] {
  const requirements: ParsedRequirement[] = [];
  const sections = tomlSections(content);
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (!section || section.header !== arrayName || !section.array) continue;
    // Sub-tables such as [package.source] / [[packages.wheels]] belong to this entry.
    const subtables: string[] = [];
    for (let next = index + 1; next < sections.length; next += 1) {
      const sub = sections[next];
      if (!sub || !sub.header.startsWith(`${arrayName}.`)) break;
      subtables.push(sub.header, ...sub.body.map((entry) => entry.text));
    }
    const values = new Map(tomlKeyValues(section.body).map((entry) => [entry.key, entry.value]));
    const name = tomlString(values.get("name") ?? "");
    const version = tomlString(values.get("version") ?? "");
    const source = values.get("source") ?? "";
    const text = `${name ?? "?"}==${version ?? "?"}`;
    const subText = subtables.join("\n");
    if (/\b(editable|virtual)\s*=/u.test(source)) continue; // the project itself (uv)
    if (
      /\b(git|path|directory|url)\s*=/u.test(source) ||
      /\b(vcs|directory)\b/u.test(subText) ||
      /type\s*=\s*"(git|directory|file|url)"/u.test(subText)
    ) {
      rejected.push({ file, line: section.line, text: clip(text), reason: "non-registry lockfile source" });
      continue;
    }
    if (!name || !version) {
      rejected.push({ file, line: section.line, text: clip(text), reason: "lockfile entry without name and version" });
      continue;
    }
    accept(file, section.line, `${name}==${version}`, rejected, requirements);
  }
  return requirements;
}

function parsePipfileLock(file: string, content: string, rejected: RejectedLine[]): ParsedRequirement[] {
  const requirements: ParsedRequirement[] = [];
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    rejected.push({ file, line: 1, text: "", reason: "invalid JSON" });
    return requirements;
  }
  const section = (data as { default?: unknown } | null)?.default;
  if (!section || typeof section !== "object") return requirements;
  for (const [name, raw] of Object.entries(section as Record<string, unknown>)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const text = `${name}${typeof entry.version === "string" ? entry.version : ""}`;
    if (["git", "path", "file", "editable", "ref"].some((key) => key in entry)) {
      rejected.push({ file, line: 1, text: clip(text), reason: "non-registry lockfile source" });
      continue;
    }
    if (typeof entry.version !== "string" || !entry.version.startsWith("==")) {
      rejected.push({ file, line: 1, text: clip(text), reason: "Pipfile.lock entry is not pinned" });
      continue;
    }
    const marker = typeof entry.markers === "string" ? `; ${entry.markers}` : "";
    const hashes = Array.isArray(entry.hashes)
      ? entry.hashes.filter((hash): hash is string => typeof hash === "string" && hash.startsWith("sha256:"))
      : [];
    const line = `${name}${entry.version}${marker}${hashes.map((hash) => ` --hash=${hash}`).join("")}`;
    accept(file, 1, line, rejected, requirements);
  }
  return requirements;
}
