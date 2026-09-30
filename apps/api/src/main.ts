#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LabManager } from "@dejaml/lab-manager";
import { loadProviderConfig, ProviderConfigError, publicProviders } from "@dejaml/agent-runtime";
import { DEFAULT_DATASET_POLICY, parseAllowedHosts } from "@dejaml/net-guard";
import { DependencyPreparer, loadPrepPolicy } from "@dejaml/prep";
import { RunStore } from "@dejaml/run-store";

import { loadCases } from "./cases.js";
import { DEFAULT_STUDY_RESOURCES } from "./pipeline.js";
import { createApiServer, legacyModelEnv, recoverAfterRestart } from "./server.js";

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
  providers = loadProviderConfig(legacyModelEnv(process.env));
} catch (error) {
  process.stderr.write(`Model provider configuration is invalid:\n${error instanceof ProviderConfigError ? error.problems.join("\n") : String(error)}\n`);
  process.exit(1);
}
// Trust zone 2: Python wheels are downloaded by short-lived, egress-restricted containers.
const prep =
  process.env.DEJAML_PREP_ENABLED === "0"
    ? null
    : new DependencyPreparer({ cacheDir: join(dataDir, "prep-cache"), policy: loadPrepPolicy(process.env), workRoot: join(dataDir, "prep-tmp") });
const prepOrphans = await prep?.cleanupOrphans().catch(() => null);
const datasetHosts = parseAllowedHosts(process.env.DEJAML_DATASET_ALLOWED_HOSTS ?? "");
const number = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const recovery = await recoverAfterRestart({ store, labs, workRoot: dataDir });
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
    prep,
    config: {
      resources: { ...DEFAULT_STUDY_RESOURCES, timeoutSeconds: number("DEJAML_LAB_TIMEOUT_SECONDS", DEFAULT_STUDY_RESOURCES.timeoutSeconds) },
      engineers: Math.min(4, Math.floor(number("DEJAML_LAB_ENGINEERS", 2))),
      datasetPolicy: { ...DEFAULT_DATASET_POLICY, allowedHosts: datasetHosts },
      maxStudyMs: number("DEJAML_STUDY_MAX_MINUTES", 180) * 60_000,
      commandTimeoutSeconds: number("DEJAML_COMMAND_TIMEOUT_SECONDS", 900),
      maxDelegations: 8,
    },
  },
  webRoot: join(projectRoot, "apps/web/dist"),
});

api.server.listen(port, host, () => {
  process.stdout.write(
    `DéjàML API on http://${host}:${port} (data: ${dataDir}; recovered ${recovery.interruptedRuns.length} interrupted run(s), ${recovery.orphanLabs} orphan lab(s), ${prepOrphans?.containersRemoved.length ?? 0} orphan prep container(s); providers: ${publicProviders(providers).map((item) => item.id).join(", ") || "none"})\n`,
  );
});

const shutdown = (): void => {
  void api.close().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
