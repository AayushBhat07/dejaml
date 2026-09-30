// Real-model acceptance run: uploads a real paper to a running DéjàML API
// that has a real provider configured, follows the study to the end, and
// checks the evidence the agents produced. Nothing here is scripted: the
// agents are driven by the configured model.
//
// Usage (the API must already be running, for example `npm run start:local`):
//   node apps/api/scripts/accept-real-paper.mjs <paper.pdf> [repositoryUrl]
//
// Environment:
//   DEJAML_ACCEPT_API        API base (default http://127.0.0.1:8787/api)
//   DEJAML_ACCEPT_PROVIDER   provider id from /api/config (default: the first)
//   DEJAML_ACCEPT_MODEL      model from that provider (default: its first)
//   DEJAML_ACCEPT_API_KEY    only when the provider needs the uploader's key;
//                            prefer a server key set in the API's environment.
// The key is sent once with the upload and is checked to be absent from the report.
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const [paperPath, repositoryUrl = "https://github.com/reproducibility-sec/reproducibility"] = process.argv.slice(2);
if (!paperPath) {
  console.error("usage: node apps/api/scripts/accept-real-paper.mjs <paper.pdf> [repositoryUrl]");
  process.exit(2);
}
const api = (process.env.DEJAML_ACCEPT_API ?? "http://127.0.0.1:8787/api").replace(/\/$/u, "");
const key = process.env.DEJAML_ACCEPT_API_KEY;

const config = await (await fetch(`${api}/config`)).json();
const provider = config.providers.find((item) => item.id === (process.env.DEJAML_ACCEPT_PROVIDER ?? config.providers[0]?.id));
if (!provider) {
  console.error(`No such provider. Configured: ${config.providers.map((item) => item.id).join(", ") || "none"}`);
  process.exit(2);
}
const model = process.env.DEJAML_ACCEPT_MODEL ?? provider.models[0];
if (provider.keySource === "uploader" && !key) {
  console.error(`${provider.label} needs a key: set it in the API's environment, or DEJAML_ACCEPT_API_KEY for this run.`);
  process.exit(2);
}

const form = new FormData();
form.append("paper", new Blob([await readFile(paperPath)], { type: "application/pdf" }), basename(paperPath));
form.append("providerId", provider.id);
form.append("modelName", model);
form.append("repositoryUrl", repositoryUrl);
if (key) form.append("apiKey", key);
const created = await fetch(`${api}/runs`, { method: "POST", body: form });
if (!created.ok) {
  console.error(`The API refused the study: ${created.status} ${await created.text()}`);
  process.exit(1);
}
const { runId } = await created.json();
console.log(`run ${runId} with ${provider.id}/${model} on ${repositoryUrl}`);

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
    const who = event.publicPayload?.label ? `${event.actor}/${event.publicPayload.label}` : event.actor;
    console.log(`${event.timestamp.slice(11, 19)} ${who.padEnd(34)} ${event.status.padEnd(9)} ${event.summary}`);
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
const reportText = JSON.stringify(report);
await writeFile(`dejaml-acceptance-${runId}.json`, `${JSON.stringify(report, null, 2)}\n`);

const study = report.study;
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });
if (!study) {
  check("multi-agent study ran", false, report.failure ?? "the report has no study section (a reviewed case, or autonomy is off)");
} else {
  const agents = study.agents;
  const byRole = (role) => agents.filter((agent) => agent.role === role);
  const receipts = study.board.filter((entry) => entry.kind === "command_receipt").map((entry) => entry.payload);
  const entry = study.plan?.officialEntrypoint?.path ? basename(study.plan.officialEntrypoint.path) : null;
  const failedThenOk = study.engineers.some((engineer) => {
    const own = receipts.filter((item) => item.agentId === engineer.engineerAgentId);
    const firstFailure = own.findIndex((item) => item.exitCode !== 0);
    return firstFailure >= 0 && own.slice(firstFailure + 1).some((item) => item.exitCode === 0);
  });
  check("1 separate analysts", byRole("paper_analyst").length >= 1 && byRole("repository_analyst").length >= 1, agents.map((agent) => `${agent.roleLabel} ${agent.agentId} ${agent.status}`).join("; "));
  check("2 clone and SHA pinning", /^[a-f0-9]{40}$/u.test(study.repository?.commitSha ?? ""), `${study.repository?.repositoryUrl}@${study.repository?.commitSha}`);
  check("3 dependency discovery", study.board.some((item) => item.kind === "dependency_report"), "");
  check("4 controlled wheel download", Boolean(study.dependencies.manifest?.packages?.length), `manifest ${study.dependencies.manifestSha256}; failures ${JSON.stringify(study.dependencies.failures)}`);
  check("5 offline install", receipts.some((item) => item.argv.includes("--no-index") && item.exitCode === 0), "");
  check("6 offline lab", report.events.some((event) => event.type === "lab_create" && event.status === "completed"), "labs run with --network none, read-only root, non-root user, all capabilities dropped");
  check("7 official code execution", Boolean(entry) && receipts.some((item) => item.exitCode === 0 && item.argv.some((arg) => arg.endsWith(entry))), `entry point ${entry}`);
  check("8 recovery from a failure", failedThenOk || byRole("debugger").length > 0, `debuggers ${byRole("debugger").length}; failed-then-succeeded ${failedThenOk}`);
  check("9 evidence capture", Boolean(study.result.evidence?.commands?.length), `${study.result.evidence?.commands?.length ?? 0} commands, ${study.result.evidence?.artifacts?.length ?? 0} artifacts`);
  check("10 independent review", byRole("independent_reviewer").some((agent) => agent.status === "completed"), study.engineers.map((item) => `${item.label}: ${item.review?.verdict ?? "no review"} (${item.review?.equivalence ?? "-"})`).join("; "));
  check("11 status from evidence", ["reproduced", "partially_reproduced", "not_reproduced", "inconclusive", "policy_blocked"].includes(study.result.status), `${study.result.status}: ${study.result.reasons.join(" | ")}`);
  const leftovers = spawnSync("docker", ["ps", "-a", "--filter", `label=dejaml.run=${runId}`, "--format", "{{.Names}}"], { encoding: "utf8" });
  check("12 verified destruction", study.cleanup.verified && leftovers.status === 0 && leftovers.stdout.trim() === "", `labs ${study.cleanup.labs.length}, containers left: "${leftovers.stdout.trim()}"`);
  check("no key in the report", !key || !reportText.includes(key), "");
  check("infrastructure succeeded", !/internal error/iu.test(report.failure ?? ""), report.failure ?? "");

  console.log(`\nRun ${runId}\nProvider ${study.provider.id} / ${study.provider.model}\nRepository ${study.repository?.repositoryUrl}@${study.repository?.commitSha}`);
  console.log(`Dependencies ${study.dependencies.manifest ? study.dependencies.manifest.packages.map((item) => `${item.name}==${item.version}`).join(", ") : "none"}`);
  console.log(`Result ${study.result.status} (mechanical ${study.result.mechanicalStatus}; supervisor proposed ${study.result.supervisor?.proposedStatus ?? "nothing"})`);
  console.log(`Usage ${study.usage.inputTokens} input / ${study.usage.outputTokens} output tokens, cost ${study.usage.costUsd ?? "unknown"} USD, ${study.usage.toolCalls} tool calls`);
}
console.log("");
for (const item of checks) console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
console.log(`\nFull report: dejaml-acceptance-${runId}.json`);
process.exit(checks.every((item) => item.pass) ? 0 : 1);
