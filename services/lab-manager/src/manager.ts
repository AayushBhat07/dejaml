import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";

import {
  ArgvCommandSchema,
  AttemptSchema,
  ContainerPlatformSchema,
  PreparationStepSchema,
  type Attempt,
  type ContainerPlatform,
  type EvidencePointerSchema,
  type RunEvent,
} from "@dejaml/contracts";
import type { z } from "zod";

import { type BoundedText, type ContainerRuntime, type OutputStream, type RuntimeCommandResult, DockerCliRuntime } from "./runtime.js";
import { ArtifactWatcher, DEFAULT_OBSERVE_OPTIONS, OutputBatcher, parseDockerStats, type ObserveOptions } from "./observer.js";
import type { ImageReadiness } from "./images.js";
import { DEFAULT_LAB_TIMEOUT_SECONDS, LabSpecSchema, WorkspaceRelativePathSchema, type LabSpec } from "./spec.js";

export const LAB_LABEL = "dejaml.lab";
export const RUN_LABEL = "dejaml.run";
export const PLATFORM_LABEL = "dejaml.platform";
export const IMAGE_LABEL = "dejaml.image";
/**
 * The only environment variable names a lab container may carry. The Lab
 * Manager adds none of its own: the container's environment is its image's,
 * checked against this list before and after creation, so no host, provider,
 * or cloud credential can reach a lab through the environment.
 */
export const LAB_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "GPG_KEY",
  "PYTHON_VERSION",
  "PYTHON_SHA256",
  "PYTHONDONTWRITEBYTECODE",
  "PYTHONUNBUFFERED",
  "PYTHONNOUSERSITE",
  "PYTHONHASHSEED",
  "PIP_DISABLE_PIP_VERSION_CHECK",
  "PIP_NO_CACHE_DIR",
  "PIP_NO_INDEX",
  "PIP_ROOT_USER_ACTION",
  "OMP_NUM_THREADS",
  "OPENBLAS_NUM_THREADS",
  "MKL_NUM_THREADS",
]);
/** Variable names a command may never set: they look like credentials or configure a provider. */
const CREDENTIAL_ENV_PREFIXES = [
  "DEJAML_",
  "AWS_",
  "AZURE_",
  "GOOGLE_",
  "GCP_",
  "GCLOUD_",
  "GITHUB_",
  "GH_",
  "GITLAB_",
  "OPENAI_",
  "ANTHROPIC_",
  "DOCKER_",
  "KUBE",
  "SSH_",
  "NPM_",
  "PIP_INDEX",
  "PIP_EXTRA_INDEX",
];
const CREDENTIAL_ENV_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIALS?|ACCESS_KEY|PRIVATE_KEY|AUTH)(?:_|$)/u;
/** Host paths that must never be mounted into a lab, nor any directory that contains them. */
const DOCKER_SOCKET_PATHS = ["/var/run/docker.sock", "/run/docker.sock"];
const FORBIDDEN_MOUNT_ROOTS = ["/proc", "/sys", "/dev", "/run", "/var/run", "/var/lib/docker", "/etc", "/boot"];
const CREDENTIAL_DIRECTORIES = [".aws", ".azure", ".config/gcloud", ".docker", ".kube", ".ssh", ".netrc", ".git-credentials"];
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

export type LabState = "ready" | "preparing" | "running" | "idle" | "cancelled" | "timed_out" | "failed" | "destroyed";

export type LabHandle = {
  labId: string;
  runId: string;
  containerName: string;
  image: string;
  imageId: string;
  /** The platform-specific manifest digest (or a registry digest) of the image the container runs. */
  imageDigest: string | null;
  platform: ContainerPlatform;
  createdAt: string;
};

export type AttemptRequest = {
  number: number;
  label: "baseline" | "modified";
  command: z.input<typeof ArgvCommandSchema>;
  changes?: string[];
  onOutput?: (stream: OutputStream, chunk: string) => void;
  /** Publish live output, telemetry, and artifact-change events while the attempt runs. */
  observe?: boolean | ObserveOptions;
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

/** One agent tool command: bounded output, its own time limit, and the artifacts afterwards. */
export type CommandOutcome = {
  command: z.infer<typeof ArgvCommandSchema>;
  exitCode: number | null;
  timedOut: boolean;
  stdout: BoundedText;
  stderr: BoundedText;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  artifacts: ArtifactSummary[];
  /** Processes the command left running in the background, stopped afterwards. */
  strayProcesses: string[];
  /** Size of the scratch directory after the command. */
  scratchBytes: number | null;
};

/** One read-only look at the lab's files, run inside the container as the lab user. */
export type InspectRequest =
  | { op: "list"; path: string; depth?: number }
  | { op: "read"; path: string; offset?: number; maxBytes?: number }
  | { op: "search"; path: string; pattern: string; maxMatches?: number };

/** Largest file an agent may write in one call; it travels base64-encoded in one argv entry. */
export const MAX_SCRATCH_FILE_BYTES = 64 * 1024;

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
  /** Null only for an orphan whose labels could not be read. */
  platform: ContainerPlatform | null;
  imageId: string | null;
  imageDigest: string | null;
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
  frozen: boolean;
  /** PID of the lab's keep-alive process inside the container, learned before the first agent command. */
  mainPid: number | null;
  hostScratchDir: string | null;
  activeAbort: AbortController | null;
  killReason: "cancelled" | "timed_out" | null;
  receipt: CleanupReceipt | null;
  /** Kills the lab when its overall lifetime ends. */
  lifetime: ReturnType<typeof setTimeout> | null;
  expired: boolean;
};

