// Real-Docker proof of the platform-aware dependency-preparation trust zone.
//
// It uses the digest-pinned python:3.11-slim-trixie preparation image (never
// pulled; pull it once with `docker pull --platform <host> python@sha256:…`)
// and proves, for Python 3.11:
//  0. the image is found by its pinned digest even when the tag is not local
//     (the old code looked it up by tag and reported it missing);
//  1. numpy + scikit-learn (+pip) resolve and download for the host platform
//     through the egress-restricted container, every wheel validated with
//     wheelMatchesPlatform and hashed;
//  2. they install offline in a --network none container of the same
//     platform from the read-only wheelhouse, and import;
//  3. a CPU run refuses PyPI torch on linux/amd64 and on linux/arm64 (one of
//     them resolved across platforms, with markers evaluated for the target)
//     because of its nvidia-* transitive dependencies (and a directly requested
//     nvidia-cublas-cu12) with a typed evidence receipt; the in-container
//     download guard stops pip before it fetches any wheel of the set, so no
//     accelerator wheel is downloaded or left anywhere in the cache;
// 3b. the guard against the image's own pip, offline, with local wheels: a
//     CPU wheel passes, a transitive accelerator wheel is refused;
//  4. cross-platform resolution for the other architecture yields only its
//     wheels (download only, no execution);
//  5. numpy==1.19.5 has no cp311 wheel: typed no_compatible_wheel, nothing built;
//  6. egress restriction of the internal network;
//  7. a tiny temp quota refuses a larger download with
//     insufficient_preparation_space and cleans up;
//  8. cancellation mid-download cleans up;
//  9. no containers, networks or temp directories remain.
//
// In the Claude Code cloud machine outbound TLS is re-terminated by an
// intercepting proxy, so pip inside the downloader would reject every
// certificate. When /root/.ccr/ca-bundle.crt exists (or DEJAML_PREP_CA_BUNDLE
// is set) it is passed as the operator setting DEJAML_PREP_CA_BUNDLE.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, chown, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlatformSpec, hostArchitecture, platformCacheKey, wheelMatchesPlatform } from "@dejaml/contracts";
import { DockerCliRuntime } from "@dejaml/lab-manager";

import {
  DEFAULT_PREP_IMAGES,
  DependencyPreparer,
  DockerPrepImageProvider,
  PrepError,
  inspectEnvironmentCommand,
  installationReceipt,
  loadPrepPolicy,
  offlineInstallCommands,
  parseAcceleratorGuard,
  parsePinnedReference,
  pipInvocation,
  platformDigestFor,
} from "../dist/index.js";

class DockerCliImageProviderCheck extends DockerPrepImageProvider {
  constructor() {
    super(new DockerCliRuntime());
  }
}

const CA_BUNDLE = process.env.DEJAML_PREP_CA_BUNDLE ?? "/root/.ccr/ca-bundle.crt";
const LAB_WHEELS = "/workspace/case/wheels";
const LAB_VENV = "/workspace/case/work/.venv";
const PYTHON = "3.11";

