// Real-Docker infrastructure proof of the multi-agent study, on a real paper.
//
// Everything is real except the model: the pyts paper (JMLR 2020) is ingested
// from its PDF, the official pyts-repro repository is cloned from GitHub and
// pinned by SHA, the lab image is made ready by digest for the selected
// platform, Python wheels are resolved and downloaded by the egress-restricted
// prep containers, and the official BOSS notebook runs in a sealed, offline
// Docker lab. The agents' decisions come from a fixed script
// (ScriptedProofProvider below), so this proves the runtime, the stage
// machine, the tools, the trust zones, the evidence and the cleanup. It does
// NOT prove that a model can do the study, and it never counts as an
// acceptance run; see accept-real-paper.mjs for that.
//
// Needs Docker, git access to GitHub, and access to the package index for the
// prep containers. The Python 3.11 base image is used by digest (pull it once
// with `docker pull python@sha256:e41613d4…` if it is missing). On a machine
// whose outbound TLS is intercepted, set DEJAML_PREP_CA_BUNDLE (it defaults to
// /root/.ccr/ca-bundle.crt when present).
//
//   npm run build && node apps/api/scripts/verify-study-docker.mjs
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { platformFromEnv } from "@dejaml/contracts";
import { ImageReadiness, LabManager, loadBaseImageLock } from "@dejaml/lab-manager";
import { ingestPdf } from "@dejaml/paper-intake";
import { DependencyPreparer, loadCompatibilityConstraints, loadPrepPolicy } from "@dejaml/prep";
import { RunStore } from "@dejaml/run-store";

