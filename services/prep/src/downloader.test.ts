import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlatformSpec, platformCacheKey, type PlatformSpec } from "@dejaml/contracts";
import type { ContainerRuntime, RuntimeCommandOptions, RuntimeCommandResult } from "@dejaml/lab-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DependencyPreparer, type PythonResolution } from "./downloader.js";
import { PrepError } from "./errors.js";
import { DEFAULT_PREP_IMAGES, parsePrepPolicy, type PrepPolicyInput } from "./policy.js";

const DIGEST_313 = "sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b";
const DIGEST_311 = "sha256:e41613d42d4891e4930f79523f93f81bbc7632584ec65e36ab055f41a800b41e";
const REF_313 = `python@${DIGEST_313}`;
const REF_311 = `python@${DIGEST_311}`;
const MANIFEST_ID = `sha256:${"a".repeat(64)}`;

const AMD64_313 = buildPlatformSpec({ architecture: "amd64", python: "3.13" });
const AMD64_311 = buildPlatformSpec({ architecture: "amd64", python: "3.11" });
const ARM64_311 = buildPlatformSpec({ architecture: "arm64", python: "3.11" });

function ok(stdout = "", stderr = "", exitCode: number | null = 0): RuntimeCommandResult {
  return {
    exitCode,
    stdout: { text: stdout, bytes: stdout.length, truncated: false },
    stderr: { text: stderr, bytes: stderr.length, truncated: false },
    aborted: false,
  };
}

function aborted(): RuntimeCommandResult {
  return { ...ok("", "", null), aborted: true };
}

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((value, index) => (args[index - 1] === flag ? [value] : []));
}

type RunHandler = (args: readonly string[], mounts: Map<string, string>, options: RuntimeCommandOptions) => Promise<RuntimeCommandResult>;

/** Records every Docker CLI call and simulates the engine, the image store and the preparation topology. */
class FakeRuntime implements ContainerRuntime {
  readonly calls: string[][] = [];
  engine = "linux/amd64";
  /** Platforms whose content is present for each digest reference. */
  images = new Map<string, Set<string>>([
    [REF_313, new Set(["linux/amd64"])],
    [REF_311, new Set(["linux/amd64"])],
  ]);
  inspectFailure: string | null = null;
  emulation = "";
  proxyLog = "";
  onRun: RunHandler = async () => ok();
  readonly containers = new Set<string>();
  readonly networks = new Set<string>();

  async docker(args: readonly string[], options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    this.calls.push([...args]);
    const [command, sub] = args;
    if (command === "version") return ok(`${this.engine}\n`);
    if (command === "image" && sub === "inspect") {
      if (this.inspectFailure) return ok("", this.inspectFailure, 1);
      const reference = args.at(-1) ?? "";
      const platform = flagValues(args, "--platform")[0] ?? "linux/amd64";
      const present = this.images.get(reference);
      if (!present) return ok("", `Error response from daemon: No such image: ${reference}`, 1);
      const digest = reference.slice(reference.indexOf("@") + 1);
      if (!present.has(platform)) return ok(`${MANIFEST_ID}|||["python@${digest}"]\n`);
      return ok(`${MANIFEST_ID}|linux|${platform.split("/")[1]}|["python@${digest}"]\n`);
    }
    if (command === "pull") {
      const platform = flagValues(args, "--platform")[0] ?? "";
      const reference = args.at(-1) ?? "";
      this.images.set(reference, new Set([...(this.images.get(reference) ?? []), platform]));
      return ok();
    }
    if (command === "network" && sub === "create") {
      this.networks.add(args.at(-1) ?? "");
      return ok();
    }
    if (command === "network" && sub === "rm") {
      this.networks.delete(args.at(-1) ?? "");
      return ok();
    }
    if (command === "network" && sub === "ls") return ok([...this.networks].join("\n"));
    if (command === "network") return ok();
    if (command === "create") {
      this.containers.add(args[args.indexOf("--name") + 1] ?? "");
      return ok();
    }
    if (command === "start") return ok();
    if (command === "logs") return ok(`{"event":"listening"}\n${this.proxyLog}`);
    if (command === "inspect") return ok("false\n");
    if (command === "run") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      if (name.endsWith("-arch")) return this.emulation ? ok(`${this.emulation}\n`) : ok("", "exec format error", 1);
      this.containers.add(name);
      const mounts = new Map<string, string>();
      args.forEach((value, index) => {
        if (args[index - 1] !== "--mount") return;
        const src = /src=([^,]+)/u.exec(value)?.[1] ?? "";
        const dst = /dst=([^,]+)/u.exec(value)?.[1] ?? "";
        mounts.set(dst, src);
      });
      return this.onRun(args, mounts, options);
    }
    if (command === "rm") {
      this.containers.delete(args.at(-1) ?? "");
      return ok();
    }
    if (command === "ps") return ok([...this.containers].join("\n"));
    throw new Error(`unexpected docker call: ${args.join(" ")}`);
  }

  find(predicate: (args: string[]) => boolean): string[] {
    const call = this.calls.find(predicate);
    if (!call) throw new Error("call not found");
    return call;
  }

  runs(role: string): string[][] {
    return this.calls.filter((args) => args[0] === "run" && (args[args.indexOf("--name") + 1] ?? "").endsWith(`-${role}`));
  }
}

type Wheel = { name: string; version: string; filename: string; content: string };

