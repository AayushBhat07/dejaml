import { chmod, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { type BaseImageLock, type ImageReadiness, ImageNotReadyError, pythonBaseImageRequest } from "@dejaml/lab-manager";
import { acquireLabDataset, cleanupDataset, DatasetError, type FetchPolicy, NetGuardError } from "@dejaml/net-guard";
import {
  type DependencyManifest,
  type DependencyPreparer,
  findAcceleratorRequirements,
  isAcceleratorIndexUrl,
  parseRequirementLine,
  type ParsedRequirement,
  PrepError,
  type PrepErrorCode,
  sha256File,
} from "@dejaml/prep";

import {
  type DatasetPort,
  type DependencyPort,
  type DependencyScreen,
  LAB_LAYOUT,
  type LabImagePort,
  PreparationFailure,
  type PreparedDependencies,
} from "./context.js";

/**
 * Local implementations of the orchestrator's ports. An AWS deployment swaps
 * these for workers behind a queue; the orchestrator does not change.
 */

/** Trust zone 4: allowlisted HTTPS downloads, checksummed, extracted safely, mounted read-only. */
export function localDatasetPort(policy: FetchPolicy): DatasetPort {
  return {
    async acquire(input) {
      try {
        const dataset = await acquireLabDataset({
          name: input.name,
          url: input.url,
          policy,
          ...(input.sha256 ? { expectedSha256: input.sha256 } : {}),
          requireChecksum: true,
          destinationDir: input.destinationDir,
          extract: input.extract,
          signal: input.signal,
        });
        const identity = dataset.identity;
        return {
          identity: {
            name: identity.name,
            requestedUrl: identity.requestedUrl,
            finalUrl: identity.finalUrl,
            sha256: identity.sha256,
            bytes: identity.bytes,
            checksumVerified: identity.checksumVerified,
            extracted: identity.extracted
              ? { fileCount: identity.extracted.fileCount, totalBytes: identity.extracted.totalBytes, listingDigest: identity.extracted.listingDigest }
              : null,
            fetchedAt: identity.fetchedAt,
          },
          root: dataset.root,
          labPath: `${LAB_LAYOUT.dataDir}/${dataset.extractedPath ?? dataset.downloadPath}`,
        };
      } catch (error) {
        if (error instanceof DatasetError) throw new PreparationFailure(`dataset_${error.code}`, error.message, error.policy);
        if (error instanceof NetGuardError) throw new PreparationFailure(`dataset_${error.code}`, error.message, "policy_blocked");
        throw error;
      }
    },
    async release(dataset) {
      const receipt = await cleanupDataset(dataset.root);
      return { removed: receipt.verifiedAbsent };
    },
  };
}

/** What each preparation error means for the study. */
const PREP_OUTCOMES: Record<PrepErrorCode, PreparationFailure["outcome"]> = {
  // The plan can change: another Python version or a trusted constraint may resolve.
  no_compatible_wheel: "replan",
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
      refused.push({ requirement: line, code: "accelerator_package_refused", reason: "accelerator package indexes are refused under the CPU-only policy" });
      continue;
    }
    const result = parseRequirementLine(line);
    if (!result.ok) refused.push({ requirement: line, code: "invalid_requirement", reason: result.reason });
    else if (result.requirement) parsed.push(result.requirement);
  }
  for (const finding of findAcceleratorRequirements(parsed)) {
    refused.push({ requirement: finding.spec, code: "accelerator_package_refused", reason: `${finding.reason}; only CPU packages are prepared` });
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
          detail: { packages: resolution.packages.map((pkg) => `${pkg.name}==${pkg.version}`), resolver: resolution.resolver.mode, platform: platform.containerPlatform },
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
    receipts: { resolver: manifest.resolver, cache: manifest.cache, disk: manifest.disk, cleanup: manifest.cleanup, rejected: manifest.rejected },
  };
}

/**
 * The lab base image for the plan's Python on the selected platform, made
 * ready by the Lab Manager's ImageReadiness: found by identity, pulled by
 * digest, or built from `lab-images/python-base` with its base pinned by the
 * lock. It never falls back to another image or platform.
 */
export function readinessLabImagePort(input: { readiness: ImageReadiness; lock: BaseImageLock; contextDir: string }): LabImagePort {
  return {
    async ensure({ platform, signal }) {
      try {
        const request = pythonBaseImageRequest({ lock: input.lock, python: platform.python.version, platform: platform.containerPlatform, contextDir: input.contextDir });
        const ready = await input.readiness.ensure(request, signal);
        return { name: ready.reference, imageId: ready.imageId, digest: ready.digest, containerPlatform: ready.platform, python: ready.python ?? platform.python.version };
      } catch (error) {
        if (error instanceof ImageNotReadyError) throw new PreparationFailure(`lab_image_${error.code}`, error.message, "failed");
        throw error;
      }
    },
  };
}

/**
 * A single pre-built lab image, identified by its expected image id. The lab
 * checks the Python version after setup, so a plan asking for another Python
 * fails there instead of silently running on the wrong interpreter.
 */
export function fixedLabImagePort(image: { name: string; expectedImageId: string }): LabImagePort {
  return {
    async ensure({ platform }) {
      return { name: image.name, imageId: image.expectedImageId, digest: null, containerPlatform: platform.containerPlatform, python: platform.python.version };
    },
  };
}
