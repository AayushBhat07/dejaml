// Rebuilds the lab and verification part of the replay fixture by running the
// real Lab Manager and Result Verifier against a scripted container runtime.
// Research events (up to plan approval) are kept as written. Lab output lines
// are abbreviated; values come from the Phase 3.1 observation (79.88%).
//
//   npm run build && node fixtures/events/build-urban-land-cover-success.mjs
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RunEventSchema, ExperimentPolicySchema } from "@dejaml/contracts";
import { DEFAULT_LAB_LIMITS, LabManager } from "@dejaml/lab-manager";
import { verifyResult } from "@dejaml/result-verifier";

const fixturePath = fileURLToPath(new URL("urban-land-cover-success.json", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const policy = ExperimentPolicySchema.parse(JSON.parse(await readFile(join(root, "cases/urban-land-cover/policy.json"), "utf8")));
const caseManifest = JSON.parse(await readFile(join(root, "cases/urban-land-cover/case.json"), "utf8"));
const meta = JSON.parse(await readFile(fileURLToPath(new URL("urban-land-cover-success.meta.json", import.meta.url)), "utf8"));
if (meta.source === "recorded") {
  throw new Error("The fixture is a recorded real run; rebuilding it would replace real events with prepared ones.");
}
const existing = RunEventSchema.array().parse(JSON.parse(await readFile(fixturePath, "utf8")));
const research = existing.slice(0, existing.findIndex((event) => event.type === "plan_approved") + 1);
const runId = research[0].runId;

const IMAGE_ID = "sha256:630cac03bfdbd7207c225148a3a0e26a92b0ed3af1063a76e5a1794a373e9920";
const RESULT = `${JSON.stringify({ schemaVersion: 1, caseId: policy.caseId, seed: 42, metrics: { accuracyPercent: 79.88 } }, null, 2)}\n`;
const STDOUT = ['DEJAML_RESULT={"accuracyPercent":79.88}', "DEJAML_ARTIFACT=/workspace/case/artifacts/result.json"];
const STATS = [
  { CPUPerc: "0.00%", MemPerc: "0.05%", MemUsage: "1.1MiB / 2GiB", PIDs: "2" },
  { CPUPerc: "164.20%", MemPerc: "5.21%", MemUsage: "106.7MiB / 2GiB", PIDs: "9" },
  { CPUPerc: "97.10%", MemPerc: "6.02%", MemUsage: "123.3MiB / 2GiB", PIDs: "9" },
];

// Fake clock: every read advances 250 ms from the last research event.
let clock = Date.parse(research.at(-1).timestamp);
const now = () => new Date((clock += 250));

let artifactsDir = "";
const ok = (text = "") => ({ exitCode: 0, stdout: { text, bytes: text.length, truncated: false }, stderr: { text: "", bytes: 0, truncated: false }, aborted: false });
const runtime = {
  async docker(args, options = {}) {
    const [command] = args;
    if (command === "image") return ok(`${IMAGE_ID} 10001:10001`);
    if (command === "create") {
      artifactsDir = /src=([^,]+),dst=\/workspace\/case\/artifacts$/u.exec(args.find((arg) => arg.endsWith("dst=/workspace/case/artifacts")))[1];
      return ok();
    }
    if (command === "stats") {
      for (const frame of STATS) {
        options.onOutput?.("stdout", `\u001b[H${JSON.stringify(frame)}\n`);
        clock += 1000;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      while (!options.signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      return { ...ok(), aborted: true };
    }
    if (command === "exec") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(join(artifactsDir, "result.json"), RESULT);
      await new Promise((resolve) => setTimeout(resolve, 60));
      options.onOutput?.("stdout", `${STDOUT.join("\n")}\n`);
      return ok(`${STDOUT.join("\n")}\n`);
    }
    if (command === "ps") return ok("");
    return ok();
  },
};

const scratch = await mkdtemp(join(tmpdir(), "dejaml-fixture-"));
try {
  const caseRoot = join(scratch, "case");
  await mkdir(join(caseRoot, "data"), { recursive: true });
  const runner = await readFile(join(root, policy.trustedExecutionAdapter.path));
  await writeFile(join(caseRoot, "runner.py"), runner);
  for (const path of policy.dataset.expectedPaths) await writeFile(join(caseRoot, path), "placeholder\n");

  const generated = [];
  const sink = (event) => generated.push(event);
  const manager = new LabManager({ runtime, labRoot: join(scratch, "labs"), events: sink, now });
  const plan = {
    caseId: policy.caseId,
    repository: { url: policy.repository.url, commitSha: policy.repository.commitSha },
    claim: {
      experimentLabel: "Random Forest on UCI Urban Land Cover",
      dataset: policy.claim.dataset,
      split: "official test set",
      model: policy.claim.model,
      metric: { name: "accuracy", unit: "percent", reportedValue: policy.claim.reportedValue },
      seed: null,
      hyperparameters: {},
      evidence: [{ kind: "paper_page", reference: "page 4, Table 2", excerpt: "Random Forest — Test Acc. 81.66" }],
      missingFields: ["validation split seed"],
      confidence: "high",
    },
    dataset: policy.dataset,
    preparation: [],
    executionAdapter: policy.trustedExecutionAdapter,
    command: policy.command,
    resources: policy.maximumResources,
    metricExtraction: policy.metricExtraction,
    maxAttempts: 1,
    stopConditions: policy.requiredStopConditions,
  };
  const spec = {
    runId,
    image: "dejaml/python-cpu:0.1.0",
    expectedImageId: IMAGE_ID,
    workdir: "/workspace/case",
    artifactsDir: "artifacts",
    inputs: [
      { hostPath: join(caseRoot, "runner.py"), containerPath: "runner.py", sha256: createHash("sha256").update(runner).digest("hex") },
      ...policy.dataset.expectedPaths.map((path) => ({ hostPath: join(caseRoot, path), containerPath: path })),
    ],
    resources: policy.maximumResources,
    limits: DEFAULT_LAB_LIMITS,
  };
  await manager.withLab(spec, async (lab) => {
    const outcome = await manager.executeAttempt(lab.labId, {
      number: 1,
      label: "baseline",
      command: policy.command,
      observe: { flushIntervalMs: 50, telemetryIntervalMs: 900, artifactIntervalMs: 30 },
    });
    const artifact = await manager.readArtifact(lab.labId, "artifacts/result.json");
    verifyResult({
      runId,
      plan,
      attempt: outcome.attempt,
      artifact,
      tolerance: caseManifest.comparison.tolerance,
      knownDiscrepancies: caseManifest.knownDiscrepancies,
      events: sink,
    });
  });

  // Keep the lab ID and host paths out of the public fixture.
  const stable = JSON.parse(
    JSON.stringify(generated)
      .replace(/lab_[a-f0-9]{32}/gu, "lab_demo")
      .replace(/dejaml-lab-[a-f0-9]{32}/gu, "dejaml-lab-demo"),
  );
  let sequence = research.length;
  let time = Date.parse(research.at(-1).timestamp);
  const events = [
    ...research,
    ...stable.map((event) => {
      sequence += 1;
      time += 200;
      return RunEventSchema.parse({
        ...event,
        id: `evt_${String(sequence).padStart(3, "0")}`,
        sequence,
        timestamp: new Date(time).toISOString(),
      });
    }),
  ];
  await writeFile(fixturePath, `${JSON.stringify(events, null, 2)}\n`);
  process.stdout.write(`${events.map((event) => `${event.sequence} ${event.actor} ${event.type} ${event.status}: ${event.summary}`).join("\n")}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
