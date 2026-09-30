import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  constants as fsConstants,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerCliRuntime, type ContainerRuntime, type RuntimeCommandResult } from "@dejaml/lab-manager";

import { PrepError, type PrepCleanupReceipt } from "./errors.js";
import { DEFAULT_PREP_POLICY, parsePrepPolicy, type PrepPolicy } from "./policy.js";
import {
  classifyPipFailure,
  parsePipReport,
  parseProxyLog,
  ResolvedPackageSchema,
  tail,
  type ProxyLogEntry,
  type ResolvedPackage,
} from "./report.js";
import { parseRequirementLine } from "./requirements.js";

export const PREP_LABEL = "dejaml.prep";
export const RUN_LABEL = "dejaml.run";
export const PROXY_ALIAS = "egress";
export const PROXY_PORT = 3128;
/** The unprivileged uid:gid every preparation container runs as (`nobody`). */
export const PREP_USER = "65534:65534";
const PROXY_SCRIPT_TARGET = "/opt/dejaml/egress_proxy.py";
const CA_TARGET = "/etc/dejaml/ca-bundle.pem";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const PREP_ID_PATTERN = /^prep_[a-f0-9]{32}$/u;
const MAX_REQUIREMENTS = 500;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_CA_BYTES = 4 * 1024 * 1024;
const PROXY_IDLE_TIMEOUT_S = 60;
/** Extra proxy budget on top of maxTotalBytes for index pages, metadata and TLS overhead. */
const PROXY_OVERHEAD_BYTES = 128 * 1024 * 1024;
const CLEANUP_OUTPUT_BYTES = 64 * 1024;

export const DEFAULT_PROXY_SCRIPT_PATH = fileURLToPath(new URL("../proxy/egress_proxy.py", import.meta.url));

export type DependencyPreparerOptions = {
  /** Verified, content-addressed wheel cache: `<cacheDir>/wheels/<sha256>/<filename>`. */
  cacheDir: string;
  policy?: PrepPolicy;
  runtime?: ContainerRuntime;
  /** Parent of per-call temp directories (default `<os tmp>/dejaml-prep`). */
  workRoot?: string;
  /** Parent of per-run wheelhouses (default `<cacheDir>/wheelhouses`). */
  wheelhouseRoot?: string;
  proxyScriptPath?: string;
  now?: () => Date;
};

export type ResolvePythonInput = {
  runId: string;
  /** Validated requirement specs only (see parseRequirementLine). */
  requirements: string[];
  /** Also resolve `pip` so the offline lab (whose image has no pip) can install from the pip wheel. */
  includeInstaller?: boolean;
  signal?: AbortSignal;
};

export type PythonResolution = {
  resolutionId: string;
  runId: string;
  requested: string[];
  includeInstaller: boolean;
  /** Everything to install in the lab (the installer excluded). */
  packages: ResolvedPackage[];
  installer: ResolvedPackage | null;
  image: string;
  imageId: string;
  pythonVersion: string | null;
  platform: string | null;
  proxyLog: ProxyLogEntry[];
  resolvedAt: string;
  cleanup: PrepCleanupReceipt;
};

export type DownloadOptions = { signal?: AbortSignal };

export type ManifestPackage = {
  name: string;
  version: string;
  filename: string;
  sha256: string;
  bytes: number;
  url: string;
  requested: boolean;
  cached: boolean;
};

export type DependencyManifest = {
  schemaVersion: 1;
  prepId: string;
  resolutionId: string;
  runId: string;
  requested: string[];
  packages: ManifestPackage[];
  installer: ManifestPackage | null;
  totalBytes: number;
  policy: PrepPolicy;
  image: string;
  imageId: string;
  pythonVersion: string | null;
  cache: { hits: number; downloaded: number; evicted: number; downloaderSkipped: boolean };
  proxyLog: { resolve: ProxyLogEntry[]; download: ProxyLogEntry[] };
  timestamps: { resolvedAt: string; downloadStartedAt: string; completedAt: string };
  cleanup: { resolve: PrepCleanupReceipt; download: PrepCleanupReceipt | null };
  /** Host path of the per-run wheelhouse (not written into manifest.json). */
  wheelhouseDir: string;
};

export type EgressProbeResult = {
  prepId: string;
  results: Record<string, string>;
  proxyLog: ProxyLogEntry[];
  cleanup: PrepCleanupReceipt;
};

export type OrphanCleanupReceipt = {
  containersRemoved: string[];
  networksRemoved: string[];
  tempDirsRemoved: number;
  verifiedAbsent: boolean;
};

