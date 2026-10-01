// Real-model acceptance run.
//
// Uploads a real paper to a running DéjàML API whose server environment holds a
// real provider key (DEJAML_OPENAI_API_KEY or DEJAML_ANTHROPIC_API_KEY, or
// DEJAML_CHEAPER_INFERENCE_API_KEY for the trusted third-party Cheaper Inference
// gateway, which is not the official Anthropic API; see acceptance-route.mjs). A case
// with `reviewedCaseId` names the server's reviewed claim target by id only (the
// claim itself lives in config/reviewed-targets on the server); other cases name
// their repository and let the agents choose the claim. It follows
// the study to the end, checks the evidence the native agents produced, and
// writes a sanitized acceptance report. Nothing here is scripted: the agents are
// driven by the configured model through DéjàML's own provider adapters. This
// script never reads, sends, or prints a key; the browser path it uses cannot
// carry one.
//
// Usage (the API must already be running, for example `npm run start:local`):
//   node apps/api/scripts/accept-real-paper.mjs <case.json> [paper.pdf]
//
//   acceptance/cases/pyts-boss-gunpoint.json              positive case (paper included)
//   acceptance/cases/urban-land-cover-random-forest.json  positive case (pass the arXiv PDF; needs
//                                                         DEJAML_DATASET_ALLOWED_HOSTS=archive.ics.uci.edu)
//   acceptance/cases/ccs-reproducibility-survey.json      negative case (pass its PDF)
//
// Environment (all optional):
//   DEJAML_ACCEPT_API       API base (default http://127.0.0.1:8787/api)
//   DEJAML_ACCEPT_PROVIDER  provider id from /api/config (default: the first listed)
//   DEJAML_ACCEPT_MODEL     model from that provider (default: its first)
//
// Before anything is uploaded, the deterministic blinding and leakage tests run
// (npm run test:blinding); the run is refused if any fails. After the study, the
// paper's target must have been sealed before any agent, revealed only after the
// observation and the blind review were locked, and verified against its
// commitment; the server's re-check of every blind agent's history and this
// script's own re-check of the report and the event stream must both pass.
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 usage, 3 pending (no
// provider key in the API's environment).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BLINDING_ORDER, compareRevealed, revealTarget, valueForms } from "../dist/study/index.js";
import { checkAcceptanceProvider, classifyAcceptanceRoute } from "./acceptance-route.mjs";

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

// No real paper runs while the deterministic leakage tests fail: they prove the blinding this run relies on.
const leakage = spawnSync("npm", ["run", "test:blinding"], { cwd: projectRoot, encoding: "utf8" });
if (leakage.status !== 0) {
  console.error(
    `Acceptance refused: the deterministic blinding and leakage tests fail (npm run test:blinding).\n${leakage.stdout.slice(-2000)}`,
  );
  process.exit(2);
}
console.log("deterministic blinding and leakage tests: passed");

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
      "  export DEJAML_ANTHROPIC_API_KEY=…   # or DEJAML_OPENAI_API_KEY=… with DEJAML_OPENAI_MODELS=…, or DEJAML_CHEAPER_INFERENCE_API_KEY=…",
      "  npm run build && npm run start:local",
      `  node apps/api/scripts/accept-real-paper.mjs ${casePath}${paperArgument ? ` ${paperArgument}` : ""}`,
    ].join("\n"),
  );
  process.exit(3);
}
// Acceptance needs a vendor's own API or the fixed trusted Cheaper Inference gateway (claude-sonnet-5.5 only):
// no custom endpoint, local bridge, other host, plain http, or stand-in model.
const health = await fetch(`${api}/health`)
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null);
const route = health?.providers?.find((item) => item.id === provider.id) ?? null;
const model = process.env.DEJAML_ACCEPT_MODEL ?? provider.models[0];
const routeClassification = classifyAcceptanceRoute({ providerId: provider.id, model, health: route });
if (!routeClassification.ok) {
  console.error(`Acceptance refused: ${routeClassification.reason}.`);
  process.exit(2);
}
console.log(`provider route: ${routeClassification.label} (${routeClassification.reason})`);
// A case whose dataset is downloaded needs its host on the server's allowlist; refuse before any tokens are spent.
const datasetHost = acceptanceCase.dataset?.allowedHost;
if (datasetHost && !(health?.datasetHosts ?? []).includes(datasetHost)) {
  console.error(
    [
      `${acceptanceCase.caseId} downloads its dataset from ${datasetHost}, which the API does not allow.`,
      `Add it to the API's environment and restart: DEJAML_DATASET_ALLOWED_HOSTS=${datasetHost}`,
    ].join("\n"),
  );
  process.exit(2);
}

const form = new FormData();
form.append("paper", new Blob([paper], { type: "application/pdf" }), basename(paperPath));
form.append("providerId", provider.id);
form.append("modelName", model);
// A reviewed case is chosen by id; the server resolves the claim. Nothing else about the claim is sent.
if (acceptanceCase.reviewedCaseId) form.append("reviewedCaseId", acceptanceCase.reviewedCaseId);
else form.append("repositoryUrl", acceptanceCase.repository.url);
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

