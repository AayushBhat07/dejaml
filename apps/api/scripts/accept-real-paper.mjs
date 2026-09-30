// Real-model acceptance run.
//
// Uploads a real paper to a running DéjàML API whose server environment holds a
// real provider key (DEJAML_OPENAI_API_KEY or DEJAML_ANTHROPIC_API_KEY), follows
// the study to the end, checks the evidence the native agents produced, and
// writes a sanitized acceptance report. Nothing here is scripted: the agents are
// driven by the configured model through DéjàML's own provider adapters. This
// script never reads, sends, or prints a key; the browser path it uses cannot
// carry one.
//
// Usage (the API must already be running, for example `npm run start:local`):
//   node apps/api/scripts/accept-real-paper.mjs <case.json> [paper.pdf]
//
//   acceptance/cases/pyts-boss-gunpoint.json          positive case (paper included)
//   acceptance/cases/ccs-reproducibility-survey.json  negative case (pass its PDF)
//
// Environment (all optional):
//   DEJAML_ACCEPT_API       API base (default http://127.0.0.1:8787/api)
//   DEJAML_ACCEPT_PROVIDER  provider id from /api/config (default: the first listed)
//   DEJAML_ACCEPT_MODEL     model from that provider (default: its first)
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 usage, 3 pending (no
// provider key in the API's environment).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [casePath, paperArgument] = process.argv.slice(2);
if (!casePath) {
  console.error("usage: node apps/api/scripts/accept-real-paper.mjs <case.json> [paper.pdf]");
  process.exit(2);
}
const acceptanceCase = JSON.parse(await readFile(resolve(casePath), "utf8"));
const paperPath = paperArgument ? resolve(paperArgument) : acceptanceCase.paper.file ? join(projectRoot, acceptanceCase.paper.file) : null;
if (!paperPath) {
  console.error(`${acceptanceCase.caseId} does not include its paper; pass the PDF path as the second argument.`);
  process.exit(2);
}
const paper = await readFile(paperPath);
const paperSha256 = createHash("sha256").update(paper).digest("hex");
if (acceptanceCase.paper.sha256 && acceptanceCase.paper.sha256 !== paperSha256) {
  console.error(`The paper's SHA-256 ${paperSha256} does not match the case's ${acceptanceCase.paper.sha256}.`);
  process.exit(2);
}

const api = (process.env.DEJAML_ACCEPT_API ?? "http://127.0.0.1:8787/api").replace(/\/$/u, "");
let config;
try {
  config = await (await fetch(`${api}/config`)).json();
} catch (error) {
  console.error(
    `The API at ${api} is not reachable (${error instanceof Error ? error.message : String(error)}). Start it first: npm run start:local`,
  );
  process.exit(2);
}
const provider = config.providers.find((item) => item.id === (process.env.DEJAML_ACCEPT_PROVIDER ?? config.providers[0]?.id));
if (!provider) {
  console.error(
    [
      "PENDING: the API lists no model provider, so no real-model run can start.",
      "Put a key in the API's own environment (never in the browser or this script), restart it, and run this again:",
      "  export DEJAML_ANTHROPIC_API_KEY=…   # or DEJAML_OPENAI_API_KEY=… with DEJAML_OPENAI_MODELS=…",
      "  npm run build && npm run start:local",
      `  node apps/api/scripts/accept-real-paper.mjs ${casePath}${paperArgument ? ` ${paperArgument}` : ""}`,
    ].join("\n"),
  );
  process.exit(3);
}
if (!["openai", "anthropic", "custom"].includes(provider.id)) {
  console.error(
    `Provider ${provider.id} is not a real model provider; acceptance needs openai, anthropic, or the configured custom endpoint.`,
  );
  process.exit(2);
}
const model = process.env.DEJAML_ACCEPT_MODEL ?? provider.models[0];

const form = new FormData();
form.append("paper", new Blob([paper], { type: "application/pdf" }), basename(paperPath));
form.append("providerId", provider.id);
form.append("modelName", model);
form.append("repositoryUrl", acceptanceCase.repository.url);
const created = await fetch(`${api}/runs`, { method: "POST", body: form });
if (!created.ok) {
  console.error(`The API refused the study: ${created.status} ${await created.text()}`);
  process.exit(1);
}
const { runId } = await created.json();
const startedAt = new Date().toISOString();
console.log(`run ${runId}: ${acceptanceCase.caseId} with ${provider.id}/${model} on ${acceptanceCase.repository.url}`);

// Follow the event stream until the study finishes.
const stream = await fetch(`${api}/runs/${runId}/events`);
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let finished = false;
while (!finished) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split("\n\n");
  buffer = frames.pop() ?? "";
  for (const frame of frames) {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!data) continue;
    const event = JSON.parse(data.slice(6));
    if (event.type === "agent_turn" || event.type === "lab_telemetry") continue;
    console.log(`${event.timestamp.slice(11, 19)} ${String(event.actor).padEnd(22)} ${event.status.padEnd(9)} ${event.summary}`);
    if (event.type === "run_finished") finished = true;
  }
}
await reader.cancel().catch(() => undefined);

