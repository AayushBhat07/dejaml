import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { ContainerPlatformSchema, PythonVersionSchema, type ContainerPlatform, type PythonVersion } from "@dejaml/contracts";
import { z } from "zod";

import { type ContainerRuntime, type RuntimeCommandResult, DockerCliRuntime } from "./runtime.js";

/**
 * Deterministic image readiness. An image is identified by its immutable
 * local image ID (and registry digests), never by a mutable tag alone. It is
 * inspected first; only when it is absent is it pulled (by digest, for the
 * requested platform) or built (from a digest-pinned base, for the requested
 * platform). The result is always re-inspected and must match the requested
 * platform and, when given, the expected image ID. Nothing ever falls back to
 * another image.
 */

export type ImageBuildSpec = {
  /** Absolute build context directory. */
  contextDir: string;
  /** Dockerfile path, absolute or relative to the context directory. */
  dockerfile: string;
  buildArgs?: Record<string, string>;
  /** Local tag the build produces; it must equal the request's reference. */
  tag: string;
};

export type ImageRequest = {
  /** Stable name for status and deduplication, such as `lab:python-3.11`. */
  key: string;
  /** Pinned reference (`name@sha256:…`) or, for a local build, the local tag. */
  reference: string;
  platform: ContainerPlatform;
  /** When set, the local image ID must equal this, or preparation fails as stale. */
  expectedImageId?: string;
  build?: ImageBuildSpec;
  /** Pull the pinned reference when it is absent. Only digest-pinned references may be pulled. */
  pull?: boolean;
  /** The CPython version the image provides, when known (lab base images); carried into ReadyImage. */
  python?: PythonVersion;
};

export type ReadyImage = {
  key: string;
  reference: string;
  /** The ID `docker image inspect <reference>` reports; what a LabSpec's `expectedImageId` must be. */
  imageId: string;
  /**
   * Content digest of the platform-specific image: the platform manifest
   * digest when the engine reports one (containerd image store), else the
   * registry digest, else null for a local build under the classic store.
   */
  digest: string | null;
  repoDigests: string[];
  platform: ContainerPlatform;
  architecture: string;
  os: string;
  python: PythonVersion | null;
  source: "present" | "pulled" | "built";
  readyAt: string;
};

export type ImageReadinessState = "absent" | "preparing" | "ready" | "failed";

export type ImageErrorCode =
  | "image_missing"
  | "image_stale"
  | "pull_failed"
  | "build_failed"
  | "platform_mismatch"
  | "cancelled"
  | "timeout"
  | "invalid_request"
  | "runtime_error";

export type ImageStatus = {
  key: string;
  reference: string;
  platform: ContainerPlatform;
  state: ImageReadinessState;
  image?: ReadyImage;
  error?: { code: ImageErrorCode; message: string };
  updatedAt: string;
};

export class ImageNotReadyError extends Error {
  readonly code: ImageErrorCode;
  readonly key: string;
  readonly platform: ContainerPlatform | null;
  readonly detail: string | undefined;

  constructor(code: ImageErrorCode, message: string, context: { key?: string; platform?: ContainerPlatform | null; detail?: string } = {}) {
    super(message);
    this.name = "ImageNotReadyError";
    this.code = code;
    this.key = context.key ?? "";
    this.platform = context.platform ?? null;
    this.detail = context.detail;
  }
}

export type ImageReadinessOptions = {
  /** The Docker CLI runner; the Lab Manager's runtime by default. */
  docker?: ContainerRuntime;
  now?: () => Date;
  inspectTimeoutMs?: number;
  pullTimeoutMs?: number;
  buildTimeoutMs?: number;
  /** Extra pull attempts after the first failure (bounded). Mismatches are never retried. */
  retries?: number;
  /** First retry delay; each later retry doubles it. */
  backoffMs?: number;
};

