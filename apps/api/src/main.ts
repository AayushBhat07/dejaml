#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { platformFromEnv } from "@dejaml/contracts";
import { ImageReadiness, LabManager, loadBaseImageLock } from "@dejaml/lab-manager";
import { loadProviderConfig, ProviderConfigError, publicProviders } from "@dejaml/agent-runtime";
import { DEFAULT_DATASET_POLICY, parseAllowedHosts } from "@dejaml/net-guard";
import { DependencyPreparer, loadCompatibilityConstraints, loadPrepPolicy } from "@dejaml/prep";
import { RunStore } from "@dejaml/run-store";

import { loadCases } from "./cases.js";
import { DEFAULT_STUDY_RESOURCES } from "./pipeline.js";
import { environmentSecrets, withSecrets } from "./boundaries.js";
import { createApiServer, recoverAfterRestart } from "./server.js";
import { loadReviewedTargets, localDatasetPort, preparerPort, readinessLabImagePort } from "./study/index.js";

const projectRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const dataDir = resolve(process.env.DEJAML_DATA_DIR ?? join(projectRoot, "artifacts", "api"));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");

await mkdir(dataDir, { recursive: true, mode: 0o700 });
const imageLock = JSON.parse(await readFile(join(projectRoot, "lab-images/python-cpu/image-lock.json"), "utf8")) as {
  image: string;
  verifiedImageId: string;
};
const store = new RunStore(join(dataDir, "runs.sqlite"));
const labs = new LabManager({ labRoot: join(dataDir, "labs"), events: (event) => store.appendEvent(event) });
// Providers and models come only from the server's environment; the browser picks among them.
let providers;
try {
  // Keys come through the secret boundary (the environment here; a secret manager in a deployment).
  providers = loadProviderConfig(withSecrets(process.env, environmentSecrets(process.env)));
} catch (error) {
  process.stderr.write(
    `Model provider configuration is invalid:\n${error instanceof ProviderConfigError ? error.problems.join("\n") : String(error)}\n`,
  );
  process.exit(1);
}
// The lab platform: Apple Silicon → linux/arm64, Intel Mac or an AWS x86 host → linux/amd64 (or DEJAML_PLATFORM).
let platform;
try {
  platform = platformFromEnv(process.env, process.arch);
} catch (error) {
  process.stderr.write(`Platform configuration is invalid: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
// Lab images are found by identity, pulled by digest, or built from a digest-pinned base; never substituted.
const readiness = new ImageReadiness();
const baseImages = await loadBaseImageLock(join(projectRoot, "lab-images/python-base/bases.lock.json"));
// Trust zone 3: Python wheels are downloaded by short-lived, egress-restricted containers.
const prep =
  process.env.DEJAML_PREP_ENABLED === "0"
    ? null
    : new DependencyPreparer({
        cacheDir: join(dataDir, "prep-cache"),
        policy: loadPrepPolicy(process.env),
        workRoot: join(dataDir, "prep-tmp"),
        imageProvider: readiness,
      });
const prepOrphans = await prep?.cleanupOrphans().catch(() => null);
const trustedConstraints = (
  await loadCompatibilityConstraints(join(projectRoot, "config/compatibility-constraints.txt"), "config/compatibility-constraints.txt")
).map((item) => ({ requirement: item.spec, reason: item.reason }));
const OFFICIAL_HOSTS: Record<string, string> = { openai: "api.openai.com", anthropic: "api.anthropic.com" };
// Reviewed claim targets are server-owned files; each adapter is checked against its reviewed hash here.
const reviewedTargets = await loadReviewedTargets(join(projectRoot, "config/reviewed-targets"), projectRoot);
const datasetHosts = parseAllowedHosts(process.env.DEJAML_DATASET_ALLOWED_HOSTS ?? "");
const number = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const recovery = await recoverAfterRestart({ store, labs, workRoot: dataDir, resumeStudies: process.env.DEJAML_AUTONOMOUS !== "0" });
const api = createApiServer({
  store,
  labs,
  providers,
  cases: await loadCases(projectRoot),
  projectRoot,
  workRoot: dataDir,
  image: {
    name: imageLock.image,
    // The lock's ID was verified on linux/arm64; other platforms must rebuild and override.
    expectedImageId: process.env.DEJAML_EXPECTED_IMAGE_ID ?? imageLock.verifiedImageId,
  },
  labAgentEnabled: process.env.DEJAML_LAB_AGENT_ENABLED !== "0",
  multiAgent: {
    enabled: process.env.DEJAML_AUTONOMOUS !== "0",
    dependencies: prep ? preparerPort(prep) : null,
    images: readinessLabImagePort({ readiness, lock: baseImages, contextDir: join(projectRoot, "lab-images/python-base") }),
    datasets: datasetHosts.length ? localDatasetPort({ ...DEFAULT_DATASET_POLICY, allowedHosts: datasetHosts }) : null,
    config: {
      platform,
      resources: {
        ...DEFAULT_STUDY_RESOURCES,
        timeoutSeconds: number("DEJAML_LAB_TIMEOUT_SECONDS", DEFAULT_STUDY_RESOURCES.timeoutSeconds),
      },
      engineers: Math.min(3, Math.floor(number("DEJAML_LAB_ENGINEERS", 1))),
      datasetPolicy: { ...DEFAULT_DATASET_POLICY, allowedHosts: datasetHosts },
      maxStudyMs: number("DEJAML_STUDY_MAX_MINUTES", 180) * 60_000,
      commandTimeoutSeconds: number("DEJAML_COMMAND_TIMEOUT_SECONDS", 900),
      maxReplans: Math.min(4, Math.floor(number("DEJAML_MAX_REPLANS", 2))),
      trustedConstraints,
    },
  },
  webRoot: join(projectRoot, "apps/web/dist"),
  reviewedTargets,
  health: () => ({
    platform: platform.containerPlatform,
    python: platform.python.version,
    images: readiness.status().map((item) => ({
      key: item.key,
      reference: item.reference,
      platform: item.platform,
      state: item.state,
      imageId: item.image?.imageId ?? null,
      digest: item.image?.digest ?? null,
      error: item.error?.code ?? null,
    })),
    dependencyPreparation: prep ? "enabled" : "disabled",
    reviewedTargets: [...reviewedTargets.keys()],
    // Where each available provider's calls go (host only, never a key): `official` means the vendor's own API, not a bridge.
    providers: providers.providers
      .filter((item) => item.available)
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        endpointHost: item.baseUrl ? new URL(item.baseUrl).host : (OFFICIAL_HOSTS[item.kind] ?? null),
        official: item.baseUrl === undefined && item.kind in OFFICIAL_HOSTS,
      })),
    datasetHosts: datasetHosts.length,
  }),
});

api.server.listen(port, host, () => {
  process.stdout.write(
    `DéjàML API on http://${host}:${port} (data: ${dataDir}; platform ${platform.containerPlatform}; recovered ${recovery.interruptedRuns.length} interrupted run(s), resuming ${recovery.resumableRuns.length} study(ies), ${recovery.orphanLabs} orphan lab(s), ${prepOrphans?.containersRemoved.length ?? 0} orphan prep container(s); providers: ${
      publicProviders(providers)
        .map((item) => item.id)
        .join(", ") || "none"
    })\n`,
  );
  // Studies that were mid-flight resume from their last completed stage.
  void api.resume(recovery.resumableRuns);
});

const shutdown = (): void => {
  void api.close().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
