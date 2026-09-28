import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RunEventSchema, type ExperimentPlan, type RunEvent } from "@dejaml/contracts";
import { LabManager } from "@dejaml/lab-manager";
import { RunStore } from "@dejaml/run-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkDemoAcceptance } from "./acceptance.js";
import { loadCases, type CuratedCase } from "./cases.js";
import type { StudyReport } from "./pipeline.js";
import { createApiServer, recoverAfterRestart, type ApiServer } from "./server.js";
import { paperPdf, ScriptedModel, ScriptedRuntime, STAND_IN_IMAGE_ID, standInAcquire } from "./stand-ins.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
let work: string;
let store: RunStore;
let runtime: ScriptedRuntime;
let api: ApiServer;
let serverStarted = false;
let base: string;
let checkoutsCreated: string[];
let curated: CuratedCase;

async function startServer(
  options: { timeoutSeconds?: number; editPlan?: (plan: ExperimentPlan) => ExperimentPlan; commitSha?: string } = {},
): Promise<void> {
  // A private project root holding the reviewed adapter and placeholder data files.
  const projectRoot = join(work, "project");
  const caseDir = join(projectRoot, "cases/urban-land-cover");
  await mkdir(join(caseDir, "data"), { recursive: true });
  for (const name of ["policy.json", "case.json", "runner.py"]) {
    await copyFile(join(repoRoot, "cases/urban-land-cover", name), join(caseDir, name));
  }
  await writeFile(join(caseDir, "data/training.csv"), "placeholder\n");
  await writeFile(join(caseDir, "data/testing.csv"), "placeholder\n");
  const cases = await loadCases(projectRoot);
  curated = cases[0]!;

  store = new RunStore();
  runtime = new ScriptedRuntime();
  const labs = new LabManager({ runtime, labRoot: join(work, "labs"), events: (event) => store.appendEvent(event) });
  api = createApiServer({
    store,
    labs,
    model: new ScriptedModel(cases[0]!, options.timeoutSeconds ?? 120, 0, options.editPlan),
    cases,
    projectRoot,
    workRoot: join(work, "data"),
    image: { name: "dejaml/python-cpu:0.1.0", expectedImageId: STAND_IN_IMAGE_ID },
    acquire: standInAcquire(cases[0]!, checkoutsCreated, options.commitSha),
  });
  await mkdir(join(work, "data"), { recursive: true });
  await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  serverStarted = true;
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
}

async function upload(data: Uint8Array | string, name = "paper.pdf"): Promise<Response> {
  const form = new FormData();
  form.append("paper", new Blob([typeof data === "string" ? data : new Uint8Array(data)]), name);
  return fetch(`${base}/api/runs`, { method: "POST", body: form });
}

/** Reads the SSE stream until the study finishes. */
async function collectEvents(runId: string, after = 0): Promise<RunEvent[]> {
  const response = await fetch(`${base}/api/runs/${runId}/events?after=${after}`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: RunEvent[] = [];
  let buffer = "";
  while (!events.some((event) => event.type === "run_finished")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data) events.push(RunEventSchema.parse(JSON.parse(data.slice(6))));
    }
  }
  await reader.cancel();
  return events;
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "dejaml-api-test-"));
  checkoutsCreated = [];
});

afterEach(async () => {
  if (serverStarted) {
    await api.close();
    store.close();
    serverStarted = false;
  }
  await rm(work, { recursive: true, force: true });
});