const REFERENCE_PATTERN = /^[a-z0-9][a-z0-9._/:-]{0,254}(?:@sha256:[a-f0-9]{64})?$/u;
const PINNED_PATTERN = /@sha256:[a-f0-9]{64}$/u;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const BUILD_ARG_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const MAX_RETRIES = 5;

type Flight = {
  request: ImageRequest;
  promise: Promise<ReadyImage>;
  controller: AbortController;
  waiters: number;
};

type Inspection =
  | { kind: "missing" }
  /** The reference exists locally, but not for the requested platform. */
  | { kind: "other_platform"; imageId: string; platform: string | null }
  | { kind: "found"; imageId: string; digest: string | null; repoDigests: string[]; os: string; architecture: string };

type StepResult = { result: RuntimeCommandResult; timedOut: boolean };

export class ImageReadiness {
  readonly #docker: ContainerRuntime;
  readonly #now: () => Date;
  readonly #inspectTimeoutMs: number;
  readonly #pullTimeoutMs: number;
  readonly #buildTimeoutMs: number;
  readonly #retries: number;
  readonly #backoffMs: number;
  readonly #flights = new Map<string, Flight>();
  readonly #status = new Map<string, ImageStatus>();

  constructor(options: ImageReadinessOptions = {}) {
    this.#docker = options.docker ?? new DockerCliRuntime();
    this.#now = options.now ?? (() => new Date());
    this.#inspectTimeoutMs = options.inspectTimeoutMs ?? 60_000;
    this.#pullTimeoutMs = options.pullTimeoutMs ?? 10 * 60_000;
    this.#buildTimeoutMs = options.buildTimeoutMs ?? 30 * 60_000;
    this.#retries = Math.max(0, Math.min(MAX_RETRIES, Math.floor(options.retries ?? 2)));
    this.#backoffMs = Math.max(0, options.backoffMs ?? 1_000);
  }

  /**
   * Makes the image ready, or fails with an ImageNotReadyError. Concurrent
   * calls for the same key and platform share one preparation. A caller's
   * signal abandons only its own wait; the shared preparation (and its Docker
   * child process) is cancelled when every waiting caller has aborted.
   */
  ensure(input: ImageRequest, signal?: AbortSignal): Promise<ReadyImage> {
    let request: ImageRequest;
    try {
      request = parseRequest(input);
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal?.aborted) {
      return Promise.reject(this.#error("cancelled", "image preparation was cancelled", request));
    }
    const id = slot(request.key, request.platform);
    let flight = this.#flights.get(id);
    // A preparation every earlier caller abandoned is finishing its cancellation; start afresh.
    if (flight?.controller.signal.aborted) flight = undefined;
    if (flight && !sameRequest(flight.request, request)) {
      return Promise.reject(this.#error("invalid_request", `image key ${request.key} is already preparing a different image`, request));
    }
    if (!flight) flight = this.#launch(id, request);
    return this.#wait(flight, request, signal);
  }

  /** Readiness of every image this instance has been asked for, for internal health diagnostics. */
  status(): ImageStatus[] {
    return [...this.#status.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.key.localeCompare(right.key) || left.platform.localeCompare(right.platform));
  }

  /** Resolves once no preparation of this reference for this platform is in flight. */
  async whenSettled(reference: string, platform: ContainerPlatform): Promise<void> {
    const pending = [...this.#flights.values()].filter(
      (flight) =>
        flight.request.platform === platform && (flight.request.reference === reference || flight.request.build?.tag === reference),
    );
    await Promise.all(pending.map((flight) => flight.promise.catch(() => undefined)));
  }

  #launch(id: string, request: ImageRequest): Flight {
    const controller = new AbortController();
    this.#setStatus(request, { state: "preparing" });
    const promise = this.#prepare(request, controller.signal).then(
      (image) => {
        this.#setStatus(request, { state: "ready", image });
        return image;
      },
      (error: unknown) => {
        const failure =
          error instanceof ImageNotReadyError
            ? error
            : this.#error("runtime_error", `image preparation failed: ${message(error)}`, request);
        this.#setStatus(request, { state: "failed", error: { code: failure.code, message: failure.message } });
        throw failure;
      },
    );
    const flight: Flight = { request, promise, controller, waiters: 0 };
    this.#flights.set(id, flight);
    void promise
      .catch(() => undefined)
      .finally(() => {
        if (this.#flights.get(id) === flight) this.#flights.delete(id);
      });
    return flight;
  }

  #wait(flight: Flight, request: ImageRequest, signal: AbortSignal | undefined): Promise<ReadyImage> {
    flight.waiters += 1;
    if (!signal) {
      return flight.promise.finally(() => {
        flight.waiters -= 1;
      });
    }
    return new Promise<ReadyImage>((resolvePromise, rejectPromise) => {
      let done = false;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        flight.waiters -= 1;
        // The last waiter leaving cancels the shared preparation and kills its Docker child.
        if (flight.waiters === 0) flight.controller.abort();
        rejectPromise(this.#error("cancelled", "image preparation was cancelled", request));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (image) => {
          if (done) return;
          done = true;
          flight.waiters -= 1;
          signal.removeEventListener("abort", onAbort);
          resolvePromise(image);
        },
        (error: unknown) => {
          if (done) return;
          done = true;
          flight.waiters -= 1;
          signal.removeEventListener("abort", onAbort);
          rejectPromise(error);
        },
      );
    });
  }