let report = null;
for (let attempt = 0; attempt < 30 && !report; attempt += 1) {
  const response = await fetch(`${api}/runs/${runId}/report`);
  if (response.ok) report = await response.json();
  else await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!report) {
  console.error("The report was not written.");
  process.exit(1);
}

const study = report.study;
const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
const receipts = (study?.board ?? []).filter((entry) => entry.kind === "command_receipt").map((entry) => entry.payload);
const official = receipts.filter((item) => item.official);
const engineers = study?.engineers ?? [];
const measured = engineers.find((item) => typeof item.value === "number") ?? engineers[0] ?? null;
const officialReceipt = measured?.official ? receipts.find((item) => item.receiptId === measured.official.receiptId) : official.at(-1);

// Sanitized: identifiers, digests, bounded excerpts; no prompts, hidden reasoning, keys, or environment dumps.
const acceptanceReport = {
  schemaVersion: 1,
  caseId: acceptanceCase.caseId,
  kind: acceptanceCase.kind,
  runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim() || null,
  runtime: study?.runtime ?? null,
  provider: study?.provider ?? { id: provider.id, model },
  agents: (study?.agents ?? []).map((agent) => ({
    agentId: agent.agentId,
    role: agent.role,
    label: agent.label,
    status: agent.status,
    usage: agent.usage,
  })),
  lifecycle: report.events
    .filter((event) => /^agent_(started|resumed|finished)$/u.test(event.type) || event.type.startsWith("stage_"))
    .map((event) => ({ at: event.timestamp, type: event.type, status: event.status, summary: event.summary })),
  messages: study?.messages ?? [],
  toolReceipts: study?.receipts ?? [],
  paper: { file: basename(paperPath), sha256: paperSha256, pages: study?.paper?.pages ?? null },
  repository: study?.repository ?? null,
  platform: study?.platform ?? null,
  labImage: study?.labImage ?? null,
  preparationImage: study?.dependencies?.prepImage ?? null,
  datasets: study?.datasets ?? [],
  wheels: (study?.dependencies?.packages ?? []).map((item) => ({
    name: item.name,
    version: item.version,
    filename: item.filename,
    tags: item.tags,
    sha256: item.sha256,
  })),
  compatibilityChanges: study?.dependencies?.changes ?? [],
  plan: {
    contract: study?.contract ?? null,
    planDigest: study?.planDigest ?? null,
    adapter: study?.adapter ?? null,
    policy: study?.policy ?? null,
  },
  command: study?.contract?.command ?? null,
  officialRun: officialReceipt
    ? {
        receiptId: officialReceipt.receiptId,
        argv: officialReceipt.argv,
        cwd: officialReceipt.cwd,
        exitCode: officialReceipt.exitCode,
        timedOut: officialReceipt.timedOut,
        durationMs: officialReceipt.durationMs,
        stdoutSha256: officialReceipt.stdoutSha256,
        stdoutExcerpt: officialReceipt.stdoutExcerpt,
        stderrExcerpt: officialReceipt.stderrExcerpt,
      }
    : null,
  resources: {
    limits: study?.contract ? { expectedRuntimeSeconds: study.contract.expectedRuntimeSeconds } : null,
    telemetry: report.events
      .filter((event) => event.type === "lab_telemetry")
      .slice(-5)
      .map((event) => ({ at: event.timestamp, ...event.publicPayload })),
    usage: study?.usage ?? null,
  },
  metric: {
    parser: study?.contract?.metricParser ?? null,
    paperValue: study?.result?.paperValue ?? null,
    observedValue: study?.result?.observedValue ?? null,
    delta: study?.result?.absoluteDifference ?? null,
    tolerance: study?.result?.tolerance ?? null,
  },
  reviews: engineers.map((item) => ({
    engineerAgentId: item.engineerAgentId,
    reviewerAgentId: item.reviewerAgentId,
    verdict: item.review?.verdict ?? null,
    equivalence: item.review?.equivalence ?? null,
  })),
  status: {
    final: study?.result?.status ?? report.status,
    computed: study?.result?.computedStatus ?? null,
    supervisor: study?.result?.supervisor ?? null,
    reasons: study?.result?.reasons ?? [],
  },
  cleanup: study?.cleanup ?? null,
};

