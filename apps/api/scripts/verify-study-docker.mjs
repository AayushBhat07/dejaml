// Real-Docker infrastructure proof of the multi-agent study, on a real paper.
//
// Everything is real except the model: the case's paper is ingested from its
// PDF and matched to the server's reviewed claim target, the official
// repository is cloned from GitHub and pinned by SHA, the lab image is made
// ready by digest for the selected platform, Python wheels are resolved and
// downloaded by the egress-restricted prep containers, a download dataset is
// fetched from its allowlisted host and checked against its reviewed hash, and
// the planned command runs in a sealed, offline Docker lab. The agents'
// decisions come from the case's `scriptedProof` answers (ScriptedProofProvider
// below), so this proves the runtime, the stage machine, the tools, the trust
// zones, the evidence and the cleanup. It does NOT prove that a model can do
// the study, and it never counts as an acceptance run; see
// accept-real-paper.mjs for that.
//
// Needs Docker, git access to GitHub, access to the package index for the prep
// containers, and, for a case with a download dataset, HTTPS access to that
// dataset's host. Base images are used by digest. On a machine whose outbound
// TLS is intercepted, set DEJAML_PREP_CA_BUNDLE (it defaults to
// /root/.ccr/ca-bundle.crt when present).
//
//   npm run build && node apps/api/scripts/verify-study-docker.mjs [case.json] [paper.pdf]
//
//   acceptance/cases/pyts-boss-gunpoint.json              default; paper included
//   acceptance/cases/urban-land-cover-random-forest.json  pass the arXiv PDF
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { platformFromEnv } from "@dejaml/contracts";
import { ImageReadiness, LabManager, loadBaseImageLock } from "@dejaml/lab-manager";
import { ingestPdf } from "@dejaml/paper-intake";
import { DependencyPreparer, loadCompatibilityConstraints, loadPrepPolicy } from "@dejaml/prep";
import { DEFAULT_DATASET_POLICY } from "@dejaml/net-guard";
import { RunStore } from "@dejaml/run-store";

