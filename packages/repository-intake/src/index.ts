import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type PaperDocument,
  type RepositoryAcquisition,
  RepositoryAcquisitionSchema,
  type RepositoryCandidate,
  RepositoryCandidateSchema,
} from "@dejaml/contracts";
import { isPublicAddress } from "@dejaml/net-guard";
import { z } from "zod";

export const MAX_REPOSITORY_SIZE_KB = 100_000;
export const MAX_CHECKED_OUT_BYTES = 250 * 1024 * 1024;
export const MAX_CHECKED_OUT_FILES = 20_000;
export const DEFAULT_ACQUISITION_TIMEOUT_MS = 60_000;
export const ACQUISITION_DIRECTORY_PREFIX = "dejaml-repo-";

const GITHUB_LINK_PATTERN = /https?:\/\/(?:www\.)?github\.com\/[^\s<>()\[\]{}"'`]+/giu;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const RESERVED_OWNERS = new Set([
  "about",
  "collections",
  "contact",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "search",
  "security",
  "settings",
  "sponsors",
  "topics",
  "trending",
  "users",
]);

const GitHubRepositoryResponseSchema = z.object({
  private: z.boolean(),
  size: z.number().int().nonnegative(),
  default_branch: z.string().min(1),
  html_url: z.string().url(),
  clone_url: z.string().url(),
});

export class RepositoryIntakeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_repository_url"
      | "repository_unavailable"
      | "private_repository"
      | "repository_too_large"
      | "acquisition_failed"
      | "checkout_too_large"
      | "unsafe_destination"
      | "unsafe_network"
      | "unsafe_symlink"
      | "commit_unavailable",
  ) {
    super(message);
    this.name = "RepositoryIntakeError";
  }
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/u, "").replace(/\)+$/u, "");
}

export function canonicalizeGithubRepositoryUrl(rawUrl: string): {
  repositoryUrl: string;
  owner: string;
  name: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(trimUrlPunctuation(rawUrl));
  } catch {
    throw new RepositoryIntakeError("repository URL is malformed", "invalid_repository_url");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !["github.com", "www.github.com"].includes(parsed.hostname.toLowerCase()) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  ) {
    throw new RepositoryIntakeError(
      "only direct GitHub repository URLs are supported",
      "invalid_repository_url",
    );
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new RepositoryIntakeError("GitHub URL does not identify a repository", "invalid_repository_url");
  }

  const owner = segments[0] ?? "";
  const repositorySegment = segments[1] ?? "";
  const name = repositorySegment.toLowerCase().endsWith(".git")
    ? repositorySegment.slice(0, -4)
    : repositorySegment;
  if (
    !OWNER_PATTERN.test(owner) ||
    RESERVED_OWNERS.has(owner.toLowerCase()) ||
    !REPOSITORY_PATTERN.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new RepositoryIntakeError("GitHub owner or repository name is invalid", "invalid_repository_url");
  }

  return {
    repositoryUrl: `https://github.com/${owner}/${name}`,
    owner,
    name,
  };
}

export function discoverGithubRepositories(document: PaperDocument): RepositoryCandidate[] {
  const candidates = new Map<string, RepositoryCandidate>();

  for (const page of document.pages) {
    for (const match of page.text.matchAll(GITHUB_LINK_PATTERN)) {
      const rawUrl = trimUrlPunctuation(match[0]);
      try {
        const canonical = canonicalizeGithubRepositoryUrl(rawUrl);
        const key = canonical.repositoryUrl.toLowerCase();
        const current = candidates.get(key);
        if (current) {
          if (!current.occurrences.some((item) => item.pageNumber === page.pageNumber && item.rawUrl === rawUrl)) {
            current.occurrences.push({ pageNumber: page.pageNumber, rawUrl });
          }
          continue;
        }
        candidates.set(
          key,
          RepositoryCandidateSchema.parse({
            ...canonical,
            occurrences: [{ pageNumber: page.pageNumber, rawUrl }],
          }),
        );
      } catch (error) {
        if (!(error instanceof RepositoryIntakeError)) {
          throw error;
        }
      }
    }
  }

  return [...candidates.values()];
}

type CommandResult = { stdout: string; stderr: string };
type RunGit = (args: string[], options: { cwd?: string; timeoutMs: number; signal?: AbortSignal }) => Promise<CommandResult>;

/**
 * Operator network settings Git may need (an egress proxy and its CA). No
 * credential, token, or other host variable ever reaches Git.
 */