const WHEELS: Record<string, Wheel> = {
  matplotlib: { name: "matplotlib", version: "3.11.2", filename: "matplotlib-3.11.2-cp313-cp313-manylinux_2_27_x86_64.whl", content: "mpl-wheel" },
  six: { name: "six", version: "1.17.0", filename: "six-1.17.0-py2.py3-none-any.whl", content: "six-wheel" },
  pip: { name: "pip", version: "26.2.1", filename: "pip-26.2.1-py3-none-any.whl", content: "pip-wheel" },
  numpyAmd64: { name: "numpy", version: "2.3.3", filename: "numpy-2.3.3-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl", content: "np-x86" },
  numpyArm64: { name: "numpy", version: "2.3.3", filename: "numpy-2.3.3-cp311-cp311-manylinux_2_26_aarch64.manylinux_2_28_aarch64.whl", content: "np-arm" },
  torch: { name: "torch", version: "2.8.0", filename: "torch-2.8.0-cp313-cp313-manylinux_2_28_x86_64.whl", content: "torch" },
  cublas: { name: "nvidia-cublas-cu12", version: "12.8.4.1", filename: "nvidia_cublas_cu12-12.8.4.1-py3-none-manylinux_2_27_x86_64.whl", content: "cublas" },
  triton: { name: "triton", version: "3.4.0", filename: "triton-3.4.0-cp313-cp313-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl", content: "triton" },
  rocm: { name: "pytorch-triton-rocm", version: "3.4.0", filename: "pytorch_triton_rocm-3.4.0-cp313-cp313-linux_x86_64.whl", content: "rocm" },
};

function pipReport(wheels: Wheel[], env: Record<string, string> = { python_full_version: "3.13.15", python_version: "3.13", platform_machine: "x86_64" }) {
  return {
    version: "1",
    environment: env,
    install: wheels.map((wheel) => ({
      metadata: { name: wheel.name, version: wheel.version },
      download_info: {
        url: `https://files.pythonhosted.org/packages/x/${wheel.filename}`,
        archive_info: { hashes: { sha256: sha(wheel.content) } },
      },
      requested: wheel.name === "matplotlib" || wheel.name === "numpy" || wheel.name === "torch",
    })),
  };
}

let root: string;
let runtime: FakeRuntime;
let preparer: DependencyPreparer;
let reportWheels: Wheel[];
let reportEnv: Record<string, string> | undefined;
const SECRET_ENV = { ANTHROPIC_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp-secret", DOCKER_AUTH_CONFIG: "{}" };
const PLENTY = async () => ({ freeBytes: 1024 ** 4 });

function make(policy: PrepPolicyInput = {}, extra: Partial<ConstructorParameters<typeof DependencyPreparer>[0]> = {}): DependencyPreparer {
  return new DependencyPreparer({
    cacheDir: join(root, "cache"),
    workRoot: join(root, "work"),
    runtime,
    freeSpace: PLENTY,
    policy: parsePrepPolicy({ caBundlePath: join(root, "ca.pem"), ...policy }),
    ...extra,
  });
}

/** The default worker: writes the pip report, or the wheels listed in pinned.txt. */
const defaultRun: RunHandler = async (_args, mounts) => {
  const out = mounts.get("/out");
  if (out) await writeFile(join(out, "report.json"), JSON.stringify(pipReport(reportWheels, reportEnv)));
  const wheels = mounts.get("/wheels");
  if (wheels) {
    const pinned = await readFile(join(mounts.get("/in") ?? "", "pinned.txt"), "utf8");
    for (const wheel of Object.values(WHEELS)) {
      if (pinned.includes(`${wheel.name}==${wheel.version} --hash=sha256:${sha(wheel.content)}`)) await writeFile(join(wheels, wheel.filename), wheel.content);
    }
  }
  return ok("Would install ...");
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prep-downloader-"));
  runtime = new FakeRuntime();
  reportWheels = [WHEELS.matplotlib!, WHEELS.six!, WHEELS.pip!];
  reportEnv = undefined;
  runtime.onRun = defaultRun;
  await writeFile(join(root, "ca.pem"), "-----BEGIN CERTIFICATE-----\n");
  preparer = make();
  Object.assign(process.env, SECRET_ENV);
});

afterEach(async () => {
  for (const key of Object.keys(SECRET_ENV)) delete process.env[key];
  const unlock = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        await chmod(join(dir, entry.name), 0o755);
        await unlock(join(dir, entry.name));
      }
    }
  };
  await unlock(root);
  await rm(root, { recursive: true, force: true });
});

async function expectNothingLeft(): Promise<void> {
  expect(runtime.containers.size).toBe(0);
  expect(runtime.networks.size).toBe(0);
  expect(await readdir(join(root, "work")).catch(() => [])).toEqual([]);
}

async function failure(promise: Promise<unknown>): Promise<PrepError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a PrepError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PrepError);
  return error as PrepError;
}

