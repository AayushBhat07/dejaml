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

import {
  platformCacheKey,
  PlatformSpecSchema,
  wheelMachine,
  wheelMatchesPlatform,
  type ContainerPlatform,
  type PlatformSpec,
  type PythonVersion,
  type WheelTags,
} from "@dejaml/contracts";
import { DockerCliRuntime, type ContainerRuntime, type RuntimeCommandResult } from "@dejaml/lab-manager";

import { acceleratorError, findAcceleratorPackages, findAcceleratorRequirements } from "./accelerator.js";
import { validateConstraints, type CompatibilityConstraint, type ValidatedConstraint } from "./constraints.js";
import type { RejectedLine } from "./discover.js";
import { PrepError, type PrepCleanupReceipt } from "./errors.js";
import {
  dockerEnginePlatform,
  DockerPrepImageProvider,
  imageMatchesPin,
  parsePinnedReference,
  type PinnedReference,
  type PrepImage,
  type PrepImageProvider,
} from "./image.js";
import { DEFAULT_PREP_POLICY, effectivePackageIndex, parsePrepPolicy, type PrepPolicy } from "./policy.js";
import {
  classifyPipFailure,
  parsePipReport,
  parseProxyLog,
  ResolvedPackageSchema,
  tail,
  type ProxyLogEntry,
  type ResolvedPackage,
} from "./report.js";
import { parseRequirementLine, type ParsedRequirement } from "./requirements.js";
import { assertFreeSpace, defaultFreeSpaceProbe, QuotaWatcher, spaceError, type FreeSpaceProbe } from "./space.js";
import { assertWheelsMatchPlatform, pipCrossTargetArgs, sameContainerPlatform, wheelPlatformTags, type ResolverMode } from "./target.js";

export const PREP_LABEL = "dejaml.prep";
export const RUN_LABEL = "dejaml.run";
export const PROXY_ALIAS = "egress";
export const PROXY_PORT = 3128;
/** The unprivileged uid:gid preparation containers run as when the host service runs as root (`nobody`). */
export const PREP_USER = "65534:65534";
const PROXY_SCRIPT_TARGET = "/opt/dejaml/egress_proxy.py";
const CA_TARGET = "/etc/dejaml/ca-bundle.pem";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const PREP_ID_PATTERN = /^prep_[a-f0-9]{32}$/u;
const CACHE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_REQUIREMENTS = 500;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_CA_BYTES = 4 * 1024 * 1024;
const PROXY_IDLE_TIMEOUT_S = 60;
/** Extra proxy budget on top of maxTotalBytes for index pages, metadata and TLS overhead. */
const PROXY_OVERHEAD_BYTES = 128 * 1024 * 1024;
const CLEANUP_OUTPUT_BYTES = 64 * 1024;

export const DEFAULT_PROXY_SCRIPT_PATH = fileURLToPath(new URL("../proxy/egress_proxy.py", import.meta.url));

export type DependencyPreparerOptions = {
  /** Verified, content-addressed wheel cache: `<cacheDir>/wheels/<platformCacheKey>/<sha256>/<filename>`. */
  cacheDir: string;
  policy?: PrepPolicy;
  runtime?: ContainerRuntime;
  /** Image readiness (for example the lab manager's ImageReadiness); defaults to a Docker CLI provider. */
  imageProvider?: PrepImageProvider;
  /** The Docker engine's own platform; detected with `docker version` when omitted. */
  enginePlatform?: ContainerPlatform;
  /** Parent of the per-call, disk-backed temp directories (default `<os tmp>/dejaml-prep`). */
  workRoot?: string;
  /** Parent of per-run wheelhouses (default `<cacheDir>/wheelhouses`). */
  wheelhouseRoot?: string;
  proxyScriptPath?: string;
  freeSpace?: FreeSpaceProbe;
  now?: () => Date;
};

/** A validated requirement line, or a ParsedRequirement from discovery (re-validated; its `source` is kept). */
export type RequirementInput = string | Pick<ParsedRequirement, "spec" | "source">;

export type ResolvePythonInput = {
  runId: string;
  /** The approved platform: architecture, container platform, Python version/ABI, glibc, CPU-only, package index. */
  platform: PlatformSpec;
  /** Requirements from the repository (validated specs only; see parseRequirementLine). */
  requirements: RequirementInput[];
  /** Project-owned compatibility constraints (never from the repository), applied with pip `-c`. */
  constraints?: CompatibilityConstraint[];
  /** Repository lines that discovery rejected; recorded in the manifest. */
  rejected?: RejectedLine[];
  /** Also resolve `pip` so the offline lab (whose image has no pip) can install from the pip wheel. */
  includeInstaller?: boolean;
  signal?: AbortSignal;
};

export type RequirementRecord = {
  spec: string;
  name: string;
  source: "repository" | "compatibility_constraint";
  /** Why a compatibility constraint exists; null for repository requirements. */
  reason: string | null;
  origin: { file: string; line: number } | null;
};