const PASS_THROUGH_ENV = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "GIT_SSL_CAINFO", "SSL_CERT_FILE"];

function defaultRunGit(
  args: string[],
  options: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const environment: NodeJS.ProcessEnv = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "https",
      GIT_LFS_SKIP_SMUDGE: "1",
      GCM_INTERACTIVE: "Never",
      LANG: "C",
      LC_ALL: "C",
    };
    if (process.env.PATH) environment.PATH = process.env.PATH;
    if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;
    for (const key of PASS_THROUGH_ENV) {
      const value = process.env[key];
      if (value) environment[key] = value;
    }

    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: environment,
        maxBuffer: 1024 * 1024,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(stderr.trim() || error.message));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

async function measureCheckout(root: string): Promise<{ bytes: number; files: number }> {
  const pending = [root];
  let bytes = 0;
  let files = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".git") continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        const metadata = await lstat(entryPath);
        bytes += metadata.size;
        files += 1;
      } else if (entry.isSymbolicLink()) {
        files += 1;
        // A link must stay inside the checkout: no absolute targets, no escapes.
        const target = await readlink(entryPath);
        const resolved = resolve(dirname(entryPath), target);
        if (isAbsolute(target) || (resolved !== root && !resolved.startsWith(`${root}${sep}`))) {
          throw new RepositoryIntakeError(
            `unsafe symlink ${relative(root, entryPath)} points outside the repository`,
            "unsafe_symlink",
          );
        }
      }
      if (bytes > MAX_CHECKED_OUT_BYTES || files > MAX_CHECKED_OUT_FILES) {
        throw new RepositoryIntakeError(
          "checked-out repository exceeds local inspection limits",
          "checkout_too_large",
        );
      }
    }
  }
  return { bytes, files };
}

async function checkedRoot(destinationRoot: string): Promise<string> {
  if (!isAbsolute(destinationRoot)) {
    throw new RepositoryIntakeError("acquisition root must be absolute", "unsafe_destination");
  }
  await mkdir(destinationRoot, { recursive: true });
  return realpath(destinationRoot);
}

export type ManifestEntry = { path: string; bytes: number; sha256: string | null; symlinkTarget?: string };

export type RepositoryReceipt = RepositoryAcquisition & {
  /** How the repository's size and visibility were checked. */
  metadataSource: "github_api" | "unavailable";
  fileCount: number;
  totalBytes: number;
  /** SHA-256 of the canonical JSON manifest (sorted paths with sizes and digests). */
  manifestSha256: string;
  manifest: ManifestEntry[];
};

async function assertPublicGithub(resolveHost: (host: string) => Promise<string[]>): Promise<void> {
  // Behind an operator egress proxy, the proxy resolves and connects; there is
  // nothing local to check. Otherwise refuse a DNS answer that points GitHub
  // at a private or local network.
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return;
  const addresses = await resolveHost("github.com");
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new RepositoryIntakeError("github.com resolved to a non-public address", "unsafe_network");
  }
}

async function directorySize(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else {
        files += 1;
        bytes += (await lstat(path).catch(() => ({ size: 0 }))).size;
      }
    }
  }
  return { bytes, files };
}