describe("DependencyPreparer.resolvePython", () => {
  it("builds the isolated topology with the exact docker argv", async () => {
    const resolution = await preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["matplotlib>=3"], includeInstaller: true });
    const prepId = resolution.resolutionId;
    const id = prepId.slice(5);
    const network = `dejaml-prep-${id}`;
    const labels = ["--label", `dejaml.prep=${prepId}`, "--label", "dejaml.run=run-1"];

    expect(runtime.calls[0]).toEqual(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
    // Looked up by the pinned digest for one explicit platform, never by a mutable tag.
    expect(runtime.calls[1]).toEqual([
      "image", "inspect", "--platform", "linux/amd64", "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}|{{json .RepoDigests}}", REF_313,
    ]);
    expect(runtime.find((args) => args[0] === "network" && args[1] === "create")).toEqual([
      "network", "create", "--internal", ...labels, network,
    ]);

    const proxy = runtime.find((args) => args[0] === "create");
    const proxyIndex = proxy.indexOf(REF_313);
    expect(proxy.slice(0, proxyIndex + 1)).toEqual([
      "create",
      "--name", `${network}-egress`,
      "--pull", "never",
      "--platform", "linux/amd64",
      ...labels,
      "--network", "bridge",
      "--user", "65534:65534",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "64",
      "--memory", "128m",
      "--memory-swap", "128m",
      "--cpus", "0.5",
      "--mount", expect.stringMatching(/^type=bind,src=.+egress_proxy\.py,dst=\/opt\/dejaml\/egress_proxy\.py,readonly$/u),
      "--entrypoint", "python",
      REF_313,
    ]);
    expect(proxy.slice(proxyIndex + 1)).toEqual([
      "-I", "-u", "/opt/dejaml/egress_proxy.py",
      "--listen", "0.0.0.0:3128",
      "--allow", "pypi.org",
      "--allow", "files.pythonhosted.org",
      "--budget-bytes", String(3 * 1024 ** 3 + 128 * 1024 * 1024),
      "--idle-timeout", "60",
    ]);
    expect(flagValues(proxy, "--env")).toEqual([]);
    expect(runtime.find((args) => args[0] === "network" && args[1] === "connect")).toEqual([
      "network", "connect", "--alias", "egress", network, `${network}-egress`,
    ]);

    const resolver = runtime.find((args) => args[0] === "run");
    const imageIndex = resolver.indexOf(REF_313);
    expect(resolver.slice(imageIndex)).toEqual([
      REF_313,
      "-m", "pip", "install", "--dry-run", "--ignore-installed", "--only-binary=:all:", "--progress-bar=off",
      "--report", "/out/report.json", "-r", "/in/requirements.in",
    ]);
    const options = resolver.slice(0, imageIndex);
    expect(options.slice(0, 7)).toEqual(["run", "--name", `${network}-resolve`, "--pull", "never", "--platform", "linux/amd64"]);
    expect(flagValues(options, "--network")).toEqual([network]);
    expect(flagValues(options, "--user")).toEqual(["65534:65534"]);
    expect(options).toContain("--read-only");
    expect(flagValues(options, "--cap-drop")).toEqual(["ALL"]);
    expect(flagValues(options, "--security-opt")).toEqual(["no-new-privileges"]);
    // No RAM tmpfs: /tmp is a bounded, disk-backed directory under the work root.
    expect(options).not.toContain("--tmpfs");
    expect(flagValues(options, "--cpus")).toEqual(["2"]);
    expect(flagValues(options, "--memory")).toEqual(["2048m"]);
    expect(flagValues(options, "--pids-limit")).toEqual(["256"]);
    expect(flagValues(options, "--entrypoint")).toEqual(["python"]);
    expect(flagValues(options, "--env")).toEqual([
      "HOME=/tmp",
      "TMPDIR=/tmp",
      "HTTPS_PROXY=http://egress:3128",
      "PIP_INDEX_URL=https://pypi.org/simple",
      "PIP_DISABLE_PIP_VERSION_CHECK=1",
      "PIP_NO_INPUT=1",
      "PIP_NO_CACHE_DIR=1",
      "PIP_CERT=/etc/dejaml/ca-bundle.pem",
    ]);
    const mounts = flagValues(options, "--mount");
    expect(mounts).toEqual([
      expect.stringMatching(/^type=bind,src=.+\/in,dst=\/in,readonly$/u),
      expect.stringMatching(/^type=bind,src=.+\/in\/ca-bundle\.pem,dst=\/etc\/dejaml\/ca-bundle\.pem,readonly$/u),
      expect.stringMatching(/^type=bind,src=.+\/out,dst=\/out$/u),
      expect.stringMatching(new RegExp(`^type=bind,src=${join(root, "work")}/prep_[a-f0-9]{32}-[^/]+/tmp,dst=/tmp$`, "u")),
    ]);
    expect(options).not.toContain("--privileged");
    expect(options).not.toContain("-v");
    const everything = runtime.calls.flat().join(" ");
    for (const secret of Object.values(SECRET_ENV)) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/--env-file|--volume |-v |--network host|--privileged|docker\.sock/u);
    for (const call of runtime.calls.filter((args) => args[0] === "run" || args[0] === "create")) {
      expect(flagValues(call, "--pull")).toEqual(["never"]);
      expect(flagValues(call, "--platform")).toEqual(["linux/amd64"]);
    }
    expect(runtime.calls.some((args) => args[0] === "pull")).toBe(false);

    expect(resolution.requested).toEqual(["matplotlib>=3"]);
    expect(resolution.platform).toEqual(AMD64_313);
    expect(resolution.platformKey).toBe(platformCacheKey(AMD64_313));
    expect(resolution.resolver).toEqual({ mode: "native", enginePlatform: "linux/amd64", targetPlatform: "linux/amd64", targetArgs: [] });
    expect(resolution.image).toBe(DEFAULT_PREP_IMAGES["3.13"]);
    expect(resolution.imageIdentity).toMatchObject({ digestReference: REF_313, digest: DIGEST_313, imageId: MANIFEST_ID, platform: "linux/amd64", pythonVersion: "3.13" });
    expect(resolution.packages.map((pkg) => pkg.name)).toEqual(["matplotlib", "six"]);
    expect(resolution.installer?.filename).toBe(WHEELS.pip?.filename);
    expect(resolution.requirements).toEqual([{ spec: "matplotlib>=3", name: "matplotlib", source: "repository", reason: null, origin: null }]);
    expect(resolution.cleanup).toEqual({
      prepId,
      containersRemoved: [`${network}-resolve`, `${network}-egress`],
      networkRemoved: true,
      tempRemoved: true,
      verifiedAbsent: true,
    });
    await expectNothingLeft();
  });

  it("writes only validated specs (plus pip) into requirements.in", async () => {
    let written = "";
    runtime.onRun = async (_args, mounts) => {
      written = await readFile(join(mounts.get("/in") ?? "", "requirements.in"), "utf8");
      await writeFile(join(mounts.get("/out") ?? "", "report.json"), JSON.stringify(pipReport([WHEELS.six!, WHEELS.pip!])));
      return ok();
    };
    await preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["Six==1.17.0 # c"], includeInstaller: true });
    expect(written).toBe("six==1.17.0\npip\n");
  });

  it("rejects unsafe requirements and an invalid platform before touching Docker", async () => {
    await expect(preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["--index-url https://evil"] })).rejects.toMatchObject({
      code: "invalid_requirement",
    });
    await expect(preparer.resolvePython({ runId: "run 1", platform: AMD64_313, requirements: ["six"] })).rejects.toMatchObject({ code: "invalid_requirement" });
    await expect(
      preparer.resolvePython({ runId: "run-1", platform: { ...AMD64_313, accelerator: "cuda" } as unknown as PlatformSpec, requirements: ["six"] }),
    ).rejects.toMatchObject({ code: "invalid_policy" });
    const rogueIndex = buildPlatformSpec({
      architecture: "amd64",
      python: "3.13",
      packageIndex: { id: "rogue", indexUrl: "https://evil.example/simple", allowedHosts: ["evil.example"], cpuOnly: true },
    });
    await expect(preparer.resolvePython({ runId: "run-1", platform: rogueIndex, requirements: ["six"] })).rejects.toMatchObject({ code: "invalid_policy" });
    expect(runtime.calls).toEqual([]);
  });

  it("cleans up and returns a typed error when pip fails", async () => {
    runtime.onRun = async () =>
      ok("", "ERROR: Could not find a version that satisfies the requirement numpy==1.19.5\nERROR: No matching distribution found for numpy==1.19.5\n", 1);
    const error = await failure(preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["numpy==1.19.5"] }));
    expect(error.code).toBe("no_compatible_wheel");
    expect(error.requirement).toBe("numpy");
    expect(error.cleanup).toMatchObject({ networkRemoved: true, tempRemoved: true, verifiedAbsent: true });
    expect(error.cleanup?.containersRemoved).toHaveLength(2);
    await expectNothingLeft();
  });

  it("classifies a denied egress attempt from the proxy log", async () => {
    runtime.proxyLog = '{"event":"connect","host":"evil.example","ip":null,"allowed":false,"reason":"host_not_allowed"}\n';
    runtime.onRun = async () => ok("", "ProxyError: Tunnel connection failed: 403 Forbidden", 1);
    await expect(preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["six"] })).rejects.toMatchObject({ code: "egress_denied" });
  });

  it("cleans up on cancellation", async () => {
    const controller = new AbortController();
    runtime.onRun = (_args, _mounts, options) =>
      new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(aborted()), { once: true });
        setTimeout(() => controller.abort(), 5);
      });
    const error = await failure(preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["six"], signal: controller.signal }));
    expect(error.code).toBe("cancelled");
    expect(error.cleanup).toMatchObject({ networkRemoved: true, tempRemoved: true, verifiedAbsent: true });
    await expectNothingLeft();
  });

  it("cleans up on timeout", async () => {
    const quick = make({ timeoutSeconds: 1 });
    runtime.onRun = (_args, mounts, options) =>
      new Promise((resolve) => {
        void writeFile(join(mounts.get("/tmp") ?? "", "partial"), "x");
        options.signal?.addEventListener("abort", () => resolve(aborted()), { once: true });
      });
    const error = await failure(quick.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["six"] }));
    expect(error.code).toBe("timeout");
    expect(error.cleanup).toMatchObject({ networkRemoved: true, tempRemoved: true, verifiedAbsent: true });
    await expectNothingLeft();
  });

  it("refuses an image whose ID does not match the policy", async () => {
    const strict = make({ expectedImageIds: { "3.13": `sha256:${"b".repeat(64)}` } });
    await expect(strict.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["six"] })).rejects.toMatchObject({ code: "image_mismatch" });
    expect(runtime.calls.some((args) => args[0] === "run" || args[0] === "create")).toBe(false);
  });

  it("fails clearly when the requested Python version's image is not available", async () => {
    runtime.images.delete(REF_311);
    const error = await failure(preparer.resolvePython({ runId: "run-1", platform: AMD64_311, requirements: ["six"] }));
    expect(error.code).toBe("image_unavailable");
    expect(error.message).toContain("python:3.11-slim-trixie@sha256:");
    expect(error.message).toContain(`docker pull --platform linux/amd64 ${REF_311}`);
    expect(runtime.calls.some((args) => args[0] === "run" || args[0] === "create" || args[0] === "pull")).toBe(false);

    const unconfigured = make({ images: { "3.13": DEFAULT_PREP_IMAGES["3.13"] } });
    await expect(unconfigured.resolvePython({ runId: "run-1", platform: AMD64_311, requirements: ["six"] })).rejects.toMatchObject({
      code: "image_unavailable",
      message: expect.stringContaining("Python 3.11"),
    });
    await expectNothingLeft();
  });

  it("pulls a missing image only when the policy allows it, by digest and for the exact platform", async () => {
    runtime.images.delete(REF_311);
    reportWheels = [WHEELS.six!];
    reportEnv = { python_full_version: "3.11.16", python_version: "3.11", platform_machine: "x86_64" };
    const pulling = make({ pullImages: true });
    await pulling.resolvePython({ runId: "run-1", platform: AMD64_311, requirements: ["six"] });
    expect(runtime.calls.filter((args) => args[0] === "pull")).toEqual([["pull", "--platform", "linux/amd64", REF_311]]);
  });

  it("rejects an interpreter that is not the platform's Python version", async () => {
    reportEnv = { python_full_version: "3.12.1", python_version: "3.12", platform_machine: "x86_64" };
    const error = await failure(preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["matplotlib"] }));
    expect(error.code).toBe("platform_mismatch");
    await expectNothingLeft();
  });
});