const results = [];
function record(name, pass, info = "") {
  results.push({ name, pass, info });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${info ? `\n      ${info.replaceAll("\n", "\n      ")}` : ""}`);
}

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    const extra = error instanceof PrepError ? ` [${error.code}] ${error.detail ?? ""}` : "";
    record(name, false, `${error?.stack ?? error}${extra}`);
  }
}

const architecture = hostArchitecture(process.arch);
if (!architecture) throw new Error(`unsupported host architecture ${process.arch}`);
const other = architecture === "amd64" ? "arm64" : "amd64";
const host = buildPlatformSpec({ architecture, python: PYTHON });
const foreign = buildPlatformSpec({ architecture: other, python: PYTHON });
const pinned = parsePinnedReference(DEFAULT_PREP_IMAGES[PYTHON]);

const env = {};
if (existsSync(CA_BUNDLE)) env.DEJAML_PREP_CA_BUNDLE = CA_BUNDLE;
const policy = loadPrepPolicy(env);
console.log(
  `host=${host.containerPlatform} python=${PYTHON} image=${pinned.reference}\n` +
    `index=${host.packageIndex.indexUrl} hosts=${policy.allowedHosts.join(",")} ca=${policy.caBundlePath ?? "(none)"} ` +
    `quota=${policy.maxTempBytes}B/${policy.maxTempInodes} files, margin=${policy.minFreeBytes}B`,
);

const root = await mkdtemp(join(tmpdir(), "dejaml-prep-proof-"));
const workRoot = join(root, "work");
const preparer = new DependencyPreparer({ cacheDir: join(root, "cache"), workRoot, policy });
const receipts = [];
let manifest = null;

await step("orphan sweep before start", async () => {
  const sweep = await preparer.cleanupOrphans();
  record("orphan sweep before start", sweep.verifiedAbsent, JSON.stringify(sweep));
});

// (0) the pinned image is found by digest, even when its tag is not present locally.
await step("0. image readiness by digest", async () => {
  const tag = docker(["image", "inspect", "--format", "{{.Id}}", `${pinned.repository}:${pinned.tag}`]);
  const image = await new DockerCliImageProviderCheck().ensure({
    key: "proof",
    reference: pinned.reference,
    platform: host.containerPlatform,
  });
  // The other platform is either present for exactly that platform, or a typed refusal; never a runtime error.
  const foreignOutcome = await new DockerCliImageProviderCheck()
    .ensure({ key: "proof", reference: pinned.reference, platform: foreign.containerPlatform })
    .then(
      (found) => ({
        ok: found.platform.startsWith(foreign.containerPlatform),
        text: `present (${found.platform}) id ${found.imageId.slice(0, 19)}`,
      }),
      (error) => ({ ok: ["image_unavailable", "platform_mismatch"].includes(error.code), text: `${error.code}` }),
    );
  const foreignImage = foreignOutcome.text;
  const hostDigest = platformDigestFor(pinned, host.containerPlatform);
  const foreignDigest = platformDigestFor(pinned, foreign.containerPlatform);
  record(
    "0. image readiness by digest",
    image.platform === host.containerPlatform &&
      image.repoDigests.some((entry) => entry.endsWith(pinned.digest)) &&
      foreignOutcome.ok &&
      hostDigest !== null &&
      foreignDigest !== null &&
      hostDigest !== foreignDigest,
    `tag lookup ${pinned.repository}:${pinned.tag}: ${tag.code === 0 ? "present" : tag.stderr.split("\n")[0]}\n` +
      `digest lookup ${pinned.digestReference} --platform ${host.containerPlatform}: ${image.imageId.slice(0, 19)} ${image.platform}\n` +
      `${foreign.containerPlatform}: ${foreignImage}\n` +
      `platform manifests: ${host.containerPlatform} ${hostDigest} / ${foreign.containerPlatform} ${foreignDigest}`,
  );
});

function wheelsOk(pkgs, platform) {
  return pkgs.map((pkg) => ({ pkg, verdict: wheelMatchesPlatform(pkg.filename, platform) }));
}

// (1) numpy + scikit-learn for the host platform, every wheel validated.
await step(`1. resolve + download numpy, scikit-learn for ${host.containerPlatform}`, async () => {
  const started = Date.now();
  const resolution = await preparer.resolvePython({
    runId: "proof-run",
    platform: host,
    requirements: ["numpy", "scikit-learn"],
    includeInstaller: true,
  });
  receipts.push(resolution.cleanup);
  manifest = await preparer.downloadWheels(resolution, { platform: host });
  if (manifest.cleanup.download) receipts.push(manifest.cleanup.download);
  const files = await readdir(manifest.wheelhouseDir);
  const onDisk = JSON.parse(await readFile(join(manifest.wheelhouseDir, "manifest.json"), "utf8"));
  const checks = wheelsOk([...manifest.packages, manifest.installer], host);
  const pass =
    ["numpy", "scikit-learn", "scipy"].every((name) => manifest.packages.some((pkg) => pkg.name === name)) &&
    checks.every((item) => item.verdict.ok && files.includes(item.pkg.filename)) &&
    onDisk.platform.containerPlatform === host.containerPlatform &&
    onDisk.imageIdentity.digest === pinned.digest &&
    onDisk.cache.key === platformCacheKey(host) &&
    manifest.proxyLog.download.every((entry) => entry.allowed && policy.allowedHosts.includes(entry.host));
  record(
    `1. resolve + download numpy, scikit-learn for ${host.containerPlatform}`,
    pass,
    `${manifest.packages.length} packages, ${manifest.totalBytes} bytes, resolver=${manifest.resolver.mode}, image ${manifest.imageIdentity.digestReference.slice(0, 32)}… (${manifest.imageIdentity.platform}), python ${manifest.pythonVersion}, ${Date.now() - started} ms\n` +
      checks
        .map(
          ({ pkg, verdict }) =>
            `${pkg.name}==${pkg.version} [${pkg.platformTags.platform.join(".")}] sha256 ${pkg.sha256.slice(0, 12)}… wheelMatchesPlatform=${verdict.ok}`,
        )
        .join("\n") +
      `\ndisk peak=${manifest.disk.download?.peakBytes}B/${manifest.disk.download?.peakInodes} files (quota ${manifest.disk.download?.quotaBytes}B)`,
  );
});

// (2) offline install into a --network none container of the same platform.
await step("2. offline install + import (network none)", async () => {
  if (!manifest) throw new Error("no manifest from step 1");
  const workDir = join(root, "labwork");
  await mkdir(workDir);
  if (process.getuid?.() === 0) await chown(workDir, 10001, 10001);
  else await chmod(workDir, 0o777);
  const name = `dejaml-prep-proof-offline-${process.pid}`;
  const created = docker([
    "create",
    "--name",
    name,
    "--pull",
    "never",
    "--platform",
    host.containerPlatform,
    "--label",
    "dejaml.prep=proof-offline",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "10001:10001",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
    "--mount",
    `type=bind,src=${manifest.wheelhouseDir},dst=${LAB_WHEELS},readonly`,
    "--mount",
    `type=bind,src=${workDir},dst=/workspace/case/work`,
    "--env",
    "HOME=/tmp",
    "--entrypoint",
    "sleep",
    pinned.digestReference,
    "infinity",
  ]);
  if (created.code !== 0) throw new Error(created.stderr);
  try {
    docker(["start", name]);
    const outputs = [];
    const commands = [
      ...offlineInstallCommands({ wheelhouse: LAB_WHEELS, venv: LAB_VENV, installerWheel: manifest.installer.filename }),
      [`${LAB_VENV}/bin/python`, "-c", "import numpy, sklearn, scipy; print(numpy.__version__, sklearn.__version__)"],
      inspectEnvironmentCommand(LAB_VENV),
      [
        "python",
        "-c",
        "import socket\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=3); print('network reachable')\nexcept OSError as e: print('network blocked', type(e).__name__)",
      ],
      [
        "python",
        "-c",
        "import os\ntry:\n open('/workspace/case/wheels/x','w'); print('wheelhouse writable')\nexcept OSError as e: print('wheelhouse read-only', type(e).__name__)",
      ],
    ];
    let ok = true;
    for (const argv of commands) {
      const run = docker(["exec", name, ...argv]);
      outputs.push({ argv, ...run });
      if (run.code !== 0) ok = false;
    }
    const versions = outputs[2]?.stdout ?? "";
    const expected = ["numpy", "scikit-learn"].map((n) => manifest.packages.find((pkg) => pkg.name === n)?.version).join(" ");
    const receipt = installationReceipt(manifest, JSON.parse(outputs[3]?.stdout || "{}"));
    record(
      "2. offline install + import (network none)",
      ok &&
        versions === expected &&
        receipt.ok &&
        outputs[4]?.stdout.startsWith("network blocked") &&
        outputs[5]?.stdout.startsWith("wheelhouse read-only"),
      `install: ${outputs[1]?.stdout.split("\n").at(-1)}\nimport numpy, sklearn -> ${versions} (expected ${expected})\n` +
        `receipt: ok=${receipt.ok} python ${receipt.python.actual} (expected ${receipt.python.expected}), ${receipt.packages.length} packages matched, missing=[${receipt.missing}] unexpected=[${receipt.unexpected}]\n` +
        `${outputs[4]?.stdout}; ${outputs[5]?.stdout}` +
        (ok
          ? ""
          : `\n${outputs
              .filter((o) => o.code !== 0)
              .map((o) => `${o.argv.join(" ")}: ${o.stderr}`)
              .join("\n")}`),
    );
  } finally {
    docker(["rm", "--force", name]);
  }
});

// Every file name anywhere under a directory (missing directories are empty).
async function allFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) files.push(...(await allFiles(join(dir, entry.name))));
    else files.push(entry.name);
  }
  return files;
}

// (3) CPU-only: PyPI torch pulls nvidia-* on Linux; refused for both platforms before any wheel is downloaded.
await step("3. CPU-only policy refuses CUDA", async () => {
  let pass = true;
  const lines = [];
  for (const architecture of ["amd64", "arm64"]) {
    const target = buildPlatformSpec({ architecture, python: PYTHON });
    let line = "not refused";
    let ok = false;
    try {
      const resolution = await preparer.resolvePython({ runId: `proof-torch-${architecture}`, platform: target, requirements: ["torch"] });
      receipts.push(resolution.cleanup);
    } catch (error) {
      if (!(error instanceof PrepError)) throw error;
      if (error.cleanup) receipts.push(error.cleanup);
      const nvidia = error.refused.filter((name) => name.startsWith("nvidia-"));
      const evidence = error.evidence;
      line =
        `code=${error.code} refused=${error.refused.length} (${error.refused.slice(0, 6).join(", ")}${error.refused.length > 6 ? ", …" : ""}) ` +
        `evidence=${evidence ? `${evidence.stage}/${evidence.resolverMode} for ${evidence.platform}, image ${evidence.image?.platform} ${evidence.image?.platformDigest?.slice(0, 19)}…, wheelsDownloaded=${evidence.wheelsDownloaded}` : "none"} ` +
        `cleanup=${error.cleanup?.verifiedAbsent}` +
        (error.code === "accelerator_package_refused"
          ? ""
          : `\n  ${error.message}\n  ${(error.detail ?? "").split("\n").slice(-4).join("\n  ")}`);
      ok =
        error.code === "accelerator_package_refused" &&
        nvidia.length > 0 &&
        error.cleanup?.verifiedAbsent === true &&
        evidence?.kind === "accelerator_refusal" &&
        // Refused by the guard before pip downloaded any wheel of the set.
        evidence.stage === "download_guard" &&
        evidence.platform === target.containerPlatform &&
        evidence.platformKey === platformCacheKey(target) &&
        evidence.wheelsDownloaded === 0 &&
        evidence.image !== null &&
        evidence.image.platformDigest === platformDigestFor(pinned, evidence.image.platform);
    }
    pass = pass && ok;
    lines.push(`torch for ${target.containerPlatform} (transitive): ${line}`);
  }
  let direct = "not refused";
  try {
    await preparer.resolvePython({ runId: "proof-cublas", platform: host, requirements: ["nvidia-cublas-cu12"] });
  } catch (error) {
    if (!(error instanceof PrepError)) throw error;
    direct = `code=${error.code} refused=${error.refused.join(",")} containers started=${error.cleanup ? "yes" : "no"}`;
    pass = pass && error.code === "accelerator_package_refused" && error.cleanup === undefined;
  }
  const cachedAccelerator = (await allFiles(join(root, "cache"))).filter((file) =>
    /^(nvidia|torch|triton|cuda|pytorch_triton)/iu.test(file),
  );
  record(
    "3. CPU-only policy refuses CUDA",
    pass && cachedAccelerator.length === 0,
    `${lines.join("\n")}\nnvidia-cublas-cu12 (direct): ${direct}\naccelerator wheels in cache: ${cachedAccelerator.length}`,
  );
});

// (3b) the download guard against the image's real pip, offline, with two tiny local wheels.
await step("3b. download guard (offline, local wheels)", async () => {
  const wheelDir = join(root, "guard-wheels");
  await mkdir(wheelDir);
  // Minimal wheels written with the image's own zipfile module (no network, nothing executed from them).
  const make = [
    "import sys, zipfile",
    "def wheel(name, version, requires=()):",
    "    info = f'{name}-{version}.dist-info'",
    "    with zipfile.ZipFile(f'/w/{name}-{version}-py3-none-any.whl', 'w') as z:",
    "        z.writestr(f'{info}/METADATA', f'Metadata-Version: 2.1\\nName: {name}\\nVersion: {version}\\n' + ''.join(f'Requires-Dist: {r}\\n' for r in requires))",
    "        z.writestr(f'{info}/WHEEL', 'Wheel-Version: 1.0\\nGenerator: proof\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')",
    "        z.writestr(f'{info}/RECORD', '')",
    "wheel('cpuonly', '1.0')",
    "wheel('gpuish', '1.0', ['nvidia-cublas-cu12'])",
    "wheel('nvidia_cublas_cu12', '12.1.0')",
  ].join("\n");
  await writeFile(join(wheelDir, "make.py"), make);
  if (process.getuid?.() === 0) await chown(wheelDir, 65534, 65534);
  const base = [
    "run",
    "--rm",
    "--label",
    "dejaml.prep=proof-guard",
    "--pull",
    "never",
    "--platform",
    host.containerPlatform,
    "--network",
    "none",
  ];
  const hardening = [
    "--user",
    process.getuid?.() === 0 ? "65534:65534" : `${process.getuid()}:${process.getgid()}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
  ];
  const built = docker([
    ...base,
    ...hardening,
    "--mount",
    `type=bind,src=${wheelDir},dst=/w`,
    "--entrypoint",
    "python",
    pinned.digestReference,
    "/w/make.py",
  ]);
  if (built.code !== 0) throw new Error(built.stderr);
  const pip = (requirement) =>
    docker([
      ...base,
      ...hardening,
      "--mount",
      `type=bind,src=${wheelDir},dst=/w,readonly`,
      "--workdir",
      "/tmp",
      "--entrypoint",
      "python",
      pinned.digestReference,
      ...pipInvocation("native", host),
      "install",
      "--dry-run",
      "--ignore-installed",
      "--only-binary=:all:",
      "--no-index",
      "--find-links",
      "/w",
      "--report",
      "/tmp/report.json",
      requirement,
    ]);
  const cpu = pip("cpuonly");
  const gpu = pip("gpuish");
  const refused = parseAcceleratorGuard(gpu.stderr) ?? [];
  record(
    "3b. download guard (offline, local wheels)",
    cpu.code === 0 &&
      /Would install cpuonly-1\.0/u.test(cpu.stdout) &&
      gpu.code === 3 &&
      refused.map((item) => item.name).join(",") === "nvidia-cublas-cu12",
    `cpuonly: exit ${cpu.code} (${cpu.stdout.split("\n").at(-1)})\ngpuish -> nvidia-cublas-cu12: exit ${gpu.code}, guard refused [${refused.map((item) => item.spec).join(", ")}]`,
  );
});

