// Real-Docker infrastructure proof of the multi-agent study.
//
// Everything is real except the model: the repository is cloned from GitHub
// and pinned by SHA, Python wheels are resolved and downloaded by the
// egress-restricted prep containers, every engineer gets its own sealed,
// offline Docker lab, and the official figure.py of
// reproducibility-sec/reproducibility runs inside it. The agents' decisions
// come from a fixed script (ScriptedProofProvider below), so this proves the
// runtime, tools, trust zones, evidence, and cleanup, NOT that a model can do
// the study. It is never an acceptance run; see accept-real-paper.mjs for that.
//
// Needs Docker, the lab image (default dejaml/lab-manager-proof:local, a
// Python 3.13 image whose user is 10001), and python:3.13.15-slim-trixie for
// the prep containers. On a machine whose outbound TLS is intercepted, set
// DEJAML_PREP_CA_BUNDLE (it defaults to /root/.ccr/ca-bundle.crt when present).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LabManager } from "@dejaml/lab-manager";
import { DependencyPreparer, loadPrepPolicy } from "@dejaml/prep";
import { RunStore } from "@dejaml/run-store";

import { runMultiAgentStudy } from "../dist/study/index.js";

const REPOSITORY = "https://github.com/reproducibility-sec/reproducibility";
const LAB_IMAGE = process.env.DEJAML_PROOF_LAB_IMAGE ?? "dejaml/lab-manager-proof:local";
const VENV_PYTHON = "/workspace/case/work/.venv/bin/python";

const inspect = spawnSync("docker", ["image", "inspect", LAB_IMAGE, "--format", "{{.Id}}"], { encoding: "utf8" });
if (inspect.status !== 0) {
  console.error(`The lab image ${LAB_IMAGE} is not present locally.`);
  process.exit(2);
}
const labImageId = inspect.stdout.trim();

const METRIC_SCRIPT = [
  "import json, pandas as pd",
  "df = pd.read_csv('work/repo/sheet1.csv')",
  "share = float((pd.to_numeric(df['Available'], errors='coerce') > 0).mean())",
  "json.dump({'metrics': {'codeAvailableShare': share, 'papers': int(len(df))}}, open('artifacts/metric.json', 'w'))",
  "print('share of papers with code available:', round(share, 4))",
].join("\n");

/** Plays each role from a fixed script; every step still goes through the real tools. */
class ScriptedProofProvider {
  id = "scripted-proof";
  kind = "scripted";
  calls = 0;

  async chat(request) {
    const role = /^You are the ([A-Za-z ]+), one independent agent/u.exec(request.system)?.[1] ?? "";
    const turn = request.messages.filter((message) => message.role === "assistant").length;
    const tools = request.messages.filter((message) => message.role === "tool");
    const last = tools.at(-1);
    let lastJson = {};
    try {
      lastJson = JSON.parse(last?.content ?? "{}");
    } catch {
      lastJson = {};
    }
    const first = request.messages[0];
    const inputs = JSON.parse(first.content.slice(first.content.indexOf("\n{") + 1));
    const calls = this.#step(role, turn, inputs, lastJson, last?.isError === true, tools);
    return {
      id: `proof_${++this.calls}`,
      provider: this.id,
      model: request.model,
      text: null,
      toolCalls: calls.map((call, index) => ({ id: `call_${this.calls}_${index}`, name: call.name, input: call.input, rawInput: JSON.stringify(call.input) })),
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: null,
      attempts: 1,
    };
  }

