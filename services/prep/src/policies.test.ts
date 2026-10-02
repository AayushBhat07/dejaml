import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlatformSpec } from "@dejaml/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acceleratorReason, findAcceleratorPackages, findAcceleratorRequirements, isAcceleratorIndexUrl } from "./accelerator.js";
import { loadCompatibilityConstraints, parseCompatibilityConstraints } from "./constraints.js";
import { installationReceipt } from "./offline.js";
import { parseRequirementLine, type ParsedRequirement } from "./requirements.js";
import { assertFreeSpace, measureTree, QuotaWatcher } from "./space.js";
import { assertWheelsMatchPlatform, manylinuxTags, pipCrossTargetArgs } from "./target.js";

function parsed(line: string): ParsedRequirement {
  const result = parseRequirementLine(line);
  if (!result.ok || !result.requirement) throw new Error(line);
  return result.requirement;
}

describe("CPU-only accelerator policy", () => {
  it.each([
    "nvidia-cublas-cu12",
    "nvidia-cudnn-cu12",
    "nvidia-nccl-cu12",
    "cuda-python",
    "cuda-bindings",
    "cupy-cuda12x",
    "cupy-rocm-5-0",
    "cudf-cu12",
    "jax-cuda12-plugin",
    "jax-cuda12-pjrt",
    "mxnet-cu112",
    "pytorch-triton-rocm",
    "pytorch-triton",
    "triton",
    "tensorflow-gpu",
    "onnxruntime-gpu",
    "onnxruntime-rocm",
    "paddlepaddle-gpu",
    "faiss-gpu",
    "rocm-smi",
    "tensorrt",
    "libtpu",
    "intel-sycl-rt",
    "pycuda",
  ])("refuses %s", (name) => {
    expect(acceleratorReason(name)).not.toBeNull();
  });

  it.each(["numpy", "torch", "torchvision", "tensorflow", "jax", "jaxlib", "onnxruntime", "scikit-learn", "tritonclient", "pynvml"])(
    "allows the CPU package %s",
    (name) => {
      expect(acceleratorReason(name)).toBeNull();
    },
  );

  it("refuses accelerator local versions and extras", () => {
    expect(acceleratorReason("torch", "2.3.0+cu121")).toMatch(/cu121/u);
    expect(acceleratorReason("torchaudio", "2.3.0+rocm6.0")).toMatch(/rocm/u);
    expect(acceleratorReason("intel-extension-for-pytorch", "2.1.10+xpu")).toMatch(/xpu/u);
    expect(acceleratorReason("torch", "2.3.0+cpu")).toBeNull();
    expect(acceleratorReason("jax", null, ["cuda12"])).toMatch(/cuda12/u);
    expect(acceleratorReason("tensorflow", null, ["and-cuda"])).toMatch(/and-cuda/u);
    expect(acceleratorReason("jax", null, ["cpu"])).toBeNull();
    expect(
      findAcceleratorRequirements([parsed("torch==2.3.0+cu121"), parsed("numpy"), parsed("jax[cuda12]>=0.4")]).map((item) => item.name),
    ).toEqual(["torch", "jax"]);
    expect(
      findAcceleratorPackages([
        { name: "torch", version: "2.8.0" },
        { name: "nvidia_cublas_cu12", version: "12.8.4.1" },
        { name: "jaxlib", version: "0.4.30+cuda12.cudnn89" },
      ]),
    ).toEqual([
      {
        name: "nvidia-cublas-cu12",
        spec: "nvidia_cublas_cu12==12.8.4.1",
        reason: "NVIDIA CUDA runtime or library package",
        origin: "resolved",
      },
      { name: "jaxlib", spec: "jaxlib==0.4.30+cuda12.cudnn89", reason: "accelerator build (0.4.30+cuda12.cudnn89)", origin: "resolved" },
    ]);
  });

  it("recognizes CUDA/ROCm package indexes and reports them when a requirements file points at one", () => {
    expect(isAcceleratorIndexUrl("https://download.pytorch.org/whl/cu118")).toBe(true);
    expect(isAcceleratorIndexUrl("https://download.pytorch.org/whl/rocm6.0")).toBe(true);
    expect(isAcceleratorIndexUrl("https://pypi.nvidia.com")).toBe(true);
    expect(isAcceleratorIndexUrl("https://download.pytorch.org/whl/cpu")).toBe(false);
    expect(isAcceleratorIndexUrl("https://pypi.org/simple")).toBe(false);
    const line = parseRequirementLine("--extra-index-url https://download.pytorch.org/whl/cu118");
    expect(line).toEqual({ ok: false, reason: expect.stringMatching(/accelerator package indexes/u) });
    expect(parseRequirementLine("--extra-index-url https://download.pytorch.org/whl/cpu")).toEqual({
      ok: false,
      reason: expect.stringMatching(/extra indexes/u),
    });
    expect(parseRequirementLine("-f https://download.pytorch.org/whl/rocm6.0/torch_stable.html")).toEqual({
      ok: false,
      reason: expect.stringMatching(/accelerator/u),
    });
  });
});