describe("platform-aware resolution", () => {
  it("resolves arm64 wheels across platforms when the engine cannot execute arm64, and never accepts x86_64 wheels", async () => {
    reportEnv = { python_full_version: "3.11.16", python_version: "3.11", platform_machine: "x86_64" };
    reportWheels = [WHEELS.numpyArm64!];
    const resolution = await preparer.resolvePython({ runId: "run-arm", platform: ARM64_311, requirements: ["numpy"] });
    expect(resolution.resolver.mode).toBe("cross");
    expect(resolution.resolver.targetPlatform).toBe("linux/arm64");
    expect(resolution.imageIdentity.platform).toBe("linux/amd64");
    const resolver = runtime.runs("resolve")[0] ?? [];
    expect(flagValues(resolver, "--platform")).toEqual(["linux/amd64", "manylinux_2_41_aarch64", ...Array.from({ length: 24 }, (_, i) => {
      const minor = 40 - i;
      return `manylinux_2_${minor}_aarch64`;
    }).flatMap((tag) => (tag === "manylinux_2_17_aarch64" ? [tag, "manylinux2014_aarch64"] : [tag]))]);
    expect(flagValues(resolver, "--python-version")).toEqual(["3.11"]);
    expect(flagValues(resolver, "--implementation")).toEqual(["cp"]);
    expect(flagValues(resolver, "--abi")).toEqual(["cp311"]);
    expect(resolver.join(" ")).not.toMatch(/x86_64/u);

    const manifest = await preparer.downloadWheels(resolution, { platform: ARM64_311 });
    const downloader = runtime.runs("download")[0] ?? [];
    expect(flagValues(downloader, "--platform")).toContain("manylinux2014_aarch64");
    expect(manifest.platform).toEqual(ARM64_311);
    expect(manifest.packages[0]?.platformTags).toEqual({ python: ["cp311"], abi: ["cp311"], platform: ["manylinux_2_26_aarch64", "manylinux_2_28_aarch64"] });
    expect(manifest.cache.key).toBe("linux-arm64-cp311-glibc2.41-cpu_only-pypi-cpu");
    expect(await readdir(join(root, "cache", "wheels"))).toEqual(["linux-arm64-cp311-glibc2.41-cpu_only-pypi-cpu"]);

    // A resolver that hands back an x86_64 wheel for the arm64 lab is refused before anything is downloaded.
    reportWheels = [WHEELS.numpyAmd64!];
    const before = runtime.runs("download").length;
    const error = await failure(preparer.resolvePython({ runId: "run-arm", platform: ARM64_311, requirements: ["numpy"] }));
    expect(error.code).toBe("platform_mismatch");
    expect(error.refused).toEqual(["numpy"]);
    expect(runtime.runs("download").length).toBe(before);
    await expectNothingLeft();
  });

  it("never resolves arm64 wheels for an amd64 lab, and keeps the caches apart", async () => {
    reportEnv = { python_full_version: "3.11.16", python_version: "3.11", platform_machine: "x86_64" };
    reportWheels = [WHEELS.numpyArm64!];
    const error = await failure(preparer.resolvePython({ runId: "run-x", platform: AMD64_311, requirements: ["numpy"] }));
    expect(error.code).toBe("platform_mismatch");

    reportWheels = [WHEELS.numpyAmd64!];
    const amd = await preparer.downloadWheels(await preparer.resolvePython({ runId: "run-x", platform: AMD64_311, requirements: ["numpy"] }));
    reportWheels = [WHEELS.numpyArm64!];
    const arm = await preparer.downloadWheels(await preparer.resolvePython({ runId: "run-x", platform: ARM64_311, requirements: ["numpy"] }));
    expect(amd.cache.key).not.toBe(arm.cache.key);
    expect((await readdir(join(root, "cache", "wheels"))).sort()).toEqual([platformCacheKey(AMD64_311), platformCacheKey(ARM64_311)].sort());

    // A resolution cannot be downloaded for a different platform, and a tampered resolution is re-validated.
    const resolution = await preparer.resolvePython({ runId: "run-x", platform: ARM64_311, requirements: ["numpy"] });
    await expect(preparer.downloadWheels(resolution, { platform: AMD64_311 })).rejects.toMatchObject({ code: "platform_mismatch" });
    const swapped: PythonResolution = { ...resolution, packages: [{ ...resolution.packages[0]!, filename: WHEELS.numpyAmd64!.filename }] };
    await expect(preparer.downloadWheels(swapped)).rejects.toMatchObject({ code: "platform_mismatch" });
  });

  it("runs pip in a container of the target platform when the engine can emulate it", async () => {
    runtime.images.set(REF_311, new Set(["linux/amd64", "linux/arm64"]));
    runtime.emulation = "aarch64 3.11";
    reportEnv = { python_full_version: "3.11.16", python_version: "3.11", platform_machine: "aarch64" };
    reportWheels = [WHEELS.numpyArm64!];
    const resolution = await preparer.resolvePython({ runId: "run-arm", platform: ARM64_311, requirements: ["numpy"] });
    expect(resolution.resolver).toEqual({ mode: "emulated", enginePlatform: "linux/amd64", targetPlatform: "linux/arm64", targetArgs: [] });
    const resolver = runtime.runs("resolve")[0] ?? [];
    expect(flagValues(resolver, "--platform")).toEqual(["linux/arm64"]);
    expect(resolver).not.toContain("--python-version");
    const probe = runtime.runs("arch")[0] ?? [];
    expect(flagValues(probe, "--network")).toEqual(["none"]);
    expect(flagValues(probe, "--platform")).toEqual(["linux/arm64"]);
  });

  it("with resolverMode native, refuses a platform the engine cannot execute", async () => {
    const strict = make({ resolverMode: "native" });
    const error = await failure(strict.resolvePython({ runId: "run-arm", platform: ARM64_311, requirements: ["numpy"] }));
    expect(["platform_mismatch", "image_unavailable"]).toContain(error.code);
    expect(runtime.runs("resolve")).toEqual([]);
  });
});