/** One project-owned change to what the repository asked for. Every constraint appears here. */
export type CompatibilityChange = {
  name: string;
  constraint: string;
  reason: string;
  /** What the repository itself requested for this package (empty when it is only a transitive dependency). */
  repository: string[];
  /** The version that was resolved under the constraint (null when the package was not needed). */
  resolved: string | null;
  origin: { file: string; line: number } | null;
};

export type PrepImageIdentity = {
  /** The configured digest-pinned reference. */
  reference: string;
  /** `repository@sha256:…`: what the containers were created from. */
  digestReference: string;
  digest: string;
  imageId: string;
  repoDigests: string[];
  /** The platform the preparation containers ran as. */
  platform: ContainerPlatform;
  pythonVersion: PythonVersion;
};

export type ResolverInfo = {
  mode: ResolverMode;
  /** The Docker engine's platform. */
  enginePlatform: ContainerPlatform | null;
  /** The platform the wheels are for. */
  targetPlatform: ContainerPlatform;
  /** pip's explicit target options (cross mode only). */
  targetArgs: string[];
};

export type DiskReceipt = {
  workRoot: string;
  freeBytesAtStart: number;
  peakBytes: number;
  peakInodes: number;
  quotaBytes: number;
  quotaInodes: number;
};

export type PythonResolution = {
  resolutionId: string;
  runId: string;
  platform: PlatformSpec;
  platformKey: string;
  /** Repository requirement specs, as requested. */
  requested: string[];
  requirements: RequirementRecord[];
  compatibilityChanges: CompatibilityChange[];
  rejected: RejectedLine[];
  includeInstaller: boolean;
  /** Everything to install in the lab (the installer excluded). */
  packages: ResolvedPackage[];
  installer: ResolvedPackage | null;
  /** Digest-pinned image reference. */
  image: string;
  imageId: string;
  imageIdentity: PrepImageIdentity;
  resolver: ResolverInfo;
  /** Full interpreter version of the resolver, e.g. 3.11.16. */
  pythonVersion: string | null;
  /** `platform_machine` of the resolver's interpreter. */
  machine: string | null;
  proxyLog: ProxyLogEntry[];
  resolvedAt: string;
  disk: DiskReceipt;
  cleanup: PrepCleanupReceipt;
};

export type DownloadOptions = {
  /** When given, must be the platform the resolution was made for. */
  platform?: PlatformSpec;
  signal?: AbortSignal;
};

export type ManifestPackage = {
  name: string;
  version: string;
  filename: string;
  sha256: string;
  bytes: number;
  url: string;
  requested: boolean;
  cached: boolean;
  /** Tags of the wheel, validated against the manifest's platform. */
  platformTags: WheelTags;
  /** The project-owned constraint that applied to this package, if any. */
  constraint: string | null;
};

export type DependencyManifest = {
  schemaVersion: 2;
  prepId: string;
  resolutionId: string;
  runId: string;
  platform: PlatformSpec;
  platformKey: string;
  requested: string[];
  requirements: RequirementRecord[];
  compatibilityChanges: CompatibilityChange[];
  rejected: RejectedLine[];
  packages: ManifestPackage[];
  installer: ManifestPackage | null;
  totalBytes: number;
  policy: PrepPolicy;
  /** Digest-pinned image reference. */
  image: string;
  imageId: string;
  imageIdentity: PrepImageIdentity;
  resolver: ResolverInfo;
  pythonVersion: string | null;
  cache: { hits: number; downloaded: number; evicted: number; downloaderSkipped: boolean; key: string };
  proxyLog: { resolve: ProxyLogEntry[]; download: ProxyLogEntry[] };
  disk: { resolve: DiskReceipt; download: DiskReceipt | null };
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
  image: PrepImageIdentity | null;
  resolver: ResolverInfo | null;
  index: { indexUrl: string; allowedHosts: string[] };
  disk: DiskReceipt;
};

type CallSignals = { signal: AbortSignal; user: AbortSignal | undefined; quota: AbortController; quotaViolation: string | null };

type WorkerRun = { result: RuntimeCommandResult; stderrTail: string; oomKilled: boolean };

function hexId(): string {
  return randomBytes(16).toString("hex");
}

/** Streams the file through sha256; nothing is buffered whole in memory. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new PrepError("invalid_requirement", "runId has an invalid format");
}

function assertPlatform(platform: unknown): PlatformSpec {
  const parsed = PlatformSpecSchema.safeParse(platform);
  if (!parsed.success) throw new PrepError("invalid_policy", `invalid platform: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  if (parsed.data.accelerator !== "cpu_only") throw new PrepError("invalid_policy", "only the cpu_only accelerator policy is supported");
  return parsed.data;
}

function cacheKeyFor(platform: PlatformSpec): string {
  const key = platformCacheKey(platform);
  if (!CACHE_KEY_PATTERN.test(key)) throw new PrepError("invalid_policy", "platform cache key has unexpected characters");
  return key;
}

function mountArgument(source: string, target: string, readonly: boolean): string {
  if (source.includes(",") || target.includes(",")) {
    throw new PrepError("runtime_error", "mount paths must not contain commas");
  }
  return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Trust zone 2: fetches Python wheels for a run through short-lived,
 * locked-down containers that can reach only the configured package index,
 * and never executes (or even sees) the repository being reproduced.
 * Everything is for one explicit PlatformSpec.
 */
