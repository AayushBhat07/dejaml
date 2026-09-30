import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlatformSpec } from "@dejaml/contracts";
import { ImageNotReadyError, type ImageReadiness } from "@dejaml/lab-manager";
import { type DependencyManifest, type DependencyPreparer, PrepError } from "@dejaml/prep";
import { describe, expect, it } from "vitest";

import { PreparationFailure } from "./context.js";
import { preparerPort, readinessLabImagePort, screenRequirements } from "./ports.js";

const platform = buildPlatformSpec({ architecture: "arm64", python: "3.11" });
const signal = new AbortController().signal;

describe("dependency screening", () => {
  it("refuses CUDA, ROCm and accelerator indexes, URLs and local paths before any network", () => {
    const { refused } = screenRequirements([
      "numpy==1.26.4",
      "torch==2.3.0+cu121",
      "nvidia-cublas-cu12",
      "pytorch-triton-rocm",
      "--extra-index-url https://download.pytorch.org/whl/cu121",
      "pkg @ https://example.com/pkg.tar.gz",
      "./local-package",
    ]);
    const byRequirement = Object.fromEntries(refused.map((item) => [item.requirement, item.code]));
    expect(byRequirement["numpy==1.26.4"]).toBeUndefined();
    expect(Object.values(byRequirement).filter((code) => code === "accelerator_package_refused")).toHaveLength(4);
    expect(byRequirement["pkg @ https://example.com/pkg.tar.gz"]).toBe("invalid_requirement");
    expect(byRequirement["./local-package"]).toBe("invalid_requirement");
  });
});

describe("preparer port", () => {
  const failing = (code: PrepError["code"]) =>
    ({
      resolvePython: async () => {
        throw new PrepError(code, `${code} happened`, { requirement: "scipy" });
      },
    }) as unknown as DependencyPreparer;

  it.each([
    ["no_compatible_wheel", "replan"],
    ["accelerator_package_refused", "policy_blocked"],
    ["egress_denied", "policy_blocked"],
    ["insufficient_preparation_space", "inconclusive"],
    ["platform_mismatch", "failed"],
    ["image_unavailable", "failed"],
  ] as const)("maps %s to a %s study outcome", async (code, outcome) => {
    const error = await preparerPort(failing(code))
      .prepare({ runId: "run_x", platform, requirements: ["scipy"], constraints: [], signal })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PreparationFailure);
    expect(error).toMatchObject({ code, outcome, requirement: "scipy" });
  });

  it("reports a missing wheel from check without failing the study", async () => {
    const result = await preparerPort(failing("no_compatible_wheel")).check({ runId: "run_x", platform, requirements: ["scipy"], signal });
    expect(result).toMatchObject({ ok: false, detail: { code: "no_compatible_wheel", requirement: "scipy" } });
  });

  it("passes the platform and trusted constraints through, and records wheels, tags, hashes and changes", async () => {
    const wheelhouseDir = join(await mkdtemp(join(tmpdir(), "ports-")), "wh");
    await mkdir(wheelhouseDir);
    await writeFile(join(wheelhouseDir, "manifest.json"), "{}\n");
    const calls: Record<string, unknown>[] = [];
    const wheel = {
      name: "numpy",
      version: "1.26.4",
      filename: "numpy-1.26.4-cp311-cp311-manylinux_2_17_aarch64.whl",
      sha256: "a".repeat(64),
      bytes: 10,
      url: "https://files.example/numpy.whl",
      requested: true,
      cached: false,
      platformTags: { python: ["cp311"], abi: ["cp311"], platform: ["manylinux_2_17_aarch64"] },
      constraint: "numpy<2",
    };
    const preparer = {
      resolvePython: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { resolutionId: "res_1" };
      },
      downloadWheels: async (_resolution: unknown, options: Record<string, unknown>) => {
        calls.push(options);
        return {
          prepId: "prep_1",
          platform,
          image: "python@sha256:" + "b".repeat(64),
          imageIdentity: { digest: "sha256:" + "b".repeat(64) },
          packages: [wheel],
          installer: { ...wheel, name: "pip", filename: "pip-24.0-py3-none-any.whl" },
          requested: ["numpy"],
          compatibilityChanges: [{ name: "numpy", constraint: "numpy<2", reason: "np.float", repository: ["numpy"], resolved: "1.26.4", origin: null }],
          resolver: { mode: "cross" },
          cache: {},
          disk: {},
          cleanup: {},
          rejected: [],
          wheelhouseDir,
        } as unknown as DependencyManifest;
      },
    } as unknown as DependencyPreparer;
    const port = preparerPort(preparer);
    const prepared = await port.prepare({ runId: "run_x", platform, requirements: ["numpy"], constraints: [{ requirement: "numpy<2", reason: "np.float" }], signal });
    expect(calls[0]).toMatchObject({ platform, includeInstaller: true, constraints: [{ spec: "numpy<2", reason: "np.float" }] });
    expect(calls[1]).toMatchObject({ platform });
    expect(prepared).toMatchObject({
      containerPlatform: "linux/arm64",
      python: "3.11",
      installerWheel: "pip-24.0-py3-none-any.whl",
      packages: [{ name: "numpy", sha256: "a".repeat(64), tags: "cp311-cp311-manylinux_2_17_aarch64" }],
      constraints: [{ requirement: "numpy<2", reason: "np.float" }],
    });
    expect(prepared.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.changes[0]).toMatch(/numpy.*numpy<2.*1\.26\.4/u);
    expect(await port.release(prepared)).toEqual({ removed: true });
    expect(await readdir(join(wheelhouseDir, ".."))).toEqual([]);
  });
});

