import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContainerRuntime, RuntimeCommandOptions, RuntimeCommandResult } from "@dejaml/lab-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DependencyPreparer, type PythonResolution } from "./downloader.js";
import { PrepError } from "./errors.js";
import { parsePrepPolicy } from "./policy.js";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

function ok(stdout = "", stderr = "", exitCode: number | null = 0): RuntimeCommandResult {
  return {
    exitCode,
    stdout: { text: stdout, bytes: stdout.length, truncated: false },
    stderr: { text: stderr, bytes: stderr.length, truncated: false },
    aborted: false,
  };
}

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

type RunHandler = (args: readonly string[], mounts: Map<string, string>, options: RuntimeCommandOptions) => Promise<RuntimeCommandResult>;

/** Records every Docker CLI call and simulates the preparation topology. */
class FakeRuntime implements ContainerRuntime {
  readonly calls: string[][] = [];
  imageId = IMAGE_ID;
  proxyLog = "";
  onRun: RunHandler = async () => ok();
  readonly containers = new Set<string>();
  readonly networks = new Set<string>();

  async docker(args: readonly string[], options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    this.calls.push([...args]);
    const [command, sub] = args;
    if (command === "image") return ok(`${this.imageId}\n`);
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
      this.containers.add(args[args.indexOf("--name") + 1] ?? "");
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
}

function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((value, index) => (args[index - 1] === flag ? [value] : []));
}

const WHEELS: Record<string, { version: string; filename: string; content: string }> = {
  matplotlib: { version: "3.11.2", filename: "matplotlib-3.11.2-cp313-cp313-manylinux_2_27_x86_64.whl", content: "mpl-wheel" },
  six: { version: "1.17.0", filename: "six-1.17.0-py2.py3-none-any.whl", content: "six-wheel" },
  pip: { version: "26.2.1", filename: "pip-26.2.1-py3-none-any.whl", content: "pip-wheel" },
};

function pipReport(names: string[]) {
  return {
    version: "1",
    environment: { python_full_version: "3.13.15" },
    install: names.map((name) => {
      const wheel = WHEELS[name];
      if (!wheel) throw new Error(name);
      return {
        metadata: { name, version: wheel.version },
        download_info: {
          url: `https://files.pythonhosted.org/packages/x/${wheel.filename}`,
          archive_info: { hashes: { sha256: sha(wheel.content) } },
        },
        requested: name === "matplotlib",
      };
    }),
  };
}

let root: string;
let runtime: FakeRuntime;
let preparer: DependencyPreparer;
const SECRET_ENV = { ANTHROPIC_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp-secret", DOCKER_AUTH_CONFIG: "{}" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prep-downloader-"));
  runtime = new FakeRuntime();
  runtime.onRun = async (_args, mounts) => {
    const out = mounts.get("/out");
    if (out) await writeFile(join(out, "report.json"), JSON.stringify(pipReport(["matplotlib", "six", "pip"])));
    const wheels = mounts.get("/wheels");
    if (wheels) {
      const pinned = await readFile(join(mounts.get("/in") ?? "", "pinned.txt"), "utf8");
      for (const wheel of Object.values(WHEELS)) {
        if (pinned.includes(`==${wheel.version} `)) await writeFile(join(wheels, wheel.filename), wheel.content);
      }
    }
    return ok("Would install ...");
  };
  const caBundle = join(root, "ca.pem");
  await writeFile(caBundle, "-----BEGIN CERTIFICATE-----\n");
  preparer = new DependencyPreparer({
    cacheDir: join(root, "cache"),
    workRoot: join(root, "work"),
    runtime,
    policy: parsePrepPolicy({ caBundlePath: caBundle }),
  });
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