  async #prepare(request: ImageRequest, signal: AbortSignal): Promise<ReadyImage> {
    const present = await this.#inspect(request, signal);
    if (present.kind === "found") return this.#accept(request, present, "present");
    if (present.kind === "other_platform" && !request.build && !request.pull) {
      throw this.#error(
        "platform_mismatch",
        `image ${request.reference} is present only for ${present.platform ?? "another platform"}, not ${request.platform}`,
        request,
      );
    }
    if (request.build) {
      await this.#build(request, request.build, signal);
      const built = await this.#inspect(request, signal);
      if (built.kind === "missing") {
        throw this.#error("build_failed", `the build finished but ${request.reference} is not present`, request);
      }
      if (built.kind === "other_platform") throw this.#platformMismatch(request, built.platform);
      return this.#accept(request, built, "built");
    }
    if (request.pull) {
      await this.#pull(request, signal);
      const pulled = await this.#inspect(request, signal);
      if (pulled.kind === "missing") {
        throw this.#error("pull_failed", `the pull finished but ${request.reference} is not present`, request);
      }
      if (pulled.kind === "other_platform") throw this.#platformMismatch(request, pulled.platform);
      return this.#accept(request, pulled, "pulled");
    }
    throw this.#error(
      "image_missing",
      `image ${request.reference} is not present locally for ${request.platform}, and neither a pull nor a build is allowed`,
      request,
    );
  }

  #accept(request: ImageRequest, found: Extract<Inspection, { kind: "found" }>, source: ReadyImage["source"]): ReadyImage {
    const platform = `${found.os}/${found.architecture}`;
    if (platform !== request.platform) throw this.#platformMismatch(request, platform);
    if (request.expectedImageId && found.imageId !== request.expectedImageId) {
      throw this.#error("image_stale", `image ${request.reference} is ${found.imageId}, expected ${request.expectedImageId}`, request);
    }
    return {
      key: request.key,
      reference: request.reference,
      imageId: found.imageId,
      digest: found.digest,
      repoDigests: found.repoDigests,
      platform: request.platform,
      architecture: found.architecture,
      os: found.os,
      python: request.python ?? null,
      source,
      readyAt: this.#now().toISOString(),
    };
  }

  /**
   * Inspects the reference. The plain inspection gives the ID a lab checks;
   * a multi-platform local image reports the daemon's default platform, so a
   * platform-specific inspection decides whether the requested platform's
   * content is present.
   */
  async #inspect(request: ImageRequest, signal: AbortSignal): Promise<Inspection> {
    const plain = await this.#inspectOnce(request, null, signal);
    if (!plain) return { kind: "missing" };
    const plainPlatform = plain.Os && plain.Architecture ? `${plain.Os}/${plain.Architecture}` : null;
    const specific = await this.#inspectOnce(request, request.platform, signal).catch((error: unknown) => {
      if (error instanceof ImageNotReadyError && (error.code === "cancelled" || error.code === "timeout")) throw error;
      return null;
    });
    if (specific?.Os && specific.Architecture) return found(plain, specific);
    // An engine that cannot inspect by platform still answers for a single-platform image.
    if (plainPlatform === request.platform) return found(plain, plain);
    return { kind: "other_platform", imageId: String(plain.Id), platform: plainPlatform };
  }

  async #inspectOnce(request: ImageRequest, platform: ContainerPlatform | null, signal: AbortSignal): Promise<DockerImageInfo | null> {
    const { result } = await this.#step(
      request,
      ["image", "inspect", ...(platform ? ["--platform", platform] : []), "--format", "{{json .}}", request.reference],
      this.#inspectTimeoutMs,
      signal,
      1024 * 1024,
    );
    if (result.exitCode !== 0) {
      // Only "no such image" means absent. Anything else (an unreachable daemon, a
      // permission error) is reported as it is, never as a missing image.
      if (/no such image|not found|does not match the specified platform/iu.test(result.stderr.text)) return null;
      throw this.#error("runtime_error", `image inspect failed for ${request.reference}`, request, result.stderr.text);
    }
    try {
      const raw = JSON.parse(result.stdout.text.trim().split("\n")[0] ?? "") as unknown;
      const info = (Array.isArray(raw) ? raw[0] : raw) as DockerImageInfo | undefined;
      if (!info || typeof info.Id !== "string" || !IMAGE_ID_PATTERN.test(info.Id)) throw new Error("no image ID");
      return info;
    } catch {
      throw this.#error("runtime_error", `image inspect returned unreadable output for ${request.reference}`, request);
    }
  }

  async #pull(request: ImageRequest, signal: AbortSignal): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      if (attempt > 0) await this.#sleep(this.#backoffMs * 2 ** (attempt - 1), request, signal);
      const { result } = await this.#step(
        request,
        ["pull", "--quiet", "--platform", request.platform, request.reference],
        this.#pullTimeoutMs,
        signal,
      );
      if (result.exitCode === 0) return;
      lastError = result.stderr.text;
    }
    throw this.#error(
      "pull_failed",
      `could not pull ${request.reference} for ${request.platform} after ${this.#retries + 1} attempt(s)`,
      request,
      lastError,
    );
  }

  async #build(request: ImageRequest, build: ImageBuildSpec, signal: AbortSignal): Promise<void> {
    const dockerfile = isAbsolute(build.dockerfile) ? build.dockerfile : join(build.contextDir, build.dockerfile);
    let text: string;
    try {
      text = await readFile(dockerfile, "utf8");
    } catch (error) {
      throw this.#error("build_failed", `cannot read Dockerfile ${dockerfile}: ${message(error)}`, request);
    }
    const unpinned = unpinnedBaseImages(text, build.buildArgs ?? {});
    if (unpinned.length > 0) {
      throw this.#error("build_failed", `every base image must be pinned by digest; unpinned: ${unpinned.join(", ")}`, request);
    }
    const { result } = await this.#step(
      request,
      [
        "build",
        "--platform",
        request.platform,
        "--provenance=false",
        "--file",
        dockerfile,
        "--tag",
        build.tag,
        "--label",
        `dejaml.image-key=${request.key}`,
        ...Object.entries(build.buildArgs ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
        build.contextDir,
      ],
      this.#buildTimeoutMs,
      signal,
    );
    if (result.exitCode !== 0) {
      throw this.#error("build_failed", `building ${build.tag} for ${request.platform} failed`, request, result.stderr.text);
    }
  }

  /** Runs one Docker CLI step under its own time limit and the preparation's cancellation. */
  async #step(
    request: ImageRequest,
    args: string[],
    timeoutMs: number,
    signal: AbortSignal,
    maxOutputBytes = 64 * 1024,
  ): Promise<StepResult> {
    if (signal.aborted) throw this.#error("cancelled", "image preparation was cancelled", request);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let result: RuntimeCommandResult;
    try {
      result = await this.#docker.docker(args, { signal: controller.signal, maxOutputBytes });
    } catch (error) {
      throw this.#error("runtime_error", `docker ${args[0] ?? ""} could not run: ${message(error)}`, request);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    if (timedOut) {
      throw this.#error("timeout", `docker ${args[0] ?? ""} did not finish within ${timeoutMs} ms`, request);
    }
    if (signal.aborted || result.aborted) throw this.#error("cancelled", "image preparation was cancelled", request);
    return { result, timedOut };
  }

  #sleep(ms: number, request: ImageRequest, signal: AbortSignal): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(this.#error("cancelled", "image preparation was cancelled", request));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        rejectPromise(this.#error("cancelled", "image preparation was cancelled", request));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #setStatus(request: ImageRequest, update: Pick<ImageStatus, "state"> & Partial<ImageStatus>): void {
    const id = slot(request.key, request.platform);
    const previous = this.#status.get(id);
    const next: ImageStatus = {
      key: request.key,
      reference: request.reference,
      platform: request.platform,
      state: update.state,
      updatedAt: this.#now().toISOString(),
    };
    // A failed re-check keeps no stale "ready" image; a new preparation keeps the last good one visible.
    const image = update.image ?? (update.state === "preparing" ? previous?.image : undefined);
    if (image) next.image = image;
    if (update.error) next.error = update.error;
    this.#status.set(id, next);
  }

  #platformMismatch(request: ImageRequest, actual: string | null): ImageNotReadyError {
    return this.#error(
      "platform_mismatch",
      `image ${request.reference} is built for ${actual ?? "an unknown platform"}, not ${request.platform}`,
      request,
    );
  }

  #error(code: ImageErrorCode, text: string, request: ImageRequest, detail?: string): ImageNotReadyError {
    return new ImageNotReadyError(code, text, {
      key: request.key,
      platform: request.platform,
      ...(detail ? { detail: detail.trim().slice(-2_000) } : {}),
    });
  }
}

