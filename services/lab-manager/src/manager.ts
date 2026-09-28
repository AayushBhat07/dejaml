import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";

import {
  ArgvCommandSchema,
  AttemptSchema,
  PreparationStepSchema,
  type Attempt,
  type EvidencePointerSchema,
  type RunEvent,
} from "@dejaml/contracts";
import type { z } from "zod";

import {
  type BoundedText,
  type ContainerRuntime,
  type OutputStream,
  type RuntimeCommandResult,
  DockerCliRuntime,
} from "./runtime.js";
import { LabSpecSchema, WorkspaceRelativePathSchema, type LabSpec } from "./spec.js";

export const LAB_LABEL = "dejaml.lab";
export const RUN_LABEL = "dejaml.run";
const CONTAINER_PREFIX = "dejaml-lab-";
const LAB_ID_PATTERN = /^lab_[a-f0-9]{32}$/u;
const EXECUTABLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const FORBIDDEN_ENV_PREFIXES = ["LD_", "DYLD_"];
const FORBIDDEN_ENV_KEYS = new Set(["PATH", "HOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME"]);
/** Grace period for the Docker CLI to return after the container has been killed. */
const KILL_GRACE_MS = 10_000;

export type LabEventInput = Omit<RunEvent, "id" | "sequence" | "timestamp">;
export type LabEventSink = (event: LabEventInput) => unknown;
type EvidencePointer = z.infer<typeof EvidencePointerSchema>;

export type LabState =
  | "ready"
  | "preparing"
  | "running"
  | "idle"
  | "cancelled"
  | "timed_out"
  | "failed"
  | "destroyed";

export type LabHandle = {
  labId: string;
  runId: string;
  containerName: string;
  image: string;
  imageId: string;
  createdAt: string;
};

export type AttemptRequest = {
  number: number;
  label: "baseline" | "modified";
  command: z.input<typeof ArgvCommandSchema>;
  changes?: string[];
  onOutput?: (stream: OutputStream, chunk: string) => void;
};

export type AttemptOutcome = {
  attempt: Attempt;
  stdout: BoundedText;
  stderr: BoundedText;
  durationMs: number;
  artifacts: ArtifactSummary[];
};

export type ArtifactSummary = {
  path: string;
  bytes: number;
  sha256: string;
};

export type ArtifactContent = ArtifactSummary & {
  content: Buffer;
};

export type PreparationRecord = {
  step: z.infer<typeof PreparationStepSchema>;
  exitCode: number | null;
  stdout: BoundedText;
  stderr: BoundedText;
};

export type CleanupReceipt = {
  labId: string;
  runId: string;
  containerName: string;
  reason: string;
  containerRemoved: boolean;
  artifactDirectoryRemoved: boolean;
  verifiedAbsent: boolean;
  destroyedAt: string;
  errors: string[];
};

type LabRecord = {
  handle: LabHandle;
  spec: LabSpec;
  state: LabState;
  hostArtifactsDir: string;
  hostLabDir: string;
  activeAbort: AbortController | null;
  killReason: "cancelled" | "timed_out" | null;
  receipt: CleanupReceipt | null;
};

export type LabManagerOptions = {
  runtime?: ContainerRuntime;
  /** Host directory that holds one private subdirectory per lab. */
  labRoot?: string;
  events?: LabEventSink;
  now?: () => Date;
};

export class LabError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LabError";
    this.code = code;
  }
}

export class LabManager {
  readonly #runtime: ContainerRuntime;
  readonly #labRoot: string;
  readonly #events: LabEventSink | undefined;
  readonly #now: () => Date;
  readonly #labs = new Map<string, LabRecord>();

  constructor(options: LabManagerOptions = {}) {
    this.#runtime = options.runtime ?? new DockerCliRuntime();
    this.#labRoot = resolve(options.labRoot ?? join(tmpdir(), "dejaml-labs"));
    this.#events = options.events;
    this.#now = options.now ?? (() => new Date());
  }