  #step(role, turn, inputs, last, lastFailed, tools) {
    const finish = (input) => [{ name: "finish", input }];
    switch (role) {
      case "Supervisor":
        return [["analysis", "plan", "engineering", "review"][turn]].filter(Boolean).map((stage) => ({ name: "delegate", input: { stage, objective: `Run the ${stage} stage.` } }))
          .concat(turn >= 4 ? finish({ proposedStatus: "inconclusive", rationale: "Scripted infrastructure proof; no model judged the evidence." }) : []);
      case "Paper Analyst":
        if (turn === 0) return [{ name: "paper_read_page", input: { page: 1 } }];
        return finish({
          schemaVersion: 1,
          status: "ready",
          summary: "Placeholder claim for the infrastructure proof (not read from the real paper).",
          selectedRepositoryUrl: REPOSITORY,
          claim: {
            experimentLabel: "INFRASTRUCTURE PROOF placeholder: share of surveyed papers with code available",
            dataset: "sheet1.csv survey",
            split: null,
            model: "survey statistics",
            metric: { name: "code available share", unit: "fraction", reportedValue: 0.5 },
            seed: null,
            hyperparameters: {},
            evidence: [{ kind: "paper_page", reference: "page 1", excerpt: "placeholder claim" }],
            missingFields: ["the real paper was not provided to this proof"],
            confidence: "low",
          },
          reasons: [],
          warnings: ["placeholder claim; this run proves infrastructure only"],
        });
      case "Repository Analyst":
        if (turn === 0) return [{ name: "repo_acquire", input: { repositoryUrl: inputs.repositoryCandidates[0].url } }];
        if (turn === 1) return [{ name: "dependency_discover", input: {} }];
        if (turn === 2) return [{ name: "repo_read", input: { path: "README.md" } }];
        return finish({
          status: "ready",
          summary: "figure.py reads sheet1.csv and artifact.csv from its working directory and writes Figure2-9.pdf there.",
          entrypoints: [{ path: "figure.py", why: "README: Run figure.py" }],
          dataFiles: [{ path: "sheet1.csv", why: "survey data" }, { path: "artifact.csv", why: "Figure 8 data" }],
          dependencyFiles: ["requirements.txt"],
          metricSources: [{ path: "figure.py", description: "computes the plotted shares" }],
          runInstructions: "pip install -r requirements.txt; python figure.py (from the repository directory)",
          warnings: ["requirements.txt pins 2020-era versions for Python 3.9"],
        });
      case "Reproduction Planner": {
        const pinned = ["numpy==1.19.5", "pandas==1.2.0", "matplotlib==3.3.3", "seaborn==0.11.1"];
        if (turn === 0) return [{ name: "dependency_resolvePython", input: { requirements: pinned } }];
        if (turn === 1) return [{ name: "dependency_resolvePython", input: { requirements: ["numpy", "pandas", "matplotlib", "seaborn"] } }];
        if (turn === 2) return [{ name: "dependency_downloadWheels", input: {} }];
        const firstFailure = JSON.parse(tools[0]?.content ?? "{}");
        return finish({
          status: "ready",
          summary: "Install current wheels for figure.py's imports, run figure.py from a writable copy, and compute the share from sheet1.csv.",
          target: { experimentLabel: "INFRASTRUCTURE PROOF placeholder: share of surveyed papers with code available", metric: "code available share", unit: "fraction", reportedValue: 0.5 },
          officialEntrypoint: { path: "figure.py", why: "the repository's figure script" },
          steps: ["Install the wheelhouse offline", "Copy the repository into work/", "Run figure.py", "Compute the share with an adapter"],
          environment: {
            requested: ["numpy", "pandas", "matplotlib", "seaborn"],
            manifestPrepared: true,
            deviations: [`pinned versions have no Python 3.13 wheels (${firstFailure.code ?? "resolution failed"} for ${firstFailure.requirement ?? "numpy"}); unpinned current versions used`],
          },
          datasets: [{ name: "sheet1.csv", source: "repository", location: "repo/sheet1.csv" }],
          metricExtraction: "metrics.codeAvailableShare in artifacts/metric.json",
          adapterExpected: true,
          adapterJustification: "figure.py only plots; the adapter computes the plotted share as JSON.",
          risks: ["newer pandas and matplotlib versions"],
          blockedReason: null,
        });
      }
      case "Lab Engineer": {
        const script = [
          [{ name: "dependency_installOffline", input: {} }],
          [{ name: "lab_run", input: { argv: [VENV_PYTHON, "repo/figure.py"], env: { MPLCONFIGDIR: "/tmp/mpl" }, timeoutSeconds: 300 } }],
        ];
        if (turn < script.length) return script[turn];
        if (turn === 2 && lastFailed) return [{ name: "request_debugging", input: { question: "figure.py failed; why?", receiptIds: [last.receiptId].filter(Boolean) } }];
        if (turn === 3) return [{ name: "lab_run", input: { argv: ["cp", "-r", "repo", "work/repo"] } }];
        if (turn === 4) return [{ name: "lab_run", input: { argv: [VENV_PYTHON, "figure.py"], cwd: "work/repo", env: { MPLCONFIGDIR: "/tmp/mpl" }, timeoutSeconds: 600 } }];
        if (turn === 5) return [{ name: "lab_write_file", input: { path: "work/metric.py", content: METRIC_SCRIPT } }];
        if (turn === 6) return [{ name: "lab_run", input: { argv: [VENV_PYTHON, "work/metric.py"] } }];
        if (turn === 7) return [{ name: "dependency_inspectEnvironment", input: {} }];
        const produced = tools.map((tool) => { try { return JSON.parse(tool.content); } catch { return {}; } })
          .filter((item) => item.exitCode === 0 && Array.isArray(item.artifacts) && item.artifacts.some((artifact) => artifact.path === "artifacts/metric.json"))
          .at(-1);
        return finish({
          status: produced ? "measured" : "not_measured",
          summary: "Ran the official figure.py from a writable copy, then computed the share of papers with code from sheet1.csv.",
          metricFile: produced ? "artifacts/metric.json" : null,
          metricKey: produced ? "metrics.codeAvailableShare" : null,
          unit: produced ? "fraction" : null,
          producingReceiptId: produced?.receiptId ?? null,
          officialCodeRan: true,
          officialCommands: ["python figure.py"],
          adapters: [{ path: "work/metric.py", why: "figure.py plots but writes no number", source: "figure.py Available handling and sheet1.csv", differences: ["computes the share directly instead of reading it from a figure"], changesEvidenceEquivalence: false }],
          deviations: ["current numpy/pandas/matplotlib/seaborn instead of the 2020 pins"],
          failureReason: produced ? null : "the metric script did not run",
        });
      }
      case "Debugger":
        if (turn === 0) return [{ name: "lab_search", input: { path: "repo", pattern: "read_csv" } }];
        return finish({
          diagnosis: "figure.py opens sheet1.csv relative to the working directory and writes its PDFs there; the repository is read-only.",
          rootCause: "working directory",
          suggestedFix: "Copy the repository into work/ and run figure.py from that copy.",
          fixableInLab: true,
          changesMethodology: false,
        });
      case "Independent Reviewer":
        if (turn === 0) return [{ name: "board_read", input: { key: inputs.submissionKey } }];
        if (turn === 1) return [{ name: "artifact_read", input: { engineerAgentId: inputs.submissionKey, path: "artifacts/metric.json" } }];
        return finish({
          verdict: "reject",
          equivalence: "not_equivalent",
          summary: "The claim is a placeholder, and the number comes from an adapter rather than a value the paper's code reports.",
          checks: [
            { name: "official code ran", passed: true, explanation: "figure.py exited 0 in the lab" },
            { name: "metric from the run", passed: true, explanation: "metric.json was written by the metric script's receipt" },
            { name: "claim matches the paper", passed: false, explanation: "the claim is a placeholder, not read from the paper" },
          ],
          concerns: ["infrastructure proof only"],
        });
      default:
        return [{ name: "give_up", input: { reason: `unscripted role ${role}` } }];
    }
  }
}

