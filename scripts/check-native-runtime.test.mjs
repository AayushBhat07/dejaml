// Run with: node --test scripts/check-native-runtime.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { scanNativeRuntime } from "./check-native-runtime.mjs";

const SCRIPT = fileURLToPath(new URL("./check-native-runtime.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "dejaml-native-check-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
}

// One forbidden line per rule, each in its own production file.
const FORBIDDEN = {
  "openclaw-import": ["packages/a/src/import.ts", `import { Agent } from "@openclaw/sdk";\n`],
  "openclaw-dependency": ["packages/a/package.json", `{\n  "dependencies": {\n    "openclaw": "2026.9.5"\n  }\n}\n`],
  "openclaw-exec": ["services/b/src/exec.ts", `const child = spawn("openclaw", ["agent", "--json"]);\n`],
  "openclaw-bin": ["scripts/bin.mjs", `const binary = process.env.OPENCLAW_BIN;\n`],
  "openclaw-script": ["apps/c/package.json", `{\n  "scripts": {\n    "agent": "openclaw agent --json"\n  }\n}\n`],
  "openclaw-gateway-port": ["apps/c/src/port.ts", `const port = 18789;\n`],
  "openclaw-gateway-endpoint": ["apps/c/src/endpoint.ts", `await fetch(new URL("/v1/agent", base));\n`],
  "openclaw-gateway": ["packages/d/src/gw.ts", `// connect to the OpenClaw gateway for analyst runs\n`],
  "openclaw-session": ["packages/d/src/session.ts", `const key = "agent:main";\n`],
  "loopback-model-bridge": ["lab-images/e/client.js", `const baseUrl = "http://127.0.0.1:8080/v1";\n`],
};

test("flags each forbidden pattern with file and line", () => {
  for (const [rule, [path, content]] of Object.entries(FORBIDDEN)) {
    const findings = scanNativeRuntime(tree({ [path]: content }));
    assert.ok(
      findings.some((finding) => finding.rule === rule && finding.file === path && finding.line >= 1),
      `${rule} was not reported for ${path}: ${JSON.stringify(findings)}`,
    );
  }
});

test("flags a locked OpenClaw package and loopback bridge variants", () => {
  const root = tree({
    "package-lock.json": `{\n  "packages": {\n    "node_modules/@openclaw/gateway-client": { "version": "1.0.0" }\n  }\n}\n`,
    "packages/f/src/a.ts": `const url = "http://localhost:11434/v1/chat/completions";\n`,
    "packages/f/src/b.ts": `execFile("/usr/local/bin/openclaw", args);\n`,
    "packages/f/src/c.ts": `const sessionKey = openclawSessionFor(run); // --session-key\n`,
  });
  const rules = scanNativeRuntime(root).map((finding) => `${finding.file}:${finding.rule}`);
  assert.ok(rules.includes("package-lock.json:openclaw-dependency"));
  assert.ok(rules.includes("packages/f/src/a.ts:loopback-model-bridge"));
  assert.ok(rules.includes("packages/f/src/b.ts:openclaw-exec"));
  assert.ok(rules.includes("packages/f/src/c.ts:openclaw-session"));
});

test("the CLI exits 1 and prints file:line", () => {
  const result = run(tree({ "packages/a/src/x.ts": `\nconst gateway = "ws://127.0.0.1:18789";\n` }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/a\/src\/x\.ts:2: targets the OpenClaw Gateway port 18789/u);
});

test("ignores tests, fixtures, build output, dependencies, and allowed providers", () => {
  const root = tree({
    "packages/a/src/client.test.ts": `spawn("openclaw", []);\n`,
    "packages/a/src/fixtures/bridge.json": `{ "baseUrl": "http://127.0.0.1:8000/v1" }\n`,
    "packages/a/dist/index.js": `import "openclaw";\n`,
    "packages/a/node_modules/openclaw/index.js": `export {};\n`,
    "packages/a/src/providers.ts": [
      `const openai = "https://api.openai.com/v1";`,
      `const anthropic = "https://api.anthropic.com/v1/messages";`,
      `const sessionKey = \`\${runId}:\${role}\`;`,
      `const agents = "/v1/agents";`,
      `const api = "http://127.0.0.1:8787/api/runs";`,
      "",
    ].join("\n"),
    "package-lock.json": `{ "integrity": "sha512-Ab18789Cd+/x18789==" }\n`,
  });
  assert.deepEqual(scanNativeRuntime(root), []);
  assert.equal(run(root).status, 0);
});

test("the repository passes", () => {
  const result = run(REPO);
  assert.equal(result.status, 0, result.stderr);
});
