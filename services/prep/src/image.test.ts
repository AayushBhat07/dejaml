import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlatformSpec } from "@dejaml/contracts";
import type { ContainerRuntime, RuntimeCommandOptions, RuntimeCommandResult } from "@dejaml/lab-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DependencyPreparer } from "./downloader.js";
import { PrepError } from "./errors.js";
import {
  classifyPinnedDigest,
  DockerPrepImageProvider,
  imageMatchesPin,
  OFFICIAL_PYTHON_PLATFORM_MANIFESTS,
  parsePinnedReference,
  platformDigestFor,
  type PrepImageProvider,
} from "./image.js";
import { DEFAULT_PREP_IMAGES, parsePrepPolicy } from "./policy.js";

const DIGEST = "sha256:e41613d42d4891e4930f79523f93f81bbc7632584ec65e36ab055f41a800b41e";
const PINNED = `python:3.11-slim-trixie@${DIGEST}`;
const BY_DIGEST = `python@${DIGEST}`;
const PLATFORM_ID = `sha256:${"1".repeat(64)}`;
/** The python:3.11-slim-trixie platform manifests inside the index DIGEST (lab-images/python-base/bases.lock.json). */
const AMD64_MANIFEST = "sha256:174bec68e0451bffabbb08c7d5d21c6b253f772d81d52b9558af97bb3159b761";
const ARM64_MANIFEST = "sha256:8b29ec24b5f3c929a79b55772b95c93311b7133f1cf7fa0a6141ef621f8e3c57";

function result(stdout = "", stderr = "", exitCode: number | null = 0): RuntimeCommandResult {
  return {
    exitCode,
    stdout: { text: stdout, bytes: stdout.length, truncated: false },
    stderr: { text: stderr, bytes: stderr.length, truncated: false },
    aborted: false,
  };
}

/** A Docker image store that, like the real one, knows the image only by what it was pulled as. */
class StoreRuntime implements ContainerRuntime {
  readonly calls: string[][] = [];
  /** reference -> platforms with content. */
  readonly refs = new Map<string, Set<string>>();
  pullDelayMs = 0;
  failure: string | null = null;
  legacyCli = false;

