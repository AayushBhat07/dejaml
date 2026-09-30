import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PrepError } from "./errors.js";
import { DEFAULT_PACKAGE_INDEX } from "@dejaml/contracts";

import { DEFAULT_PREP_IMAGES, DEFAULT_PREP_POLICY, effectivePackageIndex, loadPrepPolicy } from "./policy.js";
import { classifyPipFailure, parsePipReport, parseProxyLog, parseWheelFilename } from "./report.js";
import { inspectEnvironmentCommand, offlineInstallCommands } from "./offline.js";
import { DEFAULT_PROXY_SCRIPT_PATH } from "./downloader.js";

const SHA = "d".repeat(64);

function item(name: string, version: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    metadata: { name, version, metadata_version: "2.1" },
    download_info: { url, archive_info: { hash: `sha256=${SHA}`, hashes: { sha256: SHA } } },
    is_direct: false,
    requested: false,
    ...extra,
  };
}

function report(install: unknown[]) {
  return { version: "1", pip_version: "26.2", install, environment: { python_full_version: "3.13.15", platform_machine: "x86_64" } };
}

const MPL = "https://files.pythonhosted.org/packages/aa/bb/matplotlib-3.11.2-cp313-cp313-manylinux_2_27_x86_64.whl";
const DATEUTIL = "https://files.pythonhosted.org/packages/cc/python_dateutil-2.9.0.post0-py2.py3-none-any.whl";

describe("parsePipReport", () => {
  it("accepts allowlisted wheels with hashes", () => {
    const parsed = parsePipReport(
      report([item("matplotlib", "3.11.2", MPL, { requested: true }), item("python-dateutil", "2.9.0.post0", DATEUTIL)]),
      DEFAULT_PREP_POLICY,
    );
    expect(parsed.pythonVersion).toBe("3.13.15");
    expect(parsed.packages).toEqual([
      { name: "matplotlib", version: "3.11.2", filename: "matplotlib-3.11.2-cp313-cp313-manylinux_2_27_x86_64.whl", url: MPL, sha256: SHA, requested: true },
      { name: "python-dateutil", version: "2.9.0.post0", filename: "python_dateutil-2.9.0.post0-py2.py3-none-any.whl", url: DATEUTIL, sha256: SHA, requested: false },
    ]);
  });

  it("falls back to the legacy hash field", () => {
    const entry = item("six", "1.17.0", "https://files.pythonhosted.org/six-1.17.0-py2.py3-none-any.whl");
    entry.download_info.archive_info = { hash: `sha256=${SHA}` } as never;
    expect(parsePipReport(report([entry]), DEFAULT_PREP_POLICY).packages[0]?.sha256).toBe(SHA);
  });

  it("rejects a URL on a host that is not allowlisted", () => {
    expect(() =>
      parsePipReport(report([item("six", "1.17.0", "https://evil.example/six-1.17.0-py2.py3-none-any.whl")]), DEFAULT_PREP_POLICY),
    ).toThrow(expect.objectContaining({ code: "egress_denied" }));
  });

  it("rejects plain http", () => {
    expect(() =>
      parsePipReport(report([item("six", "1.17.0", "http://files.pythonhosted.org/six-1.17.0-py2.py3-none-any.whl")]), DEFAULT_PREP_POLICY),
    ).toThrow(PrepError);
  });

  it("rejects sdists", () => {
    expect(() =>
      parsePipReport(report([item("numpy", "1.19.5", "https://files.pythonhosted.org/numpy-1.19.5.tar.gz")]), DEFAULT_PREP_POLICY),
    ).toThrow(expect.objectContaining({ code: "no_compatible_wheel" }));
  });

  it("rejects wheels whose file name does not match the metadata", () => {
    expect(() =>
      parsePipReport(report([item("six", "1.17.0", "https://files.pythonhosted.org/evil-1.0-py3-none-any.whl")]), DEFAULT_PREP_POLICY),
    ).toThrow(/does not match/u);
  });

  it("rejects direct references and missing hashes", () => {
    const direct = item("six", "1.17.0", "https://files.pythonhosted.org/six-1.17.0-py2.py3-none-any.whl", { is_direct: true });
    expect(() => parsePipReport(report([direct]), DEFAULT_PREP_POLICY)).toThrow(/direct/u);
    const unhashed = item("six", "1.17.0", "https://files.pythonhosted.org/six-1.17.0-py2.py3-none-any.whl");
    unhashed.download_info.archive_info = {} as never;
    expect(() => parsePipReport(report([unhashed]), DEFAULT_PREP_POLICY)).toThrow(/sha256/u);
  });

  it("enforces maxPackages", () => {
    const many = Array.from({ length: 4 }, (_, index) =>
      item(`pkg${index}`, "1.0", `https://files.pythonhosted.org/pkg${index}-1.0-py3-none-any.whl`),
    );
    expect(() => parsePipReport(report(many), { ...DEFAULT_PREP_POLICY, maxPackages: 3 })).toThrow(
      expect.objectContaining({ code: "limit_exceeded" }),
    );
  });

  it("rejects malformed reports", () => {
    expect(() => parsePipReport({ install: "nope" }, DEFAULT_PREP_POLICY)).toThrow(PrepError);
  });

  it("parses wheel file names", () => {
    expect(parseWheelFilename("Keras_Preprocessing-1.1.2-py2.py3-none-any.whl")).toEqual({ name: "keras-preprocessing", version: "1.1.2" });
    expect(parseWheelFilename("foo-1.0-1-py3-none-any.whl")).toEqual({ name: "foo", version: "1.0" });
    expect(parseWheelFilename("../evil.whl")).toBeNull();
  });
});

