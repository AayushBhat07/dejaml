import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RPackageNameSchema, type ContainerPlatform, type RVersion } from "@dejaml/contracts";
import { DatasetError, extractArchive, type FetchPolicy, NetGuardError, safeDownload } from "@dejaml/net-guard";

import { PrepError } from "./errors.js";

/**
 * R package preparation. CRAN packages come only as prebuilt Linux binaries
 * for the lab image (Ubuntu 24.04, one R minor version, one architecture)
 * from a dated, immutable Posit Package Manager snapshot. Nothing is
 * compiled and no package code runs: the trusted host fetches the index and
 * the binaries over the guarded HTTPS client, checks each one is a binary
 * built for this R and architecture, and unpacks it into a library directory
 * that the lab mounts read-only.
 */

export const R_REPOSITORY_BASE = "https://packagemanager.posit.co/cran";
/** The package manager's hosts, including the sync host it redirects binary downloads to. */
export const R_REPOSITORY_HOSTS = ["packagemanager.posit.co", "p3m.dev", "rspm-sync.rstudio.com"] as const;
/** The snapshot used unless the administrator sets another. */
export const DEFAULT_R_SNAPSHOT = "2026-10-01";

/** Shipped with R itself, never downloaded. */
export const R_BASE_PACKAGES: ReadonlySet<string> = new Set([
  "base",
  "compiler",
  "datasets",
  "graphics",
  "grDevices",
  "grid",
  "methods",
  "parallel",
  "splines",
  "stats",
  "stats4",
  "tcltk",
  "tools",
  "utils",
]);

/** The recommended packages the rocker/r-ver lab images include. */
export const R_RECOMMENDED_PACKAGES: ReadonlySet<string> = new Set([
  "KernSmooth",
  "MASS",
  "Matrix",
  "boot",
  "class",
  "cluster",
  "codetools",
  "foreign",
  "lattice",
  "mgcv",
  "nlme",
  "nnet",
  "rpart",
  "spatial",
  "survival",
]);

const MAX_REQUESTED = 150;
const MAX_RESOLVED = 400;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const PARALLEL_DOWNLOADS = 4;
const SNAPSHOT_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const VERSION_PATTERN = /^[0-9]+(?:[.-][0-9]+)*$/u;

export type RPackageRecord = {
  name: string;
  version: string;
  sha256: string;
  bytes: number;
  url: string;
  /** The binary's `Built:` field, such as `R 4.5.1; x86_64-pc-linux-gnu; 2026-09-30 10:00:00 UTC; unix`. */
  built: string;
  /** True when the user asked for it; false for a dependency. */
  requested: boolean;
};

export type RPackageManifest = {
  schemaVersion: 1;
  snapshot: string;
  rVersion: RVersion;
  platform: ContainerPlatform;
  repository: string;
  requested: string[];
  /** Base and recommended packages the lab image already has. */
  provided: string[];
  packages: RPackageRecord[];
  preparedAt: string;
};

export type PreparedRLibrary = {
  manifest: RPackageManifest;
  manifestSha256: string;
  /** Host directory with one subdirectory per package; mounted read-only as the lab's R library. */
  libraryDir: string;
};

type IndexEntry = { name: string; version: string; depends: string[]; imports: string[]; minR: string | null };

/** The platform segment Posit uses for Ubuntu 24.04 binaries. */
export function rBinaryRepository(snapshot: string, r: RVersion, platform: ContainerPlatform): string {
  const arch = platform === "linux/amd64" ? "x86_64" : "aarch64";
  return `${R_REPOSITORY_BASE}/${snapshot}/bin/linux/noble-${arch}/${r}/src/contrib`;
}

