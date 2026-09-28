import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const image = "dejaml/python-cpu:0.1.0";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");
const caseRoot = join(projectRoot, "cases/urban-land-cover");
const outputRoot = await mkdtemp(join(tmpdir(), "dejaml-image-proof-"));
const outputPath = join(outputRoot, "result.json");

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function run(args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", args, {
      cwd: projectRoot,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(Buffer.concat(stderr).toString("utf8") || `docker exited with ${code}`),
        );
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

try {
  await chmod(outputRoot, 0o777);
  const imageLock = JSON.parse(await readFile(join(scriptDirectory, "image-lock.json"), "utf8"));
  const dockerfileDigest = await sha256(join(scriptDirectory, "Dockerfile"));
  const requirementsDigest = await sha256(join(scriptDirectory, "requirements.lock.txt"));
  if (dockerfileDigest !== imageLock.dockerfileSha256) throw new Error("Dockerfile digest differs from image lock");
  if (requirementsDigest !== imageLock.requirementsSha256) throw new Error("requirements digest differs from image lock");
  await run([
    "build", "--provenance=false", "--file", "lab-images/python-cpu/Dockerfile", "--tag", image, ".",
  ]);

  const metadata = JSON.parse(
    await run(["image", "inspect", image, "--format", "{{json .}}"], { capture: true }),
  );
  if (metadata.Config?.User !== "10001:10001") throw new Error("image is not configured as non-root");
  if (metadata.Config?.WorkingDir !== "/workspace/case") throw new Error("unexpected image workdir");
  if (metadata.Id !== imageLock.verifiedImageId) throw new Error("built image identity differs from image lock");

  const versions = JSON.parse(
    await run(
      [
        "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", image, "python", "-c",
        "import json,numpy,pandas,scipy,sklearn; print(json.dumps({'numpy':numpy.__version__,'pandas':pandas.__version__,'scipy':scipy.__version__,'scikitLearn':sklearn.__version__}))",
      ],
      { capture: true },
    ),
  );
  const expectedVersions = {
    numpy: "2.5.3", pandas: "3.0.6", scipy: "1.18.1", scikitLearn: "1.9.1",
  };
  if (JSON.stringify(versions) !== JSON.stringify(expectedVersions)) {
    throw new Error(`dependency versions differ: ${JSON.stringify(versions)}`);
  }

  await run([
    "run", "--rm", "--network", "none", "--read-only", "--cpus", "2", "--memory",
    "2048m", "--pids-limit", "128", "--cap-drop", "ALL", "--security-opt",
    "no-new-privileges", "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=1777", "--mount",
    `type=bind,src=${join(caseRoot, "runner.py")},dst=/workspace/case/runner.py,readonly`,
    "--mount", `type=bind,src=${join(caseRoot, "data")},dst=/workspace/case/data,readonly`,
    "--mount", `type=bind,src=${outputRoot},dst=/workspace/case/artifacts`, image,
    "python", "runner.py", "--training", "data/training.csv", "--testing",
    "data/testing.csv", "--output", "artifacts/result.json",
  ]);

  const result = JSON.parse(await readFile(outputPath, "utf8"));
  if (result.metrics?.accuracyPercent !== 79.88) {
    throw new Error(`unexpected accuracy: ${String(result.metrics?.accuracyPercent)}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      image,
      imageId: metadata.Id,
      user: metadata.Config.User,
      workingDirectory: metadata.Config.WorkingDir,
      networkDuringRun: false,
      accuracyPercent: result.metrics.accuracyPercent,
      runtime: result.runtime,
    }, null, 2)}\n`,
  );
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}
