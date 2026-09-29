// Proves the failure and cleanup paths of the real API, pipeline, and Lab
// Manager against a real Docker engine. The model and GitHub are stand-ins, and
// the reviewed runner is replaced by a stub whose behaviour is chosen by its
// input file, in a private copy of the case with a matching adapter digest.
// Scenarios: success, missing metric, non-zero exit, cancel, timeout, killed
// API process with restart recovery, unsupported paper, and non-PDF upload.
// After each one, no `dejaml.lab` container may remain.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_IMAGE =
  "python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b";
const PROOF_IMAGE = "dejaml/api-failure-proof:local";
const RUNNER = String.raw`
import json, pathlib, sys, time
mode = pathlib.Path("data/training.csv").read_text().strip()
print(f"stub runner mode={mode}", flush=True)
if mode == "hang":
    while True:
        print("training", flush=True)
        time.sleep(0.5)
if mode == "crash":
    print("KeyError: 'class'", file=sys.stderr, flush=True)
    sys.exit(3)
if mode == "success":
    pathlib.Path("artifacts/result.json").write_text(json.dumps({"metrics": {"accuracyPercent": 79.88}}))
    print('DEJAML_RESULT={"accuracyPercent":79.88}', flush=True)
`;

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const self = fileURLToPath(import.meta.url);

