import type { ContainerPlatform } from "@dejaml/contracts";
import type { ContainerRuntime } from "@dejaml/lab-manager";

import { PrepError } from "./errors.js";
import { tail } from "./report.js";
import { architectureOf } from "./target.js";

/**
 * Preparation-image readiness.
 *
 * The preparer never trusts a mutable tag. Every image is configured as a
 * digest-pinned reference (`python:3.11-slim-trixie@sha256:…`), looked up by
 * that digest for one explicit platform, and containers are created from the
 * digest reference with `--platform` and `--pull never`, so neither a retag
 * nor a concurrent pull can change what runs.
 *
 * `PrepImageProvider` is structural so that the lab manager's
 * `ImageReadiness` can be injected; `DockerPrepImageProvider` is the small
 * built-in fallback (inspect, and pull by digest only when allowed).
 */

export type PrepImageRequest = {
  /** Stable identity of what is being ensured, such as `prep-python-3.11-linux-amd64`. */
  key: string;
  /** Digest-pinned reference. */
  reference: string;
  platform: ContainerPlatform;
  expectedImageId?: string;
  /** Pull (by digest, for this platform) when the image is missing. */
  pull?: boolean;
};

export type PrepImage = {
  reference?: string;
  imageId: string;
  repoDigests: string[];
  /** The platform of the image that was found, such as `linux/amd64`. */
  platform: string;
};

export type PrepImageProvider = {
  ensure(request: PrepImageRequest, signal?: AbortSignal): Promise<PrepImage>;
};

export type PinnedReference = {
  /** As configured, e.g. `python:3.11-slim-trixie@sha256:…`. */
  reference: string;
  /** Canonical repository without the default registry, e.g. `python`. */
  repository: string;
  tag: string | null;
  digest: string;
  /** `repository@digest`: what containers are created from. */
  digestReference: string;
};

const PINNED =
  /^((?:[a-z0-9][a-z0-9._-]*(?::\d{1,5})?\/)*[a-z0-9][a-z0-9._-]*)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?@(sha256:[a-f0-9]{64})$/u;

export function canonicalRepository(repository: string): string {
  return repository.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//u, "").replace(/^library\//u, "");
}

/** Parse a digest-pinned image reference; an unpinned tag is an `invalid_policy` error. */
export function parsePinnedReference(reference: string): PinnedReference {
  const match = PINNED.exec(reference.trim());
  if (!match?.[1] || !match[3]) {
    throw new PrepError(
      "invalid_policy",
      `preparation image ${reference.slice(0, 200)} must be pinned by digest (name:tag@sha256:<64 hex>)`,
    );
  }
  const repository = canonicalRepository(match[1]);
  return { reference: reference.trim(), repository, tag: match[2] ?? null, digest: match[3], digestReference: `${match[1]}@${match[3]}` };
}

/** Whether what Docker reports is the pinned image: a repo digest (or, on the containerd store, the ID) equals the pin. */
export function imageMatchesPin(image: Pick<PrepImage, "imageId" | "repoDigests">, pinned: PinnedReference): boolean {
  if (image.imageId === pinned.digest) return true;
  return image.repoDigests.some((entry) => {
    const at = entry.lastIndexOf("@");
    return at > 0 && entry.slice(at + 1) === pinned.digest && canonicalRepository(entry.slice(0, at)) === pinned.repository;
  });
}

type InspectOutcome =
  | { state: "present"; image: PrepImage }
  | { state: "missing" }
  | { state: "missing_platform" }
  | { state: "wrong_platform"; platform: string };

const INSPECT_FORMAT = "{{.Id}}|{{.Os}}|{{.Architecture}}|{{json .RepoDigests}}";

/**
 * Built-in provider on the Docker CLI. It distinguishes "missing" (Docker
 * says No such image, or the multi-platform index has no content for this
 * platform) from any other Docker failure, never falls back to another
 * platform, and pulls only by digest when `pull` is set. Concurrent ensures
 * of the same reference and platform share one operation.
 */
export class DockerPrepImageProvider implements PrepImageProvider {
  readonly #runtime: ContainerRuntime;
  readonly #inflight = new Map<string, Promise<PrepImage>>();

  constructor(runtime: ContainerRuntime) {
    this.#runtime = runtime;
  }

  ensure(request: PrepImageRequest, signal?: AbortSignal): Promise<PrepImage> {
    const key = `${request.reference}|${request.platform}|${request.pull === true}`;
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const operation = this.#ensure(request, signal).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, operation);
    return operation;
  }

