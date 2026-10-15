import { chmod, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  type BaseImageLock,
  type ImageReadiness,
  ImageNotReadyError,
  pythonBaseImageRequest,
  type RBaseImageLock,
  rBaseImageRequest,
} from "@dejaml/lab-manager";
import {
  acquireLabDataset,
  cleanupDataset,
  DatasetError,
  type FetchPolicy,
  type LabDataset,
  NetGuardError,
  parseAllowedHosts,
} from "@dejaml/net-guard";
import {
  type DependencyManifest,
  type DependencyPreparer,
  findAcceleratorRequirements,
  isAcceleratorIndexUrl,
  parseRequirementLine,
  type ParsedRequirement,
  PrepError,
  type PrepErrorCode,
  chmodTree,
  RPackagePreparer,
  sha256File,
} from "@dejaml/prep";
import type { RVersion } from "@dejaml/contracts";

import {
  type DatasetPort,
  type DependencyPort,
  type DependencyScreen,
  LAB_LAYOUT,
  type LabImagePort,
  PreparationFailure,
  type PreparedDependencies,
  type RPackagePort,
} from "./context.js";

/**
 * Public hosts that serve the datasets lightweight ML papers use (UCI,
 * OpenML, the UCR/UEA archive, Zenodo, figshare, Hugging Face, files in
 * GitHub repositories), with the hosts their downloads redirect to. Every
 * download is still HTTPS-only, size-capped, and pinned by its SHA-256.
 */
