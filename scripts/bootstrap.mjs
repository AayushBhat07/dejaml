#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvLocal, readEnvLocal, updateEnvLocal } from "./env-local.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const image = "dejaml/python-cpu:0.1.0";
const minimumNodeMajor = 24;

function heading(message) {
  process.stdout.write(`\n==> ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\nBOOTSTRAP FAILED: ${message}\n`);
  process.exit(1);
}

function commandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  return result.status === 0;
}

async function run(command, args, options = {}) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with status ${String(code)}`));
    });
  });
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} exited with status ${String(result.status)}`);
  return result.stdout.trim();
}

async function downloadPaper() {
  const manifest = JSON.parse(await readFile(join(root, "cases/urban-land-cover/case.json"), "utf8"));
  const destination = join(root, "artifacts/demo/paper.pdf");
  const existing = await readFile(destination).catch(() => null);
  if (existing?.subarray(0, 5).toString("ascii") === "%PDF-") return destination;
  const response = await fetch(manifest.paper.pdfUrl, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`paper download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 20 * 1024 * 1024 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("paper download was not a valid PDF under 20 MB");
  }
  await mkdir(join(root, "artifacts/demo"), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { mode: 0o600 });
  return destination;
}

try {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < minimumNodeMajor) {
    fail(`Node.js ${minimumNodeMajor}+ is required; found ${process.version}.`);
  }
  if (!commandAvailable("npm")) fail("npm is required.");
  if (!commandAvailable("python3")) fail("Python 3 is required to fetch the checksum-pinned dataset.");
  if (!commandAvailable("docker", ["info"])) fail("Docker is required and its Linux engine must be running.");
  // An existing .env.local (with any provider keys in it) is read first and must parse; it is never replaced wholesale.
  const environmentPath = join(root, ".env.local");
  const existingEnvironment = await readEnvLocal(environmentPath);
  if (existingEnvironment !== null) parseEnvLocal(existingEnvironment);

  heading("Installing locked JavaScript dependencies");
  await run("npm", ["ci"]);

  heading("Building, type-checking, and testing the repository");
  await run("npm", ["run", "check"]);

  heading("Fetching and verifying the curated public dataset");
  await run("python3", ["cases/urban-land-cover/fetch_data.py"]);

  heading("Building the pinned local CPU lab image");
  await run("docker", ["build", "--provenance=false", "--file", "lab-images/python-cpu/Dockerfile", "--tag", image, "."]);
  const imageId = capture("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error(`Docker returned an invalid image ID: ${imageId}`);

  heading("Running the real curated paper experiment in the disposable lab");
  await run("npm", ["run", "verify:curated", "--workspace", "@dejaml/lab-manager"], {
    env: { DEJAML_EXPECTED_IMAGE_ID: imageId },
  });

  heading("Preparing the example paper and live web build");
  const paperPath = await downloadPaper();
  await run("npm", ["run", "build", "--workspace", "@dejaml/web"], {
    env: { VITE_DEJAML_API: "live" },
  });

  // Only the generated image ID is updated (and missing defaults added, including DEJAML_CHEAPER_INFERENCE_MODELS);
  // provider keys and model lists are kept, and only key names are reported.
  const environment = await updateEnvLocal(environmentPath, { DEJAML_EXPECTED_IMAGE_ID: imageId });

  const resultPath = join(root, "cases/urban-land-cover/artifacts/result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  const resultInfo = await stat(resultPath);

  heading("Bootstrap complete");
  process.stdout.write(`Verified result: ${result.metrics.accuracyPercent}%\n`);
  process.stdout.write(`Paper: ${paperPath}\n`);
  process.stdout.write(`Result: ${resultPath} (${resultInfo.size} bytes)\n`);
  process.stdout.write(`Local image: ${imageId}\n`);
  process.stdout.write(
    `.env.local ${environment.created ? "created" : "updated"} (mode 0600)` +
      (environment.keptSecrets.length > 0 ? `; kept ${environment.keptSecrets.join(", ")} unchanged (values not shown)` : "") +
      "\n\n",
  );
  process.stdout.write("Explore the labelled replay UI:\n  npm run demo:replay\n\n");
  process.stdout.write(
    "Put DEJAML_ANTHROPIC_API_KEY, DEJAML_OPENAI_API_KEY (with DEJAML_OPENAI_MODELS) or DEJAML_CHEAPER_INFERENCE_API_KEY (a trusted third-party gateway, not the official Anthropic API; zero-data-retention disabled) in the server environment or .env.local (bootstrap keeps them), then run npm run start:local. Keys are never entered in the page or printed.\n",
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