describe("platform targeting", () => {
  it("lists manylinux tags for the machine and glibc, newest first", () => {
    const arm = manylinuxTags(buildPlatformSpec({ architecture: "arm64", python: "3.11" }));
    expect(arm[0]).toBe("manylinux_2_41_aarch64");
    expect(arm.at(-2)).toBe("manylinux_2_17_aarch64");
    expect(arm.at(-1)).toBe("manylinux2014_aarch64");
    expect(arm.every((tag) => tag.includes("aarch64"))).toBe(true);
    const amd = manylinuxTags(buildPlatformSpec({ architecture: "amd64", python: "3.10", glibc: "2.28" }));
    expect(amd[0]).toBe("manylinux_2_28_x86_64");
    expect(amd).toContain("manylinux2014_x86_64");
    expect(amd).toContain("manylinux2010_x86_64");
    expect(amd.at(-1)).toBe("manylinux1_x86_64");
    expect(amd.every((tag) => tag.includes("x86_64"))).toBe(true);
    expect(pipCrossTargetArgs(buildPlatformSpec({ architecture: "arm64", python: "3.10" })).slice(0, 6)).toEqual([
      "--python-version",
      "3.10",
      "--implementation",
      "cp",
      "--abi",
      "cp310",
    ]);
  });

  it("validates every wheel against the platform", () => {
    const arm = buildPlatformSpec({ architecture: "arm64", python: "3.11" });
    expect(() =>
      assertWheelsMatchPlatform(
        [
          { name: "six", filename: "six-1.17.0-py2.py3-none-any.whl" },
          { name: "numpy", filename: "numpy-2.3.3-cp311-cp311-manylinux_2_26_aarch64.manylinux_2_28_aarch64.whl" },
          { name: "scipy", filename: "scipy-1.16.0-cp312-abi3-manylinux_2_28_aarch64.whl" },
        ],
        arm,
      ),
    ).toThrow(expect.objectContaining({ code: "platform_mismatch", refused: ["scipy"] }));
    expect(() =>
      assertWheelsMatchPlatform(
        [{ name: "numpy", filename: "numpy-2.3.3-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl" }],
        arm,
      ),
    ).toThrow(/linux\/arm64/u);
    expect(() =>
      assertWheelsMatchPlatform([{ name: "numpy", filename: "numpy-2.3.3-cp311-cp311-musllinux_1_2_aarch64.whl" }], arm),
    ).toThrow(/is not built for linux\/arm64/u);
  });
});