  state(labId: string): LabState {
    return this.#lab(labId).state;
  }

  async createLab(input: LabSpec): Promise<LabHandle> {
    const spec = LabSpecSchema.parse(input);
    const labId = `lab_${randomUUID().replaceAll("-", "")}`;
    const containerName = `${CONTAINER_PREFIX}${labId.slice(4)}`;
    this.#emit(spec.runId, "lab_create", "started", "Preparing a disposable CPU research lab", {
      labId,
      image: spec.image,
    });

    let hostLabDir: string | null = null;
    let created = false;
    try {
      const imageId = await this.#verifyImage(spec);
      for (const labInput of spec.inputs) await this.#verifyInput(labInput);

      await mkdir(this.#labRoot, { recursive: true, mode: 0o700 });
      hostLabDir = await mkdtemp(join(this.#labRoot, `${labId}-`));
      const hostArtifactsDir = join(hostLabDir, "artifacts");
      await mkdir(hostArtifactsDir);
      // The lab user (UID 10001) must write here; the private parent keeps other host users out.
      await chmod(hostArtifactsDir, 0o777);

      const args = [
        "create",
        "--name", containerName,
        "--label", `${LAB_LABEL}=${labId}`,
        "--label", `${RUN_LABEL}=${spec.runId}`,
        "--init",
        "--network", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--cpus", String(spec.resources.cpus),
        "--memory", `${spec.resources.memoryMb}m`,
        "--memory-swap", `${spec.resources.memoryMb}m`,
        "--pids-limit", String(spec.resources.pids),
        "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${spec.limits.tmpfsMb}m,uid=10001,gid=10001,mode=1777`,
        "--workdir", spec.workdir,
        ...spec.inputs.flatMap((labInput) => [
          "--mount",
          mountArgument(labInput.hostPath, posix.join(spec.workdir, labInput.containerPath), true),
        ]),
        "--mount",
        mountArgument(hostArtifactsDir, posix.join(spec.workdir, spec.artifactsDir), false),
        "--entrypoint", "sleep",
        spec.image,
        "infinity",
      ];
      await this.#docker(args, "container create");
      created = true;
      await this.#docker(["start", containerName], "container start");

      const handle: LabHandle = {
        labId,
        runId: spec.runId,
        containerName,
        image: spec.image,
        imageId,
        createdAt: this.#now().toISOString(),
      };
      this.#labs.set(labId, {
        handle,
        spec,
        state: "ready",
        hostArtifactsDir,
        hostLabDir,
        activeAbort: null,
        killReason: null,
        receipt: null,
      });
      this.#emit(spec.runId, "lab_create", "completed", "Disposable CPU lab is ready", {
        labId,
        image: spec.image,
        imageId,
        network: "none",
        readOnlyRoot: true,
        resources: spec.resources,
      });
      return handle;
    } catch (error) {
      if (created) {
        await this.#runtime.docker(["rm", "--force", "--volumes", containerName]).catch(() => undefined);
      }
      if (hostLabDir) await rm(hostLabDir, { recursive: true, force: true }).catch(() => undefined);
      this.#emit(spec.runId, "lab_create", "failed", "The lab could not be created", {
        labId,
        reason: errorMessage(error),
      });
      throw error;
    }
  }

  async prepareLab(
    labId: string,
    steps: ReadonlyArray<z.input<typeof PreparationStepSchema>>,
  ): Promise<PreparationRecord[]> {
    const lab = this.#lab(labId);
    this.#requireState(lab, ["ready"]);
    const records: PreparationRecord[] = [];
    lab.state = "preparing";
    try {
      for (const rawStep of steps) {
        const step = PreparationStepSchema.parse(rawStep);
        if (step.kind === "install") {
          throw new LabError(
            "preparation_rejected",
            "install steps need network access, which labs never receive after creation",
          );
        }
        if (!step.command) {
          records.push({ step, exitCode: null, stdout: emptyText(), stderr: emptyText() });
          this.#emit(lab.handle.runId, "lab_prepare", "progress", step.description, {
            labId,
            kind: step.kind,
          });
          continue;
        }
        const command = { ...step.command, env: {} };
        this.#validateCommand(lab, command);
        const result = await this.#execInLab(lab, command, lab.spec.resources.timeoutSeconds);
        records.push({ step, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
        if (lab.killReason || result.exitCode !== 0) {
          this.#emit(lab.handle.runId, "lab_prepare", "failed", `Preparation failed: ${step.description}`, {
            labId,
            kind: step.kind,
            exitCode: result.exitCode,
            reason: lab.killReason,
          });
          lab.state = lab.killReason ?? "failed";
          return records;
        }
        this.#emit(lab.handle.runId, "lab_prepare", "progress", step.description, {
          labId,
          kind: step.kind,
          exitCode: result.exitCode,
        });
      }
      lab.state = "ready";
      this.#emit(lab.handle.runId, "lab_prepare", "completed", `Recorded ${records.length} preparation step(s)`, {
        labId,
        steps: records.length,
      });
      return records;
    } catch (error) {
      if (lab.state === "preparing") lab.state = "failed";
      throw error;
    }
  }

  async executeAttempt(labId: string, request: AttemptRequest): Promise<AttemptOutcome> {
    const lab = this.#lab(labId);
    this.#requireState(lab, ["ready", "idle"]);
    const command = ArgvCommandSchema.parse(request.command);
    this.#validateCommand(lab, command);

    const attemptId = `${lab.handle.runId}:attempt-${request.number}`;
    const startedAt = this.#now();
    lab.state = "running";
    this.#emit(lab.handle.runId, "attempt", "started", `Running ${request.label} attempt ${request.number}`, {
      labId,
      attemptId,
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      timeoutSeconds: lab.spec.resources.timeoutSeconds,
    });

    let result: RuntimeCommandResult;
    try {
      result = await this.#execInLab(
        lab,
        command,
        lab.spec.resources.timeoutSeconds,
        request.onOutput,
      );
    } catch (error) {
      lab.state = "failed";
      this.#emit(lab.handle.runId, "attempt", "failed", "The attempt could not be started", {
        labId,
        attemptId,
        reason: errorMessage(error),
      });
      throw error;
    }
    const endedAt = this.#now();
    const timedOut = lab.killReason === "timed_out";
    const cancelled = lab.killReason === "cancelled";
    let artifacts: ArtifactSummary[];
    try {
      artifacts = await this.#listArtifacts(lab);
    } catch (error) {
      lab.state = "failed";
      this.#emit(lab.handle.runId, "attempt", "failed", "The attempt's artifacts exceeded lab limits", {
        labId,
        attemptId,
        reason: errorMessage(error),
      });
      throw error;
    }

    const attempt = AttemptSchema.parse({
      id: attemptId,
      runId: lab.handle.runId,
      number: request.number,
      label: request.label,
      command,
      changes: request.changes ?? [],
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      exitCode: timedOut || cancelled ? null : result.exitCode,
      timedOut,
      cancelled,
      artifactDigests: Object.fromEntries(artifacts.map((item) => [item.path, item.sha256])),
    });

    lab.state = timedOut ? "timed_out" : cancelled ? "cancelled" : "idle";
    const durationMs = endedAt.getTime() - startedAt.getTime();
    const succeeded = !timedOut && !cancelled && result.exitCode === 0;
    const summary = timedOut
      ? `Attempt stopped after the ${lab.spec.resources.timeoutSeconds}s wall-time limit`
      : cancelled
        ? "Attempt cancelled; the lab process tree was terminated"
        : succeeded
          ? "Experiment finished successfully"
          : `Experiment exited with code ${String(result.exitCode)}`;
    this.#emit(
      lab.handle.runId,
      "attempt",
      succeeded ? "completed" : "failed",
      summary,
      {
        labId,
        attemptId,
        exitCode: attempt.exitCode,
        timedOut,
        cancelled,
        durationMs,
        stdoutBytes: result.stdout.bytes,
        stderrBytes: result.stderr.bytes,
        logsTruncated: result.stdout.truncated || result.stderr.truncated,
        artifacts,
      },
      artifacts.map((item) => ({ kind: "artifact", reference: `${item.path}#sha256=${item.sha256}` })),
    );
    return { attempt, stdout: result.stdout, stderr: result.stderr, durationMs, artifacts };
  }

  async readArtifact(labId: string, path: string): Promise<ArtifactContent> {
    const lab = this.#lab(labId);
    this.#requireState(lab, ["ready", "idle", "cancelled", "timed_out", "failed"]);
    const relativePath = WorkspaceRelativePathSchema.parse(path);
    const prefix = `${lab.spec.artifactsDir}/`;
    if (!relativePath.startsWith(prefix)) {
      throw new LabError("artifact_rejected", `artifacts must be read from ${prefix}`);
    }
    const hostPath = join(lab.hostArtifactsDir, ...relativePath.slice(prefix.length).split("/"));
    await this.#assertInsideArtifacts(lab, hostPath);

    const handle = await open(hostPath, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new LabError("artifact_rejected", `${relativePath} is not a regular file`);
      if (stats.size > lab.spec.limits.maxArtifactBytes) {
        throw new LabError(
          "artifact_too_large",
          `${relativePath} is ${stats.size} bytes; the limit is ${lab.spec.limits.maxArtifactBytes}`,
        );
      }
      const content = await handle.readFile();
      if (content.length > lab.spec.limits.maxArtifactBytes) {
        throw new LabError("artifact_too_large", `${relativePath} grew beyond the artifact limit`);
      }
      const artifact = {
        path: relativePath,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        content,
      };
      this.#emit(lab.handle.runId, "artifact_read", "completed", `Exported ${relativePath}`, {
        labId,
        path: relativePath,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      }, [{ kind: "artifact", reference: `${relativePath}#sha256=${artifact.sha256}` }]);
      return artifact;
    } finally {
      await handle.close();
    }
  }

  async cancelLab(labId: string): Promise<void> {
    const lab = this.#lab(labId);
    if (lab.state === "destroyed") return;
    this.#emit(lab.handle.runId, "lab_cancel", "progress", "Cancellation requested", { labId });
    if (lab.activeAbort) {
      await this.#kill(lab, "cancelled");
    } else if (lab.state !== "timed_out" && lab.state !== "failed") {
      lab.state = "cancelled";
    }
  }

  async destroyLab(labId: string, reason = "attempt finished"): Promise<CleanupReceipt> {
    const lab = this.#lab(labId);
    if (lab.receipt) return lab.receipt;
    if (lab.activeAbort) await this.#kill(lab, "cancelled");

    const errors: string[] = [];
    const removal = await this.#runtime
      .docker(["rm", "--force", "--volumes", lab.handle.containerName], { maxOutputBytes: 4096 })
      .catch((error: unknown) => {
        errors.push(`container removal: ${errorMessage(error)}`);
        return null;
      });
    const containerRemoved =
      removal !== null &&
      (removal.exitCode === 0 || /no such container/iu.test(removal.stderr.text));
    if (removal && !containerRemoved) errors.push(`container removal: ${removal.stderr.text.trim()}`);

    let artifactDirectoryRemoved = false;
    try {
      await rm(lab.hostLabDir, { recursive: true, force: true });
      artifactDirectoryRemoved = true;
    } catch (error) {
      errors.push(`artifact directory removal: ${errorMessage(error)}`);
    }

    const remaining = await this.#listLabContainers(`${LAB_LABEL}=${labId}`).catch((error: unknown) => {
      errors.push(`verification: ${errorMessage(error)}`);
      return null;
    });
    const verifiedAbsent = remaining !== null && remaining.length === 0;

    const receipt: CleanupReceipt = {
      labId,
      runId: lab.handle.runId,
      containerName: lab.handle.containerName,
      reason,
      containerRemoved,
      artifactDirectoryRemoved,
      verifiedAbsent,
      destroyedAt: this.#now().toISOString(),
      errors,
    };
    lab.state = "destroyed";
    lab.receipt = receipt;
    const clean = containerRemoved && artifactDirectoryRemoved && verifiedAbsent;
    this.#emit(
      lab.handle.runId,
      "lab_cleanup",
      clean ? "completed" : "failed",
      clean ? "Disposable lab removed" : "Lab cleanup needs attention",
      { ...receipt },
    );
    return receipt;
  }

  /** Creates a lab, runs `work`, and always destroys the lab afterwards. */
  async withLab<T>(
    spec: LabSpec,
    work: (lab: LabHandle) => Promise<T>,
  ): Promise<{ value: T; receipt: CleanupReceipt }> {
    const lab = await this.createLab(spec);
    let failure: unknown = null;
    let value: T | undefined;
    try {
      value = await work(lab);
    } catch (error) {
      failure = error;
    }
    const receipt = await this.destroyLab(
      lab.labId,
      failure ? `work failed: ${errorMessage(failure)}` : `lab ${this.state(lab.labId)}`,
    );
    if (failure) throw failure;
    return { value: value as T, receipt };
  }

  /**
   * Removes lab containers and lab directories that this manager instance does
   * not own, such as those left behind by a crashed backend.
   */
  async cleanupOrphans(): Promise<CleanupReceipt[]> {
    const containers = await this.#listLabContainers(LAB_LABEL);
    const receipts: CleanupReceipt[] = [];
    const seenLabIds = new Set<string>();
    for (const container of containers) {
      if (!LAB_ID_PATTERN.test(container.labId) || this.#labs.has(container.labId)) continue;
      seenLabIds.add(container.labId);
      const errors: string[] = [];
      const removal = await this.#runtime.docker(["rm", "--force", "--volumes", container.name], {
        maxOutputBytes: 4096,
      });
      if (removal.exitCode !== 0) errors.push(removal.stderr.text.trim());
      const directoryRemoved = await this.#removeLabDirectories(container.labId);
      const remaining = await this.#listLabContainers(`${LAB_LABEL}=${container.labId}`);
      receipts.push({
        labId: container.labId,
        runId: container.runId,
        containerName: container.name,
        reason: "orphan cleanup",
        containerRemoved: removal.exitCode === 0,
        artifactDirectoryRemoved: directoryRemoved,
        verifiedAbsent: remaining.length === 0,
        destroyedAt: this.#now().toISOString(),
        errors,
      });
    }
    for (const entry of await readdir(this.#labRoot).catch(() => [] as string[])) {
      const labId = entry.split("-")[0] ?? "";
      if (!LAB_ID_PATTERN.test(labId) || this.#labs.has(labId) || seenLabIds.has(labId)) continue;
      await rm(join(this.#labRoot, entry), { recursive: true, force: true });
    }
    return receipts;
  }

  async #verifyImage(spec: LabSpec): Promise<string> {
    const result = await this.#runtime.docker(
      ["image", "inspect", "--format", "{{.Id}} {{.Config.User}}", spec.image],
      { maxOutputBytes: 4096 },
    );
    if (result.exitCode !== 0) {
      throw new LabError("image_missing", `lab image ${spec.image} is not available locally`);
    }
    const [imageId, user] = result.stdout.text.trim().split(" ");
    if (imageId !== spec.expectedImageId) {
      throw new LabError(
        "image_mismatch",
        `lab image ${spec.image} is ${String(imageId)}, expected ${spec.expectedImageId}`,
      );
    }
    if (!user || user === "0" || user.startsWith("root") || user.startsWith("0:")) {
      throw new LabError("image_root_user", `lab image ${spec.image} must declare a non-root user`);
    }
    return imageId;
  }

  async #verifyInput(input: LabSpec["inputs"][number]): Promise<void> {
    const stats = await lstat(input.hostPath).catch(() => null);
    if (!stats) throw new LabError("input_missing", `lab input is missing: ${input.containerPath}`);
    if (stats.isSymbolicLink()) {
      throw new LabError("input_rejected", `lab input must not be a symlink: ${input.containerPath}`);
    }
    if (input.sha256) {
      if (!stats.isFile()) {
        throw new LabError("input_rejected", `digest-pinned input must be a file: ${input.containerPath}`);
      }
      const digest = createHash("sha256").update(await readFile(input.hostPath)).digest("hex");
      if (digest !== input.sha256) {
        throw new LabError("input_digest_mismatch", `${input.containerPath} does not match its reviewed digest`);
      }
    }
  }

  #validateCommand(lab: LabRecord, command: z.infer<typeof ArgvCommandSchema>): void {
    if (!EXECUTABLE_PATTERN.test(command.executable)) {
      throw new LabError("command_rejected", "executable must be a bare program name");
    }
    const cwd = posix.normalize(command.cwd);
    if (cwd !== command.cwd || (cwd !== lab.spec.workdir && !cwd.startsWith(`${lab.spec.workdir}/`))) {
      throw new LabError("command_rejected", `working directory must stay inside ${lab.spec.workdir}`);
    }
    for (const argument of command.args) {
      if (argument.includes("\0")) throw new LabError("command_rejected", "arguments must not contain NUL");
    }
    for (const [key, value] of Object.entries(command.env)) {
      if (
        !ENV_KEY_PATTERN.test(key) ||
        FORBIDDEN_ENV_KEYS.has(key) ||
        FORBIDDEN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        value.includes("\0")
      ) {
        throw new LabError("command_rejected", `environment variable ${key} is not allowed`);
      }
    }
  }

  async #execInLab(
    lab: LabRecord,
    command: z.infer<typeof ArgvCommandSchema>,
    timeoutSeconds: number,
    onOutput?: (stream: OutputStream, chunk: string) => void,
  ): Promise<RuntimeCommandResult> {
    const abort = new AbortController();
    lab.activeAbort = abort;
    lab.killReason = null;
    const timer = setTimeout(() => {
      void this.#kill(lab, "timed_out");
    }, timeoutSeconds * 1000);
    try {
      return await this.#runtime.docker(
        [
          "exec",
          "--workdir", command.cwd,
          ...Object.entries(command.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
          lab.handle.containerName,
          command.executable,
          ...command.args,
        ],
        { maxOutputBytes: lab.spec.limits.maxLogBytes, signal: abort.signal, ...(onOutput ? { onOutput } : {}) },
      );
    } finally {
      clearTimeout(timer);
      lab.activeAbort = null;
    }
  }

  /** Terminates the whole lab process tree by killing the container. */
  async #kill(lab: LabRecord, reason: "cancelled" | "timed_out"): Promise<void> {
    const abort = lab.activeAbort;
    if (!abort || lab.killReason) return;
    lab.killReason = reason;
    const grace = setTimeout(() => abort.abort(), KILL_GRACE_MS);
    try {
      await this.#runtime.docker(["kill", "--signal", "KILL", lab.handle.containerName], {
        maxOutputBytes: 4096,
      });
    } catch {
      abort.abort();
    } finally {
      grace.unref();
    }
  }

  async #listArtifacts(lab: LabRecord): Promise<ArtifactSummary[]> {
    const summaries: ArtifactSummary[] = [];
    let totalBytes = 0;
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const hostPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(hostPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (summaries.length >= lab.spec.limits.maxArtifactFiles) {
          throw new LabError("artifact_limit", "the attempt produced too many artifact files");
        }
        const stats = await lstat(hostPath);
        totalBytes += stats.size;
        if (stats.size > lab.spec.limits.maxArtifactBytes || totalBytes > lab.spec.limits.maxArtifactTotalBytes) {
          throw new LabError("artifact_limit", "the attempt produced more artifact bytes than allowed");
        }
        const path = posix.join(
          lab.spec.artifactsDir,
          ...relative(lab.hostArtifactsDir, hostPath).split(sep),
        );
        const sha256 = createHash("sha256").update(await readFile(hostPath)).digest("hex");
        summaries.push({ path, bytes: stats.size, sha256 });
      }
    };
    await walk(lab.hostArtifactsDir);
    return summaries;
  }

  async #assertInsideArtifacts(lab: LabRecord, hostPath: string): Promise<void> {
    const stats = await lstat(hostPath).catch(() => null);
    if (!stats) throw new LabError("artifact_missing", "artifact does not exist");
    if (stats.isSymbolicLink()) throw new LabError("artifact_rejected", "artifact must not be a symlink");
    const root = await realpath(lab.hostArtifactsDir);
    const resolved = await realpath(hostPath);
    if (!resolved.startsWith(`${root}${sep}`)) {
      throw new LabError("artifact_rejected", "artifact resolves outside the lab artifact directory");
    }
  }

  async #listLabContainers(filter: string): Promise<Array<{ name: string; labId: string; runId: string }>> {
    const result = await this.#runtime.docker(
      [
        "ps", "--all", "--no-trunc",
        "--filter", `label=${filter}`,
        "--format", `{{.Names}}\t{{.Label "${LAB_LABEL}"}}\t{{.Label "${RUN_LABEL}"}}`,
      ],
      { maxOutputBytes: 1024 * 1024 },
    );
    if (result.exitCode !== 0) throw new LabError("runtime_error", result.stderr.text.trim());
    return result.stdout.text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [name = "", labId = "", runId = ""] = line.split("\t");
        return { name, labId, runId };
      });
  }

  async #removeLabDirectories(labId: string): Promise<boolean> {
    const entries = await readdir(this.#labRoot).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry.startsWith(`${labId}-`)) {
        await rm(join(this.#labRoot, entry), { recursive: true, force: true });
      }
    }
    return true;
  }

  async #docker(args: string[], action: string): Promise<RuntimeCommandResult> {
    const result = await this.#runtime.docker(args, { maxOutputBytes: 64 * 1024 });
    if (result.exitCode !== 0) {
      throw new LabError("runtime_error", `${action} failed: ${result.stderr.text.trim()}`);
    }
    return result;
  }

  #lab(labId: string): LabRecord {
    const lab = this.#labs.get(labId);
    if (!lab) throw new LabError("lab_unknown", `unknown lab: ${labId}`);
    return lab;
  }

  #requireState(lab: LabRecord, allowed: readonly LabState[]): void {
    if (!allowed.includes(lab.state)) {
      throw new LabError("lab_state", `lab ${lab.handle.labId} is ${lab.state}`);
    }
  }

  #emit(
    runId: string,
    type: string,
    status: LabEventInput["status"],
    summary: string,
    publicPayload: Record<string, unknown>,
    evidence: EvidencePointer[] = [],
  ): void {
    this.#events?.({ runId, actor: "lab_engineer", type, status, summary, evidence, publicPayload });
  }
}

function mountArgument(source: string, target: string, readonly: boolean): string {
  if (source.includes(",") || target.includes(",")) {
    throw new LabError("input_rejected", "mount paths must not contain commas");
  }
  return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
}

function emptyText(): BoundedText {
  return { text: "", bytes: 0, truncated: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
