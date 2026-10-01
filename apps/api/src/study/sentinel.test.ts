import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatProvider, ChatRequest, ChatResponse, ToolCall } from "@dejaml/agent-runtime";
import { buildPlatformSpec, type PaperDocument } from "@dejaml/contracts";
import { LabManager } from "@dejaml/lab-manager";
import { buildRepositoryManifest, type RepositoryReceipt } from "@dejaml/repository-intake";
import { BlindingOrderError, RunStore } from "@dejaml/run-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_STUDY_RESOURCES } from "../pipeline.js";
import { ScriptedRuntime, STAND_IN_IMAGE_ID } from "../stand-ins.js";
import { valueForms } from "./blinding.js";
import { proveBlinding } from "./blinding-proof.js";
import { fixedLabImagePort } from "./ports.js";
import { type MultiAgentResult, runMultiAgentStudy } from "./study.js";
import { type ClaimTarget, loadClaimTarget } from "./targets.js";

/**
 * End-to-end leakage tests. A study runs with the real runtime, tools, board,
 * ledger, policy, Lab Manager and verdict code; only the model and Docker are
 * stand-ins. The paper's value is a sentinel that no honest text contains, so
 * finding any of its written forms anywhere an execution agent, the browser,
 * or a pre-reveal report can see is a leak.
 */

const SENTINEL = 0.3141592653589793;
const REPO = "https://github.com/example/sentinel-paper";
const COMMIT = "9".repeat(40);
const PAGE_TEXT = `Table 2: BOSS accuracy of ${SENTINEL} on the GunPoint test set.`;
const FORMS = [...new Set([...valueForms(SENTINEL, "fraction"), "0.3141592653589793", "31.41592653589793", "3141592653589793"])];

function leaks(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return FORMS.filter((form) => new RegExp(`(?<![0-9.])${form.replace(/\./gu, "\\.")}(?![0-9]|\\.[0-9])`, "u").test(text));
}

type Mode = "honest" | "planner_states_value" | "cancel_at_review";
type Recorded = { role: string; request: ChatRequest };

/** Plays every role, including blind agents that try to reach the target. Never a model. */
class SentinelProvider implements ChatProvider {
  readonly id = "scripted";
  readonly kind = "scripted" as const;
  readonly requests: Recorded[] = [];
  onReviewer: (() => void) | null = null;
  #counter = 0;

