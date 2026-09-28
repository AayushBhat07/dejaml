import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunEventSchema } from "@dejaml/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LabManager, type LabEventInput } from "./manager.js";
import type { ContainerRuntime, RuntimeCommandOptions, RuntimeCommandResult } from "./runtime.js";
import { DEFAULT_LAB_LIMITS, type LabSpec } from "./spec.js";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

type ExecHandler = (context: {
  args: readonly string[];
  artifactsDir: string;
  options: RuntimeCommandOptions;
  killed: Promise<void>;
}) => Promise<RuntimeCommandResult>;

function ok(stdout = "", stderr = ""): RuntimeCommandResult {
  return {
    exitCode: 0,
    stdout: { text: stdout, bytes: stdout.length, truncated: false },
    stderr: { text: stderr, bytes: stderr.length, truncated: false },
    aborted: false,
  };
}

function failed(exitCode: number, stderr: string): RuntimeCommandResult {
  return { ...ok("", stderr), exitCode };
}

/** Simulates the Docker CLI closely enough to exercise the Lab Manager's control flow. */
class FakeRuntime implements ContainerRuntime {
  readonly calls: string[][] = [];
  imageId = IMAGE_ID;
  imageUser = "10001:10001";
  onExec: ExecHandler = async () => ok("done\n");
  readonly containers = new Map<string, { labId: string; runId: string; artifactsDir: string }>();
  #kill: (() => void) | null = null;

  async docker(args: readonly string[], options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    this.calls.push([...args]);
    const [command] = args;
    if (command === "image") return ok(`${this.imageId} ${this.imageUser}\n`);
    if (command === "create") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      const labels = args.flatMap((value, index) => (args[index - 1] === "--label" ? [value] : []));
      const artifactMount = args.find((value) => value.includes("dst=/workspace/case/artifacts")) ?? "";
      this.containers.set(name, {
        labId: labels[0]?.split("=")[1] ?? "",
        runId: labels[1]?.split("=")[1] ?? "",
        artifactsDir: /src=([^,]+)/u.exec(artifactMount)?.[1] ?? "",
      });
      return ok();
    }
    if (command === "start") return ok();
    if (command === "exec") {
      const name = args.find((value) => this.containers.has(value)) ?? "";
      const killed = new Promise<void>((resolve) => {
        this.#kill = resolve;
      });
      return this.onExec({ args, artifactsDir: this.containers.get(name)?.artifactsDir ?? "", options, killed });
    }
    if (command === "stats") {
      const frame = '\u001b[H{"CPUPerc":"95.00%","MemPerc":"5.00%","MemUsage":"100MiB / 2GiB","PIDs":"4"}\n';
      while (!options.signal?.aborted) {
        options.onOutput?.("stdout", frame);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { ...ok(), aborted: true };
    }
    if (command === "kill") {
      this.#kill?.();
      return ok();
    }
    if (command === "rm") {
      const name = args.at(-1) ?? "";
      return this.containers.delete(name) ? ok() : failed(1, `Error: No such container: ${name}`);
    }
    if (command === "ps") {
      const filter = args[args.indexOf("--filter") + 1]?.replace(/^label=/u, "") ?? "";
      const [, wantedLab] = filter.split("=");
      const lines = [...this.containers.entries()]
        .filter(([, value]) => !wantedLab || value.labId === wantedLab)
        .map(([name, value]) => `${name}\t${value.labId}\t${value.runId}`);
      return ok(lines.join("\n"));
    }
    return failed(1, `unexpected docker command ${command}`);
  }
}

let workspace: string;
let runtime: FakeRuntime;
let events: LabEventInput[];
let manager: LabManager;

async function spec(overrides: Partial<LabSpec> = {}): Promise<LabSpec> {
  const runner = join(workspace, "runner.py");
  await writeFile(runner, "print('hello')\n");
  return {
    runId: "run_test",
    image: "dejaml/python-cpu:0.1.0",
    expectedImageId: IMAGE_ID,
    workdir: "/workspace/case",
    artifactsDir: "artifacts",
    inputs: [
      {
        hostPath: runner,
        containerPath: "runner.py",
        sha256: "a3c2f8bd2b8a44d3fd76c4a6c0d9c09e7d1e3c3d8d6a3c65a3aa0b9d5c0fb09f",
      },
    ],
    resources: { cpus: 2, memoryMb: 2048, pids: 128, timeoutSeconds: 1, networkDuringRun: false },
    limits: DEFAULT_LAB_LIMITS,
    ...overrides,
  };
}

async function validSpec(): Promise<LabSpec> {
  const base = await spec();
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update("print('hello')\n").digest("hex");
  return { ...base, inputs: [{ ...base.inputs[0]!, sha256: digest }] };
}