// (4) cross-platform: the other architecture's wheels only, never the host's.
await step(`4. cross-platform resolution for ${foreign.containerPlatform}`, async () => {
  const resolution = await preparer.resolvePython({ runId: "proof-foreign", platform: foreign, requirements: ["numpy", "scikit-learn"] });
  receipts.push(resolution.cleanup);
  const foreignManifest = await preparer.downloadWheels(resolution, { platform: foreign });
  if (foreignManifest.cleanup.download) receipts.push(foreignManifest.cleanup.download);
  const machine = other === "arm64" ? "aarch64" : "x86_64";
  const hostMachine = other === "arm64" ? "x86_64" : "aarch64";
  const checks = wheelsOk(foreignManifest.packages, foreign);
  const tags = foreignManifest.packages.flatMap((pkg) => pkg.platformTags.platform);
  const pass =
    checks.every((item) => item.verdict.ok) &&
    tags.every((tag) => tag === "any" || tag.endsWith(machine)) &&
    !tags.some((tag) => tag.includes(hostMachine)) &&
    foreignManifest.cache.key === platformCacheKey(foreign) &&
    foreignManifest.cache.key !== platformCacheKey(host) &&
    foreignManifest.imageIdentity.platformDigest === platformDigestFor(pinned, foreignManifest.imageIdentity.platform);
  record(
    `4. cross-platform resolution for ${foreign.containerPlatform}`,
    pass,
    `resolver=${foreignManifest.resolver.mode} (engine ${foreignManifest.resolver.enginePlatform}, containers ${foreignManifest.imageIdentity.platform}), cache key ${foreignManifest.cache.key}\n` +
      checks.map(({ pkg, verdict }) => `${pkg.filename} wheelMatchesPlatform=${verdict.ok}`).join("\n"),
  );
});

