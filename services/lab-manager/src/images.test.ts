import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ImageNotReadyError,
  ImageReadiness,
  loadBaseImageLock,
  pythonBaseImageRequest,
  pythonBaseImageTag,
  unpinnedBaseImages,
  type ImageRequest,
} from "./images.js";
import type { ContainerRuntime, RuntimeCommandOptions, RuntimeCommandResult } from "./runtime.js";

const DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER = `sha256:${"2".repeat(64)}`;
const PINNED = `mirror.example/library/busybox@${DIGEST}`;
const PLATFORM_DIGEST: Record<string, string> = {
  "linux/amd64": `sha256:${"a".repeat(64)}`,
  "linux/arm64": `sha256:${"b".repeat(64)}`,
};
const baseLockPath = fileURLToPath(new URL("../../../lab-images/python-base/bases.lock.json", import.meta.url));

function result(exitCode: number | null, stdout = "", stderr = "", aborted = false): RuntimeCommandResult {
  return {
    exitCode,
    stdout: { text: stdout, bytes: stdout.length, truncated: false },
    stderr: { text: stderr, bytes: stderr.length, truncated: false },
    aborted,
  };
}

type LocalImage = { id: string; platforms: Set<string>; defaultPlatform: string };

/** Answers the Docker CLI calls ImageReadiness makes, with a containerd-style multi-platform store. */
class FakeDocker implements ContainerRuntime {
  readonly calls: string[][] = [];
  readonly images = new Map<string, LocalImage>();
  /** Classic-store behaviour: `image inspect --platform` reports the image's only platform whatever was asked. */
  classicStore = false;
  inspectError: string | null = null;
  pullFailures = 0;
  pullHang = false;
  pullDelayMs = 0;
  pulledPlatforms: string[] = [];
  pullSignals: AbortSignal[] = [];
  pullResult: { id: string; defaultPlatform?: string } = { id: DIGEST };
  buildFails = false;
  builtId = OTHER;

  async docker(args: readonly string[], options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    this.calls.push([...args]);
    const [command] = args;
    const flag = (name: string): string | undefined => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    if (command === "image") {
      if (this.inspectError) return result(1, "", this.inspectError);
      const reference = args.at(-1) ?? "";
      const image = this.images.get(reference);
      if (!image) return result(1, "", `Error response from daemon: No such image: ${reference}`);
      const asked = flag("--platform");
      const platform = asked
        ? this.classicStore
          ? image.defaultPlatform
          : image.platforms.has(asked)
            ? asked
            : ""
        : image.defaultPlatform;
      const [os = "", architecture = ""] = platform ? platform.split("/") : [];
      // The containerd store reports the platform manifest's digest when asked for a platform.
      const id = asked && !this.classicStore ? PLATFORM_DIGEST[asked] : image.id;
      return result(
        0,
        `${JSON.stringify({ Id: id, Os: os, Architecture: architecture, RepoDigests: [`busybox@${image.id}`] })}\n`,
      );
    }
    if (command === "pull") {
      const platform = flag("--platform") ?? "";
      const reference = args.at(-1) ?? "";
      this.pulledPlatforms.push(platform);
      if (options.signal) this.pullSignals.push(options.signal);
      if (this.pullHang) {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return result(null, "", "", true);
      }
      if (this.pullDelayMs) await new Promise((resolve) => setTimeout(resolve, this.pullDelayMs));
      if (this.pullFailures > 0) {
        this.pullFailures -= 1;
        return result(1, "", "toomanyrequests: rate limit exceeded");
      }
      const existing = this.images.get(reference);
      const platforms = new Set(existing?.platforms ?? []);
      platforms.add(platform);
      this.images.set(reference, {
        id: this.pullResult.id,
        platforms,
        defaultPlatform: existing?.defaultPlatform ?? this.pullResult.defaultPlatform ?? platform,
      });
      return result(0, `${reference}\n`);
    }
    if (command === "build") {
      if (this.buildFails) return result(1, "", "ERROR: failed to solve: process did not complete successfully");
      const tag = flag("--tag") ?? "";
      const platform = flag("--platform") ?? "";
      this.images.set(tag, { id: this.builtId, platforms: new Set([platform]), defaultPlatform: platform });
      return result(0);
    }
    return result(1, "", `unexpected docker command ${command}`);
  }