type DockerImageInfo = {
  Id?: unknown;
  Os?: string;
  Architecture?: string;
  RepoDigests?: unknown;
};

function found(plain: DockerImageInfo, specific: DockerImageInfo): Inspection {
  const repoDigests = Array.isArray(plain.RepoDigests) ? plain.RepoDigests.filter((item): item is string => typeof item === "string") : [];
  // With the containerd image store, a platform inspection reports the platform manifest's digest.
  const platformDigest =
    typeof specific.Id === "string" && specific.Id !== plain.Id && IMAGE_ID_PATTERN.test(specific.Id) ? specific.Id : null;
  const repoDigest = repoDigests[0]?.split("@")[1];
  return {
    kind: "found",
    imageId: String(plain.Id),
    digest: platformDigest ?? (repoDigest && IMAGE_ID_PATTERN.test(repoDigest) ? repoDigest : null),
    repoDigests,
    os: specific.Os ?? "",
    architecture: specific.Architecture ?? "",
  };
}

function slot(key: string, platform: ContainerPlatform): string {
  return `${key}\u0000${platform}`;
}

function sameRequest(left: ImageRequest, right: ImageRequest): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(request: ImageRequest): unknown {
  return {
    reference: request.reference,
    expectedImageId: request.expectedImageId ?? null,
    pull: request.pull ?? false,
    python: request.python ?? null,
    build: request.build
      ? {
          contextDir: request.build.contextDir,
          dockerfile: request.build.dockerfile,
          tag: request.build.tag,
          buildArgs: Object.entries(request.build.buildArgs ?? {}).sort(([left], [right]) => left.localeCompare(right)),
        }
      : null,
  };
}

