// Proves the autonomous Lab Agent's tools against a real Docker engine with a
// scripted model: the agent explores a read-only repository, writes its own
// adapter, survives a failed and a timed-out command, cannot escape through
// the repository, the network, or a planted symlink, and submits a metric
// that a real run produced. No model provider or dataset download is needed.
//
// With --live, a real model (DEJAML_MODEL, DEJAML_MODEL_BASE_URL,
// DEJAML_MODEL_API_KEY) drives the same lab instead of the script, and only
// the outcome is checked.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LAB_LIMITS, LabManager } from "@dejaml/lab-manager";
import { RunStore } from "@dejaml/run-store";

import { findConsensus, HostedModelClient, runAutonomousLabAgent } from "../dist/index.js";

const LIVE = process.argv.includes("--live");

const BASE_IMAGE =
  "python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b";
const PROOF_IMAGE = "dejaml/lab-manager-proof:local";

function docker(args, input) {
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

// A tiny stdlib-only "paper repository": nearest-centroid on a bundled, seeded dataset.
const MODEL_PY = String.raw`
import csv, math

def load(path):
    with open(path) as handle:
        rows = list(csv.reader(handle))[1:]
    return [([float(v) for v in row[:-1]], row[-1]) for row in rows]

def fit(rows):
    sums, counts = {}, {}
    for features, label in rows:
        acc = sums.setdefault(label, [0.0] * len(features))
        for i, value in enumerate(features):
            acc[i] += value
        counts[label] = counts.get(label, 0) + 1
    return {label: [v / counts[label] for v in acc] for label, acc in sums.items()}

def predict(centroids, features):
    return min(centroids, key=lambda label: math.dist(centroids[label], features))

def evaluate(train_path, test_path):
    centroids = fit(load(train_path))
    test = load(test_path)
    return sum(predict(centroids, f) == y for f, y in test) / len(test)
`;

function dataset(seed, count) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const lines = ["x1,x2,label"];
  for (let index = 0; index < count; index += 1) {
    const label = index % 2 === 0 ? "a" : "b";
    const centre = label === "a" ? 0 : 1.2;
    lines.push(`${(centre + random() * 1.6).toFixed(4)},${(centre + random() * 1.6).toFixed(4)},${label}`);
  }
  return `${lines.join("\n")}\n`;
}

const ADAPTER = String.raw`
import json, sys
sys.path.insert(0, "repo")
import model
accuracy = model.evaluate("repo/data/train.csv", "repo/data/test.csv")
with open("artifacts/metrics.json", "w") as handle:
    json.dump({"test_accuracy": accuracy}, handle)
print("test accuracy", accuracy)
`;

const PROBE = String.raw`
import json, os, socket
checks = {"uid": os.getuid()}
try:
    socket.create_connection(("1.1.1.1", 53), timeout=2)
    checks["network"] = "reachable"
except OSError as error:
    checks["network"] = "blocked"
for name, path in {"repoWritable": "repo/model.py", "rootWritable": "/usr/escape.txt"}.items():
    try:
        open(path, "a")
        checks[name] = True
    except OSError:
        checks[name] = False
checks["dockerSocket"] = os.path.exists("/var/run/docker.sock")
print(json.dumps(checks))
`;