  count(command: string): number {
    return this.calls.filter((call) => call[0] === command).length;
  }
}

let docker: FakeDocker;
let readiness: ImageReadiness;
let context: string;

const request = (overrides: Partial<ImageRequest> = {}): ImageRequest => ({
  key: "probe:busybox",
  reference: PINNED,
  platform: "linux/amd64",
  ...overrides,
});

beforeEach(async () => {
  docker = new FakeDocker();
  readiness = new ImageReadiness({ docker, retries: 2, backoffMs: 1, now: () => new Date("2026-09-30T12:00:00Z") });
  context = await mkdtemp(join(tmpdir(), "dejaml-image-test-"));
});

afterEach(async () => {
  await rm(context, { recursive: true, force: true });
});

describe("ImageReadiness", () => {
  it("uses an image that is already present, by its immutable ID, without pulling", async () => {
    docker.images.set(PINNED, { id: DIGEST, platforms: new Set(["linux/amd64"]), defaultPlatform: "linux/amd64" });
    const image = await readiness.ensure(request({ pull: true, expectedImageId: DIGEST }));

    expect(image).toMatchObject({
      imageId: DIGEST,
      digest: PLATFORM_DIGEST["linux/amd64"],
      python: null,
      platform: "linux/amd64",
      architecture: "amd64",
      os: "linux",
      source: "present",
      repoDigests: [`busybox@${DIGEST}`],
      readyAt: "2026-09-30T12:00:00.000Z",
    });
    expect(docker.count("pull")).toBe(0);
    expect(readiness.status()).toEqual([
      expect.objectContaining({ key: "probe:busybox", platform: "linux/amd64", state: "ready", image }),
    ]);
  });

  it("fails with image_missing when the image is absent and nothing may create it", async () => {
    await expect(readiness.ensure(request())).rejects.toMatchObject({
      name: "ImageNotReadyError",
      code: "image_missing",
    });
    expect(docker.count("pull")).toBe(0);
    expect(readiness.status()[0]).toMatchObject({ state: "failed", error: { code: "image_missing" } });
  });

  it("reports daemon failures as runtime errors, never as a missing image", async () => {
    docker.inspectError = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
    await expect(readiness.ensure(request({ pull: true }))).rejects.toMatchObject({ code: "runtime_error" });
    expect(docker.count("pull")).toBe(0);
  });

  it("pulls a missing pinned image for the requested platform, then re-inspects it", async () => {
    const image = await readiness.ensure(request({ pull: true, platform: "linux/arm64" }));

    expect(image).toMatchObject({ source: "pulled", platform: "linux/arm64", architecture: "arm64", imageId: DIGEST });
    expect(docker.pulledPlatforms).toEqual(["linux/arm64"]);
    expect(docker.calls.find((call) => call[0] === "pull")).toEqual(["pull", "--quiet", "--platform", "linux/arm64", PINNED]);
    expect(image.digest).toBe(PLATFORM_DIGEST["linux/arm64"]);
    expect(docker.calls.map((call) => call[0])).toEqual(["image", "pull", "image", "image"]);
    expect(docker.calls.at(-1)).toContain("--platform");
  });

  it("pulls the missing platform of a multi-platform image already present for another platform", async () => {
    docker.images.set(PINNED, { id: DIGEST, platforms: new Set(["linux/amd64"]), defaultPlatform: "linux/amd64" });
    const image = await readiness.ensure(request({ pull: true, platform: "linux/arm64" }));
    expect(image).toMatchObject({ source: "pulled", architecture: "arm64" });
    expect(docker.pulledPlatforms).toEqual(["linux/arm64"]);
  });

  it("fails as stale when the local image ID differs, and never falls back to it or re-pulls", async () => {
    docker.images.set(PINNED, { id: OTHER, platforms: new Set(["linux/amd64"]), defaultPlatform: "linux/amd64" });
    await expect(readiness.ensure(request({ pull: true, expectedImageId: DIGEST }))).rejects.toMatchObject({
      code: "image_stale",
    });
    expect(docker.count("pull")).toBe(0);
    expect(readiness.status()[0]).toMatchObject({ state: "failed", error: { code: "image_stale" } });
    expect(readiness.status()[0]?.image).toBeUndefined();
  });

  it("fails as stale when a pull produces a different image than expected", async () => {
    docker.pullResult = { id: OTHER };
    await expect(readiness.ensure(request({ pull: true, expectedImageId: DIGEST }))).rejects.toMatchObject({
      code: "image_stale",
    });
    expect(docker.count("pull")).toBe(1);
  });

  it("shares one preparation among concurrent requests for the same key and platform", async () => {
    docker.pullDelayMs = 30;
    const results = await Promise.all(Array.from({ length: 6 }, () => readiness.ensure(request({ pull: true }))));

    expect(docker.count("pull")).toBe(1);
    expect(new Set(results.map((image) => image.imageId))).toEqual(new Set([DIGEST]));
    expect(results.every((image) => image === results[0])).toBe(true);
  });

  it("reports preparing while a preparation is in flight", async () => {
    docker.pullDelayMs = 30;
    const pending = readiness.ensure(request({ pull: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(readiness.status()[0]).toMatchObject({ state: "preparing" });
    await pending;
    expect(readiness.status()[0]).toMatchObject({ state: "ready" });
  });

  it("prepares different platforms of the same key separately", async () => {
    await Promise.all([
      readiness.ensure(request({ pull: true, platform: "linux/amd64" })),
      readiness.ensure(request({ pull: true, platform: "linux/arm64" })),
    ]);
    expect(docker.pulledPlatforms.sort()).toEqual(["linux/amd64", "linux/arm64"]);
    expect(readiness.status().map((entry) => `${entry.platform} ${entry.state}`)).toEqual([
      "linux/amd64 ready",
      "linux/arm64 ready",
    ]);
  });

  it("refuses a second, different request under a key that is already preparing", async () => {
    docker.pullDelayMs = 30;
    const first = readiness.ensure(request({ pull: true }));
    await expect(
      readiness.ensure(request({ pull: true, reference: `mirror.example/library/busybox@${OTHER}` })),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await first;
  });

  it("retries a failed pull with backoff and succeeds", async () => {
    docker.pullFailures = 2;
    const image = await readiness.ensure(request({ pull: true }));
    expect(image.source).toBe("pulled");
    expect(docker.count("pull")).toBe(3);
  });

  it("gives up after a bounded number of pull attempts", async () => {
    docker.pullFailures = 10;
    const failure = await readiness.ensure(request({ pull: true })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ImageNotReadyError);
    expect(failure).toMatchObject({ code: "pull_failed" });
    expect((failure as ImageNotReadyError).detail).toContain("rate limit");
    expect(docker.count("pull")).toBe(3);
  });

  it("does not retry a platform mismatch", async () => {
    docker.classicStore = true;
    docker.images.set(PINNED, { id: DIGEST, platforms: new Set(["linux/arm64"]), defaultPlatform: "linux/arm64" });
    await expect(readiness.ensure(request({ pull: false }))).rejects.toMatchObject({ code: "platform_mismatch" });
    expect(docker.count("pull")).toBe(0);
  });

  it("refuses an image present only for another platform when it may not pull", async () => {
    docker.images.set(PINNED, { id: DIGEST, platforms: new Set(["linux/arm64"]), defaultPlatform: "linux/arm64" });
    await expect(readiness.ensure(request())).rejects.toMatchObject({ code: "platform_mismatch" });
  });

  it("fails with platform_mismatch when a pull still yields another platform", async () => {
    docker.classicStore = true;
    docker.pullResult = { id: DIGEST, defaultPlatform: "linux/arm64" };
    await expect(readiness.ensure(request({ pull: true }))).rejects.toMatchObject({ code: "platform_mismatch" });
    expect(docker.count("pull")).toBe(1);
  });

  it("builds a missing image for the requested platform from a pinned base", async () => {
    await writeFile(join(context, "Dockerfile"), "ARG BASE\nFROM ${BASE}\nRUN true\n");
    const image = await readiness.ensure(
      request({
        key: "lab-base:python-3.11",
        reference: "dejaml/python-base:test",
        platform: "linux/arm64",
        build: { contextDir: context, dockerfile: "Dockerfile", tag: "dejaml/python-base:test", buildArgs: { BASE: PINNED } },
      }),
    );
    expect(image).toMatchObject({ source: "built", imageId: OTHER, architecture: "arm64" });
    const build = docker.calls.find((call) => call[0] === "build") ?? [];
    expect(build.join(" ")).toContain("--platform linux/arm64");
    expect(build.join(" ")).toContain(`--build-arg BASE=${PINNED}`);
    expect(build.at(-1)).toBe(context);
  });

  it("fails with build_failed and does not retry a failed build", async () => {
    await writeFile(join(context, "Dockerfile"), `FROM ${PINNED}\n`);
    docker.buildFails = true;
    const build = { contextDir: context, dockerfile: "Dockerfile", tag: "dejaml/python-base:test" };
    const failure = await readiness
      .ensure(request({ reference: "dejaml/python-base:test", build }))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "build_failed" });
    expect((failure as ImageNotReadyError).detail).toContain("failed to solve");
    expect(docker.count("build")).toBe(1);
  });

  it("refuses to build from a base image that is not pinned by digest", async () => {
    await writeFile(join(context, "Dockerfile"), "FROM python:3.11-slim-trixie\n");
    const build = { contextDir: context, dockerfile: "Dockerfile", tag: "dejaml/python-base:test" };
    await expect(readiness.ensure(request({ reference: "dejaml/python-base:test", build }))).rejects.toMatchObject({
      code: "build_failed",
    });
    expect(docker.count("build")).toBe(0);
  });

  it("cancels the preparation and kills the Docker child when the only caller aborts", async () => {
    docker.pullHang = true;
    const controller = new AbortController();
    const pending = readiness.ensure(request({ pull: true }), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(docker.pullSignals[0]?.aborted).toBe(true);
    expect(readiness.status()[0]).toMatchObject({ state: "failed", error: { code: "cancelled" } });
  });

  it("keeps a shared preparation running while another caller still waits", async () => {
    docker.pullDelayMs = 40;
    const controller = new AbortController();
    const leaving = readiness.ensure(request({ pull: true }), controller.signal);
    const staying = readiness.ensure(request({ pull: true }));
    controller.abort();
    await expect(leaving).rejects.toMatchObject({ code: "cancelled" });
    await expect(staying).resolves.toMatchObject({ source: "pulled" });
    expect(docker.pullSignals[0]?.aborted).toBe(false);
  });

  it("rejects immediately when the caller's signal is already aborted", async () => {
    await expect(readiness.ensure(request({ pull: true }), AbortSignal.abort())).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(docker.calls).toEqual([]);
  });

  it("times out a pull that does not finish and kills its Docker child", async () => {
    docker.pullHang = true;
    const quick = new ImageReadiness({ docker, pullTimeoutMs: 20, retries: 2, backoffMs: 1 });
    await expect(quick.ensure(request({ pull: true }))).rejects.toMatchObject({ code: "timeout" });
    expect(docker.count("pull")).toBe(1);
    expect(docker.pullSignals[0]?.aborted).toBe(true);
  });

  it("lets a lab wait until an in-flight preparation settles", async () => {
    docker.pullDelayMs = 30;
    const pending = readiness.ensure(request({ pull: true }));
    let settled = false;
    const waiting = readiness.whenSettled(PINNED, "linux/amd64").then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    await pending;
    await waiting;
    expect(settled).toBe(true);
    await readiness.whenSettled("nothing:pending", "linux/amd64");
  });

  it("validates requests before touching Docker", async () => {
    for (const bad of [
      request({ pull: true, reference: "busybox:latest" }),
      request({ reference: "--privileged" }),
      request({ platform: "linux/s390x" as never }),
      request({ key: "" }),
      request({ expectedImageId: "abc" }),
      request({ reference: "dejaml/x:1", build: { contextDir: "relative", dockerfile: "Dockerfile", tag: "dejaml/x:1" } }),
      request({ reference: "dejaml/x:1", build: { contextDir: "/tmp", dockerfile: "Dockerfile", tag: "dejaml/y:1" } }),
    ]) {
      await expect(readiness.ensure(bad)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(docker.calls).toEqual([]);
  });
});

describe("unpinnedBaseImages", () => {
  it("accepts digest-pinned bases, ARG substitution, earlier stages, and scratch", () => {
    expect(unpinnedBaseImages(`FROM ${PINNED}\n`)).toEqual([]);
    expect(unpinnedBaseImages(`ARG BASE=${PINNED}\nFROM \${BASE} AS build\nFROM build\nFROM scratch\n`)).toEqual([]);
    expect(unpinnedBaseImages("ARG BASE\nFROM $BASE\n", { BASE: PINNED })).toEqual([]);
    expect(unpinnedBaseImages(`FROM --platform=linux/amd64 ${PINNED}\n`)).toEqual([]);
  });

  it("reports tags, empty arguments, and an unpinned syntax frontend", () => {
    expect(unpinnedBaseImages("FROM python:3.11-slim\n")).toEqual(["python:3.11-slim"]);
    expect(unpinnedBaseImages("ARG BASE\nFROM ${BASE}\n")).toEqual(["(empty)"]);
    expect(unpinnedBaseImages(`# syntax=docker/dockerfile:1.7\nFROM ${PINNED}\n`)).toEqual(["docker/dockerfile:1.7"]);
  });
});

describe("lab base images", () => {
  it("locks every supported Python version for both platforms by digest", async () => {
    const lock = await loadBaseImageLock(baseLockPath);
    expect(Object.keys(lock.bases).sort()).toEqual(["3.10", "3.11", "3.12", "3.13"]);
    for (const [version, base] of Object.entries(lock.bases)) {
      expect(base.tag).toBe(`${version}-slim-trixie`);
      expect(base.pythonVersion.startsWith(`${version}.`)).toBe(true);
      expect(base.platforms["linux/amd64"]).not.toBe(base.platforms["linux/arm64"]);
    }
    // The curated lab image is built from the same 3.13 base.
    expect(lock.bases["3.13"]?.index).toBe("sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b");
  });

  it("builds the study's lab image from the pinned base for its Python version and platform", async () => {
    const lock = await loadBaseImageLock(baseLockPath);
    const imageRequest = pythonBaseImageRequest({ lock, python: "3.12", platform: "linux/arm64", contextDir: "/repo/lab-images/python-base" });
    expect(imageRequest).toEqual({
      key: "lab-base:python-3.12",
      reference: "dejaml/python-base:0.1.0-py3.12-linux-arm64",
      platform: "linux/arm64",
      python: "3.12",
      build: {
        contextDir: "/repo/lab-images/python-base",
        dockerfile: "Dockerfile",
        tag: "dejaml/python-base:0.1.0-py3.12-linux-arm64",
        buildArgs: {
          PYTHON_BASE: `docker.io/library/python:3.12-slim-trixie@${lock.bases["3.12"]?.index}`,
          PYTHON_VERSION: "3.12",
        },
      },
    });
    expect(pythonBaseImageTag(lock, "3.10", "linux/amd64")).toBe("dejaml/python-base:0.1.0-py3.10-linux-amd64");
    const mirrored = pythonBaseImageRequest({
      lock,
      python: "3.11",
      platform: "linux/amd64",
      contextDir: "/x",
      baseRepository: "mirror.gcr.io/library/python",
    });
    expect(mirrored.build?.buildArgs?.PYTHON_BASE).toBe(`mirror.gcr.io/library/python:3.11-slim-trixie@${lock.bases["3.11"]?.index}`);
  });

  it("keeps the base Dockerfile pinned once its build arguments are applied", async () => {
    const { readFile } = await import("node:fs/promises");
    const dockerfile = await readFile(join(baseLockPath, "..", "Dockerfile"), "utf8");
    const lock = await loadBaseImageLock(baseLockPath);
    const imageRequest = pythonBaseImageRequest({ lock, python: "3.11", platform: "linux/amd64", contextDir: "/x" });
    expect(unpinnedBaseImages(dockerfile, imageRequest.build?.buildArgs)).toEqual([]);
    expect(unpinnedBaseImages(dockerfile)).toEqual(["(empty)"]);
  });
});