function parseRequest(input: ImageRequest): ImageRequest {
  const invalid = (text: string): ImageNotReadyError =>
    new ImageNotReadyError("invalid_request", text, { key: typeof input?.key === "string" ? input.key : "" });
  if (!input || typeof input !== "object") throw invalid("an image request is required");
  if (typeof input.key !== "string" || !KEY_PATTERN.test(input.key)) throw invalid("image key is invalid");
  const platform = ContainerPlatformSchema.safeParse(input.platform);
  if (!platform.success) throw invalid(`platform must be one of ${ContainerPlatformSchema.options.join(", ")}`);
  if (typeof input.reference !== "string" || !REFERENCE_PATTERN.test(input.reference)) {
    throw invalid("image reference is invalid");
  }
  if (input.expectedImageId !== undefined && !IMAGE_ID_PATTERN.test(input.expectedImageId)) {
    throw invalid("expectedImageId must be sha256:<64 hex>");
  }
  if (input.pull && !PINNED_PATTERN.test(input.reference)) {
    throw invalid("only a digest-pinned reference (name@sha256:…) may be pulled");
  }
  const request: ImageRequest = { key: input.key, reference: input.reference, platform: platform.data };
  if (input.expectedImageId !== undefined) request.expectedImageId = input.expectedImageId;
  if (input.pull !== undefined) request.pull = input.pull;
  if (input.python !== undefined) {
    const python = PythonVersionSchema.safeParse(input.python);
    if (!python.success) throw invalid(`python must be one of ${PythonVersionSchema.options.join(", ")}`);
    request.python = python.data;
  }
  if (input.build) {
    const build = input.build;
    if (typeof build.contextDir !== "string" || !isAbsolute(build.contextDir)) {
      throw invalid("build context directory must be absolute");
    }
    if (typeof build.dockerfile !== "string" || build.dockerfile === "" || build.dockerfile.startsWith("-")) {
      throw invalid("build Dockerfile is invalid");
    }
    if (build.tag !== input.reference) throw invalid("the build tag must equal the image reference");
    for (const [key, value] of Object.entries(build.buildArgs ?? {})) {
      if (!BUILD_ARG_PATTERN.test(key) || typeof value !== "string" || value.includes("\0") || value.includes("\n")) {
        throw invalid(`build argument ${key} is invalid`);
      }
    }
    request.build = {
      contextDir: resolve(build.contextDir),
      dockerfile: build.dockerfile,
      tag: build.tag,
      ...(build.buildArgs ? { buildArgs: { ...build.buildArgs } } : {}),
    };
  }
  return request;
}

