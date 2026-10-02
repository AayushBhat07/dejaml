import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunEventSchema } from "@dejaml/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forbiddenMountReason, isCredentialEnvKey, LabManager, type LabEventInput } from "./manager.js";
import { DockerCliRuntime, type ContainerRuntime, type RuntimeCommandOptions, type RuntimeCommandResult } from "./runtime.js";
import { DEFAULT_LAB_LIMITS, DEFAULT_LAB_TMPFS_MB, type LabSpec } from "./spec.js";

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
  imagePresent = true;
  /** A daemon failure other than "no such image". */
  imageInspectError: string | null = null;
  /** What a plain `image inspect` reports; a multi-platform store reports the daemon default. */
  imagePlatform = "linux/amd64";
  /** Platforms whose content is present locally (answered by `image inspect --platform`). */
  platformsPresent = new Set(["linux/amd64"]);
  imageEnv = ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "HOME=/tmp", "PYTHONUNBUFFERED=1"];
  /** Overrides applied to the created container's inspect output, to simulate a daemon that ignored a flag. */
  containerOverrides: Record<string, unknown> = {};
  onExec: ExecHandler = async () => ok("done\n");
  readonly containers = new Map<
    string,
    { labId: string; runId: string; platform: string; image: string; artifactsDir: string; args: string[] }
  >();
  #kill: (() => void) | null = null;

  async docker(args: readonly string[], options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    this.calls.push([...args]);
    const [command] = args;
    if (command === "image") {
      if (this.imageInspectError) return failed(1, this.imageInspectError);
      if (!this.imagePresent) return failed(1, `Error response from daemon: No such image: ${args.at(-1)}`);
      const platformIndex = args.indexOf("--platform");
      const platform = platformIndex > 0 ? (args[platformIndex + 1] ?? "") : this.imagePlatform;
      const [os = "", architecture = ""] = platformIndex > 0 && !this.platformsPresent.has(platform) ? [] : platform.split("/");
      return ok(
        `${JSON.stringify({
          Id: this.imageId,
          Os: os,
          Architecture: architecture,
          RepoDigests: [`dejaml/python-cpu@sha256:${"d".repeat(64)}`],
          Config: { User: this.imageUser, Env: this.imageEnv },
        })}\n`,
      );
    }
    if (command === "container") {
      const container = this.containers.get(args.at(-1) ?? "");
      if (!container) return failed(1, "Error: No such container");
      const flag = (name: string): string[] =>
        container.args.flatMap((value, index) => (container.args[index - 1] === name ? [value] : []));
      const [os, architecture] = container.platform.split("/");
      return ok(
        JSON.stringify({
          Image: container.image,
          ImageManifestDescriptor: { digest: `sha256:${"e".repeat(64)}`, platform: { os, architecture } },
          Config: { User: this.imageUser, Env: this.imageEnv },
          HostConfig: {
            NetworkMode: flag("--network")[0] ?? "bridge",
            ReadonlyRootfs: container.args.includes("--read-only"),
            CapDrop: flag("--cap-drop"),
            CapAdd: null,
            SecurityOpt: flag("--security-opt"),
            Privileged: container.args.includes("--privileged"),
          },
          Mounts: flag("--mount").map((mount) => ({
            Source: /src=([^,]+)/u.exec(mount)?.[1],
            Destination: /dst=([^,]+)/u.exec(mount)?.[1],
            RW: !mount.includes(",readonly"),
          })),
          ...this.containerOverrides,
        }),
      );
    }
    if (command === "create") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      const labels = args.flatMap((value, index) => (args[index - 1] === "--label" ? [value] : []));
      const artifactMount = args.find((value) => value.includes("dst=/workspace/case/artifacts")) ?? "";
      this.containers.set(name, {
        labId: labels[0]?.split("=")[1] ?? "",
        runId: labels[1]?.split("=")[1] ?? "",
        platform: args[args.indexOf("--platform") + 1] ?? "",
        image: this.imageId,
        artifactsDir: /src=([^,]+)/u.exec(artifactMount)?.[1] ?? "",
        args: [...args],
      });
      return ok();
    }
    if (command === "start") return ok();
    if (command === "exec") {
      if (args.some((value) => value.includes("DEJAML_CLEANUP_NORMALIZE"))) return ok();
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
        .map(([name, value]) => `${name}\t${value.labId}\t${value.runId}\t${value.platform}\t${value.image}`);
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
    platform: "linux/amd64",
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
    expect(runtime.calls.some((call) => call.some((value) => value.includes("DEJAML_CLEANUP_NORMALIZE")))).toBe(true);
    expect(await readdir(join(workspace, "labs"))).toEqual([]);
    for (const event of events) {
      expect(() => RunEventSchema.parse({ ...event, id: "evt", sequence: 1, timestamp: new Date().toISOString() })).not.toThrow();
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
    await expect(manager.executeAttempt(lab.labId, { number: 2, label: "baseline", command })).rejects.toMatchObject({ code: "lab_state" });
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
    await expect(manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command })).rejects.toMatchObject({
      code: "artifact_limit",
    });
    expect(manager.state(lab.labId)).toBe("failed");
  });

  it("rejects install preparation steps because labs stay offline", async () => {
    const lab = await manager.createLab(await validSpec());
    await expect(manager.prepareLab(lab.labId, [{ kind: "install", description: "pip install extra" }])).rejects.toMatchObject({
      code: "preparation_rejected",
    });
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
    expect(output.flatMap((event) => event.publicPayload.lines as string[])).toEqual(["loading data", "training", "accuracy 79.88"]);
    const telemetry = events.find((event) => event.type === "lab_telemetry");
    expect(telemetry?.publicPayload).toMatchObject({ cpuPercent: 95, pids: 4, limits: { cpus: 2, memoryMb: 2048 } });
    // The polling observer may also catch the file between truncate and write,
    // producing a legitimate later "Updated" event. Creation must always be visible.
    expect(events.filter((event) => event.type === "artifact_changed").map((event) => event.summary)).toContain(
      "Created artifacts/result.json",
    );
    const attemptDone = events.findIndex((event) => event.type === "attempt" && event.status === "completed");
    expect(events.findLastIndex((event) => event.type === "lab_output")).toBeLessThan(attemptDone);
  });
});

