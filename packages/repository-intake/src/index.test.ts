import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type PaperDocument } from "@dejaml/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const tempRoots: string[] = [];
async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
  const PINNED = "49ece7ff4cc43fd4cb258678d44854f1cb2a417d";
  function fakeGit(options: { head?: string; checkoutSha?: string; symlink?: string } = {}) {
    const commands: string[][] = [];
    const runGit = vi.fn(async (args: string[]) => {
      commands.push(args);
      if (args.includes("ls-remote")) {
        return { stdout: `ref: refs/heads/main\tHEAD\n${options.head ?? PINNED}\tHEAD\n`, stderr: "" };
      }
      if (args[0] === "init") {
        await mkdir(args.at(-1)!, { recursive: true });
        return { stdout: "", stderr: "" };
      }
      if (args.includes("checkout")) {
        const destination = args[1]!;
        await writeFile(join(destination, "README.md"), "untrusted repository content");
        if (options.symlink) await symlink(options.symlink, join(destination, "link"));
        return { stdout: "", stderr: "" };
      }
      if (args.includes("rev-parse")) return { stdout: `${options.checkoutSha ?? PINNED}\n`, stderr: "" };
      if (args.includes("get-url")) return { stdout: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    return { commands, runGit };
  }
  const publicDns = async () => ["140.82.112.3"];

  it("pins the default branch to a commit, fetches exactly it with hardened Git, and records a manifest", async () => {
    const destinationRoot = await tempRoot("dejaml-acquisition-test-");
    const { commands, runGit } = fakeGit();
    const fetchMock = vi.fn(async () => githubResponse());

    const result = await acquireGithubRepository(
      {
        repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover",
        destinationRoot,
      },
      {
        fetch: fetchMock as typeof fetch,
        runGit,
        resolveHost: publicDns,
        now: () => new Date("2026-09-28T12:00:00.000Z"),
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/mtesha/tdl-vs-ml-urbanlandcover",
      expect.objectContaining({ redirect: "error" }),
    );
    const fetchCommand = commands.find((command) => command.includes("fetch"))!;
    expect(commands[0]).toEqual(expect.arrayContaining(["ls-remote", "--symref"]));
    expect(fetchCommand).toEqual(
      expect.arrayContaining([
        "credential.helper=",
        "core.hooksPath=/dev/null",
        "filter.lfs.smudge=",
        "protocol.allow=never",
        "protocol.https.allow=always",
        "protocol.file.allow=never",
        "http.followRedirects=false",
        "submodule.recurse=false",
        "--depth=1",
        "--no-tags",
        PINNED,
      ]),
    );
    expect(commands.some((command) => command.includes("clone"))).toBe(false);
    expect(result.commitSha).toBe(PINNED);
    expect(result.defaultBranch).toBe("main");
    expect(result.metadataSource).toBe("github_api");
    expect(result.fileCount).toBe(1);
    expect(result.manifest[0]).toMatchObject({ path: "README.md", bytes: 28 });
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.acquiredAt).toBe("2026-09-28T12:00:00.000Z");
    await expect(access(join(result.destination, "README.md"))).resolves.toBeUndefined();

    await cleanupAcquiredRepository({ destination: result.destination, destinationRoot });
    await expect(access(result.destination)).rejects.toThrow();
  });

  it("fetches an already pinned commit without re-pinning the branch head", async () => {
    const destinationRoot = await tempRoot("dejaml-acquisition-test-");
    const { commands, runGit } = fakeGit();
    const result = await acquireGithubRepository(
      { repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover", destinationRoot, commitSha: PINNED },
      { fetch: (async () => githubResponse()) as typeof fetch, runGit, resolveHost: publicDns },
    );
    expect(commands.some((command) => command.includes("ls-remote"))).toBe(false);
    expect(commands.find((command) => command.includes("fetch"))).toContain(PINNED);
    expect(result.commitSha).toBe(PINNED);
    await cleanupAcquiredRepository({ destination: result.destination, destinationRoot });
    await expect(
      acquireGithubRepository(
        { repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover", destinationRoot, commitSha: "main" },
        { runGit, resolveHost: publicDns, fetch: (async () => githubResponse()) as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "commit_unavailable" });
  });

  it("rejects symlinks that point outside the checkout and removes it", async () => {
    for (const target of ["/etc/passwd", "../../outside", "sub/../../escape"]) {
      const destinationRoot = await tempRoot("dejaml-acquisition-test-");
      const { runGit } = fakeGit({ symlink: target });
      await expect(
        acquireGithubRepository(
          { repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover", destinationRoot },
          { fetch: (async () => githubResponse()) as typeof fetch, runGit, resolveHost: publicDns },
        ),
      ).rejects.toMatchObject({ code: "unsafe_symlink" });
      expect(await readdir(destinationRoot)).toEqual([]);
    }
    const destinationRoot = await tempRoot("dejaml-acquisition-test-");
    const { runGit } = fakeGit({ symlink: "README.md" });
    const inside = await acquireGithubRepository(
      { repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover", destinationRoot },
      { fetch: (async () => githubResponse()) as typeof fetch, runGit, resolveHost: publicDns },
    );
    expect(inside.manifest.find((entry) => entry.path === "link")).toMatchObject({ symlinkTarget: "README.md" });
    await cleanupAcquiredRepository({ destination: inside.destination, destinationRoot });
  });

  it("continues without API metadata on 403 but rejects a missing repository", async () => {
    const destinationRoot = await tempRoot("dejaml-acquisition-403-");
    const { runGit } = fakeGit();
    const limited = await acquireGithubRepository(
      { repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover", destinationRoot },
      { fetch: (async () => new Response("{}", { status: 403 })) as typeof fetch, runGit, resolveHost: publicDns },
    );
    expect(limited.metadataSource).toBe("unavailable");
    await expect(
      acquireGithubRepository(
        { repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover", destinationRoot },
        { fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch, runGit, resolveHost: publicDns },
      ),
    ).rejects.toMatchObject({ code: "repository_unavailable" });
  });

  it("rejects a checkout that is not the pinned commit and removes it", async () => {
    const destinationRoot = await tempRoot("dejaml-acquisition-mismatch-");
    const { runGit } = fakeGit({ checkoutSha: "1".repeat(40) });
    await expect(
      acquireGithubRepository(
        { repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover", destinationRoot },
        { fetch: (async () => githubResponse()) as typeof fetch, runGit, resolveHost: publicDns },
      ),
    ).rejects.toMatchObject({ code: "acquisition_failed" });
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(destinationRoot)).toEqual([]);
  });

  it("refuses to fetch when github.com resolves to a private address", async () => {
    const destinationRoot = await tempRoot("dejaml-acquisition-dns-");
    const { runGit } = fakeGit();
    const saved = { a: process.env.HTTPS_PROXY, b: process.env.https_proxy };
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    try {
      for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1"]) {
        await expect(
          acquireGithubRepository(
            { repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover", destinationRoot },
            { fetch: (async () => githubResponse()) as typeof fetch, runGit, resolveHost: async () => [address] },
          ),
        ).rejects.toMatchObject({ code: "unsafe_network" });
      }
      expect(runGit).not.toHaveBeenCalled();
    } finally {
      if (saved.a) process.env.HTTPS_PROXY = saved.a;
      if (saved.b) process.env.https_proxy = saved.b;
    }
  });

  it("rejects private or oversized repositories before invoking Git", async () => {
    const destinationRoot = await tempRoot("dejaml-acquisition-policy-test-");
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
          fetch: (async () => githubResponse({ size: MAX_REPOSITORY_SIZE_KB + 1 })) as typeof fetch,
          runGit,
        },
      ),
    ).rejects.toMatchObject<Partial<RepositoryIntakeError>>({ code: "repository_too_large" });

    expect(runGit).not.toHaveBeenCalled();
  });

  it("refuses cleanup outside its managed acquisition directory", async () => {
    const destinationRoot = await tempRoot("dejaml-cleanup-policy-test-");
    await expect(cleanupAcquiredRepository({ destination: destinationRoot, destinationRoot })).rejects.toMatchObject<
      Partial<RepositoryIntakeError>
    >({ code: "unsafe_destination" });
  });
});