describe("classifyPipFailure", () => {
  it("maps a missing wheel to no_compatible_wheel with the requirement name", () => {
    const stderr = [
      "ERROR: Could not find a version that satisfies the requirement numpy==1.19.5 (from versions: 2.1.0, 2.1.1)",
      "ERROR: No matching distribution found for numpy==1.19.5",
    ].join("\n");
    const error = classifyPipFailure({ stderr, proxyLog: [], exitCode: 1 });
    expect(error.code).toBe("no_compatible_wheel");
    expect(error.requirement).toBe("numpy");
    expect(error.message).toMatch(/explicit approval or a prebuilt/u);
    expect(error.message).toMatch(/never built/u);
    expect(error.detail).toContain("No matching distribution");
  });

  it("maps ResolutionImpossible to resolution_conflict", () => {
    const stderr = "ERROR: Cannot install a==1 and b==2 because these package versions have conflicting dependencies.\nERROR: ResolutionImpossible: for help visit ...";
    expect(classifyPipFailure({ stderr, proxyLog: [], exitCode: 1 }).code).toBe("resolution_conflict");
  });

  it("maps a denied proxy connection to egress_denied", () => {
    const proxyLog = parseProxyLog('{"event":"listening"}\n{"event":"connect","host":"evil.example","allowed":false,"reason":"host_not_allowed"}\nnoise\n');
    const error = classifyPipFailure({ stderr: "ProxyError('Cannot connect to proxy.')", proxyLog, exitCode: 1 });
    expect(error.code).toBe("egress_denied");
    expect(error.message).toContain("evil.example (host_not_allowed)");
  });

  it("maps budget exhaustion and OOM to limit_exceeded", () => {
    expect(classifyPipFailure({ stderr: "", proxyLog: [{ event: "budget_exceeded" }], exitCode: 1 }).code).toBe("limit_exceeded");
    expect(classifyPipFailure({ stderr: "", proxyLog: [], exitCode: 137, oomKilled: true }).code).toBe("limit_exceeded");
  });

  it("keeps only the last 4 KB of stderr and falls back to runtime_error", () => {
    const error = classifyPipFailure({ stderr: `${"x".repeat(10_000)}END`, proxyLog: [], exitCode: 2 });
    expect(error.code).toBe("runtime_error");
    expect(Buffer.byteLength(error.detail ?? "")).toBe(4096);
    expect(error.detail?.endsWith("END")).toBe(true);
  });
});