/** Parses a Debian control file style index (CRAN `PACKAGES`): records separated by blank lines, continuation lines indented. */
export function parseDcf(text: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = [];
  let current: Record<string, string> = {};
  let last: string | null = null;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === "") {
      if (Object.keys(current).length) records.push(current);
      current = {};
      last = null;
      continue;
    }
    if (/^\s/u.test(line)) {
      if (last) current[last] = `${current[last] ?? ""} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    last = line.slice(0, colon);
    current[last] = line.slice(colon + 1).trim();
  }
  if (Object.keys(current).length) records.push(current);
  return records;
}

/** Package names from a `Depends`/`Imports` field, without version requirements; `R` is returned as-is. */
export function dependencyNames(field: string | undefined): Array<{ name: string; requirement: string | null }> {
  if (!field) return [];
  return field
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      const match = /^([A-Za-z][A-Za-z0-9.]*)\s*(?:\(([^)]*)\))?$/u.exec(item);
      return match ? { name: match[1] as string, requirement: match[2]?.replace(/\s+/gu, " ").trim() ?? null } : null;
    })
    .filter((item): item is { name: string; requirement: string | null } => item !== null);
}

function compareVersions(left: string, right: string): number {
  const a = left.split(/[.-]/u).map(Number);
  const b = right.split(/[.-]/u).map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Whether R `version` (such as 4.5.3) satisfies a requirement such as `>= 4.1.0`. */
export function rSatisfies(version: string, requirement: string | null): boolean {
  if (!requirement) return true;
  const match = /^(>=|>|<=|<|==|!=)\s*([0-9][0-9.-]*)$/u.exec(requirement);
  if (!match) return true;
  const order = compareVersions(version, match[2] as string);
  switch (match[1]) {
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case "<":
      return order < 0;
    case "==":
      return order === 0;
    default:
      return order !== 0;
  }
}

function parseIndex(text: string): Map<string, IndexEntry> {
  const index = new Map<string, IndexEntry>();
  for (const record of parseDcf(text)) {
    const name = record.Package;
    const version = record.Version;
    if (!name || !version || !RPackageNameSchema.safeParse(name).success || !VERSION_PATTERN.test(version)) continue;
    const depends = dependencyNames(record.Depends);
    const minR = depends.find((item) => item.name === "R")?.requirement ?? null;
    index.set(name, {
      name,
      version,
      depends: depends.filter((item) => item.name !== "R").map((item) => item.name),
      imports: dependencyNames(record.Imports).map((item) => item.name),
      minR,
    });
  }
  return index;
}

/**
 * The packages to download for `requested`, dependencies first: Depends and
 * Imports, recursively, without the base and recommended packages. LinkingTo
 * is only needed to compile, and nothing is compiled.
 */
export function resolveRPackages(
  requested: readonly string[],
  index: ReadonlyMap<string, IndexEntry>,
  rVersion: string,
): { order: IndexEntry[]; provided: string[] } {
  const order: IndexEntry[] = [];
  const provided = new Set<string>();
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, via: string | null): void => {
    if (R_BASE_PACKAGES.has(name) || R_RECOMMENDED_PACKAGES.has(name)) {
      provided.add(name);
      return;
    }
    if (state.get(name) === "done" || state.get(name) === "visiting") return;
    const entry = index.get(name);
    if (!entry) {
      throw new PrepError(
        "no_compatible_binary",
        via ? `R package ${name} (needed by ${via}) is not in the snapshot` : `R package ${name} is not in the snapshot`,
        { requirement: name },
      );
    }
    if (!rSatisfies(rVersion, entry.minR)) {
      throw new PrepError(
        "no_compatible_binary",
        `R package ${name} ${entry.version} needs R ${entry.minR ?? ""}; the lab has R ${rVersion}`,
        {
          requirement: name,
        },
      );
    }
    state.set(name, "visiting");
    for (const dependency of [...entry.depends, ...entry.imports]) visit(dependency, name);
    state.set(name, "done");
    order.push(entry);
    if (order.length > MAX_RESOLVED) throw new PrepError("limit_exceeded", `more than ${MAX_RESOLVED} R packages would be installed`);
  };
  for (const name of requested) visit(name, null);
  return { order, provided: [...provided].sort() };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function binaryArch(platform: ContainerPlatform): string {
  return platform === "linux/amd64" ? "x86_64" : "aarch64";
}

/** The `Built:` field when `description` is a binary built for this R minor and architecture, else the reason it is not. */
export function checkBuilt(
  description: string,
  r: RVersion,
  platform: ContainerPlatform,
): { ok: true; built: string } | { ok: false; reason: string } {
  const record = parseDcf(description)[0] ?? {};
  const built = record.Built;
  if (!built) return { ok: false, reason: "it is a source package, not a prebuilt binary" };
  const [rPart = "", platformPart = ""] = built.split(";").map((part) => part.trim());
  if (!rPart.startsWith(`R ${r}.`)) return { ok: false, reason: `it was built for ${rPart || "an unknown R"}, not R ${r}` };
  if (platformPart !== "" && !platformPart.startsWith(`${binaryArch(platform)}-`)) {
    return { ok: false, reason: `it was built for ${platformPart}, not ${binaryArch(platform)}` };
  }
  return { ok: true, built };
}

export type RPackagePreparerOptions = {
  /** Immutable downloads are cached here, by snapshot, R version and platform, and re-hashed on use. */
  cacheDir: string;
  /** Prepared libraries are written here, one directory per preparation. */
  libraryRoot: string;
  snapshot?: string;
  now?: () => Date;
  /** Test seam: the guarded download policy (the hosts default to the package manager's). */
  policy?: Partial<FetchPolicy>;
  /** Test seam passed to the guarded client. */
  download?: typeof safeDownload;
};

export class RPackagePreparer {
  readonly snapshot: string;
  readonly #cacheDir: string;
  readonly #libraryRoot: string;
  readonly #now: () => Date;
  readonly #policy: FetchPolicy;
  readonly #download: typeof safeDownload;

  constructor(options: RPackagePreparerOptions) {
    this.snapshot = options.snapshot ?? DEFAULT_R_SNAPSHOT;
    if (!SNAPSHOT_PATTERN.test(this.snapshot)) throw new PrepError("invalid_policy", "the R snapshot must be a date, YYYY-MM-DD");
    this.#cacheDir = options.cacheDir;
    this.#libraryRoot = options.libraryRoot;
    this.#now = options.now ?? (() => new Date());
    this.#policy = {
      allowedHosts: [...R_REPOSITORY_HOSTS],
      maxRedirects: 3,
      maxBytes: MAX_PACKAGE_BYTES,
      timeoutMs: 300_000,
      ...options.policy,
    };
    this.#download = options.download ?? safeDownload;
  }

  /** Refuses names that are not CRAN package names before anything is fetched. */
  static screen(packages: readonly string[]): Array<{ requirement: string; reason: string }> {
    const refused = packages
      .filter((name) => !RPackageNameSchema.safeParse(name).success)
      .map((name) => ({ requirement: name, reason: "not a CRAN package name" }));
    if (packages.length > MAX_REQUESTED) refused.push({ requirement: `${packages.length} packages`, reason: `at most ${MAX_REQUESTED}` });
    return refused;
  }

  /** Whether every requested package and its dependencies have binaries in the snapshot (fetches only the index). */
  async check(input: { packages: readonly string[]; r: RVersion; rVersion: string; platform: ContainerPlatform; signal?: AbortSignal }) {
    const index = await this.#index(input.r, input.platform, input.signal);
    return resolveRPackages(input.packages, index, input.rVersion);
  }

  async prepare(input: {
    runId: string;
    packages: readonly string[];
    r: RVersion;
    /** The lab image's full R version, such as 4.5.3, for `Depends: R (>= …)`. */
    rVersion: string;
    platform: ContainerPlatform;
    signal?: AbortSignal;
  }): Promise<PreparedRLibrary> {
    const refused = RPackagePreparer.screen(input.packages);
    if (refused.length) throw new PrepError("invalid_requirement", refused.map((item) => `${item.requirement}: ${item.reason}`).join("; "));
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(input.runId)) throw new PrepError("invalid_policy", "invalid run id");
    const requested = [...new Set(input.packages)];
    const index = await this.#index(input.r, input.platform, input.signal);
    const { order, provided } = resolveRPackages(requested, index, input.rVersion);

    await mkdir(this.#libraryRoot, { recursive: true, mode: 0o711 });
    const libraryDir = join(this.#libraryRoot, `${input.runId}-r${input.r}-${input.platform.replace("/", "-")}`);
    await rm(libraryDir, { recursive: true, force: true });
    await mkdir(libraryDir, { mode: 0o755 });
    const staging = `${libraryDir}.staging`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    try {
      const records: RPackageRecord[] = [];
      let total = 0;
      const queue = [...order];
      const worker = async (): Promise<void> => {
        for (let entry = queue.shift(); entry; entry = queue.shift()) {
          const record = await this.#install(entry, requested.includes(entry.name), input, libraryDir, staging);
          total += record.bytes;
          if (total > MAX_TOTAL_BYTES) throw new PrepError("limit_exceeded", `R packages exceed ${MAX_TOTAL_BYTES} bytes`);
          records.push(record);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL_DOWNLOADS, Math.max(1, order.length)) }, worker));
      records.sort((a, b) => a.name.localeCompare(b.name));
      const manifest: RPackageManifest = {
        schemaVersion: 1,
        snapshot: this.snapshot,
        rVersion: input.r,
        platform: input.platform,
        repository: rBinaryRepository(this.snapshot, input.r, input.platform),
        requested,
        provided,
        packages: records,
        preparedAt: this.#now().toISOString(),
      };
      const text = `${JSON.stringify(manifest, null, 2)}\n`;
      await sealReadOnly(libraryDir);
      return { manifest, manifestSha256: createHash("sha256").update(text).digest("hex"), libraryDir };
    } catch (error) {
      await chmodTree(libraryDir);
      await rm(libraryDir, { recursive: true, force: true });
      throw toPrepError(error, input.signal);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async #index(r: RVersion, platform: ContainerPlatform, signal: AbortSignal | undefined): Promise<Map<string, IndexEntry>> {
    const dir = this.#cachePath(r, platform);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "PACKAGES");
    if (!(await lstat(path).catch(() => null))?.isFile()) {
      const partial = `${path}.${process.pid}.${Date.now()}`;
      try {
        await this.#download({
          url: `${rBinaryRepository(this.snapshot, r, platform)}/PACKAGES`,
          policy: { ...this.#policy, maxBytes: MAX_INDEX_BYTES },
          destinationFile: partial,
          ...(signal ? { signal } : {}),
        });
        await rename(partial, path);
      } catch (error) {
        await rm(partial, { force: true });
        throw toPrepError(error, signal);
      }
    }
    return parseIndex(await readFile(path, "utf8"));
  }

  #cachePath(r: RVersion, platform: ContainerPlatform): string {
    return join(this.#cacheDir, "r", this.snapshot, `noble-${binaryArch(platform)}`, r);
  }

  async #install(
    entry: IndexEntry,
    requested: boolean,
    input: { r: RVersion; platform: ContainerPlatform; signal?: AbortSignal },
    libraryDir: string,
    staging: string,
  ): Promise<RPackageRecord> {
    const fileName = `${entry.name}_${entry.version}.tar.gz`;
    const url = `${rBinaryRepository(this.snapshot, input.r, input.platform)}/${fileName}`;
    const cached = join(this.#cachePath(input.r, input.platform), fileName);
    const sidecar = `${cached}.sha256`;
    let sha256: string | null = null;
    if ((await lstat(cached).catch(() => null))?.isFile()) {
      const expected = (await readFile(sidecar, "utf8").catch(() => "")).trim();
      const actual = await sha256File(cached);
      if (expected === actual) sha256 = actual;
      else await rm(cached, { force: true });
    }
    if (sha256 === null) {
      const partial = `${cached}.${process.pid}.${Date.now()}.partial`;
      try {
        const receipt = await this.#download({
          url,
          policy: this.#policy,
          destinationFile: partial,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        sha256 = receipt.sha256;
        await rename(partial, cached);
        await writeFile(sidecar, `${sha256}\n`, { mode: 0o600 });
      } catch (error) {
        await rm(partial, { force: true });
        throw toPrepError(error, input.signal);
      }
    }
    const bytes = (await lstat(cached)).size;
    const unpacked = join(staging, entry.name);
    await extractArchive(cached, unpacked, {
      limits: { maxFileBytes: MAX_PACKAGE_BYTES, maxTotalBytes: 4 * MAX_PACKAGE_BYTES },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const top = await readdir(unpacked);
    if (top.length !== 1 || top[0] !== entry.name) {
      throw new PrepError("integrity_error", `the R package archive ${fileName} does not hold exactly the ${entry.name} directory`);
    }
    const packageDir = join(unpacked, entry.name);
    const description = await readFile(join(packageDir, "DESCRIPTION"), "utf8").catch(() => "");
    const meta = await lstat(join(packageDir, "Meta", "package.rds")).catch(() => null);
    const built = checkBuilt(description, input.r, input.platform);
    if (!built.ok || !meta?.isFile()) {
      throw new PrepError(
        "no_compatible_binary",
        `R package ${entry.name} ${entry.version} has no prebuilt binary for R ${input.r} on ${input.platform}: ${built.ok ? "it is not an installed package" : built.reason}`,
        { requirement: entry.name },
      );
    }
    const declared = parseDcf(description)[0] ?? {};
    if (declared.Package !== entry.name || declared.Version !== entry.version) {
      throw new PrepError(
        "integrity_error",
        `the R package archive ${fileName} describes ${declared.Package ?? "?"} ${declared.Version ?? "?"}`,
      );
    }
    await rename(packageDir, join(libraryDir, entry.name));
    return { name: entry.name, version: entry.version, sha256, bytes, url, built: built.built, requested };
  }
}

function toPrepError(error: unknown, signal: AbortSignal | undefined): PrepError {
  if (error instanceof PrepError) return error;
  if (signal?.aborted) return new PrepError("cancelled", "R package preparation was cancelled");
  if (error instanceof NetGuardError || error instanceof DatasetError) {
    if (error.code === "timeout") return new PrepError("timeout", error.message);
    if (error.code === "response_too_large" || error.code === "archive_too_large") return new PrepError("limit_exceeded", error.message);
    if (error.code === "host_not_allowed" || error.code === "redirect_refused") return new PrepError("egress_denied", error.message);
    if (error.code === "http_error") return new PrepError("no_compatible_binary", error.message);
    return new PrepError("integrity_error", error.message);
  }
  return new PrepError("runtime_error", error instanceof Error ? error.message : String(error));
}

/** Files 0444 and directories 0555, bottom-up; the lab mounts the library read-only either way. */
async function sealReadOnly(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await sealReadOnly(path);
    else if (entry.isFile()) await chmod(path, 0o444);
  }
  await chmod(dir, 0o555);
}

/** Makes a sealed tree removable again. */
export async function chmodTree(dir: string): Promise<void> {
  const stat = await lstat(dir).catch(() => null);
  if (!stat?.isDirectory()) return;
  await chmod(dir, 0o755);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await chmodTree(join(dir, entry.name));
  }
}
