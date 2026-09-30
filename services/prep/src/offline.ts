import { posix } from "node:path";

import { PrepError } from "./errors.js";

/**
 * Commands the offline lab runs (`--network none`, image without pip) to
 * install a prepared wheelhouse. Pure argv builders: no shell is involved.
 */

export type OfflineInstallInput = {
  /** Read-only wheelhouse mount inside the lab, e.g. /workspace/case/wheels. */
  wheelhouse: string;
  /** Writable virtual environment path, e.g. /workspace/case/work/.venv. */
  venv: string;
  /** File name of the pip wheel listed in installer.json. */
  installerWheel: string;
};

const WHEEL_FILENAME = /^[A-Za-z0-9_.+!-]+\.whl$/u;

export function assertLabPath(path: string, label = "path"): string {
  if (!posix.isAbsolute(path)) throw new PrepError("invalid_requirement", `${label} must be absolute`);
  if (path.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new PrepError("invalid_requirement", `${label} must not contain . or .. segments`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/u.test(path)) throw new PrepError("invalid_requirement", `${label} must not contain whitespace`);
  const normalized = posix.normalize(path).replace(/\/+$/u, "");
  if (!normalized.startsWith("/workspace/")) throw new PrepError("invalid_requirement", `${label} must be under /workspace`);
  return normalized;
}

export function offlineInstallCommands(input: OfflineInstallInput): string[][] {
  const wheelhouse = assertLabPath(input.wheelhouse, "wheelhouse");
  const venv = assertLabPath(input.venv, "venv");
  if (!WHEEL_FILENAME.test(input.installerWheel) || !/^pip-/iu.test(input.installerWheel)) {
    throw new PrepError("invalid_requirement", "installerWheel must be a pip wheel file name");
  }
  return [
    ["python", "-m", "venv", "--without-pip", venv],
    [
      `${venv}/bin/python`,
      // A wheel is a zip archive; Python can run pip directly from it.
      `${wheelhouse}/${input.installerWheel}/pip`,
      "install",
      "--no-index",
      "--find-links",
      wheelhouse,
      "--only-binary=:all:",
      "--require-hashes",
      "--no-cache-dir",
      "--disable-pip-version-check",
      "-r",
      `${wheelhouse}/requirements.lock.txt`,
    ],
  ];
}

const INSPECT_SCRIPT = [
  "import importlib.metadata as m, json, platform, sys",
  "dists = sorted({(d.metadata['Name'] or '', d.version) for d in m.distributions()})",
  "print(json.dumps({'python': platform.python_version(), 'prefix': sys.prefix,",
  " 'distributions': [{'name': n, 'version': v} for n, v in dists]}))",
].join("\n");

export type InstalledEnvironment = { python: string; distributions: { name: string; version: string }[] };

export type InstallationReceipt = {
  ok: boolean;
  python: { expected: string; actual: string; matches: boolean };
  /** Every manifest package with what the lab reports for it. */
  packages: { name: string; expected: string; installed: string | null; sha256: string; matches: boolean }[];
  missing: string[];
  /** Installed distributions the manifest does not list. */
  unexpected: string[];
};

function normalized(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, "-");
}

/**
 * Compare what the offline lab reports (`inspectEnvironmentCommand`) with the
 * manifest: the interpreter must be the platform's Python minor version and
 * every locked package must be installed at exactly its locked version.
 */
export function installationReceipt(
  manifest: { platform: { python: { version: string } }; packages: { name: string; version: string; sha256: string }[] },
  environment: InstalledEnvironment,
): InstallationReceipt {
  const installed = new Map(environment.distributions.map((item) => [normalized(item.name), item.version]));
  const packages = manifest.packages.map((pkg) => {
    const version = installed.get(normalized(pkg.name)) ?? null;
    return { name: pkg.name, expected: pkg.version, installed: version, sha256: pkg.sha256, matches: version === pkg.version };
  });
  const locked = new Set(manifest.packages.map((pkg) => normalized(pkg.name)));
  const unexpected = [...installed.keys()].filter((name) => !locked.has(name)).sort();
  const expected = manifest.platform.python.version;
  const actual = environment.python;
  const pythonMatches = actual === expected || actual.startsWith(`${expected}.`);
  const missing = packages.filter((pkg) => pkg.installed === null).map((pkg) => pkg.name);
  return {
    ok: pythonMatches && packages.every((pkg) => pkg.matches) && unexpected.length === 0,
    python: { expected, actual, matches: pythonMatches },
    packages,
    missing,
    unexpected,
  };
}

/** Print installed distributions (importlib.metadata) and the Python version as JSON. */
export function inspectEnvironmentCommand(venv: string): string[] {
  const root = assertLabPath(venv, "venv");
  return [`${root}/bin/python`, "-c", INSPECT_SCRIPT];
}
