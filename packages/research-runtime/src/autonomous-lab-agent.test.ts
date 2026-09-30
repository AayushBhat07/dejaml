import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_LAB_LIMITS,
  LabManager,
  type ContainerRuntime,
  type RuntimeCommandOptions,
  type RuntimeCommandResult,
} from "@dejaml/lab-manager";
import { RunStore } from "@dejaml/run-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findLiteral, runAutonomousLabAgent, type AutonomousLabAction } from "./autonomous-lab-agent.js";
import type { StructuredModelClient } from "./model.js";
import { paperFixture } from "./test-fixtures.js";

const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const WORKDIR = "/workspace/case";
const layout = { workdir: WORKDIR, repoDir: "repo", scratchDir: "work", artifactsDir: "artifacts" };

function ok(stdout = "", exitCode = 0, stderr = ""): RuntimeCommandResult {
  return {
    exitCode,
    stdout: { text: stdout, bytes: stdout.length, truncated: false },
    stderr: { text: stderr, bytes: stderr.length, truncated: false },
    aborted: false,
  };
}

/**
 * Maps the lab's writable mounts to host directories and interprets a few
 * commands: the in-container file writer, a training script, and echo.
 */
class SimulatedLab implements ContainerRuntime {
  readonly execs: string[][] = [];
  readonly mounts = new Map<string, string>();
  paused = false;
  accuracy = 0.7988;

  async docker(args: readonly string[], _options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    const [command] = args;
    if (command === "image")
      return ok(JSON.stringify({ Id: IMAGE_ID, Os: "linux", Architecture: "amd64", Config: { User: "10001:10001", Env: [] } }));
    if (command === "container")
      return ok(
        JSON.stringify({
          Image: IMAGE_ID,
          Config: { User: "10001:10001", Env: [] },
          HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] },
          Mounts: [],
        }),
      );
    if (command === "create") {
      for (const value of args) {
        const match = /^type=bind,src=([^,]+),dst=([^,]+)$/u.exec(value);
        if (match) this.mounts.set(match[2]!, match[1]!);
      }
      return ok();
    }
    if (command === "pause" || command === "unpause") {
      this.paused = command === "pause";
      return ok();
    }
    if (command === "exec") {
      if (this.paused) return ok("", 1, "container is paused");
      const name = args.findIndex((value) => value.startsWith("dejaml-lab-"));
      const argv = args.slice(name + 1);
      this.execs.push([...argv]);
      if (argv[0] === "python" && argv[1] === "-c") {
        const target = argv[3]!;
        const host = this.#host(target);
        await mkdir(dirname(host), { recursive: true });
        await writeFile(host, Buffer.from(argv[4]!, "base64"));
        return ok();
      }
      const inner = argv[0] === "timeout" ? argv.slice(3) : argv;
      if (inner[0] === "python" && inner[1] === "work/train.py") {
        await writeFile(this.#host(`${WORKDIR}/artifacts/metrics.json`), JSON.stringify({ accuracy: this.accuracy }));
        return ok(`accuracy ${this.accuracy}\n`);
      }
      if (inner[0] === "bash") {
        await writeFile(this.#host(`${WORKDIR}/artifacts/metrics.json`), JSON.stringify({ accuracy: 0.9123 }));
        return ok();
      }
      if (inner[0] === "false") return ok("", 1, "boom");
      return ok("README.md\ntrain.py\n");
    }
    if (command === "stats") {
      while (!_options.signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      return { ...ok(), aborted: true };
    }
    return ok();
  }

  #host(containerPath: string): string {
    for (const [dst, src] of this.mounts) {
      if (containerPath.startsWith(`${dst}/`)) return join(src, containerPath.slice(dst.length + 1));
    }
    throw new Error(`no writable mount for ${containerPath}`);
  }
}

function scripted(actions: Array<AutonomousLabAction | Error>): StructuredModelClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async complete(request) {
      prompts.push(request.prompt);
      const next = actions.shift();
      if (!next) return { value: request.schema.parse({ tool: "give_up", reason: "script ended" }) };
      if (next instanceof Error) throw next;
      return { value: request.schema.parse(next) };
    },
  };
}