import { preparerPort, readinessLabImagePort, runMultiAgentStudy } from "../dist/study/index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const acceptance = JSON.parse(await readFile(join(projectRoot, "acceptance/cases/pyts-boss-gunpoint.json"), "utf8"));
const ADAPTER = await readFile(join(projectRoot, "acceptance/proof/pyts_run_boss_notebook.py"), "utf8");
const REPOSITORY = acceptance.repository.url;
const TRUSTED = (await loadCompatibilityConstraints(join(projectRoot, "config/compatibility-constraints.txt"))).map((item) => ({ requirement: item.spec, reason: item.reason }));
const PIP = TRUSTED.find((item) => item.requirement.startsWith("pip"));

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
    const calls = this.#step(role, turn, inputs, lastJson, last?.isError === true);
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

  #step(role, turn, inputs, last, lastFailed) {
    const finish = (input) => [{ name: "finish", input }];
    switch (role) {
      case "Supervisor":
        if (inputs.resultKind === "verdict") return finish({ proposedStatus: inputs.computedStatus, rationale: "Scripted infrastructure proof: keeps the computed status." });
        return finish({ action: "continue", reason: "none", guidance: "" });
      case "Paper Analyst":
        if (turn === 0) return [{ name: "paper_read_page", input: { page: 4 } }];
        return finish({
          status: "ready",
          summary: "Table 2 reports BOSS + 1-NN test accuracy per dataset; pyts reaches 1.000 on GunPoint.",
          selectedRepositoryUrl: REPOSITORY,
          claim: {
            method: "BOSS transformer followed by a one-nearest-neighbor classifier with the BOSS metric",
            dataset: "UCR GunPoint",
            split: "the fixed UCR train/test split (test set)",
            preprocessing: "not stated beyond the BOSS transformation",
            seedPolicy: "not stated (the method is deterministic)",
            metric: { name: "accuracy", unit: "fraction" },
            reportedValue: 1,
            page: 4,
            location: "Table 2, row pyts, column GunPoint",
            excerpt: "pyts 0.752 0.870 1.000 0.526 1.000",
            missingFields: ["hyperparameters (in the notebook, not the PDF)"],
          },
          reasons: [],
        });
      case "Repository Analyst":
        if (turn === 0) return [{ name: "repo_acquire", input: { repositoryUrl: inputs.repositoryCandidates?.[0]?.url ?? REPOSITORY } }];
        if (turn === 1) return [{ name: "repo_list", input: { path: "0.10.0" } }];
        return finish({
          status: "ready",
          summary: "0.10.0/BOSS.ipynb fits BOSS + 1-NN on each UCR dataset in dataset_params and prints the test accuracy.",
          entrypoints: [{ path: "0.10.0/BOSS.ipynb", why: "the notebook behind Table 2 for pyts 0.10.0" }],
          dataFiles: [],
          dependencyFiles: [],
          metricSources: [{ path: "0.10.0/BOSS.ipynb", description: "prints 'Accuracy on the test set: x.xxx' per dataset" }],
          runInstructions: "Run the notebook's cells in order with pyts 0.10.0 installed.",
          warnings: ["datasets other than GunPoint are downloaded from timeseriesclassification.com at run time"],
        });
      case "Reproduction Planner":
        if (turn === 0) return [{ name: "board_read", input: { kinds: ["paper_claim", "repository_mapping"] } }];
        return finish({
          status: "ready",
          summary: "Run the official notebook's code cells unchanged, keeping only GunPoint (the other datasets need downloads the offline lab cannot make).",
          blockedReason: null,
          entrypoint: "0.10.0/BOSS.ipynb",
          command: { argv: ["python", "../work/adapter/run_boss_notebook.py", "0.10.0/BOSS.ipynb", "GunPoint"], cwd: "repo" },
          python: "3.11",
          requirements: acceptance.environment.wheels,
          // pyts 0.10.0's metadata is refused by pip 24.1+; the trusted file allows the older installer.
          compatibilityConstraints: PIP ? [PIP] : [],
          dataset: { name: "UCR GunPoint", source: { kind: "package", package: "pyts", path: "datasets/cached_datasets/UCR/GunPoint" } },
          metricParser: { source: "stdout", pattern: "Accuracy on the test set: (\\d\\.\\d{3})" },
          expectedRuntimeSeconds: 60,
          stopConditions: ["the command exits non-zero", "no accuracy line is printed"],
          adapter: {
            path: "work/adapter/run_boss_notebook.py",
            content: ADAPTER,
            why: "The notebook is not a script, and its other datasets must be downloaded, which the offline lab cannot do.",
            source: "0.10.0/BOSS.ipynb code cells, executed unchanged in order",
            differences: ["dataset_params is filtered to GunPoint after the cell that defines it"],
          },
          risks: ["newer numpy/scipy/scikit-learn/numba than the authors' Python 3.7 environment"],
        });
      case "Lab Engineer":
        if (turn === 0) return [{ name: "lab_run_official", input: {} }];
        if (lastFailed && typeof last.receiptId === "string" && turn < 3) {
          return [{ name: "request_debugging", input: { question: "The approved run failed; why?", receiptIds: [last.receiptId] } }];
        }
        if (typeof last.diagnosis === "string") return [{ name: "lab_run_official", input: {} }];
        if (typeof last.receiptId === "string" && last.exitCode === 0) {
          return finish({ status: "measured", summary: "Ran the approved command.", officialReceiptId: last.receiptId, deviations: [], failureReason: null });
        }
        return finish({ status: "not_measured", summary: "The approved command did not succeed.", officialReceiptId: null, deviations: [], failureReason: "the approved command did not succeed" });
      case "Debugger":
        if (turn === 0) return [{ name: "lab_logs", input: {} }];
        return finish({ diagnosis: "See the logs.", rootCause: "unknown", suggestedFix: "Run the approved command again.", fixableWithoutChangingThePlan: true, changesMethodology: false });
      case "Independent Reviewer":
        if (turn === 0) return [{ name: "board_read", input: { key: String(inputs.submissionKey ?? "") } }];
        return finish({
          verdict: "approve",
          equivalence: "minor_deviations",
          summary: "The official notebook cells ran unchanged; the adapter only restricts which datasets are evaluated.",
          checks: [
            { name: "official code ran", passed: true, explanation: "the approved command's receipt exited 0" },
            { name: "same dataset and metric", passed: true, explanation: "GunPoint test accuracy, as in Table 2" },
            { name: "metric from the run", passed: true, explanation: "the lab parsed the accuracy line from the official run's stdout" },
          ],
          concerns: ["an adapter selects GunPoint only"],
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
const platform = platformFromEnv(process.env, process.arch);
const readiness = new ImageReadiness();
const preparer = new DependencyPreparer({ cacheDir: join(root, "prep-cache"), policy: loadPrepPolicy(prepEnv), workRoot: join(root, "prep-tmp"), imageProvider: readiness });
const run = store.createRun({ fileName: "pyts-jmlr-2020-19-763.pdf", bytes: 1 });
store.transitionRun(run.id, "ingesting");
store.transitionRun(run.id, "discovering_repository");
const paper = await ingestPdf({ fileName: "pyts-jmlr-2020-19-763.pdf", data: new Uint8Array(await readFile(join(projectRoot, acceptance.paper.file))) });
check("paper ingested from the real PDF", paper.file.sha256 === acceptance.paper.sha256, `sha256 ${paper.file.sha256}, ${paper.pageCount} pages`);

const started = Date.now();
const result = await runMultiAgentStudy(
  {
    runId: run.id,
    paper,
    candidates: [{ repositoryUrl: REPOSITORY, owner: "johannfaouzi", name: "pyts-repro", occurrences: [{ pageNumber: 1, rawUrl: REPOSITORY }] }],
    signal: new AbortController().signal,
  },
  {
    store,
    labs,
    dependencies: preparerPort(preparer),
    images: readinessLabImagePort({ readiness, lock: await loadBaseImageLock(join(projectRoot, "lab-images/python-base/bases.lock.json")), contextDir: join(projectRoot, "lab-images/python-base") }),
    datasets: null,
    config: {
      platform,
      resources: { cpus: 2, memoryMb: 4096, pids: 256, timeoutSeconds: 1800, networkDuringRun: false },
      engineers: 1,
      provider: { id: "scripted-proof", model: "none" },
      datasetPolicy: { allowedHosts: [], maxRedirects: 3, maxBytes: 1024, timeoutMs: 1000 },
      maxStudyMs: 40 * 60_000,
      commandTimeoutSeconds: 900,
      maxReplans: 1,
      trustedConstraints: TRUSTED,
    },
    chatProvider: new ScriptedProofProvider(),
    workRoot: join(root, "work"),
  },
);
const study = result.report;
console.log(`run ${run.id} finished in ${Math.round((Date.now() - started) / 1000)} s; result ${study.result.status} (computed ${study.result.computedStatus}); run status ${store.getRun(run.id).status}`);

const agents = study.agents;
const roles = new Set(agents.map((agent) => agent.role));
check("separate agent instances for every role",
  new Set(agents.map((agent) => agent.agentId)).size === agents.length && ["paper_analyst", "repository_analyst", "reproduction_planner", "lab_engineer", "independent_reviewer", "supervisor"].every((role) => roles.has(role)),
  agents.map((agent) => `${agent.roleLabel}${agent.label ? ` (${agent.label})` : ""} ${agent.agentId} ${agent.status}`).join("\n      "));
check("stages ran in order, once each",
  ["analyzing_paper", "analyzing_repository", "reconciling", "policy_review", "preparing", "executing", "reviewing"].every((stage) => study.stages.find((item) => item.stage === stage)?.status === "completed"),
  study.stages.map((item) => `${item.stage}:${item.status}#${item.attempt}`).join(" "));
check("repository cloned and pinned", study.repository?.commitSha === acceptance.repository.commitSha, `${study.repository?.url ?? study.repository?.repositoryUrl}@${study.repository?.commitSha}`);
check("claim contract reconciled and policy-approved", study.policy?.outcome === "approved" && /^[a-f0-9]{64}$/u.test(study.planDigest ?? ""), `plan digest ${study.planDigest}; warnings: ${study.policy?.warnings.join(" | ")}`);
check("lab image ready for the platform", study.labImage?.containerPlatform === platform.containerPlatform && study.labImage?.python === "3.11", `${study.labImage?.name} ${study.labImage?.imageId} digest ${study.labImage?.digest}`);
const packages = study.dependencies?.packages ?? [];
const arch = platform.architecture === "amd64" ? "x86_64" : "aarch64";
check("wheels prepared, hashed and matched to the platform",
  acceptance.environment.wheels.every((pin) => packages.some((item) => `${item.name}==${item.version}`.toLowerCase() === pin.toLowerCase())) &&
    packages.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256) && (item.tags.includes(arch) || item.tags.endsWith("-any"))),
  packages.map((item) => `${item.name}==${item.version} ${item.tags} ${item.sha256.slice(0, 12)}`).join("\n      "));
check("dataset identified by its wheel", study.datasets.some((item) => item.requestedUrl.startsWith("wheel:pyts-0.10.0") && item.checksumVerified), JSON.stringify(study.datasets));
const engineer = study.engineers[0];
check("official notebook ran offline and exited 0", engineer?.official?.exitCode === 0, `${engineer?.official?.argv.join(" ")} in ${engineer?.official?.cwd}: exit ${engineer?.official?.exitCode}, ${engineer?.official?.durationMs} ms`);
check("metric parsed by the lab from stdout", engineer?.value === 1, `parsed ${engineer?.value} (paper ${study.result.paperValue}, delta ${study.result.absoluteDifference})`);
check("independent review ran", engineer?.review?.verdict === "approve", `${engineer?.reviewerAgentId}: ${engineer?.review?.verdict} (${engineer?.review?.equivalence})`);
check("status computed from evidence, capped by the adapter", study.result.status === "partially_reproduced" && study.result.computedStatus === "partially_reproduced", study.result.reasons.join(" | "));
const leftovers = spawnSync("docker", ["ps", "-a", "--filter", `label=dejaml.run=${run.id}`, "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim();
const prepLeft = spawnSync("docker", ["ps", "-a", "--filter", "label=dejaml.prep", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim();
const networks = spawnSync("docker", ["network", "ls", "--filter", "label=dejaml.prep", "--format", "{{.Name}}"], { encoding: "utf8" }).stdout.trim();
const labDirs = await readdir(join(root, "labs")).catch(() => []);
const prepTmp = await readdir(join(root, "prep-tmp")).catch(() => []);
const workLeft = (await readdir(join(root, "work")).catch(() => [])).filter((name) => name !== "exports");
check("verified destruction", study.cleanup.verified && leftovers === "" && prepLeft === "" && networks === "" && labDirs.length === 0 && prepTmp.length === 0 && workLeft.length === 0,
  `labs=${study.cleanup.labs.map((item) => item.verifiedAbsent).join(",")} dependenciesRemoved=${study.cleanup.dependenciesRemoved} containers="${leftovers}${prepLeft}" networks="${networks}" labDirs=${labDirs.length} prepTmp=${prepTmp.length} work=${workLeft.join(",")}`);
check("no live agents", study.cleanup.liveAgents.length === 0 && agents.every((agent) => !["created", "running", "waiting"].includes(agent.status)));

store.close();
await rm(root, { recursive: true, force: true });
const failed = results.filter((item) => !item.pass);
console.log(failed.length === 0 ? `\nAll ${results.length} checks passed (scripted agents; infrastructure proof only, not acceptance).` : `\n${failed.length} check(s) failed.`);
process.exit(failed.length === 0 ? 0 : 1);
