// Runs the curated Urban Land Cover experiment through the Lab Manager using
// the pinned dejaml/python-cpu image and the policy-approved plan.
// Requires: `npm run verify:lab-image` (builds the image) and the fetched dataset.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ExperimentPolicySchema } from "@dejaml/contracts";
import { RunStore } from "@dejaml/run-store";

import { LabManager, labSpecFromPlan } from "../dist/index.js";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const policy = ExperimentPolicySchema.parse(
  JSON.parse(await readFile(new URL("cases/urban-land-cover/policy.json", `file://${projectRoot}`), "utf8")),
);
const imageLock = JSON.parse(
  await readFile(new URL("lab-images/python-cpu/image-lock.json", `file://${projectRoot}`), "utf8"),
);
// The lock records the image ID verified on its build platform. Another
// platform produces a different ID; override only after rebuilding locally.
const expectedImageId = process.env.DEJAML_EXPECTED_IMAGE_ID ?? imageLock.verifiedImageId;

const plan = {
  caseId: policy.caseId,
  repository: { url: policy.repository.url, commitSha: policy.repository.commitSha },
  claim: {
    experimentLabel: "Random Forest on UCI Urban Land Cover",
    dataset: policy.claim.dataset,
    split: "official test set",
    model: policy.claim.model,
    metric: { name: "accuracy", unit: policy.claim.unit, reportedValue: policy.claim.reportedValue },
    seed: 42,
    hyperparameters: {},
    evidence: [{ kind: "paper_page", reference: "curated case manifest" }],
    missingFields: [],
    confidence: "high",
  },
  dataset: policy.dataset,
  preparation: policy.preparation,
  executionAdapter: policy.trustedExecutionAdapter,
  command: policy.command,
  resources: policy.maximumResources,
  metricExtraction: policy.metricExtraction,
  maxAttempts: policy.maximumAttempts,
  stopConditions: policy.requiredStopConditions,
};

const store = new RunStore();
try {
  const run = store.createRun({ caseId: policy.caseId });
  const manager = new LabManager({ events: (event) => store.appendEvent(event) });
  const spec = labSpecFromPlan({
    plan,
    runId: run.id,
    projectRoot,
    image: imageLock.image,
    expectedImageId,
  });
  const { value, receipt } = await manager.withLab(spec, async (lab) => {
    await manager.prepareLab(lab.labId, plan.preparation);
    const outcome = await manager.executeAttempt(lab.labId, {
      number: 1,
      label: "baseline",
      command: plan.command,
    });
    if (outcome.attempt.exitCode !== 0) {
      throw new Error(`attempt failed: ${outcome.stderr.text.slice(-2000)}`);
    }
    const artifact = await manager.readArtifact(lab.labId, plan.metricExtraction.path);
    return { outcome, result: JSON.parse(artifact.content.toString("utf8")), sha256: artifact.sha256 };
  });

  if (value.result.metrics?.accuracyPercent !== 79.88) {
    throw new Error(`unexpected accuracy: ${String(value.result.metrics?.accuracyPercent)}`);
  }
  if (!receipt.verifiedAbsent || !receipt.artifactDirectoryRemoved) {
    throw new Error(`cleanup not verified: ${JSON.stringify(receipt)}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        image: imageLock.image,
        imageId: expectedImageId,
        accuracyPercent: value.result.metrics.accuracyPercent,
        exitCode: value.outcome.attempt.exitCode,
        durationMs: value.outcome.durationMs,
        artifactDigests: value.outcome.attempt.artifactDigests,
        receipt,
        events: store.listEvents(run.id).map((event) => `${event.sequence} ${event.type} ${event.status}`),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  store.close();
}