describe("loadPrepPolicy", () => {
  it("uses safe defaults", () => {
    expect(loadPrepPolicy({})).toEqual({
      images: DEFAULT_PREP_IMAGES,
      expectedImageIds: {},
      pullImages: false,
      resolverMode: "auto",
      allowedHosts: ["pypi.org", "files.pythonhosted.org"],
      maxPackages: 150,
      maxFileBytes: 1024 * 1024 * 1024,
      maxTotalBytes: 3 * 1024 * 1024 * 1024,
      maxTempBytes: 6 * 1024 * 1024 * 1024,
      maxTempInodes: 200_000,
      minFreeBytes: 1024 * 1024 * 1024,
      diskPollMs: 1000,
      timeoutSeconds: 600,
      cpus: 2,
      memoryMb: 2048,
      pids: 256,
    });
    for (const [version, image] of Object.entries(DEFAULT_PREP_IMAGES)) {
      expect(image).toMatch(new RegExp(`^python:${version.replace(".", "\\.")}-slim-trixie@sha256:[a-f0-9]{64}$`, "u"));
    }
  });

  it("reads every supported variable", () => {
    const pinned = `python:3.12-slim-trixie@sha256:${"c".repeat(64)}`;
    const policy = loadPrepPolicy({
      DEJAML_PREP_IMAGE: pinned,
      DEJAML_PREP_IMAGE_ID: `sha256:${"e".repeat(64)}`,
      DEJAML_PREP_IMAGES: `3.10=registry.example.org/python:3.10-slim-trixie@sha256:${"f".repeat(64)}`,
      DEJAML_PREP_PULL: "1",
      DEJAML_PREP_RESOLVER_MODE: "native",
      DEJAML_PREP_INDEX_URL: "https://mirror.example.org/simple",
      DEJAML_PREP_ALLOWED_HOSTS: "mirror.example.org, Files.Mirror.example.org",
      DEJAML_PREP_MAX_PACKAGES: "20",
      DEJAML_PREP_MAX_FILE_MB: "50",
      DEJAML_PREP_MAX_TOTAL_MB: "100",
      DEJAML_PREP_MAX_TEMP_MB: "300",
      DEJAML_PREP_MAX_TEMP_INODES: "5000",
      DEJAML_PREP_MIN_FREE_MB: "256",
      DEJAML_PREP_CA_BUNDLE: "/etc/ssl/corp.pem",
    });
    expect(policy).toMatchObject({
      images: { ...DEFAULT_PREP_IMAGES, "3.12": pinned, "3.10": `registry.example.org/python:3.10-slim-trixie@sha256:${"f".repeat(64)}` },
      expectedImageIds: { "3.12": `sha256:${"e".repeat(64)}` },
      pullImages: true,
      resolverMode: "native",
      indexUrl: "https://mirror.example.org/simple",
      allowedHosts: ["mirror.example.org", "files.mirror.example.org"],
      maxPackages: 20,
      maxFileBytes: 50 * 1024 * 1024,
      maxTotalBytes: 100 * 1024 * 1024,
      maxTempBytes: 300 * 1024 * 1024,
      maxTempInodes: 5000,
      minFreeBytes: 256 * 1024 * 1024,
      caBundlePath: "/etc/ssl/corp.pem",
    });
  });

  it("maps the legacy unpinned DEJAML_PREP_IMAGE to the pinned image of the same Python line", () => {
    const policy = loadPrepPolicy({ DEJAML_PREP_IMAGE: "python:3.13.15-slim-trixie" });
    expect(policy.images["3.13"]).toBe(DEFAULT_PREP_IMAGES["3.13"]);
  });

  it.each([
    [{ DEJAML_PREP_INDEX_URL: "http://pypi.org/simple" }, /https/u],
    [{ DEJAML_PREP_INDEX_URL: "https://user:pw@pypi.org/simple" }, /credentials/u],
    [{ DEJAML_PREP_INDEX_URL: "https://other.example.org/simple" }, /allowedHosts/u],
    [{ DEJAML_PREP_ALLOWED_HOSTS: "pypi.org,1.2.3.4" }, /DNS names/u],
    [{ DEJAML_PREP_ALLOWED_HOSTS: "pypi.org,*.evil.com" }, /DNS names/u],
    [{ DEJAML_PREP_MAX_PACKAGES: "-1" }, /positive integer/u],
    [{ DEJAML_PREP_CA_BUNDLE: "relative.pem" }, /absolute/u],
    [{ DEJAML_PREP_IMAGE: "--privileged" }, /DEJAML_PREP_IMAGE/u],
    [{ DEJAML_PREP_IMAGE: "python:3.12-slim" }, /DEJAML_PREP_IMAGE/u],
    [{ DEJAML_PREP_IMAGES: "3.11=python:3.11-slim-trixie" }, /pinned by digest/u],
    [{ DEJAML_PREP_IMAGES: "3.9=python:3.9@sha256:" + "a".repeat(64) }, /DEJAML_PREP_IMAGES/u],
    [{ DEJAML_PREP_IMAGE_ID: "abc" }, /DEJAML_PREP_IMAGE/u],
    [{ DEJAML_PREP_IMAGE: "python:3.13-slim-trixie", DEJAML_PREP_IMAGE_ID: "abc" }, /expectedImageIds/u],
    [{ DEJAML_PREP_PULL: "maybe" }, /DEJAML_PREP_PULL/u],
    [{ DEJAML_PREP_RESOLVER_MODE: "cuda" }, /resolverMode/u],
  ])("rejects %j", (env, message) => {
    expect(() => loadPrepPolicy(env)).toThrow(message);
  });
});

describe("effectivePackageIndex", () => {
  it("uses the platform's profile within the administrator's host allowlist", () => {
    expect(effectivePackageIndex(DEFAULT_PREP_POLICY, DEFAULT_PACKAGE_INDEX)).toEqual({
      indexUrl: "https://pypi.org/simple",
      allowedHosts: ["pypi.org", "files.pythonhosted.org"],
    });
    const mirror = { id: "mirror", indexUrl: "https://mirror.example.org/simple", allowedHosts: ["mirror.example.org"], cpuOnly: true as const };
    expect(() => effectivePackageIndex(DEFAULT_PREP_POLICY, mirror)).toThrow(/does not/u);
    const policy = loadPrepPolicy({ DEJAML_PREP_ALLOWED_HOSTS: "mirror.example.org,pypi.org", DEJAML_PREP_INDEX_URL: "https://pypi.org/simple" });
    expect(() => effectivePackageIndex(policy, mirror)).toThrow(/requires https:\/\/pypi\.org\/simple/u);
    expect(() => effectivePackageIndex(DEFAULT_PREP_POLICY, { ...DEFAULT_PACKAGE_INDEX, allowedHosts: ["files.pythonhosted.org"] })).toThrow(/index host/u);
  });
});

