#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const environmentPath = join(root, ".env.local");

function parseEnvironment(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`invalid line in .env.local: ${rawLine}`);
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

try {
  const local = parseEnvironment(await readFile(environmentPath, "utf8"));
  const env = { ...local, ...process.env };
  const binary = env.OPENCLAW_BIN?.trim();
  if (!binary) throw new Error("OPENCLAW_BIN is empty; rerun npm run bootstrap or set it explicitly");
  const version = spawnSync(binary, ["--version"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (version.status !== 0) throw new Error(`OpenClaw is unavailable at ${binary}`);
  const agents = spawnSync(binary, ["agents", "list", "--json"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (agents.status !== 0) throw new Error("OpenClaw could not list the dedicated DéjàML agents");
  const configuredAgents = new Set(JSON.parse(agents.stdout).map((agent) => agent.id));
  const requiredAgents = [env.DEJAML_PAPER_AGENT, env.DEJAML_CODE_AGENT, env.DEJAML_LEAD_AGENT].filter(Boolean);
  const missingAgents = requiredAgents.filter((agent) => !configuredAgents.has(agent));
  if (missingAgents.length > 0) throw new Error(`missing required OpenClaw agents: ${missingAgents.join(", ")}`);
  await access(join(root, "cases/urban-land-cover/data/training.csv"));
  await access(join(root, "cases/urban-land-cover/data/testing.csv"));
  await access(join(root, "apps/web/dist/index.html"));

  const imageId = spawnSync(
    "docker",
    ["image", "inspect", "dejaml/python-cpu:0.1.0", "--format", "{{.Id}}"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (imageId.status !== 0) throw new Error("the DéjàML lab image is missing; rerun npm run bootstrap");
  if (imageId.stdout.trim() !== env.DEJAML_EXPECTED_IMAGE_ID) {
    throw new Error("the local image ID differs from .env.local; rerun npm run bootstrap");
  }

  process.stdout.write(`Starting the live DéjàML API at http://${env.HOST ?? "127.0.0.1"}:${env.PORT ?? "8787"}\n`);
  process.stdout.write(`Upload ${join(root, "artifacts/demo/paper.pdf")}\n`);
  const child = spawn(process.execPath, ["apps/api/dist/main.js"], { cwd: root, env, stdio: "inherit" });
  child.on("error", (error) => {
    process.stderr.write(`START FAILED: ${error.message}\n`);
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
} catch (error) {
  process.stderr.write(`START FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write("Run `npm run bootstrap` first.\n");
  process.exit(1);
}