// (5) no cp311 wheel for numpy 1.19.5: typed failure, nothing built.
await step("5. numpy==1.19.5 -> no_compatible_wheel", async () => {
  try {
    const resolution = await preparer.resolvePython({ runId: "proof-run", platform: host, requirements: ["numpy==1.19.5"] });
    receipts.push(resolution.cleanup);
    record("5. numpy==1.19.5 -> no_compatible_wheel", false, "unexpectedly resolved");
  } catch (error) {
    if (!(error instanceof PrepError)) throw error;
    if (error.cleanup) receipts.push(error.cleanup);
    const built = /Building wheel|setup\.py|Preparing metadata|Getting requirements to build/u.test(error.detail ?? "");
    record(
      "5. numpy==1.19.5 -> no_compatible_wheel",
      error.code === "no_compatible_wheel" && error.requirement === "numpy" && !built && error.cleanup?.verifiedAbsent === true,
      `code=${error.code} requirement=${error.requirement} built_from_source=${built}`,
    );
  }
});

// (6) egress restriction from the internal network.
await step("6. egress restriction", async () => {
  const probe = await preparer.probeEgress({ runId: "proof-run", platform: host });
  receipts.push(probe.cleanup);
  const r = probe.results;
  const pass =
    String(r["direct 1.1.1.1:443"]).startsWith("blocked") &&
    String(r["dns example.com"]).startsWith("blocked") &&
    String(r["CONNECT example.com:443"]).includes("403") &&
    String(r["CONNECT pypi.org:80"]).includes("403") &&
    String(r["CONNECT 1.1.1.1:443"]).includes("403") &&
    String(r["CONNECT 169.254.169.254:443"]).includes("403") &&
    String(r["CONNECT pypi.org:443"]).includes("200");
  record(
    "6. egress restriction",
    pass,
    Object.entries(r)
      .map(([key, value]) => `${key} -> ${value}`)
      .join("\n"),
  );
});