describe("offline commands", () => {
  it("builds the offline install argv", () => {
    expect(
      offlineInstallCommands({
        wheelhouse: "/workspace/case/wheels",
        venv: "/workspace/case/work/.venv",
        installerWheel: "pip-26.2.1-py3-none-any.whl",
      }),
    ).toEqual([
      ["python", "-m", "venv", "--without-pip", "/workspace/case/work/.venv"],
      [
        "/workspace/case/work/.venv/bin/python",
        "/workspace/case/wheels/pip-26.2.1-py3-none-any.whl/pip",
        "install",
        "--no-index",
        "--find-links",
        "/workspace/case/wheels",
        "--only-binary=:all:",
        "--require-hashes",
        "--no-cache-dir",
        "--disable-pip-version-check",
        "-r",
        "/workspace/case/wheels/requirements.lock.txt",
      ],
    ]);
  });

  it.each([
    [{ wheelhouse: "wheels" }, /absolute/u],
    [{ wheelhouse: "/workspace/case/../../etc" }, /\.\./u],
    [{ venv: "/tmp/venv" }, /under \/workspace/u],
    [{ venv: "/workspace/a b" }, /whitespace/u],
    [{ installerWheel: "../pip-1-py3-none-any.whl" }, /pip wheel/u],
    [{ installerWheel: "evil-1.0-py3-none-any.whl" }, /pip wheel/u],
  ])("rejects %j", (override, message) => {
    const input = {
      wheelhouse: "/workspace/case/wheels",
      venv: "/workspace/case/work/.venv",
      installerWheel: "pip-26.2.1-py3-none-any.whl",
      ...override,
    };
    expect(() => offlineInstallCommands(input)).toThrow(message);
  });

  it("builds the environment inspection command", () => {
    const argv = inspectEnvironmentCommand("/workspace/case/work/.venv");
    expect(argv.slice(0, 2)).toEqual(["/workspace/case/work/.venv/bin/python", "-c"]);
    expect(argv[2]).toContain("importlib.metadata");
    expect(argv[2]).toContain("python_version()");
    expect(() => inspectEnvironmentCommand("/etc")).toThrow(PrepError);
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("egress proxy (in-process, fake DNS, no network)", () => {
  it("denies everything except CONNECT to allowlisted hosts with global addresses", () => {
    const harness = fileURLToPath(new URL("./__fixtures__/proxy_harness.py", import.meta.url));
    const run = spawnSync("python3", [harness, DEFAULT_PROXY_SCRIPT_PATH], { encoding: "utf8", timeout: 20_000 });
    expect(run.status, run.stderr).toBe(0);
    const { responses, logs } = JSON.parse(run.stdout) as {
      responses: Record<string, string>;
      logs: { event: string; host?: string; ip?: string; allowed?: boolean; reason?: string }[];
    };
    for (const name of ["plain_get", "other_port", "ip_literal", "ipv6_literal", "shorthand_ip", "unknown_host", "private_answer", "metadata_answer"]) {
      expect(responses[name], name).toBe("HTTP/1.1 403 Forbidden");
    }
    expect(responses.allowed_upstream_down).toBe("HTTP/1.1 502 Bad Gateway");
    const reasons = logs.filter((entry) => entry.event === "connect").map((entry) => [entry.host, entry.allowed, entry.reason]);
    expect(reasons).toEqual([
      ["http://pypi.org/", false, "method_not_allowed"],
      ["pypi.org", false, "port_not_allowed"],
      ["1.1.1.1", false, "ip_literal"],
      ["[::1]", false, "ip_literal"],
      ["127.1", false, "ip_literal"],
      ["evil.pypi-mirror.test", false, "host_not_allowed"],
      ["files.pythonhosted.org", false, "non_global_address"],
      ["metadata.example", false, "non_global_address"],
      ["pypi.org", true, "upstream_connect_failed"],
    ]);
    expect(logs.at(-1)).toEqual({ event: "budget_exceeded", used: 2000, budget: 1000 });
  });

  it("refuses to start with an IP literal in the allowlist", () => {
    const run = spawnSync("python3", [DEFAULT_PROXY_SCRIPT_PATH, "--allow", "10.0.0.1", "--budget-bytes", "10"], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("invalid allowed host");
  });
});
