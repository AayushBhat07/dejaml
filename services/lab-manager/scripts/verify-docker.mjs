// Proves the Lab Manager lifecycle against a real Docker engine without the
// curated dataset: the sealed-lab properties (platform, no network, no cloud
// metadata, non-root, read-only root and inputs, no capabilities, no new
// privileges, no Docker socket, an allowlisted environment with no host
// credentials, CPU/RAM/PID limits, a sized noexec /tmp, one fresh writable
// artifact directory), success, per-command and overall timeouts,
// cancellation, the memory limit, bounded output, live observation, artifact
// export, cleanup receipts, and orphan recovery.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { platformFromEnv } from "@dejaml/contracts";
import { RunStore } from "@dejaml/run-store";

import { DEFAULT_LAB_LIMITS, evaluateNetworkIsolation, LAB_ENV_ALLOWLIST, LabManager, NETWORK_OBSERVER_PY } from "../dist/index.js";

const BASE_IMAGE = "python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b";
const PROOF_IMAGE = "dejaml/lab-manager-proof:local";
const PLATFORM = platformFromEnv(process.env, process.arch).containerPlatform;
const OTHER_PLATFORM = PLATFORM === "linux/amd64" ? "linux/arm64" : "linux/amd64";

// Host credentials that must never reach a lab, even though they are set in this process.
const HOST_SECRETS = {
  DEJAML_OPENAI_API_KEY: "sk-proof-host-secret-openai",
  OPENAI_API_KEY: "sk-proof-host-secret-openai-2",
  AWS_ACCESS_KEY_ID: "AKIAPROOFHOSTSECRET",
  AWS_SECRET_ACCESS_KEY: "proof-host-secret-aws",
  AWS_SESSION_TOKEN: "proof-host-secret-aws-session",
  GITHUB_TOKEN: "ghp_proofhostsecret",
};
Object.assign(process.env, HOST_SECRETS);