export type LabManagerOptions = {
  runtime?: ContainerRuntime;
  /** Host directory that holds one private subdirectory per lab. */
  labRoot?: string;
  events?: LabEventSink;
  now?: () => Date;
  /** When set, a lab waits for any in-flight preparation of its image before inspecting it. */
  images?: Pick<ImageReadiness, "whenSettled">;
};

/** What `createLab` checked on the created container before starting it. */
export type SealedLabAudit = {
  network: "none";
  readOnlyRoot: true;
  capDrop: "ALL";
  noNewPrivileges: true;
  privileged: false;
  user: string;
  dockerSocketMounted: false;
  writableMounts: string[];
  envKeys: string[];
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
  readonly #images: Pick<ImageReadiness, "whenSettled"> | undefined;

  constructor(options: LabManagerOptions = {}) {
    this.#runtime = options.runtime ?? new DockerCliRuntime();
    this.#labRoot = resolve(options.labRoot ?? join(tmpdir(), "dejaml-labs"));
    this.#events = options.events;
    this.#now = options.now ?? (() => new Date());
    this.#images = options.images;
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
      platform: spec.platform,
    });

    let hostLabDir: string | null = null;
    let created = false;
    try {
      // Never race an image that is still being pulled or built.
      await this.#images?.whenSettled(spec.image, spec.platform);
      const image = await this.#verifyImage(spec);
      const imageId = image.imageId;
      for (const labInput of spec.inputs) await this.#verifyInput(labInput);

      await mkdir(this.#labRoot, { recursive: true, mode: 0o700 });
      hostLabDir = await mkdtemp(join(this.#labRoot, `${labId}-`));
      const hostArtifactsDir = join(hostLabDir, "artifacts");
      await mkdir(hostArtifactsDir);
      // The lab user (UID 10001) must write here; the private parent keeps other host users out.
      await chmod(hostArtifactsDir, 0o777);
      let hostScratchDir: string | null = null;
      if (spec.scratchDir) {
        hostScratchDir = join(hostLabDir, "scratch");
        await mkdir(hostScratchDir);
        await chmod(hostScratchDir, 0o777);
      }

      const args = [
        "create",
        "--name",
        containerName,
        "--label",
        `${LAB_LABEL}=${labId}`,
        "--label",
        `${RUN_LABEL}=${spec.runId}`,
        "--label",
        `${PLATFORM_LABEL}=${spec.platform}`,
        "--label",
        `${IMAGE_LABEL}=${imageId}`,
        // The image was verified above; a lab never pulls, and runs only the requested platform.
        "--platform",
        spec.platform,
        "--pull",
        "never",
        "--init",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--cpus",
        String(spec.resources.cpus),
        "--memory",
        `${spec.resources.memoryMb}m`,
        "--memory-swap",
        `${spec.resources.memoryMb}m`,
        "--pids-limit",
        String(spec.resources.pids),
        "--tmpfs",
        `/tmp:rw,noexec,nosuid,nodev,size=${spec.limits.tmpfsMb}m,uid=10001,gid=10001,mode=1777`,
        "--workdir",
        spec.workdir,
        ...spec.inputs.flatMap((labInput) => [
          "--mount",
          mountArgument(labInput.hostPath, posix.join(spec.workdir, labInput.containerPath), true),
        ]),
        "--mount",
        mountArgument(hostArtifactsDir, posix.join(spec.workdir, spec.artifactsDir), false),
        ...(hostScratchDir && spec.scratchDir
          ? ["--mount", mountArgument(hostScratchDir, posix.join(spec.workdir, spec.scratchDir), false)]
          : []),
        "--entrypoint",
        "sleep",
        spec.image,
        "infinity",
      ];
      await this.#docker(args, "container create");
      created = true;
      const { audit, imageDigest } = await this.#auditContainer(containerName, spec, image);
      await this.#docker(["start", containerName], "container start");

      const handle: LabHandle = {
        labId,
        runId: spec.runId,
        containerName,
        image: spec.image,
        imageId,
        imageDigest,
        platform: spec.platform,
        createdAt: this.#now().toISOString(),
      };
      const record: LabRecord = {
        handle,
        spec,
        state: "ready",
        hostArtifactsDir,
        hostLabDir,
        frozen: false,
        mainPid: null,
        hostScratchDir,
        activeAbort: null,
        killReason: null,
        receipt: null,
        lifetime: null,
        expired: false,
      };
      const lifetimeSeconds = spec.limits.labTimeoutSeconds ?? DEFAULT_LAB_TIMEOUT_SECONDS;
      record.lifetime = setTimeout(() => void this.#expire(record, lifetimeSeconds), lifetimeSeconds * 1000);
      record.lifetime.unref();
      this.#labs.set(labId, record);
      this.#emit(spec.runId, "lab_create", "completed", "Disposable CPU lab is ready", {
        labId,
        image: spec.image,
        imageId,
        imageDigest,
        platform: spec.platform,
        network: "none",
        readOnlyRoot: true,
        sealed: audit,
        resources: spec.resources,
        tmpfsMb: spec.limits.tmpfsMb,
        labTimeoutSeconds: lifetimeSeconds,
        ...(spec.scratchDir ? { scratchDir: spec.scratchDir } : {}),
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

  async prepareLab(labId: string, steps: ReadonlyArray<z.input<typeof PreparationStepSchema>>): Promise<PreparationRecord[]> {
    const lab = this.#lab(labId);
    this.#requireState(lab, ["ready"]);
    const records: PreparationRecord[] = [];
    lab.state = "preparing";
    try {
      for (const rawStep of steps) {
        const step = PreparationStepSchema.parse(rawStep);
        if (step.kind === "install") {
          throw new LabError("preparation_rejected", "install steps need network access, which labs never receive after creation");
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

    const observation = request.observe
      ? this.#startObservation(lab, attemptId, startedAt, request.observe === true ? {} : request.observe, request.onOutput)
      : null;
    let result: RuntimeCommandResult;
    try {
      result = await this.#execInLab(lab, command, lab.spec.resources.timeoutSeconds, observation?.onOutput ?? request.onOutput);
      await observation?.stop();
    } catch (error) {
      await observation?.stop();
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

  /**
   * Runs one agent-chosen command inside the lab. The command is bounded by
   * its own `timeout` inside the container, so a slow step fails without
   * destroying the lab; the container-level kill remains the backstop. The
   * lab's isolation (no network, read-only root, dropped capabilities,
   * resource limits) is the safety boundary, not the command text.
   */
  async runCommand(
    labId: string,
    input: z.input<typeof ArgvCommandSchema>,
    options: { timeoutSeconds: number; step: number; observe?: boolean; agent?: string },
  ): Promise<CommandOutcome> {
    const lab = this.#lab(labId);
    this.#requireState(lab, ["ready", "idle"]);
    if (lab.frozen) throw new LabError("lab_state", `lab ${labId} is frozen`);
    const command = ArgvCommandSchema.parse(input);
    this.#validateCommand(lab, command);
    const limit = Math.max(1, Math.min(Math.floor(options.timeoutSeconds), lab.spec.resources.timeoutSeconds));
    const stepId = `${lab.handle.runId}:${options.agent ? `${options.agent}:` : ""}step-${options.step}`;
    const startedAt = this.#now();
    lab.state = "running";
    const who = options.agent ? `${options.agent} step` : "Step";
    this.#emit(lab.handle.runId, "agent_command", "started", `${who} ${options.step}: ${describeCommand(command)}`, {
      labId,
      step: options.step,
      ...(options.agent ? { agent: options.agent } : {}),
      executable: command.executable,
      args: command.args.map((argument) => argument.slice(0, 500)),
      cwd: command.cwd,
      timeoutSeconds: limit,
    });
    if (lab.spec.scratchDir && lab.mainPid === null) await this.#learnMainPid(lab);
    const observation = options.observe ? this.#startObservation(lab, stepId, startedAt, {}, undefined) : null;
    let result: RuntimeCommandResult;
    try {
      result = await this.#execInLab(
        lab,
        { ...command, executable: "timeout", args: ["--signal=KILL", `${limit}s`, command.executable, ...command.args] },
        limit + 15,
        observation?.onOutput,
      );
      await observation?.stop();
    } catch (error) {
      await observation?.stop();
      lab.state = "failed";
      throw error;
    }
    if (lab.killReason) {
      // The container itself was killed: the lab cannot continue.
      lab.state = lab.killReason;
    } else {
      lab.state = "idle";
    }
    const endedAt = this.#now();
    const durationMs = endedAt.getTime() - startedAt.getTime();
    // `timeout --signal=KILL` exits 137; an out-of-memory kill also exits 137, so the elapsed time decides.
    const timedOut =
      lab.killReason === "timed_out" || ((result.exitCode === 137 || result.exitCode === 124) && durationMs >= limit * 1000 - 1000);
    // Nothing the command started may keep running after it: stray background
    // processes are stopped before the host looks at the lab's files.
    const strayProcesses = lab.killReason ? [] : await this.#reapStrays(lab);
    const scratchBytes = lab.hostScratchDir ? await directoryBytes(lab.hostScratchDir) : null;
    const scratchLimit = (lab.spec.limits.maxScratchMb ?? 3_072) * 1024 * 1024;
    let artifacts: ArtifactSummary[] = [];
    try {
      // Background processes may outlive the command; pause them so none can
      // swap a file for a symlink while the host hashes the artifacts.
      const pause = lab.killReason ? null : await this.#runtime.docker(["pause", lab.handle.containerName], { maxOutputBytes: 4096 });
      try {
        artifacts = await this.#listArtifacts(lab);
      } finally {
        if (pause?.exitCode === 0) await this.#docker(["unpause", lab.handle.containerName], "container unpause");
      }
    } catch (error) {
      lab.state = "failed";
      throw error;
    }
    const outcome: CommandOutcome = {
      command,
      exitCode: lab.killReason ? null : result.exitCode,
      timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      artifacts,
      strayProcesses,
      scratchBytes,
    };
    if (strayProcesses.length > 0) {
      this.#emit(
        lab.handle.runId,
        "lab_strays_stopped",
        "warning",
        `Stopped ${strayProcesses.length} background process(es) left by step ${options.step}`,
        {
          labId,
          step: options.step,
          processes: strayProcesses,
        },
      );
    }
    if (scratchBytes !== null && scratchBytes > scratchLimit) {
      lab.state = "failed";
      this.#emit(
        lab.handle.runId,
        "lab_disk_limit",
        "failed",
        `The lab's scratch space grew past ${lab.spec.limits.maxScratchMb ?? 3_072} MB`,
        {
          labId,
          scratchBytes,
        },
      );
    }
    this.#emit(
      lab.handle.runId,
      "agent_command",
      outcome.exitCode === 0 ? "completed" : "failed",
      timedOut ? `${who} ${options.step} hit its ${limit}s limit` : `${who} ${options.step} exited with code ${String(outcome.exitCode)}`,
      {
        labId,
        step: options.step,
        ...(options.agent ? { agent: options.agent } : {}),
        exitCode: outcome.exitCode,
        timedOut,
        durationMs: outcome.durationMs,
        stdoutTail: result.stdout.text.slice(-2_000),
        stderrTail: result.stderr.text.slice(-2_000),
        artifacts,
      },
      [{ kind: "log_line", reference: `${stepId}/stdout` }],
    );
    return outcome;
  }

  /**
   * Writes an agent-authored file into the scratch directory. The write runs
   * inside the container as the lab user, so a symlink planted by an earlier
   * command can never redirect it onto the host.
   */
  async writeScratchFile(labId: string, path: string, content: string, step: number): Promise<ArtifactSummary> {
    const lab = this.#lab(labId);
    this.#requireState(lab, ["ready", "idle"]);
    if (lab.frozen) throw new LabError("lab_state", `lab ${labId} is frozen`);
    const scratch = lab.spec.scratchDir;
    if (!scratch) throw new LabError("scratch_unavailable", "this lab has no scratch directory");
    const relativePath = WorkspaceRelativePathSchema.parse(path);
    if (!relativePath.startsWith(`${scratch}/`)) {
      throw new LabError("scratch_rejected", `agent files must be written under ${scratch}/`);
    }
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > MAX_SCRATCH_FILE_BYTES) {
      throw new LabError("scratch_too_large", `files are limited to ${MAX_SCRATCH_FILE_BYTES} bytes`);
    }
    const target = posix.join(lab.spec.workdir, relativePath);
    const script =
      "import base64,os,sys\n" +
      "p=sys.argv[1]\n" +
      "os.makedirs(os.path.dirname(p),exist_ok=True)\n" +
      "fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o644)\n" +
      "os.write(fd,base64.b64decode(sys.argv[2]))\n" +
      "os.close(fd)\n";
    const result = await this.#execInLab(
      lab,
      { executable: "python", args: ["-c", script, target, bytes.toString("base64")], cwd: lab.spec.workdir, env: {} },
      30,
    );
    if (result.exitCode !== 0) {
      throw new LabError("scratch_write_failed", `could not write ${relativePath}: ${result.stderr.text.trim().slice(-500)}`);
    }
    const summary = {
      path: relativePath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    this.#emit(
      lab.handle.runId,
      "agent_file",
      "completed",
      `Step ${step}: wrote ${relativePath}`,
      {
        labId,
        step,
        ...summary,
      },
      [{ kind: "artifact", reference: `${relativePath}#sha256=${summary.sha256}` }],
    );
    return summary;
  }

  /**
   * Lists, reads, or searches files under the lab's working directory. It runs
   * inside the container as the lab user, so it sees exactly what commands see
   * and cannot reach the host; paths that resolve outside the workspace are
   * refused. Output is bounded.
   */
  async inspectFiles(labId: string, request: InspectRequest): Promise<Record<string, unknown>> {
    const lab = this.#lab(labId);
    this.#requireState(lab, ["ready", "idle"]);
    if (lab.frozen) throw new LabError("lab_state", `lab ${labId} is frozen`);
    const relativePath = request.path === "." ? "." : WorkspaceRelativePathSchema.parse(request.path);
    const payload = JSON.stringify({ ...request, path: relativePath, root: lab.spec.workdir });
    const result = await this.#execInLab(
      lab,
      { executable: "python", args: ["-I", "-S", "-c", INSPECT_SCRIPT, payload], cwd: lab.spec.workdir, env: {} },
      30,
    );
    if (result.exitCode !== 0) {
      throw new LabError("inspect_failed", result.stderr.text.trim().slice(-500) || "file inspection failed");
    }
    try {
      return JSON.parse(result.stdout.text) as Record<string, unknown>;
    } catch {
      throw new LabError("inspect_failed", "file inspection returned unreadable output");
    }
  }

  async #learnMainPid(lab: LabRecord): Promise<void> {
    // Before any agent command runs, PID 1 (the init process) has exactly one
    // child: the keep-alive process. Anything else later reparented to PID 1
    // is a stray.
    const result = await this.#execInLab(
      lab,
      { executable: "cat", args: ["/proc/1/task/1/children"], cwd: lab.spec.workdir, env: {} },
      15,
    ).catch(() => null);
    const pids =
      result?.exitCode === 0
        ? result.stdout.text
            .trim()
            .split(/\s+/u)
            .filter((item) => /^\d+$/u.test(item))
        : [];
    lab.mainPid = pids.length === 1 ? Number(pids[0]) : null;
  }

  async #reapStrays(lab: LabRecord): Promise<string[]> {
    if (!lab.spec.scratchDir) return [];
    if (lab.mainPid === null) {
      this.#emit(lab.handle.runId, "lab_strays_unchecked", "warning", "Background processes could not be checked in this lab", {
        labId: lab.handle.labId,
      });
      return [];
    }
    const result = await this.#execInLab(
      lab,
      { executable: "python", args: ["-I", "-S", "-c", REAP_SCRIPT, String(lab.mainPid)], cwd: lab.spec.workdir, env: {} },
      15,
    ).catch(() => null);
    if (!result || result.exitCode !== 0) return [];
    try {
      const killed = JSON.parse(result.stdout.text) as unknown;
      return Array.isArray(killed) ? killed.map(String).slice(0, 50) : [];
    } catch {
      return [];
    }
  }

  /**
   * Pauses every process in the lab so nothing can change the artifact
   * directory while the host exports results. Only destruction follows.
   */
  async freezeLab(labId: string): Promise<void> {
    const lab = this.#lab(labId);
    if (lab.frozen || lab.state === "destroyed") return;
    this.#requireState(lab, ["ready", "idle", "failed", "timed_out"]);
    await this.#docker(["pause", lab.handle.containerName], "container pause");
    lab.frozen = true;
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
      this.#emit(
        lab.handle.runId,
        "artifact_read",
        "completed",
        `Exported ${relativePath}`,
        {
          labId,
          path: relativePath,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
        },
        [{ kind: "artifact", reference: `${relativePath}#sha256=${artifact.sha256}` }],
      );
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
    if (lab.lifetime) clearTimeout(lab.lifetime);
    lab.lifetime = null;
    if (lab.activeAbort) await this.#kill(lab, "cancelled");

    const errors: string[] = [];
    const removal = await this.#runtime
      .docker(["rm", "--force", "--volumes", lab.handle.containerName], { maxOutputBytes: 4096 })
      .catch((error: unknown) => {
        errors.push(`container removal: ${errorMessage(error)}`);
        return null;
      });
    const containerRemoved = removal !== null && (removal.exitCode === 0 || /no such container/iu.test(removal.stderr.text));
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
      platform: lab.handle.platform,
      imageId: lab.handle.imageId,
      imageDigest: lab.handle.imageDigest,
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
  async withLab<T>(spec: LabSpec, work: (lab: LabHandle) => Promise<T>): Promise<{ value: T; receipt: CleanupReceipt }> {
    const lab = await this.createLab(spec);
    let failure: unknown = null;
    let value: T | undefined;
    try {
      value = await work(lab);
    } catch (error) {
      failure = error;
    }
    const receipt = await this.destroyLab(lab.labId, failure ? `work failed: ${errorMessage(failure)}` : `lab ${this.state(lab.labId)}`);
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
        platform: container.platform,
        imageId: container.imageId,
        imageDigest: null,
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

  /**
   * Checks the local image before anything is created: its immutable ID, a
   * non-root user, a build for exactly the lab's platform, and an environment
   * made only of allowlisted names.
   */
  async #verifyImage(spec: LabSpec): Promise<VerifiedImage> {
    const plain = await this.#inspectImage(spec.image, null);
    if (!plain) {
      throw new LabError("image_missing", `lab image ${spec.image} is not available locally`);
    }
    if (plain.id !== spec.expectedImageId) {
      throw new LabError("image_mismatch", `lab image ${spec.image} is ${plain.id}, expected ${spec.expectedImageId}`);
    }
    if (!isNonRootUser(plain.user)) {
      throw new LabError("image_root_user", `lab image ${spec.image} must declare a non-root user`);
    }
    if (plain.platform !== spec.platform) {
      // A multi-platform local image reports the daemon's default platform unless asked for one.
      const specific = await this.#inspectImage(spec.image, spec.platform).catch(() => null);
      if (specific?.platform !== spec.platform) {
        throw new LabError(
          "platform_mismatch",
          `lab image ${spec.image} is built for ${plain.platform ?? "an unknown platform"}, not ${spec.platform}`,
        );
      }
    }
    const rejected = plain.envKeys.filter((key) => !LAB_ENV_ALLOWLIST.has(key));
    if (rejected.length > 0) {
      throw new LabError(
        "image_env_rejected",
        `lab image ${spec.image} sets environment variables labs do not allow: ${rejected.join(", ")}`,
      );
    }
    return { imageId: plain.id, repoDigests: plain.repoDigests };
  }

  async #inspectImage(reference: string, platform: ContainerPlatform | null): Promise<InspectedImage | null> {
    const result = await this.#runtime.docker(
      ["image", "inspect", ...(platform ? ["--platform", platform] : []), "--format", "{{json .}}", reference],
      { maxOutputBytes: 1024 * 1024 },
    );
    if (result.exitCode !== 0) {
      // Only "no such image" means missing; any other failure is reported as it is.
      if (/no such image/iu.test(result.stderr.text)) return null;
      throw new LabError("runtime_error", `image inspect failed: ${result.stderr.text.trim().slice(-500)}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout.text.trim().split("\n")[0] ?? "");
    } catch {
      throw new LabError("runtime_error", `image inspect returned unreadable output for ${reference}`);
    }
    const info = (Array.isArray(raw) ? raw[0] : raw) as DockerImageInfo | undefined;
    if (!info || typeof info.Id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(info.Id)) {
      throw new LabError("runtime_error", `image inspect returned no image ID for ${reference}`);
    }
    return {
      id: info.Id,
      user: info.Config?.User ?? "",
      platform: info.Os && info.Architecture ? `${info.Os}/${info.Architecture}` : null,
      envKeys: envKeys(info.Config?.Env),
      repoDigests: Array.isArray(info.RepoDigests) ? info.RepoDigests.filter((item) => typeof item === "string") : [],
    };
  }

  /**
   * Reads back the created (not yet started) container and refuses it unless
   * its effective configuration is sealed: the verified image for the lab's
   * platform, no network, read-only root, no capabilities, no privilege
   * escalation, a non-root user, no Docker socket, only the lab's own
   * writable mounts, and an allowlisted environment.
   */
  async #auditContainer(
    containerName: string,
    spec: LabSpec,
    image: VerifiedImage,
  ): Promise<{ audit: SealedLabAudit; imageDigest: string | null }> {
    const result = await this.#runtime.docker(["container", "inspect", "--format", "{{json .}}", containerName], {
      maxOutputBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new LabError("runtime_error", `container inspect failed: ${result.stderr.text.trim().slice(-500)}`);
    }
    let info: DockerContainerInfo;
    try {
      const raw = JSON.parse(result.stdout.text.trim().split("\n")[0] ?? "") as unknown;
      info = (Array.isArray(raw) ? raw[0] : raw) as DockerContainerInfo;
    } catch {
      throw new LabError("runtime_error", "container inspect returned unreadable output");
    }
    const problems: string[] = [];
    if (info.Image !== image.imageId) problems.push(`runs image ${String(info.Image)}, expected ${image.imageId}`);
    const descriptor = info.ImageManifestDescriptor;
    const runningPlatform = descriptor?.platform ? `${descriptor.platform.os}/${descriptor.platform.architecture}` : null;
    if (runningPlatform !== null && runningPlatform !== spec.platform) {
      problems.push(`runs the ${runningPlatform} image, expected ${spec.platform}`);
    }
    const host = info.HostConfig ?? {};
    if (host.NetworkMode !== "none") problems.push(`network mode is ${String(host.NetworkMode)}`);
    if (host.ReadonlyRootfs !== true) problems.push("root filesystem is writable");
    if (!(host.CapDrop ?? []).some((cap) => cap.toUpperCase() === "ALL")) problems.push("capabilities are not dropped");
    if ((host.CapAdd ?? []).length > 0) problems.push("capabilities were added");
    if (!(host.SecurityOpt ?? []).some((opt) => /^no-new-privileges(?::true)?$/u.test(opt))) {
      problems.push("no-new-privileges is not set");
    }
    if (host.Privileged === true) problems.push("container is privileged");
    const user = info.Config?.User ?? "";
    if (!isNonRootUser(user)) problems.push("container runs as root");
    const mounts = info.Mounts ?? [];
    const socketMounted = mounts.some(
      (mount) =>
        DOCKER_SOCKET_PATHS.includes(mount.Source ?? "") ||
        DOCKER_SOCKET_PATHS.includes(mount.Destination ?? "") ||
        /docker\.sock$/u.test(mount.Source ?? ""),
    );
    if (socketMounted) problems.push("the Docker socket is mounted");
    const allowedWritable = new Set([
      posix.join(spec.workdir, spec.artifactsDir),
      ...(spec.scratchDir ? [posix.join(spec.workdir, spec.scratchDir)] : []),
    ]);
    const writableMounts = mounts.filter((mount) => mount.RW === true).map((mount) => mount.Destination ?? "");
    for (const destination of writableMounts) {
      if (!allowedWritable.has(destination)) problems.push(`unexpected writable mount ${destination}`);
    }
    const keys = envKeys(info.Config?.Env);
    const rejected = keys.filter((key) => !LAB_ENV_ALLOWLIST.has(key));
    if (rejected.length > 0) problems.push(`environment variables not allowed: ${rejected.join(", ")}`);
    if (problems.length > 0) {
      throw new LabError("lab_not_sealed", `lab container failed its isolation audit: ${problems.join("; ")}`);
    }
    const repoDigest = image.repoDigests[0]?.split("@")[1] ?? null;
    return {
      audit: {
        network: "none",
        readOnlyRoot: true,
        capDrop: "ALL",
        noNewPrivileges: true,
        privileged: false,
        user,
        dockerSocketMounted: false,
        writableMounts,
        envKeys: keys,
      },
      imageDigest: descriptor?.digest ?? repoDigest,
    };
  }

  /** Ends a lab whose overall lifetime ran out, whatever it is doing. */
  async #expire(lab: LabRecord, seconds: number): Promise<void> {
    lab.lifetime = null;
    if (lab.receipt || lab.expired) return;
    lab.expired = true;
    this.#emit(lab.handle.runId, "lab_timeout", "failed", `The lab reached its ${seconds}s lifetime and was stopped`, {
      labId: lab.handle.labId,
      labTimeoutSeconds: seconds,
    });
    if (lab.activeAbort) {
      await this.#kill(lab, "timed_out");
      return;
    }
    lab.state = "timed_out";
    await this.#runtime.docker(["kill", "--signal", "KILL", lab.handle.containerName], { maxOutputBytes: 4096 }).catch(() => undefined);
  }

  async #verifyInput(input: LabSpec["inputs"][number]): Promise<void> {
    const stats = await lstat(input.hostPath).catch(() => null);
    if (!stats) throw new LabError("input_missing", `lab input is missing: ${input.containerPath}`);
    if (stats.isSymbolicLink()) {
      throw new LabError("input_rejected", `lab input must not be a symlink: ${input.containerPath}`);
    }
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new LabError("input_rejected", `lab input must be a regular file or directory: ${input.containerPath}`);
    }
    const resolved = await realpath(input.hostPath);
    const denied = forbiddenMountReason(resolved);
    if (denied) throw new LabError("input_rejected", `lab input ${input.containerPath} ${denied}`);
    if (input.sha256) {
      if (!stats.isFile()) {
        throw new LabError("input_rejected", `digest-pinned input must be a file: ${input.containerPath}`);
      }
      const digest = createHash("sha256")
        .update(await readFile(input.hostPath))
        .digest("hex");
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
      if (isCredentialEnvKey(key)) {
        throw new LabError("command_rejected", `environment variable ${key} looks like a credential and is not allowed in labs`);
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
          "--workdir",
          command.cwd,
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

  #startObservation(
    lab: LabRecord,
    attemptId: string,
    startedAt: Date,
    overrides: ObserveOptions,
    forward: ((stream: OutputStream, chunk: string) => void) | undefined,
  ): { onOutput: (stream: OutputStream, chunk: string) => void; stop: () => Promise<void> } {
    const options = { ...DEFAULT_OBSERVE_OPTIONS, ...overrides };
    const runId = lab.handle.runId;
    const labId = lab.handle.labId;
    const batcher = new OutputBatcher(options);
    const watcher = new ArtifactWatcher(lab.hostArtifactsDir, lab.spec.artifactsDir, lab.spec.limits.maxArtifactFiles);

    const publishOutput = (final: boolean): void => {
      for (const batch of batcher.drain(final)) {
        this.#emit(
          runId,
          "lab_output",
          "progress",
          `${batch.lines.length} new ${batch.stream} line${batch.lines.length === 1 ? "" : "s"}`,
          { labId, attemptId, stream: batch.stream, lines: batch.lines, truncatedLines: batch.truncatedLines },
          [{ kind: "log_line", reference: `${attemptId}/${batch.stream}` }],
        );
      }
    };

    // One streaming `docker stats` process per attempt; `--no-stream` needs a
    // full second per sample and would miss most of a short run.
    const statsAbort = new AbortController();
    let statsBuffer = "";
    let lastTelemetryAt = 0;
    const onStats = (stream: OutputStream, chunk: string): void => {
      if (stream !== "stdout") return;
      statsBuffer += chunk;
      const lines = statsBuffer.split("\n");
      statsBuffer = (lines.pop() ?? "").slice(-16 * 1024);
      for (const line of lines) {
        const telemetry = parseDockerStats(line);
        const now = this.#now().getTime();
        if (!telemetry || !lab.activeAbort || now - lastTelemetryAt < options.telemetryIntervalMs) continue;
        lastTelemetryAt = now;
        this.#emit(runId, "lab_telemetry", "progress", "Resource usage sampled", {
          labId,
          attemptId,
          elapsedMs: now - startedAt.getTime(),
          ...telemetry,
          limits: {
            cpus: lab.spec.resources.cpus,
            memoryMb: lab.spec.resources.memoryMb,
            pids: lab.spec.resources.pids,
          },
        });
      }
    };
    const statsDone = this.#runtime
      .docker(["stats", "--format", "{{json .}}", lab.handle.containerName], {
        maxOutputBytes: 1024,
        signal: statsAbort.signal,
        onOutput: onStats,
      })
      .catch(() => null);

    let sampling: Promise<void> | null = null;
    const sampleArtifacts = async (): Promise<void> => {
      for (const change of await watcher.sample()) {
        this.#emit(
          runId,
          "artifact_changed",
          "progress",
          `${change.change === "created" ? "Created" : "Updated"} ${change.path}`,
          { labId, attemptId, ...change },
          [{ kind: "artifact", reference: change.path }],
        );
      }
    };

    const flushTimer = setInterval(() => publishOutput(false), options.flushIntervalMs);
    const artifactTimer = setInterval(() => {
      if (sampling) return;
      sampling = sampleArtifacts()
        .catch(() => undefined)
        .finally(() => {
          sampling = null;
        });
    }, options.artifactIntervalMs);

    let stopped = false;
    return {
      onOutput: (stream, chunk) => {
        forward?.(stream, chunk);
        batcher.push(stream, chunk);
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(flushTimer);
        clearInterval(artifactTimer);
        statsAbort.abort();
        await Promise.all([sampling, statsDone]);
        publishOutput(true);
        if (batcher.limitReached) {
          this.#emit(
            runId,
            "lab_output",
            "warning",
            "Live output limit reached; remaining lines are kept only in the bounded attempt log",
            { labId, attemptId, droppedLines: batcher.droppedLines },
          );
        }
      },
    };
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
        const path = posix.join(lab.spec.artifactsDir, ...relative(lab.hostArtifactsDir, hostPath).split(sep));
        const sha256 = createHash("sha256")
          .update(await readFile(hostPath))
          .digest("hex");
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

  async #listLabContainers(
    filter: string,
  ): Promise<Array<{ name: string; labId: string; runId: string; platform: ContainerPlatform | null; imageId: string | null }>> {
    const result = await this.#runtime.docker(
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${filter}`,
        "--format",
        `{{.Names}}\t{{.Label "${LAB_LABEL}"}}\t{{.Label "${RUN_LABEL}"}}\t{{.Label "${PLATFORM_LABEL}"}}\t{{.Label "${IMAGE_LABEL}"}}`,
      ],
      { maxOutputBytes: 1024 * 1024 },
    );
    if (result.exitCode !== 0) throw new LabError("runtime_error", result.stderr.text.trim());
    return result.stdout.text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [name = "", labId = "", runId = "", platform = "", imageId = ""] = line.split("\t");
        const parsedPlatform = ContainerPlatformSchema.safeParse(platform);
        return {
          name,
          labId,
          runId,
          platform: parsedPlatform.success ? parsedPlatform.data : null,
          imageId: /^sha256:[a-f0-9]{64}$/u.test(imageId) ? imageId : null,
        };
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

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else total += (await lstat(path).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

/** Stops every process except init, the keep-alive process, and itself. */
const REAP_SCRIPT = [
  "import json,os,signal,sys",
  "keep={1,int(sys.argv[1]),os.getpid(),os.getppid()}",
  "killed=[]",
  "for d in os.listdir('/proc'):",
  " if not d.isdigit() or int(d) in keep: continue",
  " try:",
  "  cmd=open('/proc/%s/cmdline'%d,'rb').read().replace(b'\\0',b' ').decode('utf-8','replace').strip()",
  "  os.kill(int(d),signal.SIGKILL)",
  "  killed.append(cmd[:160] or '['+d+']')",
  " except OSError: pass",
  "print(json.dumps(killed))",
].join("\n");

/** Bounded list, read, and search confined to the lab working directory. */
const INSPECT_SCRIPT = [
  "import json,os,re,sys",
  "q=json.loads(sys.argv[1]); root=os.path.realpath(q['root'])",
  "p=os.path.realpath(os.path.join(root,q['path']))",
  "if p!=root and not p.startswith(root+os.sep): print(json.dumps({'error':'path is outside the workspace'})); sys.exit(0)",
  "def rel(x): return os.path.relpath(x,root)",
  "op=q['op']",
  "if op=='list':",
  " out=[]; depth=min(int(q.get('depth') or 2),6)",
  " if os.path.isfile(p): out.append({'path':rel(p),'bytes':os.path.getsize(p)})",
  " for base,dirs,files in os.walk(p):",
  "  lvl=base[len(p):].count(os.sep)",
  "  dirs[:]=sorted(d for d in dirs if d not in ('.git','__pycache__','.venv'))[:200]",
  "  if lvl>=depth: dirs[:]=[]",
  "  for f in sorted(files)[:500]:",
  "   fp=os.path.join(base,f)",
  "   try: out.append({'path':rel(fp),'bytes':os.lstat(fp).st_size,'link':os.path.islink(fp)})",
  "   except OSError: pass",
  "  if len(out)>2000: break",
  " print(json.dumps({'entries':out[:2000],'truncated':len(out)>2000}))",
  "elif op=='read':",
  " if not os.path.isfile(p): print(json.dumps({'error':'not a regular file'})); sys.exit(0)",
  " off=max(0,int(q.get('offset') or 0)); n=min(int(q.get('maxBytes') or 20000),60000); size=os.path.getsize(p)",
  " with open(p,'rb') as fh: fh.seek(off); data=fh.read(n)",
  " print(json.dumps({'path':rel(p),'bytes':size,'offset':off,'content':data.decode('utf-8','replace'),'truncated':off+len(data)<size}))",
  "elif op=='search':",
  " rx=re.compile(q['pattern'][:200]); hits=[]; limit=min(int(q.get('maxMatches') or 100),300)",
  " for base,dirs,files in os.walk(p):",
  "  dirs[:]=[d for d in dirs if d not in ('.git','__pycache__','.venv','site-packages')]",
  "  for f in files:",
  "   fp=os.path.join(base,f)",
  "   try:",
  "    if os.path.islink(fp) or os.path.getsize(fp)>2000000: continue",
  "    with open(fp,'r',encoding='utf-8',errors='replace') as fh:",
  "     for i,line in enumerate(fh,1):",
  "      if rx.search(line): hits.append({'path':rel(fp),'line':i,'text':line.rstrip()[:300]})",
  "      if len(hits)>=limit: break",
  "   except OSError: pass",
  "   if len(hits)>=limit: break",
  "  if len(hits)>=limit: break",
  " print(json.dumps({'matches':hits,'truncated':len(hits)>=limit}))",
].join("\n");

type VerifiedImage = { imageId: string; repoDigests: string[] };

type InspectedImage = {
  id: string;
  user: string;
  platform: string | null;
  envKeys: string[];
  repoDigests: string[];
};

type DockerImageInfo = {
  Id?: unknown;
  Os?: string;
  Architecture?: string;
  RepoDigests?: unknown[];
  Config?: { User?: string; Env?: unknown };
};

type DockerContainerInfo = {
  Image?: string;
  ImageManifestDescriptor?: { digest?: string; platform?: { os?: string; architecture?: string } };
  Config?: { User?: string; Env?: unknown };
  HostConfig?: {
    NetworkMode?: string;
    ReadonlyRootfs?: boolean;
    CapDrop?: string[] | null;
    CapAdd?: string[] | null;
    SecurityOpt?: string[] | null;
    Privileged?: boolean;
  };
  Mounts?: Array<{ Source?: string; Destination?: string; RW?: boolean }> | null;
};

function envKeys(env: unknown): string[] {
  if (!Array.isArray(env)) return [];
  return env.filter((item): item is string => typeof item === "string").map((item) => item.split("=")[0] ?? "");
}

function isNonRootUser(user: string): boolean {
  return user !== "" && user !== "0" && !user.startsWith("root") && !user.startsWith("0:");
}

/** Whether a variable name looks like a credential or configures a provider, cloud, or registry. */
export function isCredentialEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return CREDENTIAL_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)) || CREDENTIAL_ENV_PATTERN.test(upper);
}

