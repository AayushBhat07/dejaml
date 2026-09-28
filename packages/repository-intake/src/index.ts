import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  type PaperDocument,
  type RepositoryAcquisition,
  RepositoryAcquisitionSchema,
  type RepositoryCandidate,
  RepositoryCandidateSchema,
} from "@dejaml/contracts";
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
      | "unsafe_destination",
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
type RunGit = (args: string[], options: { cwd?: string; timeoutMs: number }) => Promise<CommandResult>;

function defaultRunGit(
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const environment: NodeJS.ProcessEnv = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      LANG: "C",
      LC_ALL: "C",
    };
    if (process.env.PATH) environment.PATH = process.env.PATH;
    if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;

    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: environment,
        maxBuffer: 1024 * 1024,
        timeout: options.timeoutMs,
        windowsHide: true,
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

export async function acquireGithubRepository(
  input: {
    repositoryUrl: string;
    destinationRoot: string;
    timeoutMs?: number;
  },
  dependencies: {
    fetch?: typeof fetch;
    runGit?: RunGit;
    now?: () => Date;
  } = {},
): Promise<RepositoryAcquisition> {
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
  let response: Response;
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
  } catch (error) {
    throw new RepositoryIntakeError(
      `GitHub metadata request failed: ${error instanceof Error ? error.message : String(error)}`,
      "repository_unavailable",
    );
  }
  if (!response.ok) {
    throw new RepositoryIntakeError(
      `GitHub repository metadata returned HTTP ${response.status}`,
      "repository_unavailable",
    );
  }

  let metadata: z.infer<typeof GitHubRepositoryResponseSchema>;
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

  const root = await checkedRoot(input.destinationRoot);
  const destination = await mkdtemp(join(root, ACQUISITION_DIRECTORY_PREFIX));
  try {
    await runGit(
      [
        "-c",
        "credential.helper=",
        "-c",
        "core.askPass=",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "filter.lfs.smudge=",
        "-c",
        "filter.lfs.required=false",
        "-c",
        "protocol.file.allow=never",
        "clone",
        "--depth=1",
        "--filter=blob:none",
        "--no-tags",
        "--single-branch",
        "--branch",
        metadata.default_branch,
        "--",
        canonical.repositoryUrl,
        destination,
      ],
      { timeoutMs },
    );

    const [commitResult, originResult] = await Promise.all([
      runGit(["-C", destination, "rev-parse", "HEAD"], { timeoutMs }),
      runGit(["-C", destination, "remote", "get-url", "origin"], { timeoutMs }),
    ]);
    const commitSha = commitResult.stdout.trim().toLowerCase();
    const origin = canonicalizeGithubRepositoryUrl(originResult.stdout.trim());
    if (origin.repositoryUrl.toLowerCase() !== canonical.repositoryUrl.toLowerCase()) {
      throw new RepositoryIntakeError("cloned origin does not match the approved repository", "acquisition_failed");
    }
    await measureCheckout(destination);

    return RepositoryAcquisitionSchema.parse({
      schemaVersion: 1,
      repositoryUrl: canonical.repositoryUrl,
      commitSha,
      defaultBranch: metadata.default_branch,
      repositorySizeKb: metadata.size,
      destination,
      acquiredAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    if (error instanceof RepositoryIntakeError) throw error;
    throw new RepositoryIntakeError(
      `repository acquisition failed: ${error instanceof Error ? error.message : String(error)}`,
      "acquisition_failed",
    );
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