  constructor(private readonly mode: Mode) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const role = /^You are the ([A-Za-z ]+), one independent agent/u.exec(request.system)?.[1] ?? "";
    this.requests.push({ role, request: structuredClone(request) });
    if (role === "Independent Reviewer") this.onReviewer?.();
    if (request.signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    const turn = request.messages.filter((message) => message.role === "assistant").length;
    const tool = request.messages.filter((message) => message.role === "tool").at(-1);
    const last = (): Record<string, unknown> => {
      try {
        return JSON.parse(tool && tool.role === "tool" ? tool.content : "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const first = request.messages[0];
    const inputs =
      first && first.role === "user" ? (JSON.parse(first.content.slice(first.content.indexOf("\n{") + 1)) as Record<string, unknown>) : {};
    const calls = this.#step(role, turn, inputs, last);
    const toolCalls: ToolCall[] = calls.map((call) => ({
      id: `call_${++this.#counter}`,
      name: call.name,
      input: call.input,
      rawInput: JSON.stringify(call.input),
    }));
    return {
      id: `s_${this.#counter}`,
      provider: "scripted",
      model: request.model,
      text: null,
      toolCalls,
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: null,
      attempts: 1,
    };
  }

  #step(
    role: string,
    turn: number,
    inputs: Record<string, unknown>,
    last: () => Record<string, unknown>,
  ): Array<{ name: string; input: unknown }> {
    const finish = (input: unknown) => [{ name: "finish", input }];
    switch (role) {
      case "Paper Analyst":
        if (turn === 0) return [{ name: "paper_read_page", input: { page: 1 } }];
        return finish({
          status: "ready",
          summary: `Table 2 reports BOSS accuracy ${SENTINEL} on GunPoint.`,
          selectedRepositoryUrl: REPO,
          claim: {
            method: "BOSS",
            dataset: "GunPoint",
            split: "official test set",
            preprocessing: "not stated",
            seedPolicy: "not stated",
            metric: { name: "test accuracy", unit: "fraction" },
            reportedValue: SENTINEL,
            page: 1,
            location: "Table 2",
            excerpt: `BOSS accuracy of ${SENTINEL} on the GunPoint`,
            missingFields: [],
          },
          reasons: [],
        });
      case "Repository Analyst":
        if (turn === 0) return [{ name: "repo_acquire", input: { repositoryUrl: REPO } }];
        if (turn === 1) return [{ name: "repo_read", input: { path: "notebooks/eval.ipynb" } }];
        if (turn === 2) return [{ name: "repo_read", input: { path: "README.md" } }];
        // An analyst that somehow learned the number tries to forward it.
        return finish({
          status: "ready",
          summary: `train.py evaluates BOSS; the authors' notebook once printed 31.42 and ${SENTINEL}.`,
          entrypoints: [{ path: "train.py", why: "official evaluation" }],
          dataFiles: [],
          dependencyFiles: [],
          metricSources: [{ path: "train.py", description: "writes artifacts/result.json" }],
          runInstructions: "python train.py",
          warnings: [],
        });
      case "Reproduction Planner":
        // Asking for the paper is denied: the Planner has no paper tools.
        if (turn === 0) return [{ name: "paper_read_page", input: { page: 1 } }];
        if (turn === 1) return [{ name: "board_read", input: {} }];
        if (turn === 2) return [{ name: "repo_read", input: { path: "notebooks/eval.ipynb" } }];
        return finish({
          status: "ready",
          summary:
            this.mode === "planner_states_value"
              ? "Run train.py; the accuracy should be 0.3142 like the paper."
              : "Run train.py unchanged from a writable copy; it writes the test accuracy to artifacts/result.json.",
          blockedReason: null,
          entrypoint: "train.py",
          command: { argv: ["python", "train.py"], cwd: "work/repo" },
          python: "3.11",
          requirements: [],
          compatibilityConstraints: [],
          dataset: { name: "GunPoint", source: { kind: "repository", paths: ["train.py"] } },
          metricParser: { source: "json", path: "artifacts/result.json", key: "metrics.accuracyPercent", unit: "percent" },
          expectedRuntimeSeconds: 30,
          stopConditions: ["the command exits non-zero"],
          adapter: null,
          risks: [],
        });
      case "Lab Engineer": {
        // Reading the paper is denied: Engineers have no paper tools.
        if (turn === 0) return [{ name: "paper_read_page", input: { page: 1 } }];
        if (turn === 1) return [{ name: "board_read", input: {} }];
        if (turn === 2) return [{ name: "lab_run_official", input: {} }];
        const result = last();
        return finish({
          status: "measured",
          summary: "ran the approved command",
          officialReceiptId: typeof result.receiptId === "string" ? result.receiptId : null,
          deviations: [],
          failureReason: null,
        });
      }
      case "Independent Reviewer": {
        const key = String(inputs.submissionKey ?? "");
        // The paper (and its tolerance) is denied before the lock: the Reviewer has no paper tools.
        if (turn === 0) return [{ name: "paper_read_page", input: { page: 1 } }];
        if (turn === 1) return [{ name: "board_read", input: {} }];
        if (turn === 2) return [{ name: "repo_read", input: { path: "notebooks/eval.ipynb" } }];
        if (turn === 3) return [{ name: "artifact_read", input: { engineerAgentId: key, path: "artifacts/result.json" } }];
        return finish({
          equivalence: "partially_equivalent",
          summary: "The approved command ran unchanged and wrote the metric; library versions differ from the authors'.",
          checks: [
            { name: "official command", passed: true, explanation: "exit 0" },
            { name: "metric from the run", passed: true, explanation: "artifact digest matches" },
            { name: "protocol", passed: true, explanation: "same split and metric" },
          ],
          concerns: [],
        });
      }
      case "Supervisor":
        if (inputs.resultKind === "verdict")
          return finish({ proposedStatus: inputs.computedStatus, rationale: "the evidence supports it" });
        return finish({ action: "continue", reason: "none", guidance: "" });
      default:
        return [{ name: "give_up", input: { reason: `unscripted ${role}` } }];
    }
  }
}

let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "dejaml-sentinel-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** A checkout whose notebook output and README carry the paper's number, as many real repositories do. */
function acquire() {
  return async (input: { repositoryUrl: string; destinationRoot: string; commitSha?: string }): Promise<RepositoryReceipt> => {
    await mkdir(input.destinationRoot, { recursive: true });
    const destination = await mkdtemp(join(input.destinationRoot, "repo-"));
    await mkdir(join(destination, "notebooks"));
    await writeFile(
      join(destination, "notebooks/eval.ipynb"),
      JSON.stringify({
        cells: [
          { cell_type: "markdown", metadata: {}, source: [`Our BOSS accuracy is ${SENTINEL}.`] },
          {
            cell_type: "code",
            execution_count: 3,
            metadata: {},
            source: ["print('accuracy', evaluate())"],
            outputs: [{ output_type: "stream", name: "stdout", text: [`accuracy ${SENTINEL}\n`, "31.42%\n"] }],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );
    await writeFile(join(destination, "README.md"), `# Sentinel\nThe paper reports 31.42% (${SENTINEL}).\n`);
    await writeFile(join(destination, "train.py"), "print('training')\n");
    const manifest = await buildRepositoryManifest(destination);
    return {
      schemaVersion: 1,
      repositoryUrl: input.repositoryUrl,
      commitSha: input.commitSha ?? COMMIT,
      defaultBranch: "main",
      repositorySizeKb: 1,
      destination,
      acquiredAt: new Date().toISOString(),
      metadataSource: "unavailable",
      fileCount: manifest.entries.length,
      totalBytes: manifest.bytes,
      manifestSha256: manifest.sha256,
      manifest: manifest.entries,
    };
  };
}

const paper: PaperDocument = {
  schemaVersion: 1,
  file: { originalName: "sentinel.pdf", bytes: 100, sha256: createHash("sha256").update(PAGE_TEXT).digest("hex") },
  pageCount: 1,
  pages: [{ pageNumber: 1, text: PAGE_TEXT, charCount: PAGE_TEXT.length }],
  totalTextChars: PAGE_TEXT.length,
  warnings: [],
};

async function sentinelTarget(): Promise<ClaimTarget> {
  return loadClaimTarget(
    {
      schemaVersion: 1,
      caseId: "sentinel-case",
      paper: { title: "Sentinel paper", sha256: paper.file.sha256 },
      claim: {
        page: 1,
        location: "Table 2",
        excerpt: `BOSS accuracy of ${SENTINEL} on the GunPoint`,
        method: "BOSS",
        dataset: "GunPoint",
        split: "official test set",
        preprocessing: "not stated",
        seedPolicy: "not stated",
        metric: { name: "test accuracy", unit: "fraction" },
        reportedValue: SENTINEL,
        identify: { methodIncludes: ["BOSS"], methodExcludes: [], datasetIncludes: ["GunPoint"] },
      },
      repository: { url: REPO, commitSha: COMMIT, entrypoint: "train.py" },
      environment: { python: ["3.11"], requirements: [], allowedCompatibilityConstraints: [] },
      dataset: { source: { kind: "repository" } },
      adapter: null,
      metricParser: { source: "json", path: "artifacts/result.json", key: "metrics.accuracyPercent", unit: "percent" },
      expectedRuntimeCeilingSeconds: 600,
      tolerance: 0.02,
      maximumVerdict: "reproduced",
    },
    work,
  );
}

async function study(mode: Mode, options: { target: boolean }) {
  const store = new RunStore();
  const runtime = new ScriptedRuntime();
  const labs = new LabManager({ runtime, labRoot: join(work, "labs"), events: (event) => store.appendEvent(event) });
  const provider = new SentinelProvider(mode);
  const { id: runId } = store.createRun({ fileName: "sentinel.pdf" });
  const controller = new AbortController();
  if (mode === "cancel_at_review") provider.onReviewer = () => controller.abort(new Error("cancelled by the user"));
  const result: MultiAgentResult = await runMultiAgentStudy(
    {
      runId,
      paper,
      candidates: [{ repositoryUrl: REPO, owner: "example", name: "sentinel-paper", occurrences: [], providedByUser: true }],
      signal: controller.signal,
      target: options.target ? await sentinelTarget() : null,
    },
    {
      store,
      labs,
      dependencies: null,
      images: fixedLabImagePort({ name: "dejaml/python-cpu:0.1.0", expectedImageId: STAND_IN_IMAGE_ID }),
      datasets: null,
      config: {
        platform: buildPlatformSpec({ architecture: "amd64", python: "3.11" }),
        resources: DEFAULT_STUDY_RESOURCES,
        engineers: 1,
        provider: { id: "scripted", model: "scripted-model" },
        datasetPolicy: { allowedHosts: [], maxRedirects: 3, maxBytes: 1024, timeoutMs: 1000 } as never,
        maxStudyMs: 60_000,
        commandTimeoutSeconds: 60,
        maxReplans: 0,
        trustedConstraints: [],
      },
      chatProvider: provider,
      workRoot: join(work, "data"),
      acquire: acquire() as never,
      leakCheck: async () => ({ containers: [...runtime.containers], networks: [] }),
    },
  );
  return { store, runtime, provider, runId, result };
}

describe("blinded study: the sentinel value never reaches a blind agent, the browser, or a pre-reveal report", () => {
  it("seals before any agent, locks the observation and the blind review, then reveals and compares in code", async () => {
    const { store, runtime, provider, runId, result } = await study("honest", { target: true });
    const report = result.report;
    const phases = report.blinding.records.map((item) => item.phase);
    expect(phases).toEqual([
      "target_sealed",
      "agents_started",
      "execution_completed",
      "observation_locked",
      "blind_review_locked",
      "target_revealed",
      "deterministic_comparison",
      "final_status",
    ]);
    const at = (phase: string): string => report.blinding.records.find((item) => item.phase === phase)!.at;
    // Sealed before the first agent existed.
    const agents = store.ledger.listAgents(runId);
    expect(agents.every((agent) => agent.createdAt >= at("target_sealed"))).toBe(true);
    // The reveal verified both commitments, and code computed the comparison.
    expect(report.blinding.reveal).toMatchObject({ verified: true, observationVerified: true });
    expect(report.blinding.comparison).toMatchObject({
      observed: 0.7988,
      reported: SENTINEL,
      absoluteDelta: Math.round(Math.abs(0.7988 - SENTINEL) * 1e9) / 1e9,
      tolerance: 0.02,
      withinTolerance: false,
      blindVerdicts: ["partially_equivalent"],
    });
    expect(report.result).toMatchObject({ status: "not_reproduced", paperValue: SENTINEL, observedValue: 0.7988, tolerance: 0.02 });

    // 1, 3, 5: asking for the paper is denied for the Planner, the Engineer, and the Reviewer.
    for (const role of ["reproduction_planner", "lab_engineer", "independent_reviewer"]) {
      const agent = agents.find((item) => item.role === role)!;
      const asked = store.ledger.listReceipts({ agentId: agent.id }).filter((receipt) => receipt.tool === "paper_read_page");
      expect(asked.length, role).toBe(1);
      expect(asked[0]!.status, role).toBe("denied");
    }

    // Every request any blind agent sent before the reveal, tool results included.
    const revealAt = at("target_revealed");
    const blind = provider.requests.filter((item) => item.role !== "Paper Analyst");
    expect(blind.length).toBeGreaterThan(8);
    for (const { role, request } of blind) {
      const verdictAfterReveal =
        role === "Supervisor" && request.messages[0]?.role === "user" && request.messages[0].content.includes('"verdict"');
      if (verdictAfterReveal) continue;
      expect(leaks(request), `${role} request`).toEqual([]);
    }
    // Agent histories, tool arguments and results (receipts) of every blind agent.
    for (const agent of agents.filter((item) => item.role !== "paper_analyst")) {
      if (agent.role === "supervisor" && agent.createdAt >= revealAt) continue;
      // Everything the agent received (its own replies are what it wrote, not what it was told).
      const received = store.ledger.listTurns(agent.id).filter((turn) => (turn.message as { role: string }).role !== "assistant");
      expect(leaks(received), `${agent.role} history`).toEqual([]);
      // Tool results the agent was given (the adversarial Repository Analyst's own finish carries what it wrote).
      const receipts = store.ledger
        .listReceipts({ agentId: agent.id })
        .filter((receipt) => !(agent.role === "repository_analyst" && receipt.tool === "finish"));
      expect(leaks(receipts.map((receipt) => [receipt.input, receipt.output])), `${agent.role} tool arguments and results`).toEqual([]);
      expect(leaks(agent.task), `${agent.role} task`).toEqual([]);
    }
    // 4: the lab mounted the projection, whose notebook has no outputs and whose README withholds the value.
    expect(runtime.createArgs.some((arg) => arg.includes("/projections/") && arg.endsWith("dst=/workspace/case/repo,readonly"))).toBe(true);
    expect(report.blinding.projection).toMatchObject({
      notebooksStripped: [{ path: "notebooks/eval.ipynb", outputsRemoved: 1 }],
      documentsWithheld: 1,
    });
    // Terminal metadata, environment variables, and commands sent to the lab.
    expect(leaks(runtime.execs)).toEqual([]);
    expect(leaks(runtime.createArgs)).toEqual([]);
    // The board, before the reveal (the status decision is written after it).
    for (const entry of store.ledger.listBoard(runId)) {
      if (entry.createdAt >= revealAt) continue;
      expect(leaks(entry.payload), `board ${entry.kind}`).toEqual([]);
    }
    // Every event the browser receives before the reveal; the reveal event carries the value.
    const events = store.listEvents(runId);
    const revealIndex = events.findIndex((item) => item.type === "target_revealed");
    expect(revealIndex).toBeGreaterThan(0);
    for (const item of events.slice(0, revealIndex)) {
      expect(leaks(item), item.type).toEqual([]);
      expect(JSON.stringify(item), item.type).not.toMatch(/"(reportedValue|paperReference|paperValue|tolerance)"\s*:\s*(?!null)/u);
    }
    expect(leaks(events[revealIndex])).not.toEqual([]);
    const sealedEvent = events.find((item) => item.type === "target_sealed")!;
    expect(Object.keys(sealedEvent.publicPayload).sort()).toEqual(["caseId", "commitment", "metric", "sealedAt"]);
    // 14: the final report carries the commitment and the reveal proof, and no key.
    expect(report.blinding.commitment).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.blinding.reveal!.canonical).toContain('"nonce"');
    expect(JSON.stringify(report)).not.toMatch(/sk-|api[_-]?key/iu);

    // The acceptance scripts' independent re-check, from the store alone, holds.
    const proof = proveBlinding({ store, runId, report });
    expect(proof.filter((item) => !item.pass)).toEqual([]);
    expect(proof).toHaveLength(10);
    // A revealed payload that differs from what was sealed fails it.
    const tampered = structuredClone(report);
    tampered.blinding.reveal!.canonical = tampered.blinding.reveal!.canonical.replace(String(SENTINEL), "0.7988");
    const failed = proveBlinding({ store, runId, report: tampered })
      .filter((item) => !item.pass)
      .map((item) => item.name);
    expect(failed).toContain("sealed commitment verified at the reveal");
  });

  it("refuses a plan that states an expected value, and the target stays sealed", async () => {
    const { store, runId, result } = await study("planner_states_value", { target: true });
    // 2: refused with a neutral reason that repeats nothing.
    expect(result.report.result.status).toBe("inconclusive");
    expect(result.report.result.reasons.join(" ")).toMatch(/states an expected result/u);
    expect(result.report.blinding.records.map((item) => item.phase)).toEqual(["target_sealed", "agents_started", "final_status"]);
    expect(result.report.blinding.records.at(-1)!.record).toMatchObject({ sealed: true });
    // 13, 14: the public report has no value, no tolerance, and no nonce; only the audit copy has the sealed payload.
    expect(leaks(result.report)).toEqual([]);
    expect(JSON.stringify(result.report)).not.toContain('"nonce"');
    expect(result.report.result).toMatchObject({ paperValue: null, tolerance: null });
    expect(result.auditReport.blinding.sealedPayload).toContain(String(SENTINEL));
    expect(result.auditReport.blinding.sealedPayload).toContain('"nonce"');
    // A study that never revealed can never pass the acceptance re-check.
    expect(
      proveBlinding({ store, runId, report: result.report })
        .filter((item) => !item.pass)
        .map((item) => item.name),
    ).toEqual(expect.arrayContaining(["commitments recorded in the required order", "sealed commitment verified at the reveal"]));
  });

  it("never reveals a cancelled study", async () => {
    const { result } = await study("cancel_at_review", { target: true });
    // 12
    expect(result.report.result.status).toBe("cancelled");
    const phases = result.report.blinding.records.map((item) => item.phase);
    expect(phases).not.toContain("target_revealed");
    expect(phases.at(-1)).toBe("final_status");
    expect(leaks(result.report)).toEqual([]);
  });

  it("seals the Paper Analyst's own claim before any blind agent reads it when no reviewed target exists", async () => {
    const { store, provider, runId, result } = await study("honest", { target: false });
    const phases = result.report.blinding.records.map((item) => item.phase);
    expect(phases[0]).toBe("target_sealed");
    expect(phases).toContain("target_revealed");
    const planner = store.ledger.listAgents(runId).find((agent) => agent.role === "reproduction_planner")!;
    expect(planner.createdAt >= result.report.blinding.records[0]!.at).toBe(true);
    // The Repository Analyst ran beside the Paper Analyst, before any claim existed; its handoff is withheld.
    const mapping = store.ledger.listBoard(runId).find((entry) => entry.kind === "repository_mapping")!;
    expect(leaks(mapping.payload)).toEqual([]);
    for (const { role, request } of provider.requests) {
      if (!["Reproduction Planner", "Lab Engineer", "Independent Reviewer"].includes(role)) continue;
      expect(leaks(request), role).toEqual([]);
    }
  });

  it("rejects a reveal out of order at the ledger, whatever the caller", () => {
    // 8, 9, 10 at the study's own store (full coverage in run-store's blinding tests).
    const store = new RunStore();
    const { id } = store.createRun({});
    store.blinding.seal(id, { canonical: "{}", commitment: createHash("sha256").update("{}").digest("hex"), record: {} });
    store.blinding.record(id, "agents_started");
    store.blinding.record(id, "execution_completed", { round: 1 });
    expect(() => store.blinding.record(id, "target_revealed")).toThrow(BlindingOrderError);
    store.blinding.record(id, "observation_locked", { round: 1 });
    expect(() => store.blinding.record(id, "target_revealed")).toThrow(BlindingOrderError);
    store.blinding.record(id, "blind_review_locked", { round: 1 });
    const first = store.blinding.record(id, "target_revealed");
    expect(store.blinding.record(id, "target_revealed")).toEqual(first);
  });
});