export class DependencyPreparer {
  readonly policy: PrepPolicy;
  readonly #runtime: ContainerRuntime;
  readonly #images: PrepImageProvider;
  readonly #cacheDir: string;
  readonly #workRoot: string;
  readonly #wheelhouseRoot: string;
  readonly #proxyScriptPath: string;
  readonly #freeSpace: FreeSpaceProbe;
  readonly #now: () => Date;
  readonly #user: string;
  #enginePlatform: ContainerPlatform | null | undefined;
  readonly #emulation = new Map<ContainerPlatform, boolean>();

  constructor(options: DependencyPreparerOptions) {
    this.policy = parsePrepPolicy(options.policy ?? DEFAULT_PREP_POLICY);
    this.#runtime = options.runtime ?? new DockerCliRuntime();
    this.#images = options.imageProvider ?? new DockerPrepImageProvider(this.#runtime);
    this.#enginePlatform = options.enginePlatform;
    this.#cacheDir = options.cacheDir;
    this.#workRoot = options.workRoot ?? join(tmpdir(), "dejaml-prep");
    this.#wheelhouseRoot = options.wheelhouseRoot ?? join(options.cacheDir, "wheelhouses");
    this.#proxyScriptPath = options.proxyScriptPath ?? DEFAULT_PROXY_SCRIPT_PATH;
    this.#freeSpace = options.freeSpace ?? defaultFreeSpaceProbe;
    this.#now = options.now ?? (() => new Date());
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    // As root, run as nobody; otherwise as the service's own user so it can measure and remove every file.
    this.#user = uid === undefined || uid === 0 || gid === undefined ? PREP_USER : `${uid}:${gid}`;
  }

  // -------------------------------------------------------------------------
  // Resolve
  // -------------------------------------------------------------------------