describe("DependencyPreparer.resolvePython", () => {
  it("builds the isolated topology with the exact docker argv", async () => {
    const resolution = await preparer.resolvePython({ runId: "run-1", requirements: ["matplotlib>=3"], includeInstaller: true });
    const prepId = resolution.resolutionId;
    const id = prepId.slice(5);
    const network = `dejaml-prep-${id}`;
    const labels = ["--label", `dejaml.prep=${prepId}`, "--label", "dejaml.run=run-1"];

    expect(runtime.calls[0]).toEqual(["image", "inspect", "--format", "{{.Id}}", "python:3.13.15-slim-trixie"]);
    expect(runtime.find((args) => args[0] === "network" && args[1] === "create")).toEqual([
      "network", "create", "--internal", ...labels, network,
    ]);

    const proxy = runtime.find((args) => args[0] === "create");
    const proxyIndex = proxy.indexOf(IMAGE_ID);
    expect(proxy.slice(0, proxyIndex + 1)).toEqual([
      "create",
      "--name", `${network}-egress`,
      "--pull", "never",
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
      IMAGE_ID,
    ]);
    expect(proxy.slice(proxyIndex + 1)).toEqual([
      "-I", "-u", "/opt/dejaml/egress_proxy.py",
      "--listen", "0.0.0.0:3128",
      "--allow", "pypi.org",
      "--allow", "files.pythonhosted.org",
      "--budget-bytes", String(800 * 1024 * 1024 + 128 * 1024 * 1024),
      "--idle-timeout", "60",
    ]);
    expect(flagValues(proxy, "--env")).toEqual([]);
    expect(runtime.find((args) => args[0] === "network" && args[1] === "connect")).toEqual([
      "network", "connect", "--alias", "egress", network, `${network}-egress`,
    ]);

    const resolver = runtime.find((args) => args[0] === "run");
    const imageIndex = resolver.indexOf(IMAGE_ID);
    expect(resolver.slice(imageIndex)).toEqual([
      IMAGE_ID,
      "-m", "pip", "install", "--dry-run", "--ignore-installed", "--only-binary=:all:", "--progress-bar=off",
      "--report", "/out/report.json", "-r", "/in/requirements.in",
    ]);
    const options = resolver.slice(0, imageIndex);
    expect(options.slice(0, 7)).toEqual(["run", "--name", `${network}-resolve`, "--pull", "never", ...labels.slice(0, 2)]);
    expect(flagValues(options, "--network")).toEqual([network]);
    expect(flagValues(options, "--user")).toEqual(["65534:65534"]);
    expect(options).toContain("--read-only");
    expect(flagValues(options, "--cap-drop")).toEqual(["ALL"]);
    expect(flagValues(options, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(flagValues(options, "--tmpfs")).toEqual(["/tmp:rw,noexec,nosuid,nodev,size=512m"]);
    expect(flagValues(options, "--cpus")).toEqual(["2"]);
    expect(flagValues(options, "--memory")).toEqual(["2048m"]);
    expect(flagValues(options, "--pids-limit")).toEqual(["256"]);
    expect(flagValues(options, "--entrypoint")).toEqual(["python"]);
    expect(flagValues(options, "--env")).toEqual([
      "HOME=/tmp",
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
    ]);
    expect(options).not.toContain("--privileged");
    expect(options).not.toContain("-v");
    const everything = runtime.calls.flat().join(" ");
    for (const secret of Object.values(SECRET_ENV)) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/--env-file|--volume |-v |--network host|--privileged|docker\.sock/u);
    for (const call of runtime.calls.filter((args) => args[0] === "run" || args[0] === "create")) {
      expect(call).toContain("--pull");
      expect(flagValues(call, "--pull")).toEqual(["never"]);
    }

    expect(resolution.requested).toEqual(["matplotlib>=3"]);
    expect(resolution.packages.map((pkg) => pkg.name)).toEqual(["matplotlib", "six"]);
    expect(resolution.installer?.filename).toBe(WHEELS.pip?.filename);
    expect(resolution.cleanup).toEqual({
      prepId,
      containersRemoved: [`${network}-resolve`, `${network}-egress`],
      networkRemoved: true,
      tempRemoved: true,
      verifiedAbsent: true,
    });
    expect(await readdir(join(root, "work"))).toEqual([]);
  });

  it("writes only validated specs (plus pip) into requirements.in", async () => {
    let written = "";
    runtime.onRun = async (_args, mounts) => {
      written = await readFile(join(mounts.get("/in") ?? "", "requirements.in"), "utf8");
      await writeFile(join(mounts.get("/out") ?? "", "report.json"), JSON.stringify(pipReport(["six", "pip"])));
      return ok();
    };
    await preparer.resolvePython({ runId: "run-1", requirements: ["Six==1.17.0 # c"], includeInstaller: true });
    expect(written).toBe("six==1.17.0\npip\n");
  });

  it("rejects unsafe requirements before touching Docker", async () => {
    await expect(preparer.resolvePython({ runId: "run-1", requirements: ["--index-url https://evil"] })).rejects.toMatchObject({
      code: "invalid_requirement",
    });
    await expect(preparer.resolvePython({ runId: "run 1", requirements: ["six"] })).rejects.toMatchObject({ code: "invalid_requirement" });
    expect(runtime.calls).toEqual([]);
  });

  it("cleans up and returns a typed error when pip fails", async () => {
    runtime.onRun = async () =>
      ok("", "ERROR: Could not find a version that satisfies the requirement numpy==1.19.5\nERROR: No matching distribution found for numpy==1.19.5\n", 1);
    const error = (await preparer.resolvePython({ runId: "run-1", requirements: ["numpy==1.19.5"] }).catch((e: unknown) => e)) as PrepError;
    expect(error).toBeInstanceOf(PrepError);
    expect(error.code).toBe("no_compatible_wheel");
    expect(error.requirement).toBe("numpy");
    expect(error.cleanup).toMatchObject({ networkRemoved: true, tempRemoved: true, verifiedAbsent: true });
    expect(error.cleanup?.containersRemoved).toHaveLength(2);
    expect(runtime.calls.filter((args) => args[0] === "rm").map((args) => args.slice(0, 3))).toEqual([
      ["rm", "--force", "--volumes"],
      ["rm", "--force", "--volumes"],
    ]);
    expect(runtime.calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(true);
    expect(runtime.containers.size).toBe(0);
    expect(runtime.networks.size).toBe(0);
    expect(await readdir(join(root, "work"))).toEqual([]);
  });

  it("classifies a denied egress attempt from the proxy log", async () => {
    runtime.proxyLog = '{"event":"connect","host":"evil.example","ip":null,"allowed":false,"reason":"host_not_allowed"}\n';
    runtime.onRun = async () => ok("", "ProxyError: Tunnel connection failed: 403 Forbidden", 1);
    await expect(preparer.resolvePython({ runId: "run-1", requirements: ["six"] })).rejects.toMatchObject({ code: "egress_denied" });
  });

  it("cleans up on cancellation", async () => {
    const controller = new AbortController();
    runtime.onRun = (_args, _mounts, options) =>
      new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve({ ...ok("", "", null), aborted: true }), { once: true });
        setTimeout(() => controller.abort(), 5);
      });
    const error = (await preparer
      .resolvePython({ runId: "run-1", requirements: ["six"], signal: controller.signal })
      .catch((e: unknown) => e)) as PrepError;
    expect(error.code).toBe("cancelled");
    expect(error.cleanup).toMatchObject({ networkRemoved: true, tempRemoved: true, verifiedAbsent: true });
    expect(runtime.containers.size).toBe(0);
    expect(runtime.networks.size).toBe(0);
    expect(await readdir(join(root, "work"))).toEqual([]);
  });

  it("refuses an image whose ID does not match the policy", async () => {
    const strict = new DependencyPreparer({
      cacheDir: join(root, "cache"),
      workRoot: join(root, "work"),
      runtime,
      policy: parsePrepPolicy({ expectedImageId: `sha256:${"b".repeat(64)}` }),
    });
    await expect(strict.resolvePython({ runId: "run-1", requirements: ["six"] })).rejects.toMatchObject({ code: "image_mismatch" });
    expect(runtime.calls.some((args) => args[0] === "run" || args[0] === "create")).toBe(false);
  });
});

