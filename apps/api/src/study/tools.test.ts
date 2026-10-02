import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvidenceBoard, ToolDenied, type ToolContext, type ToolDefinition } from "@dejaml/agent-runtime";
import { buildPlatformSpec } from "@dejaml/contracts";
import { RunStore } from "@dejaml/run-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EngineerLab, StudyContext } from "./context.js";
import { buildStudyTools } from "./tools.js";

let dir: string;
let store: RunStore;
let ctx: StudyContext;
let runCalls: Array<{ executable: string; args: string[]; cwd: string }>;
let integrity: { workRepo: string; venv: string; adapter: string | null };

function context(role: ToolContext["role"], agentId = "agt_eng"): ToolContext {
  return {
    runId: "run_t",
    agentId,
    role,
    signal: new AbortController().signal,
    board: new EvidenceBoard(store.ledger, "run_t"),
    receiptId: "rcp_t",
  };
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
  const lab: EngineerLab = {
    agentId: "agt_eng",
    label: "engineer-1",
    labId: "lab_1",
    imageId: "sha256:x",
    platform: "linux/amd64",
    commands: [],
    artifacts: new Map(),
    integrity: { workRepo: "w:1", venv: "v:1", adapter: "a:1" },
    environment: null,
    official: null,
    dependencyRequest: null,
    destroyed: false,
  };
  integrity = { workRepo: "w:1", venv: "v:1", adapter: "a:1" };
  ctx = {
    runId: "run_t",
    paper: {
      schemaVersion: 1,
      file: { originalName: "p.pdf", bytes: 1, sha256: "a".repeat(64) },
      pageCount: 1,
      pages: [{ pageNumber: 1, text: "We report accuracy 81.66.", charCount: 25 }],
      totalTextChars: 25,
      warnings: [],
    },
    candidates: [
      { repositoryUrl: "https://github.com/example/paper", owner: "example", name: "paper", occurrences: [{ pageNumber: 1, rawUrl: "x" }] },
    ],
    store,
    labs: {
      runCommand: async (_labId: string, command: { executable: string; args: string[]; cwd: string }) => {
        runCalls.push(command);
        const stdout = command.args.some((arg) => arg.includes("hashlib")) ? JSON.stringify(integrity) : "accuracy: 0.8";
        return {
          command,
          exitCode: 0,
          timedOut: false,
          stdout: { text: stdout, bytes: stdout.length, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          startedAt: "",
          endedAt: "",
          durationMs: 5,
          artifacts: [],
          strayProcesses: [],
          scratchBytes: 0,
        };
      },
    } as unknown as StudyContext["labs"],
    dependencies: null,
    runtime: { board: (runId: string) => new EvidenceBoard(store.ledger, runId) } as unknown as StudyContext["runtime"],
    config: {
      platform: buildPlatformSpec({ architecture: "amd64", python: "3.11" }),
      resources: { cpus: 1, memoryMb: 512, pids: 64, timeoutSeconds: 60, networkDuringRun: false },
      engineers: 1,
      provider: { id: "scripted", model: "m" },
      datasetPolicy: { allowedHosts: [], maxRedirects: 3, maxBytes: 1024, timeoutMs: 1000 } as never,
      maxStudyMs: 1000,
      commandTimeoutSeconds: 30,
      maxReplans: 2,
      trustedConstraints: [],
    },
    workDir: dir,
    acquire: async () => {
      throw new Error("not called");
    },
    repository: { receipt: {} as never, dir: join(dir, "repo"), root: dir },
    projection: {
      dir: join(dir, "repo"),
      sha256: "p".repeat(64),
      notebooksStripped: [],
      documentsWithheld: [],
      staticFindings: [],
      fileCount: 0,
    },
    sealedForScan: [],
    pinnedCommit: null,
    contract: {
      schemaVersion: 1,
      method: "RF",
      dataset: { name: "d", source: { kind: "repository", paths: ["src"] } },
      split: "test",
      preprocessing: "none",
      seedPolicy: "none",
      metric: { name: "accuracy", unit: "fraction" },
      reportedValue: 0.8,
      paperReference: { page: 1, location: "T1", excerpt: "0.8" },
      repository: { url: "https://github.com/example/paper", commitSha: "b".repeat(40) },
      entrypoint: "src/train.py",
      command: { argv: ["python", "src/train.py"], cwd: "work/repo" },
      environment: {
        platform: buildPlatformSpec({ architecture: "amd64", python: "3.11" }),
        requirements: [],
        compatibilityConstraints: [],
      },
      expectedRuntimeSeconds: 10,
      metricParser: { source: "stdout", pattern: "accuracy: ([0-9.]+)" },
      tolerance: 0.02,
      additionalMetrics: [],
      stopConditions: ["exit non-zero"],
    },
    planDigest: "c".repeat(64),
    prepared: null,
    datasets: [],
    labsByAgent: new Map([["agt_eng", lab]]),
    exports: new Map(),
    finishLab: async (agentId: string) => {
      const found = ctx.labsByAgent.get(agentId);
      if (found) found.destroyed = true;
    },
    event: () => undefined,
  };
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("study tools", () => {
  it("gives each role only its granted tools", () => {
    const names = buildStudyTools(ctx, { agentId: "a", role: "independent_reviewer", grants: ["board_read", "artifact_read"] }).map(
      (item) => item.name,
    );
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
    await expect(call("repo_acquire", { repositoryUrl: "https://github.com/attacker/other" })).rejects.toThrow(
      /only the candidate repositories/u,
    );
  });

  it("runs lab commands inside the workspace, wrapping absolute executables with env", async () => {
    const run = tool("lab_run", "lab_engineer");
    await run.run(run.input.parse({ argv: ["/workspace/case/work/.venv/bin/python", "-V"], cwd: "work" }), context("lab_engineer"));
    expect(runCalls.at(-1)).toMatchObject({
      executable: "env",
      args: ["--", "/workspace/case/work/.venv/bin/python", "-V"],
      cwd: "/workspace/case/work",
    });
    await expect(run.run(run.input.parse({ argv: ["ls"], cwd: "../.." }), context("lab_engineer"))).rejects.toBeInstanceOf(ToolDenied);
    await expect(run.run(run.input.parse({ argv: ["ls"], cwd: "/etc" }), context("lab_engineer"))).rejects.toBeInstanceOf(ToolDenied);
    const receipts = new EvidenceBoard(store.ledger, "run_t").list(["command_receipt"]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.key).toBe("agt_eng");
  });

  it("runs only the approved command through lab_run_official, after an integrity check", async () => {
    const official = tool("lab_run_official", "lab_engineer");
    const first = await official.run({}, context("lab_engineer"));
    expect(first.status).not.toBe("denied");
    expect(runCalls.at(-1)).toMatchObject({
      executable: "env",
      args: ["--", "/workspace/case/work/.venv/bin/python", "src/train.py"],
      cwd: "/workspace/case/work/repo",
    });
    const lab = ctx.labsByAgent.get("agt_eng")!;
    expect(lab.official).toMatchObject({ official: true, exitCode: 0, stdoutFull: "accuracy: 0.8" });
    await expect(official.run({}, context("lab_engineer"))).rejects.toThrow(/already succeeded/u);
    lab.official = null;
    integrity = { workRepo: "w:1", venv: "v:2", adapter: "a:1" };
    const refused = await official.run({}, context("lab_engineer"));
    expect(refused.status).toBe("denied");
    expect(refused.content).toMatch(/Python environment changed/u);
    integrity = { workRepo: "w:1", venv: "v:1", adapter: "a:2" };
    const adapterChanged = await official.run({}, context("lab_engineer"));
    expect(adapterChanged.status).toBe("denied");
    expect(adapterChanged.content).toMatch(/approved adapter changed/u);
  });

  it("records dependency requests and serves logs to the Reviewer", async () => {
    const request = tool("dependency_request", "lab_engineer");
    await request.run(request.input.parse({ requirements: ["numpy==1.26.4"], reason: "ImportError" }), context("lab_engineer"));
    expect(ctx.labsByAgent.get("agt_eng")!.dependencyRequest).toEqual({ requirements: ["numpy==1.26.4"], reason: "ImportError" });
    const run = tool("lab_run", "lab_engineer");
    const result = await run.run(run.input.parse({ argv: ["ls"] }), context("lab_engineer"));
    const receiptId = JSON.parse(result.content).receiptId as string;
    const logs = tool("logs_read", "independent_reviewer");
    await expect(logs.run({ engineerAgentId: "agt_eng", receiptId }, context("independent_reviewer", "agt_rev"))).resolves.toMatchObject({
      summary: `Logs of ${receiptId}`,
    });
    await expect(
      logs.run({ engineerAgentId: "agt_eng", receiptId: "nope" }, context("independent_reviewer", "agt_rev")),
    ).rejects.toBeInstanceOf(ToolDenied);
  });

  it("destroys the lab on request and refuses lab tools afterwards", async () => {
    const destroy = tool("lab_destroy", "lab_engineer");
    await destroy.run({ reason: "done" }, context("lab_engineer"));
    const run = tool("lab_run", "lab_engineer");
    await expect(run.run(run.input.parse({ argv: ["ls"] }), context("lab_engineer"))).rejects.toThrow(/destroyed/u);
  });
});
