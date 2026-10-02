// Proves deterministic image readiness against a real Docker engine:
// a small multi-platform image pinned by digest is pulled for linux/amd64 and
// linux/arm64 (arm64 containers run only when emulation is installed), the
// lab base image is built for one Python version on this host's platform from
// its digest-pinned base, concurrent requests share one pull and one build,
// stale IDs, wrong platforms, missing images and timeouts fail with typed
// errors, and a sealed lab runs on the built base image. Everything this
// script creates is removed afterwards except the base images it pulled.
//
// Environment:
//   DEJAML_VERIFY_PYTHON      Python version to build (default 3.11)
//   DEJAML_PROBE_IMAGE        small pinned multi-platform image (default busybox 1.37.0 by digest)
//   DEJAML_BASE_REPOSITORY    registry repository of the Python bases (default: the lock's docker.io/library/python;
//                             a mirror such as mirror.gcr.io/library/python serves the same digests)
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { hostArchitecture, containerPlatformFor } from "@dejaml/contracts";

import {
  DEFAULT_LAB_LIMITS,
  DockerCliRuntime,
  ImageReadiness,
  LabManager,
  loadBaseImageLock,
  pythonBaseImageRequest,
} from "../dist/index.js";

const PROBE_IMAGE =
  process.env.DEJAML_PROBE_IMAGE ??
  "mirror.gcr.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
const PYTHON = process.env.DEJAML_VERIFY_PYTHON ?? "3.11";
const architecture = hostArchitecture(process.arch);
if (!architecture) throw new Error(`unsupported host architecture ${process.arch}`);
const HOST_PLATFORM = containerPlatformFor(architecture);
const OTHER_PLATFORM = HOST_PLATFORM === "linux/amd64" ? "linux/arm64" : "linux/amd64";
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const baseContext = join(projectRoot, "lab-images/python-base");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** Counts the Docker CLI calls ImageReadiness makes. */
class CountingRuntime {
  constructor() {
    this.inner = new DockerCliRuntime();
    this.calls = [];
  }
  docker(args, options) {
    this.calls.push([...args]);
    return this.inner.docker(args, options);
  }
  count(command) {
    return this.calls.filter((call) => call[0] === command).length;
  }
}

