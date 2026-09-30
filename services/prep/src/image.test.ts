import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlatformSpec } from "@dejaml/contracts";
import type { ContainerRuntime, RuntimeCommandOptions, RuntimeCommandResult } from "@dejaml/lab-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DependencyPreparer } from "./downloader.js";
import { PrepError } from "./errors.js";
import { DockerPrepImageProvider, imageMatchesPin, parsePinnedReference, type PrepImageProvider } from "./image.js";
import { DEFAULT_PREP_IMAGES, parsePrepPolicy } from "./policy.js";

const DIGEST = "sha256:e41613d42d4891e4930f79523f93f81bbc7632584ec65e36ab055f41a800b41e";
const PINNED = `python:3.11-slim-trixie@${DIGEST}`;
const BY_DIGEST = `python@${DIGEST}`;
const PLATFORM_ID = `sha256:${"1".repeat(64)}`;

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
      const actual = this.legacyCli ? [...present][0] ?? "linux/amd64" : platform;
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
    expect(parsePinnedReference(PINNED)).toEqual({ reference: PINNED, repository: "python", tag: "3.11-slim-trixie", digest: DIGEST, digestReference: BY_DIGEST });
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
    const error = (await new DockerPrepImageProvider(store).ensure({ key: "k", reference: PINNED, platform: "linux/amd64" }).catch((e: unknown) => e)) as PrepError;
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

  it("with an older CLI, compares the image's own platform", async () => {
    store.legacyCli = true;
    store.refs.set(BY_DIGEST, new Set(["linux/amd64"]));
    const provider = new DockerPrepImageProvider(store);
    await expect(provider.ensure({ key: "k", reference: PINNED, platform: "linux/arm64" })).rejects.toMatchObject({ code: "platform_mismatch" });
    await expect(provider.ensure({ key: "k", reference: PINNED, platform: "linux/amd64" })).resolves.toMatchObject({ platform: "linux/amd64" });
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
    await preparerWith(provider, calls).resolvePython({ runId: "r", platform, requirements: ["six"] }).catch(() => undefined);
    expect(requests).toEqual([{ key: "prep-python-3.11-linux-amd64", reference: DEFAULT_PREP_IMAGES["3.11"], platform: "linux/amd64", pull: false }]);
    expect(calls.find((args) => args[0] === "network" && args[1] === "create")).toBeDefined();
  });

  it.each([
    ["a different digest", { imageId: PLATFORM_ID, repoDigests: [`python@sha256:${"9".repeat(64)}`], platform: "linux/amd64" }, "image_mismatch"],
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
    await expect(preparerWith(notReady("image_missing"), calls).resolvePython({ runId: "r", platform, requirements: ["six"] })).rejects.toMatchObject({
      code: "image_unavailable",
    });
    await expect(preparerWith(notReady("platform_mismatch"), calls).resolvePython({ runId: "r", platform, requirements: ["six"] })).rejects.toMatchObject({
      code: "platform_mismatch",
    });
  });
});