/**
 * Base images of a Dockerfile that are not pinned by digest, after resolving
 * `ARG` defaults and build arguments. Earlier stages and `scratch` are fine;
 * a `# syntax=` frontend must be pinned too.
 */
export function unpinnedBaseImages(dockerfile: string, buildArgs: Record<string, string> = {}): string[] {
  const args = new Map<string, string>();
  const stages = new Set<string>();
  const unpinned: string[] = [];
  const lines = dockerfile.replace(/\\\r?\n/gu, " ").split(/\r?\n/u);
  const syntax = /^#\s*syntax\s*=\s*(\S+)/iu.exec(lines.find((line) => /^#\s*syntax\s*=/iu.test(line)) ?? "");
  if (syntax?.[1] && !PINNED_PATTERN.test(syntax[1])) unpinned.push(syntax[1]);
  const substitute = (value: string): string =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_, braced: string, bare: string) => {
      const name = braced ?? bare;
      return buildArgs[name] ?? args.get(name) ?? "";
    });
  for (const raw of lines) {
    const line = raw.trim();
    const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(\S*))?/iu.exec(line);
    if (arg?.[1]) {
      const value = arg[2]?.replace(/^"(.*)"$/u, "$1");
      if (value !== undefined) args.set(arg[1], value);
      continue;
    }
    const from = /^FROM\s+(.+)$/iu.exec(line);
    if (!from?.[1]) continue;
    const tokens = from[1].split(/\s+/u).filter((token) => !token.startsWith("--"));
    const image = substitute(tokens[0] ?? "");
    if (/^as$/iu.test(tokens[1] ?? "") && tokens[2]) stages.add(tokens[2].toLowerCase());
    if (image === "scratch" || stages.has(image.toLowerCase())) continue;
    if (!PINNED_PATTERN.test(image)) unpinned.push(image || "(empty)");
  }
  return unpinned;
}