function docker(args, input) {
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function labContainers() {
  return docker(["ps", "--all", "--quiet", "--filter", "label=dejaml.lab"]).split("\n").filter(Boolean);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function serve([projectRoot, workRoot, dbPath, imageId, timeoutSeconds]) {
  const { LabManager } = await import("@dejaml/lab-manager");
  const { RunStore } = await import("@dejaml/run-store");
  const { createApiServer, loadCases, recoverAfterRestart } = await import("../dist/index.js");
  const { ScriptedModel, standInAcquire } = await import("../dist/stand-ins.js");
  const cases = await loadCases(projectRoot);
  const store = new RunStore(dbPath);
  const labs = new LabManager({ labRoot: join(workRoot, "labs"), events: (event) => store.appendEvent(event) });
  const recovery = await recoverAfterRestart({ store, labs, workRoot });
  const api = createApiServer({
    store,
    labs,
    model: new ScriptedModel(cases[0], Number(timeoutSeconds)),
    cases,
    projectRoot,
    workRoot,
    image: { name: PROOF_IMAGE, expectedImageId: imageId },
    acquire: standInAcquire(cases[0]),
  });
  api.server.listen(0, "127.0.0.1", () =>
    process.stdout.write(`${JSON.stringify({ port: api.server.address().port, recovery })}\n`),
  );
  process.once("SIGTERM", () => void api.close().finally(() => (store.close(), process.exit(0))));
}

if (process.argv[2] === "serve") {
  await serve(process.argv.slice(3));
} else {
  await main();
}

async function main() {
  const { paperPdf } = await import("../dist/stand-ins.js");
  const root = await mkdtemp(join(tmpdir(), "dejaml-failure-proof-"));
  const results = {};
  try {
    assert(labContainers().length === 0, "no lab containers before the proof");
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
    const paper = await paperPdf();

    const setup = async (name, mode) => {
      const dir = join(root, name);
      const caseDir = join(dir, "project/cases/urban-land-cover");
      await mkdir(join(caseDir, "data"), { recursive: true });
      await mkdir(join(dir, "data"));
      await copyFile(join(repoRoot, "cases/urban-land-cover/case.json"), join(caseDir, "case.json"));
      await writeFile(join(caseDir, "runner.py"), RUNNER);
      await writeFile(join(caseDir, "data/training.csv"), `${mode}\n`);
      await writeFile(join(caseDir, "data/testing.csv"), "stub\n");
      const policy = JSON.parse(await readFile(join(repoRoot, "cases/urban-land-cover/policy.json"), "utf8"));
      policy.trustedExecutionAdapter.sha256 = createHash("sha256").update(RUNNER).digest("hex");
      await writeFile(join(caseDir, "policy.json"), JSON.stringify(policy));
      return { dir, project: join(dir, "project"), work: join(dir, "data"), db: join(dir, "runs.sqlite") };
    };

    const start = (env, timeoutSeconds = 60) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [self, "serve", env.project, env.work, env.db, imageId, String(timeoutSeconds)],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          const line = buffer.split("\n").find((item) => item.startsWith("{"));
          if (!line) return;
          const ready = JSON.parse(line);
          resolve({ child, base: `http://127.0.0.1:${ready.port}`, recovery: ready.recovery });
        });
        child.once("exit", (code) => reject(new Error(`server exited early (${code})`)));
      });
    const stop = (server) =>
      new Promise((resolve) => {
        server.child.removeAllListeners("exit");
        server.child.once("exit", resolve);
        server.child.kill("SIGTERM");
      });
    const upload = async (server, data, name = "paper.pdf") => {
      const form = new FormData();
      form.append("paper", new Blob([data]), name);
      const response = await fetch(`${server.base}/api/runs`, { method: "POST", body: form });
      assert(response.status === 202, `upload accepted (${response.status})`);
      return (await response.json()).runId;
    };
    const snapshot = async (server, runId) => (await fetch(`${server.base}/api/runs/${runId}`)).json();
    const waitFor = async (server, runId, predicate, what, limitMs = 60_000) => {
      const deadline = Date.now() + limitMs;
      for (;;) {
        const run = await snapshot(server, runId);
        if (predicate(run)) return run;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (status ${run.status})`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const TERMINAL = ["completed", "inconclusive", "cancelled", "timed_out", "failed"];
    const finished = async (server, runId) => {
      await waitFor(server, runId, (run) => TERMINAL.includes(run.status), "a terminal status");
      // The report is written just after the terminal transition.
      for (let tries = 0; ; tries += 1) {
        const response = await fetch(`${server.base}/api/runs/${runId}/report`);
        if (response.status === 200) return response.json();
        if (tries > 100) throw new Error(`report for ${runId} never appeared`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const log = (message) => process.stderr.write(`[verify-failures] ${message}\n`);
    const clean = async (env, label) => {
      log(`${label}: passed`);
      assert(labContainers().length === 0, `${label}: no lab containers remain`);
      const labs = await readdir(join(env.work, "labs")).catch(() => []);
      assert(labs.length === 0, `${label}: no lab directories remain`);
      const leftovers = (await readdir(env.work)).filter((name) => name.startsWith("checkouts-"));
      assert(leftovers.length === 0, `${label}: no repository checkouts remain`);
    };
    const summarize = (report) => ({
      status: report.status,
      verdict: report.assessment?.verdict ?? null,
      exitCode: report.lab?.attempt?.exitCode ?? null,
      durationMs: report.lab?.attempt?.endedAt
        ? Date.parse(report.lab.attempt.endedAt) - Date.parse(report.lab.attempt.startedAt)
        : null,
      cleanupVerified: report.lab?.cleanup?.verifiedAbsent ?? null,
      failure: report.failure,
    });

    for (const [name, check] of [
      ["success", (r) => r.status === "completed" && r.metric?.value === 79.88 && r.assessment?.verdict === "different_result"],
      ["no_metric", (r) => r.status === "inconclusive" && r.metric === null && r.lab.attempt.exitCode === 0],
      ["crash", (r) => r.status === "inconclusive" && r.lab.attempt.exitCode === 3 && r.lab.stderr.includes("KeyError")],
    ]) {
      const env = await setup(name, name);
      const server = await start(env);
      const report = await finished(server, await upload(server, paper));
      assert(check(report), `${name}: ${JSON.stringify(summarize(report))}`);
      assert(report.lab.cleanup.verifiedAbsent, `${name}: cleanup receipt verified`);
      await stop(server);
      await clean(env, name);
      results[name] = summarize(report);
    }

    {
      const env = await setup("cancel", "hang");
      const server = await start(env);
      const runId = await upload(server, paper);
      await waitFor(server, runId, (run) => run.status === "running", "the attempt to run");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const cancelled = await fetch(`${server.base}/api/runs/${runId}/cancel`, { method: "POST" });
      assert(cancelled.status === 202, "cancel accepted");
      const report = await finished(server, runId);
      assert(report.status === "cancelled" && report.lab.attempt.cancelled, "cancel: cancelled attempt");
      assert(report.lab.stdout.includes("training"), "cancel: output captured before cancel");
      assert(report.lab.cleanup.verifiedAbsent, "cancel: cleanup verified");
      await stop(server);
      await clean(env, "cancel");
      results.cancel = summarize(report);
    }

    {
      const env = await setup("timeout", "hang");
      const server = await start(env, 3);
      const report = await finished(server, await upload(server, paper));
      assert(report.status === "timed_out" && report.lab.attempt.timedOut, "timeout: timed out");
      const durationMs = summarize(report).durationMs;
      assert(durationMs >= 3_000 && durationMs < 10_000, `timeout: stopped near the 3 s limit (${durationMs} ms)`);
      assert(report.lab.cleanup.verifiedAbsent, "timeout: cleanup verified");
      await stop(server);
      await clean(env, "timeout");
      results.timeout = summarize(report);
    }

    {
      const env = await setup("restart", "hang");
      const first = await start(env);
      const runId = await upload(first, paper);
      await waitFor(first, runId, (run) => run.status === "running", "the attempt to run");
      first.child.removeAllListeners("exit");
      const killed = new Promise((resolve) => first.child.once("exit", resolve));
      first.child.kill("SIGKILL");
      await killed;
      const orphans = labContainers().length;
      assert(orphans === 1, `restart: the killed API left its lab behind (${orphans})`);
      const staleCheckouts = (await readdir(env.work)).filter((name) => name.startsWith("checkouts-")).length;
      assert(staleCheckouts === 1, "restart: the killed API left its checkout folder behind");
      const second = await start(env);
      assert(second.recovery.orphanLabs === 1, "restart: one orphan lab removed");
      assert(second.recovery.staleCheckouts === 1, "restart: one stale checkout folder removed");
      assert(second.recovery.interruptedRuns.includes(runId), "restart: run marked interrupted");
      const run = await snapshot(second, runId);
      assert(run.status === "failed", "restart: interrupted run is failed");
      await stop(second);
      await clean(env, "restart");
      results.restart = { orphansAfterKill: orphans, staleCheckouts, recovery: second.recovery, status: run.status };
    }

    {
      const env = await setup("intake", "success");
      const server = await start(env);
      const unsupported = await finished(server, await upload(server, await paperPdf(false)));
      assert(unsupported.status === "inconclusive" && unsupported.lab === null, "unsupported paper: no lab");
      const notPdf = await finished(server, await upload(server, new TextEncoder().encode("hello"), "notes.txt"));
      assert(notPdf.status === "inconclusive" && notPdf.lab === null, "non-PDF: no lab");
      await stop(server);
      await clean(env, "intake");
      results.unsupportedPaper = summarize(unsupported);
      results.notPdf = summarize(notPdf);
    }

    results.remainingLabContainers = labContainers().length;
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    for (const id of labContainers()) spawnSync("docker", ["rm", "--force", id]);
    await rm(root, { recursive: true, force: true });
  }
}
