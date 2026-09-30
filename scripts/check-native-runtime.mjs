// Fails when production code could reach OpenClaw or a localhost model bridge.
// DéjàML runs its own agents (packages/agent-runtime) and calls OpenAI or
// Anthropic through its own provider adapters; nothing may import, execute, or
// connect to an OpenClaw package, binary, Gateway, or session, or send model
// traffic to an OpenAI-compatible endpoint on loopback.
//
// usage: node scripts/check-native-runtime.mjs [rootDir]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCANNED_DIRS = ["apps", "packages", "services", "scripts", "lab-images"];
const SCANNED_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|sh)$/u;
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git", "fixtures", "__fixtures__", "coverage"]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

// The guards themselves name what they forbid.
const SELF = new Set([
  "scripts/check-native-runtime.mjs",
  "scripts/check-native-runtime.test.mjs",
  "packages/agent-runtime/src/native-guard.ts",
]);

const LOOPBACK_HOST = String.raw`(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])`;

/** Each rule is tested per line; `files` limits it to matching paths. */
const RULES = [
  {
    id: "openclaw-import",
    message: "imports an OpenClaw package",
    pattern: /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`][^"'`]*openclaw[^"'`]*["'`]/iu,
  },
  {
    id: "openclaw-dependency",
    message: "declares or locks an OpenClaw package",
    files: /(?:^|\/)(?:package\.json|package-lock\.json)$/u,
    pattern: /"(?:[^"]*\/)?(?:@[^"/]*openclaw[^"/]*\/[^"]*|@?[^"@/]*openclaw[^"]*)"\s*:/iu,
  },
  {
    id: "openclaw-exec",
    message: "executes an OpenClaw binary",
    pattern: /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|execa)\s*\(\s*["'`][^"'`]*openclaw/iu,
  },
  {
    id: "openclaw-bin",
    message: "references the OpenClaw binary",
    pattern: /\bOPENCLAW_BIN\b|["'`](?:[^"'`\s]*\/)?openclaw(?:\.exe)?["'`]/iu,
  },
  {
    id: "openclaw-script",
    message: "runs the OpenClaw CLI from an npm script",
    files: /(?:^|\/)package\.json$/u,
    pattern: /"[^"]*"\s*:\s*"(?:[^"]*(?:&&|;|\|\||\|)\s*)?(?:npx\s+)?openclaw\b/iu,
  },
  {
    id: "openclaw-gateway-port",
    message: "targets the OpenClaw Gateway port 18789",
    pattern: /(?<![A-Za-z0-9.+/=_-])18789(?![A-Za-z0-9_])/u,
  },
  {
    id: "openclaw-gateway-endpoint",
    message: "targets the OpenClaw Gateway agent endpoint",
    pattern: /\/v1\/agent(?![\w-])/u,
  },
  {
    id: "openclaw-gateway",
    message: "mentions an OpenClaw Gateway",
    pattern: /openclaw.*gateway|gateway.*openclaw/iu,
  },
  {
    id: "openclaw-session",
    message: "uses an OpenClaw session identifier",
    pattern: /["'`]agent:main(?::|["'`])|--session-key\b|openclaw.*session[-_]?key|session[-_]?key.*openclaw/iu,
  },
  {
    id: "loopback-model-bridge",
    message: "connects to a localhost compatibility bridge",
    pattern: new RegExp(String.raw`https?://${LOOPBACK_HOST}(?::\d+)?/v1(?![\w])`, "iu"),
  },
];

function toPosix(path) {
  return path.split(sep).join("/");
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(join(directory, entry.name));
    } else if (entry.isFile() && (SCANNED_EXTENSIONS.test(entry.name) || /^Dockerfile/u.test(entry.name))) {
      if (!TEST_FILE.test(entry.name)) yield join(directory, entry.name);
    }
  }
}

/** Returns every finding under `root` as { file, line, rule, message, text }. */
export function scanNativeRuntime(root) {
  const files = [];
  for (const name of ["package.json", "package-lock.json"]) {
    const path = join(root, name);
    if (existsSync(path)) files.push(path);
  }
  for (const name of SCANNED_DIRS) {
    const path = join(root, name);
    if (existsSync(path) && statSync(path).isDirectory()) files.push(...walk(path));
  }
  const findings = [];
  for (const path of files) {
    const file = toPosix(relative(root, path));
    if (SELF.has(file)) continue;
    const lines = readFileSync(path, "utf8").split(/\r?\n/u);
    lines.forEach((text, index) => {
      for (const rule of RULES) {
        if (rule.files && !rule.files.test(file)) continue;
        if (rule.pattern.test(text)) {
          findings.push({ file, line: index + 1, rule: rule.id, message: rule.message, text: text.trim().slice(0, 160) });
        }
      }
    });
  }
  return findings;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
  const findings = scanNativeRuntime(root);
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}: ${finding.message} [${finding.rule}]\n    ${finding.text}`);
    }
    console.error(`\nnative runtime check failed: ${findings.length} finding(s). DéjàML must not depend on OpenClaw or a localhost model bridge.`);
    process.exit(1);
  }
  console.log("native runtime check passed: no OpenClaw or localhost-bridge paths in production code.");
}