/** Hashes every checked-out file without following symlinks. */
export async function buildRepositoryManifest(root: string): Promise<{ entries: ManifestEntry[]; bytes: number; sha256: string }> {
  const entries: ManifestEntry[] = [];
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const relativePath = path.slice(root.length + 1).split("\\").join("/");
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: relativePath, bytes: 0, sha256: null, symlinkTarget: (await readlink(path)).slice(0, 500) });
      } else if (entry.isFile()) {
        const content = await readFile(path);
        bytes += content.length;
        entries.push({ path: relativePath, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
      }
      if (bytes > MAX_CHECKED_OUT_BYTES || entries.length > MAX_CHECKED_OUT_FILES) {
        throw new RepositoryIntakeError("checked-out repository exceeds local inspection limits", "checkout_too_large");
      }
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { entries, bytes, sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
}

const HARDENED_GIT_CONFIG = [
  "-c", "credential.helper=",
  "-c", "core.askPass=",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "filter.lfs.smudge=",
  "-c", "filter.lfs.process=",
  "-c", "filter.lfs.required=false",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.file.allow=never",
  "-c", "http.followRedirects=false",
  "-c", "submodule.recurse=false",
  "-c", "fetch.recurseSubmodules=false",
  "-c", "transfer.fsckObjects=true",
];

/**
 * Trust zone 1: acquires a public GitHub repository at an immutable commit.
 * The default branch head is pinned with `ls-remote` first, then exactly that
 * commit is fetched (never "whatever the branch is now"). Git runs with
 * hooks, credential helpers, LFS, submodules, redirects, and every protocol
 * except HTTPS disabled, and no repository code runs. Size and file count are
 * enforced while the fetch runs, and the receipt carries a hashed manifest.
 */
export async function acquireGithubRepository(
  input: {
    repositoryUrl: string;
    destinationRoot: string;
    /** Fetch exactly this commit instead of pinning the default branch head (for resuming a study). */
    commitSha?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
  dependencies: {
    fetch?: typeof fetch;
    runGit?: RunGit;
    now?: () => Date;
    resolveHost?: (host: string) => Promise<string[]>;
  } = {},
): Promise<RepositoryReceipt> {
  const canonical = canonicalizeGithubRepositoryUrl(input.repositoryUrl);
  if (canonical.repositoryUrl !== input.repositoryUrl) {
    throw new RepositoryIntakeError(
      "acquisition requires the canonical HTTPS repository URL",
      "invalid_repository_url",
    );
  }

  const fetchImplementation = dependencies.fetch ?? fetch;
  const runGit = dependencies.runGit ?? defaultRunGit;
  const timeoutMs = input.timeoutMs ?? DEFAULT_ACQUISITION_TIMEOUT_MS;
  const apiUrl = `https://api.github.com/repos/${canonical.owner}/${canonical.name}`;

  // Size and visibility from the API when it answers. A 403 or 429 (rate
  // limit, or a network that blocks the API) is not fatal: the fetch below is
  // bounded by its own size watcher, and a private repository cannot be
  // fetched anonymously anyway.
  let metadata: z.infer<typeof GitHubRepositoryResponseSchema> | null = null;
  let response: Response | null = null;
  try {
    response = await fetchImplementation(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "dejaml-repository-intake/0.1",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
    });
  } catch {
    response = null;
  }
  if (response && response.status === 404) {
    throw new RepositoryIntakeError("GitHub repository metadata returned HTTP 404", "repository_unavailable");
  }
  if (response?.ok) {
    try {
      metadata = GitHubRepositoryResponseSchema.parse(await response.json());
    } catch (error) {
      throw new RepositoryIntakeError(
        `GitHub metadata was invalid: ${error instanceof Error ? error.message : String(error)}`,
        "repository_unavailable",
      );
    }
    if (metadata.private) {
      throw new RepositoryIntakeError("private repositories are not supported", "private_repository");
    }
    if (metadata.size > MAX_REPOSITORY_SIZE_KB) {
      throw new RepositoryIntakeError(
        `repository size ${metadata.size} KiB exceeds the ${MAX_REPOSITORY_SIZE_KB} KiB limit`,
        "repository_too_large",
      );
    }
    const metadataHtml = canonicalizeGithubRepositoryUrl(metadata.html_url);
    const metadataClone = canonicalizeGithubRepositoryUrl(metadata.clone_url);
    if (
      metadataHtml.repositoryUrl.toLowerCase() !== canonical.repositoryUrl.toLowerCase() ||
      metadataClone.repositoryUrl.toLowerCase() !== canonical.repositoryUrl.toLowerCase()
    ) {
      throw new RepositoryIntakeError(
        "GitHub metadata resolved to a different repository",
        "repository_unavailable",
      );
    }
  } else if (response && ![403, 429].includes(response.status)) {
    throw new RepositoryIntakeError(
      `GitHub repository metadata returned HTTP ${response.status}`,
      "repository_unavailable",
    );
  }

  await assertPublicGithub(
    dependencies.resolveHost ?? (async (host) => (await lookup(host, { all: true })).map((item) => item.address)),
  );

  const root = await checkedRoot(input.destinationRoot);
  const destination = await mkdtemp(join(root, ACQUISITION_DIRECTORY_PREFIX));
  const watcher = new AbortController();
  const onAbort = () => watcher.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  let overLimit = false;
  const poll = setInterval(() => {
    void directorySize(destination).then((size) => {
      if (size.bytes > MAX_CHECKED_OUT_BYTES * 2 || size.files > MAX_CHECKED_OUT_FILES * 4) {
        overLimit = true;
        watcher.abort();
      }
    });
  }, 500);
  try {
    // 1. Pin the default branch head to an immutable commit, or use the one already pinned.
    if (input.commitSha !== undefined && !/^[a-f0-9]{40}$/u.test(input.commitSha)) {
      throw new RepositoryIntakeError("a pinned commit must be a full lowercase SHA", "commit_unavailable");
    }
    const remote = input.commitSha
      ? { stdout: "" }
      : await runGit([...HARDENED_GIT_CONFIG, "ls-remote", "--symref", "--", canonical.repositoryUrl, "HEAD"], {
          timeoutMs,
          signal: watcher.signal,
        });
    const branch = input.commitSha
      ? (metadata?.default_branch ?? "pinned")
      : (/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/mu.exec(remote.stdout)?.[1] ?? metadata?.default_branch ?? null);
    const pinned = input.commitSha ?? /^([a-f0-9]{40})\s+HEAD$/mu.exec(remote.stdout)?.[1] ?? null;
    if (!pinned || !branch) {
      throw new RepositoryIntakeError("could not pin the repository's default branch to a commit", "repository_unavailable");
    }

    // 2. Fetch exactly that commit, blobs included, into an empty repository.
    await runGit(["init", "--quiet", "--", destination], { timeoutMs, signal: watcher.signal });
    await runGit(["-C", destination, "remote", "add", "origin", canonical.repositoryUrl], { timeoutMs, signal: watcher.signal });
    await runGit(
      ["-C", destination, ...HARDENED_GIT_CONFIG, "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "origin", pinned],
      { timeoutMs, signal: watcher.signal },
    );
    await runGit(["-C", destination, ...HARDENED_GIT_CONFIG, "checkout", "--quiet", "--detach", "FETCH_HEAD"], {
      timeoutMs,
      signal: watcher.signal,
    });

    const [commitResult, originResult] = await Promise.all([
      runGit(["-C", destination, "rev-parse", "HEAD"], { timeoutMs }),
      runGit(["-C", destination, "remote", "get-url", "origin"], { timeoutMs }),
    ]);
    const commitSha = commitResult.stdout.trim().toLowerCase();
    if (commitSha !== pinned) {
      throw new RepositoryIntakeError("checked-out commit differs from the pinned commit", "acquisition_failed");
    }
    const origin = canonicalizeGithubRepositoryUrl(originResult.stdout.trim());
    if (origin.repositoryUrl.toLowerCase() !== canonical.repositoryUrl.toLowerCase()) {
      throw new RepositoryIntakeError("cloned origin does not match the approved repository", "acquisition_failed");
    }
    await measureCheckout(destination);
    const manifest = await buildRepositoryManifest(destination);

    const acquisition = RepositoryAcquisitionSchema.parse({
      schemaVersion: 1,
      repositoryUrl: canonical.repositoryUrl,
      commitSha,
      defaultBranch: branch,
      repositorySizeKb: metadata?.size ?? Math.ceil(manifest.bytes / 1024),
      destination,
      acquiredAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    });
    return {
      ...acquisition,
      metadataSource: metadata ? "github_api" : "unavailable",
      fileCount: manifest.entries.length,
      totalBytes: manifest.bytes,
      manifestSha256: manifest.sha256,
      manifest: manifest.entries,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    if (overLimit) {
      throw new RepositoryIntakeError("repository fetch exceeded the size or file-count limit", "checkout_too_large");
    }
    if (error instanceof RepositoryIntakeError) throw error;
    throw new RepositoryIntakeError(
      `repository acquisition failed: ${error instanceof Error ? error.message : String(error)}`,
      "acquisition_failed",
    );
  } finally {
    clearInterval(poll);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export async function cleanupAcquiredRepository(input: {
  destination: string;
  destinationRoot: string;
}): Promise<void> {
  const root = await checkedRoot(input.destinationRoot);
  const destination = resolve(input.destination);
  if (
    dirname(destination) !== root ||
    !basename(destination).startsWith(ACQUISITION_DIRECTORY_PREFIX)
  ) {
    throw new RepositoryIntakeError("refusing to remove an unmanaged directory", "unsafe_destination");
  }
  const metadata = await lstat(destination);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RepositoryIntakeError("managed checkout path is not a directory", "unsafe_destination");
  }
  await rm(destination, { recursive: true, force: false });
}