  async docker(args: readonly string[], _options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    this.calls.push([...args]);
    if (this.failure) return result("", this.failure, 1);
    if (args[0] === "image" && args[1] === "inspect") {
      if (this.legacyCli && args.includes("--platform")) return result("", "unknown flag: --platform", 125);
      const reference = args.at(-1) ?? "";
      const platform = args[args.indexOf("--platform") + 1] ?? "linux/amd64";
      const present = this.refs.get(reference);
      if (!present) return result("", `Error response from daemon: No such image: ${reference}`, 1);
      if (!this.legacyCli && !present.has(platform)) return result(`${PLATFORM_ID}|||["python@${DIGEST}"]\n`);
      const actual = this.legacyCli ? ([...present][0] ?? "linux/amd64") : platform;
      return result(`${PLATFORM_ID}|linux|${actual.split("/")[1]}|["python@${DIGEST}"]\n`);
    }
    if (args[0] === "pull") {
      await new Promise((resolve) => setTimeout(resolve, this.pullDelayMs));
      const reference = args.at(-1) ?? "";
      this.refs.set(reference, new Set([...(this.refs.get(reference) ?? []), args[2] ?? ""]));
      return result();
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  }
}

let store: StoreRuntime;
beforeEach(() => {
  store = new StoreRuntime();
});

describe("parsePinnedReference", () => {
  it("requires a digest and canonicalizes Docker Hub names", () => {
    expect(parsePinnedReference(PINNED)).toEqual({
      reference: PINNED,
      repository: "python",
      tag: "3.11-slim-trixie",
      digest: DIGEST,
      digestReference: BY_DIGEST,
    });
    expect(parsePinnedReference(`docker.io/library/python@${DIGEST}`).repository).toBe("python");
    expect(parsePinnedReference(`registry.example.org:5000/team/python:3.11@${DIGEST}`)).toMatchObject({
      repository: "registry.example.org:5000/team/python",
      digestReference: `registry.example.org:5000/team/python@${DIGEST}`,
    });
    expect(() => parsePinnedReference("python:3.11-slim-trixie")).toThrow(/pinned by digest/u);
    expect(() => parsePinnedReference(`--privileged@${DIGEST}`)).toThrow(PrepError);
  });

  it("matches the pin by repo digest or containerd image ID, never by tag", () => {
    const pinned = parsePinnedReference(PINNED);
    expect(imageMatchesPin({ imageId: PLATFORM_ID, repoDigests: [`docker.io/library/python@${DIGEST}`] }, pinned)).toBe(true);
    expect(imageMatchesPin({ imageId: DIGEST, repoDigests: [] }, pinned)).toBe(true);
    expect(imageMatchesPin({ imageId: PLATFORM_ID, repoDigests: [`evil/python@${DIGEST}`] }, pinned)).toBe(false);
    expect(imageMatchesPin({ imageId: PLATFORM_ID, repoDigests: [`python@sha256:${"0".repeat(64)}`] }, pinned)).toBe(false);
  });
});

describe("per-platform digests", () => {
  it("mirrors lab-images/python-base/bases.lock.json, and every default pin is a multi-platform index", async () => {
    const lock = JSON.parse(await readFile(new URL("../../../lab-images/python-base/bases.lock.json", import.meta.url), "utf8")) as {
      bases: Record<string, { index: string; platforms: Record<string, string> }>;
    };
    const fromLock = Object.fromEntries(Object.values(lock.bases).map((base) => [base.index, base.platforms]));
    expect(OFFICIAL_PYTHON_PLATFORM_MANIFESTS).toEqual(fromLock);
    for (const [version, reference] of Object.entries(DEFAULT_PREP_IMAGES)) {
      expect(lock.bases[version]?.index).toBe(parsePinnedReference(reference).digest);
      expect(classifyPinnedDigest(parsePinnedReference(reference).digest).kind).toBe("index");
    }
  });

  it("uses each platform's own manifest digest and never another platform's", () => {
    const index = parsePinnedReference(PINNED);
    expect(platformDigestFor(index, "linux/amd64")).toBe(AMD64_MANIFEST);
    expect(platformDigestFor(index, "linux/arm64")).toBe(ARM64_MANIFEST);
    const arm = parsePinnedReference(`python:3.11-slim-trixie@${ARM64_MANIFEST}`);
    expect(platformDigestFor(arm, "linux/arm64")).toBe(ARM64_MANIFEST);
    expect(() => platformDigestFor(arm, "linux/amd64")).toThrow(expect.objectContaining({ code: "platform_mismatch" }));
    const amd = parsePinnedReference(`python@${AMD64_MANIFEST}`);
    expect(() => platformDigestFor(amd, "linux/arm64")).toThrow(/pins the linux\/amd64 manifest/u);
    expect(platformDigestFor(parsePinnedReference(`registry.example.org/python@sha256:${"c".repeat(64)}`), "linux/arm64")).toBeNull();
  });
});

describe("DockerPrepImageProvider", () => {
  it("finds an image that was pulled by digest (no local tag) - the old 'missing' bug", async () => {
    // `docker pull python:3.11-slim-trixie@sha256:…` stores only python@sha256:…; the tag lookup the
    // old code did (`docker image inspect python:3.13.15-slim-trixie`) said "No such image".
    store.refs.set(BY_DIGEST, new Set(["linux/amd64"]));
    const image = await new DockerPrepImageProvider(store).ensure({ key: "k", reference: PINNED, platform: "linux/amd64" });
    expect(image).toEqual({ reference: PINNED, imageId: PLATFORM_ID, repoDigests: [BY_DIGEST], platform: "linux/amd64" });
    expect(store.calls).toEqual([
      ["image", "inspect", "--platform", "linux/amd64", "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}|{{json .RepoDigests}}", BY_DIGEST],
    ]);
  });

  it("does not report a Docker failure as a missing image", async () => {
    store.failure = "permission denied while trying to connect to the Docker daemon socket";
    const error = (await new DockerPrepImageProvider(store)
      .ensure({ key: "k", reference: PINNED, platform: "linux/amd64" })
      .catch((e: unknown) => e)) as PrepError;
    expect(error.code).toBe("runtime_error");
    expect(error.detail).toContain("permission denied");
  });

  it("treats an index without content for the platform as missing and never falls back to another platform", async () => {
    store.refs.set(BY_DIGEST, new Set(["linux/amd64"]));
    const provider = new DockerPrepImageProvider(store);
    await expect(provider.ensure({ key: "k", reference: PINNED, platform: "linux/arm64" })).rejects.toMatchObject({
      code: "image_unavailable",
      message: expect.stringContaining("no content for this platform"),
    });
    expect(store.calls.some((args) => args[0] === "pull")).toBe(false);
  });

  it.each([
    ["linux/amd64", "linux/arm64/v8"],
    ["linux/arm64", "linux/amd64"],
  ] as const)(
    "classic image store: an image present only for another platform is a typed platform_mismatch for %s",
    async (requested, actual) => {
      // Docker Desktop's classic store answers a platform inspection of another platform's image with an error.
      store.failure = `Error response from daemon: image with reference ${BY_DIGEST} was found but does not match the specified platform: wanted ${requested}, actual: ${actual}`;
      const error = (await new DockerPrepImageProvider(store)
        .ensure({ key: "k", reference: PINNED, platform: requested, pull: true })
        .catch((e: unknown) => e)) as PrepError;
      expect(error.code).toBe("platform_mismatch");
      expect(error.message).toContain(`is ${actual}, not ${requested}`);
      // Never "fixed" by pulling over the other platform's image.
      expect(store.calls.some((args) => args[0] === "pull")).toBe(false);
    },
  );

  it("containerd image store: an index without the platform's content is image_unavailable", async () => {
    store.failure = `Error response from daemon: image with reference ${BY_DIGEST} was found but does not provide the specified platform (linux/arm64)`;
    await expect(new DockerPrepImageProvider(store).ensure({ key: "k", reference: PINNED, platform: "linux/arm64" })).rejects.toMatchObject(
      {
        code: "image_unavailable",
      },
    );
  });

  it("refuses an arm64 manifest pin for linux/amd64 before asking Docker, and accepts it for linux/arm64", async () => {
    const armPin = `python:3.11-slim-trixie@${ARM64_MANIFEST}`;
    store.refs.set(`python@${ARM64_MANIFEST}`, new Set(["linux/arm64"]));
    const provider = new DockerPrepImageProvider(store);
    await expect(provider.ensure({ key: "k", reference: armPin, platform: "linux/amd64", pull: true })).rejects.toMatchObject({
      code: "platform_mismatch",
    });
    expect(store.calls).toEqual([]);
    await expect(provider.ensure({ key: "k", reference: armPin, platform: "linux/arm64" })).resolves.toMatchObject({
      platform: "linux/arm64",
    });
  });

  it("refuses an index whose platform inspection reports another platform's manifest", async () => {
    const lying: ContainerRuntime = {
      async docker() {
        return result(`${ARM64_MANIFEST}|linux|amd64|["python@${DIGEST}"]\n`);
      },
    };
    await expect(new DockerPrepImageProvider(lying).ensure({ key: "k", reference: PINNED, platform: "linux/amd64" })).rejects.toMatchObject(
      {
        code: "platform_mismatch",
      },
    );
    const honest: ContainerRuntime = {
      async docker() {
        return result(`${AMD64_MANIFEST}|linux|amd64|["python@${DIGEST}"]\n`);
      },
    };
    await expect(
      new DockerPrepImageProvider(honest).ensure({ key: "k", reference: PINNED, platform: "linux/amd64" }),
    ).resolves.toMatchObject({
      imageId: AMD64_MANIFEST,
    });
  });

  it("with an older CLI, compares the image's own platform", async () => {
    store.legacyCli = true;
    store.refs.set(BY_DIGEST, new Set(["linux/amd64"]));
    const provider = new DockerPrepImageProvider(store);
    await expect(provider.ensure({ key: "k", reference: PINNED, platform: "linux/arm64" })).rejects.toMatchObject({
      code: "platform_mismatch",
    });
    await expect(provider.ensure({ key: "k", reference: PINNED, platform: "linux/amd64" })).resolves.toMatchObject({
      platform: "linux/amd64",
    });
  });

  it("pulls by digest for the exact platform, once for concurrent callers", async () => {
    store.pullDelayMs = 30;
    const provider = new DockerPrepImageProvider(store);
    const request = { key: "k", reference: PINNED, platform: "linux/arm64" as const, pull: true };
    const [a, b] = await Promise.all([provider.ensure(request), provider.ensure(request)]);
    expect(a).toEqual(b);
    expect(a.platform).toBe("linux/arm64");
    expect(store.calls.filter((args) => args[0] === "pull")).toEqual([["pull", "--platform", "linux/arm64", BY_DIGEST]]);
  });
});

describe("DependencyPreparer with an injected image provider", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "prep-image-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const platform = buildPlatformSpec({ architecture: "amd64", python: "3.11" });

  function preparerWith(imageProvider: PrepImageProvider, calls: string[][]): DependencyPreparer {
    const runtime: ContainerRuntime = {
      async docker(args) {
        calls.push([...args]);
        return result(args[0] === "logs" ? '{"event":"listening"}\n' : "");
      },
    };
    return new DependencyPreparer({
      cacheDir: join(root, "cache"),
      workRoot: join(root, "work"),
      runtime,
      imageProvider,
      enginePlatform: "linux/amd64",
      freeSpace: async () => ({ freeBytes: 1024 ** 4 }),
      policy: parsePrepPolicy({}),
    });
  }

  it("passes the pinned reference and platform to ImageReadiness-style providers", async () => {
    const requests: unknown[] = [];
    const calls: string[][] = [];
    const provider: PrepImageProvider = {
      async ensure(request) {
        requests.push(request);
        return { imageId: PLATFORM_ID, repoDigests: [`docker.io/library/python@${DIGEST}`], platform: "linux/amd64" };
      },
    };
    // The run itself fails (the fake runtime has no proxy), but the image request is what matters here.
    await preparerWith(provider, calls)
      .resolvePython({ runId: "r", platform, requirements: ["six"] })
      .catch(() => undefined);
    expect(requests).toEqual([
      { key: "prep-python-3.11-linux-amd64", reference: DEFAULT_PREP_IMAGES["3.11"], platform: "linux/amd64", pull: false },
    ]);
    expect(calls.find((args) => args[0] === "network" && args[1] === "create")).toBeDefined();
  });

  it.each([
    [
      "a different digest",
      { imageId: PLATFORM_ID, repoDigests: [`python@sha256:${"9".repeat(64)}`], platform: "linux/amd64" },
      "image_mismatch",
    ],
    ["another platform", { imageId: PLATFORM_ID, repoDigests: [BY_DIGEST], platform: "linux/arm64" }, "platform_mismatch"],
  ])("refuses an image with %s before creating anything", async (_label, image, code) => {
    const calls: string[][] = [];
    const error = (await preparerWith({ ensure: async () => image }, calls)
      .resolvePython({ runId: "r", platform, requirements: ["six"] })
      .catch((e: unknown) => e)) as PrepError;
    expect(error.code).toBe(code);
    expect(calls.some((args) => args[0] === "create" || args[0] === "run" || (args[0] === "network" && args[1] === "create"))).toBe(false);
  });

  it("maps ImageNotReadyError-style codes", async () => {
    const calls: string[][] = [];
    const notReady = (code: string) => ({
      ensure: async () => {
        throw Object.assign(new Error(`not ready: ${code}`), { code });
      },
    });
    await expect(
      preparerWith(notReady("image_missing"), calls).resolvePython({ runId: "r", platform, requirements: ["six"] }),
    ).rejects.toMatchObject({
      code: "image_unavailable",
    });
    await expect(
      preparerWith(notReady("platform_mismatch"), calls).resolvePython({ runId: "r", platform, requirements: ["six"] }),
    ).rejects.toMatchObject({
      code: "platform_mismatch",
    });
  });
});