  async #ensure(request: PrepImageRequest, signal: AbortSignal | undefined): Promise<PrepImage> {
    const pinned = parsePinnedReference(request.reference);
    let outcome = await this.#inspect(pinned, request.platform, signal);
    if (outcome.state !== "present" && outcome.state !== "wrong_platform" && request.pull === true) {
      const pulled = await this.#runtime.docker(["pull", "--platform", request.platform, pinned.digestReference], {
        ...(signal ? { signal } : {}),
        maxOutputBytes: 64 * 1024,
      });
      if (pulled.aborted || signal?.aborted) throw new PrepError("cancelled", "the image pull was cancelled");
      if (pulled.exitCode !== 0) {
        throw new PrepError("image_unavailable", `pulling ${pinned.digestReference} for ${request.platform} failed`, {
          detail: tail(pulled.stderr.text),
        });
      }
      outcome = await this.#inspect(pinned, request.platform, signal);
    }
    switch (outcome.state) {
      case "present":
        return { ...outcome.image, reference: pinned.reference };
      case "wrong_platform":
        throw new PrepError(
          "platform_mismatch",
          `preparation image ${pinned.reference} is ${outcome.platform}, not ${request.platform}; it is never used for another platform`,
        );
      default:
        throw new PrepError(
          "image_unavailable",
          `preparation image ${pinned.reference} is not available locally for ${request.platform}` +
            (outcome.state === "missing_platform" ? " (the image index is present but has no content for this platform)" : "") +
            `; pull it with: docker pull --platform ${request.platform} ${pinned.digestReference}`,
        );
    }
  }

  async #inspect(pinned: PinnedReference, platform: ContainerPlatform, signal: AbortSignal | undefined): Promise<InspectOutcome> {
    const options = { ...(signal ? { signal } : {}), maxOutputBytes: 64 * 1024 };
    let usedPlatformFlag = true;
    let result = await this.#runtime.docker(
      ["image", "inspect", "--platform", platform, "--format", INSPECT_FORMAT, pinned.digestReference],
      options,
    );
    if (result.exitCode !== 0 && /unknown flag: --platform/u.test(result.stderr.text)) {
      // Docker before 28 cannot inspect a single platform; compare the image's own platform instead.
      usedPlatformFlag = false;
      result = await this.#runtime.docker(["image", "inspect", "--format", INSPECT_FORMAT, pinned.digestReference], options);
    }
    if (result.aborted || signal?.aborted) throw new PrepError("cancelled", "the image inspection was cancelled");
    if (result.exitCode !== 0) {
      if (/No such image|not found/iu.test(result.stderr.text)) return { state: "missing" };
      // Anything else (daemon unreachable, permission denied, …) is not "missing" and must not be reported as such.
      throw new PrepError("runtime_error", "docker image inspect failed", { detail: tail(result.stderr.text) });
    }
    const line = result.stdout.text.trim().split("\n").at(-1) ?? "";
    const [imageId = "", os = "", architecture = "", digestsJson = "[]"] = line.split("|");
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId))
      throw new PrepError("runtime_error", "unexpected image ID format from docker image inspect");
    if (os === "" || architecture === "") return usedPlatformFlag ? { state: "missing_platform" } : { state: "missing" };
    const found = `${os}/${architecture}`;
    if (os !== "linux" || architectureOf(found) !== architectureOf(platform)) return { state: "wrong_platform", platform: found };
    let repoDigests: string[] = [];
    try {
      const parsed = JSON.parse(digestsJson) as unknown;
      if (Array.isArray(parsed)) repoDigests = parsed.filter((value): value is string => typeof value === "string");
    } catch {
      repoDigests = [];
    }
    return { state: "present", image: { imageId, repoDigests, platform: found } };
  }
}

/** The platform of the Docker engine (what it runs without emulation). */
export async function dockerEnginePlatform(runtime: ContainerRuntime, signal?: AbortSignal): Promise<ContainerPlatform | null> {
  const result = await runtime.docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], {
    ...(signal ? { signal } : {}),
    maxOutputBytes: 4096,
  });
  if (result.exitCode !== 0) throw new PrepError("runtime_error", "docker version failed", { detail: tail(result.stderr.text) });
  const architecture = architectureOf(result.stdout.text.trim());
  return architecture ? (`linux/${architecture}` as ContainerPlatform) : null;
}