// (7) a tiny temp quota: the download is refused as insufficient_preparation_space and cleaned up.
await step("7. temp quota -> insufficient_preparation_space", async () => {
  const tinyRoot = join(root, "tiny");
  const tiny = new DependencyPreparer({
    cacheDir: join(tinyRoot, "cache"),
    workRoot: join(tinyRoot, "work"),
    policy: loadPrepPolicy({ ...env, DEJAML_PREP_MAX_TEMP_MB: "4" }),
  });
  const resolution = await preparer.resolvePython({ runId: "proof-quota", platform: host, requirements: ["numpy"] });
  receipts.push(resolution.cleanup);
  const size = manifest?.packages.find((pkg) => pkg.name === "numpy")?.bytes ?? 0;
  try {
    await tiny.downloadWheels(resolution);
    record("7. temp quota -> insufficient_preparation_space", false, "download unexpectedly fit");
  } catch (error) {
    if (!(error instanceof PrepError)) throw error;
    if (error.cleanup) receipts.push(error.cleanup);
    const temps = await readdir(join(tinyRoot, "work")).catch(() => []);
    const cached = await readdir(join(tinyRoot, "cache", "wheels", platformCacheKey(host))).catch(() => []);
    record(
      "7. temp quota -> insufficient_preparation_space",
      error.code === "insufficient_preparation_space" &&
        error.cleanup?.tempRemoved === true &&
        error.cleanup.verifiedAbsent &&
        temps.length === 0 &&
        cached.length === 0,
      `numpy wheel ${size} B vs 4 MiB quota: code=${error.code} "${error.message}"\ntemp dirs left=${temps.length} cached wheels=${cached.length}`,
    );
  }
});

