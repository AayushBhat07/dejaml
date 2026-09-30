// Real-Docker proof of the dependency-preparation trust zone.
//
// It uses the locally present python:3.13.15-slim-trixie image (never pulled)
// and proves: resolve + hash-verified download of matplotlib and pip; a
// typed no_compatible_wheel failure without building from source; egress
// restriction of the internal network; an offline, read-only lab install from
// the wheelhouse; the verified-cache path; cancellation; and full cleanup.
//
// In the Claude Code cloud machine outbound TLS is re-terminated by an
// intercepting proxy, so pip inside the downloader would reject every
// certificate. When /root/.ccr/ca-bundle.crt exists it is passed as the
// operator setting DEJAML_PREP_CA_BUNDLE (mounted read-only as PIP_CERT). On
// a normal network this file does not exist and nothing extra is trusted.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, chown, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DependencyPreparer,
  PrepError,
  inspectEnvironmentCommand,
  loadPrepPolicy,
  offlineInstallCommands,
} from "../dist/index.js";

const IMAGE = "python:3.13.15-slim-trixie";
const CA_BUNDLE = "/root/.ccr/ca-bundle.crt";
const LAB_WHEELS = "/workspace/case/wheels";
const LAB_VENV = "/workspace/case/work/.venv";

const results = [];
function record(name, pass, info = "") {
  results.push({ name, pass, info });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${info ? `\n      ${info.replaceAll("\n", "\n      ")}` : ""}`);
}

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    const extra = error instanceof PrepError ? ` [${error.code}] ${error.detail ?? ""}` : "";
    record(name, false, `${error?.stack ?? error}${extra}`);
  }
}

const env = { DEJAML_PREP_IMAGE: IMAGE };
if (existsSync(CA_BUNDLE)) env.DEJAML_PREP_CA_BUNDLE = CA_BUNDLE;
const policy = loadPrepPolicy(env);
console.log(`policy: image=${policy.image} index=${policy.indexUrl} hosts=${policy.allowedHosts.join(",")} ca=${policy.caBundlePath ?? "(none)"}`);

const root = await mkdtemp(join(tmpdir(), "dejaml-prep-proof-"));
const cacheDir = join(root, "cache");
const workRoot = join(root, "work");
const preparer = new DependencyPreparer({ cacheDir, workRoot, policy });
const receipts = [];
let manifest = null;

await step("orphan sweep before start", async () => {
  const sweep = await preparer.cleanupOrphans();
  record("orphan sweep before start", sweep.verifiedAbsent, JSON.stringify(sweep));
});

// (1) resolve + download matplotlib and the pip installer, every hash verified.
await step("1. resolve + download matplotlib (+pip installer)", async () => {
  const started = Date.now();
  const resolution = await preparer.resolvePython({ runId: "proof-run", requirements: ["matplotlib"], includeInstaller: true });
  receipts.push(resolution.cleanup);
  manifest = await preparer.downloadWheels(resolution);
  if (manifest.cleanup.download) receipts.push(manifest.cleanup.download);
  const files = await readdir(manifest.wheelhouseDir);
  const lock = await readFile(join(manifest.wheelhouseDir, "requirements.lock.txt"), "utf8");
  const onDisk = JSON.parse(await readFile(join(manifest.wheelhouseDir, "manifest.json"), "utf8"));
  const allWheels = [...manifest.packages, manifest.installer].every((pkg) => files.includes(pkg.filename));
  const lockHasHashes = lock.trim().split("\n").every((line) => /^[a-z0-9-]+==\S+ --hash=sha256:[a-f0-9]{64}$/u.test(line));
  const pass =
    manifest.packages.some((pkg) => pkg.name === "matplotlib" && pkg.requested) &&
    manifest.installer?.name === "pip" &&
    allWheels &&
    lockHasHashes &&
    !/^pip==/mu.test(lock) &&
    onDisk.packages.length === manifest.packages.length &&
    manifest.proxyLog.download.every((entry) => entry.allowed && ["pypi.org", "files.pythonhosted.org"].includes(entry.host));
  const summary = manifest.packages.map((pkg) => `${pkg.name}==${pkg.version} (${pkg.bytes} B, sha256 ${pkg.sha256.slice(0, 12)}…)`).join("\n");
  record(
    "1. resolve + download matplotlib (+pip installer)",
    pass,
    `${manifest.packages.length} packages, ${manifest.totalBytes} bytes, installer ${manifest.installer?.filename}, image ${manifest.imageId.slice(0, 19)}, python ${manifest.pythonVersion}, ${Date.now() - started} ms\n` +
      `${summary}\nproxy connections: resolve=${manifest.proxyLog.resolve.length} download=${manifest.proxyLog.download.length} ` +
      `(${[...manifest.proxyLog.resolve, ...manifest.proxyLog.download].map((e) => `${e.host}:${e.allowed ? "allowed" : "DENIED"}:${e.bytes_down}B`).join(", ")})`,
  );
});

// (2) numpy==1.19.5 has no cp313 wheel: typed failure, nothing built.
await step("2. numpy==1.19.5 -> no_compatible_wheel", async () => {
  try {
    const resolution = await preparer.resolvePython({ runId: "proof-run", requirements: ["numpy==1.19.5"] });
    receipts.push(resolution.cleanup);
    record("2. numpy==1.19.5 -> no_compatible_wheel", false, "unexpectedly resolved");
  } catch (error) {
    if (!(error instanceof PrepError)) throw error;
    if (error.cleanup) receipts.push(error.cleanup);
    const built = /Building wheel|setup\.py|Preparing metadata|Getting requirements to build/u.test(error.detail ?? "");
    record(
      "2. numpy==1.19.5 -> no_compatible_wheel",
      error.code === "no_compatible_wheel" && error.requirement === "numpy" && !built && error.cleanup?.verifiedAbsent === true,
      `code=${error.code} requirement=${error.requirement} built_from_source=${built}\nmessage: ${error.message}\npip: ${(error.detail ?? "").trim().split("\n").slice(-2).join(" | ")}`,
    );
  }
});

// (3) egress restriction from the internal network.
await step("3. egress restriction", async () => {
  const probe = await preparer.probeEgress({ runId: "proof-run" });
  receipts.push(probe.cleanup);
  const r = probe.results;
  const denied = probe.proxyLog.find((entry) => entry.host === "example.com");
  const pass =
    String(r["direct 1.1.1.1:443"]).startsWith("blocked") &&
    String(r["CONNECT example.com:443"]).includes("403") &&
    denied?.allowed === false &&
    String(r["CONNECT pypi.org:80"]).includes("403") &&
    String(r["CONNECT 1.1.1.1:443"]).includes("403") &&
    String(r["CONNECT 169.254.169.254:443"]).includes("403") &&
    String(r["CONNECT pypi.org:443"]).includes("200");
  record(
    "3. egress restriction",
    pass,
    `${Object.entries(r).map(([key, value]) => `${key} -> ${value}`).join("\n")}\nproxy log: ${probe.proxyLog.map((e) => JSON.stringify(e)).join("\n           ")}`,
  );
});

// (4) offline install in a lab-shaped container, wheelhouse mounted read-only.
await step("4. offline install + import matplotlib", async () => {
  if (!manifest) throw new Error("no manifest from step 1");
  const workDir = join(root, "labwork");
  await mkdir(workDir);
  if (process.getuid?.() === 0) await chown(workDir, 10001, 10001);
  else await chmod(workDir, 0o777);
  const name = `dejaml-prep-proof-offline-${process.pid}`;
  const created = docker([
    "create", "--name", name, "--pull", "never",
    "--label", "dejaml.prep=proof-offline",
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "10001:10001",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
    "--mount", `type=bind,src=${manifest.wheelhouseDir},dst=${LAB_WHEELS},readonly`,
    "--mount", `type=bind,src=${workDir},dst=/workspace/case/work`,
    "--env", "HOME=/tmp",
    "--entrypoint", "sleep", IMAGE, "infinity",
  ]);
  if (created.code !== 0) throw new Error(created.stderr);
  try {
    docker(["start", name]);
    const outputs = [];
    const commands = [
      ...offlineInstallCommands({ wheelhouse: LAB_WHEELS, venv: LAB_VENV, installerWheel: manifest.installer.filename }),
      [`${LAB_VENV}/bin/python`, "-c", "import matplotlib; print(matplotlib.__version__)"],
      inspectEnvironmentCommand(LAB_VENV),
      ["python", "-c", "import socket\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=3); print('network reachable')\nexcept OSError as e: print('network blocked', type(e).__name__)"],
      ["python", "-c", "import os\ntry:\n open('/workspace/case/wheels/x','w'); print('wheelhouse writable')\nexcept OSError as e: print('wheelhouse read-only', type(e).__name__)"],
    ];
    let ok = true;
    for (const argv of commands) {
      const run = docker(["exec", name, ...argv]);
      outputs.push({ argv, ...run });
      if (run.code !== 0) ok = false;
    }
    const version = outputs[2]?.stdout ?? "";
    const expected = manifest.packages.find((pkg) => pkg.name === "matplotlib")?.version;
    const inspected = JSON.parse(outputs[3]?.stdout || "{}");
    const installedPip = (inspected.distributions ?? []).some((d) => d.name.toLowerCase() === "pip");
    record(
      "4. offline install + import matplotlib",
      ok && version === expected && outputs[4]?.stdout.startsWith("network blocked") && outputs[5]?.stdout.startsWith("wheelhouse read-only"),
      `install: ${outputs[1]?.stdout.split("\n").at(-1)}\nimport matplotlib -> ${version} (expected ${expected})\n` +
        `lab env: python ${inspected.python}, ${inspected.distributions?.length} distributions, pip installed into venv=${installedPip}\n` +
        `${outputs[4]?.stdout}; ${outputs[5]?.stdout}` +
        (ok ? "" : `\n${outputs.filter((o) => o.code !== 0).map((o) => `${o.argv.join(" ")}: ${o.stderr}`).join("\n")}`),
    );
  } finally {
    docker(["rm", "--force", name]);
  }
});

// (5) second run: every wheel comes from the verified cache; no downloader.
await step("5. cache path", async () => {
  const resolution = await preparer.resolvePython({ runId: "proof-run-2", requirements: ["matplotlib"], includeInstaller: true });
  receipts.push(resolution.cleanup);
  const second = await preparer.downloadWheels(resolution);
  const bytesThroughProxy = second.proxyLog.download.reduce((sum, entry) => sum + (entry.bytes_down ?? 0), 0);
  record(
    "5. cache path",
    second.cache.downloaderSkipped && second.cache.downloaded === 0 && second.cleanup.download === null && bytesThroughProxy === 0,
    `cache=${JSON.stringify(second.cache)} download proxy bytes=${bytesThroughProxy} wheelhouse=${second.wheelhouseDir}`,
  );
});

// (5b) cancellation mid-resolve cleans everything up.
await step("5b. cancellation", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1500);
  try {
    await preparer.resolvePython({ runId: "proof-cancel", requirements: ["scipy", "pandas"], signal: controller.signal });
    record("5b. cancellation", false, "resolve finished before the abort fired");
  } catch (error) {
    if (!(error instanceof PrepError)) throw error;
    if (error.cleanup) receipts.push(error.cleanup);
    record("5b. cancellation", error.code === "cancelled" && error.cleanup?.verifiedAbsent === true, `code=${error.code} cleanup=${JSON.stringify(error.cleanup)}`);
  }
});

// (6) nothing labelled dejaml.prep remains; temp dirs are gone.
await step("6. cleanup", async () => {
  const containers = docker(["ps", "--all", "--filter", "label=dejaml.prep", "--format", "{{.Names}}"]).stdout;
  const networks = docker(["network", "ls", "--filter", "label=dejaml.prep", "--format", "{{.Name}}"]).stdout;
  const temps = await readdir(workRoot).catch(() => []);
  const receiptsOk = receipts.every((r) => r.networkRemoved && r.tempRemoved && r.verifiedAbsent);
  record(
    "6. cleanup",
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

const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