// The paper's target, opened here from the report's own reveal record and checked against its commitment.
const blinding = study?.blinding ?? null;
let revealed = null;
let revealProblem = blinding?.reveal ? "" : "the target was never revealed";
if (blinding?.reveal && blinding.commitment) {
  try {
    revealed = revealTarget({ canonical: blinding.reveal.canonical, commitment: blinding.commitment });
  } catch (error) {
    revealProblem = error instanceof Error ? error.message : String(error);
  }
}
const phaseRecords = blinding?.records ?? [];
const recordOf = (phase) => phaseRecords.find((item) => item.phase === phase) ?? null;

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
  providerRoute: route
    ? { id: route.id, endpointHost: route.endpointHost, route: route.route ?? null, https: route.https ?? null, official: route.official }
    : null,
  providerRouteLabel: routeClassification.label,
  reviewedTarget: study?.reviewedTarget ?? null,
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
  blinding: blinding
    ? {
        commitment: blinding.commitment,
        sealedAt: blinding.sealedAt,
        // The sealed schema: the field names the commitment binds (values are in the reveal record below).
        sealedFields: revealed ? Object.keys(revealed).sort() : null,
        records: phaseRecords.map(({ sequence, phase, round, commitment, at }) => ({ sequence, phase, round, commitment, at })),
        observation: phaseRecords
          .filter((item) => item.phase === "observation_locked")
          .map((item) => ({ round: item.round, commitment: item.commitment, observation: item.record?.observation ?? null })),
        blindReview: phaseRecords
          .filter((item) => item.phase === "blind_review_locked")
          .map((item) => ({ round: item.round, commitment: item.commitment, reviews: item.record?.reviews ?? [] })),
        reveal: blinding.reveal,
        comparison: blinding.comparison,
        projection: blinding.projection,
        errors: blinding.errors,
      }
    : null,
  blindingProof: report.blindingProof ?? null,
  cleanup: study?.cleanup ?? null,
};

