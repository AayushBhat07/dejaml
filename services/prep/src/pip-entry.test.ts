import { buildPlatformSpec } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";

import { ACCELERATOR_PATTERN_SOURCES } from "./accelerator.js";
import { ACCELERATOR_GUARD_MARKER, parseAcceleratorGuard, pipEntryCode, pipInvocation } from "./pip-entry.js";

const AMD64 = buildPlatformSpec({ architecture: "amd64", python: "3.11" });
const ARM64 = buildPlatformSpec({ architecture: "arm64", python: "3.11" });

describe("pipInvocation", () => {
  it("always starts pip isolated behind the download guard", () => {
    for (const mode of ["native", "emulated", "cross"] as const) {
      const argv = pipInvocation(mode, AMD64);
      expect(argv.slice(0, 2)).toEqual(["-I", "-c"]);
      expect(argv).toHaveLength(3);
      const code = argv[2] ?? "";
      expect(code).toContain("RequirementPreparer.prepare_linked_requirements_more = prepare_more");
      expect(code).toContain("Session.request = request");
      expect(code).toContain(ACCELERATOR_GUARD_MARKER);
      // Fails closed when pip's internals are missing.
      expect(code).toContain("os._exit(4)");
    }
  });

  it("changes platform.machine only in cross mode, to the target machine", () => {
    expect(pipEntryCode("native", AMD64)).not.toContain("platform.machine =");
    expect(pipEntryCode("emulated", ARM64)).not.toContain("platform.machine =");
    expect(pipEntryCode("cross", ARM64)).toContain('platform.machine = lambda: "aarch64"');
    expect(pipEntryCode("cross", AMD64)).toContain('platform.machine = lambda: "x86_64"');
  });

  it("embeds exactly the host's accelerator denylist", () => {
    const code = pipEntryCode("native", AMD64);
    const literal = /^RULES = json\.loads\((.+)\)$/mu.exec(code)?.[1] ?? "";
    const rules = JSON.parse(JSON.parse(literal) as string) as { names: string[]; local: string };
    expect(rules.names).toEqual(ACCELERATOR_PATTERN_SOURCES.names.map(([source]) => source));
    expect(rules.local).toBe(ACCELERATOR_PATTERN_SOURCES.localVersion);
  });
});

describe("parseAcceleratorGuard", () => {
  it("reads the guard's last marker and re-decides each name on the host", () => {
    const output = [
      "Collecting torch",
      `${ACCELERATOR_GUARD_MARKER} {"packages": [{"name": "nvidia_cublas", "version": "13.1.1.3", "filename": "a.whl"}, {"name": "torch", "version": "2.3.0+cu121", "filename": "b.whl"}]}`,
    ].join("\n");
    expect(parseAcceleratorGuard(output)).toEqual([
      { name: "nvidia-cublas", spec: "nvidia-cublas==13.1.1.3", reason: "NVIDIA CUDA runtime or library package", origin: "resolved" },
      { name: "torch", spec: "torch==2.3.0+cu121", reason: "accelerator build (2.3.0+cu121)", origin: "resolved" },
    ]);
    expect(parseAcceleratorGuard("Would install six-1.17.0")).toBeNull();
    expect(parseAcceleratorGuard(`${ACCELERATOR_GUARD_MARKER} not json`)).toEqual([]);
  });
});
