import {
  parseWheelTags,
  wheelMachine,
  wheelMatchesPlatform,
  type ContainerPlatform,
  type PlatformSpec,
  type WheelTags,
} from "@dejaml/contracts";

import { PrepError } from "./errors.js";

/**
 * How wheels are resolved for a PlatformSpec:
 * - `native`: the prep container runs on the target platform natively;
 * - `emulated`: it runs on the target platform through the host's emulation (binfmt/QEMU);
 * - `cross`: the host cannot execute the target platform, so a same-Python
 *   container of the host platform runs pip with explicit target options
 *   (`--platform <manylinux tags> --python-version --implementation cp --abi`).
 * In every mode each wheel is validated with `wheelMatchesPlatform`.
 */
export type ResolverMode = "native" | "emulated" | "cross";

/** Manylinux platform tags a platform's glibc accepts, newest first (PEP 600 plus the legacy aliases). */
export function manylinuxTags(platform: PlatformSpec): string[] {
  const machine = wheelMachine(platform.architecture);
  const [major, minor] = platform.libc.version.split(".").map(Number) as [number, number];
  if (major !== 2) throw new PrepError("platform_mismatch", `unsupported glibc ${platform.libc.version}`);
  const lowest = machine === "x86_64" ? 5 : 17;
  const tags: string[] = [];
  for (let value = minor; value >= lowest; value -= 1) {
    tags.push(`manylinux_2_${value}_${machine}`);
    if (value === 17) tags.push(`manylinux2014_${machine}`);
    if (value === 12 && machine === "x86_64") tags.push("manylinux2010_x86_64");
    if (value === 5 && machine === "x86_64") tags.push("manylinux1_x86_64");
  }
  return tags;
}

/** pip options that make it resolve for `platform` regardless of the interpreter it runs on. */
export function pipCrossTargetArgs(platform: PlatformSpec): string[] {
  return [
    "--python-version", platform.python.version,
    "--implementation", platform.python.implementation,
    "--abi", platform.python.abi,
    ...manylinuxTags(platform).flatMap((tag) => ["--platform", tag]),
  ];
}

export function architectureOf(containerPlatform: string): "amd64" | "arm64" | null {
  const match = /^linux\/(amd64|arm64)(\/v8)?$/u.exec(containerPlatform.trim());
  return (match?.[1] as "amd64" | "arm64" | undefined) ?? null;
}

export function sameContainerPlatform(a: string, b: ContainerPlatform): boolean {
  return architectureOf(a) !== null && architectureOf(a) === architectureOf(b);
}

/** The tags of a wheel that the platform accepted, for the manifest. */
export function wheelPlatformTags(filename: string): WheelTags {
  const tags = parseWheelTags(filename);
  if (!tags) throw new PrepError("platform_mismatch", `${filename.slice(0, 160)} is not a wheel`);
  return tags;
}

/** Every file must be a wheel for this platform; the first mismatch is a typed error naming all of them. */
export function assertWheelsMatchPlatform(files: readonly { name: string; filename: string }[], platform: PlatformSpec): void {
  const mismatches = files.flatMap((file) => {
    const verdict = wheelMatchesPlatform(file.filename, platform);
    return verdict.ok ? [] : [{ name: file.name, reason: verdict.reason }];
  });
  if (mismatches.length === 0) return;
  throw new PrepError(
    "platform_mismatch",
    `${mismatches.length} wheel(s) do not match ${platform.containerPlatform} / CPython ${platform.python.version}: ` +
      mismatches.slice(0, 10).map((item) => item.reason).join("; "),
    { refused: [...new Set(mismatches.map((item) => item.name))].sort() },
  );
}