describe("DependencyPreparer.downloadWheels", () => {
  async function resolve(): Promise<PythonResolution> {
    return preparer.resolvePython({ runId: "run-1", requirements: ["matplotlib"], includeInstaller: true });
  }

  it("downloads with hashes, verifies, caches and builds a read-only wheelhouse", async () => {
    const resolution = await resolve();
    const manifest = await preparer.downloadWheels(resolution);

    const downloader = runtime.find((args) => args[0] === "run" && args.includes("download"));
    expect(downloader.slice(downloader.indexOf(IMAGE_ID))).toEqual([
      IMAGE_ID, "-m", "pip", "download", "--no-deps", "--only-binary=:all:", "--require-hashes", "--progress-bar=off",
      "--dest", "/wheels", "-r", "/in/pinned.txt",
    ]);
    expect(flagValues(downloader, "--network")).toEqual([expect.stringMatching(/^dejaml-prep-[a-f0-9]{32}$/u)]);
    expect(flagValues(downloader, "--user")).toEqual(["65534:65534"]);

    expect(manifest.cache).toEqual({ hits: 0, downloaded: 3, evicted: 0, downloaderSkipped: false });
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
    expect(onDisk).toMatchObject({ imageId: IMAGE_ID, runId: "run-1", totalBytes: 27 });
    expect((await lstat(manifest.wheelhouseDir)).mode & 0o777).toBe(0o555);
    expect((await lstat(join(manifest.wheelhouseDir, WHEELS.six?.filename ?? ""))).mode & 0o777).toBe(0o444);
    const cached = join(root, "cache", "wheels", sha("six-wheel"), WHEELS.six?.filename ?? "");
    expect(await readFile(cached, "utf8")).toBe("six-wheel");
    expect(manifest.cleanup.download).toMatchObject({ networkRemoved: true, tempRemoved: true, verifiedAbsent: true });

    // Second run: everything is served from the verified cache; no containers at all.
    const callsBefore = runtime.calls.length;
    const again = await preparer.downloadWheels(resolution);
    expect(runtime.calls.length).toBe(callsBefore);
    expect(again.cache).toEqual({ hits: 3, downloaded: 0, evicted: 0, downloaderSkipped: true });
    expect(again.cleanup.download).toBeNull();
    expect(again.wheelhouseDir).not.toBe(manifest.wheelhouseDir);
  });

  it("re-hashes cached wheels and evicts corrupt entries", async () => {
    const resolution = await resolve();
    await preparer.downloadWheels(resolution);
    const cached = join(root, "cache", "wheels", sha("six-wheel"), WHEELS.six?.filename ?? "");
    await chmod(cached, 0o644);
    await writeFile(cached, "tampered");
    const again = await preparer.downloadWheels(resolution);
    expect(again.cache).toEqual({ hits: 2, downloaded: 1, evicted: 1, downloaderSkipped: false });
    expect(await readFile(cached, "utf8")).toBe("six-wheel");
  });

  it("rejects a downloaded wheel whose hash does not match and caches nothing", async () => {
    const resolution = await resolve();
    runtime.onRun = async (_args, mounts) => {
      const wheels = mounts.get("/wheels") ?? "";
      for (const wheel of Object.values(WHEELS)) await writeFile(join(wheels, wheel.filename), `${wheel.content}!`);
      return ok();
    };
    const error = (await preparer.downloadWheels(resolution).catch((e: unknown) => e)) as PrepError;
    expect(error.code).toBe("integrity_error");
    expect(error.cleanup).toMatchObject({ tempRemoved: true, verifiedAbsent: true });
    expect(await readdir(join(root, "cache", "wheels"))).toEqual([]);
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
      policy: parsePrepPolicy({ maxTotalBytes: 10 }),
    });
    runtime.onRun = async (_args, mounts) => {
      const wheels = mounts.get("/wheels") ?? "";
      for (const wheel of Object.values(WHEELS)) await writeFile(join(wheels, wheel.filename), wheel.content);
      return ok();
    };
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