const statusOk = acceptanceCase.expected.statuses.includes(acceptanceReport.status.final);
if (!study) {
  check("the native multi-agent study ran", false, report.failure ?? "the report has no study section");
} else {
  const roles = new Set(study.agents.map((agent) => agent.role));
  check(
    "real provider through DéjàML's own adapter",
    ["openai", "anthropic", "custom"].includes(study.provider.id) && study.runtime === "native autonomous agent runtime",
    `${study.provider.id}/${study.provider.model}; ${study.runtime}`,
  );
  check(
    "independent native agents",
    ["paper_analyst", "repository_analyst", "reproduction_planner", "supervisor"].every((role) => roles.has(role)) &&
      new Set(study.agents.map((agent) => agent.agentId)).size === study.agents.length,
    study.agents.map((agent) => `${agent.role} ${agent.agentId} ${agent.status}`).join("; "),
  );
  check(
    "real tool calls with receipts",
    study.receipts.length > 0 && study.receipts.every((item) => /^[a-f0-9]{64}$/u.test(item.inputSha256)),
    `${study.receipts.length} receipts`,
  );
  check(
    "repository cloned and pinned",
    /^[a-f0-9]{40}$/u.test(String(study.repository?.commitSha ?? "")),
    `${study.repository?.url ?? study.repository?.repositoryUrl}@${study.repository?.commitSha}`,
  );
  check(
    `status in ${acceptanceCase.expected.statuses.join(" / ")}`,
    statusOk,
    `${acceptanceReport.status.final}: ${acceptanceReport.status.reasons.join(" | ")}`,
  );
  if (acceptanceCase.kind === "positive") {
    check(
      "dependencies prepared as verified wheels",
      acceptanceReport.wheels.length > 0 && acceptanceReport.wheels.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256)),
      `${acceptanceReport.wheels.length} wheels`,
    );
    check(
      "reached a real offline lab",
      report.events.some((event) => event.type === "lab_create" && event.status === "completed"),
    );
    check(
      "official experiment exited 0",
      officialReceipt?.exitCode === 0,
      officialReceipt ? `${officialReceipt.argv.join(" ")} -> ${officialReceipt.exitCode}` : "no official run",
    );
    check(
      "metric produced and parsed",
      typeof acceptanceReport.metric.observedValue === "number",
      `paper ${acceptanceReport.metric.paperValue}, observed ${acceptanceReport.metric.observedValue}, delta ${acceptanceReport.metric.delta}`,
    );
    check(
      "independent review ran",
      acceptanceReport.reviews.some((item) => item.verdict !== null),
      acceptanceReport.reviews.map((item) => `${item.reviewerAgentId}: ${item.verdict} (${item.equivalence})`).join("; "),
    );
    check(
      "verdict computed from evidence",
      acceptanceReport.status.computed !== null &&
        (acceptanceReport.status.supervisor === null ||
          ["reproduced", "partially_reproduced", "not_reproduced", "inconclusive"].includes(acceptanceReport.status.final)),
    );
  }
  const leftovers = spawnSync("docker", ["ps", "-a", "--filter", `label=dejaml.run=${runId}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  check(
    "verified cleanup",
    study.cleanup.verified && leftovers.status === 0 && leftovers.stdout.trim() === "",
    `labs ${study.cleanup.labs.length}; containers left "${leftovers.stdout.trim()}"`,
  );
}
const reportText = JSON.stringify(report) + JSON.stringify(acceptanceReport);
// Keys are never read here; the report is scanned for anything shaped like one.
const secretShapes = [
  /sk-ant-[A-Za-z0-9_-]{10,}/u,
  /sk-(proj-)?[A-Za-z0-9_-]{20,}/u,
  /authorization["']?\s*[:=]/iu,
  /x-api-key/iu,
  /DEJAML_(OPENAI|ANTHROPIC|CUSTOM)_API_KEY\s*[=:]\s*\S/u,
];
check("no secret in the report", !secretShapes.some((shape) => shape.test(reportText)));
check("no OpenClaw on the path", !/openclaw/iu.test(reportText));

const outputDir = join(projectRoot, "artifacts", "acceptance");
await mkdir(outputDir, { recursive: true });
const outputPath = join(outputDir, `${acceptanceCase.caseId}-${runId}.json`);
await writeFile(outputPath, `${JSON.stringify({ ...acceptanceReport, checks }, null, 2)}\n`);

console.log("");
for (const item of checks) console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
console.log(`\nSanitized acceptance report: ${outputPath}`);
process.exit(checks.every((item) => item.pass) ? 0 : 1);
