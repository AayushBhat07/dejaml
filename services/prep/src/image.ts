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

/**
 * Platform manifests of the official `python:<version>-slim-trixie` indexes
 * pinned in DEFAULT_PREP_IMAGES, from `lab-images/python-base/bases.lock.json`
 * (a test keeps the two identical). An index digest names one immutable
 * manifest per platform; a platform manifest digest names exactly one
 * platform and is never valid for another.
 */
export const OFFICIAL_PYTHON_PLATFORM_MANIFESTS: Readonly<Record<string, Readonly<Record<ContainerPlatform, string>>>> = {
  // 3.10.21
  "sha256:9d53d8d4c0e882f61913025db53b3aec4ef74336082a9ab47d8a14e9e8329b00": {
    "linux/amd64": "sha256:179cecec99c29e6f1e97caa424514599267f7dd836696dd673ea5587eefc65fa",
    "linux/arm64": "sha256:2b05dee42ba2a39ad1e491e3f5f5bc2ef2e221ccc48d0772cf1870174b62bd67",
  },
  // 3.11.16
  "sha256:e41613d42d4891e4930f79523f93f81bbc7632584ec65e36ab055f41a800b41e": {
    "linux/amd64": "sha256:174bec68e0451bffabbb08c7d5d21c6b253f772d81d52b9558af97bb3159b761",
    "linux/arm64": "sha256:8b29ec24b5f3c929a79b55772b95c93311b7133f1cf7fa0a6141ef621f8e3c57",
  },
  // 3.12.14
  "sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f": {
    "linux/amd64": "sha256:44ff437bba879d4941b710a369a8f19266aea34b29002807f0c487fabc9eec9b",
    "linux/arm64": "sha256:950206c37262dd86c55659797f6ee418fee30535072f65a82ed470d985f5cda5",
  },
  // 3.13.15
  "sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b": {
    "linux/amd64": "sha256:37134a49d21d2120e4c4d73bb76f8a4ab9aef31f096f7ec2ead48c2feead4332",
    "linux/arm64": "sha256:e2a5fce94bd761967528a12f16d707c2613e1522f3f2d77fa45766f45962547f",
  },
};

/** What a pinned digest is known to be: a multi-platform index, one platform's manifest, or unknown (custom images). */
export type PinKind =
  | { kind: "index"; manifests: Readonly<Record<ContainerPlatform, string>> }
  | { kind: "platform_manifest"; platform: ContainerPlatform; index: string }
  | { kind: "unknown" };

export function classifyPinnedDigest(digest: string): PinKind {
  const manifests = OFFICIAL_PYTHON_PLATFORM_MANIFESTS[digest];
  if (manifests) return { kind: "index", manifests };
  for (const [index, byPlatform] of Object.entries(OFFICIAL_PYTHON_PLATFORM_MANIFESTS)) {
    for (const [platform, manifest] of Object.entries(byPlatform)) {
      if (manifest === digest) return { kind: "platform_manifest", platform: platform as ContainerPlatform, index };
    }
  }
  return { kind: "unknown" };
}

/**
 * The immutable digest that identifies `pinned` on `platform`: the platform's
 * manifest digest when the pin is a known index, the pin itself when it is that
 * platform's manifest, null when unknown (custom images; Docker's own platform
 * answer decides). A known manifest of another platform is a `platform_mismatch`:
 * an arm64 manifest digest is never used as amd64 or the other way round.
 */
export function platformDigestFor(pinned: PinnedReference, platform: ContainerPlatform): string | null {
  const pin = classifyPinnedDigest(pinned.digest);
  if (pin.kind === "index") return pin.manifests[platform];
  if (pin.kind === "platform_manifest") {
    if (pin.platform !== platform) {
      throw new PrepError(
        "platform_mismatch",
        `preparation image ${pinned.reference} pins the ${pin.platform} manifest; it is never used for ${platform}. ` +
          `Pin the multi-platform index ${pinned.repository}@${pin.index} instead`,
      );
    }
    return pinned.digest;
  }
  return null;
}

/**
 * Whether an image ID reported for `platform` is a known manifest of a different platform
 * (containerd image store: a platform inspection reports the platform manifest digest as ID).
 */
export function reportsOtherPlatformManifest(
  pinned: PinnedReference,
  platform: ContainerPlatform,
  imageId: string,
): ContainerPlatform | null {
  const pin = classifyPinnedDigest(pinned.digest);
  if (pin.kind !== "index") return null;
  for (const [other, manifest] of Object.entries(pin.manifests)) {
    if (other !== platform && manifest === imageId) return other as ContainerPlatform;
  }
  return null;
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
    // A known platform manifest pinned for another platform is refused before Docker is asked or anything is pulled.
    platformDigestFor(pinned, request.platform);
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
      const stderr = result.stderr.text;
      // Classic image store: the image is local but for another platform ("… was found but does not match the
      // specified platform: wanted linux/amd64, actual: linux/arm64/v8"). It is never used for the requested one.
      const wrong = /does not match the specified platform: wanted \S+, actual: (\S+)/u.exec(stderr);
      if (wrong?.[1]) return { state: "wrong_platform", platform: wrong[1].replace(/[,.;]$/u, "") };
      if (/does not match the specified platform/iu.test(stderr)) return { state: "wrong_platform", platform: "another platform" };
      // containerd image store: the index is local but has no content for the requested platform.
      if (/does not provide the specified platform/iu.test(stderr)) return { state: "missing_platform" };
      if (/No such image|not found/iu.test(stderr)) return { state: "missing" };
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
    const otherManifest = reportsOtherPlatformManifest(pinned, platform, imageId);
    if (otherManifest) return { state: "wrong_platform", platform: otherManifest };
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