export const COMMON_DATASET_HOSTS: readonly string[] = [
  "archive.ics.uci.edu",
  "www.openml.org",
  "api.openml.org",
  "data.openml.org",
  "www.timeseriesclassification.com",
  "timeseriesclassification.com",
  "www.cs.ucr.edu",
  "zenodo.org",
  "figshare.com",
  "ndownloader.figshare.com",
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs.hf.co",
  "cas-bridge.xethub.hf.co",
  "raw.githubusercontent.com",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

/** The dataset allowlist: the common hosts when unset or empty, none for `none`, else exactly the listed hosts. */
export function datasetAllowedHosts(env: string | undefined): string[] {
  const value = (env ?? "").trim();
  if (value === "") return [...COMMON_DATASET_HOSTS];
  if (value.toLowerCase() === "none") return [];
  return parseAllowedHosts(value);
}

/**
 * Local implementations of the orchestrator's ports. An AWS deployment swaps
 * these for workers behind a queue; the orchestrator does not change.
 */

/**
 * Some hosts answer a missing file with HTTP 200 and a short HTML or text
 * error page. A dataset is never a web page or a few bytes saying "not found",
 * so the probe refuses those instead of reporting their hash.
 */
async function looksLikeErrorPage(dataset: LabDataset): Promise<string | null> {
  if (dataset.identity.extracted) return null;
  if (/^text\/html\b/iu.test(dataset.identity.contentType ?? "")) return "a web page";
  if (dataset.identity.bytes > 2048) return null;
  const head = await readFile(dataset.filePath, "utf8").catch(() => "");
  if (/^\s*<(?:!doctype\s+html|html|head|body)\b/iu.test(head)) return "a web page";
  if (/^\s*(?:404\b|<\?xml[^>]*>\s*<Error>)|\b(?:not found|no such file|access denied|forbidden)\b/iu.test(head)) {
    return `an error message (${dataset.identity.bytes} bytes)`;
  }
  return null;
}

/** Probed downloads kept so preparation can reuse them; each may hold a full-size dataset on disk. */
const MAX_KEPT_PROBES = 2;

function datasetFailure(error: unknown): unknown {
  if (error instanceof DatasetError) return new PreparationFailure(`dataset_${error.code}`, error.message, error.policy);
  if (error instanceof NetGuardError) return new PreparationFailure(`dataset_${error.code}`, error.message, "policy_blocked");
  return error;
}

/** Trust zone 4: allowlisted HTTPS downloads, checksummed, extracted safely, mounted read-only. */
export function localDatasetPort(policy: FetchPolicy): DatasetPort {
  const kept: Array<{ dataset: LabDataset; url: string; extract: boolean }> = [];

  /**
   * Moves a kept probe of the same URL, archive mode and hash into
   * `destinationDir`, so the file is not downloaded twice. Null when there is
   * none or the move fails; the caller then downloads as usual.
   */
  async function takeProbe(input: { url: string; sha256: string; extract: boolean; destinationDir: string }): Promise<LabDataset | null> {
    const index = kept.findIndex(
      (entry) =>
        entry.extract === input.extract &&
        entry.dataset.identity.sha256 === input.sha256.toLowerCase() &&
        (entry.url === input.url || entry.dataset.identity.finalUrl === input.url),
    );
    if (index === -1) return null;
    const { dataset } = kept.splice(index, 1)[0] as { dataset: LabDataset };
    try {
      // A sealed directory must be writable to move it to a new parent.
      await chmod(dataset.root, 0o755);
      await rename(dataset.root, input.destinationDir);
    } catch {
      await cleanupDataset(dataset.root);
      return null;
    }
    try {
      await chmod(input.destinationDir, 0o555);
    } catch {
      await cleanupDataset(input.destinationDir);
      return null;
    }
    return { ...dataset, root: input.destinationDir, filePath: join(input.destinationDir, dataset.downloadPath) };
  }

  return {
    async acquire(input) {
      try {
        const reused = input.sha256 ? await takeProbe({ ...input, sha256: input.sha256 }) : null;
        const dataset =
          reused ??
          (await acquireLabDataset({
            name: input.name,
            url: input.url,
            policy,
            ...(input.sha256 ? { expectedSha256: input.sha256 } : {}),
            requireChecksum: true,
            destinationDir: input.destinationDir,
            extract: input.extract,
            signal: input.signal,
          }));
        const identity = dataset.identity;
        return {
          identity: {
            name: input.name,
            requestedUrl: identity.requestedUrl,
            finalUrl: identity.finalUrl,
            sha256: identity.sha256,
            bytes: identity.bytes,
            // A reused probe matched the plan's hash, which verifies it.
            checksumVerified: reused !== null || identity.checksumVerified,
            extracted: identity.extracted
              ? {
                  fileCount: identity.extracted.fileCount,
                  totalBytes: identity.extracted.totalBytes,
                  listingDigest: identity.extracted.listingDigest,
                }
              : null,
            fetchedAt: identity.fetchedAt,
          },
          root: dataset.root,
          labPath: `${LAB_LAYOUT.dataDir}/${dataset.extractedPath ?? dataset.downloadPath}`,
        };
      } catch (error) {
        throw datasetFailure(error);
      }
    },
    async release(dataset) {
      const receipt = await cleanupDataset(dataset.root);
      return { removed: receipt.verifiedAbsent };
    },
    async probe(input) {
      let dataset: LabDataset;
      try {
        dataset = await acquireLabDataset({
          name: "probe",
          url: input.url,
          policy,
          destinationDir: input.destinationDir,
          extract: input.extract,
          signal: input.signal,
        });
      } catch (error) {
        await cleanupDataset(input.destinationDir).catch(() => undefined);
        throw datasetFailure(error);
      }
      const errorPage = await looksLikeErrorPage(dataset);
      if (errorPage) {
        await cleanupDataset(dataset.root).catch(() => undefined);
        throw new PreparationFailure("dataset_error_page", `the URL returned ${errorPage}, not data`, "inconclusive");
      }
      kept.push({ dataset, url: input.url, extract: input.extract });
      while (kept.length > MAX_KEPT_PROBES) {
        const oldest = kept.shift();
        if (oldest) await cleanupDataset(oldest.dataset.root).catch(() => undefined);
      }
      const files = dataset.identity.extracted?.files ?? [];
      return {
        finalUrl: dataset.identity.finalUrl,
        sha256: dataset.identity.sha256,
        bytes: dataset.identity.bytes,
        files: files.slice(0, 200).map((file) => ({ path: file.path, bytes: file.bytes })),
        fileCount: files.length,
      };
    },
  };
}

/** What each preparation error means for the study. */
const PREP_OUTCOMES: Record<PrepErrorCode, PreparationFailure["outcome"]> = {
  // The plan can change: another Python version or a trusted constraint may resolve.
  no_compatible_wheel: "replan",
  // An R package with no prebuilt binary: another package or version may have one.
  no_compatible_binary: "replan",
  resolution_conflict: "replan",
  // Refused by policy: never retried with broader access.
  accelerator_package_refused: "policy_blocked",
  egress_denied: "policy_blocked",
  invalid_requirement: "policy_blocked",
  invalid_policy: "policy_blocked",
  // The environment could not be prepared within its bounds.
  insufficient_preparation_space: "inconclusive",
  limit_exceeded: "inconclusive",
  timeout: "inconclusive",
  // Infrastructure faults.
  cancelled: "failed",
  image_unavailable: "failed",
  image_mismatch: "failed",
  platform_mismatch: "failed",
  integrity_error: "failed",
  runtime_error: "failed",
};

function prepFailure(error: unknown): unknown {
  if (!(error instanceof PrepError)) return error;
  return new PreparationFailure(error.code, error.message, PREP_OUTCOMES[error.code], error.requirement ?? error.refused[0] ?? null);
}

/** Static screening with no network: invalid lines, URLs, local paths, index options, and accelerator packages. */
export function screenRequirements(requirements: string[]): DependencyScreen {
  const refused: DependencyScreen["refused"] = [];
  const parsed: ParsedRequirement[] = [];
  for (const line of requirements) {
    if (/^\s*-/u.test(line) && isAcceleratorIndexUrl(line)) {
      refused.push({
        requirement: line,
        code: "accelerator_package_refused",
        reason: "accelerator package indexes are refused under the CPU-only policy",
      });
      continue;
    }
    const result = parseRequirementLine(line);
    if (!result.ok) refused.push({ requirement: line, code: "invalid_requirement", reason: result.reason });
    else if (result.requirement) parsed.push(result.requirement);
  }
  for (const finding of findAcceleratorRequirements(parsed)) {
    refused.push({
      requirement: finding.spec,
      code: "accelerator_package_refused",
      reason: `${finding.reason}; only CPU packages are prepared`,
    });
  }
  return { refused };
}

/**
 * Trust zone 3: the Dependency Preparer resolves and downloads verified,
 * platform-matched binary wheels behind an allowlisted egress proxy. The lab
 * itself never reaches a package index.
 */
export function preparerPort(preparer: DependencyPreparer): DependencyPort {
  return {
    screen: (requirements) => screenRequirements(requirements),
    async check({ runId, platform, requirements, signal }) {
      try {
        const resolution = await preparer.resolvePython({ runId, platform, requirements, signal });
        return {
          ok: true,
          detail: {
            packages: resolution.packages.map((pkg) => `${pkg.name}==${pkg.version}`),
            resolver: resolution.resolver.mode,
            platform: platform.containerPlatform,
          },
        };
      } catch (error) {
        if (error instanceof PrepError && (error.code === "no_compatible_wheel" || error.code === "resolution_conflict")) {
          return { ok: false, detail: { code: error.code, requirement: error.requirement ?? null, message: error.message } };
        }
        throw prepFailure(error);
      }
    },
    async prepare({ runId, platform, requirements, constraints, signal }) {
      let manifest: DependencyManifest;
      try {
        const resolution = await preparer.resolvePython({
          runId,
          platform,
          requirements,
          constraints: constraints.map((item) => ({ spec: item.requirement, reason: item.reason })),
          includeInstaller: true,
          signal,
        });
        manifest = await preparer.downloadWheels(resolution, { platform, signal });
      } catch (error) {
        throw prepFailure(error);
      }
      return preparedFromManifest(manifest, await sha256File(join(manifest.wheelhouseDir, "manifest.json")));
    },
    async release(prepared) {
      await chmod(prepared.wheelhouseDir, 0o755).catch(() => undefined);
      await rm(prepared.wheelhouseDir, { recursive: true, force: true });
      const removed = await stat(prepared.wheelhouseDir).then(
        () => false,
        () => true,
      );
      return { removed };
    },
  };
}

/** Trust zone 3 for R: prebuilt CRAN binaries from a dated snapshot, unpacked by the host; nothing is compiled. */
export function rPackagePort(preparer: RPackagePreparer, lock: RBaseImageLock): RPackagePort {
  // The full R version of each lab image, for `Depends: R (>= …)`.
  const full = (r: RVersion): string => lock.bases[r]?.rVersion ?? `${r}.0`;
  return {
    snapshot: preparer.snapshot,
    screen: (packages) => RPackagePreparer.screen(packages),
    async check({ packages, r, platform, signal }) {
      try {
        const { order, provided } = await preparer.check({ packages, r, rVersion: full(r), platform, signal });
        return {
          ok: true,
          detail: { packages: order.map((item) => `${item.name} ${item.version}`), provided, snapshot: preparer.snapshot },
        };
      } catch (error) {
        if (error instanceof PrepError && error.code === "no_compatible_binary") {
          return { ok: false, detail: { code: error.code, requirement: error.requirement ?? null, message: error.message } };
        }
        throw prepFailure(error);
      }
    },
    async prepare({ runId, packages, r, platform, signal }) {
      try {
        const prepared = await preparer.prepare({ runId, packages, r, rVersion: full(r), platform, signal });
        return {
          manifestSha256: prepared.manifestSha256,
          libraryDir: prepared.libraryDir,
          snapshot: prepared.manifest.snapshot,
          packages: prepared.manifest.packages.map((item) => ({
            name: item.name,
            version: item.version,
            sha256: item.sha256,
            requested: item.requested,
          })),
        };
      } catch (error) {
        throw prepFailure(error);
      }
    },
    async release(prepared) {
      await chmodTree(prepared.libraryDir).catch(() => undefined);
      await rm(prepared.libraryDir, { recursive: true, force: true });
      const removed = await stat(prepared.libraryDir).then(
        () => false,
        () => true,
      );
      return { removed };
    },
  };
}

export function preparedFromManifest(manifest: DependencyManifest, manifestSha256: string): PreparedDependencies {
  return {
    prepId: manifest.prepId,
    manifestSha256,
    wheelhouseDir: manifest.wheelhouseDir,
    installerWheel: manifest.installer?.filename ?? null,
    python: manifest.platform.python.version,
    containerPlatform: manifest.platform.containerPlatform,
    prepImage: { name: manifest.image, digest: manifest.imageIdentity.digest },
    packages: manifest.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      filename: pkg.filename,
      sha256: pkg.sha256,
      bytes: pkg.bytes,
      tags: [pkg.platformTags.python.join("."), pkg.platformTags.abi.join("."), pkg.platformTags.platform.join(".")].join("-"),
    })),
    requested: manifest.requested,
    constraints: manifest.compatibilityChanges.map((change) => ({ requirement: change.constraint, reason: change.reason })),
    changes: manifest.compatibilityChanges.map(
      (change) =>
        `${change.name}: repository asked for ${change.repository.join(", ") || "nothing (transitive)"}; constraint ${change.constraint} resolved ${change.resolved ?? "not needed"} (${change.reason})`,
    ),
    receipts: {
      resolver: manifest.resolver,
      cache: manifest.cache,
      disk: manifest.disk,
      cleanup: manifest.cleanup,
      rejected: manifest.rejected,
    },
  };
}