let work: string;
let runtime: SimulatedLab;
let labs: LabManager;
let store: RunStore;
let labId: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "dejaml-agent-"));
  await mkdir(join(work, "repo"));
  runtime = new SimulatedLab();
  store = new RunStore();
  store.createRun({}, "run_auto");
  labs = new LabManager({ runtime, labRoot: join(work, "labs"), events: (event) => store.appendEvent(event) });
  const handle = await labs.createLab({
    runId: "run_auto",
    image: "dejaml/python-cpu:0.1.0",
    expectedImageId: IMAGE_ID,
    platform: "linux/amd64",
    workdir: WORKDIR,
    artifactsDir: "artifacts",
    scratchDir: "work",
    inputs: [{ hostPath: join(work, "repo"), containerPath: "repo" }],
    resources: { cpus: 2, memoryMb: 2048, pids: 128, timeoutSeconds: 120, networkDuringRun: false },
    limits: DEFAULT_LAB_LIMITS,
  });
  labId = handle.labId;
});

afterEach(async () => {
  await labs.destroyLab(labId).catch(() => undefined);
  store.close();
  await rm(work, { recursive: true, force: true });
});

const TRAIN = "from repo import model\nprint(model.evaluate())\n";
const submit: AutonomousLabAction = {
  tool: "submit",
  metricFile: "artifacts/metrics.json",
  key: "accuracy",
  metricName: "accuracy",
  unit: "fraction",
  split: "official test set",
  dataset: "UCI Urban Land Cover",
  summary: "Ran the repository's Random Forest on the test split.",
};

function run(argv: string[], timeoutSeconds?: number): AutonomousLabAction {
  return { tool: "run", argv, why: "test", ...(timeoutSeconds ? { timeoutSeconds } : {}) };
}

async function agent(model: StructuredModelClient, budget = {}) {
  return runAutonomousLabAgent({
    runId: "run_auto",
    labId,
    claim: paperFixture.claim!,
    mapping: null,
    layout,
    labs,
    model,
    store,
    budget,
  });
}

