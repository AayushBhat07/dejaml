import { describe, expect, it } from "vitest";

import {
  buildPlatformSpec,
  ClaimContractSchema,
  MetricParserSchema,
  parseWheelTags,
  platformCacheKey,
  platformFromEnv,
  wheelMatchesPlatform,
} from "./index.js";

const arm = buildPlatformSpec({ architecture: "arm64", python: "3.11" });
const amd = buildPlatformSpec({ architecture: "amd64", python: "3.11" });

describe("platform spec", () => {
  it("maps each target to one container platform and Python ABI", () => {
    expect(arm).toMatchObject({
      os: "linux",
      containerPlatform: "linux/arm64",
      python: { version: "3.11", abi: "cp311" },
      accelerator: "cpu_only",
    });
    expect(amd.containerPlatform).toBe("linux/amd64");
    expect(platformFromEnv({ DEJAML_PLATFORM: "apple-silicon-dev" }, "x64").containerPlatform).toBe("linux/arm64");
    expect(platformFromEnv({ DEJAML_PLATFORM: "intel-dev" }, "arm64").containerPlatform).toBe("linux/amd64");
    expect(platformFromEnv({ DEJAML_PLATFORM: "aws-cpu" }, "arm64").containerPlatform).toBe("linux/amd64");
    expect(platformFromEnv({ DEJAML_PLATFORM: "linux/arm64", DEJAML_PYTHON_VERSION: "3.10" }, "x64")).toMatchObject({
      architecture: "arm64",
      python: { abi: "cp310" },
    });
    expect(platformFromEnv({}, "arm64").architecture).toBe("arm64");
    expect(platformFromEnv({}, "x64").architecture).toBe("amd64");
    expect(() => platformFromEnv({}, "ia32")).toThrow(/unsupported host architecture/u);
    expect(() => platformFromEnv({ DEJAML_PLATFORM: "windows/amd64" }, "x64")).toThrow(/DEJAML_PLATFORM/u);
    expect(() => platformFromEnv({ DEJAML_PYTHON_VERSION: "2.7" }, "x64")).toThrow(/DEJAML_PYTHON_VERSION/u);
  });

  it("keeps cache keys apart per platform and Python version", () => {
    const keys = new Set([arm, amd, buildPlatformSpec({ architecture: "arm64", python: "3.12" })].map(platformCacheKey));
    expect(keys.size).toBe(3);
  });

  it("accepts only wheels built for the platform's machine, glibc, and CPython", () => {
    const numpyArm = "numpy-2.2.6-cp311-cp311-manylinux_2_17_aarch64.manylinux2014_aarch64.whl";
    const numpyAmd = "numpy-2.2.6-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl";
    expect(wheelMatchesPlatform(numpyArm, arm).ok).toBe(true);
    expect(wheelMatchesPlatform(numpyAmd, arm).ok).toBe(false);
    expect(wheelMatchesPlatform(numpyAmd, amd).ok).toBe(true);
    expect(wheelMatchesPlatform(numpyArm, amd).ok).toBe(false);
    expect(wheelMatchesPlatform("six-1.17.0-py2.py3-none-any.whl", arm).ok).toBe(true);
    expect(wheelMatchesPlatform("cryptography-44.0.0-cp39-abi3-manylinux_2_34_x86_64.whl", amd).ok).toBe(true);
    expect(wheelMatchesPlatform("pkg-1.0-cp312-cp312-manylinux_2_17_x86_64.whl", amd).ok).toBe(false);
    expect(wheelMatchesPlatform("pkg-1.0-cp311-cp311-musllinux_1_2_x86_64.whl", amd).ok).toBe(false);
    expect(wheelMatchesPlatform("pkg-1.0-cp311-cp311-manylinux_2_45_x86_64.whl", amd).ok).toBe(false);
    expect(wheelMatchesPlatform("pkg-1.0-cp311-cp311-macosx_14_0_arm64.whl", arm).ok).toBe(false);
    expect(wheelMatchesPlatform("pkg-1.0.tar.gz", arm).ok).toBe(false);
    expect(parseWheelTags("pkg-1.0-1-cp311-cp311-manylinux2014_x86_64.whl")).toEqual({
      python: ["cp311"],
      abi: ["cp311"],
      platform: ["manylinux2014_x86_64"],
    });
  });
});

describe("claim contract", () => {
  const contract = {
    schemaVersion: 1,
    method: "Random Forest",
    dataset: { name: "Iris", source: { kind: "repository", paths: ["data/iris.csv"] } },
    split: "5-fold cross-validation",
    preprocessing: "none",
    seedPolicy: "random_state=0 as in the script",
    metric: { name: "accuracy", unit: "fraction" },
    reportedValue: 0.95,
    paperReference: { page: 4, location: "Table 1", excerpt: "RF 0.95" },
    repository: { url: "https://github.com/example/paper", commitSha: "a".repeat(40) },
    entrypoint: "run.py",
    command: { argv: ["python", "run.py"], cwd: "work/repo" },
    environment: { platform: arm, requirements: ["scikit-learn==1.5.2"], compatibilityConstraints: [] },
    expectedRuntimeSeconds: 120,
    metricParser: { source: "stdout", pattern: "accuracy: ([0-9.]+)" },
    tolerance: 0.02,
    stopConditions: ["the command exits non-zero"],
  };

  it("accepts a complete contract and refuses escapes and gaps", () => {
    expect(ClaimContractSchema.safeParse(contract).success).toBe(true);
    expect(ClaimContractSchema.safeParse({ ...contract, entrypoint: "../etc/passwd" }).success).toBe(false);
    expect(ClaimContractSchema.safeParse({ ...contract, entrypoint: "/abs/run.py" }).success).toBe(false);
    expect(ClaimContractSchema.safeParse({ ...contract, stopConditions: [] }).success).toBe(false);
    const { seedPolicy: _seed, ...missing } = contract;
    expect(ClaimContractSchema.safeParse(missing).success).toBe(false);
    expect(MetricParserSchema.safeParse({ source: "json", path: "artifacts/../x.json", key: "a" }).success).toBe(false);
    expect(MetricParserSchema.safeParse({ source: "json", path: "work/x.json", key: "a" }).success).toBe(false);
  });
});