/**
 * The lab base image for the plan's Python on the selected platform, made
 * ready by the Lab Manager's ImageReadiness: found by identity, pulled by
 * digest, or built from `lab-images/python-base` with its base pinned by the
 * lock. It never falls back to another image or platform.
 */
export function readinessLabImagePort(input: {
  readiness: ImageReadiness;
  lock: BaseImageLock;
  contextDir: string;
  /** The R lab images, when this server offers R studies. */
  r?: { lock: RBaseImageLock; contextDir: string } | null;
}): LabImagePort {
  const rLock = input.r?.lock ?? null;
  return {
    rVersions: rLock ? (Object.keys(rLock.bases) as RVersion[]) : [],
    async ensure({ platform, r, signal }) {
      try {
        if (r && !input.r) throw new PreparationFailure("lab_image_r_unavailable", "this server has no R lab image", "policy_blocked");
        const request =
          r && input.r
            ? rBaseImageRequest({ lock: input.r.lock, r, platform: platform.containerPlatform, contextDir: input.r.contextDir })
            : pythonBaseImageRequest({
                lock: input.lock,
                python: platform.python.version,
                platform: platform.containerPlatform,
                contextDir: input.contextDir,
              });
        const ready = await input.readiness.ensure(request, signal);
        return {
          name: ready.reference,
          imageId: ready.imageId,
          digest: ready.digest,
          containerPlatform: ready.platform,
          python: ready.python ?? platform.python.version,
          ...(r && rLock?.bases[r] ? { r: rLock.bases[r].rVersion } : {}),
        };
      } catch (error) {
        if (error instanceof ImageNotReadyError) {
          // Docker's own error (an unreachable engine, a failed base pull) is the actionable part; keep it.
          if (error.detail) console.error(`[lab image] ${error.message}\n${error.detail}`);
          const cause = dockerErrorLine(error.detail);
          throw new PreparationFailure(`lab_image_${error.code}`, cause ? `${error.message}: ${cause}` : error.message, "failed");
        }
        throw error;
      }
    },
  };
}

/** The line of Docker's stderr that names the failure, such as `ERROR: failed to solve: …`, else its last line. */
export function dockerErrorLine(stderr: string | undefined): string | null {
  const lines = (stderr ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.findLast((item) => /^(error|fatal)\b/iu.test(item)) ?? lines.at(-1);
  return line ? line.slice(0, 400) : null;
}

/**
 * A single pre-built lab image, identified by its expected image id. The lab
 * checks the Python version after setup, so a plan asking for another Python
 * fails there instead of silently running on the wrong interpreter.
 */
export function fixedLabImagePort(image: { name: string; expectedImageId: string }): LabImagePort {
  return {
    async ensure({ platform }) {
      return {
        name: image.name,
        imageId: image.expectedImageId,
        digest: null,
        containerPlatform: platform.containerPlatform,
        python: platform.python.version,
      };
    },
  };
}
