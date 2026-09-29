#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const image = "dejaml/python-cpu:0.1.0";
const minimumNodeMajor = 24;
const pinnedOpenClawVersion = "2026.9.5";
const requiredAgents = ["dejaml-paper", "dejaml-code", "dejaml-lead"];
const optionalAgents = ["dejaml-audit"];

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

function inspectOpenClaw() {
  const binary = process.env.OPENCLAW_BIN?.trim() || "openclaw";
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (version.status !== 0) return { binary, available: false, versionOk: false, missing: requiredAgents, optionalMissing: optionalAgents };
  const versionText = version.stdout.trim();
  const versionOk = versionText.includes(pinnedOpenClawVersion);
  const listed = spawnSync(binary, ["agents", "list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ids = [];
  if (listed.status === 0) {
    try {
      ids = JSON.parse(listed.stdout).map((agent) => agent.id);
    } catch {
      ids = [];
    }
  }
  return {
    binary,
    available: true,
    versionOk,
    versionText,
    missing: requiredAgents.filter((id) => !ids.includes(id)),
    optionalMissing: optionalAgents.filter((id) => !ids.includes(id)),
  };
}

try {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < minimumNodeMajor) {
    fail(`Node.js ${minimumNodeMajor}+ is required; found ${process.version}.`);
  }
  if (!commandAvailable("npm")) fail("npm is required.");
  if (!commandAvailable("python3")) fail("Python 3 is required to fetch the checksum-pinned dataset.");
  if (!commandAvailable("docker", ["info"])) fail("Docker is required and its Linux engine must be running.");

  heading("Installing locked JavaScript dependencies");
  await run("npm", ["ci"]);

  heading("Building, type-checking, and testing the repository");
  await run("npm", ["run", "check"]);

  heading("Fetching and verifying the curated public dataset");
  await run("python3", ["cases/urban-land-cover/fetch_data.py"]);

  heading("Building the pinned local CPU lab image");
  await run("docker", [
    "build",
    "--provenance=false",
    "--file",
    "lab-images/python-cpu/Dockerfile",
    "--tag",
    image,
    ".",
  ]);
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

  const openClaw = inspectOpenClaw();
  const localEnvironment = [
    "# Generated by npm run bootstrap. Contains no provider credentials.",
    `DEJAML_EXPECTED_IMAGE_ID=${imageId}`,
    `OPENCLAW_BIN=${openClaw.binary}`,
    "DEJAML_PAPER_AGENT=dejaml-paper",
    "DEJAML_CODE_AGENT=dejaml-code",
    "DEJAML_LEAD_AGENT=dejaml-lead",
    "DEJAML_AUDIT_AGENT=dejaml-audit",
    "HOST=127.0.0.1",
    "PORT=8787",
    "",
  ].join("\n");
  const environmentPath = join(root, ".env.local");
  await writeFile(environmentPath, localEnvironment, { mode: 0o600 });
  await chmod(environmentPath, 0o600);

  const resultPath = join(root, "cases/urban-land-cover/artifacts/result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  const resultInfo = await stat(resultPath);

  heading("Bootstrap complete");
  process.stdout.write(`Verified result: ${result.metrics.accuracyPercent}%\n`);
  process.stdout.write(`Paper: ${paperPath}\n`);
  process.stdout.write(`Result: ${resultPath} (${resultInfo.size} bytes)\n`);
  process.stdout.write(`Local image: ${imageId}\n\n`);
  process.stdout.write("Explore the labelled replay UI:\n  npm run demo:replay\n\n");
  if (!openClaw.available) {
    process.stdout.write("Live agent mode is not ready: the pinned OpenClaw CLI was not found.\n");
  } else {
    if (!openClaw.versionOk) {
      process.stdout.write(`Live agent warning: expected OpenClaw ${pinnedOpenClawVersion}; found ${openClaw.versionText}.\n`);
    }
    if (openClaw.missing.length > 0) {
      process.stdout.write(`Live agent mode is missing required agents: ${openClaw.missing.join(", ")}\n`);
    } else {
      process.stdout.write("Run the complete live agent pipeline:\n  npm run start:local\n");
    }
    if (openClaw.optionalMissing.length > 0) {
      process.stdout.write(`Optional semantic audit unavailable until configured: ${openClaw.optionalMissing.join(", ")}\n`);
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
