// Serves the built web app from the real API, pipeline, policy gate, Lab
// Manager, and Result Verifier, with stand-ins only for the model provider,
// GitHub, and Docker. Used to drive the full UI in live mode without external
// services. Build first: VITE_DEJAML_API=live npm run build
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { LabManager } from "@dejaml/lab-manager";
import { RunStore } from "@dejaml/run-store";

import { createApiServer, loadCases } from "../dist/index.js";
import { ScriptedModel, ScriptedRuntime, STAND_IN_IMAGE_ID, paperPdf, standInAcquire } from "../dist/stand-ins.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const port = Number(process.env.PORT ?? "8787");
const work = await mkdtemp(join(tmpdir(), "dejaml-stack-"));
const caseDir = join(work, "project/cases/urban-land-cover");
await mkdir(join(caseDir, "data"), { recursive: true });
for (const name of ["policy.json", "case.json", "runner.py"]) {
  await copyFile(join(repoRoot, "cases/urban-land-cover", name), join(caseDir, name));
}
await writeFile(join(caseDir, "data/training.csv"), "stand-in\n");
await writeFile(join(caseDir, "data/testing.csv"), "stand-in\n");
await mkdir(join(work, "data"));
await writeFile(join(work, "paper.pdf"), await paperPdf());

const cases = await loadCases(join(work, "project"));
const store = new RunStore();
const runtime = new ScriptedRuntime();
runtime.execDelayMs = Number(process.env.STAND_IN_EXEC_MS ?? "3000");
const timeoutSeconds = Number(process.env.STAND_IN_TIMEOUT_S ?? "120");
if (process.env.STAND_IN_MODE === "hang") runtime.mode = "hang";
const labs = new LabManager({ runtime, labRoot: join(work, "labs"), events: (event) => store.appendEvent(event) });
const api = createApiServer({
  store,
  labs,
  model: new ScriptedModel(cases[0], timeoutSeconds, Number(process.env.STAND_IN_MODEL_MS ?? "1200")),
  cases,
  projectRoot: join(work, "project"),
  workRoot: join(work, "data"),
  image: { name: "dejaml/python-cpu:0.1.0", expectedImageId: STAND_IN_IMAGE_ID },
  acquire: standInAcquire(cases[0]),
  webRoot: join(repoRoot, "apps/web/dist"),
});
api.server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`stand-in stack on http://127.0.0.1:${port} (sample paper: ${join(work, "paper.pdf")})\n`);
});
const shutdown = async () => {
  await api.close();
  store.close();
  await rm(work, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
