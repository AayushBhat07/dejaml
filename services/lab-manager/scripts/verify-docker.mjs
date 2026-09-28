// Proves the Lab Manager lifecycle against a real Docker engine without the
// curated dataset: isolation, success, timeout, cancellation, memory limit,
// artifact export, cleanup receipts, and orphan recovery.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunStore } from "@dejaml/run-store";

import { DEFAULT_LAB_LIMITS, LabManager } from "../dist/index.js";

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

const PROBE = String.raw`
import json, os, socket, sys, time
mode = sys.argv[1]
if mode == "probe":
    checks = {"uid": os.getuid(), "gid": os.getgid()}
    try:
        socket.create_connection(("1.1.1.1", 53), timeout=2)
        checks["network"] = "reachable"
    except OSError as error:
        checks["network"] = f"blocked ({type(error).__name__})"
    try:
        open("/usr/escape.txt", "w")
        checks["rootWritable"] = True
    except OSError:
        checks["rootWritable"] = False
    try:
        open("data/input.txt", "a")
        checks["inputWritable"] = True
    except OSError:
        checks["inputWritable"] = False
    checks["docker_sock"] = os.path.exists("/var/run/docker.sock")
    checks["input"] = open("data/input.txt").read().strip()
    with open("artifacts/result.json", "w") as handle:
        json.dump({"metrics": {"accuracyPercent": 79.88}, "checks": checks}, handle)
    print(json.dumps(checks))
elif mode == "sleep":
    print("started", flush=True)
    time.sleep(600)
elif mode == "memory":
    blocks = []
    while True:
        blocks.append(bytearray(32 * 1024 * 1024))
`;

const root = await mkdtemp(join(tmpdir(), "dejaml-lab-proof-"));
const store = new RunStore();
const report = {};
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
  const probePath = join(root, "probe.py");
  const inputPath = join(root, "input.txt");
  await writeFile(probePath, PROBE);
  await writeFile(inputPath, "read-only input\n");

  const labRoot = join(root, "labs");
  const run = store.createRun({ proof: "lab-manager" });
  const manager = new LabManager({ labRoot, events: (event) => store.appendEvent(event) });
  const spec = (timeoutSeconds, memoryMb = 512) => ({
    runId: run.id,
    image: PROOF_IMAGE,
    expectedImageId: imageId,
    workdir: "/workspace/case",
    artifactsDir: "artifacts",
    inputs: [
      { hostPath: probePath, containerPath: "probe.py" },
      { hostPath: inputPath, containerPath: "data/input.txt" },
    ],
    resources: { cpus: 1, memoryMb, pids: 64, timeoutSeconds, networkDuringRun: false },
    limits: DEFAULT_LAB_LIMITS,
  });
  const command = (mode) => ({ executable: "python", args: ["probe.py", mode], cwd: "/workspace/case", env: {} });

  // 1. Success with isolation probes and artifact export.
  const success = await manager.withLab(spec(60), async (lab) => {
    const outcome = await manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: command("probe") });
    const artifact = await manager.readArtifact(lab.labId, "artifacts/result.json");
    return { outcome, result: JSON.parse(artifact.content.toString("utf8")), sha256: artifact.sha256 };
  });
  const checks = success.value.result.checks;
  assert(success.value.outcome.attempt.exitCode === 0, "probe exits 0");
  assert(checks.uid === 10001 && checks.gid === 10001, "runs as 10001:10001");
  assert(checks.network.startsWith("blocked"), "network is blocked");
  assert(checks.rootWritable === false, "root filesystem is read-only");
  assert(checks.inputWritable === false, "inputs are read-only");
  assert(checks.docker_sock === false, "no Docker socket");
  assert(success.value.outcome.attempt.artifactDigests["artifacts/result.json"] === success.value.sha256, "artifact digest matches export");
  assert(success.receipt.verifiedAbsent && success.receipt.artifactDirectoryRemoved, "success cleanup verified");
  report.success = { checks, durationMs: success.value.outcome.durationMs, receipt: success.receipt };

  // 2. Wall-time limit.
  const timeout = await manager.withLab(spec(2), async (lab) =>
    manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: command("sleep") }),
  );
  assert(timeout.value.attempt.timedOut && timeout.value.attempt.exitCode === null, "timeout recorded");
  assert(timeout.value.durationMs < 15_000, "timeout enforced promptly");
  assert(timeout.receipt.verifiedAbsent, "timeout cleanup verified");
  report.timeout = { durationMs: timeout.value.durationMs, stdout: timeout.value.stdout.text.trim(), receipt: timeout.receipt };

  // 3. Cancellation.
  const cancel = await manager.withLab(spec(60), async (lab) => {
    const running = manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: command("sleep") });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await manager.cancelLab(lab.labId);
    return running;
  });
  assert(cancel.value.attempt.cancelled, "cancellation recorded");
  assert(cancel.receipt.verifiedAbsent, "cancel cleanup verified");
  report.cancel = { durationMs: cancel.value.durationMs, receipt: cancel.receipt };

  // 4. Memory ceiling.
  const memory = await manager.withLab(spec(60, 256), async (lab) =>
    manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: command("memory") }),
  );
  assert(memory.value.attempt.exitCode !== 0, "memory hog is stopped by the memory limit");
  report.memory = { exitCode: memory.value.attempt.exitCode, receipt: memory.receipt };

  // 5. Orphan recovery: a crashed manager leaves a running lab behind.
  const crashed = new LabManager({ labRoot });
  const orphan = await crashed.createLab(spec(60));
  const recovered = await new LabManager({ labRoot }).cleanupOrphans();
  assert(recovered.some((receipt) => receipt.labId === orphan.labId && receipt.verifiedAbsent), "orphan removed");
  report.orphans = recovered;

  const leftovers = docker(["ps", "--all", "--quiet", "--filter", "label=dejaml.lab"]);
  assert(leftovers === "", "no lab containers remain");
  const events = store.listEvents(run.id);
  report.events = events.map((event) => `${event.sequence} ${event.type} ${event.status}: ${event.summary}`);
  report.remainingLabContainers = 0;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