type Topology = {
  prepId: string;
  runId: string;
  network: string;
  proxy: string;
  tempDir: string;
  containers: string[];
  networkCreated: boolean;
  imageId: string;
};

type CallSignals = { signal: AbortSignal; user: AbortSignal | undefined };

type WorkerRun = { result: RuntimeCommandResult; stderrTail: string; oomKilled: boolean };

function hexId(): string {
  return randomBytes(16).toString("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new PrepError("invalid_requirement", "runId has an invalid format");
}

function mountArgument(source: string, target: string, readonly: boolean): string {
  if (source.includes(",") || target.includes(",")) {
    throw new PrepError("runtime_error", "mount paths must not contain commas");
  }
  return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
}

/**
 * Trust zone 2: fetches Python wheels for a run through short-lived,
 * locked-down containers that can reach only the configured package index,
 * and never executes (or even sees) the repository being reproduced.
 */
export class DependencyPreparer {
  readonly policy: PrepPolicy;
  readonly #runtime: ContainerRuntime;
  readonly #cacheDir: string;
  readonly #workRoot: string;
  readonly #wheelhouseRoot: string;
  readonly #proxyScriptPath: string;
  readonly #now: () => Date;

  constructor(options: DependencyPreparerOptions) {
    this.policy = parsePrepPolicy(options.policy ?? DEFAULT_PREP_POLICY);
    this.#runtime = options.runtime ?? new DockerCliRuntime();
    this.#cacheDir = options.cacheDir;
    this.#workRoot = options.workRoot ?? join(tmpdir(), "dejaml-prep");
    this.#wheelhouseRoot = options.wheelhouseRoot ?? join(options.cacheDir, "wheelhouses");
    this.#proxyScriptPath = options.proxyScriptPath ?? DEFAULT_PROXY_SCRIPT_PATH;
    this.#now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Resolve
  // -------------------------------------------------------------------------

  async resolvePython(input: ResolvePythonInput): Promise<PythonResolution> {
    assertRunId(input.runId);
    const includeInstaller = input.includeInstaller === true;
    if (input.requirements.length > MAX_REQUIREMENTS) {
      throw new PrepError("limit_exceeded", `at most ${MAX_REQUIREMENTS} requirements may be resolved at once`);
    }
    const specs: string[] = [];
    for (const text of input.requirements) {
      const parsed = parseRequirementLine(text);
      if (!parsed.ok) throw new PrepError("invalid_requirement", `rejected requirement: ${parsed.reason}`, { detail: text.slice(0, 200) });
      if (!parsed.requirement) throw new PrepError("invalid_requirement", "empty requirement");
      if (!specs.includes(parsed.requirement.spec)) specs.push(parsed.requirement.spec);
    }
    if (specs.length === 0 && !includeInstaller) throw new PrepError("invalid_requirement", "no requirements to resolve");
    const lines = includeInstaller && !specs.some((spec) => /^pip(\[|[<>=!~;]|$)/u.test(spec)) ? [...specs, "pip"] : specs;

    return this.#withTopology(input.runId, input.signal, async (topology, signals) => {
      await writeFile(join(topology.tempDir, "in", "requirements.in"), `${lines.join("\n")}\n`, { mode: 0o444 });
      const run = await this.#runWorker(topology, signals, "resolve", [
        "-m", "pip", "install",
        "--dry-run",
        "--ignore-installed",
        "--only-binary=:all:",
        "--progress-bar=off",
        "--report", "/out/report.json",
        "-r", "/in/requirements.in",
      ], "/out");
      const proxyLog = await this.#proxyLog(topology);
      if (run.result.exitCode !== 0) {
        throw classifyPipFailure({ stderr: run.stderrTail, proxyLog, exitCode: run.result.exitCode, oomKilled: run.oomKilled });
      }
      const reportPath = join(topology.tempDir, "out", "report.json");
      const stat = await lstat(reportPath).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_REPORT_BYTES) {
        throw new PrepError("runtime_error", "pip did not produce a usable report", { detail: tail(run.stderrTail) });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        throw new PrepError("runtime_error", "pip report is not valid JSON");
      }
      const report = parsePipReport(raw, this.policy);
      const installer = includeInstaller ? (report.packages.find((pkg) => pkg.name === "pip") ?? null) : null;
      if (includeInstaller && !installer) throw new PrepError("runtime_error", "the resolution did not include the pip installer wheel");
      return {
        resolutionId: topology.prepId,
        runId: input.runId,
        requested: specs,
        includeInstaller,
        packages: report.packages.filter((pkg) => pkg !== installer),
        installer,
        image: this.policy.image,
        imageId: topology.imageId,
        pythonVersion: report.pythonVersion,
        platform: report.platform,
        proxyLog,
        resolvedAt: this.#now().toISOString(),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Download + verify + wheelhouse
  // -------------------------------------------------------------------------

  async downloadWheels(resolution: PythonResolution, options: DownloadOptions = {}): Promise<DependencyManifest> {
    assertRunId(resolution.runId);
    if (!PREP_ID_PATTERN.test(resolution.resolutionId)) throw new PrepError("invalid_requirement", "invalid resolution id");
    const downloadStartedAt = this.#now().toISOString();
    const all = [...resolution.packages, ...(resolution.installer ? [resolution.installer] : [])].map((pkg) => {
      const parsed = ResolvedPackageSchema.safeParse(pkg);
      if (!parsed.success) throw new PrepError("invalid_requirement", "resolution contains an invalid package entry");
      const host = new URL(parsed.data.url).hostname.toLowerCase();
      if (!this.policy.allowedHosts.includes(host)) {
        throw new PrepError("egress_denied", `${parsed.data.name} would download from ${host}, which is not an allowed host`);
      }
      return parsed.data;
    });
    if (all.length > this.policy.maxPackages) {
      throw new PrepError("limit_exceeded", `resolution has ${all.length} packages; the policy allows ${this.policy.maxPackages}`);
    }
    if (new Set(all.map((pkg) => pkg.name)).size !== all.length) {
      throw new PrepError("invalid_requirement", "resolution lists a package twice");
    }

    const wheelsDir = join(this.#cacheDir, "wheels");
    await mkdir(wheelsDir, { recursive: true, mode: 0o755 });
    const sizes = new Map<string, number>();
    const cachedNames = new Set<string>();
    let evicted = 0;
    for (const pkg of all) {
      const cached = await this.#cachedWheel(pkg);
      if (cached === "evicted") evicted += 1;
      if (typeof cached === "number") {
        sizes.set(pkg.name, cached);
        cachedNames.add(pkg.name);
      }
    }
    const missing = all.filter((pkg) => !cachedNames.has(pkg.name));

    let downloadLog: ProxyLogEntry[] = [];
    let downloadCleanup: PrepCleanupReceipt | null = null;
    if (missing.length > 0) {
      const outcome = await this.#withTopology(resolution.runId, options.signal, async (topology, signals) => {
        const pinned = missing.map((pkg) => `${pkg.name}==${pkg.version} --hash=sha256:${pkg.sha256}`).join("\n");
        await writeFile(join(topology.tempDir, "in", "pinned.txt"), `${pinned}\n`, { mode: 0o444 });
        const run = await this.#runWorker(topology, signals, "download", [
          "-m", "pip", "download",
          "--no-deps",
          "--only-binary=:all:",
          "--require-hashes",
          "--progress-bar=off",
          "--dest", "/wheels",
          "-r", "/in/pinned.txt",
        ], "/wheels");
        const proxyLog = await this.#proxyLog(topology);
        if (run.result.exitCode !== 0) {
          if (/DO NOT MATCH THE HASHES/u.test(run.stderrTail)) {
            throw new PrepError("integrity_error", "a downloaded wheel did not match its resolved sha256", { detail: tail(run.stderrTail) });
          }
          throw classifyPipFailure({ stderr: run.stderrTail, proxyLog, exitCode: run.result.exitCode, oomKilled: run.oomKilled });
        }
        const verified = await this.#verifyDownloads(join(topology.tempDir, "out"), missing, all, sizes);
        for (const [name, bytes] of verified) sizes.set(name, bytes);
        return { proxyLog };
      });
      downloadLog = outcome.proxyLog;
      downloadCleanup = outcome.cleanup;
    }

    const totalBytes = all.reduce((sum, pkg) => sum + (sizes.get(pkg.name) ?? 0), 0);
    if (totalBytes > this.policy.maxTotalBytes) {
      throw new PrepError("limit_exceeded", `wheels total ${totalBytes} bytes; the policy allows ${this.policy.maxTotalBytes}`);
    }

    const prepId = `prep_${hexId()}`;
    const toManifest = (pkg: ResolvedPackage): ManifestPackage => ({
      name: pkg.name,
      version: pkg.version,
      filename: pkg.filename,
      sha256: pkg.sha256,
      bytes: sizes.get(pkg.name) ?? 0,
      url: pkg.url,
      requested: pkg.requested,
      cached: cachedNames.has(pkg.name),
    });
    const wheelhouseDir = join(this.#wheelhouseRoot, `${resolution.runId}-${prepId.slice(5, 17)}`);
    const manifest: DependencyManifest = {
      schemaVersion: 1,
      prepId,
      resolutionId: resolution.resolutionId,
      runId: resolution.runId,
      requested: resolution.requested,
      packages: resolution.packages.map(toManifest),
      installer: resolution.installer ? toManifest(resolution.installer) : null,
      totalBytes,
      policy: this.policy,
      image: resolution.image,
      imageId: resolution.imageId,
      pythonVersion: resolution.pythonVersion,
      cache: { hits: cachedNames.size, downloaded: missing.length, evicted, downloaderSkipped: missing.length === 0 },
      proxyLog: { resolve: resolution.proxyLog, download: downloadLog },
      timestamps: { resolvedAt: resolution.resolvedAt, downloadStartedAt, completedAt: "" },
      cleanup: { resolve: resolution.cleanup, download: downloadCleanup },
      wheelhouseDir,
    };
    await this.#buildWheelhouse(manifest, all);
    return manifest;
  }

  // -------------------------------------------------------------------------
  // Egress self-test (used by the Docker proof and by operators)
  // -------------------------------------------------------------------------

  /**
   * Run a probe inside a preparation worker (same network and restrictions as
   * the resolver): a direct TCP connection, DNS, and CONNECT requests through
   * the egress proxy. Returns what the probe saw plus the proxy's own log.
   */
  async probeEgress(input: { runId: string; signal?: AbortSignal }): Promise<EgressProbeResult> {
    assertRunId(input.runId);
    const allowed = this.policy.allowedHosts[0] ?? "pypi.org";
    const script = [
      "import json, socket",
      "out = {}",
      "def attempt(key, fn):",
      "    try:",
      "        out[key] = fn()",
      "    except Exception as error:",
      "        out[key] = 'blocked (%s: %s)' % (type(error).__name__, error)",
      "def direct():",
      "    socket.create_connection(('1.1.1.1', 443), timeout=5).close()",
      "    return 'connected'",
      "def dns():",
      "    return 'resolved %s' % socket.getaddrinfo('example.com', 443)[0][4][0]",
      "def via_proxy(target):",
      `    sock = socket.create_connection(('${PROXY_ALIAS}', ${PROXY_PORT}), timeout=10)`,
      "    sock.sendall(('CONNECT %s HTTP/1.1\\r\\nHost: %s\\r\\n\\r\\n' % (target, target)).encode())",
      "    line = sock.recv(256).split(b'\\r\\n')[0].decode()",
      "    sock.close()",
      "    return line",
      "attempt('direct 1.1.1.1:443', direct)",
      "attempt('dns example.com', dns)",
      `for target in ['example.com:443', '${allowed}:80', '1.1.1.1:443', '169.254.169.254:443', '${allowed}:443']:`,
      "    attempt('CONNECT ' + target, lambda: via_proxy(target))",
      "print(json.dumps(out))",
    ].join("\n");
    return this.#withTopology(input.runId, input.signal, async (topology, signals) => {
      const run = await this.#runWorker(topology, signals, "probe", ["-c", script], null);
      const proxyLog = await this.#proxyLog(topology);
      const line = run.result.stdout.text.trim().split("\n").at(-1) ?? "";
      let results: Record<string, string>;
      try {
        results = JSON.parse(line) as Record<string, string>;
      } catch {
        throw new PrepError("runtime_error", "egress probe produced no result", { detail: tail(run.stderrTail) });
      }
      return { prepId: topology.prepId, results, proxyLog };
    });
  }

  // -------------------------------------------------------------------------
  // Orphans
  // -------------------------------------------------------------------------

  /** Remove every container, network and temp directory left by earlier preparations. */
  async cleanupOrphans(): Promise<OrphanCleanupReceipt> {
    const containers = await this.#listLabelled(["ps", "--all", "--filter", `label=${PREP_LABEL}`, "--format", "{{.Names}}"]);
    const containersRemoved: string[] = [];
    for (const name of containers) {
      const result = await this.#runtime.docker(["rm", "--force", "--volumes", name], { maxOutputBytes: CLEANUP_OUTPUT_BYTES });
      if (result.exitCode === 0) containersRemoved.push(name);
    }
    const networks = await this.#listLabelled(["network", "ls", "--filter", `label=${PREP_LABEL}`, "--format", "{{.Name}}"]);
    const networksRemoved: string[] = [];
    for (const name of networks) {
      const result = await this.#runtime.docker(["network", "rm", name], { maxOutputBytes: CLEANUP_OUTPUT_BYTES });
      if (result.exitCode === 0) networksRemoved.push(name);
    }
    let tempDirsRemoved = 0;
    const entries = await readdir(this.#workRoot).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!/^prep_[a-f0-9]{32}-/u.test(entry)) continue;
      await rm(join(this.#workRoot, entry), { recursive: true, force: true });
      tempDirsRemoved += 1;
    }
    const verifiedAbsent =
      (await this.#listLabelled(["ps", "--all", "--filter", `label=${PREP_LABEL}`, "--format", "{{.Names}}"])).length === 0 &&
      (await this.#listLabelled(["network", "ls", "--filter", `label=${PREP_LABEL}`, "--format", "{{.Name}}"])).length === 0;
    return { containersRemoved, networksRemoved, tempDirsRemoved, verifiedAbsent };
  }

  // -------------------------------------------------------------------------
  // Topology
  // -------------------------------------------------------------------------

  async #withTopology<T extends object>(
    runId: string,
    userSignal: AbortSignal | undefined,
    body: (topology: Topology, signals: CallSignals) => Promise<T>,
  ): Promise<T & { cleanup: PrepCleanupReceipt }> {
    const id = hexId();
    const prepId = `prep_${id}`;
    const network = `dejaml-prep-${id}`;
    const deadline = AbortSignal.timeout(this.policy.timeoutSeconds * 1000);
    const signal = userSignal ? AbortSignal.any([userSignal, deadline]) : deadline;
    const signals: CallSignals = { signal, user: userSignal };
    const topology: Topology = {
      prepId,
      runId,
      network,
      proxy: `${network}-egress`,
      tempDir: "",
      containers: [],
      networkCreated: false,
      imageId: "",
    };
    let value: T | undefined;
    let failure: unknown;
    try {
      this.#checkAborted(signals);
      await mkdir(this.#workRoot, { recursive: true, mode: 0o700 });
      topology.tempDir = await mkdtemp(join(this.#workRoot, `${prepId}-`));
      topology.imageId = await this.#verifyImage(signals);
      await this.#prepareTempDir(topology);
      await this.#startNetworkAndProxy(topology, signals);
      value = await body(topology, signals);
      this.#checkAborted(signals);
    } catch (error) {
      failure = error;
    }
    const cleanup = await this.#cleanup(topology);
    if (failure !== undefined || value === undefined) {
      const error = this.#toPrepError(failure, signals);
      error.cleanup = cleanup;
      throw error;
    }
    return { ...value, cleanup };
  }

  #toPrepError(error: unknown, signals: CallSignals): PrepError {
    if (signals.user?.aborted) return new PrepError("cancelled", "dependency preparation was cancelled");
    if (signals.signal.aborted) {
      return new PrepError("timeout", `dependency preparation exceeded ${this.policy.timeoutSeconds}s`);
    }
    if (error instanceof PrepError) return error;
    return new PrepError("runtime_error", error instanceof Error ? error.message : String(error));
  }

  #checkAborted(signals: CallSignals): void {
    if (signals.signal.aborted) throw this.#toPrepError(undefined, signals);
  }

  async #docker(args: string[], signals: CallSignals | null, what: string, maxOutputBytes = 256 * 1024): Promise<RuntimeCommandResult> {
    const result = await this.#runtime.docker(args, signals ? { signal: signals.signal, maxOutputBytes } : { maxOutputBytes });
    if (signals && (result.aborted || signals.signal.aborted)) throw this.#toPrepError(undefined, signals);
    if (result.exitCode !== 0) {
      throw new PrepError("runtime_error", `${what} failed`, { detail: tail(result.stderr.text) });
    }
    return result;
  }

  async #verifyImage(signals: CallSignals): Promise<string> {
    const result = await this.#runtime.docker(["image", "inspect", "--format", "{{.Id}}", this.policy.image], {
      signal: signals.signal,
      maxOutputBytes: 4096,
    });
    this.#checkAborted(signals);
    if (result.exitCode !== 0) {
      throw new PrepError(
        "runtime_error",
        `preparation image ${this.policy.image} is not present locally; images are never pulled implicitly`,
        { detail: tail(result.stderr.text) },
      );
    }
    const imageId = result.stdout.text.trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new PrepError("runtime_error", "unexpected image ID format");
    if (this.policy.expectedImageId && imageId !== this.policy.expectedImageId) {
      throw new PrepError("image_mismatch", `preparation image ID ${imageId} does not match the expected ${this.policy.expectedImageId}`);
    }
    return imageId;
  }

  async #prepareTempDir(topology: Topology): Promise<void> {
    const inDir = join(topology.tempDir, "in");
    const outDir = join(topology.tempDir, "out");
    await mkdir(inDir, { mode: 0o755 });
    await mkdir(outDir, { mode: 0o755 });
    await chmod(inDir, 0o755);
    // The containers run as 65534 and must be able to write the output mount.
    if (process.getuid?.() === 0) await chown(outDir, 65534, 65534);
    else await chmod(outDir, 0o777);
    if (this.policy.caBundlePath) {
      const stat = await lstat(this.policy.caBundlePath).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_CA_BYTES) {
        throw new PrepError("invalid_policy", "caBundlePath must be a regular file of at most 4 MiB");
      }
      // Copied so the mount is a private, world-readable snapshot, never a host directory.
      await copyFile(this.policy.caBundlePath, join(inDir, "ca-bundle.pem"));
      await chmod(join(inDir, "ca-bundle.pem"), 0o444);
    }
  }

  #labels(topology: Topology): string[] {
    return ["--label", `${PREP_LABEL}=${topology.prepId}`, "--label", `${RUN_LABEL}=${topology.runId}`];
  }

  #hardening(): string[] {
    return ["--user", PREP_USER, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
  }

  async #startNetworkAndProxy(topology: Topology, signals: CallSignals): Promise<void> {
    const script = await realpath(this.#proxyScriptPath).catch(() => null);
    const scriptStat = script ? await lstat(script) : null;
    if (!script || !scriptStat?.isFile()) throw new PrepError("runtime_error", "egress proxy script not found");

    await this.#docker(
      ["network", "create", "--internal", ...this.#labels(topology), topology.network],
      signals,
      "network create",
    );
    topology.networkCreated = true;

    const budget = this.policy.maxTotalBytes + PROXY_OVERHEAD_BYTES;
    topology.containers.push(topology.proxy);
    await this.#docker(
      [
        "create",
        "--name", topology.proxy,
        "--pull", "never",
        ...this.#labels(topology),
        "--network", "bridge",
        ...this.#hardening(),
        "--pids-limit", "64",
        "--memory", "128m",
        "--memory-swap", "128m",
        "--cpus", "0.5",
        "--mount", mountArgument(script, PROXY_SCRIPT_TARGET, true),
        "--entrypoint", "python",
        topology.imageId,
        "-I", "-u", PROXY_SCRIPT_TARGET,
        "--listen", `0.0.0.0:${PROXY_PORT}`,
        ...this.policy.allowedHosts.flatMap((host) => ["--allow", host]),
        "--budget-bytes", String(budget),
        "--idle-timeout", String(PROXY_IDLE_TIMEOUT_S),
      ],
      signals,
      "egress proxy create",
    );
    await this.#docker(
      ["network", "connect", "--alias", PROXY_ALIAS, topology.network, topology.proxy],
      signals,
      "egress proxy network connect",
    );
    await this.#docker(["start", topology.proxy], signals, "egress proxy start");

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const logs = await this.#runtime.docker(["logs", topology.proxy], { signal: signals.signal, maxOutputBytes: 64 * 1024 });
      this.#checkAborted(signals);
      if (parseProxyLog(logs.stdout.text).some((entry) => entry.event === "listening")) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new PrepError("runtime_error", "egress proxy did not start");
  }

  async #runWorker(
    topology: Topology,
    signals: CallSignals,
    role: "resolve" | "download" | "probe",
    command: string[],
    outputTarget: "/out" | "/wheels" | null,
  ): Promise<WorkerRun> {
    const name = `${topology.network}-${role}`;
    const inDir = join(topology.tempDir, "in");
    const env: string[] =
      role === "probe"
        ? ["--env", "HOME=/tmp"]
        : [
            "--env", "HOME=/tmp",
            "--env", `HTTPS_PROXY=http://${PROXY_ALIAS}:${PROXY_PORT}`,
            "--env", `PIP_INDEX_URL=${this.policy.indexUrl}`,
            "--env", "PIP_DISABLE_PIP_VERSION_CHECK=1",
            "--env", "PIP_NO_INPUT=1",
            "--env", "PIP_NO_CACHE_DIR=1",
            ...(this.policy.caBundlePath ? ["--env", `PIP_CERT=${CA_TARGET}`] : []),
          ];
    const mounts: string[] = [];
    if (role !== "probe") {
      mounts.push("--mount", mountArgument(inDir, "/in", true));
      if (this.policy.caBundlePath) mounts.push("--mount", mountArgument(join(inDir, "ca-bundle.pem"), CA_TARGET, true));
    }
    if (outputTarget) mounts.push("--mount", mountArgument(join(topology.tempDir, "out"), outputTarget, false));

    topology.containers.push(name);
    let stderrTail = "";
    const result = await this.#runtime.docker(
      [
        "run",
        "--name", name,
        "--pull", "never",
        ...this.#labels(topology),
        "--network", topology.network,
        ...this.#hardening(),
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=512m",
        "--cpus", String(this.policy.cpus),
        "--memory", `${this.policy.memoryMb}m`,
        "--memory-swap", `${this.policy.memoryMb}m`,
        "--pids-limit", String(this.policy.pids),
        ...env,
        ...mounts,
        "--workdir", "/tmp",
        "--entrypoint", "python",
        topology.imageId,
        ...command,
      ],
      {
        signal: signals.signal,
        maxOutputBytes: 256 * 1024,
        onOutput: (stream, chunk) => {
          if (stream === "stderr" || role !== "probe") stderrTail = tail(stderrTail + chunk, 8192);
        },
      },
    );
    this.#checkAborted(signals);
    if (result.aborted) throw this.#toPrepError(undefined, signals);
    let oomKilled = false;
    if (result.exitCode !== 0) {
      const inspect = await this.#runtime.docker(["inspect", "--format", "{{.State.OOMKilled}}", name], { maxOutputBytes: 1024 });
      oomKilled = inspect.exitCode === 0 && inspect.stdout.text.trim() === "true";
    }
    // onOutput sees the full stream; the bounded capture keeps only its start.
    const combined = stderrTail !== "" ? stderrTail : `${result.stdout.text}${result.stderr.text}`;
    return { result, stderrTail: tail(combined), oomKilled };
  }

  async #proxyLog(topology: Topology): Promise<ProxyLogEntry[]> {
    const logs = await this.#runtime.docker(["logs", topology.proxy], { maxOutputBytes: 4 * 1024 * 1024 });
    return parseProxyLog(logs.stdout.text).filter((entry) => entry.event !== "listening");
  }

  async #listLabelled(args: string[]): Promise<string[]> {
    const result = await this.#runtime.docker(args, { maxOutputBytes: CLEANUP_OUTPUT_BYTES });
    if (result.exitCode !== 0) throw new PrepError("runtime_error", `docker ${args.slice(0, 2).join(" ")} failed`);
    return result.stdout.text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  }

  /** Always runs, on every exit path, without the (possibly aborted) call signal. */
  async #cleanup(topology: Topology): Promise<PrepCleanupReceipt> {
    const containersRemoved: string[] = [];
    for (const name of [...topology.containers].reverse()) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await this.#runtime
          .docker(["rm", "--force", "--volumes", name], { maxOutputBytes: CLEANUP_OUTPUT_BYTES })
          .catch(() => null);
        if (result && (result.exitCode === 0 || /No such container/u.test(result.stderr.text))) {
          containersRemoved.push(name);
          break;
        }
      }
    }
    let networkRemoved = !topology.networkCreated;
    if (topology.networkCreated) {
      for (let attempt = 0; attempt < 3 && !networkRemoved; attempt += 1) {
        const result = await this.#runtime
          .docker(["network", "rm", topology.network], { maxOutputBytes: CLEANUP_OUTPUT_BYTES })
          .catch(() => null);
        networkRemoved = result !== null && (result.exitCode === 0 || /not found/u.test(result.stderr.text));
        if (!networkRemoved) await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    let tempRemoved = topology.tempDir === "";
    if (topology.tempDir !== "") {
      await rm(topology.tempDir, { recursive: true, force: true }).catch(() => undefined);
      tempRemoved = (await lstat(topology.tempDir).catch(() => null)) === null;
    }
    let verifiedAbsent = false;
    try {
      const containers = await this.#listLabelled(["ps", "--all", "--filter", `label=${PREP_LABEL}=${topology.prepId}`, "--format", "{{.Names}}"]);
      const networks = await this.#listLabelled(["network", "ls", "--filter", `label=${PREP_LABEL}=${topology.prepId}`, "--format", "{{.Name}}"]);
      verifiedAbsent = containers.length === 0 && networks.length === 0;
    } catch {
      verifiedAbsent = false;
    }
    return { prepId: topology.prepId, containersRemoved, networkRemoved, tempRemoved, verifiedAbsent };
  }

  // -------------------------------------------------------------------------
  // Cache and wheelhouse
  // -------------------------------------------------------------------------

  #cachePath(pkg: ResolvedPackage): string {
    return join(this.#cacheDir, "wheels", pkg.sha256, pkg.filename);
  }

  /** Size of a verified cached wheel, "evicted" if a corrupt entry was removed, or null. */
  async #cachedWheel(pkg: ResolvedPackage): Promise<number | "evicted" | null> {
    const path = this.#cachePath(pkg);
    const stat = await lstat(path).catch(() => null);
    if (!stat) return null;
    if (stat.isFile() && stat.size <= this.policy.maxFileBytes && (await sha256File(path)) === pkg.sha256) return stat.size;
    await rm(join(this.#cacheDir, "wheels", pkg.sha256), { recursive: true, force: true });
    return "evicted";
  }

  async #verifyDownloads(
    dir: string,
    expected: ResolvedPackage[],
    all: ResolvedPackage[],
    knownSizes: Map<string, number>,
  ): Promise<Map<string, number>> {
    const byFilename = new Map(expected.map((pkg) => [pkg.filename, pkg]));
    const entries = await readdir(dir);
    const sizes = new Map<string, number>();
    let total = all.reduce((sum, pkg) => sum + (knownSizes.get(pkg.name) ?? 0), 0);
    for (const entry of entries) {
      const pkg = byFilename.get(entry);
      if (!pkg) throw new PrepError("integrity_error", `unexpected file in the download directory: ${entry.slice(0, 120)}`);
      const path = join(dir, entry);
      const stat = await lstat(path);
      if (!stat.isFile()) throw new PrepError("integrity_error", `${entry} is not a regular file`);
      if (stat.size > this.policy.maxFileBytes) {
        throw new PrepError("limit_exceeded", `${entry} is ${stat.size} bytes; the policy allows ${this.policy.maxFileBytes} per file`);
      }
      total += stat.size;
      if (total > this.policy.maxTotalBytes) {
        throw new PrepError("limit_exceeded", `wheels exceed the ${this.policy.maxTotalBytes}-byte total limit`);
      }
      const digest = await sha256File(path);
      if (digest !== pkg.sha256) throw new PrepError("integrity_error", `${entry} sha256 ${digest} does not match the resolved ${pkg.sha256}`);
      sizes.set(pkg.name, stat.size);
    }
    for (const pkg of expected) {
      if (!sizes.has(pkg.name)) throw new PrepError("integrity_error", `${pkg.filename} was not downloaded`);
    }
    // Only fully verified files enter the write-once cache.
    for (const pkg of expected) {
      const target = this.#cachePath(pkg);
      const targetDir = join(this.#cacheDir, "wheels", pkg.sha256);
      await mkdir(targetDir, { recursive: true, mode: 0o755 });
      if (await lstat(target).catch(() => null)) {
        if ((await sha256File(target)) !== pkg.sha256) throw new PrepError("integrity_error", `cache entry ${target} is corrupt`);
        continue;
      }
      const staging = join(targetDir, `.${hexId()}.partial`);
      await copyFile(join(dir, pkg.filename), staging, fsConstants.COPYFILE_EXCL);
      await chmod(staging, 0o444);
      if ((await sha256File(staging)) !== pkg.sha256) {
        await rm(staging, { force: true });
        throw new PrepError("integrity_error", `${pkg.filename} changed while entering the cache`);
      }
      await rename(staging, target);
    }
    return sizes;
  }

  async #buildWheelhouse(manifest: DependencyManifest, all: ResolvedPackage[]): Promise<void> {
    const dir = manifest.wheelhouseDir;
    await mkdir(this.#wheelhouseRoot, { recursive: true, mode: 0o755 });
    await mkdir(dir, { mode: 0o755 });
    try {
      for (const pkg of all) {
        const target = join(dir, pkg.filename);
        await copyFile(this.#cachePath(pkg), target, fsConstants.COPYFILE_EXCL);
        await chmod(target, 0o444);
        if ((await sha256File(target)) !== pkg.sha256) {
          throw new PrepError("integrity_error", `${pkg.filename} changed while building the wheelhouse`);
        }
      }
      const lock = manifest.packages.map((pkg) => `${pkg.name}==${pkg.version} --hash=sha256:${pkg.sha256}`).join("\n");
      await writeFile(join(dir, "requirements.lock.txt"), `${lock}\n`, { mode: 0o444 });
      const installer = manifest.installer
        ? { filename: manifest.installer.filename, sha256: manifest.installer.sha256, version: manifest.installer.version }
        : null;
      await writeFile(join(dir, "installer.json"), `${JSON.stringify(installer, null, 2)}\n`, { mode: 0o444 });
      manifest.timestamps.completedAt = this.#now().toISOString();
      const { wheelhouseDir: _hostPath, ...portable } = manifest;
      await writeFile(join(dir, "manifest.json"), `${JSON.stringify(portable, null, 2)}\n`, { mode: 0o444 });
      await chmod(dir, 0o555);
    } catch (error) {
      await chmod(dir, 0o755).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
}