// ---------------------------------------------------------------------------
// Lab base images: the official CPython slim image for one Python version on
// one platform, pinned in lab-images/python-base/bases.lock.json.

const DigestSchema = z.string().regex(IMAGE_ID_PATTERN);

export const BaseImageLockSchema = z.object({
  schemaVersion: z.literal(1),
  /** Repository of the lab images built from the bases, such as `dejaml/python-base`. */
  image: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/u),
  version: z.string().regex(/^[0-9A-Za-z._-]{1,32}$/u),
  /** Registry repository of the bases, such as `docker.io/library/python`. */
  baseRepository: z.string().regex(/^[a-z0-9][a-z0-9._/:-]{0,254}$/u),
  bases: z.record(
    PythonVersionSchema,
    z.object({
      tag: z.string().regex(/^[0-9A-Za-z._-]{1,128}$/u),
      pythonVersion: z.string().regex(/^3\.\d+\.\d+$/u),
      /** The multi-platform index (manifest list) digest the Dockerfile is built from. */
      index: DigestSchema,
      /** The per-platform image manifests inside that index. */
      platforms: z.object({ "linux/amd64": DigestSchema, "linux/arm64": DigestSchema }),
    }),
  ),
});
export type BaseImageLock = z.infer<typeof BaseImageLockSchema>;

export async function loadBaseImageLock(path: string): Promise<BaseImageLock> {
  return BaseImageLockSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** The local tag of the lab base image for one Python version and platform. */
export function pythonBaseImageTag(lock: BaseImageLock, python: PythonVersion, platform: ContainerPlatform): string {
  return `${lock.image}:${lock.version}-py${python}-${platform.replace("/", "-")}`;
}

/**
 * The image request for a study's lab: the base image for the approved Python
 * version on the selected platform, built from `lab-images/python-base` with
 * its base pinned by digest. `baseRepository` may name a registry mirror of
 * the same content (the digest pins the bytes either way).
 */
export function pythonBaseImageRequest(input: {
  lock: BaseImageLock;
  python: PythonVersion;
  platform: ContainerPlatform;
  /** The `lab-images/python-base` directory. */
  contextDir: string;
  baseRepository?: string;
  expectedImageId?: string;
}): ImageRequest {
  const base = input.lock.bases[input.python];
  if (!base) {
    throw new ImageNotReadyError("invalid_request", `no lab base image is locked for Python ${input.python}`, {
      platform: input.platform,
    });
  }
  const tag = pythonBaseImageTag(input.lock, input.python, input.platform);
  const repository = input.baseRepository ?? input.lock.baseRepository;
  return {
    key: `lab-base:python-${input.python}`,
    reference: tag,
    platform: input.platform,
    python: input.python,
    ...(input.expectedImageId ? { expectedImageId: input.expectedImageId } : {}),
    build: {
      contextDir: input.contextDir,
      dockerfile: "Dockerfile",
      tag,
      buildArgs: {
        PYTHON_BASE: `${repository}:${base.tag}@${base.index}`,
        PYTHON_VERSION: input.python,
      },
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