function docker(args, input) {
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Short-lived helper containers (never labs); removed with --rm and checked by this label at the end. */
const HELPER_LABEL = "dejaml.proof=lab-network";

function helper(network, args) {
  return docker(["run", "--rm", "--label", HELPER_LABEL, "--pull", "never", "--platform", PLATFORM, "--network", network, ...args]);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const PROBE = String.raw`
import json, os, socket, subprocess, sys, time
${NETWORK_OBSERVER_PY}
mode = sys.argv[1]
def connect(host, port):
    try:
        socket.create_connection((host, port), timeout=2).close()
        return "reachable"
    except OSError as error:
        return f"blocked ({type(error).__name__})"
def writable(path):
    try:
        with open(path, "a"):
            pass
        return True
    except OSError:
        return False
def read(path):
    try:
        return open(path).read().strip()
    except OSError as error:
        return f"unreadable ({type(error).__name__})"
if mode == "probe":
    status = dict(line.split(":\t", 1) for line in open("/proc/self/status").read().splitlines() if ":\t" in line)
    checks = {"uid": os.getuid(), "gid": os.getgid()}
    checks["network"] = connect("1.1.1.1", 53)
    checks["networkV6"] = connect("2606:4700:4700::1111", 53)
    checks["metadata"] = connect("169.254.169.254", 80)
    try:
        socket.getaddrinfo("pypi.org", 443)
        checks["dns"] = "resolved"
    except OSError as error:
        checks["dns"] = f"blocked ({type(error).__name__})"
    checks["interfaces"] = sorted(os.listdir("/sys/class/net"))
    checks["networkObservation"] = observe_network()
    checks["netns"] = os.readlink("/proc/self/ns/net")
    checks["rootWritable"] = writable("/usr/escape.txt")
    checks["inputWritable"] = writable("data/input.txt")
    checks["wheelhouseWritable"] = writable("wheels/new.whl")
    checks["repoWritable"] = writable("repo/new.py")
    checks["artifactsWritable"] = writable("artifacts/probe.txt")
    os.remove("artifacts/probe.txt")
    checks["artifactsInitially"] = sorted(os.listdir("artifacts"))
    checks["tmpWritable"] = writable("/tmp/x.sh")
    with open("/tmp/x.sh", "w") as handle:
        handle.write("#!/bin/sh\necho ran\n")
    os.chmod("/tmp/x.sh", 0o755)
    try:
        subprocess.run(["/tmp/x.sh"], check=True, capture_output=True)
        checks["tmpExec"] = True
    except (OSError, subprocess.CalledProcessError):
        checks["tmpExec"] = False
    stat = os.statvfs("/tmp")
    checks["tmpMb"] = round(stat.f_blocks * stat.f_frsize / 1024 / 1024)
    checks["capEff"] = status.get("CapEff", "").strip()
    checks["capBnd"] = status.get("CapBnd", "").strip()
    checks["noNewPrivs"] = status.get("NoNewPrivs", "").strip()
    checks["docker_sock"] = os.path.exists("/var/run/docker.sock") or os.path.exists("/run/docker.sock")
    checks["envKeys"] = sorted(os.environ)
    checks["envValues"] = sorted(os.environ.values())
    # The kernel's own view of the limits (cgroup v2, else v1).
    if os.path.exists("/sys/fs/cgroup/cgroup.controllers"):
        checks["memoryMax"] = read("/sys/fs/cgroup/memory.max")
        checks["pidsMax"] = read("/sys/fs/cgroup/pids.max")
        checks["cpuMax"] = read("/sys/fs/cgroup/cpu.max")
    else:
        checks["memoryMax"] = read("/sys/fs/cgroup/memory/memory.limit_in_bytes")
        checks["pidsMax"] = read("/sys/fs/cgroup/pids/pids.max")
        checks["cpuMax"] = read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") + " " + read("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
    checks["machine"] = os.uname().machine
    checks["input"] = open("data/input.txt").read().strip()
    with open("artifacts/result.json", "w") as handle:
        json.dump({"metrics": {"accuracyPercent": 79.88}, "checks": checks}, handle)
    print(json.dumps(checks))
elif mode == "sleep":
    print("started", flush=True)
    time.sleep(600)
elif mode == "flood":
    chunk = "x" * 1023 + "\n"
    for _ in range(2048):
        sys.stdout.write(chunk)
    sys.stdout.flush()
elif mode == "stream":
    for step in range(1, 7):
        print(f"\x1b[32mepoch {step}/6\x1b[0m", flush=True)
        if step == 3:
            with open("artifacts/progress.json", "w") as handle:
                json.dump({"epoch": step}, handle)
        total = sum(i * i for i in range(400_000))
        time.sleep(0.5)
    print("done", flush=True)
elif mode == "memory":
    blocks = []
    while True:
        blocks.append(bytearray(32 * 1024 * 1024))
`;

const MACHINE = { "linux/amd64": "x86_64", "linux/arm64": "aarch64" }[PLATFORM];
const root = await mkdtemp(join(tmpdir(), "dejaml-lab-proof-"));
const store = new RunStore();
const report = { platform: PLATFORM };
try {
  docker(
    ["build", "--provenance=false", "--platform", PLATFORM, "--tag", PROOF_IMAGE, "-"],
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
  const wheelhouse = join(root, "wheelhouse");
  const repo = join(root, "repo");
  await writeFile(probePath, PROBE);
  await writeFile(inputPath, "read-only input\n");
  await mkdir(wheelhouse);
  await writeFile(join(wheelhouse, "requirements.lock.txt"), "");
  await mkdir(repo);
  await writeFile(join(repo, "train.py"), "print('train')\n");

  const labRoot = join(root, "labs");
  const run = store.createRun({ proof: "lab-manager" });
  const manager = new LabManager({ labRoot, events: (event) => store.appendEvent(event) });
  const spec = (timeoutSeconds, memoryMb = 512, limits = {}, platform = PLATFORM) => ({
    runId: run.id,
    image: PROOF_IMAGE,
    expectedImageId: imageId,
    platform,
    workdir: "/workspace/case",
    artifactsDir: "artifacts",
    inputs: [
      { hostPath: probePath, containerPath: "probe.py" },
      { hostPath: inputPath, containerPath: "data/input.txt" },
      { hostPath: wheelhouse, containerPath: "wheels" },
      { hostPath: repo, containerPath: "repo" },
    ],
    resources: { cpus: 1, memoryMb, pids: 64, timeoutSeconds, networkDuringRun: false },
    limits: { ...DEFAULT_LAB_LIMITS, ...limits },
  });
  const command = (mode) => ({ executable: "python", args: ["probe.py", mode], cwd: "/workspace/case", env: {} });

  // 1. The sealed lab: its effective container configuration, and what a process inside can observe.
  const success = await manager.withLab(spec(60, 512, { tmpfsMb: 48 }), async (lab) => {
    const inspected = JSON.parse(docker(["container", "inspect", "--format", "{{json .}}", lab.containerName]));
    // The proof image is built locally for exactly PLATFORM above. Plain
    // inspection works on both legacy Docker CLIs (including GitHub-hosted
    // runners) and newer containerd-backed stores; the assertions below still
    // verify its OS/architecture and the created container's manifest.
    const imageInfo = JSON.parse(docker(["image", "inspect", "--format", "{{json .}}", PROOF_IMAGE]));
    const outcome = await manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: command("probe") });
    const artifact = await manager.readArtifact(lab.labId, "artifacts/result.json");
    return { lab, inspected, imageInfo, outcome, result: JSON.parse(artifact.content.toString("utf8")), sha256: artifact.sha256 };
  });
  const { inspected, imageInfo, lab: sealedLab } = success.value;
  const host = inspected.HostConfig;
  const checks = success.value.result.checks;
  // Platform.
  assert(sealedLab.platform === PLATFORM, "lab handle records the platform");
  assert(`${imageInfo.Os}/${imageInfo.Architecture}` === PLATFORM, "image is built for the lab's platform");
  const descriptorPlatform = inspected.ImageManifestDescriptor?.platform;
  assert(
    !descriptorPlatform || `${descriptorPlatform.os}/${descriptorPlatform.architecture}` === PLATFORM,
    "container runs the platform's manifest",
  );
  assert(inspected.Image === imageId && sealedLab.imageId === imageId, "container runs the verified image ID");
  assert(checks.machine === MACHINE, `processes run on ${MACHINE}`);
  assert(inspected.Config.Labels["dejaml.platform"] === PLATFORM, "container is labelled with its platform");
  // Network and metadata.
  assert(host.NetworkMode === "none", "network mode is none");
  assert(checks.network.startsWith("blocked"), "network is blocked");
  assert(checks.metadata.startsWith("blocked"), "cloud metadata endpoint is unreachable");
  assert(checks.dns.startsWith("blocked"), "DNS does not resolve");
  assert(checks.networkV6.startsWith("blocked"), "IPv6 network is blocked");
  // Docker Desktop's LinuxKit kernel creates inert fallback tunnel devices (tunl0, ip6tnl0, ...) in every
  // network namespace; isolation means no device but loopback can carry traffic, not one exact listing.
  const isolation = evaluateNetworkIsolation(checks.networkObservation);
  assert(isolation.isolated, `no usable interface or route besides loopback: ${isolation.violations.join("; ")}`);
  console.log(
    `      interfaces ${checks.networkObservation.interfaces.map((item) => item.name).join(",")}; kernel lists ${(
      checks.networkObservation.kernelInterfaces ?? []
    ).join(",")}; inert ${isolation.inertDevices.join(",") || "none"}; non-device sysfs entries ${
      (checks.networkObservation.ignoredEntries ?? []).map((item) => item.name).join(",") || "none"
    }`,
  );
  assert(
    JSON.stringify(Object.keys(inspected.NetworkSettings?.Networks ?? {})) === JSON.stringify(["none"]),
    `attached only to the none network: ${Object.keys(inspected.NetworkSettings?.Networks ?? {}).join(",")}`,
  );
  const attachment = inspected.NetworkSettings.Networks.none;
  assert(!attachment.IPAddress && !attachment.GlobalIPv6Address && !attachment.Gateway, "the none attachment has no address or gateway");
  const empty = (value) => value === null || value === undefined || Object.keys(value).length === 0;
  assert(
    empty(host.PortBindings) &&
      host.PublishAllPorts !== true &&
      empty(inspected.NetworkSettings.Ports) &&
      empty(inspected.Config.ExposedPorts),
    "no exposed or published port",
  );
  assert(!["host"].includes(host.PidMode) && !["host"].includes(host.IpcMode) && !["host"].includes(host.UTSMode), "no host namespaces");
  // The engine's own network namespace (the Docker Desktop VM's on macOS), seen by a host-network helper.
  const engineNetns = helper("host", ["--entrypoint", "readlink", PROOF_IMAGE, "/proc/self/ns/net"]);
  assert(
    /^net:\[\d+\]$/u.test(checks.netns) && checks.netns !== engineNetns,
    `own network namespace (${checks.netns}, engine ${engineNetns})`,
  );
  // Identity and privileges.
  assert(checks.uid === 10001 && checks.gid === 10001, "runs as 10001:10001");
  assert(host.ReadonlyRootfs === true && checks.rootWritable === false, "root filesystem is read-only");
  assert(host.CapDrop?.includes("ALL") && !host.CapAdd?.length, "all capabilities dropped");
  assert(/^0+$/u.test(checks.capEff) && /^0+$/u.test(checks.capBnd), "no effective or bounding capabilities");
  assert(host.SecurityOpt?.includes("no-new-privileges") && checks.noNewPrivs === "1", "no new privileges");
  assert(host.Privileged === false, "not privileged");
  assert(checks.docker_sock === false, "no Docker socket");
  assert(!inspected.Mounts.some((mount) => /docker\.sock/u.test(`${mount.Source} ${mount.Destination}`)), "no Docker socket mount");
  // Environment allowlist; host credentials never arrive.
  // Docker sets HOSTNAME (and HOME when the image has none) for every process; Python's locale coercion sets LC_CTYPE.
  assert(
    checks.envKeys.every((key) => LAB_ENV_ALLOWLIST.has(key) || key === "HOSTNAME"),
    `environment is allowlisted: ${checks.envKeys.join(",")}`,
  );
  assert(
    inspected.Config.Env.every((entry) => LAB_ENV_ALLOWLIST.has(entry.split("=")[0])),
    "container config environment is allowlisted",
  );
  for (const [key, value] of Object.entries(HOST_SECRETS)) {
    assert(!checks.envKeys.includes(key) && !checks.envValues.includes(value), `${key} does not reach the lab`);
    assert(!JSON.stringify(inspected.Config.Env).includes(value), `${key} is not in the container config`);
  }
  // Resources.
  assert(host.NanoCpus === 1e9 && /^100000 100000$/u.test(checks.cpuMax), `one CPU (${host.NanoCpus}, cpu.max ${checks.cpuMax})`);
  assert(host.Memory === 512 * 1024 * 1024 && host.MemorySwap === host.Memory, "512 MiB memory, no swap");
  assert(checks.memoryMax === String(512 * 1024 * 1024), `memory cgroup limit (${checks.memoryMax})`);
  assert(host.PidsLimit === 64 && checks.pidsMax === "64", `PID limit (${checks.pidsMax})`);
  assert(/size=48m/u.test(host.Tmpfs["/tmp"]) && checks.tmpMb === 48, "/tmp is sized from the spec");
  assert(checks.tmpWritable === true && checks.tmpExec === false, "/tmp is writable and noexec");
  // Mounts.
  const writable = inspected.Mounts.filter((mount) => mount.RW).map((mount) => mount.Destination);
  assert(JSON.stringify(writable) === JSON.stringify(["/workspace/case/artifacts"]), "the artifact directory is the only writable mount");
  assert(
    checks.inputWritable === false && checks.wheelhouseWritable === false && checks.repoWritable === false,
    "dataset, wheelhouse and repository mounts are read-only",
  );
  assert(checks.artifactsWritable === true && checks.artifactsInitially.length === 0, "a fresh, empty writable artifact directory");
  // Outcome and cleanup.
  assert(success.value.outcome.attempt.exitCode === 0, "probe exits 0");
  assert(success.value.outcome.attempt.artifactDigests["artifacts/result.json"] === success.value.sha256, "artifact digest matches export");
  assert(success.receipt.verifiedAbsent && success.receipt.artifactDirectoryRemoved, "success cleanup verified");
  assert(success.receipt.platform === PLATFORM && success.receipt.imageId === imageId, "receipt records platform and image");
  const { envValues: _values, ...publicChecks } = checks;
  report.sealed = {
    checks: publicChecks,
    networkIsolation: { ...isolation, engineNetns },
    imageDigest: sealedLab.imageDigest,
    receipt: success.receipt,
  };

  // 1b. The same rule refuses a namespace that has a route out (the default bridge), so it is not vacuous.
  const bridged = JSON.parse(
    helper("bridge", [
      "--user",
      "10001:10001",
      "--entrypoint",
      "python",
      PROOF_IMAGE,
      "-c",
      `import json\n${NETWORK_OBSERVER_PY}\nprint(json.dumps(observe_network()))`,
    ]),
  );
  const bridgedVerdict = evaluateNetworkIsolation(bridged);
  assert(!bridgedVerdict.isolated, "a bridge-attached namespace fails the isolation rule");
  report.bridgeNegativeControl = bridgedVerdict.violations;

  // 2. The wrong platform is refused before anything is created.
  const mismatch = await manager.createLab(spec(60, 512, {}, OTHER_PLATFORM)).then(
    () => null,
    (error) => error,
  );
  assert(mismatch?.code === "platform_mismatch", `a ${OTHER_PLATFORM} lab from a ${PLATFORM} image is refused`);
  report.platformMismatch = mismatch.message;

  // 3. Wall-time limit.
  const timeout = await manager.withLab(spec(2), async (lab) =>
    manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: command("sleep") }),
  );
  assert(timeout.value.attempt.timedOut && timeout.value.attempt.exitCode === null, "timeout recorded");
  assert(timeout.value.durationMs < 15_000, "timeout enforced promptly");
  assert(timeout.receipt.verifiedAbsent, "timeout cleanup verified");
  report.timeout = { durationMs: timeout.value.durationMs, stdout: timeout.value.stdout.text.trim(), receipt: timeout.receipt };

  // 4. Per-command limit: the command stops, the lab survives.
  const perCommand = await manager.withLab(spec(60), async (lab) => {
    const slow = await manager.runCommand(lab.labId, command("sleep"), { timeoutSeconds: 2, step: 1 });
    const state = manager.state(lab.labId);
    const next = await manager.runCommand(
      lab.labId,
      { executable: "python", args: ["-c", "print('still here')"], cwd: "/workspace/case", env: {} },
      { timeoutSeconds: 10, step: 2 },
    );
    return { slow, state, next };
  });
  assert(perCommand.value.slow.timedOut && perCommand.value.slow.durationMs < 15_000, "per-command limit enforced");
  assert(perCommand.value.state === "idle" && perCommand.value.next.stdout.text.trim() === "still here", "lab survives a command timeout");
  report.perCommandTimeout = { durationMs: perCommand.value.slow.durationMs, receipt: perCommand.receipt };

  // 5. Overall lab lifetime.
  const lifetime = await manager.withLab(spec(60, 512, { labTimeoutSeconds: 3 }), async (lab) => {
    const outcome = await manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: command("sleep") });
    return { outcome, state: manager.state(lab.labId) };
  });
  assert(lifetime.value.outcome.attempt.timedOut && lifetime.value.state === "timed_out", "overall lab lifetime enforced");
  assert(lifetime.value.outcome.durationMs < 15_000, "lab lifetime enforced promptly");
  assert(lifetime.receipt.verifiedAbsent, "lifetime cleanup verified");
  report.labLifetime = { durationMs: lifetime.value.outcome.durationMs, receipt: lifetime.receipt };

  // 6. Cancellation.
  const cancel = await manager.withLab(spec(60), async (lab) => {
    const running = manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: command("sleep") });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await manager.cancelLab(lab.labId);
    return running;
  });
  assert(cancel.value.attempt.cancelled, "cancellation recorded");
  assert(cancel.receipt.verifiedAbsent, "cancel cleanup verified");
  report.cancel = { durationMs: cancel.value.durationMs, receipt: cancel.receipt };

  // 7. Memory ceiling.
  const memory = await manager.withLab(spec(60, 256), async (lab) =>
    manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: command("memory") }),
  );
  assert(memory.value.attempt.exitCode !== 0, "memory hog is stopped by the memory limit");
  report.memory = { exitCode: memory.value.attempt.exitCode, receipt: memory.receipt };

  // 8. Bounded output capture.
  const flood = await manager.withLab(spec(60, 512, { maxLogBytes: 64 * 1024 }), async (lab) =>
    manager.executeAttempt(lab.labId, { number: 1, label: "baseline", command: command("flood") }),
  );
  assert(flood.value.stdout.truncated && flood.value.stdout.text.length <= 64 * 1024, "stdout capture is bounded");
  assert(flood.value.stdout.bytes === 2048 * 1024, "the full output size is still counted");
  report.boundedOutput = { keptBytes: flood.value.stdout.text.length, totalBytes: flood.value.stdout.bytes };

  // 9. Live observation: output, telemetry, and artifact changes during a run.
  const firstObserved = store.listEvents(run.id).length;
  const observed = await manager.withLab(spec(60), async (lab) =>
    manager.executeAttempt(lab.labId, {
      number: 1,
      label: "baseline",
      command: command("stream"),
      observe: { flushIntervalMs: 200, telemetryIntervalMs: 500, artifactIntervalMs: 250 },
    }),
  );
  const live = store.listEvents(run.id, firstObserved);
  const liveLines = live.filter((event) => event.type === "lab_output").flatMap((event) => event.publicPayload.lines);
  const telemetry = live.filter((event) => event.type === "lab_telemetry");
  const changes = live.filter((event) => event.type === "artifact_changed");
  const attemptDone = live.findIndex((event) => event.type === "attempt" && event.status === "completed");
  const firstLine = live.findIndex((event) => event.type === "lab_output");
  assert(observed.value.attempt.exitCode === 0, "observed attempt exits 0");
  assert(
    JSON.stringify(liveLines) === JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => `epoch ${n}/6`).concat("done")),
    "live lines are complete and sanitized",
  );
  assert(firstLine >= 0 && firstLine < attemptDone, "output streamed before the attempt finished");
  assert(telemetry.length >= 2, "telemetry sampled repeatedly");
  assert(
    telemetry.every((event) => event.publicPayload.memoryBytes > 0 && event.publicPayload.memoryLimitBytes <= 512 * 1024 * 1024),
    "telemetry reports memory under the limit",
  );
  assert(
    changes.some((event) => event.publicPayload.path === "artifacts/progress.json"),
    "artifact change observed",
  );
  report.observed = {
    durationMs: observed.value.durationMs,
    outputEvents: live.filter((event) => event.type === "lab_output").length,
    liveLines,
    telemetrySamples: telemetry.map((event) => ({
      elapsedMs: event.publicPayload.elapsedMs,
      cpuPercent: event.publicPayload.cpuPercent,
      memoryMiB: Math.round(event.publicPayload.memoryBytes / 1024 / 1024),
      pids: event.publicPayload.pids,
    })),
    artifactChanges: changes.map((event) => event.summary),
    firstOutputBeforeCompletion: firstLine < attemptDone,
  };

  // 10. Orphan recovery: a crashed manager leaves a running lab behind.
  const crashed = new LabManager({ labRoot });
  const orphan = await crashed.createLab(spec(60));
  const recovered = await new LabManager({ labRoot }).cleanupOrphans();
  assert(
    recovered.some((receipt) => receipt.labId === orphan.labId && receipt.verifiedAbsent && receipt.platform === PLATFORM),
    "orphan removed",
  );
  report.orphans = recovered;

  const leftovers = docker(["ps", "--all", "--quiet", "--filter", "label=dejaml.lab"]);
  assert(leftovers === "", "no lab containers remain");
  assert(docker(["ps", "--all", "--quiet", "--filter", `label=${HELPER_LABEL}`]) === "", "no helper containers remain");
  assert((await readdir(labRoot)).length === 0, "no lab directories remain");
  const events = store.listEvents(run.id);
  report.events = events.map((event) => `${event.sequence} ${event.type} ${event.status}: ${event.summary}`);
  report.remainingLabContainers = 0;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