describe("Run API", () => {
  it("runs an uploaded paper end to end and serves events, snapshot, and report", async () => {
    await startServer();
    const response = await upload(await paperPdf());
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };

    const events = await collectEvents(runId);
    await api.idle();
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    const types = events.map((event) => `${event.actor}:${event.type}`);
    for (const expected of [
      "system:run_created",
      "system:repository_found",
      "paper_analyst:analysis_started",
      "code_analyst:analysis_completed",
      "lead_researcher:reconciliation_completed",
      "system:plan_policy_completed",
      "lab_engineer:lab_create",
      "lab_engineer:lab_output",
      "result_verifier:comparison_completed",
      "audit_agent:audit_completed",
      "lab_engineer:lab_cleanup",
      "system:run_finished",
    ]) {
      expect(types).toContain(expected);
    }
    expect(types.indexOf("lab_engineer:lab_cleanup")).toBeGreaterThan(types.indexOf("result_verifier:comparison_completed"));

    const snapshot = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as { status: string };
    expect(snapshot.status).toBe("completed");
    const reportResponse = await fetch(`${base}/api/runs/${runId}/report`);
    expect(reportResponse.headers.get("content-disposition")).toContain(`dejaml-report-${runId}.json`);
    const report = (await reportResponse.json()) as StudyReport;
    expect(report).toMatchObject({
      status: "completed",
      caseId: "urban-land-cover-random-forest",
      policy: { approved: true },
      metric: { value: 79.88 },
      assessment: { verdict: "different_result", signedDifference: -1.78 },
      audit: { verdict: "confirmed", metricAligned: true },
      lab: { attempt: { exitCode: 0 }, cleanup: { verifiedAbsent: true, artifactDirectoryRemoved: true } },
      failure: null,
    });
    expect(runtime.containers.size).toBe(0);
    expect(checkoutsCreated).toHaveLength(1);
    await expect(readdir(join(work, "data"))).resolves.toEqual(["reports"]);

    // The demo acceptance test passes, but only counts as a real run for the expected image.
    const acceptance = checkDemoAcceptance(report, curated, { expectedImageId: STAND_IN_IMAGE_ID });
    expect(acceptance.checks.filter((check) => !check.passed)).toEqual([]);
    expect(acceptance).toMatchObject({ passed: true, realRun: true });
    expect(acceptance.checks.map((check) => check.name)).toContain("matches_rehearsal_baseline");
    expect(checkDemoAcceptance(report, curated).realRun).toBe(false);

    // Refresh-safe replay from a later sequence.
    const resumed = await collectEvents(runId, events.length - 3);
    expect(resumed.map((event) => event.sequence)).toEqual([events.length - 2, events.length - 1, events.length]);
  });

  it("ends as inconclusive without a lab when the paper links no supported repository", async () => {
    await startServer();
    const { runId } = (await (await upload(await paperPdf(false))).json()) as { runId: string };
    const events = await collectEvents(runId);
    await api.idle();
    expect(events.find((event) => event.type === "repository_unsupported")?.summary).toBe(
      "No GitHub repository link was found in the paper",
    );
    expect(events.some((event) => event.actor === "lab_engineer")).toBe(false);
    expect(store.getRun(runId).status).toBe("inconclusive");
    expect(checkoutsCreated).toHaveLength(0);
  });

  it("cancels a running attempt and still destroys the lab", async () => {
    await startServer();
    runtime.mode = "hang";
    const started = new Promise<void>((resolve) => {
      runtime.execStarted = resolve;
    });
    const { runId } = (await (await upload(await paperPdf())).json()) as { runId: string };
    await started;
    expect((await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" })).status).toBe(202);
    await api.idle();

    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.status).toBe("cancelled");
    expect(report.lab?.attempt).toMatchObject({ cancelled: true });
    const failed = checkDemoAcceptance(report, curated).checks.filter((check) => !check.passed).map((check) => check.name);
    expect(failed).toEqual(expect.arrayContaining(["isolated_experiment", "metric_parsed", "comparison", "report_complete"]));
    expect(report.lab?.cleanup?.verifiedAbsent).toBe(true);
    expect(report.assessment).toBeNull();
    expect(runtime.containers.size).toBe(0);
    expect((await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" })).status).toBe(409);
  });

  it("stops an attempt at the plan's wall-time limit", async () => {
    await startServer({ timeoutSeconds: 1 });
    runtime.mode = "hang";
    const { runId } = (await (await upload(await paperPdf())).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.status).toBe("timed_out");
    expect(report.lab?.attempt).toMatchObject({ timedOut: true, exitCode: null });
    expect(report.lab?.cleanup?.verifiedAbsent).toBe(true);
  });

  it("ends as inconclusive when the attempt writes no metric, and still removes the lab", async () => {
    await startServer();
    runtime.mode = "no_metric";
    const { runId } = (await (await upload(await paperPdf())).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.status).toBe("inconclusive");
    expect(report.metric).toBeNull();
    expect(report.assessment).toMatchObject({ verdict: "inconclusive", observedValue: null });
    expect(report.events.find((event) => event.type === "metric_extracted")?.status).toBe("failed");
    expect(report.lab?.cleanup?.verifiedAbsent).toBe(true);
    expect(runtime.containers.size).toBe(0);
  });

  it("ends as inconclusive when the attempt exits non-zero", async () => {
    await startServer();
    runtime.mode = "crash";
    const { runId } = (await (await upload(await paperPdf())).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.status).toBe("inconclusive");
    expect(report.lab?.attempt?.exitCode).toBe(3);
    expect(report.lab?.stderr).toContain("KeyError");
    expect(report.assessment?.checks.find((check) => check.name === "attempt_completed")?.passed).toBe(false);
    expect(report.lab?.cleanup?.verifiedAbsent).toBe(true);
  });

  it("stops before any lab when the repository moved past the reviewed commit", async () => {
    await startServer({ commitSha: "f".repeat(40) });
    const { runId } = (await (await upload(await paperPdf())).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.status).toBe("inconclusive");
    expect(report.failure).toBe("repository commit mismatch");
    expect(report.lab).toBeNull();
    expect(report.events.some((event) => event.actor === "lab_engineer")).toBe(false);
    expect(checkoutsCreated).toHaveLength(1);
    await expect(readdir(join(work, "data"))).resolves.toEqual(["reports"]);
  });

  it("stops before any lab when the plan exceeds the reviewed policy", async () => {
    await startServer({
      editPlan: (plan) => ({ ...plan, command: { ...plan.command, args: [...plan.command.args, "--download"] } }),
    });
    const { runId } = (await (await upload(await paperPdf())).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.policy?.approved).toBe(false);
    expect(report.failure).toBe("plan rejected by policy");
    expect(report.lab).toBeNull();
    expect(runtime.containers.size).toBe(0);
    expect(report.status).toBe("inconclusive");
  });

  it("rejects bad uploads, a second concurrent study, and unknown runs", async () => {
    await startServer();
    expect((await upload("hello", "notes.txt")).status).toBe(202); // accepted, then rejected by intake
    await api.idle();
    const wrongType = await fetch(`${base}/api/runs`, { method: "POST", body: "x", headers: { "content-type": "text/plain" } });
    expect(wrongType.status).toBe(415);
    const tooLarge = await upload(new Uint8Array(21 * 1024 * 1024));
    expect(tooLarge.status).toBe(413);

    runtime.mode = "hang";
    const first = (await (await upload(await paperPdf())).json()) as { runId: string };
    expect((await upload(await paperPdf())).status).toBe(409);
    await fetch(`${base}/api/runs/${first.runId}/cancel`, { method: "POST" });
    await api.idle();

    expect((await fetch(`${base}/api/runs/run_00000000-0000-0000-0000-000000000000`)).status).toBe(404);
    expect((await fetch(`${base}/api/runs/../../etc/passwd`)).status).toBe(404);
  });
});

describe("restart recovery", () => {
  it("marks interrupted runs failed and removes orphan labs and stale checkouts", async () => {
    const recoveryStore = new RunStore();
    const run = recoveryStore.createRun({}, "run_interrupted");
    recoveryStore.transitionRun(run.id, "ingesting");
    const orphanRuntime = new ScriptedRuntime();
    orphanRuntime.containers.add("dejaml-lab-orphan");
    const labs = new LabManager({ runtime: orphanRuntime, labRoot: join(work, "labs") });

    await mkdir(join(work, "data/checkouts-abc123/dejaml-repo-x"), { recursive: true });
    await mkdir(join(work, "data/reports"), { recursive: true });

    const result = await recoverAfterRestart({ store: recoveryStore, labs, workRoot: join(work, "data") });
    expect(result).toEqual({ interruptedRuns: ["run_interrupted"], orphanLabs: 1, staleCheckouts: 1 });
    await expect(readdir(join(work, "data"))).resolves.toEqual(["reports"]);
    expect(orphanRuntime.containers.size).toBe(0);
    expect(recoveryStore.getRun(run.id).status).toBe("failed");
    expect(recoveryStore.listEvents(run.id).at(-1)?.type).toBe("run_interrupted");
    recoveryStore.close();
  });
});
