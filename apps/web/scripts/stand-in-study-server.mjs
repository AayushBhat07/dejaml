// STAND-IN ONLY. Serves the built web app from the real API, study state
// machine, agent runtime, policy review, Lab Manager, and verdict code, with
// scripted stand-ins for the model provider, GitHub, and Docker (the same
// stand-ins the API tests use). It exists so the live dashboard can be looked
// at without a model key or Docker. A run on this server is never evidence that
// DéjàML reproduced anything, and capture-live-run.mjs refuses to treat it as one
// unless it is told to label its screenshots as stand-in.
//
// Build first:  npm run build && VITE_DEJAML_API=live npm run build --workspace @dejaml/web
// Then:         node apps/web/scripts/stand-in-study-server.mjs   (PORT, STAND_IN_ENGINEERS, STAND_IN_MODEL_MS, STAND_IN_EXEC_MS)
// It prints the URL and the path of the stand-in paper to upload.
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProviderConfig } from "@dejaml/agent-runtime";
import { buildPlatformSpec } from "@dejaml/contracts";
import { LabManager } from "@dejaml/lab-manager";
import { RunStore } from "@dejaml/run-store";

import { createApiServer, DEFAULT_STUDY_RESOURCES, loadCases } from "../../api/dist/index.js";
import { fixedLabImagePort, loadClaimTarget } from "../../api/dist/study/index.js";
import {
  paperPdf,
  ScriptedModel,
  ScriptedRuntime,
  ScriptedStudyProvider,
  STAND_IN_IMAGE_ID,
  standInAcquire,
} from "../../api/dist/stand-ins.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const port = Number(process.env.PORT ?? "8788");
const repositoryUrl = "https://github.com/example/new-paper";
const commitSha = "7f8b1c4cbe5b4caf2f6cc8bc0d6fc31ce2f6bd71";

const work = await mkdtemp(join(tmpdir(), "dejaml-stand-in-"));
const projectRoot = join(work, "project");
const caseDir = join(projectRoot, "cases/urban-land-cover");
await mkdir(join(caseDir, "data"), { recursive: true });
for (const name of ["policy.json", "case.json", "runner.py"]) {
  await copyFile(join(repoRoot, "cases/urban-land-cover", name), join(caseDir, name));
}
await writeFile(join(caseDir, "data/training.csv"), "stand-in\n");
await writeFile(join(caseDir, "data/testing.csv"), "stand-in\n");
await mkdir(join(work, "data"), { recursive: true });
const paper = await paperPdf(false);
await writeFile(join(work, "stand-in-paper.pdf"), paper);

// A reviewed target for the stand-in paper, built the way the API tests build theirs.
const target = await loadClaimTarget(
  {
    schemaVersion: 1,
    caseId: "stand-in-rf-accuracy",
    paper: { title: "Stand-in paper (not a real study)", sha256: createHash("sha256").update(paper).digest("hex") },
    claim: {
      page: 1,
      location: "Section 4",
      excerpt: "Random Forest test accuracy of 81.66 percent on the test set.",
      method: "Random Forest",
      dataset: "UCI Urban Land Cover",
      split: "official test set",
      preprocessing: "not stated",
      seedPolicy: "not stated",
      metric: { name: "accuracy", unit: "percent" },
      reportedValue: 81.66,
      identify: { methodIncludes: ["Random Forest"], methodExcludes: [], datasetIncludes: ["Urban Land Cover"] },
    },
    repository: { url: repositoryUrl, commitSha, entrypoint: "train.py" },
    environment: { python: ["3.11"], requirements: [], allowedCompatibilityConstraints: [] },
    dataset: { source: { kind: "repository" } },
    adapter: null,
    metricParser: { source: "json", path: "artifacts/result.json", key: "metrics.accuracyPercent" },
    expectedRuntimeCeilingSeconds: 60,
    tolerance: 2,
    maximumVerdict: "reproduced",
  },
  repoRoot,
);

const cases = await loadCases(projectRoot);
const store = new RunStore();
const runtime = new ScriptedRuntime();
runtime.execDelayMs = Number(process.env.STAND_IN_EXEC_MS ?? "6000");
const labs = new LabManager({ runtime, labRoot: join(work, "labs"), events: (event) => store.appendEvent(event) });
const provider = new ScriptedStudyProvider(repositoryUrl);
provider.delayMs = Number(process.env.STAND_IN_MODEL_MS ?? "900");
const model = new ScriptedModel(cases[0], 120, 0);
model.repositoryUrl = repositoryUrl;

const api = createApiServer({
  store,
  labs,
  providers: loadProviderConfig({ DEJAML_OPENAI_API_KEY: "stand-in-key-not-used", DEJAML_OPENAI_MODELS: "stand-in" }),
  providerFactory: () => provider,
  structuredModel: () => model,
  cases,
  projectRoot,
  workRoot: join(work, "data"),
  image: { name: "dejaml/python-cpu:0.1.0", expectedImageId: STAND_IN_IMAGE_ID },
  acquire: standInAcquire(cases[0], [], commitSha),
  reviewedTargets: new Map([[target.caseId, target]]),
  multiAgent: {
    enabled: true,
    dependencies: null,
    images: fixedLabImagePort({ name: "dejaml/python-cpu:0.1.0", expectedImageId: STAND_IN_IMAGE_ID }),
    datasets: null,
    config: {
      platform: buildPlatformSpec({ architecture: "amd64", python: "3.11" }),
      resources: DEFAULT_STUDY_RESOURCES,
      engineers: Number(process.env.STAND_IN_ENGINEERS ?? "2"),
      datasetPolicy: { allowedHosts: [], maxRedirects: 3, maxBytes: 1024, timeoutMs: 1000 },
      maxStudyMs: 600_000,
      commandTimeoutSeconds: 120,
      maxReplans: 2,
      trustedConstraints: [],
    },
    leakCheck: async () => ({ containers: [...runtime.containers], networks: [] }),
  },
  webRoot: join(repoRoot, "apps/web/dist"),
});
api.server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`STAND-IN study server on http://127.0.0.1:${port}\nstand-in paper: ${join(work, "stand-in-paper.pdf")}\n`);
});
const shutdown = async () => {
  await api.close();
  store.close();
  await rm(work, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