const results = [];
const check = (name, pass, info = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${info ? `\n      ${info}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "dejaml-study-proof-"));
const store = new RunStore(join(root, "runs.sqlite"));
const labs = new LabManager({ labRoot: join(root, "labs"), events: (event) => store.appendEvent(event) });
const prepEnv = { ...process.env };
if (!prepEnv.DEJAML_PREP_CA_BUNDLE && existsSync("/root/.ccr/ca-bundle.crt")) prepEnv.DEJAML_PREP_CA_BUNDLE = "/root/.ccr/ca-bundle.crt";
const prep = new DependencyPreparer({ cacheDir: join(root, "prep-cache"), policy: loadPrepPolicy(prepEnv), workRoot: join(root, "prep-tmp") });
const run = store.createRun({ fileName: "stand-in.pdf", bytes: 1 });
store.transitionRun(run.id, "ingesting");
store.transitionRun(run.id, "discovering_repository");
const paper = {
  schemaVersion: 1,
  file: { originalName: "stand-in.pdf", bytes: 1, sha256: "0".repeat(64) },
  pageCount: 1,
  pages: [{ pageNumber: 1, text: "INFRASTRUCTURE PROOF stand-in page; the real paper is not used here. Code: https://github.com/reproducibility-sec/reproducibility", charCount: 120 }],
  totalTextChars: 120,
  warnings: [],
};

const started = Date.now();
const result = await runMultiAgentStudy(
  {
    runId: run.id,
    paper,
    candidates: [{ repositoryUrl: REPOSITORY, owner: "reproducibility-sec", name: "reproducibility", occurrences: [{ pageNumber: 1, rawUrl: REPOSITORY }] }],
    signal: new AbortController().signal,
  },
  {
    store,
    labs,
    prep,
    config: {
      image: { name: LAB_IMAGE, expectedImageId: labImageId },
      resources: { cpus: 2, memoryMb: 3072, pids: 256, timeoutSeconds: 900, networkDuringRun: false },
      engineers: 2,
      provider: { id: "scripted-proof", model: "none" },
      datasetPolicy: { allowedHosts: [], maxRedirects: 3, maxBytes: 1024, timeoutMs: 1000 },
      maxStudyMs: 40 * 60_000,
      commandTimeoutSeconds: 900,
      maxDelegations: 8,
    },
    chatProvider: new ScriptedProofProvider(),
    workRoot: join(root, "work"),
  },
);
const study = result.report;
console.log(`run ${run.id} finished in ${Math.round((Date.now() - started) / 1000)} s; result ${study.result.status}; run status ${store.getRun(run.id).status}`);

const agents = study.agents;
check("separate agent instances", new Set(agents.map((agent) => agent.agentId)).size === agents.length && agents.length >= 9,
  agents.map((agent) => `${agent.roleLabel}${agent.label ? ` (${agent.label})` : ""} ${agent.agentId} ${agent.status}`).join("\n      "));
check("repository cloned and pinned", /^[a-f0-9]{40}$/u.test(String(study.repository?.commitSha)), `${study.repository?.repositoryUrl}@${study.repository?.commitSha} files=${study.repository?.fileCount} manifest=${study.repository?.manifestSha256}`);
const discovery = study.board.find((entry) => entry.kind === "dependency_report");
check("dependency discovery", Boolean(discovery), JSON.stringify(discovery?.payload.files));
const failure = study.dependencies.failures[0];
check("pinned numpy fails as a typed error", failure?.code === "no_compatible_wheel", JSON.stringify(failure));
const manifest = study.dependencies.manifest;
check("controlled wheel download", Boolean(manifest && manifest.packages.length > 0 && manifest.proxyLog.download.every((entry) => entry.allowed !== false)),
  `${manifest?.packages.map((item) => `${item.name}==${item.version}`).join(", ")} manifest=${study.dependencies.manifestSha256}`);
const receipts = study.board.filter((entry) => entry.kind === "command_receipt").map((entry) => entry.payload);
check("offline install in each lab", receipts.filter((item) => item.argv.some((arg) => arg.includes("--no-index")) && item.exitCode === 0).length === 2);
const figureRuns = receipts.filter((item) => item.argv.some((arg) => arg.endsWith("figure.py")));
check("official code failed first, then ran", figureRuns.some((item) => item.exitCode !== 0) && figureRuns.some((item) => item.exitCode === 0),
  figureRuns.map((item) => `${item.lab}: ${item.argv.join(" ")} (cwd ${item.cwd}) -> ${item.exitCode}`).join("\n      "));
check("separate Debugger agents diagnosed the failure", agents.filter((agent) => agent.role === "debugger").length === 2 && study.board.filter((entry) => entry.kind === "diagnosis").length === 2);
check("evidence captured", study.engineers.every((item) => item.provenance.ok && item.metricArtifact !== null),
  study.engineers.map((item) => `${item.label}: ${item.rawValue} from ${item.metricArtifact?.path} sha256=${item.metricArtifact?.sha256}`).join("\n      "));
check("independent review", study.engineers.every((item) => item.review?.verdict === "reject"));
check("accurate status (placeholder claim is never reproduced)", study.result.status === "inconclusive", study.result.reasons.join(" | "));
const leftovers = spawnSync("docker", ["ps", "-a", "--filter", `label=dejaml.run=${run.id}`, "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim();
const networks = spawnSync("docker", ["network", "ls", "--filter", `label=dejaml.run=${run.id}`, "--format", "{{.Name}}"], { encoding: "utf8" }).stdout.trim();
const labDirs = await readdir(join(root, "labs")).catch(() => []);
const prepTmp = await readdir(join(root, "prep-tmp")).catch(() => []);
const workLeft = (await readdir(join(root, "work"))).filter((name) => name !== "exports");
check("verified destruction", study.cleanup.verified && leftovers === "" && networks === "" && labDirs.length === 0 && prepTmp.length === 0 && workLeft.length === 0,
  `labs=${study.cleanup.labs.map((item) => item.verifiedAbsent).join(",")} wheelhouseRemoved=${study.cleanup.wheelhouseRemoved} containers="${leftovers}" networks="${networks}" labDirs=${labDirs.length} prepTmp=${prepTmp.length} work=${workLeft.join(",")}`);
check("no live agents", study.cleanup.liveAgents.length === 0 && agents.every((agent) => !["created", "running", "waiting"].includes(agent.status)));

store.close();
await rm(root, { recursive: true, force: true });
const failed = results.filter((item) => !item.pass);
console.log(failed.length === 0 ? `\nAll ${results.length} checks passed (scripted agents; infrastructure proof only).` : `\n${failed.length} check(s) failed.`);
process.exit(failed.length === 0 ? 0 : 1);