async function failure(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

const report = { hostPlatform: HOST_PLATFORM, probeImage: PROBE_IMAGE, python: PYTHON, skipped: [] };
const cleanup = { images: [], dirs: [] };
const probePresentBefore = docker(["image", "inspect", PROBE_IMAGE]).status === 0;
const lock = await loadBaseImageLock(join(baseContext, "bases.lock.json"));
const baseRequest = pythonBaseImageRequest({
  lock,
  python: PYTHON,
  platform: HOST_PLATFORM,
  contextDir: baseContext,
  ...(process.env.DEJAML_BASE_REPOSITORY ? { baseRepository: process.env.DEJAML_BASE_REPOSITORY } : {}),
});
report.baseImage = { tag: baseRequest.reference, from: baseRequest.build.buildArgs.PYTHON_BASE };

try {
  // 1. A small image by digest for this host's platform: concurrent requests share one pull.
  if (!probePresentBefore) cleanup.images.push(PROBE_IMAGE);
  const counting = new CountingRuntime();
  const readiness = new ImageReadiness({ docker: counting, retries: 2, backoffMs: 2_000 });
  const probeRequest = (platform) => ({ key: "probe:busybox", reference: PROBE_IMAGE, platform, pull: true });
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => readiness.ensure(probeRequest(HOST_PLATFORM))));
  assert(counting.count("pull") === (probePresentBefore ? 0 : 1), `one pull for five concurrent requests (saw ${counting.count("pull")})`);
  assert(
    concurrent.every((image) => image === concurrent[0]),
    "all callers share one result",
  );
  const host = concurrent[0];
  assert(host.platform === HOST_PLATFORM && `${host.os}/${host.architecture}` === HOST_PLATFORM, "probe image is for this platform");
  assert(host.source === (probePresentBefore ? "present" : "pulled"), "probe image source recorded");
  const again = await readiness.ensure(probeRequest(HOST_PLATFORM));
  assert(again.source === "present" && again.imageId === host.imageId, "an existing image is used by its ID without pulling");
  const running = docker(["run", "--rm", "--network", "none", "--platform", HOST_PLATFORM, "--pull", "never", PROBE_IMAGE, "uname", "-m"]);
  assert(running.status === 0, `probe image runs on ${HOST_PLATFORM}: ${running.stderr}`);
  report.hostProbe = {
    imageId: host.imageId,
    repoDigests: host.repoDigests,
    source: host.source,
    pulls: counting.count("pull"),
    uname: running.stdout.trim(),
  };

  // 2. The same image for the other platform: pulling needs no emulation; running it does.
  const other = await readiness.ensure(probeRequest(OTHER_PLATFORM));
  assert(
    other.platform === OTHER_PLATFORM && `${other.os}/${other.architecture}` === OTHER_PLATFORM,
    `probe image pulled for ${OTHER_PLATFORM}`,
  );
  const emulated = docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--platform",
    OTHER_PLATFORM,
    "--pull",
    "never",
    PROBE_IMAGE,
    "uname",
    "-m",
  ]);
  if (emulated.status === 0) {
    report.otherProbe = { imageId: other.imageId, architecture: other.architecture, uname: emulated.stdout.trim() };
  } else {
    report.otherProbe = { imageId: other.imageId, architecture: other.architecture };
    report.skipped.push(
      `running ${OTHER_PLATFORM} containers: no emulation on this ${HOST_PLATFORM} host (${emulated.stderr.trim().split("\n").at(-1)}); install binfmt/QEMU to run them`,
    );
  }

  // 3. Typed failures against the real engine.
  const stale = await failure(
    readiness.ensure({ ...probeRequest(HOST_PLATFORM), key: "probe:stale", expectedImageId: `sha256:${"0".repeat(64)}` }),
  );
  assert(stale?.code === "image_stale", `a different local ID is stale (${stale?.code})`);
  const missing = await failure(
    readiness.ensure({ key: "probe:missing", reference: `dejaml/never-built@sha256:${"0".repeat(64)}`, platform: HOST_PLATFORM }),
  );
  assert(missing?.code === "image_missing", `an absent image is missing (${missing?.code})`);
  const quick = new ImageReadiness({ pullTimeoutMs: 50, retries: 0 });
  const unpulled = lock.bases["3.12"];
  const timedOut = await failure(
    quick.ensure({
      key: "probe:timeout",
      reference: `docker.io/library/python:${unpulled.tag}@${unpulled.index}`,
      platform: HOST_PLATFORM,
      pull: true,
    }),
  );
  assert(timedOut?.code === "timeout" || timedOut === null, `a pull past its limit times out (${timedOut?.code})`);
  if (timedOut === null) report.skipped.push("timeout: the 3.12 base was already present locally, so nothing was pulled");
  report.typedFailures = { stale: stale.message, missing: missing.message, timeout: timedOut?.message ?? null };

  // 4. The lab base image for one Python version, built on this platform from its pinned base.
  const existing = docker(["image", "inspect", "--format", "{{.Id}}", baseRequest.reference]);
  if (existing.status === 0) docker(["image", "rm", baseRequest.reference]);
  cleanup.images.push(baseRequest.reference);
  const builds = new CountingRuntime();
  const images = new ImageReadiness({ docker: builds, buildTimeoutMs: 20 * 60_000 });
  const built = await Promise.all([images.ensure(baseRequest), images.ensure(baseRequest), images.ensure(baseRequest)]);
  assert(builds.count("build") === 1, `one build for three concurrent requests (saw ${builds.count("build")})`);
  const base = built[0];
  assert(
    base.source === "built" && base.platform === HOST_PLATFORM && `${base.os}/${base.architecture}` === HOST_PLATFORM,
    "base image built for this platform",
  );
  const rebuilt = await images.ensure({ ...baseRequest, expectedImageId: base.imageId });
  assert(rebuilt.source === "present" && rebuilt.imageId === base.imageId, "the built image is reused by its ID");
  const wrongPlatform = await failure(
    images.ensure({ key: "lab-base:wrong-platform", reference: baseRequest.reference, platform: OTHER_PLATFORM }),
  );
  assert(
    wrongPlatform?.code === "platform_mismatch",
    `the ${HOST_PLATFORM} base is refused for ${OTHER_PLATFORM} (${wrongPlatform?.code})`,
  );
  const staleBase = await failure(images.ensure({ ...baseRequest, key: "lab-base:stale", expectedImageId: host.imageId }));
  assert(staleBase?.code === "image_stale", "a base with another ID is stale");

  // 5. The built base is a sealed lab image: non-root, no pip, offline venv support, and it runs in a lab.
  const inspected = JSON.parse(docker(["image", "inspect", "--format", "{{json .}}", baseRequest.reference]).stdout);
  assert(
    inspected.Config.User === "10001:10001" && inspected.Config.WorkingDir === "/workspace/case",
    "base image is non-root with the lab workdir",
  );
  const root = await mkdtemp(join(tmpdir(), "dejaml-images-proof-"));
  cleanup.dirs.push(root);
  await mkdir(join(root, "repo"));
  await writeFile(join(root, "repo", "train.py"), "import sys\nprint('python', '%d.%d' % sys.version_info[:2])\n");
  const labs = new LabManager({ labRoot: join(root, "labs"), images });
  const lab = await labs.withLab(
    {
      runId: "run_images_proof",
      image: baseRequest.reference,
      expectedImageId: base.imageId,
      platform: HOST_PLATFORM,
      workdir: "/workspace/case",
      artifactsDir: "artifacts",
      scratchDir: "work",
      inputs: [{ hostPath: join(root, "repo"), containerPath: "repo" }],
      resources: { cpus: 1, memoryMb: 512, pids: 64, timeoutSeconds: 120, networkDuringRun: false },
      limits: DEFAULT_LAB_LIMITS,
    },
    async (handle) => {
      const run = (args) =>
        labs.runCommand(handle.labId, { executable: "python", args, cwd: "/workspace/case", env: {} }, { timeoutSeconds: 60, step: 1 });
      const version = await run(["repo/train.py"]);
      const pip = await run(["-c", "import importlib.util as u; print(u.find_spec('pip') is None, u.find_spec('ensurepip') is None)"]);
      const venv = await run(["-m", "venv", "--without-pip", "work/venv"]);
      const inVenv = await labs
        .runCommand(
          handle.labId,
          {
            executable: "work/venv/bin/python",
            args: ["-c", "import sys; print(sys.prefix != sys.base_prefix)"],
            cwd: "/workspace/case",
            env: {},
          },
          { timeoutSeconds: 30, step: 2 },
        )
        .catch((error) => ({ exitCode: null, stdout: { text: "" }, stderr: { text: String(error) } }));
      return { handle, version, pip, venv, inVenv };
    },
  );
  assert(
    lab.value.handle.platform === HOST_PLATFORM && lab.value.handle.imageId === base.imageId,
    "lab runs the built base image on this platform",
  );
  assert(lab.value.version.stdout.text.trim() === `python ${PYTHON}`, `lab has Python ${PYTHON}`);
  assert(lab.value.pip.stdout.text.trim() === "True True", "pip and ensurepip are removed");
  assert(lab.value.venv.exitCode === 0, `python -m venv --without-pip works offline: ${lab.value.venv.stderr.text}`);
  assert(lab.receipt.verifiedAbsent && lab.receipt.platform === HOST_PLATFORM, "lab removed with a platform receipt");
  report.base = {
    imageId: base.imageId,
    builds: builds.count("build"),
    labPython: lab.value.version.stdout.text.trim(),
    venvWithoutPip: lab.value.venv.exitCode === 0,
    receipt: lab.receipt,
  };
  // The executable check only accepts bare program names, so the venv interpreter is refused by design.
  report.base.venvInterpreterRefused = lab.value.inVenv.exitCode === null;
  report.status = images.status().concat(readiness.status());
} finally {
  for (const image of cleanup.images) docker(["image", "rm", image]);
  for (const dir of cleanup.dirs) await rm(dir, { recursive: true, force: true });
}

const leftovers = docker(["ps", "--all", "--quiet", "--filter", "label=dejaml.lab"]).stdout.trim();
assert(leftovers === "", "no lab containers remain");
for (const image of cleanup.images) {
  assert(docker(["image", "inspect", image]).status !== 0, `${image} was removed`);
}
report.removed = cleanup.images;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