describe("autonomous Lab Agent", () => {
  it("explores, writes its own adapter, runs it, and submits a metric the run produced", async () => {
    const model = scripted([
      run(["ls", "repo"]),
      { tool: "write_file", path: "work/train.py", content: TRAIN, why: "adapter" },
      run(["python", "work/train.py"], 60),
      submit,
    ]);
    const result = await agent(model);

    expect(result.status).toBe("submitted");
    expect(result.attempt).toMatchObject({ number: 3, label: "baseline", exitCode: 0, changes: [] });
    expect(result.attempt?.command).toMatchObject({ executable: "python", args: ["work/train.py"], cwd: WORKDIR });
    expect(result.artifact?.content.toString()).toBe('{"accuracy":0.7988}');
    expect(result.files).toEqual([expect.objectContaining({ path: "work/train.py", content: TRAIN })]);
    expect(runtime.paused).toBe(true);
    // Every command is wrapped in its own in-container time limit.
    expect(runtime.execs).toContainEqual(["timeout", "--signal=KILL", "60s", "python", "work/train.py"]);
    // The first prompt is the brief; later prompts carry the latest observation.
    expect(JSON.parse(model.prompts[0]!)).toMatchObject({ claim: { dataset: "UCI Urban Land Cover" } });
    expect(JSON.parse(model.prompts[1]!).observation).toMatchObject({ exitCode: 0, stdout: "README.md\ntrain.py\n" });
    const types = store.listEvents("run_auto").map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(["lab_agent_started", "agent_command", "agent_file", "lab_agent_submitted"]));
  });

  it("rejects a metric file no run produced and lets the agent recover", async () => {
    const model = scripted([
      submit,
      run(["false"]),
      { tool: "write_file", path: "work/train.py", content: TRAIN, why: "adapter" },
      run(["python", "work/train.py"]),
      submit,
    ]);
    const result = await agent(model);
    expect(result.status).toBe("submitted");
    expect(result.transcript[0]!.observation).toMatchObject({
      submissionRejected: "artifacts/metrics.json was not produced by any run command",
    });
    expect(JSON.parse(model.prompts[2]!).observation).toMatchObject({ exitCode: 1, stderr: "boom" });
  });

  it("refuses files outside scratch and a metric typed into a shell command", async () => {
    const model = scripted([
      { tool: "write_file", path: "artifacts/metrics.json", content: '{"accuracy":0.99}', why: "cheat" },
      run(["bash", "-lc", "echo '{\"accuracy\": 0.9123}' > artifacts/metrics.json"]),
      submit,
    ]);
    const result = await agent(model);
    expect(result.transcript[0]!.observation.error).toMatch(/under work\//u);
    expect(result.status).toBe("rejected");
    expect(result.reason).toMatch(/0\.9123 appears literally/u);
  });

  it("rejects a submission whose value is written literally in the agent's files", async () => {
    runtime.accuracy = 0.8166;
    const model = scripted([
      { tool: "write_file", path: "work/train.py", content: "print('accuracy', 0.8166)\n", why: "adapter" },
      run(["python", "work/train.py"]),
      submit,
    ]);
    const result = await agent(model);
    expect(result.status).toBe("rejected");
    expect(result.reason).toMatch(/0\.8166 appears literally/u);
  });

  it("stops at the step budget and after repeated invalid actions", async () => {
    expect((await agent(scripted([run(["ls"]), run(["ls"]), run(["ls"])]), { maxSteps: 2 })).status).toBe("exhausted");
    const invalid = await agent(scripted([new Error("bad json"), new Error("bad json"), new Error("bad json")]));
    expect(invalid).toMatchObject({ status: "lab_failed", reason: "the model returned three invalid actions in a row" });
  });

  it("works as a team: the Planner briefs the Engineer and the Debugger advises after a failure", async () => {
    const roles: string[] = [];
    const engineer = scripted([
      run(["false"]),
      { tool: "write_file", path: "work/train.py", content: TRAIN, why: "adapter" },
      run(["python", "work/train.py"]),
      submit,
    ]);
    const model: StructuredModelClient = {
      async complete(request) {
        roles.push(`${request.role}:${request.sessionId}`);
        if (request.role === "lab_planner") {
          expect(JSON.parse(request.prompt).repositoryListing).toContain("README.md");
          return { value: request.schema.parse({ summary: "Run train.py", entrypoint: "train.py", steps: ["run it"], risks: [] }) };
        }
        if (request.role === "lab_debugger") {
          expect(JSON.parse(request.prompt)).toMatchObject({ failedCommand: ["false"], exitCode: 1, stderr: "boom" });
          return { value: request.schema.parse({ diagnosis: "wrong command", suggestedFix: "run work/train.py", reproducibleHere: true }) };
        }
        return engineer.complete(request);
      },
    };
    const result = await runAutonomousLabAgent({
      runId: "run_auto",
      labId,
      agentName: "agent-2",
      team: true,
      claim: paperFixture.claim!,
      mapping: null,
      layout,
      labs,
      model,
      store,
    });
    expect(result.status).toBe("submitted");
    expect(result.team?.plan?.entrypoint).toBe("train.py");
    expect(result.team?.diagnoses).toEqual([{ step: 1, diagnosis: expect.objectContaining({ diagnosis: "wrong command" }) }]);
    expect(JSON.parse(engineer.prompts[0]!).plannerPlan).toMatchObject({ summary: "Run train.py" });
    expect(JSON.parse(engineer.prompts[1]!).observation.debuggerAdvice).toMatchObject({ suggestedFix: "run work/train.py" });
    expect(roles).toEqual(
      expect.arrayContaining([
        "lab_planner:run_auto:lab_planner:agent-2",
        "lab_debugger:run_auto:lab_debugger:agent-2",
        "lab_agent:run_auto:lab_agent:agent-2",
      ]),
    );
  });

  it("finds literal metric values without flagging small constants", () => {
    expect(findLiteral(0.7988, ["acc = 0.7988"])).toBe("0.7988");
    expect(findLiteral(79.88, ["print(79.88)"])).toBe("79.88");
    expect(findLiteral(0.5, ["threshold = 0.5"])).toBeNull();
    expect(findLiteral(0.7988, ["seed = 17988"])).toBeNull();
  });
});