describe("CPU-only policy", () => {
  it.each([
    ["nvidia-cublas-cu12"],
    ["torch==2.3.0+cu121"],
    ["torchvision==0.18.0+rocm6.0"],
    ["cupy-cuda12x"],
    ["pytorch-triton-rocm"],
    ["triton"],
    ["tensorflow-gpu==2.12.0"],
    ["onnxruntime-gpu"],
    ["jax[cuda12]"],
    ["jax-cuda12-plugin"],
    ["rocm-smi"],
  ])("refuses a directly requested %s before any Docker call", async (requirement) => {
    const error = await failure(preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["numpy", requirement] }));
    expect(error.code).toBe("accelerator_package_refused");
    expect(error.refused).toHaveLength(1);
    expect(runtime.calls).toEqual([]);
  });

  it("refuses CUDA and ROCm packages pulled in transitively, without downloading them", async () => {
    reportWheels = [WHEELS.torch!, WHEELS.cublas!, WHEELS.triton!, WHEELS.rocm!, WHEELS.six!];
    const error = await failure(preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["torch"] }));
    expect(error.code).toBe("accelerator_package_refused");
    expect(error.refused).toEqual(["nvidia-cublas-cu12", "pytorch-triton-rocm", "triton"]);
    expect(error.message).toContain("transitive");
    expect(runtime.runs("download")).toEqual([]);
    expect(error.cleanup).toMatchObject({ tempRemoved: true, verifiedAbsent: true });
    await expectNothingLeft();
  });

  it("refuses an accelerator package smuggled into a resolution handed to downloadWheels", async () => {
    const resolution = await preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["matplotlib"] });
    const cublas = WHEELS.cublas!;
    const tampered: PythonResolution = {
      ...resolution,
      packages: [
        ...resolution.packages,
        { name: cublas.name, version: cublas.version, filename: cublas.filename, sha256: sha(cublas.content), url: `https://files.pythonhosted.org/x/${cublas.filename}`, requested: false },
      ],
    };
    await expect(preparer.downloadWheels(tampered)).rejects.toMatchObject({ code: "accelerator_package_refused" });
    expect(runtime.runs("download")).toEqual([]);
  });

  it("refuses a compatibility constraint that selects an accelerator build", async () => {
    await expect(
      preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["torch"], constraints: [{ spec: "torch==2.3.0+cu121", reason: "x" }] }),
    ).rejects.toMatchObject({ code: "accelerator_package_refused" });
    expect(runtime.calls).toEqual([]);
  });
});

