/**
 * A deliberately small, safe subset of PEP 508 requirement lines.
 *
 * Anything that could change where pip fetches code from, or make it build or
 * execute something, is rejected: options, URLs, direct references, VCS and
 * local paths. What remains is a name, optional extras, version specifiers,
 * an optional environment marker and (on pinned lines only) sha256 hashes.
 */

export const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const MAX_NAME_LENGTH = 100;
const VERSION_PATTERN = /^[A-Za-z0-9.*+!_-]{1,64}$/u;
const SPECIFIER_PATTERN = /^\s*(===|==|!=|<=|>=|~=|<|>)\s*([^\s,]+)\s*$/u;
const MARKER_PATTERN = /^[A-Za-z0-9_ .'"<>=!()~,-]+$/u;
const MAX_MARKER_LENGTH = 200;
const MAX_SPECIFIERS = 8;
const MAX_LINE_LENGTH = 4096;
const HASH_TOKEN = /^--hash[=:]sha256:([A-Fa-f0-9]{64})$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/u;

export type VersionOperator = "===" | "==" | "!=" | "<=" | ">=" | "~=" | "<" | ">";

export type VersionSpecifier = { op: VersionOperator; version: string };

export type ParsedRequirement = {
  /** PEP 503 normalized name. */
  name: string;
  /** The name exactly as written. */
  rawName: string;
  extras: string[];
  specifiers: VersionSpecifier[];
  marker: string | null;
  /** Lower-case sha256 hex digests from trailing `--hash=sha256:` options. */
  hashes: string[];
  /** Exactly one `==`/`===` specifier without wildcards. */
  pinned: boolean;
  /** Canonical requirement text safe to hand to pip (no hashes). */
  spec: string;
  source?: { file: string; line: number };
};

export type RequirementParseResult = { ok: true; requirement: ParsedRequirement | null } | { ok: false; reason: string };

/** PEP 503 name normalization: lower-case, runs of `-_.` collapse to `-`. */
export function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, "-");
}

export function isValidPackageName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(name);
}

const OPTION_REASONS: Record<string, string> = {
  "-r": "nested requirement files (-r) are not allowed",
  "--requirement": "nested requirement files (-r) are not allowed",
  "-c": "constraint file includes (-c) are not allowed",
  "--constraint": "constraint file includes (-c) are not allowed",
  "-e": "editable installs (-e) are not allowed",
  "--editable": "editable installs (-e) are not allowed",
  "-f": "find-links (-f) are not allowed",
  "--find-links": "find-links (-f) are not allowed",
  "-i": "index overrides (-i) are not allowed",
  "--index-url": "index overrides (--index-url) are not allowed",
  "--extra-index-url": "extra indexes (--extra-index-url) are not allowed",
  "--no-index": "--no-index is not allowed",
  "--trusted-host": "--trusted-host is not allowed",
  "--pre": "--pre is not allowed",
  "--hash": "--hash must trail a pinned requirement",
};

/** Index URLs that serve accelerator builds (PyTorch CUDA/ROCm indexes, NVIDIA's index, JAX CUDA releases). */
export function isAcceleratorIndexUrl(url: string): boolean {
  return /download\.pytorch\.org\/whl\/(nightly\/)?(cu\d|rocm|xpu)|pypi\.(ngc\.)?nvidia\.com|developer\.download\.nvidia|jax_cuda|jax-releases\/cuda|repo\.radeon\.com|rocm/iu.test(
    url,
  );
}

const INDEX_OPTIONS = new Set(["-i", "--index-url", "--extra-index-url", "-f", "--find-links", "--trusted-host"]);

function rejectOptionLine(line: string): string {
  const token = line.split(/\s+/u)[0] ?? line;
  const key = token.split("=")[0] ?? token;
  if (INDEX_OPTIONS.has(key) && isAcceleratorIndexUrl(line)) {
    return `accelerator package indexes (CUDA/ROCm/GPU) are not allowed (${key}); the CPU-only policy uses the administrator's index`;
  }
  return rejectOption(token);
}

function rejectOption(token: string): string {
  const key = token.split("=")[0] ?? token;
  return OPTION_REASONS[key] ?? `pip options are not allowed (${key.slice(0, 40)})`;
}

/** Strip a trailing comment: `#` at the start or preceded by whitespace (pip's rule). */
export function stripComment(line: string): string {
  const match = /(^|\s)#/u.exec(line);
  return match ? line.slice(0, match.index) : line;
}

/**
 * Parse one logical requirement line (continuations already joined).
 * Blank and comment-only lines yield `{ ok: true, requirement: null }`.
 */