  async resolvePython(input: ResolvePythonInput): Promise<PythonResolution> {
    assertRunId(input.runId);
    const platform = assertPlatform(input.platform);
    const platformKey = cacheKeyFor(platform);
    const index = effectivePackageIndex(this.policy, platform.packageIndex);
    const includeInstaller = input.includeInstaller === true;
    if (input.requirements.length > MAX_REQUIREMENTS) {
      throw new PrepError("limit_exceeded", `at most ${MAX_REQUIREMENTS} requirements may be resolved at once`);
    }
    const specs: string[] = [];
    const parsedRequirements: ParsedRequirement[] = [];
    const records: RequirementRecord[] = [];
    for (const item of input.requirements) {
      const text = typeof item === "string" ? item : item.spec;
      const parsed = parseRequirementLine(text);
      if (!parsed.ok) throw new PrepError("invalid_requirement", `rejected requirement: ${parsed.reason}`, { detail: text.slice(0, 200) });
      if (!parsed.requirement) throw new PrepError("invalid_requirement", "empty requirement");
      if (specs.includes(parsed.requirement.spec)) continue;
      specs.push(parsed.requirement.spec);
      parsedRequirements.push(parsed.requirement);
      const origin = typeof item === "string" ? null : (item.source ?? null);
      records.push({ spec: parsed.requirement.spec, name: parsed.requirement.name, source: "repository", reason: null, origin });
    }
    if (specs.length === 0 && !includeInstaller) throw new PrepError("invalid_requirement", "no requirements to resolve");
    const constraints: ValidatedConstraint[] = validateConstraints(input.constraints ?? []);
    for (const constraint of constraints) {
      records.push({ spec: constraint.spec, name: constraint.name, source: "compatibility_constraint", reason: constraint.reason, origin: constraint.source ?? null });
    }
    // CPU-only policy, before anything is downloaded.
    const refused = [
      ...findAcceleratorRequirements(parsedRequirements),
      ...findAcceleratorRequirements(constraints.map((constraint) => constraint.requirement), "constraint"),
    ];
    if (refused.length > 0) throw acceleratorError(refused);
    const lines = includeInstaller && !specs.some((spec) => /^pip(\[|[<>=!~;]|$)/u.test(spec)) ? [...specs, "pip"] : specs;

    return this.#withTopology(input.runId, platform, index, input.signal, 0, "dependency resolution", async (topology, signals) => {
      const resolver = topology.resolver as ResolverInfo;
      const image = topology.image as PrepImageIdentity;
      await writeFile(join(topology.tempDir, "in", "requirements.in"), `${lines.join("\n")}\n`, { mode: 0o444 });
      if (constraints.length > 0) {
        await writeFile(join(topology.tempDir, "in", "constraints.txt"), `${constraints.map((constraint) => constraint.spec).join("\n")}\n`, { mode: 0o444 });
      }
      const run = await this.#runWorker(topology, signals, "resolve", [
        "-m", "pip", "install",
        "--dry-run",
        "--ignore-installed",
        "--only-binary=:all:",
        "--progress-bar=off",
        ...resolver.targetArgs,
        "--report", "/out/report.json",
        ...(constraints.length > 0 ? ["-c", "/in/constraints.txt"] : []),
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
      const report = parsePipReport(raw, { allowedHosts: index.allowedHosts, maxPackages: this.policy.maxPackages });
      if (report.pythonMinor !== null && report.pythonMinor !== platform.python.version) {
        throw new PrepError("platform_mismatch", `the preparation image runs Python ${report.pythonMinor}, but the platform requires ${platform.python.version}`);
      }
      if (resolver.mode !== "cross" && report.platform !== null && report.platform !== wheelMachine(platform.architecture)) {
        throw new PrepError("platform_mismatch", `the resolver ran on ${report.platform}, not ${wheelMachine(platform.architecture)}`);
      }
      // CPU-only policy on the whole transitive set, before any wheel is downloaded.
      const transitive = findAcceleratorPackages(report.packages);
      if (transitive.length > 0) throw acceleratorError(transitive);
      // Never accept a wheel for another platform, Python or glibc.
      assertWheelsMatchPlatform(report.packages, platform);
      const installer = includeInstaller ? (report.packages.find((pkg) => pkg.name === "pip") ?? null) : null;
      if (includeInstaller && !installer) throw new PrepError("runtime_error", "the resolution did not include the pip installer wheel");
      const packages = report.packages.filter((pkg) => pkg !== installer);
      return {
        resolutionId: topology.prepId,
        runId: input.runId,
        platform,
        platformKey,
        requested: specs,
        requirements: records,
        compatibilityChanges: constraints.map((constraint) => ({
          name: constraint.name,
          constraint: constraint.spec,
          reason: constraint.reason,
          repository: records.filter((record) => record.source === "repository" && record.name === constraint.name).map((record) => record.spec),
          resolved: report.packages.find((pkg) => pkg.name === constraint.name)?.version ?? null,
          origin: constraint.source ?? null,
        })),
        rejected: (input.rejected ?? []).slice(0, 500),
        includeInstaller,
        packages,
        installer,
        image: image.reference,
        imageId: image.imageId,
        imageIdentity: image,
        resolver,
        pythonVersion: report.pythonVersion,
        machine: report.platform,
        proxyLog,
        resolvedAt: this.#now().toISOString(),
        disk: topology.disk,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Download + verify + wheelhouse
  // -------------------------------------------------------------------------

  async downloadWheels(resolution: PythonResolution, options: DownloadOptions = {}): Promise<DependencyManifest> {
    assertRunId(resolution.runId);
    if (!PREP_ID_PATTERN.test(resolution.resolutionId)) throw new PrepError("invalid_requirement", "invalid resolution id");
    const platform = assertPlatform(resolution.platform);
    const platformKey = cacheKeyFor(platform);
    if (resolution.platformKey !== platformKey) throw new PrepError("platform_mismatch", "the resolution's platform key does not match its platform");
    if (options.platform && cacheKeyFor(assertPlatform(options.platform)) !== platformKey) {
      throw new PrepError("platform_mismatch", `the resolution is for ${platformKey}, not ${platformCacheKey(options.platform)}`);
    }
    const index = effectivePackageIndex(this.policy, platform.packageIndex);
    const downloadStartedAt = this.#now().toISOString();
    const all = [...resolution.packages, ...(resolution.installer ? [resolution.installer] : [])].map((pkg) => {
      const parsed = ResolvedPackageSchema.safeParse(pkg);
      if (!parsed.success) throw new PrepError("invalid_requirement", "resolution contains an invalid package entry");
      const host = new URL(parsed.data.url).hostname.toLowerCase();
      if (!index.allowedHosts.includes(host)) {
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
    const refused = findAcceleratorPackages(all);
    if (refused.length > 0) throw acceleratorError(refused);
    assertWheelsMatchPlatform(all, platform);

    const wheelsDir = join(this.#cacheDir, "wheels", platformKey);
    await mkdir(wheelsDir, { recursive: true, mode: 0o755 });
    const sizes = new Map<string, number>();
    const cachedNames = new Set<string>();
    let evicted = 0;
    for (const pkg of all) {
      const cached = await this.#cachedWheel(platformKey, pkg);
      if (cached === "evicted") evicted += 1;
      if (typeof cached === "number") {
        sizes.set(pkg.name, cached);
        cachedNames.add(pkg.name);
      }
    }
    const missing = all.filter((pkg) => !cachedNames.has(pkg.name));

    let downloadLog: ProxyLogEntry[] = [];
    let downloadCleanup: PrepCleanupReceipt | null = null;
    let downloadDisk: DiskReceipt | null = null;
    if (missing.length > 0) {
      const reserve = Math.min(this.policy.maxTotalBytes, this.policy.maxTempBytes);
      const outcome = await this.#withTopology(resolution.runId, platform, index, options.signal, reserve, "downloading wheels", async (topology, signals) => {
        const resolver = topology.resolver as ResolverInfo;
        const pinned = missing.map((pkg) => `${pkg.name}==${pkg.version} --hash=sha256:${pkg.sha256}`).join("\n");
        await writeFile(join(topology.tempDir, "in", "pinned.txt"), `${pinned}\n`, { mode: 0o444 });
        const run = await this.#runWorker(topology, signals, "download", [
          "-m", "pip", "download",
          "--no-deps",
          "--only-binary=:all:",
          "--require-hashes",
          "--progress-bar=off",
          ...resolver.targetArgs,
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
        const verified = await this.#verifyDownloads(join(topology.tempDir, "out"), platformKey, platform, missing, all, sizes, signals);
        for (const [name, bytes] of verified) sizes.set(name, bytes);
        return { proxyLog, disk: topology.disk };
      });
      downloadLog = outcome.proxyLog;
      downloadDisk = outcome.disk;
      downloadCleanup = outcome.cleanup;
    }

    const totalBytes = all.reduce((sum, pkg) => sum + (sizes.get(pkg.name) ?? 0), 0);
    if (totalBytes > this.policy.maxTotalBytes) {
      throw new PrepError("limit_exceeded", `wheels total ${totalBytes} bytes; the policy allows ${this.policy.maxTotalBytes}`);
    }

    const prepId = `prep_${hexId()}`;
    const constraintFor = new Map(resolution.compatibilityChanges.map((change) => [change.name, change.constraint]));
    const toManifest = (pkg: ResolvedPackage): ManifestPackage => ({
      name: pkg.name,
      version: pkg.version,
      filename: pkg.filename,
      sha256: pkg.sha256,
      bytes: sizes.get(pkg.name) ?? 0,
      url: pkg.url,
      requested: pkg.requested,
      cached: cachedNames.has(pkg.name),
      platformTags: wheelPlatformTags(pkg.filename),
      constraint: constraintFor.get(pkg.name) ?? null,
    });
    const wheelhouseDir = join(this.#wheelhouseRoot, `${resolution.runId}-${prepId.slice(5, 17)}`);
    const manifest: DependencyManifest = {
      schemaVersion: 2,
      prepId,
      resolutionId: resolution.resolutionId,
      runId: resolution.runId,
      platform,
      platformKey,
      requested: resolution.requested,
      requirements: resolution.requirements,
      compatibilityChanges: resolution.compatibilityChanges,
      rejected: resolution.rejected,
      packages: resolution.packages.map(toManifest),
      installer: resolution.installer ? toManifest(resolution.installer) : null,
      totalBytes,
      policy: this.policy,
      image: resolution.image,
      imageId: resolution.imageId,
      imageIdentity: resolution.imageIdentity,
      resolver: resolution.resolver,
      pythonVersion: resolution.pythonVersion,
      cache: { hits: cachedNames.size, downloaded: missing.length, evicted, downloaderSkipped: missing.length === 0, key: platformKey },
      proxyLog: { resolve: resolution.proxyLog, download: downloadLog },
      disk: { resolve: resolution.disk, download: downloadDisk },
      timestamps: { resolvedAt: resolution.resolvedAt, downloadStartedAt, completedAt: "" },
      cleanup: { resolve: resolution.cleanup, download: downloadCleanup },
      wheelhouseDir,
    };
    await mkdir(this.#wheelhouseRoot, { recursive: true, mode: 0o755 });
    await assertFreeSpace(this.#freeSpace, this.#wheelhouseRoot, totalBytes, this.policy.minFreeBytes, "building the wheelhouse");
    await this.#buildWheelhouse(manifest, platformKey, all);
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
  async probeEgress(input: { runId: string; platform: PlatformSpec; signal?: AbortSignal }): Promise<EgressProbeResult> {
    assertRunId(input.runId);
    const platform = assertPlatform(input.platform);
    const index = effectivePackageIndex(this.policy, platform.packageIndex);
    const allowed = index.allowedHosts[0] ?? "pypi.org";
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
    return this.#withTopology(input.runId, platform, index, input.signal, 0, "the egress probe", async (topology, signals) => {
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
  // Image and resolver selection
  // -------------------------------------------------------------------------

  async #enginePlatformOf(signals: CallSignals): Promise<ContainerPlatform | null> {
    if (this.#enginePlatform === undefined) this.#enginePlatform = await dockerEnginePlatform(this.#runtime, signals.signal);
    return this.#enginePlatform;
  }

  async #ensureImage(pinned: PinnedReference, version: PythonVersion, platform: ContainerPlatform, signals: CallSignals): Promise<PrepImageIdentity> {
    let found: PrepImage;
    try {
      found = await this.#images.ensure(
        {
          key: `prep-python-${version}-${platform.replace("/", "-")}`,
          reference: pinned.reference,
          platform,
          ...(this.policy.expectedImageIds[version] ? { expectedImageId: this.policy.expectedImageIds[version] } : {}),
          pull: this.policy.pullImages,
        },
        signals.signal,
      );
    } catch (error) {
      this.#checkAborted(signals);
      if (error instanceof PrepError) throw error;
      // ImageReadiness (lab manager) errors carry a code; map them to the preparation vocabulary.
      const code = errorCode(error);
      const message = error instanceof Error ? error.message : String(error);
      if (code === "platform_mismatch") throw new PrepError("platform_mismatch", message);
      throw new PrepError("image_unavailable", `preparation image for Python ${version} on ${platform} is not ready (${code ?? "error"}): ${message}`);
    }
    this.#checkAborted(signals);
    if (!/^sha256:[a-f0-9]{64}$/u.test(found.imageId)) throw new PrepError("runtime_error", "unexpected image ID format");
    if (!sameContainerPlatform(found.platform, platform)) {
      throw new PrepError("platform_mismatch", `preparation image ${pinned.reference} is ${found.platform}, not ${platform}`);
    }
    if (!imageMatchesPin(found, pinned)) {
      throw new PrepError("image_mismatch", `the local image for ${pinned.reference} does not carry the pinned digest ${pinned.digest}`);
    }
    const expected = this.policy.expectedImageIds[version];
    if (expected && found.imageId !== expected) {
      throw new PrepError("image_mismatch", `preparation image ID ${found.imageId} does not match the expected ${expected}`);
    }
    return {
      reference: pinned.reference,
      digestReference: pinned.digestReference,
      digest: pinned.digest,
      imageId: found.imageId,
      repoDigests: found.repoDigests,
      platform,
      pythonVersion: version,
    };
  }

  /** Whether the engine can run `platform` (natively or through binfmt emulation), probed once per platform. */
  async #canExecute(topology: Topology, image: PrepImageIdentity, platform: PlatformSpec, signals: CallSignals): Promise<boolean> {
    const known = this.#emulation.get(platform.containerPlatform);
    if (known !== undefined) return known;
    const name = `${topology.network}-arch`;
    topology.containers.push(name);
    const result = await this.#runtime.docker(
      [
        "run", "--rm", "--name", name, "--pull", "never", ...this.#labels(topology),
        "--platform", platform.containerPlatform, "--network", "none", ...this.#hardening(),
        "--pids-limit", "32", "--memory", "256m", "--memory-swap", "256m",
        "--entrypoint", "python", image.digestReference,
        "-I", "-c", "import platform, sys; print(platform.machine(), '%d.%d' % sys.version_info[:2])",
      ],
      { signal: signals.signal, maxOutputBytes: 4096 },
    );
    this.#checkAborted(signals);
    const ok = result.exitCode === 0 && result.stdout.text.trim() === `${wheelMachine(platform.architecture)} ${platform.python.version}`;
    this.#emulation.set(platform.containerPlatform, ok);
    return ok;
  }

  async #selectResolver(topology: Topology, platform: PlatformSpec, signals: CallSignals): Promise<void> {
    const version = platform.python.version;
    const configured = this.policy.images[version];
    if (!configured) {
      throw new PrepError("image_unavailable", `no preparation image is configured for Python ${version}; set DEJAML_PREP_IMAGES`);
    }
    const pinned = parsePinnedReference(configured);
    const engine = await this.#enginePlatformOf(signals);
    const target = platform.containerPlatform;
    if (engine === target) {
      topology.image = await this.#ensureImage(pinned, version, target, signals);
      topology.resolver = { mode: "native", enginePlatform: engine, targetPlatform: target, targetArgs: [] };
      return;
    }
    let targetImage: PrepImageIdentity | null = null;
    try {
      targetImage = await this.#ensureImage(pinned, version, target, signals);
    } catch (error) {
      if (!(error instanceof PrepError) || (error.code !== "image_unavailable" && error.code !== "platform_mismatch")) throw error;
      if (this.policy.resolverMode === "native") throw error;
    }
    if (targetImage && (await this.#canExecute(topology, targetImage, platform, signals))) {
      topology.image = targetImage;
      topology.resolver = { mode: "emulated", enginePlatform: engine, targetPlatform: target, targetArgs: [] };
      return;
    }
    if (this.policy.resolverMode === "native") {
      throw new PrepError("platform_mismatch", `the Docker engine (${engine ?? "unknown"}) cannot execute ${target} and the policy requires native resolution`);
    }
    if (!engine) throw new PrepError("platform_mismatch", "the Docker engine's platform is not linux/amd64 or linux/arm64");
    // Cross resolution: the same Python on the engine's platform, pip told exactly which platform to target.
    topology.image = await this.#ensureImage(pinned, version, engine, signals);
    topology.resolver = { mode: "cross", enginePlatform: engine, targetPlatform: target, targetArgs: pipCrossTargetArgs(platform) };
  }

  // -------------------------------------------------------------------------
  // Topology
  // -------------------------------------------------------------------------

  async #withTopology<T extends object>(
    runId: string,
    platform: PlatformSpec,
    index: { indexUrl: string; allowedHosts: string[] },
    userSignal: AbortSignal | undefined,
    reserveBytes: number,
    phase: string,
    body: (topology: Topology, signals: CallSignals) => Promise<T>,
  ): Promise<T & { cleanup: PrepCleanupReceipt }> {
    const id = hexId();
    const prepId = `prep_${id}`;
    const network = `dejaml-prep-${id}`;
    const deadline = AbortSignal.timeout(this.policy.timeoutSeconds * 1000);
    const quota = new AbortController();
    const signal = AbortSignal.any([...(userSignal ? [userSignal] : []), deadline, quota.signal]);
    const signals: CallSignals = { signal, user: userSignal, quota, quotaViolation: null };
    const topology: Topology = {
      prepId,
      runId,
      network,
      proxy: `${network}-egress`,
      tempDir: "",
      containers: [],
      networkCreated: false,
      image: null,
      resolver: null,
      index,
      disk: {
        workRoot: this.#workRoot,
        freeBytesAtStart: 0,
        peakBytes: 0,
        peakInodes: 0,
        quotaBytes: this.policy.maxTempBytes,
        quotaInodes: this.policy.maxTempInodes,
      },
    };
    let value: T | undefined;
    let failure: unknown;
    try {
      this.#checkAborted(signals);
      await mkdir(this.#workRoot, { recursive: true, mode: 0o700 });
      topology.disk.freeBytesAtStart = await assertFreeSpace(this.#freeSpace, this.#workRoot, reserveBytes, this.policy.minFreeBytes, phase);
      topology.tempDir = await mkdtemp(join(this.#workRoot, `${prepId}-`));
      await this.#selectResolver(topology, platform, signals);
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
    if (signals.quotaViolation) return spaceError(signals.quotaViolation);
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

  async #prepareTempDir(topology: Topology): Promise<void> {
    const inDir = join(topology.tempDir, "in");
    const outDir = join(topology.tempDir, "out");
    const tmpDir = join(topology.tempDir, "tmp");
    await mkdir(inDir, { mode: 0o755 });
    await mkdir(outDir, { mode: 0o755 });
    await mkdir(tmpDir, { mode: 0o700 });
    await chmod(inDir, 0o755);
    // The containers must be able to write the output and temp mounts.
    if (this.#user === PREP_USER && process.getuid?.() === 0) {
      await chown(outDir, 65534, 65534);
      await chown(tmpDir, 65534, 65534);
    } else if (this.#user === PREP_USER) {
      await chmod(outDir, 0o777);
      await chmod(tmpDir, 0o777);
    }
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
    return ["--user", this.#user, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
  }

  async #startNetworkAndProxy(topology: Topology, signals: CallSignals): Promise<void> {
    const image = topology.image as PrepImageIdentity;
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
        "--platform", image.platform,
        ...this.#labels(topology),
        "--network", "bridge",
        ...this.#hardening(),
        "--pids-limit", "64",
        "--memory", "128m",
        "--memory-swap", "128m",
        "--cpus", "0.5",
        "--mount", mountArgument(script, PROXY_SCRIPT_TARGET, true),
        "--entrypoint", "python",
        image.digestReference,
        "-I", "-u", PROXY_SCRIPT_TARGET,
        "--listen", `0.0.0.0:${PROXY_PORT}`,
        ...topology.index.allowedHosts.flatMap((host) => ["--allow", host]),
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

    for (let attempt = 0; attempt < 80; attempt += 1) {
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
    const image = topology.image as PrepImageIdentity;
    const name = `${topology.network}-${role}`;
    const inDir = join(topology.tempDir, "in");
    const env: string[] =
      role === "probe"
        ? ["--env", "HOME=/tmp", "--env", "TMPDIR=/tmp"]
        : [
            "--env", "HOME=/tmp",
            "--env", "TMPDIR=/tmp",
            "--env", `HTTPS_PROXY=http://${PROXY_ALIAS}:${PROXY_PORT}`,
            "--env", `PIP_INDEX_URL=${topology.index.indexUrl}`,
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
    // Disk-backed scratch space under the work root (not a RAM tmpfs), bounded by the quota watcher.
    mounts.push("--mount", mountArgument(join(topology.tempDir, "tmp"), "/tmp", false));

    const watcher = new QuotaWatcher(
      topology.tempDir,
      {
        maxBytes: this.policy.maxTempBytes,
        maxInodes: this.policy.maxTempInodes,
        minFreeBytes: this.policy.minFreeBytes,
        pollMs: this.policy.diskPollMs,
      },
      this.#freeSpace,
      () => {
        signals.quotaViolation = watcher.violation;
        signals.quota.abort();
      },
    );

    topology.containers.push(name);
    let stderrTail = "";
    watcher.start();
    let result: RuntimeCommandResult;
    try {
      result = await this.#runtime.docker(
        [
          "run",
          "--name", name,
          "--pull", "never",
          "--platform", image.platform,
          ...this.#labels(topology),
          "--network", topology.network,
          ...this.#hardening(),
          "--cpus", String(this.policy.cpus),
          "--memory", `${this.policy.memoryMb}m`,
          "--memory-swap", `${this.policy.memoryMb}m`,
          "--pids-limit", String(this.policy.pids),
          ...env,
          ...mounts,
          "--workdir", "/tmp",
          "--entrypoint", "python",
          image.digestReference,
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
    } finally {
      await watcher.stop();
    }
    // A last measurement catches anything written between polls.
    await watcher.check();
    topology.disk.peakBytes = Math.max(topology.disk.peakBytes, watcher.peak.bytes);
    topology.disk.peakInodes = Math.max(topology.disk.peakInodes, watcher.peak.inodes);
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
      await rm(topology.tempDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
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

  #cachePath(platformKey: string, pkg: ResolvedPackage): string {
    return join(this.#cacheDir, "wheels", platformKey, pkg.sha256, pkg.filename);
  }

  /** Size of a verified cached wheel, "evicted" if a corrupt entry was removed, or null. */
  async #cachedWheel(platformKey: string, pkg: ResolvedPackage): Promise<number | "evicted" | null> {
    const path = this.#cachePath(platformKey, pkg);
    const stat = await lstat(path).catch(() => null);
    if (!stat) return null;
    if (stat.isFile() && stat.size <= this.policy.maxFileBytes && (await sha256File(path)) === pkg.sha256) return stat.size;
    await rm(join(this.#cacheDir, "wheels", platformKey, pkg.sha256), { recursive: true, force: true });
    return "evicted";
  }

  async #verifyDownloads(
    dir: string,
    platformKey: string,
    platform: PlatformSpec,
    expected: ResolvedPackage[],
    all: ResolvedPackage[],
    knownSizes: Map<string, number>,
    signals: CallSignals,
  ): Promise<Map<string, number>> {
    const byFilename = new Map(expected.map((pkg) => [pkg.filename, pkg]));
    const entries = await readdir(dir);
    const sizes = new Map<string, number>();
    let total = all.reduce((sum, pkg) => sum + (knownSizes.get(pkg.name) ?? 0), 0);
    for (const entry of entries) {
      this.#checkAborted(signals);
      const pkg = byFilename.get(entry);
      if (!pkg) throw new PrepError("integrity_error", `unexpected file in the download directory: ${entry.slice(0, 120)}`);
      const verdict = wheelMatchesPlatform(entry, platform);
      if (!verdict.ok) throw new PrepError("platform_mismatch", verdict.reason, { refused: [pkg.name] });
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
    const incoming = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
    await assertFreeSpace(this.#freeSpace, join(this.#cacheDir, "wheels", platformKey), incoming, this.policy.minFreeBytes, "adding wheels to the cache");
    // Only fully verified files enter the write-once cache.
    for (const pkg of expected) {
      this.#checkAborted(signals);
      const target = this.#cachePath(platformKey, pkg);
      const targetDir = join(this.#cacheDir, "wheels", platformKey, pkg.sha256);
      await mkdir(targetDir, { recursive: true, mode: 0o755 });
      if (await lstat(target).catch(() => null)) {
        if ((await sha256File(target)) !== pkg.sha256) throw new PrepError("integrity_error", `cache entry ${target} is corrupt`);
        continue;
      }
      const staging = join(targetDir, `.${hexId()}.partial`);
      try {
        await copyFile(join(dir, pkg.filename), staging, fsConstants.COPYFILE_EXCL);
        await chmod(staging, 0o444);
        if ((await sha256File(staging)) !== pkg.sha256) throw new PrepError("integrity_error", `${pkg.filename} changed while entering the cache`);
        await rename(staging, target);
      } finally {
        await rm(staging, { force: true });
      }
    }
    return sizes;
  }

  async #buildWheelhouse(manifest: DependencyManifest, platformKey: string, all: ResolvedPackage[]): Promise<void> {
    const dir = manifest.wheelhouseDir;
    await mkdir(dir, { mode: 0o755 });
    try {
      for (const pkg of all) {
        const target = join(dir, pkg.filename);
        await copyFile(this.#cachePath(platformKey, pkg), target, fsConstants.COPYFILE_EXCL);
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