const command = {
  executable: "python",
  args: ["runner.py", "--output", "artifacts/result.json"],
  cwd: "/workspace/case",
  env: {},
};

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dejaml-lab-test-"));
  runtime = new FakeRuntime();
  events = [];
  manager = new LabManager({
    runtime,
    labRoot: join(workspace, "labs"),
    events: (event) => events.push(event),
  });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("LabManager", () => {
  it("creates an isolated lab with the approved limits and read-only inputs", async () => {
    const lab = await manager.createLab(await validSpec());
    const create = runtime.calls.find((call) => call[0] === "create") ?? [];
    const joined = create.join(" ");

    expect(lab.imageId).toBe(IMAGE_ID);
    expect(joined).toContain("--network none");
    expect(joined).toContain("--read-only");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--cpus 2");
    expect(joined).toContain("--memory 2048m --memory-swap 2048m");
    expect(joined).toContain("--pids-limit 128");
    expect(joined).toMatch(/dst=\/workspace\/case\/runner\.py,readonly/u);
    expect(joined).toMatch(/dst=\/workspace\/case\/artifacts(?!,readonly)/u);
    expect(joined).not.toContain("docker.sock");
    expect(manager.state(lab.labId)).toBe("ready");
  });

  it("refuses an image whose identity differs from the pinned image", async () => {
    runtime.imageId = `sha256:${"b".repeat(64)}`;
    await expect(manager.createLab(await validSpec())).rejects.toMatchObject({ code: "image_mismatch" });
    expect(runtime.calls.some((call) => call[0] === "create")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "lab_create", status: "failed" });
  });

  it("refuses a root image and an execution adapter whose digest changed", async () => {
    runtime.imageUser = "root";
    await expect(manager.createLab(await validSpec())).rejects.toMatchObject({ code: "image_root_user" });
    runtime.imageUser = "10001:10001";
    await expect(manager.createLab(await spec())).rejects.toMatchObject({ code: "input_digest_mismatch" });
  });

  it("runs an attempt, records artifact digests, and exports the metric artifact", async () => {
    runtime.onExec = async ({ artifactsDir, options }) => {
      options.onOutput?.("stdout", "accuracy 79.88\n");
      await writeFile(join(artifactsDir, "result.json"), '{"metrics":{"accuracyPercent":79.88}}');
      return ok("accuracy 79.88\n");
    };
    const lab = await manager.createLab(await validSpec());
    const chunks: string[] = [];
    const outcome = await manager.executeAttempt(lab.labId, {
      number: 1,
      label: "baseline",
      command,
      onOutput: (_, chunk) => chunks.push(chunk),
    });

    expect(outcome.attempt).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(Object.keys(outcome.attempt.artifactDigests)).toEqual(["artifacts/result.json"]);
    expect(chunks).toEqual(["accuracy 79.88\n"]);
    const artifact = await manager.readArtifact(lab.labId, "artifacts/result.json");
    expect(JSON.parse(artifact.content.toString("utf8"))).toEqual({ metrics: { accuracyPercent: 79.88 } });
    expect(artifact.sha256).toBe(outcome.attempt.artifactDigests["artifacts/result.json"]);

    const receipt = await manager.destroyLab(lab.labId);
    expect(receipt).toMatchObject({ containerRemoved: true, artifactDirectoryRemoved: true, verifiedAbsent: true });
    expect(await readdir(join(workspace, "labs"))).toEqual([]);
    for (const event of events) {
      expect(() =>
        RunEventSchema.parse({ ...event, id: "evt", sequence: 1, timestamp: new Date().toISOString() }),
      ).not.toThrow();
    }
  });

  it("kills the lab when the wall-time limit is reached", async () => {
    runtime.onExec = async ({ killed }) => {
      await killed;
      return failed(137, "");
    };
    const lab = await manager.createLab(await validSpec());
    const outcome = await manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command });

    expect(outcome.attempt).toMatchObject({ timedOut: true, cancelled: false, exitCode: null });
    expect(runtime.calls.some((call) => call[0] === "kill")).toBe(true);
    expect(manager.state(lab.labId)).toBe("timed_out");
    await expect(
      manager.executeAttempt(lab.labId, { number: 2, label: "baseline", command }),
    ).rejects.toMatchObject({ code: "lab_state" });
    expect((await manager.destroyLab(lab.labId, "timed out")).verifiedAbsent).toBe(true);
  });

  it("cancels a running attempt and preserves the partial logs", async () => {
    runtime.onExec = async ({ killed }) => {
      await killed;
      return { ...failed(137, ""), stdout: { text: "epoch 1\n", bytes: 8, truncated: false } };
    };
    const lab = await manager.createLab(await validSpec());
    const running = manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.cancelLab(lab.labId);
    const outcome = await running;

    expect(outcome.attempt).toMatchObject({ cancelled: true, timedOut: false });
    expect(outcome.stdout.text).toBe("epoch 1\n");
    expect(manager.state(lab.labId)).toBe("cancelled");
  });

  it("rejects commands that leave the workspace or smuggle loader variables", async () => {
    const lab = await manager.createLab(await validSpec());
    await expect(
      manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: { ...command, cwd: "/etc" } }),
    ).rejects.toMatchObject({ code: "command_rejected" });
    await expect(
      manager.executeAttempt(lab.labId, {
        number: 1,
        label: "baseline",
        command: { ...command, executable: "/bin/sh" },
      }),
    ).rejects.toMatchObject({ code: "command_rejected" });
    await expect(
      manager.executeAttempt(lab.labId, {
        number: 1,
        label: "baseline",
        command: { ...command, env: { LD_PRELOAD: "/tmp/x.so" } },
      }),
    ).rejects.toMatchObject({ code: "command_rejected" });
  });

  it("refuses artifact paths outside the artifact directory and symlinks", async () => {
    runtime.onExec = async ({ artifactsDir }) => {
      await symlink("/etc/passwd", join(artifactsDir, "link.txt"));
      return ok();
    };
    const lab = await manager.createLab(await validSpec());
    await manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command });

    await expect(manager.readArtifact(lab.labId, "runner.py")).rejects.toMatchObject({ code: "artifact_rejected" });
    await expect(manager.readArtifact(lab.labId, "artifacts/../runner.py")).rejects.toThrow();
    await expect(manager.readArtifact(lab.labId, "artifacts/link.txt")).rejects.toMatchObject({
      code: "artifact_rejected",
    });
  });

  it("fails the attempt when artifacts exceed the size limit", async () => {
    runtime.onExec = async ({ artifactsDir }) => {
      await writeFile(join(artifactsDir, "big.bin"), Buffer.alloc(2048));
      return ok();
    };
    const lab = await manager.createLab({
      ...(await validSpec()),
      limits: { ...DEFAULT_LAB_LIMITS, maxArtifactBytes: 1024 },
    });
    await expect(
      manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command }),
    ).rejects.toMatchObject({ code: "artifact_limit" });
    expect(manager.state(lab.labId)).toBe("failed");
  });

  it("rejects install preparation steps because labs stay offline", async () => {
    const lab = await manager.createLab(await validSpec());
    await expect(
      manager.prepareLab(lab.labId, [{ kind: "install", description: "pip install extra" }]),
    ).rejects.toMatchObject({ code: "preparation_rejected" });
  });

  it("destroys the lab even when the work inside withLab throws", async () => {
    await expect(
      manager.withLab(await validSpec(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(runtime.containers.size).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "lab_cleanup", status: "completed" });
  });

  it("removes orphan labs left behind by another process", async () => {
    const other = new LabManager({ runtime, labRoot: join(workspace, "labs") });
    await other.createLab(await validSpec());
    const mine = await manager.createLab(await validSpec());

    const receipts = await manager.cleanupOrphans();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ reason: "orphan cleanup", verifiedAbsent: true });
    expect(runtime.containers.size).toBe(1);
    expect(manager.state(mine.labId)).toBe("ready");
  });

  it("publishes live output, telemetry, and artifact changes while observing an attempt", async () => {
    runtime.onExec = async ({ artifactsDir, options }) => {
      options.onOutput?.("stdout", "loading data\n\u001b[32mtraining\u001b[0m\n");
      await new Promise((resolve) => setTimeout(resolve, 60));
      await writeFile(join(artifactsDir, "result.json"), "{}");
      await new Promise((resolve) => setTimeout(resolve, 60));
      options.onOutput?.("stdout", "accuracy 79.88");
      return ok("loading data\ntraining\naccuracy 79.88");
    };
    const lab = await manager.createLab(await validSpec());
    await manager.executeAttempt(lab.labId, {
      number: 1,
      label: "baseline",
      command,
      observe: { flushIntervalMs: 10, telemetryIntervalMs: 20, artifactIntervalMs: 20 },
    });

    const output = events.filter((event) => event.type === "lab_output");
    expect(output.flatMap((event) => event.publicPayload.lines as string[])).toEqual([
      "loading data",
      "training",
      "accuracy 79.88",
    ]);
    const telemetry = events.find((event) => event.type === "lab_telemetry");
    expect(telemetry?.publicPayload).toMatchObject({ cpuPercent: 95, pids: 4, limits: { cpus: 2, memoryMb: 2048 } });
    expect(events.filter((event) => event.type === "artifact_changed").map((event) => event.summary)).toEqual([
      "Created artifacts/result.json",
    ]);
    const attemptDone = events.findIndex((event) => event.type === "attempt" && event.status === "completed");
    expect(events.findLastIndex((event) => event.type === "lab_output")).toBeLessThan(attemptDone);
  });
});