/**
 * Why a resolved host path may not be mounted into a lab, or null. The Docker
 * socket, kernel and device trees, host configuration, and credential
 * directories are refused, as is any directory that contains one of them.
 */
export function forbiddenMountReason(resolvedPath: string, home = process.env.HOME): string | null {
  const within = (path: string, root: string): boolean => root === "/" || path === root || path.startsWith(`${root}/`);
  const protectedPaths = [
    ...DOCKER_SOCKET_PATHS,
    ...(home && home !== "/" ? CREDENTIAL_DIRECTORIES.map((entry) => posix.join(home, entry)) : []),
  ];
  const hostSocket = /^unix:\/\/(\/.+)$/u.exec(process.env.DOCKER_HOST ?? "")?.[1];
  if (hostSocket) protectedPaths.push(hostSocket);
  for (const path of protectedPaths) {
    if (within(resolvedPath, path)) return `is a protected host path (${path})`;
    if (within(path, resolvedPath)) return `contains a protected host path (${path})`;
  }
  for (const root of FORBIDDEN_MOUNT_ROOTS) {
    if (within(resolvedPath, root)) return `is inside ${root}`;
  }
  return null;
}

function mountArgument(source: string, target: string, readonly: boolean): string {
  if (source.includes(",") || target.includes(",")) {
    throw new LabError("input_rejected", "mount paths must not contain commas");
  }
  return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
}

function describeCommand(command: z.infer<typeof ArgvCommandSchema>): string {
  const text = [command.executable, ...command.args].join(" ");
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function emptyText(): BoundedText {
  return { text: "", bytes: 0, truncated: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
