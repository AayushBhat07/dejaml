import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type PaperDocument } from "@dejaml/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  acquireGithubRepository,
  canonicalizeGithubRepositoryUrl,
  cleanupAcquiredRepository,
  discoverGithubRepositories,
  MAX_REPOSITORY_SIZE_KB,
  RepositoryIntakeError,
} from "./index.js";

function paperWithPages(texts: string[]): PaperDocument {
  const pages = texts.map((text, index) => ({
    pageNumber: index + 1,
    text,
    charCount: text.length,
  }));
  return {
    schemaVersion: 1,
    file: {
      originalName: "paper.pdf",
      bytes: 1234,
      sha256: "a".repeat(64),
    },
    pageCount: pages.length,
    pages,
    totalTextChars: texts.reduce((total, text) => total + text.length, 0),
    warnings: [],
  };
}

function githubResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      private: false,
      size: 120,
      default_branch: "main",
      html_url: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover",
      clone_url: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover.git",
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("GitHub repository discovery", () => {
  it("finds, canonicalizes, deduplicates, and page-anchors repository links", () => {
    const candidates = discoverGithubRepositories(
      paperWithPages([
        "Code: http://www.github.com/mtesha/tdl-vs-ml-urbanlandcover/tree/main.",
        "Repository https://github.com/mtesha/tdl-vs-ml-urbanlandcover.git). Ignore https://github.com.evil.test/a/b.",
      ]),
    );

    expect(candidates).toEqual([
      {
        repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover",
        owner: "mtesha",
        name: "tdl-vs-ml-urbanlandcover",
        occurrences: [
          {
            pageNumber: 1,
            rawUrl: "http://www.github.com/mtesha/tdl-vs-ml-urbanlandcover/tree/main",
          },
          {
            pageNumber: 2,
            rawUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover.git",
          },
        ],
      },
    ]);
  });

  it("rejects credentials, lookalike hosts, and non-repository GitHub paths", () => {
    for (const url of [
      "https://token@github.com/owner/repo",
      "https://github.com.evil.test/owner/repo",
      "https://github.com/settings/profile",
      "file:///tmp/repo",
    ]) {
      expect(() => canonicalizeGithubRepositoryUrl(url)).toThrow(RepositoryIntakeError);
    }
  });
});

describe("GitHub repository acquisition", () => {
  it("checks metadata, uses bounded Git arguments, pins HEAD, and cleans up", async () => {
    const destinationRoot = await mkdtemp(join(tmpdir(), "dejaml-acquisition-test-"));
    const commands: string[][] = [];
    const runGit = vi.fn(async (args: string[]) => {
      commands.push(args);
      if (args.includes("clone")) {
        const destination = args.at(-1);
        if (!destination) throw new Error("missing clone destination");
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "README.md"), "untrusted repository content");
        return { stdout: "", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        return { stdout: "49ece7ff4cc43fd4cb258678d44854f1cb2a417d\n", stderr: "" };
      }
      return {
        stdout: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover\n",
        stderr: "",
      };
    });
    const fetchMock = vi.fn(async () => githubResponse());

    const result = await acquireGithubRepository(
      {
        repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover",
        destinationRoot,
      },
      {
        fetch: fetchMock as typeof fetch,
        runGit,
        now: () => new Date("2026-09-28T12:00:00.000Z"),
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/mtesha/tdl-vs-ml-urbanlandcover",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(commands[0]).toEqual(
      expect.arrayContaining([
        "credential.helper=",
        "core.hooksPath=/dev/null",
        "filter.lfs.smudge=",
        "protocol.file.allow=never",
        "--depth=1",
        "--filter=blob:none",
        "--no-tags",
      ]),
    );
    expect(result.commitSha).toBe("49ece7ff4cc43fd4cb258678d44854f1cb2a417d");
    expect(result.acquiredAt).toBe("2026-09-28T12:00:00.000Z");
    await expect(access(join(result.destination, "README.md"))).resolves.toBeUndefined();

    await cleanupAcquiredRepository({ destination: result.destination, destinationRoot });
    await expect(access(result.destination)).rejects.toThrow();
  });

  it("rejects private or oversized repositories before invoking Git", async () => {
    const destinationRoot = await mkdtemp(join(tmpdir(), "dejaml-acquisition-policy-test-"));
    const runGit = vi.fn();

    await expect(
      acquireGithubRepository(
        {
          repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover",
          destinationRoot,
        },
        { fetch: (async () => githubResponse({ private: true })) as typeof fetch, runGit },
      ),
    ).rejects.toMatchObject<Partial<RepositoryIntakeError>>({ code: "private_repository" });

    await expect(
      acquireGithubRepository(
        {
          repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover",
          destinationRoot,
        },
        {
          fetch: (async () =>
            githubResponse({ size: MAX_REPOSITORY_SIZE_KB + 1 })) as typeof fetch,
          runGit,
        },
      ),
    ).rejects.toMatchObject<Partial<RepositoryIntakeError>>({ code: "repository_too_large" });

    expect(runGit).not.toHaveBeenCalled();
  });

  it("refuses cleanup outside its managed acquisition directory", async () => {
    const destinationRoot = await mkdtemp(join(tmpdir(), "dejaml-cleanup-policy-test-"));
    await expect(
      cleanupAcquiredRepository({ destination: destinationRoot, destinationRoot }),
    ).rejects.toMatchObject<Partial<RepositoryIntakeError>>({ code: "unsafe_destination" });
  });
});