export function parseRequirementLine(input: string): RequirementParseResult {
  if (input.length > MAX_LINE_LENGTH) return { ok: false, reason: "line too long" };
  if (CONTROL_CHARS.test(input.replace(/\r$/u, ""))) {
    return { ok: false, reason: "control characters are not allowed" };
  }
  const line = stripComment(input.replace(/\r$/u, "")).replace(/\t/gu, " ").trim();
  if (line === "") return { ok: true, requirement: null };

  if (line.startsWith("-")) return { ok: false, reason: rejectOptionLine(line) };

  // Split trailing options: only `--hash=sha256:<hex>` tokens are allowed.
  const tokens = line.split(/\s+/u);
  const firstOption = tokens.findIndex((token) => token.startsWith("-") && /^-{1,2}[A-Za-z]/u.test(token));
  const hashes: string[] = [];
  let body = line;
  if (firstOption !== -1) {
    const optionTokens = tokens.slice(firstOption);
    for (const token of optionTokens) {
      const hash = HASH_TOKEN.exec(token);
      if (!hash?.[1]) {
        if (token.startsWith("--hash")) return { ok: false, reason: "only --hash=sha256:<64 hex> hashes are allowed" };
        return { ok: false, reason: `embedded option: ${rejectOption(token)}` };
      }
      hashes.push(hash[1].toLowerCase());
    }
    body = tokens.slice(0, firstOption).join(" ");
  }

  if (/\b(git|hg|svn|bzr)\+/iu.test(body)) return { ok: false, reason: "VCS references are not allowed" };
  if (/^[A-Za-z0-9._-]+\s*(\[[^\]]*\])?\s*@/u.test(body)) {
    return { ok: false, reason: "direct references (name @ url) are not allowed" };
  }
  if (/:\/\//u.test(body) || /^[a-z][a-z0-9+.-]*:/iu.test(body)) {
    if (/^file:/iu.test(body)) return { ok: false, reason: "local paths are not allowed" };
    return { ok: false, reason: "URLs are not allowed" };
  }
  if (/\b(git|hg|svn|bzr)\+/iu.test(body)) return { ok: false, reason: "VCS references are not allowed" };
  if (/^(\.{1,2}(\/|\\|$)|\/|~|\\|[A-Za-z]:[\\/])/u.test(body)) {
    return { ok: false, reason: "local paths are not allowed" };
  }

  const semicolon = body.indexOf(";");
  const requirementPart = (semicolon === -1 ? body : body.slice(0, semicolon)).trim();
  if (requirementPart.includes("@")) return { ok: false, reason: "direct references (name @ url) are not allowed" };
  let marker: string | null = null;
  if (semicolon !== -1) {
    marker = body.slice(semicolon + 1).trim();
    if (marker === "") return { ok: false, reason: "empty environment marker" };
    if (marker.length > MAX_MARKER_LENGTH) return { ok: false, reason: "environment marker too long" };
    if (!MARKER_PATTERN.test(marker)) return { ok: false, reason: "environment marker contains disallowed characters" };
    marker = marker.replace(/\s+/gu, " ");
  }

  const head = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*(.*)$/u.exec(requirementPart);
  if (!head?.[1]) return { ok: false, reason: "invalid package name" };
  const rawName = head[1];
  if (!isValidPackageName(rawName)) return { ok: false, reason: "invalid package name" };

  const extras: string[] = [];
  if (head[2] !== undefined) {
    for (const extra of head[2].split(",").map((value) => value.trim())) {
      if (extra === "") continue;
      if (!isValidPackageName(extra)) return { ok: false, reason: "invalid extra name" };
      extras.push(normalizePackageName(extra));
    }
  }

  const specifiers: VersionSpecifier[] = [];
  const specText = (head[3] ?? "").trim();
  if (specText !== "") {
    const parts = specText.split(",");
    if (parts.length > MAX_SPECIFIERS) return { ok: false, reason: "too many version specifiers" };
    for (const part of parts) {
      const match = SPECIFIER_PATTERN.exec(part);
      if (!match?.[1] || !match[2]) return { ok: false, reason: "invalid version specifier" };
      if (!VERSION_PATTERN.test(match[2])) return { ok: false, reason: "invalid version" };
      specifiers.push({ op: match[1] as VersionOperator, version: match[2] });
    }
  }

  const only = specifiers.length === 1 ? specifiers[0] : undefined;
  const pinned = only !== undefined && (only.op === "==" || only.op === "===") && !only.version.includes("*");
  if (hashes.length > 0 && !pinned) {
    return { ok: false, reason: "--hash is allowed only on pinned (==) requirements" };
  }

  const name = normalizePackageName(rawName);
  const spec =
    name +
    (extras.length > 0 ? `[${extras.join(",")}]` : "") +
    specifiers.map((specifier) => `${specifier.op}${specifier.version}`).join(",") +
    (marker ? `; ${marker}` : "");
  return { ok: true, requirement: { name, rawName, extras, specifiers, marker, hashes, pinned, spec } };
}

/** Split file text into logical lines, joining `\` continuations. */
export function logicalLines(text: string): { line: number; text: string }[] {
  const physical = text.split("\n");
  const result: { line: number; text: string }[] = [];
  let buffer = "";
  let start = 0;
  physical.forEach((raw, index) => {
    const value = raw.replace(/\r$/u, "");
    if (buffer === "") start = index + 1;
    // A continuation only counts when the backslash is not inside a comment.
    if (value.endsWith("\\") && !/(^|\s)#/u.test(value)) {
      buffer += value.slice(0, -1) + " ";
      return;
    }
    result.push({ line: start, text: buffer + value });
    buffer = "";
  });
  if (buffer !== "") result.push({ line: start, text: buffer });
  return result;
}
