#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LabManager } from "@dejaml/lab-manager";
import { OpenClawGatewayStructuredClient } from "@dejaml/research-runtime";
import { RunStore } from "@dejaml/run-store";

import { loadCases } from "./cases.js";
import { createApiServer, recoverAfterRestart } from "./server.js";

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
const model = new OpenClawGatewayStructuredClient({
  binaryPath: process.env.OPENCLAW_BIN ?? "openclaw",
  analystAgents: {
    paper_analyst: process.env.DEJAML_PAPER_AGENT ?? "dejaml-paper",
    code_analyst: process.env.DEJAML_CODE_AGENT ?? "dejaml-code",
    lead_researcher: process.env.DEJAML_LEAD_AGENT ?? "dejaml-lead",
    audit_agent: process.env.DEJAML_AUDIT_AGENT ?? "dejaml-audit",
  },
  timeoutSeconds: 180,
  thinking: "low",
});

const recovery = await recoverAfterRestart({ store, labs, workRoot: dataDir });
const api = createApiServer({
  store,
  labs,
  model,
  cases: await loadCases(projectRoot),
  projectRoot,
  workRoot: dataDir,
  image: {
    name: imageLock.image,
    // The lock's ID was verified on linux/arm64; other platforms must rebuild and override.
    expectedImageId: process.env.DEJAML_EXPECTED_IMAGE_ID ?? imageLock.verifiedImageId,
  },
  webRoot: join(projectRoot, "apps/web/dist"),
});

api.server.listen(port, host, () => {
  process.stdout.write(
    `DéjàML API on http://${host}:${port} (data: ${dataDir}; recovered ${recovery.interruptedRuns.length} interrupted run(s), ${recovery.orphanLabs} orphan lab(s))\n`,
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
