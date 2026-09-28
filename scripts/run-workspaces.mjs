// Runs one npm script across all workspaces in dependency order.
// npm's own `--workspaces` runs alphabetically, which builds dependents
// before the internal packages they import.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptName = process.argv[2];
if (!scriptName) {
  console.error("usage: node scripts/run-workspaces.mjs <script>");
  process.exit(2);
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const workspaces = new Map();
for (const pattern of rootManifest.workspaces) {
  if (!pattern.endsWith("/*")) throw new Error(`unsupported workspace pattern: ${pattern}`);
  const parent = join(root, pattern.slice(0, -2));
  if (!existsSync(parent)) continue;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const manifestPath = join(parent, entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    workspaces.set(manifest.name, manifest);
  }
}

const ordered = [];
const state = new Map();
function visit(name, path) {
  if (state.get(name) === "done") return;
  if (state.get(name) === "visiting") {
    throw new Error(`workspace dependency cycle: ${[...path, name].join(" -> ")}`);
  }
  state.set(name, "visiting");
  const manifest = workspaces.get(name);
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const dependency of Object.keys(dependencies).sort()) {
    if (workspaces.has(dependency)) visit(dependency, [...path, name]);
  }
  state.set(name, "done");
  ordered.push(name);
}
for (const name of [...workspaces.keys()].sort()) visit(name, []);

for (const name of ordered) {
  if (!workspaces.get(name).scripts?.[scriptName]) continue;
  const result = spawnSync("npm", ["run", scriptName, "--workspace", name], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