describe("sealed labs on an explicit platform", () => {
  const createArgs = (): string[] => runtime.calls.find((call) => call[0] === "create") ?? [];

  it("creates the lab for the spec's platform, never pulls, and records the image identity", async () => {
    const lab = await manager.createLab(await validSpec());
    const create = createArgs().join(" ");

    expect(create).toContain("--platform linux/amd64");
    expect(create).toContain("--pull never");
    expect(create).toContain("--label dejaml.platform=linux/amd64");
    expect(lab).toMatchObject({ platform: "linux/amd64", imageId: IMAGE_ID, imageDigest: `sha256:${"e".repeat(64)}` });
    // The container is audited after creation and before it starts.
    const audit = runtime.calls.findIndex((call) => call[0] === "container" && call[1] === "inspect");
    const start = runtime.calls.findIndex((call) => call[0] === "start");
    expect(audit).toBeGreaterThan(runtime.calls.findIndex((call) => call[0] === "create"));
    expect(audit).toBeLessThan(start);
    const created = events.find((event) => event.type === "lab_create" && event.status === "completed");
    expect(created?.publicPayload).toMatchObject({
      platform: "linux/amd64",
      sealed: { network: "none", readOnlyRoot: true, capDrop: "ALL", noNewPrivileges: true, dockerSocketMounted: false },
    });

    const receipt = await manager.destroyLab(lab.labId);
    expect(receipt).toMatchObject({ platform: "linux/amd64", imageId: IMAGE_ID, imageDigest: `sha256:${"e".repeat(64)}` });
  });

  it("requires a valid platform in the spec", async () => {
    const { platform: _omitted, ...withoutPlatform } = await validSpec();
    await expect(manager.createLab(withoutPlatform as LabSpec)).rejects.toThrow();
    await expect(manager.createLab({ ...(await validSpec()), platform: "linux/s390x" as never })).rejects.toThrow();
    expect(runtime.calls).toEqual([]);
  });

  it("refuses an image built for another platform before creating anything", async () => {
    runtime.imagePlatform = "linux/arm64";
    runtime.platformsPresent = new Set(["linux/arm64"]);
    await expect(manager.createLab(await validSpec())).rejects.toMatchObject({ code: "platform_mismatch" });
    expect(runtime.calls.some((call) => call[0] === "create")).toBe(false);
  });

  it("accepts the requested variant of a multi-platform local image", async () => {
    runtime.platformsPresent = new Set(["linux/amd64", "linux/arm64"]);
    const lab = await manager.createLab({ ...(await validSpec()), platform: "linux/arm64" });
    expect(lab.platform).toBe("linux/arm64");
    expect(createArgs().join(" ")).toContain("--platform linux/arm64");
    expect(runtime.calls.some((call) => call[0] === "image" && call.includes("--platform"))).toBe(true);
  });

  it("removes a created container that runs another platform's image", async () => {
    runtime.containerOverrides = {
      ImageManifestDescriptor: { digest: `sha256:${"f".repeat(64)}`, platform: { os: "linux", architecture: "arm64" } },
    };
    await expect(manager.createLab(await validSpec())).rejects.toMatchObject({ code: "lab_not_sealed" });
    expect(runtime.calls.some((call) => call[0] === "start")).toBe(false);
    expect(runtime.containers.size).toBe(0);
    expect(await readdir(join(workspace, "labs"))).toEqual([]);
  });

  it("refuses a container whose effective configuration is not sealed", async () => {
    const sealedHost = { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] };
    for (const override of [
      { HostConfig: { ...sealedHost, NetworkMode: "bridge" } },
      { HostConfig: { ...sealedHost, NetworkMode: "host" } },
      { HostConfig: { ...sealedHost, ReadonlyRootfs: false } },
      { HostConfig: { ...sealedHost, CapDrop: [] } },
      { HostConfig: { ...sealedHost, CapAdd: ["NET_ADMIN"] } },
      { HostConfig: { ...sealedHost, SecurityOpt: [] } },
      { HostConfig: { ...sealedHost, Privileged: true } },
      { Mounts: [{ Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }] },
      { Mounts: [{ Source: "/srv/data", Destination: "/workspace/case/data", RW: true }] },
      { Config: { User: "10001:10001", Env: ["GITHUB_TOKEN=x"] } },
      { Config: { User: "0:0", Env: [] } },
      { Image: `sha256:${"9".repeat(64)}` },
    ]) {
      runtime.containerOverrides = override;
      await expect(manager.createLab(await validSpec())).rejects.toMatchObject({ code: "lab_not_sealed" });
      expect(runtime.containers.size).toBe(0);
    }
    expect(runtime.calls.some((call) => call[0] === "start")).toBe(false);
  });

  it("reports a missing image as missing and other daemon failures as they are", async () => {
    runtime.imagePresent = false;
    await expect(manager.createLab(await validSpec())).rejects.toMatchObject({ code: "image_missing" });
    runtime.imageInspectError = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock";
    await expect(manager.createLab(await validSpec())).rejects.toMatchObject({ code: "runtime_error" });
  });

  it("never passes host credentials into the container", async () => {
    const secrets = {
      DEJAML_OPENAI_API_KEY: "sk-test-openai-never-in-lab",
      AWS_SECRET_ACCESS_KEY: "aws-secret-never-in-lab",
      AWS_ACCESS_KEY_ID: "AKIANEVERINLAB",
      GITHUB_TOKEN: "ghp_never_in_lab",
    };
    const saved = Object.fromEntries(Object.keys(secrets).map((key) => [key, process.env[key]]));
    Object.assign(process.env, secrets);
    try {
      const lab = await manager.createLab(await validSpec());
      await manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command });
      const everything = runtime.calls.flat().join("\n");
      for (const [key, value] of Object.entries(secrets)) {
        expect(everything).not.toContain(key);
        expect(everything).not.toContain(value);
      }
      expect(createArgs().some((arg) => arg === "--env" || arg === "-e" || arg.startsWith("--env-file"))).toBe(false);
      // The Docker CLI itself runs with a minimal environment, so it has nothing to forward.
      const cliEnv = await new DockerCliRuntime("env").docker([]);
      for (const [key, value] of Object.entries(secrets)) {
        expect(cliEnv.stdout.text).not.toContain(key);
        expect(cliEnv.stdout.text).not.toContain(value);
      }
      const created = events.find((event) => event.type === "lab_create" && event.status === "completed");
      expect((created?.publicPayload.sealed as { envKeys: string[] }).envKeys).toEqual(["PATH", "LANG", "HOME", "PYTHONUNBUFFERED"]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("refuses images and commands that carry credential-like variables", async () => {
    runtime.imageEnv = ["PATH=/usr/bin", "AWS_ACCESS_KEY_ID=AKIA"];
    await expect(manager.createLab(await validSpec())).rejects.toMatchObject({ code: "image_env_rejected" });
    runtime.imageEnv = ["PATH=/usr/bin"];
    const lab = await manager.createLab(await validSpec());
    for (const key of ["GITHUB_TOKEN", "OPENAI_API_KEY", "DEJAML_OPENAI_API_KEY", "AWS_REGION", "HF_TOKEN", "DB_PASSWORD"]) {
      await expect(
        manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: { ...command, env: { [key]: "x" } } }),
      ).rejects.toMatchObject({ code: "command_rejected" });
    }
    expect(isCredentialEnvKey("TOKENIZERS_PARALLELISM")).toBe(false);
    expect(isCredentialEnvKey("OMP_NUM_THREADS")).toBe(false);
    const outcome = await manager.executeAttempt(lab.labId, {
      number: 1,
      label: "baseline",
      command: { ...command, env: { TOKENIZERS_PARALLELISM: "false" } },
    });
    expect(outcome.attempt.exitCode).toBe(0);
  });

  it("refuses to mount the Docker socket, host system trees, or credential directories", async () => {
    expect(forbiddenMountReason("/var/run/docker.sock")).toMatch(/protected/u);
    expect(forbiddenMountReason("/run/docker.sock")).toMatch(/protected/u);
    expect(forbiddenMountReason("/var")).toMatch(/contains/u);
    expect(forbiddenMountReason("/")).toMatch(/contains/u);
    expect(forbiddenMountReason("/proc/1/root")).toMatch(/inside \/proc/u);
    expect(forbiddenMountReason("/etc")).toMatch(/inside \/etc/u);
    expect(forbiddenMountReason("/home/user/.aws/credentials", "/home/user")).toMatch(/protected/u);
    expect(forbiddenMountReason("/home/user", "/home/user")).toMatch(/contains/u);
    expect(forbiddenMountReason("/home/user/research/repo", "/home/user")).toBeNull();
    expect(forbiddenMountReason(workspace)).toBeNull();

    const base = await validSpec();
    await expect(
      manager.createLab({ ...base, inputs: [...base.inputs, { hostPath: "/etc", containerPath: "data/etc" }] }),
    ).rejects.toMatchObject({ code: "input_rejected" });
    expect(runtime.calls.some((call) => call[0] === "create")).toBe(false);
  });

  it("sizes /tmp from the spec's limits", async () => {
    await manager.createLab(await validSpec());
    expect(createArgs().join(" ")).toContain(`size=${DEFAULT_LAB_TMPFS_MB}m`);
    runtime.calls.length = 0;
    await manager.createLab({ ...(await validSpec()), limits: { ...DEFAULT_LAB_LIMITS, tmpfsMb: 512 } });
    expect(createArgs().join(" ")).toContain("/tmp:rw,noexec,nosuid,nodev,size=512m");
  });

  it("kills an idle lab when its overall lifetime ends", async () => {
    const lab = await manager.createLab({ ...(await validSpec()), limits: { ...DEFAULT_LAB_LIMITS, labTimeoutSeconds: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(manager.state(lab.labId)).toBe("timed_out");
    expect(runtime.calls.some((call) => call[0] === "kill")).toBe(true);
    expect(events.some((event) => event.type === "lab_timeout")).toBe(true);
    await expect(manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command })).rejects.toMatchObject({
      code: "lab_state",
    });
    expect((await manager.destroyLab(lab.labId)).verifiedAbsent).toBe(true);
  });

  it("stops a running command when the lab's lifetime ends before the command's own limit", async () => {
    runtime.onExec = async ({ killed }) => {
      await killed;
      return failed(137, "");
    };
    const lab = await manager.createLab({
      ...(await validSpec()),
      resources: { cpus: 2, memoryMb: 2048, pids: 128, timeoutSeconds: 60, networkDuringRun: false },
      limits: { ...DEFAULT_LAB_LIMITS, labTimeoutSeconds: 1 },
    });
    const outcome = await manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command });
    expect(outcome.attempt).toMatchObject({ timedOut: true, exitCode: null });
    expect(outcome.durationMs).toBeLessThan(10_000);
    expect(manager.state(lab.labId)).toBe("timed_out");
  });

  it("clears the lifetime timer when the lab is destroyed", async () => {
    const lab = await manager.createLab({ ...(await validSpec()), limits: { ...DEFAULT_LAB_LIMITS, labTimeoutSeconds: 1 } });
    await manager.destroyLab(lab.labId);
    const kills = runtime.calls.filter((call) => call[0] === "kill").length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(runtime.calls.filter((call) => call[0] === "kill").length).toBe(kills);
    expect(events.some((event) => event.type === "lab_timeout")).toBe(false);
  });

  it("records the platform and image of orphans it removes", async () => {
    const other = new LabManager({ runtime, labRoot: join(workspace, "labs") });
    await other.createLab(await validSpec());
    const [receipt] = await manager.cleanupOrphans();
    expect(receipt).toMatchObject({ platform: "linux/amd64", imageId: IMAGE_ID, verifiedAbsent: true });
  });

  it("waits for an in-flight image preparation before inspecting the image", async () => {
    let release: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waited: string[] = [];
    const waiting = new LabManager({
      runtime,
      labRoot: join(workspace, "labs"),
      images: {
        whenSettled: async (reference, platform) => {
          waited.push(`${reference} ${platform}`);
          await settled;
        },
      },
    });
    const creating = waiting.createLab(await validSpec());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.calls.some((call) => call[0] === "image")).toBe(false);
    release();
    await creating;
    expect(waited).toEqual(["dejaml/python-cpu:0.1.0 linux/amd64"]);
  });
});