describe("lab image port", () => {
  const lock = {
    schemaVersion: 1,
    image: "dejaml/python-base",
    version: "0.1.0",
    baseRepository: "docker.io/library/python",
    bases: { "3.11": { tag: "3.11-slim-trixie", pythonVersion: "3.11.16", index: "sha256:" + "c".repeat(64), platforms: {} } },
  } as never;

  it("asks for the plan's Python on the approved platform and reports the ready image's identity", async () => {
    const requests: Record<string, unknown>[] = [];
    const readiness = {
      ensure: async (request: Record<string, unknown>) => {
        requests.push(request);
        return { reference: request.reference, imageId: "sha256:" + "d".repeat(64), digest: "sha256:" + "e".repeat(64), platform: request.platform, python: "3.11" };
      },
    } as unknown as ImageReadiness;
    const image = await readinessLabImagePort({ readiness, lock, contextDir: "/ctx" }).ensure({ platform, signal });
    expect(requests[0]).toMatchObject({ platform: "linux/arm64", python: "3.11" });
    expect(image).toMatchObject({ containerPlatform: "linux/arm64", python: "3.11", digest: "sha256:" + "e".repeat(64) });
  });

  it("fails the study with a typed error instead of substituting another image", async () => {
    const readiness = {
      ensure: async () => {
        throw new ImageNotReadyError("platform_mismatch", "image is linux/amd64");
      },
    } as unknown as ImageReadiness;
    await expect(readinessLabImagePort({ readiness, lock, contextDir: "/ctx" }).ensure({ platform, signal })).rejects.toMatchObject({
      code: "lab_image_platform_mismatch",
      outcome: "failed",
    });
  });
});

describe("deployment boundaries", () => {
  it("runs one job at a time, cancels by run id, and reads keys only through the secret provider", async () => {
    const { InProcessJobDispatcher, LocalArtifactStore, environmentSecrets, withSecrets } = await import("../boundaries.js");
    const jobs = new InProcessJobDispatcher();
    let release!: () => void;
    const seen: string[] = [];
    expect(jobs.submit({ runId: "run_a", kind: "study", run: (signal) => new Promise<void>((resolve) => { release = resolve; signal.addEventListener("abort", () => { seen.push("aborted"); resolve(); }); }) })).toBe(true);
    expect(jobs.submit({ runId: "run_b", kind: "study", run: async () => undefined })).toBe(false);
    const queued = jobs.enqueue({ runId: "run_c", kind: "resume", run: async () => void seen.push("c") });
    expect(jobs.cancel("run_a")).toBe(true);
    expect(jobs.cancel("run_x")).toBe(false);
    await queued;
    await jobs.idle();
    release();
    expect(seen).toEqual(["aborted", "c"]);

    const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "store-")));
    const put = await store.put({ runId: "run_a", scope: "engineer-1", path: "artifacts/m.json", content: Buffer.from("{}") });
    expect(put).toMatchObject({ bytes: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    await expect(store.put({ runId: "run_a", scope: "e", path: "../../x", content: Buffer.from("") })).rejects.toThrow(/escapes/u);

    const env = withSecrets({ DEJAML_OPENAI_MODELS: "m", DEJAML_OPENAI_API_KEY: "from-env" }, { get: (name) => (name === "DEJAML_ANTHROPIC_API_KEY" ? "from-vault" : undefined) });
    expect(env).toEqual({ DEJAML_OPENAI_MODELS: "m", DEJAML_ANTHROPIC_API_KEY: "from-vault" });
    expect(environmentSecrets({ A: "1" }).get("A")).toBe("1");
  });
});