// (8) cancellation in the middle of a download.
await step("8. cancellation mid-download", async () => {
  const cancelRoot = join(root, "cancel");
  const fresh = new DependencyPreparer({ cacheDir: join(cancelRoot, "cache"), workRoot: join(cancelRoot, "work"), policy });
  const resolution = await preparer.resolvePython({ runId: "proof-cancel", platform: host, requirements: ["scipy", "scikit-learn"] });
  receipts.push(resolution.cleanup);
  const controller = new AbortController();
  let sawDownload = false;
  const timer = setInterval(() => {
    const running = docker(["ps", "--filter", "label=dejaml.run=proof-cancel", "--format", "{{.Names}}"]).stdout;
    if (/-download$/mu.test(running)) {
      sawDownload = true;
      setTimeout(() => controller.abort(), 1000);
      clearInterval(timer);
    }
  }, 200);
  try {
    await fresh.downloadWheels(resolution, { signal: controller.signal });
    record("8. cancellation mid-download", false, "download finished before the abort fired");
  } catch (error) {
    if (!(error instanceof PrepError)) throw error;
    if (error.cleanup) receipts.push(error.cleanup);
    const temps = await readdir(join(cancelRoot, "work")).catch(() => []);
    record(
      "8. cancellation mid-download",
      sawDownload &&
        error.code === "cancelled" &&
        error.cleanup?.verifiedAbsent === true &&
        error.cleanup.tempRemoved &&
        temps.length === 0,
      `downloader seen running=${sawDownload} code=${error.code} cleanup=${JSON.stringify(error.cleanup)} temp dirs left=${temps.length}`,
    );
  } finally {
    clearInterval(timer);
  }
});

// (9) nothing labelled dejaml.prep remains; temp dirs are gone.
await step("9. cleanup", async () => {
  const containers = docker(["ps", "--all", "--filter", "label=dejaml.prep", "--format", "{{.Names}}"]).stdout;
  const networks = docker(["network", "ls", "--filter", "label=dejaml.prep", "--format", "{{.Name}}"]).stdout;
  const temps = await readdir(workRoot).catch(() => []);
  const receiptsOk = receipts.every((r) => r.networkRemoved && r.tempRemoved && r.verifiedAbsent);
  record(
    "9. cleanup",
    containers === "" && networks === "" && temps.length === 0 && receiptsOk,
    `containers=[${containers}] networks=[${networks}] tempDirs=[${temps.join(",")}] receipts=${receipts.length} all verified=${receiptsOk}`,
  );
});

// Remove the proof's own cache and wheelhouses (wheelhouses are 0555/0444).
async function unlock(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) {
      await chmod(join(dir, entry.name), 0o755).catch(() => undefined);
      await unlock(join(dir, entry.name));
    }
  }
}
await unlock(root);
await rm(root, { recursive: true, force: true });
console.log(`proof root removed: ${!existsSync(root)}`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