describe("disk accounting", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prep-space-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("measures apparent bytes and entries without following symlinks", async () => {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "b", "f"), Buffer.alloc(1000));
    await writeFile(join(dir, "g"), Buffer.alloc(24));
    await symlink("/etc", join(dir, "link"));
    const usage = await measureTree(dir, { maxBytes: 10_000, maxInodes: 100 });
    expect(usage.inodes).toBe(5);
    expect(usage.bytes).toBeGreaterThanOrEqual(1024);
    expect(usage.bytes).toBeLessThan(1100);
    expect(usage.exceeded).toBeNull();
    expect((await measureTree(dir, { maxBytes: 100, maxInodes: 100 })).exceeded).toBe("bytes");
    expect((await measureTree(dir, { maxBytes: 10_000, maxInodes: 2 })).exceeded).toBe("inodes");
  });

  it("requires free space plus the margin", async () => {
    await expect(assertFreeSpace(async () => ({ freeBytes: 10 }), dir, 5, 5, "x")).resolves.toBe(10);
    await expect(assertFreeSpace(async () => ({ freeBytes: 10 }), dir, 6, 5, "extraction")).rejects.toMatchObject({
      code: "insufficient_preparation_space",
      message: expect.stringContaining("extraction"),
    });
    await expect(
      assertFreeSpace(
        async () => {
          throw new Error("ENOENT");
        },
        dir,
        0,
        0,
        "x",
      ),
    ).rejects.toMatchObject({ code: "insufficient_preparation_space" });
  });

  it("the watcher fires when free space drops below the margin", async () => {
    let fired = false;
    const watcher = new QuotaWatcher(
      dir,
      { maxBytes: 1e9, maxInodes: 1e6, minFreeBytes: 100, pollMs: 20 },
      async () => ({ freeBytes: 50 }),
      () => {
        fired = true;
      },
    );
    expect(await watcher.check()).toMatch(/below the 100 B margin/u);
    expect(fired).toBe(true);
  });
});

describe("compatibility constraints files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prep-constraints-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses project constraints with their reasons", async () => {
    await writeFile(
      join(dir, "constraints.txt"),
      "# compatibility pins for the 2019 paper\nnumpy<1.24  # reason: uses np.float\nscikit-learn==0.24.2 # the paper's results used 0.24\n",
    );
    expect(await loadCompatibilityConstraints(join(dir, "constraints.txt"), "cases/demo/constraints.txt")).toEqual([
      { spec: "numpy<1.24", reason: "uses np.float", source: { file: "cases/demo/constraints.txt", line: 2 } },
      { spec: "scikit-learn==0.24.2", reason: "the paper's results used 0.24", source: { file: "cases/demo/constraints.txt", line: 3 } },
    ]);
  });

  it("rejects constraints without a reason, with options, extras, URLs or duplicates", () => {
    expect(() => parseCompatibilityConstraints("numpy<2\n", "c.txt")).toThrow(/reason/u);
    expect(() => parseCompatibilityConstraints("--index-url https://x # reason: x\n", "c.txt")).toThrow(/rejected/u);
    expect(() => parseCompatibilityConstraints("jax[cpu]<1 # reason: x\n", "c.txt")).toThrow(/extras/u);
    expect(() => parseCompatibilityConstraints("numpy # reason: x\n", "c.txt")).toThrow(/specifier/u);
    expect(() => parseCompatibilityConstraints("numpy<2 # reason: a\nNumPy<3 # reason: b\n", "c.txt")).toThrow(/twice/u);
  });

  it("reads only regular files", async () => {
    await symlink("/etc/hostname", join(dir, "link.txt"));
    await expect(loadCompatibilityConstraints(join(dir, "link.txt"))).rejects.toMatchObject({ code: "invalid_requirement" });
  });
});

describe("installationReceipt", () => {
  const manifest = {
    platform: { python: { version: "3.11" } },
    packages: [
      { name: "numpy", version: "2.3.3", sha256: "a".repeat(64) },
      { name: "scikit-learn", version: "1.7.2", sha256: "b".repeat(64) },
    ],
  };

  it("confirms the lab has exactly the locked versions on the platform's Python", () => {
    const receipt = installationReceipt(manifest, {
      python: "3.11.16",
      distributions: [
        { name: "numpy", version: "2.3.3" },
        { name: "scikit_learn", version: "1.7.2" },
      ],
    });
    expect(receipt.ok).toBe(true);
    expect(receipt.python).toEqual({ expected: "3.11", actual: "3.11.16", matches: true });
  });

  it("reports missing, mismatched and unexpected packages and a wrong interpreter", () => {
    const receipt = installationReceipt(manifest, {
      python: "3.13.15",
      distributions: [
        { name: "numpy", version: "2.2.0" },
        { name: "torch", version: "2.8.0" },
      ],
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.python.matches).toBe(false);
    expect(receipt.missing).toEqual(["scikit-learn"]);
    expect(receipt.unexpected).toEqual(["torch"]);
    expect(receipt.packages[0]).toMatchObject({ name: "numpy", expected: "2.3.3", installed: "2.2.0", matches: false });
  });
});
