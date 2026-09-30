import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvidenceBoard, ToolDenied, type ToolContext, type ToolDefinition } from "@dejaml/agent-runtime";
import { RunStore } from "@dejaml/run-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EngineerLab, StudyContext } from "./context.js";
import { buildStudyTools } from "./tools.js";

let dir: string;
let store: RunStore;
let ctx: StudyContext;
let runCalls: Array<{ executable: string; args: string[]; cwd: string }>;

function context(role: ToolContext["role"], agentId = "agt_eng"): ToolContext {
  return { runId: "run_t", agentId, role, signal: new AbortController().signal, board: new EvidenceBoard(store.ledger, "run_t"), receiptId: "rcp_t" };
}

function tool(name: string, role: ToolContext["role"] = "repository_analyst"): ToolDefinition {
  const found = buildStudyTools(ctx, { agentId: "agt_x", role, grants: [name] }).find((item) => item.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

async function call(name: string, input: unknown, role: ToolContext["role"] = "repository_analyst") {
  const definition = tool(name, role);
  return definition.run(definition.input.parse(input), context(role));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dejaml-tools-"));
  await mkdir(join(dir, "repo/src"), { recursive: true });
  await writeFile(join(dir, "repo/src/train.py"), "print('accuracy')\n");
  await symlink("/etc/passwd", join(dir, "repo/leak"));
  await symlink("/etc", join(dir, "repo/etcdir"));
  store = new RunStore();
  store.createRun({}, "run_t");
  runCalls = [];
  const lab: EngineerLab = { agentId: "agt_eng", label: "engineer-1-1", labId: "lab_1", imageId: "sha256:x", commands: [], written: new Map(), artifacts: new Map(), environment: null, destroyed: false };
  ctx = {
    runId: "run_t",
    paper: { schemaVersion: 1, file: { originalName: "p.pdf", bytes: 1, sha256: "a".repeat(64) }, pageCount: 1, pages: [{ pageNumber: 1, text: "We report accuracy 81.66.", charCount: 25 }], totalTextChars: 25, warnings: [] },
    candidates: [{ repositoryUrl: "https://github.com/example/paper", owner: "example", name: "paper", occurrences: [{ pageNumber: 1, rawUrl: "x" }] }],
    store,
    labs: {
      runCommand: async (_labId: string, command: { executable: string; args: string[]; cwd: string }) => {
        runCalls.push(command);
        return { command, exitCode: 0, timedOut: false, stdout: { text: "ok", bytes: 2, truncated: false }, stderr: { text: "", bytes: 0, truncated: false }, startedAt: "", endedAt: "", durationMs: 5, artifacts: [], strayProcesses: [], scratchBytes: 0 };
      },
    } as unknown as StudyContext["labs"],
    prep: null,
    runtime: undefined as unknown as StudyContext["runtime"],
    config: {
      image: { name: "img", expectedImageId: "sha256:x" },
      resources: { cpus: 1, memoryMb: 512, pids: 64, timeoutSeconds: 60, networkDuringRun: false },
      engineers: 1,
      provider: { id: "scripted", model: "m" },
      datasetPolicy: { allowedHosts: [], maxRedirects: 3, maxBytes: 1024, timeoutMs: 1000 },
      maxStudyMs: 1000,
      commandTimeoutSeconds: 30,
      maxDelegations: 3,
    },
    workDir: dir,
    acquire: async () => {
      throw new Error("not called");
    },
    repository: { receipt: {} as never, dir: join(dir, "repo"), root: dir },
    dependencies: { discovery: null, resolution: null, manifest: null, manifestSha256: null, failures: [] },
    datasets: [],
    labsByAgent: new Map([["agt_eng", lab]]),
    exports: new Map(),
    delegations: { total: 0, byStage: { analysis: 0, plan: 0, engineering: 0, review: 0 } },
    runStage: async (stage) => `${stage} done`,
    event: () => undefined,
  };
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("study tools", () => {
  it("gives each role only its granted tools", () => {
    const names = buildStudyTools(ctx, { agentId: "a", role: "independent_reviewer", grants: ["board_read", "artifact_read"] }).map((item) => item.name);
    expect(names.sort()).toEqual(["artifact_read", "board_read"]);
  });

  it("reads the checkout but refuses traversal and symlink escapes", async () => {
    await expect(call("repo_read", { path: "src/train.py" })).resolves.toMatchObject({ summary: "Read src/train.py" });
    await expect(call("repo_read", { path: "../../etc/passwd" })).rejects.toBeInstanceOf(ToolDenied);
    await expect(call("repo_read", { path: "/etc/passwd" })).rejects.toBeInstanceOf(ToolDenied);
    await expect(call("repo_read", { path: "leak" })).rejects.toThrow(/outside the repository/u);
    await expect(call("repo_list", { path: "etcdir" })).rejects.toThrow(/outside the repository/u);
    const listing = await call("repo_list", {});
    expect(listing.content).toContain("leak (symlink, not followed)");
    const search = await call("repo_search", { query: "accuracy" });
    expect(search.content).toContain("src/train.py:1:");
    expect(search.content).not.toContain("root:");
  });

  it("acquires only the paper's candidate repositories", async () => {
    ctx.repository = null;
    await expect(call("repo_acquire", { repositoryUrl: "https://github.com/attacker/other" })).rejects.toThrow(/only the candidate repositories/u);
  });

  it("refuses dataset downloads when no host is allowed and records a policy block", async () => {
    const result = await call("dataset_fetch", { name: "d", url: "https://example.com/d.csv", fileName: "d.csv" }, "reproduction_planner");
    expect(result.status).toBe("denied");
    expect(new EvidenceBoard(store.ledger, "run_t").list(["policy_block"])).toHaveLength(1);
  });

  it("refuses SSRF targets through the dataset guard", async () => {
    ctx.config.datasetPolicy = { ...ctx.config.datasetPolicy, allowedHosts: ["example.com"] };
    for (const url of ["http://example.com/d.csv", "https://127.0.0.1/d.csv", "https://169.254.169.254/latest", "https://user:pw@example.com/d.csv", "https://other.org/d.csv"]) {
      const result = await call("dataset_fetch", { name: "d", url, fileName: "d.csv" }, "reproduction_planner");
      expect(result.status, url).toBe("denied");
    }
  });

  it("runs lab commands inside the workspace, wrapping absolute executables with env", async () => {
    const run = tool("lab_run", "lab_engineer");
    await run.run(run.input.parse({ argv: ["/workspace/case/work/.venv/bin/python", "-V"], cwd: "work" }), context("lab_engineer"));
    expect(runCalls.at(-1)).toMatchObject({ executable: "env", args: ["--", "/workspace/case/work/.venv/bin/python", "-V"], cwd: "/workspace/case/work" });
    await expect(run.run(run.input.parse({ argv: ["ls"], cwd: "../.." }), context("lab_engineer"))).rejects.toBeInstanceOf(ToolDenied);
    await expect(run.run(run.input.parse({ argv: ["ls"], cwd: "/etc" }), context("lab_engineer"))).rejects.toBeInstanceOf(ToolDenied);
    const receipts = new EvidenceBoard(store.ledger, "run_t").list(["command_receipt"]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.key).toBe("agt_eng");
  });

  it("caps the Supervisor's delegations", async () => {
    const delegate = tool("delegate", "supervisor");
    for (let index = 0; index < 2; index += 1) {
      await delegate.run(delegate.input.parse({ stage: "analysis", objective: "go" }), context("supervisor", "agt_sup"));
    }
    await expect(delegate.run(delegate.input.parse({ stage: "analysis", objective: "again" }), context("supervisor", "agt_sup"))).rejects.toThrow(/already ran/u);
    await delegate.run(delegate.input.parse({ stage: "plan", objective: "go" }), context("supervisor", "agt_sup"));
    await expect(delegate.run(delegate.input.parse({ stage: "plan", objective: "go" }), context("supervisor", "agt_sup"))).rejects.toThrow(/delegation limit/u);
  });
});