import {
  checkTargetPaper,
  loadReviewedTargets,
  localDatasetPort,
  preparerPort,
  readinessLabImagePort,
  runMultiAgentStudy,
} from "../dist/study/index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [caseArgument, paperArgument] = process.argv.slice(2);
const casePath = resolve(caseArgument ?? join(projectRoot, "acceptance/cases/pyts-boss-gunpoint.json"));
const acceptance = JSON.parse(await readFile(casePath, "utf8"));
const SCRIPT = acceptance.scriptedProof;
if (!acceptance.reviewedCaseId || !SCRIPT) {
  console.error(`${acceptance.caseId} has no reviewed target or no scriptedProof answers.`);
  process.exit(2);
}
const paperPath = paperArgument ? resolve(paperArgument) : acceptance.paper.file ? join(projectRoot, acceptance.paper.file) : null;
if (!paperPath || !existsSync(paperPath)) {
  console.error(
    `${acceptance.caseId} does not include its paper; pass the PDF (${acceptance.paper.source ?? "see the case"}) as the second argument.`,
  );
  process.exit(2);
}
// The server's reviewed claim target for this case, as the API resolves it from the id.
const TARGET = (await loadReviewedTargets(join(projectRoot, "config/reviewed-targets"), projectRoot)).get(acceptance.reviewedCaseId);
const REPOSITORY = acceptance.repository.url;
const [OWNER, NAME] = new URL(REPOSITORY).pathname.slice(1).split("/");
const TRUSTED = (await loadCompatibilityConstraints(join(projectRoot, "config/compatibility-constraints.txt"))).map((item) => ({
  requirement: item.spec,
  reason: item.reason,
}));
// A download dataset may come only from its own host; nothing else is allowlisted.
const datasetSource = TARGET?.dataset.source;
const DATASET_POLICY = {
  ...DEFAULT_DATASET_POLICY,
  allowedHosts: datasetSource?.kind === "download" ? [new URL(datasetSource.url).hostname] : [],
};
const PYTHON = SCRIPT.plan.python;

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
      toolCalls: calls.map((call, index) => ({
        id: `call_${this.calls}_${index}`,
        name: call.name,
        input: call.input,
        rawInput: JSON.stringify(call.input),
      })),
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
        if (inputs.resultKind === "verdict")
          return finish({ proposedStatus: inputs.computedStatus, rationale: "Scripted infrastructure proof: keeps the computed status." });
        return finish({ action: "continue", reason: "none", guidance: "" });
      case "Paper Analyst":
        if (turn === 0) return [{ name: "paper_read_page", input: { page: SCRIPT.paperAnalyst.claim.page } }];
        return finish({
          status: "ready",
          summary: SCRIPT.paperAnalyst.summary,
          selectedRepositoryUrl: REPOSITORY,
          claim: SCRIPT.paperAnalyst.claim,
          reasons: [],
        });
      case "Repository Analyst":
        if (turn === 0) return [{ name: "repo_acquire", input: { repositoryUrl: inputs.repositoryCandidates?.[0]?.url ?? REPOSITORY } }];
        if (turn === 1) return [{ name: "repo_list", input: { path: SCRIPT.repositoryAnalyst.listPath } }];
        return finish({
          status: "ready",
          summary: SCRIPT.repositoryAnalyst.summary,
          entrypoints: SCRIPT.repositoryAnalyst.entrypoints,
          dataFiles: [],
          dependencyFiles: [],
          metricSources: SCRIPT.repositoryAnalyst.metricSources,
          runInstructions: SCRIPT.repositoryAnalyst.runInstructions,
          warnings: SCRIPT.repositoryAnalyst.warnings,
        });
      case "Reproduction Planner": {
        if (turn === 0) return [{ name: "board_read", input: { kinds: ["paper_claim", "repository_mapping"] } }];
        const { compatibilityConstraints, ...plan } = SCRIPT.plan;
        return finish({
          status: "ready",
          blockedReason: null,
          ...plan,
          requirements: acceptance.environment.wheels,
          // Each constraint must come from the project's trusted file, with its reason.
          compatibilityConstraints: compatibilityConstraints.map(
            (spec) => TRUSTED.find((item) => item.requirement === spec) ?? { requirement: spec, reason: "missing from the trusted file" },
          ),
          // The reviewed adapter, by id: code substitutes the hash-checked file.
          adapter: { reviewedAdapterId: inputs.reviewedTarget?.reviewedAdapter?.id ?? "missing" },
        });
      }
      case "Lab Engineer":
        if (turn === 0) return [{ name: "lab_run_official", input: {} }];
        if (lastFailed && typeof last.receiptId === "string" && turn < 3) {
          return [{ name: "request_debugging", input: { question: "The approved run failed; why?", receiptIds: [last.receiptId] } }];
        }
        if (typeof last.diagnosis === "string") return [{ name: "lab_run_official", input: {} }];
        if (typeof last.receiptId === "string" && last.exitCode === 0) {
          return finish({
            status: "measured",
            summary: "Ran the approved command.",
            officialReceiptId: last.receiptId,
            deviations: [],
            failureReason: null,
          });
        }
        return finish({
          status: "not_measured",
          summary: "The approved command did not succeed.",
          officialReceiptId: null,
          deviations: [],
          failureReason: "the approved command did not succeed",
        });
      case "Debugger":
        if (turn === 0) return [{ name: "lab_logs", input: {} }];
        return finish({
          diagnosis: "See the logs.",
          rootCause: "unknown",
          suggestedFix: "Run the approved command again.",
          fixableWithoutChangingThePlan: true,
          changesMethodology: false,
        });
      case "Independent Reviewer":
        if (turn === 0) return [{ name: "board_read", input: { key: String(inputs.submissionKey ?? "") } }];
        return finish({ verdict: "approve", ...SCRIPT.review });
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
const preparer = new DependencyPreparer({
  cacheDir: join(root, "prep-cache"),
  policy: loadPrepPolicy(prepEnv),
  workRoot: join(root, "prep-tmp"),
  imageProvider: readiness,
});
const run = store.createRun({ fileName: basename(paperPath), bytes: 1 });
store.transitionRun(run.id, "ingesting");
store.transitionRun(run.id, "discovering_repository");
const paper = await ingestPdf({ fileName: basename(paperPath), data: new Uint8Array(await readFile(paperPath)) });
check(
  "paper ingested from the real PDF and matched to the reviewed target",
  paper.file.sha256 === acceptance.paper.sha256 &&
    TARGET !== undefined &&
    checkTargetPaper(TARGET, { sha256: paper.file.sha256, pages: paper.pages }) === null,
  `sha256 ${paper.file.sha256}, ${paper.pageCount} pages; target ${TARGET?.caseId}`,
);