const statusOk = acceptanceCase.expected.statuses.includes(acceptanceReport.status.final);
if (!study) {
  check("the native multi-agent study ran", false, report.failure ?? "the report has no study section");
} else {
  const roles = new Set(study.agents.map((agent) => agent.role));
  {
    const providerCheck = checkAcceptanceProvider({ providerId: provider.id, model, health: route, study });
    check(providerCheck.name, providerCheck.pass, providerCheck.detail);
  }
  check(
    "independent native agents",
    ["paper_analyst", "repository_analyst", "reproduction_planner", "supervisor"].every((role) => roles.has(role)) &&
      new Set(study.agents.map((agent) => agent.agentId)).size === study.agents.length,
    study.agents.map((agent) => `${agent.role} ${agent.agentId} ${agent.status}`).join("; "),
  );
  const paperAgent = study.agents.find((agent) => agent.role === "paper_analyst");
  const repoAgent = study.agents.find((agent) => agent.role === "repository_analyst");
  check(
    "Paper and Repository Analysts ran concurrently",
    Boolean(paperAgent && repoAgent) &&
      repoAgent.createdAt < (paperAgent.finishedAt ?? "9") &&
      paperAgent.createdAt < (repoAgent.finishedAt ?? "9"),
    `paper analyst ${paperAgent?.createdAt}–${paperAgent?.finishedAt}; repository analyst ${repoAgent?.createdAt}–${repoAgent?.finishedAt}`,
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
  if (acceptanceCase.reviewedCaseId) {
    const target = study.reviewedTarget;
    const contract = study.contract;
    const claim = acceptanceCase.claim;
    check(
      "the reviewed claim was studied, not another one",
      target?.caseId === acceptanceCase.reviewedCaseId &&
        revealed?.caseId === acceptanceCase.reviewedCaseId &&
        revealed?.claimLocator?.page === claim.page &&
        revealed?.reportedValue === claim.reportedValue &&
        revealed?.metric?.unit === claim.unit &&
        contract?.entrypoint === acceptanceCase.repository.entrypoint,
      revealed
        ? `${contract?.method} | ${contract?.dataset?.name} | ${revealed.metric.name} | p.${revealed.claimLocator.page} ${revealed.claimLocator.location} | ${revealed.reportedValue}`
        : revealProblem,
    );
    check(
      `repository pinned to ${acceptanceCase.repository.commitSha.slice(0, 12)}`,
      study.repository?.commitSha === acceptanceCase.repository.commitSha &&
        contract?.repository?.commitSha === acceptanceCase.repository.commitSha,
      `${study.repository?.commitSha}`,
    );
    check("plan digest recorded", /^[a-f0-9]{64}$/u.test(String(study.planDigest ?? "")), String(study.planDigest));
    check(
      "platform and image identities recorded",
      Boolean(study.platform?.containerPlatform) && /^sha256:[a-f0-9]{64}$/u.test(String(study.labImage?.imageId ?? "")),
      `${study.platform?.containerPlatform} ${study.labImage?.name ?? ""} ${study.labImage?.imageId ?? ""}`,
    );
    check(
      "verified wheel manifest",
      /^[a-f0-9]{64}$/u.test(String(study.dependencies?.manifestSha256 ?? "")),
      `manifest ${study.dependencies?.manifestSha256}`,
    );
    if (acceptanceCase.expected.observedValue !== undefined)
      check(
        `parsed observed value ${acceptanceCase.expected.observedValue}`,
        acceptanceReport.metric.observedValue === acceptanceCase.expected.observedValue,
        `observed ${acceptanceReport.metric.observedValue}, paper ${acceptanceReport.metric.paperValue}`,
      );
    check(
      "independent Reviewer approved",
      acceptanceReport.reviews.some((item) => item.verdict === "approve"),
      acceptanceReport.reviews.map((item) => `${item.reviewerAgentId}: ${item.verdict}`).join("; "),
    );
  }
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
  // Blinding: the server's re-check from its stored histories, then this script's own from the report and the event stream.
  const serverProof = report.blindingProof ?? [];
  check("the server re-checked the blinding", serverProof.length >= 10, `${serverProof.length} checks`);
  for (const item of serverProof) check(`blinding: ${item.name}`, item.pass, item.info);
  check(
    "sealed commitment recomputed here from the revealed payload",
    revealed !== null && createHash("sha256").update(blinding.reveal.canonical).digest("hex") === blinding.commitment,
    revealed ? `sha256 = ${blinding.commitment}` : revealProblem,
  );
  const firsts = BLINDING_ORDER.map((phase) => recordOf(phase)?.sequence ?? -1);
  check(
    "phases in order: sealed, agents, execution, observation lock, blind review lock, reveal, comparison, final status",
    firsts.every((sequence, index) => sequence > 0 && (index === 0 || sequence > firsts[index - 1])),
    phaseRecords.map((item) => item.phase).join(" > "),
  );
  const events = report.events;
  const sealedEvent = events.find((event) => event.type === "target_sealed");
  const firstAgent = events.find((event) => event.type === "agent_started");
  const revealIndex = events.findIndex((event) => event.type === "target_revealed");
  check(
    "the sealed announcement came before any agent and carried four public fields",
    Boolean(sealedEvent && firstAgent) &&
      sealedEvent.sequence < firstAgent.sequence &&
      JSON.stringify(Object.keys(sealedEvent.publicPayload).sort()) === JSON.stringify(["caseId", "commitment", "metric", "sealedAt"]),
    sealedEvent ? Object.keys(sealedEvent.publicPayload).join(", ") : "no target_sealed event",
  );
  const forms = revealed ? valueForms(revealed.reportedValue, revealed.metric.unit) : [];
  const observedTypes = new Set(["lab_output", "observation_locked", "metric_parsed"]);
  const earlyLeaks = (revealIndex > 0 ? events.slice(0, revealIndex) : events).filter((event) => {
    const text = JSON.stringify({ summary: event.summary, payload: event.publicPayload });
    if (/"(reportedValue|paperReference|paperValue|tolerance)"\s*:\s*(?!null)/u.test(text)) return true;
    if (observedTypes.has(event.type)) return false;
    return forms.some((form) => new RegExp(`(?<![\\d.])${form.replaceAll(".", "\\.")}(?![\\d]|\\.\\d)`, "u").test(text));
  });
  check(
    "no event the browser saw before the reveal carried the target",
    revealIndex > 0 && earlyLeaks.length === 0,
    `${revealIndex} events before the reveal; ${
      forms.length ? `scanned for ${forms.join(", ")}` : "the value has no distinctive written form, so target fields were scanned"
    }${earlyLeaks.length ? `; leaked in ${earlyLeaks.map((event) => event.type).join(", ")}` : ""}`,
  );
  const comparison = blinding?.comparison ?? null;
  const recomputed = revealed && comparison ? compareRevealed(revealed, comparison.observed) : null;
  check(
    "comparison recomputed here: absolute delta within the revealed tolerance",
    recomputed !== null &&
      recomputed.absoluteDelta === comparison.absoluteDelta &&
      recomputed.withinTolerance === comparison.withinTolerance &&
      recomputed.observed === acceptanceReport.metric.observedValue,
    comparison
      ? `|${comparison.observed} − ${comparison.reported}| = ${comparison.absoluteDelta}, tolerance ${comparison.tolerance}, within ${comparison.withinTolerance}; blind verdicts ${comparison.blindVerdicts.join(", ")}`
      : "no comparison",
  );
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
  /DEJAML_(OPENAI|ANTHROPIC|CHEAPER_INFERENCE|CUSTOM)_API_KEY\s*[=:]\s*\S/u,
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
