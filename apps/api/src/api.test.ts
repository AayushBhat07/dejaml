import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlatformSpec, RunEventSchema, type ExperimentPlan, type RunEvent } from "@dejaml/contracts";
import { LabManager } from "@dejaml/lab-manager";
import { RunStore } from "@dejaml/run-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkDemoAcceptance } from "./acceptance.js";
import { loadCases, type CuratedCase } from "./cases.js";
import type { StudyReport } from "./pipeline.js";
import { loadProviderConfig } from "@dejaml/agent-runtime";

import { DEFAULT_STUDY_RESOURCES } from "./pipeline.js";
import { createApiServer, recoverAfterRestart, type ApiServer } from "./server.js";
import { fixedLabImagePort } from "./study/index.js";
import { paperPdf, ScriptedModel, ScriptedRuntime, ScriptedStudyProvider, STAND_IN_IMAGE_ID, standInAcquire } from "./stand-ins.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
let work: string;
let store: RunStore;
let runtime: ScriptedRuntime;
let api: ApiServer;
let serverStarted = false;
let base: string;
let checkoutsCreated: string[];
let curated: CuratedCase;
let selections: Array<{ providerId: string; model: string }>;
let studyProvider: ScriptedStudyProvider;

async function startServer(
  options: {
    timeoutSeconds?: number;
    editPlan?: (plan: ExperimentPlan) => ExperimentPlan;
    commitSha?: string;
    labAgentEnabled?: boolean;
    labActionOverride?: (state: string, action: string) => string;
    autonomous?: boolean;
    repositoryUrl?: string;
    /** Independent Lab Engineers per round in autonomous studies. */
    engineers?: number;
    /** Provider settings as the server's environment would carry them. */
    providerEnv?: Record<string, string>;
  } = {},
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
  const model = new ScriptedModel(cases[0]!, options.timeoutSeconds ?? 120, 0, options.editPlan, options.labActionOverride);
  model.repositoryUrl = options.repositoryUrl ?? null;
  selections = [];
  studyProvider = new ScriptedStudyProvider(options.repositoryUrl ?? curated.policy.repository.url);
  api = createApiServer({
    store,
    labs,
    providers: loadProviderConfig(
      options.providerEnv ?? { DEJAML_OPENAI_API_KEY: "sk-server-test-key-0001", DEJAML_OPENAI_MODELS: "default-model" },
    ),
    providerFactory: (providerId, modelName) => {
      selections.push({ providerId, model: modelName });
      return studyProvider;
    },
    structuredModel: () => model,
    cases,
    projectRoot,
    workRoot: join(work, "data"),
    image: { name: "dejaml/python-cpu:0.1.0", expectedImageId: STAND_IN_IMAGE_ID },
    acquire: standInAcquire(cases[0]!, checkoutsCreated, options.commitSha),
    ...(options.labAgentEnabled ? { labAgentEnabled: true } : {}),
    ...(options.autonomous
      ? {
          multiAgent: {
            enabled: true,
            dependencies: null,
            images: fixedLabImagePort({ name: "dejaml/python-cpu:0.1.0", expectedImageId: STAND_IN_IMAGE_ID }),
            datasets: null,
            config: {
              platform: buildPlatformSpec({ architecture: "amd64", python: "3.11" }),
              resources: DEFAULT_STUDY_RESOURCES,
              engineers: options.engineers ?? 1,
              datasetPolicy: { allowedHosts: [], maxRedirects: 3, maxBytes: 1024, timeoutMs: 1000 } as never,
              maxStudyMs: 60_000,
              commandTimeoutSeconds: 60,
              maxReplans: 2,
              trustedConstraints: [],
            },
            leakCheck: async () => ({ containers: [...runtime.containers], networks: [] }),
          },
        }
      : {}),
  });
  await mkdir(join(work, "data"), { recursive: true });
  await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  serverStarted = true;
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
}