const started = Date.now();
const result = await runMultiAgentStudy(
  {
    runId: run.id,
    paper,
    candidates: [{ repositoryUrl: REPOSITORY, owner: OWNER, name: NAME, occurrences: [{ pageNumber: 1, rawUrl: REPOSITORY }] }],
    signal: new AbortController().signal,
    target: TARGET,
  },
  {
    store,
    labs,
    dependencies: preparerPort(preparer),
    images: readinessLabImagePort({
      readiness,
      lock: await loadBaseImageLock(join(projectRoot, "lab-images/python-base/bases.lock.json")),
      contextDir: join(projectRoot, "lab-images/python-base"),
    }),
    datasets: DATASET_POLICY.allowedHosts.length ? localDatasetPort(DATASET_POLICY) : null,
    config: {
      platform,
      resources: { cpus: 2, memoryMb: 4096, pids: 256, timeoutSeconds: 1800, networkDuringRun: false },
      engineers: 1,
      provider: { id: "scripted-proof", model: "none" },
      datasetPolicy: DATASET_POLICY,
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
console.log(
  `run ${run.id} finished in ${Math.round((Date.now() - started) / 1000)} s; result ${study.result.status} (computed ${study.result.computedStatus}); run status ${store.getRun(run.id).status}`,
);

const agents = study.agents;
const roles = new Set(agents.map((agent) => agent.role));
check(
  "separate agent instances for every role",
  new Set(agents.map((agent) => agent.agentId)).size === agents.length &&
    ["paper_analyst", "repository_analyst", "reproduction_planner", "lab_engineer", "independent_reviewer", "supervisor"].every((role) =>
      roles.has(role),
    ),
  agents.map((agent) => `${agent.roleLabel}${agent.label ? ` (${agent.label})` : ""} ${agent.agentId} ${agent.status}`).join("\n      "),
);
const firstTurn = (role) =>
  JSON.stringify(store.ledger.listTurns(agents.find((agent) => agent.role === role)?.agentId ?? "none")[0] ?? null);
check(
  "the reviewed target reached the analysts and the Planner only",
  study.reviewedTarget?.caseId === acceptance.reviewedCaseId &&
    ["paper_analyst", "repository_analyst", "reproduction_planner"].every((role) => firstTurn(role).includes("reviewedTarget")) &&
    ["lab_engineer", "independent_reviewer", "supervisor"].every((role) => !firstTurn(role).includes("reviewedTarget")),
  `target ${study.reviewedTarget?.caseId}; adapter ${study.adapter?.sha256}`,
);
check(
  "stages ran in order, once each",
  ["analyzing_paper", "analyzing_repository", "reconciling", "policy_review", "preparing", "executing", "reviewing"].every(
    (stage) => study.stages.find((item) => item.stage === stage)?.status === "completed",
  ),
  study.stages.map((item) => `${item.stage}:${item.status}#${item.attempt}`).join(" "),
);
check(
  "repository cloned and pinned",
  study.repository?.commitSha === acceptance.repository.commitSha,
  `${study.repository?.url ?? study.repository?.repositoryUrl}@${study.repository?.commitSha}`,
);
check(
  "claim contract reconciled and policy-approved",
  study.policy?.outcome === "approved" && /^[a-f0-9]{64}$/u.test(study.planDigest ?? ""),
  `plan digest ${study.planDigest}; warnings: ${study.policy?.warnings.join(" | ")}`,
);
check(
  "lab image ready for the platform",
  study.labImage?.containerPlatform === platform.containerPlatform && study.labImage?.python === PYTHON,
  `${study.labImage?.name} ${study.labImage?.imageId} digest ${study.labImage?.digest}`,
);
const packages = study.dependencies?.packages ?? [];
const arch = platform.architecture === "amd64" ? "x86_64" : "aarch64";
check(
  "wheels prepared, hashed and matched to the platform",
  acceptance.environment.wheels.every((pin) =>
    packages.some((item) => `${item.name}==${item.version}`.toLowerCase() === pin.toLowerCase()),
  ) && packages.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256) && (item.tags.includes(arch) || item.tags.endsWith("-any"))),
  packages.map((item) => `${item.name}==${item.version} ${item.tags} ${item.sha256.slice(0, 12)}`).join("\n      "),
);
const reviewedSource = TARGET?.dataset.source;
check(
  reviewedSource?.kind === "download"
    ? "dataset downloaded from its allowlisted host, checksum verified"
    : "dataset identified by its wheel",
  reviewedSource?.kind === "download"
    ? study.datasets.some(
        (item) => item.requestedUrl === reviewedSource.url && item.sha256 === reviewedSource.sha256 && item.checksumVerified,
      )
    : study.datasets.some((item) => item.requestedUrl.startsWith(`wheel:${reviewedSource?.package}-`) && item.checksumVerified),
  JSON.stringify(study.datasets),
);
const engineer = study.engineers[0];
check(
  "planned command ran offline and exited 0",
  engineer?.official?.exitCode === 0,
  `${engineer?.official?.argv.join(" ")} in ${engineer?.official?.cwd}: exit ${engineer?.official?.exitCode}, ${engineer?.official?.durationMs} ms`,
);
const expectedValue = acceptance.expected.observedValue;
check(
  `metric parsed by the lab from ${study.contract?.metricParser?.source === "json" ? study.contract.metricParser.path : "stdout"}`,
  typeof engineer?.value === "number" && (expectedValue === undefined || engineer.value === expectedValue),
  `parsed ${engineer?.value} (paper ${study.result.paperValue}, delta ${study.result.absoluteDifference})`,
);
check(
  "independent review ran",
  engineer?.review?.verdict === "approve",
  `${engineer?.reviewerAgentId}: ${engineer?.review?.verdict} (${engineer?.review?.equivalence})`,
);
check(
  `status computed from evidence (${acceptance.expected.statuses.join(" / ")}), capped by the adapter`,
  acceptance.expected.statuses.includes(study.result.status) &&
    study.result.computedStatus === study.result.status &&
    study.result.status !== "reproduced",
  `${study.result.status}: ${study.result.reasons.join(" | ")}`,
);
const leftovers = spawnSync("docker", ["ps", "-a", "--filter", `label=dejaml.run=${run.id}`, "--format", "{{.Names}}"], {
  encoding: "utf8",
}).stdout.trim();
const prepLeft = spawnSync("docker", ["ps", "-a", "--filter", "label=dejaml.prep", "--format", "{{.Names}}"], {
  encoding: "utf8",
}).stdout.trim();
const networks = spawnSync("docker", ["network", "ls", "--filter", "label=dejaml.prep", "--format", "{{.Name}}"], {
  encoding: "utf8",
}).stdout.trim();
const labDirs = await readdir(join(root, "labs")).catch(() => []);
const prepTmp = await readdir(join(root, "prep-tmp")).catch(() => []);
const workLeft = (await readdir(join(root, "work")).catch(() => [])).filter((name) => name !== "exports");
check(
  "verified destruction",
  study.cleanup.verified &&
    leftovers === "" &&
    prepLeft === "" &&
    networks === "" &&
    labDirs.length === 0 &&
    prepTmp.length === 0 &&
    workLeft.length === 0,
  `labs=${study.cleanup.labs.map((item) => item.verifiedAbsent).join(",")} dependenciesRemoved=${study.cleanup.dependenciesRemoved} containers="${leftovers}${prepLeft}" networks="${networks}" labDirs=${labDirs.length} prepTmp=${prepTmp.length} work=${workLeft.join(",")}`,
);
check(
  "no live agents",
  study.cleanup.liveAgents.length === 0 && agents.every((agent) => !["created", "running", "waiting"].includes(agent.status)),
);

store.close();
await rm(root, { recursive: true, force: true });
const failed = results.filter((item) => !item.pass);
console.log(
  failed.length === 0
    ? `\nAll ${results.length} checks passed (scripted agents; infrastructure proof only, not acceptance).`
    : `\n${failed.length} check(s) failed.`,
);
process.exit(failed.length === 0 ? 0 : 1);