const root = await mkdtemp(join(tmpdir(), "dejaml-autonomous-proof-"));
const store = new RunStore();
const report = {};
let labs;
let labId;
try {
  docker(
    ["build", "--provenance=false", "--tag", PROOF_IMAGE, "-"],
    [
      `FROM ${BASE_IMAGE}`,
      "RUN groupadd --gid 10001 dejaml && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dejaml && install -d -o 10001 -g 10001 -m 0750 /workspace/case",
      "USER 10001:10001",
      "WORKDIR /workspace/case",
    ].join("\n"),
  );
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", PROOF_IMAGE]);

  const repo = join(root, "repo");
  await mkdir(join(repo, "data"), { recursive: true });
  await writeFile(join(repo, "model.py"), MODEL_PY);
  await writeFile(join(repo, "data/train.csv"), dataset(7, 200));
  await writeFile(join(repo, "data/test.csv"), dataset(11, 100));
  const hostSecret = join(root, "host-secret.txt");
  await writeFile(hostSecret, "untouched\n");

  store.createRun({}, "run_autonomous_proof");
  labs = new LabManager({ labRoot: join(root, "labs"), events: (event) => store.appendEvent(event) });
  const handle = await labs.createLab({
    runId: "run_autonomous_proof",
    image: PROOF_IMAGE,
    expectedImageId: imageId,
    workdir: "/workspace/case",
    artifactsDir: "artifacts",
    scratchDir: "work",
    inputs: [{ hostPath: repo, containerPath: "repo" }],
    resources: { cpus: 1, memoryMb: 512, pids: 64, timeoutSeconds: 60, networkDuringRun: false },
    limits: DEFAULT_LAB_LIMITS,
  });
  labId = handle.labId;

  const actions = [
    { tool: "run", argv: ["ls", "-R", "repo"], why: "Explore the repository" },
    { tool: "write_file", path: "work/probe.py", content: PROBE, why: "Check the sandbox" },
    { tool: "run", argv: ["python", "work/probe.py"], why: "Probe isolation" },
    { tool: "run", argv: ["ln", "-s", hostSecret, "work/escape.txt"], why: "Plant a symlink to a host path" },
    { tool: "write_file", path: "work/escape.txt", content: "overwritten\n", why: "Try to write through it" },
    { tool: "run", argv: ["sleep", "30"], timeoutSeconds: 2, why: "A command that hangs" },
    { tool: "run", argv: ["python", "work/missing.py"], why: "A command that fails" },
    { tool: "write_file", path: "work/run.py", content: ADAPTER, why: "Adapter that calls the repository's model" },
    { tool: "run", argv: ["python", "work/run.py"], why: "Run the experiment" },
    {
      tool: "submit",
      metricFile: "artifacts/metrics.json",
      key: "test_accuracy",
      metricName: "accuracy",
      unit: "fraction",
      split: "test",
      dataset: "bundled toy data",
      summary: "Ran the repository's nearest-centroid model on its bundled test split.",
    },
  ];
  const observations = [];
  const scripted = {
    async complete(request) {
      if (observations.length > 0 || request.prompt.includes('"observation"')) {
        observations.push(JSON.parse(request.prompt).observation);
      } else {
        observations.push(null);
      }
      return { value: request.schema.parse(actions.shift() ?? { tool: "give_up", reason: "script ended" }) };
    },
  };

  const model = LIVE
    ? new HostedModelClient({
        baseUrl: process.env.DEJAML_MODEL_BASE_URL ?? "https://api.openai.com/v1",
        model: process.env.DEJAML_MODEL ?? "",
        ...(process.env.DEJAML_MODEL_API_KEY ? { apiKey: process.env.DEJAML_MODEL_API_KEY } : {}),
      })
    : scripted;
  const started = Date.now();
  const result = await runAutonomousLabAgent({
    runId: "run_autonomous_proof",
    labId,
    claim: {
      experimentLabel: "Nearest centroid on bundled data",
      dataset: "bundled toy data",
      split: "test",
      model: "nearest centroid",
      metric: { name: "accuracy", unit: "fraction", reportedValue: 0.9 },
      seed: 11,
      hyperparameters: {},
      evidence: [{ kind: "paper_page", reference: "page 1" }],
      missingFields: [],
      confidence: "high",
    },
    mapping: null,
    layout: { workdir: "/workspace/case", repoDir: "repo", scratchDir: "work", artifactsDir: "artifacts" },
    labs,
    model,
    store,
    budget: LIVE ? { maxSteps: 20, wallSeconds: 600, commandTimeoutSeconds: 30 } : { maxSteps: 15, wallSeconds: 180, commandTimeoutSeconds: 30 },
  });
  if (LIVE) {
    report.transcript = result.transcript.map((entry) => ({ step: entry.step, action: entry.action, exitCode: entry.observation.exitCode }));
    assert(result.status === "submitted", `agent submitted (got ${result.status}: ${result.reason})`);
    report.metric = JSON.parse(result.artifact.content.toString("utf8"));
    const receipt = await labs.destroyLab(labId, "live proof finished");
    labId = null;
    assert(receipt.verifiedAbsent, "lab removed");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\nAutonomous Lab Agent live proof passed.\n`);
    process.exit(0);
  }
  const byStep = new Map(result.transcript.map((entry) => [entry.step, entry.observation]));

  const probe = JSON.parse(String(byStep.get(3).stdout).trim());
  report.isolation = probe;
  assert(probe.uid === 10001, "lab runs as the non-root lab user");
  assert(probe.network === "blocked", "network is blocked");
  assert(probe.repoWritable === false, "repository is read-only");
  assert(probe.rootWritable === false, "root filesystem is read-only");
  assert(probe.dockerSocket === false, "no Docker socket inside the lab");

  assert(byStep.get(5).error?.includes("could not write"), "write through a planted symlink is refused");
  assert((await readFile(hostSecret, "utf8")) === "untouched\n", "host file behind the symlink is untouched");
  report.symlinkEscape = "refused";

  assert(byStep.get(6).timedOut === true && byStep.get(6).exitCode === 137, "hung command is stopped by its own limit");
  report.commandTimeout = { exitCode: byStep.get(6).exitCode, durationMs: byStep.get(6).durationMs };
  assert(byStep.get(7).exitCode === 2 && String(byStep.get(7).stderr).includes("No such file"), "failure is visible to the agent");

  assert(result.status === "submitted", `agent submitted (got ${result.status}: ${result.reason})`);
  const metric = JSON.parse(result.artifact.content.toString("utf8"));
  assert(result.attempt.command.args[0] === "work/run.py" && result.attempt.number === 9, "attempt is the producing run");
  assert(typeof metric.test_accuracy === "number" && metric.test_accuracy > 0.5, "metric was computed by the run");
  report.metric = { ...metric, producedByStep: result.attempt.number, sha256: result.artifact.sha256 };

  const paused = docker(["inspect", "--format", "{{.State.Paused}}", handle.containerName]);
  assert(paused === "true", "lab is frozen before export");
  report.frozenBeforeExport = true;
  report.steps = result.steps;
  report.elapsedMs = Date.now() - started;

  const receipt = await labs.destroyLab(labId, "proof finished");
  labId = null;
  assert(receipt.verifiedAbsent && receipt.containerRemoved && receipt.artifactDirectoryRemoved, "lab removed");
  report.cleanup = { verifiedAbsent: receipt.verifiedAbsent };

  // Two more independent agents, run at the same time, each in its own lab and model session.
  const replica = async (agentName) => {
    const lab = await labs.createLab({
      runId: "run_autonomous_proof",
      image: PROOF_IMAGE,
      expectedImageId: imageId,
      workdir: "/workspace/case",
      artifactsDir: "artifacts",
      scratchDir: "work",
      inputs: [{ hostPath: repo, containerPath: "repo" }],
      resources: { cpus: 1, memoryMb: 512, pids: 64, timeoutSeconds: 60, networkDuringRun: false },
      limits: DEFAULT_LAB_LIMITS,
    });
    const plan = [
      { tool: "run", argv: ["ls", "-A", "work", "artifacts"], why: "Nothing from other agents should be here" },
      { tool: "write_file", path: "work/run.py", content: ADAPTER, why: "My own adapter" },
      { tool: "run", argv: ["python", "work/run.py"], why: "Run the experiment" },
      {
        tool: "submit",
        metricFile: "artifacts/metrics.json",
        key: "test_accuracy",
        metricName: "accuracy",
        unit: "fraction",
        split: "test",
        dataset: "bundled toy data",
        summary: "Independent run of the repository's model.",
      },
    ];
    const sessions = new Set();
    try {
      const outcome = await runAutonomousLabAgent({
        runId: "run_autonomous_proof",
        labId: lab.labId,
        agentName,
        claim: { experimentLabel: "x", dataset: "bundled toy data", split: "test", model: "nearest centroid", metric: { name: "accuracy", unit: "fraction", reportedValue: 0.9 }, seed: 11, hyperparameters: {}, evidence: [{ kind: "paper_page", reference: "page 1" }], missingFields: [], confidence: "high" },
        mapping: null,
        layout: { workdir: "/workspace/case", repoDir: "repo", scratchDir: "work", artifactsDir: "artifacts" },
        labs,
        model: {
          async complete(request) {
            sessions.add(request.sessionId);
            return { value: request.schema.parse(plan.shift()) };
          },
        },
        store,
        budget: { maxSteps: 6, wallSeconds: 120, commandTimeoutSeconds: 30 },
      });
      return { agentName, container: lab.containerName, outcome, sessions: [...sessions] };
    } finally {
      await labs.destroyLab(lab.labId, `${agentName} finished`);
    }
  };
  const team = await Promise.all([replica("agent-2"), replica("agent-3")]);
  assert(team[0].container !== team[1].container, "each agent has its own container");
  for (const member of team) {
    const listing = member.outcome.transcript[0].observation.stdout;
    assert(listing.trim() === "artifacts:\n\nwork:", `${member.agentName} starts with empty work and artifacts (got ${JSON.stringify(listing)})`);
    assert(member.outcome.status === "submitted", `${member.agentName} submitted`);
    assert(member.sessions.length === 1 && member.sessions[0].endsWith(member.agentName), `${member.agentName} has its own model session`);
  }
  const consensus = findConsensus(
    [
      { agentName: "agent-1", value: metric.test_accuracy },
      ...team.map((member) => ({ agentName: member.agentName, value: JSON.parse(member.outcome.artifact.content.toString("utf8")).test_accuracy })),
    ],
    0.02,
    2,
  );
  assert(consensus.status === "agreed" && consensus.agreeing.length === 3, "independent agents agree");
  report.independentAgents = {
    containers: team.map((member) => member.container.slice(0, 20)),
    startedEmpty: true,
    consensus: { status: consensus.status, values: consensus.values, representative: consensus.representative },
  };
  const leftovers = docker(["ps", "--all", "--filter", "label=dejaml.lab", "--format", "{{.Names}}"]);
  assert(leftovers === "", "no lab containers remain");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nAutonomous Lab Agent Docker proof passed.\n`);
} finally {
  if (labs && labId) await labs.destroyLab(labId, "proof aborted").catch(() => undefined);
  store.close();
  await rm(root, { recursive: true, force: true });
}