async function upload(
  data: Uint8Array | string,
  name = "paper.pdf",
  fields: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  form.append("paper", new Blob([typeof data === "string" ? data : new Uint8Array(data)]), name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
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

  it("lets a bounded Lab Agent call real lab tools and records each decision", async () => {
    await startServer({ labAgentEnabled: true });
    const { runId } = (await (await upload(await paperPdf())).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.status).toBe("completed");
    expect(report.metric?.value).toBe(79.88);
    expect(report.lab?.cleanup?.verifiedAbsent).toBe(true);
    expect(runtime.containers.size).toBe(0);
    expect(report.events.filter((event) => event.type === "lab_agent_action").map((event) => event.publicPayload.action))
      .toEqual(["request_lab", "run_approved_experiment", "inspect_result", "finish"]);
    expect(report.events.some((event) => event.type === "lab_agent_finished")).toBe(true);
  });

  it("rejects an out-of-order Lab Agent action and removes the created lab", async () => {
    await startServer({
      labAgentEnabled: true,
      labActionOverride: (state, action) => state === "ready" ? "finish" : action,
    });
    const { runId } = (await (await upload(await paperPdf())).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.status).toBe("failed");
    expect(report.events.some((event) => event.type === "lab_agent_rejected")).toBe(true);
    expect(report.events.some((event) => event.type === "lab_cleanup")).toBe(true);
    expect(runtime.containers.size).toBe(0);
  });

  it("runs a paper with no reviewed case through the stage machine with separate, independent agents", async () => {
    await startServer({ autonomous: true, engineers: 2, repositoryUrl: "https://github.com/example/new-paper" });
    const { runId } = (await (await upload(await paperPdf(true, "https://github.com/example/new-paper"))).json()) as {
      runId: string;
    };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    const study = report.study!;
    expect(report.status).toBe("completed");
    expect(report.caseId).toBeNull();
    expect(report.repository?.url).toBe("https://github.com/example/new-paper");

    // Every role ran as its own agent instance with its own id, grants, and history.
    const roles = study.agents.map((agent) => agent.role).sort();
    expect(roles).toEqual([
      "independent_reviewer", "independent_reviewer", "lab_engineer", "lab_engineer",
      "paper_analyst", "repository_analyst", "reproduction_planner", "supervisor",
    ]);
    expect(new Set(study.agents.map((agent) => agent.agentId)).size).toBe(study.agents.length);
    expect(study.agents.every((agent) => agent.status === "completed")).toBe(true);
    expect(study.agents.find((agent) => agent.role === "independent_reviewer")?.grants).not.toContain("lab_run");
    expect(study.agents.find((agent) => agent.role === "supervisor")?.grants).toEqual(["board_read"]);
    const conversations = study.agents.map((agent) => store.ledger.listTurns(agent.agentId));
    expect(conversations.every((turns) => turns.length > 0)).toBe(true);
    const firstMessages = conversations.map((turns) => JSON.stringify(turns[0]));
    expect(new Set(firstMessages).size).toBe(firstMessages.length);

    // Code owns every stage, in order, each run once.
    expect(study.stages.map((stage) => [stage.stage, stage.status, stage.attempt])).toEqual([
      ["ingesting", "completed", 1],
      ["analyzing_paper", "completed", 1],
      ["analyzing_repository", "completed", 1],
      ["reconciling", "completed", 1],
      ["policy_review", "completed", 1],
      ["preparing", "completed", 1],
      ["executing", "completed", 1],
      ["reviewing", "completed", 1],
      ["deciding", "completed", 1],
    ]);
    expect(study.transitions.at(-1)).toMatchObject({ stage: "completed", to: "completed", reason: "reproduced" });

    // One bounded claim, approved by policy, run exactly, metric parsed by code, reviewed.
    expect(study.contract).toMatchObject({ entrypoint: "train.py", command: { argv: ["python", "train.py"], cwd: "work/repo" }, reportedValue: 81.66, tolerance: 2 });
    expect(study.planDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(study.policy).toMatchObject({ outcome: "approved", violations: [] });
    expect(study.engineers.map((item) => [item.label, item.official?.exitCode, item.metric?.ok, item.value, item.review?.verdict])).toEqual([
      ["engineer-1", 0, true, 79.88, "approve"],
      ["engineer-2", 0, true, 79.88, "approve"],
    ]);
    expect(study.result).toMatchObject({ status: "reproduced", computedStatus: "reproduced", paperValue: 81.66, observedValue: 79.88, tolerance: 2 });
    expect(study.result.absoluteDifference).toBeCloseTo(1.78);
    expect(study.board.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      "paper_claim", "repository_receipt", "repository_mapping", "plan", "claim_contract", "command_receipt", "metric", "artifact", "submission", "review", "status_decision", "stage",
    ]));
    // The official run went through lab_run_official; nothing typed the number.
    const official = study.board.filter((entry) => entry.kind === "command_receipt" && entry.payload.official === true);
    expect(official).toHaveLength(2);
    expect(official[0]?.payload.argv).toEqual(["/workspace/case/work/.venv/bin/python", "train.py"]);
    expect(report.metric?.value).toBe(79.88);
    expect(report.assessment?.verdict).toBe("reproduced_within_tolerance");

    // The Reviewer never saw the Engineer's own words.
    const reviewer = study.agents.find((agent) => agent.role === "independent_reviewer")!;
    expect(JSON.stringify(store.ledger.listTurns(reviewer.agentId))).not.toContain("PRIVATE-ENGINEER-NOTE");

    // Labs: one per engineer, offline, repository read-only; all destroyed and verified.
    expect(report.events.filter((event) => event.type === "lab_create" && event.status === "completed")).toHaveLength(2);
    const create = runtime.createArgs;
    expect(create).toContain("none");
    expect(create.some((arg) => arg.endsWith("dst=/workspace/case/repo,readonly"))).toBe(true);
    expect(study.cleanup).toMatchObject({ verified: true, workDirRemoved: true, leftoverContainers: [], liveAgents: [] });
    expect(study.cleanup.labs).toHaveLength(2);
    expect(runtime.containers.size).toBe(0);
    expect(checkoutsCreated).toHaveLength(1);
    expect(selections).toEqual([{ providerId: "openai", model: "default-model" }]);
    const persisted = [JSON.stringify(report), JSON.stringify(store.ledger.listAgents(runId)), JSON.stringify(store.ledger.listReceipts({ runId }))].join("\n");
    expect(persisted).not.toContain("sk-server-test-key-0001");
  });

  it("recovers from a failed official run with a separate Debugger agent", async () => {
    await startServer({ autonomous: true, repositoryUrl: "https://github.com/example/new-paper" });
    runtime.failFirstRun = true;
    const { runId } = (await (await upload(await paperPdf(true, "https://github.com/example/new-paper"))).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    const study = report.study!;
    const debuggers = study.agents.filter((agent) => agent.role === "debugger");
    expect(debuggers).toHaveLength(1);
    const engineer = study.agents.find((agent) => agent.role === "lab_engineer")!;
    expect(debuggers[0]?.parentId).toBe(engineer.agentId);
    expect(study.board.filter((entry) => entry.kind === "diagnosis")).toHaveLength(1);
    expect(study.receipts.filter((receipt) => receipt.tool === "lab_run_official").map((receipt) => receipt.status)).toEqual(["error", "ok"]);
    expect(study.result.status).toBe("reproduced");
    expect(runtime.containers.size).toBe(0);
  });

  it("refuses to run the approved command after the prepared environment changed", async () => {
    await startServer({ autonomous: true, repositoryUrl: "https://github.com/example/new-paper" });
    studyProvider.tamper = true;
    const { runId } = (await (await upload(await paperPdf(true, "https://github.com/example/new-paper"))).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.study?.receipts.filter((receipt) => receipt.tool === "lab_run_official").map((receipt) => receipt.status)).toEqual(["denied"]);
    expect(report.study?.result.status).toBe("inconclusive");
    expect(report.metric).toBeNull();
    expect(runtime.containers.size).toBe(0);
  });

  it("ends policy_blocked before any lab when the plan needs a GPU package", async () => {
    await startServer({ autonomous: true, repositoryUrl: "https://github.com/example/new-paper" });
    studyProvider.plan = { requirements: ["torch==2.4.0"] };
    const { runId } = (await (await upload(await paperPdf(true, "https://github.com/example/new-paper"))).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.study?.result.status).toBe("policy_blocked");
    expect(report.status).toBe("inconclusive");
    expect(report.events.some((event) => event.type === "lab_create")).toBe(false);
    expect(report.study?.stages.find((stage) => stage.stage === "executing")?.status).toBe("skipped");
  });

  it("ends inconclusive when the Independent Reviewers reject the measurement, and the Supervisor cannot raise it", async () => {
    await startServer({ autonomous: true, repositoryUrl: "https://github.com/example/new-paper" });
    studyProvider.review = { verdict: "reject", equivalence: "not_equivalent" };
    studyProvider.supervisorProposal = "reproduced";
    const { runId } = (await (await upload(await paperPdf(true, "https://github.com/example/new-paper"))).json()) as {
      runId: string;
    };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.status).toBe("inconclusive");
    expect(report.study?.result.status).toBe("inconclusive");
    expect(report.study?.result.supervisor).toMatchObject({ proposedStatus: "reproduced", applied: false });
    expect(report.study?.result.reasons.join(" ")).toMatch(/rejected by the Independent Reviewer/u);
    expect(report.metric).toBeNull();
    expect(runtime.containers.size).toBe(0);
  });

  it("lets the Supervisor lower a reproduced result", async () => {
    await startServer({ autonomous: true, repositoryUrl: "https://github.com/example/new-paper" });
    studyProvider.supervisorProposal = "partially_reproduced";
    const { runId } = (await (await upload(await paperPdf(true, "https://github.com/example/new-paper"))).json()) as { runId: string };
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.study?.result).toMatchObject({ status: "partially_reproduced", computedStatus: "reproduced", supervisor: { applied: true } });
  });

  it("cancels a multi-agent study mid-run and cleans up every agent and lab", async () => {
    await startServer({ autonomous: true, repositoryUrl: "https://github.com/example/new-paper" });
    studyProvider.delayMs = 40;
    const { runId } = (await (await upload(await paperPdf(true, "https://github.com/example/new-paper"))).json()) as { runId: string };
    // Cancel while an Engineer is mid-loop inside its lab, so a live agent must be stopped.
    while (
      !store.listEvents(runId).some((event) => event.type === "lab_create" && event.status === "completed") ||
      !store.ledger.listAgents(runId).some((agent) => agent.role === "lab_engineer" && agent.status === "running")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await fetch(`${base}/api/runs/${runId}/cancel`, { method: "POST" })).status).toBe(202);
    await api.idle();
    const report = (await (await fetch(`${base}/api/runs/${runId}/report`)).json()) as StudyReport;
    expect(report.status).toBe("cancelled");
    expect(report.study?.result.status).toBe("cancelled");
    expect(store.stages.state(runId)?.terminal).toBe("cancelled");
    expect(report.study?.agents.some((agent) => agent.status === "cancelled")).toBe(true);
    expect(report.study?.agents.every((agent) => !["created", "running", "waiting"].includes(agent.status))).toBe(true);
    expect(report.study?.cleanup.verified).toBe(true);
    expect(runtime.containers.size).toBe(0);
  });

  it("keeps unsupported papers inconclusive when autonomy is off", async () => {
    await startServer();
    const { runId } = (await (await upload(await paperPdf(true, "https://github.com/example/new-paper"))).json()) as {
      runId: string;
    };
    await api.idle();
    expect(store.getRun(runId).status).toBe("inconclusive");
    expect(checkoutsCreated).toHaveLength(0);
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

  it("serves internal health diagnostics to loopback clients without secrets", async () => {
    await startServer();
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|authorization|sk-/iu);
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
    const agent = recoveryStore.ledger.createAgent({ runId: run.id, role: "lab_engineer", parentId: null, provider: "p", model: "m", task: {}, grants: [], limits: {} });
    recoveryStore.ledger.updateAgent(agent.id, { status: "running" });
    await mkdir(join(work, "data/study-abc"), { recursive: true });
    const orphanRuntime = new ScriptedRuntime();
    orphanRuntime.containers.add("dejaml-lab-orphan");
    const labs = new LabManager({ runtime: orphanRuntime, labRoot: join(work, "labs") });

    await mkdir(join(work, "data/checkouts-abc123/dejaml-repo-x"), { recursive: true });
    await mkdir(join(work, "data/reports"), { recursive: true });

    const result = await recoverAfterRestart({ store: recoveryStore, labs, workRoot: join(work, "data") });
    expect(result).toEqual({ interruptedRuns: ["run_interrupted"], resumableRuns: [], orphanLabs: 1, staleCheckouts: 2 });
    expect(recoveryStore.ledger.getAgent(agent.id)).toMatchObject({ status: "interrupted", failure: "the service restarted" });
    await expect(readdir(join(work, "data"))).resolves.toEqual(["reports"]);
    expect(orphanRuntime.containers.size).toBe(0);
    expect(recoveryStore.getRun(run.id).status).toBe("failed");
    expect(recoveryStore.listEvents(run.id).at(-1)?.type).toBe("run_interrupted");
    recoveryStore.close();
  });
});