describe("compatibility constraints", () => {
  it("applies project constraints with -c and records every change next to the repository requirements", async () => {
    let constraintsFile = "";
    runtime.onRun = async (args, mounts) => {
      if (mounts.get("/out")) constraintsFile = await readFile(join(mounts.get("/in") ?? "", "constraints.txt"), "utf8");
      return defaultRun(args, mounts, {});
    };
    const resolution = await preparer.resolvePython({
      runId: "run-1",
      platform: AMD64_313,
      requirements: [{ spec: "matplotlib>=3", source: { file: "requirements.txt", line: 3 } }],
      constraints: [
        { spec: "matplotlib<3.12", reason: "the paper's plotting code uses an API removed in 3.12", source: { file: "cases/demo/constraints.txt", line: 1 } },
        { spec: "six==1.17.0", reason: "transitive pin used in the original environment" },
      ],
      rejected: [{ file: "requirements.txt", line: 1, text: "--extra-index-url https://download.pytorch.org/whl/cu118", reason: "accelerator package indexes are not allowed" }],
      includeInstaller: true,
    });
    expect(constraintsFile).toBe("matplotlib<3.12\nsix==1.17.0\n");
    const resolver = runtime.runs("resolve")[0] ?? [];
    expect(resolver.slice(-4)).toEqual(["-c", "/in/constraints.txt", "-r", "/in/requirements.in"]);
    expect(resolution.requirements).toEqual([
      { spec: "matplotlib>=3", name: "matplotlib", source: "repository", reason: null, origin: { file: "requirements.txt", line: 3 } },
      {
        spec: "matplotlib<3.12",
        name: "matplotlib",
        source: "compatibility_constraint",
        reason: "the paper's plotting code uses an API removed in 3.12",
        origin: { file: "cases/demo/constraints.txt", line: 1 },
      },
      { spec: "six==1.17.0", name: "six", source: "compatibility_constraint", reason: "transitive pin used in the original environment", origin: null },
    ]);
    expect(resolution.compatibilityChanges).toEqual([
      {
        name: "matplotlib",
        constraint: "matplotlib<3.12",
        reason: "the paper's plotting code uses an API removed in 3.12",
        repository: ["matplotlib>=3"],
        resolved: "3.11.2",
        origin: { file: "cases/demo/constraints.txt", line: 1 },
      },
      { name: "six", constraint: "six==1.17.0", reason: "transitive pin used in the original environment", repository: [], resolved: "1.17.0", origin: null },
    ]);
    const manifest = await preparer.downloadWheels(resolution);
    const onDisk = JSON.parse(await readFile(join(manifest.wheelhouseDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(onDisk.compatibilityChanges).toEqual(resolution.compatibilityChanges);
    expect(onDisk.rejected).toEqual([expect.objectContaining({ reason: "accelerator package indexes are not allowed" })]);
    expect(manifest.packages.find((pkg) => pkg.name === "matplotlib")?.constraint).toBe("matplotlib<3.12");
    expect(manifest.packages.find((pkg) => pkg.name === "six")?.constraint).toBe("six==1.17.0");
  });

  it("requires a reason and a plain specifier for every constraint", async () => {
    await expect(
      preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["six"], constraints: [{ spec: "six<2", reason: " " }] }),
    ).rejects.toMatchObject({ code: "invalid_requirement" });
    await expect(
      preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["six"], constraints: [{ spec: "six @ https://x/y.whl", reason: "r" }] }),
    ).rejects.toMatchObject({ code: "invalid_requirement" });
    expect(runtime.calls).toEqual([]);
  });
});

describe("DependencyPreparer.downloadWheels", () => {
  async function resolve(): Promise<PythonResolution> {
    return preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["matplotlib"], includeInstaller: true });
  }

  it("downloads with hashes, verifies, caches per platform and builds a read-only wheelhouse", async () => {
    const resolution = await resolve();
    const manifest = await preparer.downloadWheels(resolution);

    const downloader = runtime.runs("download")[0] ?? [];
    expect(downloader.slice(downloader.indexOf(REF_313))).toEqual([
      REF_313, "-m", "pip", "download", "--no-deps", "--only-binary=:all:", "--require-hashes", "--progress-bar=off",
      "--dest", "/wheels", "-r", "/in/pinned.txt",
    ]);
    expect(flagValues(downloader, "--network")).toEqual([expect.stringMatching(/^dejaml-prep-[a-f0-9]{32}$/u)]);
    expect(flagValues(downloader, "--user")).toEqual(["65534:65534"]);

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.cache).toEqual({ hits: 0, downloaded: 3, evicted: 0, downloaderSkipped: false, key: platformCacheKey(AMD64_313) });
    const files = (await readdir(manifest.wheelhouseDir)).sort();
    expect(files).toEqual(
      [WHEELS.matplotlib?.filename, WHEELS.pip?.filename, WHEELS.six?.filename, "installer.json", "manifest.json", "requirements.lock.txt"].sort(),
    );
    expect(await readFile(join(manifest.wheelhouseDir, "requirements.lock.txt"), "utf8")).toBe(
      `matplotlib==3.11.2 --hash=sha256:${sha("mpl-wheel")}\nsix==1.17.0 --hash=sha256:${sha("six-wheel")}\n`,
    );
    expect(JSON.parse(await readFile(join(manifest.wheelhouseDir, "installer.json"), "utf8"))).toEqual({
      filename: WHEELS.pip?.filename,
      sha256: sha("pip-wheel"),
      version: "26.2.1",
    });
    const onDisk = JSON.parse(await readFile(join(manifest.wheelhouseDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(onDisk.wheelhouseDir).toBeUndefined();
    expect(onDisk).toMatchObject({
      imageId: MANIFEST_ID,
      image: DEFAULT_PREP_IMAGES["3.13"],
      imageIdentity: { digest: DIGEST_313, platform: "linux/amd64" },
      runId: "run-1",
      totalBytes: 27,
      platform: AMD64_313,
      resolver: { mode: "native" },
    });
    expect(manifest.packages.map((pkg) => pkg.platformTags.platform)).toEqual([["manylinux_2_27_x86_64"], ["any"]]);
    expect((await lstat(manifest.wheelhouseDir)).mode & 0o777).toBe(0o555);
    expect((await lstat(join(manifest.wheelhouseDir, WHEELS.six?.filename ?? ""))).mode & 0o777).toBe(0o444);
    const cached = join(root, "cache", "wheels", platformCacheKey(AMD64_313), sha("six-wheel"), WHEELS.six?.filename ?? "");
    expect(await readFile(cached, "utf8")).toBe("six-wheel");
    expect(manifest.cleanup.download).toMatchObject({ networkRemoved: true, tempRemoved: true, verifiedAbsent: true });
    expect(manifest.disk.download).toMatchObject({ quotaBytes: 6 * 1024 ** 3, quotaInodes: 200_000 });
    expect(manifest.disk.download?.peakBytes).toBeGreaterThanOrEqual(27);

    // Second run: everything is served from the verified cache; no containers at all.
    const callsBefore = runtime.calls.length;
    const again = await preparer.downloadWheels(resolution);
    expect(runtime.calls.length).toBe(callsBefore);
    expect(again.cache).toMatchObject({ hits: 3, downloaded: 0, evicted: 0, downloaderSkipped: true });
    expect(again.cleanup.download).toBeNull();
    expect(again.wheelhouseDir).not.toBe(manifest.wheelhouseDir);
  });

  it("re-hashes cached wheels and evicts corrupt entries", async () => {
    const resolution = await resolve();
    await preparer.downloadWheels(resolution);
    const cached = join(root, "cache", "wheels", platformCacheKey(AMD64_313), sha("six-wheel"), WHEELS.six?.filename ?? "");
    await chmod(cached, 0o644);
    await writeFile(cached, "tampered");
    const again = await preparer.downloadWheels(resolution);
    expect(again.cache).toMatchObject({ hits: 2, downloaded: 1, evicted: 1, downloaderSkipped: false });
    expect(await readFile(cached, "utf8")).toBe("six-wheel");
  });

  it("rejects a downloaded wheel whose hash does not match and caches nothing", async () => {
    const resolution = await resolve();
    runtime.onRun = async (_args, mounts) => {
      const wheels = mounts.get("/wheels") ?? "";
      for (const wheel of [WHEELS.matplotlib!, WHEELS.six!, WHEELS.pip!]) await writeFile(join(wheels, wheel.filename), `${wheel.content}!`);
      return ok();
    };
    const error = await failure(preparer.downloadWheels(resolution));
    expect(error.code).toBe("integrity_error");
    expect(error.cleanup).toMatchObject({ tempRemoved: true, verifiedAbsent: true });
    expect(await readdir(join(root, "cache", "wheels", platformCacheKey(AMD64_313)))).toEqual([]);
  });

  it("rejects unexpected files and oversize totals", async () => {
    const resolution = await resolve();
    runtime.onRun = async (_args, mounts) => {
      await writeFile(join(mounts.get("/wheels") ?? "", "evil-1.0-py3-none-any.whl"), "x");
      return ok();
    };
    await expect(preparer.downloadWheels(resolution)).rejects.toMatchObject({ code: "integrity_error" });

    const small = new DependencyPreparer({
      cacheDir: join(root, "cache2"),
      workRoot: join(root, "work"),
      runtime,
      freeSpace: PLENTY,
      policy: parsePrepPolicy({ maxTotalBytes: 10 }),
    });
    runtime.onRun = defaultRun;
    await expect(small.downloadWheels(resolution)).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("re-validates the resolution it is given", async () => {
    const resolution = await resolve();
    const tampered: PythonResolution = {
      ...resolution,
      packages: [{ ...resolution.packages[0]!, url: "https://evil.example/matplotlib-3.11.2-cp313-cp313-manylinux_2_27_x86_64.whl" }],
    };
    await expect(preparer.downloadWheels(tampered)).rejects.toMatchObject({ code: "egress_denied" });
  });
});

describe("disk-backed temporary storage", () => {
  it("refuses to start without free space plus the margin, before any container exists", async () => {
    const cramped = make({ minFreeBytes: 1024 ** 3 }, { freeSpace: async () => ({ freeBytes: 512 * 1024 ** 2 }) });
    const error = await failure(cramped.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["six"] }));
    expect(error.code).toBe("insufficient_preparation_space");
    expect(error.message).toMatch(/512\.0 MiB free, 1\.00 GiB needed/u);
    // Only the post-failure cleanup verification talks to Docker.
    expect(runtime.calls.filter((args) => args[0] !== "ps" && !(args[0] === "network" && args[1] === "ls"))).toEqual([]);
    await expectNothingLeft();
  });

  it("requires room for the download before starting the downloader", async () => {
    const resolution = await resolve();
    let free = 1024 ** 4;
    const limited = make({ maxTotalBytes: 2 * 1024 ** 3, minFreeBytes: 1024 ** 3 }, { freeSpace: async () => ({ freeBytes: free }) });
    free = 2 * 1024 ** 3;
    await expect(limited.downloadWheels(resolution)).rejects.toMatchObject({ code: "insufficient_preparation_space" });
    expect(runtime.runs("download")).toEqual([]);
    await expectNothingLeft();

    async function resolve(): Promise<PythonResolution> {
      return preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["matplotlib"], includeInstaller: true });
    }
  });

  it("aborts a download that outgrows the byte quota mid-run and removes every partial file", async () => {
    const resolution = await preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["matplotlib"], includeInstaller: true });
    const tiny = make({ maxTempBytes: 64 * 1024, diskPollMs: 20 });
    let sawAbort = false;
    runtime.onRun = (_args, mounts, options) =>
      new Promise((resolve) => {
        // pip streams a large wheel into its temp directory; it never finishes on its own.
        void writeFile(join(mounts.get("/tmp") ?? "", "big-wheel.part"), Buffer.alloc(256 * 1024));
        options.signal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve(aborted());
          },
          { once: true },
        );
      });
    const error = await failure(tiny.downloadWheels(resolution));
    expect(error.code).toBe("insufficient_preparation_space");
    expect(error.message).toMatch(/exceeded its 64\.0 KiB quota/u);
    expect(sawAbort).toBe(true);
    expect(error.cleanup).toMatchObject({ tempRemoved: true, verifiedAbsent: true });
    expect(await readdir(join(root, "cache", "wheels", platformCacheKey(AMD64_313)))).toEqual([]);
    await expectNothingLeft();
  });

  it("enforces the inode quota and catches writes that land between polls", async () => {
    const resolution = await preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["matplotlib"], includeInstaller: true });
    const few = make({ maxTempInodes: 20, diskPollMs: 60_000 });
    runtime.onRun = async (_args, mounts) => {
      for (let index = 0; index < 50; index += 1) await writeFile(join(mounts.get("/tmp") ?? "", `f${index}`), "");
      return ok();
    };
    const error = await failure(few.downloadWheels(resolution));
    expect(error.code).toBe("insufficient_preparation_space");
    expect(error.message).toMatch(/20-file quota/u);
    await expectNothingLeft();
  });

  it("cleans up after cancellation mid-download", async () => {
    const resolution = await preparer.resolvePython({ runId: "run-1", platform: AMD64_313, requirements: ["matplotlib"], includeInstaller: true });
    const controller = new AbortController();
    runtime.onRun = (_args, mounts, options) =>
      new Promise((resolve) => {
        void writeFile(join(mounts.get("/wheels") ?? "", WHEELS.matplotlib!.filename), "mpl-").then(() => controller.abort());
        options.signal?.addEventListener("abort", () => resolve(aborted()), { once: true });
      });
    const error = await failure(preparer.downloadWheels(resolution, { signal: controller.signal }));
    expect(error.code).toBe("cancelled");
    expect(error.cleanup).toMatchObject({ tempRemoved: true, networkRemoved: true, verifiedAbsent: true });
    expect(await readdir(join(root, "cache", "wheels", platformCacheKey(AMD64_313)))).toEqual([]);
    await expectNothingLeft();
  });

  it("streams a wheel larger than the old 512 MiB tmpfs through hashing, caching and the wheelhouse", async () => {
    const size = 600 * 1024 * 1024;
    const zeros = Buffer.alloc(1024 * 1024);
    const hash = createHash("sha256");
    for (let offset = 0; offset < size; offset += zeros.length) hash.update(zeros);
    const big: Wheel = { name: "bigwheel", version: "1.0", filename: "bigwheel-1.0-py3-none-any.whl", content: "" };
    const digest = hash.digest("hex");
    runtime.onRun = async (_args, mounts) => {
      const out = mounts.get("/out");
      if (out) {
        const report = pipReport([big]);
        report.install[0]!.download_info.archive_info.hashes.sha256 = digest;
        await writeFile(join(out, "report.json"), JSON.stringify(report));
      }
      const wheels = mounts.get("/wheels");
      if (wheels) {
        // A sparse 600 MiB file: large on paper, cheap on the test machine.
        const handle = await open(join(wheels, big.filename), "w");
        await handle.truncate(size);
        await handle.close();
      }
      return ok();
    };
    const roomy = make({ maxFileBytes: 1024 ** 3, maxTotalBytes: 2 * 1024 ** 3, maxTempBytes: 2 * 1024 ** 3 });
    const resolution = await roomy.resolvePython({ runId: "run-big", platform: AMD64_313, requirements: ["bigwheel"] });
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    const manifest = await roomy.downloadWheels(resolution);
    clearInterval(sampler);
    expect(manifest.packages[0]).toMatchObject({ name: "bigwheel", bytes: size, sha256: digest });
    expect((await lstat(join(manifest.wheelhouseDir, big.filename))).size).toBe(size);
    // Hashing and copying are streamed: memory grows by far less than the wheel.
    expect(peak - baseline).toBeLessThan(256 * 1024 * 1024);
    await expectNothingLeft();
  }, 60_000);
});

describe("DependencyPreparer.cleanupOrphans", () => {
  it("removes everything labelled dejaml.prep", async () => {
    runtime.containers.add("dejaml-prep-old-egress");
    runtime.networks.add("dejaml-prep-old");
    const receipt = await preparer.cleanupOrphans();
    expect(receipt).toEqual({
      containersRemoved: ["dejaml-prep-old-egress"],
      networksRemoved: ["dejaml-prep-old"],
      tempDirsRemoved: 0,
      verifiedAbsent: true,
    });
    expect(runtime.calls).toContainEqual(["ps", "--all", "--filter", "label=dejaml.prep", "--format", "{{.Names}}"]);
    expect(runtime.calls).toContainEqual(["network", "ls", "--filter", "label=dejaml.prep", "--format", "{{.Name}}"]);
  });
});
