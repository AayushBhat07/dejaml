// Stand-ins for Docker, the model provider, and GitHub, used by tests and by
// scripts/verify-stack.mjs to exercise the real API, pipeline, Lab Manager,
// policy gate, and verifier without external services. Never used by main.ts.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  AuditDecisionSchema,
  CodeAnalysisSchema,
  LeadResearchDecisionSchema,
  PaperAnalysisSchema,
  type ExperimentPlan,
} from "@dejaml/contracts";
import type { ChatProvider, ChatRequest, ChatResponse, ToolCall } from "@dejaml/agent-runtime";
import type { ContainerRuntime, RuntimeCommandOptions, RuntimeCommandResult } from "@dejaml/lab-manager";
import { buildRepositoryManifest, type RepositoryReceipt } from "@dejaml/repository-intake";
import type { StructuredCompletionRequest, StructuredModelClient } from "@dejaml/research-runtime";
import { PDFDocument, StandardFonts } from "pdf-lib";

import type { CuratedCase } from "./cases.js";

export const STAND_IN_IMAGE_ID = `sha256:${"c".repeat(64)}`;
export const NOTEBOOK = '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}\n';
export const NOTEBOOK_PATH = "Urban Land Cover Classification.ipynb";

export type ExecMode = "success" | "hang" | "no_metric" | "crash";

function ok(stdout = ""): RuntimeCommandResult {
  return {
    exitCode: 0,
    stdout: { text: stdout, bytes: stdout.length, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    aborted: false,
  };
}

/**
 * Stands in for Docker: success writes the curated result; hang waits to be
 * killed; no_metric exits 0 without a result; crash exits 3.
 */
const STAND_IN_USER = "10001:10001";
const STAND_IN_ENV = ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "HOME=/tmp", "PYTHONUNBUFFERED=1"];

export class ScriptedRuntime implements ContainerRuntime {
  mode: ExecMode = "success";
  /** Metric written by a successful scripted experiment. Tests may vary it to exercise exact-match blinding. */
  resultAccuracyPercent = 79.88;
  /** Spreads the scripted output over this many milliseconds so live views have time to update. */
  execDelayMs = 0;
  readonly containers = new Set<string>();
  execStarted: (() => void) | null = null;
  createArgs: string[] = [];
  /** Make the first experiment run in each lab fail, to exercise recovery. */
  failFirstRun = false;
  /** Every `docker exec` argv, for assertions. */
  readonly execs: string[][] = [];
  readonly #mounts = new Map<string, { artifacts: string; scratch: string; runs: number; tampered?: boolean }>();
  readonly #created = new Map<string, string[]>();
  #kill: (() => void) | null = null;

  async docker(args: readonly string[], options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    const [command] = args;
    if (command === "image") {
      // `image inspect [--platform p] --format {{json .}} <ref>`: the image exists for whichever platform is asked.
      const platformIndex = args.indexOf("--platform");
      const [os, architecture] = (platformIndex > 0 ? (args[platformIndex + 1] ?? "") : "linux/amd64").split("/");
      return ok(
        `${JSON.stringify({ Id: STAND_IN_IMAGE_ID, Os: os, Architecture: architecture, RepoDigests: [], Config: { User: STAND_IN_USER, Env: STAND_IN_ENV } })}\n`,
      );
    }
    if (command === "container") {
      // `container inspect <name>`: the created container, read back by the sealed-lab audit.
      const created = this.#created.get(args.at(-1) ?? "");
      if (!created) return { ...ok(), exitCode: 1, stderr: { text: "Error: No such container", bytes: 24, truncated: false } };
      const flag = (name: string): string[] => created.flatMap((value, index) => (created[index - 1] === name ? [value] : []));
      const [os, architecture] = (flag("--platform")[0] ?? "linux/amd64").split("/");
      return ok(
        JSON.stringify({
          Image: STAND_IN_IMAGE_ID,
          ImageManifestDescriptor: { digest: `sha256:${"e".repeat(64)}`, platform: { os, architecture } },
          Config: { User: STAND_IN_USER, Env: STAND_IN_ENV },
          HostConfig: {
            NetworkMode: flag("--network")[0] ?? "bridge",
            ReadonlyRootfs: created.includes("--read-only"),
            CapDrop: flag("--cap-drop"),
            CapAdd: null,
            SecurityOpt: flag("--security-opt"),
            Privileged: created.includes("--privileged"),
          },
          Mounts: flag("--mount").map((mount) => ({
            Source: /src=([^,]+)/u.exec(mount)?.[1],
            Destination: /dst=([^,]+)/u.exec(mount)?.[1],
            RW: !mount.includes(",readonly"),
          })),
        }),
      );
    }
    if (command === "create") {
      this.createArgs = [...args];
      const container = args[args.indexOf("--name") + 1] ?? "";
      this.containers.add(container);
      this.#created.set(container, [...args]);
      const mount = args.find((arg) => arg.endsWith("dst=/workspace/case/artifacts")) ?? "";
      const scratchMount = args.find((arg) => arg.endsWith("dst=/workspace/case/work")) ?? "";
      this.#mounts.set(container, {
        artifacts: /src=([^,]+),/u.exec(mount)?.[1] ?? "",
        scratch: /src=([^,]+),/u.exec(scratchMount)?.[1] ?? "",
        runs: 0,
      });
      return ok();
    }
    if (command === "exec") {
      const name = args.findIndex((arg) => this.containers.has(arg));
      const mounts = this.#mounts.get(args[name] ?? "") ?? { artifacts: "", scratch: "", runs: 0, tampered: false };
      const argv = args.slice(name + 1);
      this.execs.push(argv);
      if (argv[0] === "python" && argv[1] === "-c" && argv[2]?.startsWith("import base64")) {
        // The Lab Manager's in-container file writer for agent-authored scripts.
        const target = argv[3] ?? "";
        const scratch = target.startsWith("/workspace/case/work/") ? mounts.scratch : "";
        if (!scratch) return { ...ok(), exitCode: 1 };
        const host = join(scratch, target.slice("/workspace/case/work/".length));
        await mkdir(dirname(host), { recursive: true });
        await writeFile(host, Buffer.from(argv[4] ?? "", "base64"));
        return ok();
      }
      if (argv[0] === "python" && argv[1] === "-I" && argv[2] === "-S") {
        // The Lab Manager's file inspector and background-process reaper.
        let request: { op?: string; path?: string } | null = null;
        try {
          request = argv[5] ? (JSON.parse(argv[5]) as { op?: string; path?: string }) : null;
        } catch {
          request = null;
        }
        if (!request?.op) return ok("[]");
        return ok(
          JSON.stringify(
            request.op === "read"
              ? { path: request.path, content: "import runpy\nrunpy.run_path('repo/train.py')\n", size: 44 }
              : { path: request.path, entries: ["repo/train.py", "work/run.py"] },
          ),
        );
      }
      if (argv[0] === "cat" && argv[1] === "/proc/1/task/1/children") return ok("7\n");
      let inner = argv[0] === "timeout" ? argv.slice(3) : argv;
      if (inner[0] === "env" && inner[1] === "--") inner = inner.slice(2);
      const program = inner[0] ?? "";
      // The study's own setup steps: copying the checkout and measuring integrity.
      if (inner[1] === "-I" && inner[4]?.includes("copytree")) return ok();
      if (inner[1] === "-I" && inner[4]?.includes("hashlib"))
        return ok(JSON.stringify({ workRepo: `${"d".repeat(64)}:3`, venv: `${"e".repeat(64)}:${mounts.tampered ? 2 : 1}` }));
      if (program.endsWith("python") && inner[1] === "-m" && inner[2] === "venv") return ok();
      if (program.endsWith("python") && inner[1] === "-c" && inner[2]?.includes("python_version")) return ok('{"python": "3.11.9"}\n');
      if (program === "touch") {
        // An engineer changing the prepared environment, for the integrity check.
        mounts.tampered = true;
        return ok();
      }
      // Exploration such as `find` or `ls` inside an autonomous lab.
      if (!program.endsWith("python")) return ok("repo/train.py\n");
      mounts.runs += 1;
      if (this.failFirstRun && mounts.runs === 1) {
        options.onOutput?.(
          "stderr",
          "Traceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory: 'sheet1.csv'\n",
        );
        return {
          ...ok(),
          exitCode: 1,
          stderr: { text: "FileNotFoundError: [Errno 2] No such file or directory: 'sheet1.csv'\n", bytes: 70, truncated: false },
        };
      }
      this.execStarted?.();
      if (this.mode === "hang") {
        options.onOutput?.("stdout", "training…\n");
        await new Promise<void>((resolve) => {
          this.#kill = resolve;
        });
        return { ...ok(), exitCode: 137 };
      }
      if (this.mode === "no_metric") return ok("finished without writing a result\n");
      if (this.mode === "crash") {
        options.onOutput?.("stderr", "Traceback (most recent call last): KeyError: 'class'\n");
        return { ...ok(), exitCode: 3, stderr: { text: "KeyError: 'class'\n", bytes: 16, truncated: false } };
      }
      for (let step = 1; step <= 3 && this.execDelayMs > 0; step += 1) {
        options.onOutput?.("stdout", `stand-in progress ${step}/3\n`);
        await new Promise((resolve) => setTimeout(resolve, this.execDelayMs / 3));
      }
      const result = JSON.stringify({ metrics: { accuracyPercent: this.resultAccuracyPercent } });
      const stdout = `DEJAML_RESULT=${JSON.stringify({ accuracyPercent: this.resultAccuracyPercent })}\n`;
      await writeFile(join(mounts.artifacts, "result.json"), result);
      options.onOutput?.("stdout", stdout);
      return ok(stdout);
    }
    if (command === "stats") {
      while (!options.signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      return { ...ok(), aborted: true };
    }
    if (command === "kill") {
      this.#kill?.();
      return ok();
    }
    if (command === "rm") {
      this.containers.delete(args.at(-1) ?? "");
      this.#created.delete(args.at(-1) ?? "");
      return ok();
    }
    if (command === "ps") {
      const filter = args[args.indexOf("--filter") + 1] ?? "";
      return ok(
        filter === "label=dejaml.lab" ? [...this.containers].map((name) => `${name}\tlab_${"a".repeat(32)}\trun_x`).join("\n") : "",
      );
    }
    return ok();
  }
}

/** Returns reviewed analyses so the pipeline can be exercised without a model provider. */
export class ScriptedModel implements StructuredModelClient {
  /** The repository the analysts report; defaults to the curated case's. */
  repositoryUrl: string | null = null;
  /** The Lab Reviewer's verdict per replica session; approves by default. */
  reviewVerdict: (sessionId: string) => "approve" | "reject" = () => "approve";

  constructor(
    private readonly curated: CuratedCase,
    private readonly timeoutSeconds: number,
    private readonly delayMs = 0,
    /** Lets a test alter the Lead Researcher's plan, for example to exceed policy. */
    private readonly editPlan: (plan: ExperimentPlan) => ExperimentPlan = (plan) => plan,
    private readonly labActionOverride?: (state: string, action: string) => string,
  ) {}

  async complete<T>(request: StructuredCompletionRequest<T>): Promise<{ value: T }> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (request.signal?.aborted) throw new Error("cancelled");
    const policy = this.curated.policy;
    const repositoryUrl = this.repositoryUrl ?? policy.repository.url;
    if (request.role === "lab_planner") {
      return {
        value: request.schema.parse({
          summary: "Wrap repo/train.py in a small adapter and write the accuracy to artifacts/result.json.",
          entrypoint: "repo/train.py",
          steps: ["Write work/run.py that runs repo/train.py", "Run it", "Submit artifacts/result.json"],
          risks: [],
        }),
      };
    }
    if (request.role === "lab_debugger") {
      return {
        value: request.schema.parse({ diagnosis: "The script failed.", suggestedFix: "Check the path.", reproducibleHere: true }),
      };
    }
    if (request.role === "lab_reviewer") {
      const verdict = this.reviewVerdict(request.sessionId);
      return {
        value: request.schema.parse({
          verdict,
          summary:
            verdict === "approve"
              ? "The adapter runs the repository's training script."
              : "The metric is not computed by the repository's model.",
          concerns: verdict === "approve" ? [] : ["metric written without running the model"],
        }),
      };
    }
    if (request.role === "lab_agent" && request.systemPrompt.includes("sealed Linux container")) {
      // Autonomous session: write an adapter, run it, submit what the run produced.
      const step = (JSON.parse(request.prompt) as { step?: number }).step ?? 1;
      const actions = [
        {
          tool: "write_file",
          path: "work/run.py",
          content: "import json, runpy\nrunpy.run_path('repo/train.py')\n",
          why: "Wrap the repository's training script",
        },
        { tool: "run", argv: ["python", "work/run.py"], why: "Run the experiment" },
        {
          tool: "submit",
          metricFile: "artifacts/result.json",
          key: "metrics.accuracyPercent",
          metricName: "accuracy",
          unit: "percent",
          split: "official test set",
          dataset: policy.claim.dataset,
          summary: "Ran the repository's Random Forest on the official test set",
        },
      ];
      return { value: request.schema.parse(actions[step - 1] ?? { tool: "give_up", reason: "script ended" }) };
    }
    if (request.role === "lab_agent") {
      const observation = JSON.parse(request.prompt) as { state: string };
      const action = (
        {
          not_created: "request_lab",
          ready: "run_approved_experiment",
          attempt_completed: "inspect_result",
          inspected: "finish",
        } as Record<string, string>
      )[observation.state];
      if (!action) throw new Error("unrecognized lab observation");
      const chosen = this.labActionOverride?.(observation.state, action) ?? action;
      return { value: request.schema.parse({ action: chosen, summary: `Lab Agent: ${chosen}` }) };
    }
    const claim = {
      experimentLabel: "Random Forest on UCI Urban Land Cover",
      dataset: policy.claim.dataset,
      split: "official test set",
      model: policy.claim.model,
      metric: { name: "accuracy", unit: policy.claim.unit, reportedValue: policy.claim.reportedValue },
      seed: null,
      hyperparameters: {},
      evidence: [{ kind: "paper_page" as const, reference: "page 1", excerpt: "Random Forest test accuracy of 81.66" }],
      missingFields: ["validation split seed"],
      confidence: "high" as const,
    };
    if (request.role === "paper_analyst") {
      return {
        value: request.schema.parse(
          PaperAnalysisSchema.parse({
            schemaVersion: 1,
            status: "ready",
            summary: "Extracted Random Forest test accuracy of 81.66%",
            selectedRepositoryUrl: repositoryUrl,
            claim,
            reasons: [],
            warnings: [],
          }),
        ),
      };
    }
    if (request.role === "audit_agent") {
      return {
        value: request.schema.parse(
          AuditDecisionSchema.parse({
            schemaVersion: 1,
            verdict: "confirmed",
            metricAligned: true,
            summary:
              "The measured accuracy metric matches the paper's Random Forest test accuracy claim on the UCI Urban Land Cover dataset.",
            evidence: [{ kind: "paper_page", reference: "page 1", excerpt: "Random Forest test accuracy of 81.66" }],
            concerns: [],
          }),
        ),
      };
    }
    if (request.role === "code_analyst") {
      return {
        value: request.schema.parse(
          CodeAnalysisSchema.parse({
            schemaVersion: 1,
            status: "ready",
            summary: "Mapped the paper claim to a CPU-compatible Random Forest run",
            mapping: {
              repositoryUrl,
              commitSha: policy.repository.commitSha,
              entrypoint: NOTEBOOK_PATH,
              relevantFiles: [{ path: NOTEBOOK_PATH, sha256: createHash("sha256").update(NOTEBOOK).digest("hex"), reason: "experiment" }],
              dependencyFiles: [],
              datasetReferences: ["UCI Urban Land Cover"],
              candidateCommand: null,
              metricEvidence: [{ kind: "repository_file", reference: NOTEBOOK_PATH }],
              warnings: ["The validation split seed is not fixed."],
            },
            reasons: [],
            warnings: [],
          }),
        ),
      };
    }
    const plan: ExperimentPlan = {
      caseId: policy.caseId,
      repository: { url: policy.repository.url, commitSha: policy.repository.commitSha },
      claim,
      dataset: policy.dataset,
      preparation: policy.preparation,
      executionAdapter: policy.trustedExecutionAdapter,
      command: policy.command,
      resources: { ...policy.maximumResources, timeoutSeconds: this.timeoutSeconds },
      metricExtraction: policy.metricExtraction,
      maxAttempts: 1,
      stopConditions: policy.requiredStopConditions,
    };
    return {
      value: request.schema.parse(
        LeadResearchDecisionSchema.parse({
          schemaVersion: 1,
          status: "ready",
          summary: "Approved one deterministic CPU experiment with seed 42",
          plan: this.editPlan(plan),
          reasons: [],
          warnings: [],
        }),
      ),
    };
  }
}

export async function paperPdf(withLink = true, repositoryUrl = "https://github.com/mtesha/tdl-vs-ml-urbanlandcover"): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText("Urban Land Cover: Random Forest test accuracy of 81.66 percent on the test set.", {
    x: 40,
    y: 730,
    size: 11,
    font,
  });
  pdf
    .addPage([612, 792])
    .drawText(
      withLink
        ? `Code: ${repositoryUrl} for reproducibility of every table.`
        : "Code is available from the authors on request for reproducibility of every table.",
      { x: 40, y: 730, size: 11, font },
    );
  return pdf.save();
}

/** Creates a checkout containing the curated notebook and a training script, pinned to the reviewed commit. */
export function standInAcquire(curated: CuratedCase, created: string[] = [], commitSha = curated.policy.repository.commitSha) {
  return async (input: { repositoryUrl: string; destinationRoot: string }): Promise<RepositoryReceipt> => {
    await mkdir(input.destinationRoot, { recursive: true });
    const destination = await mkdtemp(join(input.destinationRoot, "dejaml-repo-"));
    created.push(destination);
    await writeFile(join(destination, NOTEBOOK_PATH), NOTEBOOK);
    await writeFile(join(destination, "train.py"), "print('training')\n");
    await writeFile(join(destination, "requirements.txt"), "scikit-learn==1.9.1\n");
    const manifest = await buildRepositoryManifest(destination);
    return {
      schemaVersion: 1,
      repositoryUrl: input.repositoryUrl,
      commitSha,
      defaultBranch: "main",
      repositorySizeKb: 10,
      destination,
      acquiredAt: new Date().toISOString(),
      metadataSource: "unavailable",
      fileCount: manifest.entries.length,
      totalBytes: manifest.bytes,
      manifestSha256: manifest.sha256,
      manifest: manifest.entries,
    };
  };
}

type ScriptedCall = { name: string; input: unknown };

/**
 * Plays every role of the multi-agent study from a fixed script, for tests
 * and infrastructure proofs only. It exercises the real runtime, tools, labs,
 * and verdict code; it is not a model, and a run driven by it is never an
 * acceptance run. Each agent's next step is read from its own conversation.
 */
export class ScriptedStudyProvider implements ChatProvider {
  readonly id = "scripted";
  readonly kind = "scripted" as const;
  /** How the blind Reviewers judge each submission (code derives approve/reject from it). */
  review: { equivalence: "equivalent" | "partially_equivalent" | "not_equivalent" | "insufficient_evidence" } = {
    equivalence: "equivalent",
  };
  /** Changes to the Planner's plan (for policy tests). */
  plan: Record<string, unknown> = {};
  /** The Supervisor's final proposal; null proposes the computed status. */
  supervisorProposal: string | null = null;
  /** The Supervisor's answer at a checkpoint. */
  checkpoint: { action: "continue" | "replan" | "stop"; reason: string; guidance: string } = {
    action: "continue",
    reason: "none",
    guidance: "",
  };
  /** Engineers change the prepared environment before the approved run. */
  tamper = false;
  /** Engineers ask a Debugger for help after a failed run. */
  debugOnFailure = true;
  /** Delay per model call, so tests can cancel mid-study. */
  delayMs = 0;
  readonly systems: string[] = [];
  #counter = 0;

  constructor(private readonly repositoryUrl: string) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (request.signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    this.systems.push(request.system);
    const role = /^You are the ([A-Za-z ]+), one independent agent/u.exec(request.system)?.[1] ?? "";
    const turns = request.messages.filter((message) => message.role === "assistant").length;
    const toolResults = request.messages.filter((message) => message.role === "tool");
    const last = toolResults.at(-1);
    const lastJson = (): Record<string, unknown> => {
      try {
        return JSON.parse(last && last.role === "tool" ? last.content : "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const first = request.messages[0];
    const inputs =
      first && first.role === "user" ? (JSON.parse(first.content.slice(first.content.indexOf("\n{") + 1)) as Record<string, unknown>) : {};
    const calls = this.#step(role, turns, inputs, lastJson, last?.role === "tool" ? last.isError : false);
    const toolCalls: ToolCall[] = calls.map((call) => ({
      id: `call_${++this.#counter}`,
      name: call.name,
      input: call.input,
      rawInput: JSON.stringify(call.input),
    }));
    return {
      id: `scripted_${this.#counter}`,
      provider: "scripted",
      model: request.model,
      text: null,
      toolCalls,
      stopReason: "tool_use",
      usage: { inputTokens: 200, outputTokens: 40 },
      costUsd: null,
      attempts: 1,
    };
  }

  #step(
    role: string,
    turn: number,
    inputs: Record<string, unknown>,
    last: () => Record<string, unknown>,
    lastFailed: boolean,
  ): ScriptedCall[] {
    const finish = (input: unknown): ScriptedCall[] => [{ name: "finish", input }];
    switch (role) {
      case "Supervisor":
        if (inputs.resultKind === "verdict") {
          return finish({
            proposedStatus: this.supervisorProposal ?? inputs.computedStatus,
            rationale: "The evidence supports this status.",
          });
        }
        return finish(this.checkpoint);
      case "Paper Analyst":
        if (turn === 0) return [{ name: "paper_search", input: { query: "accuracy" } }];
        return finish({
          status: "ready",
          summary: "Random Forest test accuracy of 81.66% on UCI Urban Land Cover.",
          selectedRepositoryUrl: this.repositoryUrl,
          claim: {
            method: "Random Forest",
            dataset: "UCI Urban Land Cover",
            split: "official test set",
            preprocessing: "not stated",
            seedPolicy: "not stated",
            metric: { name: "accuracy", unit: "percent" },
            reportedValue: 81.66,
            page: 1,
            location: "Section 4",
            excerpt: "Random Forest test accuracy of 81.66 percent on the test set.",
            missingFields: ["seed"],
          },
          reasons: [],
        });
      case "Repository Analyst": {
        const candidates = (inputs.repositoryCandidates as Array<{ url: string }> | undefined) ?? [];
        if (turn === 0) return [{ name: "repo_acquire", input: { repositoryUrl: candidates[0]?.url ?? this.repositoryUrl } }];
        if (turn === 1) return [{ name: "repo_list", input: {} }];
        return finish({
          status: "ready",
          summary: "train.py trains the Random Forest and writes the test accuracy.",
          entrypoints: [{ path: "train.py", why: "trains and evaluates the model" }],
          dataFiles: [],
          dependencyFiles: ["requirements.txt"],
          metricSources: [{ path: "train.py", description: "writes artifacts/result.json" }],
          runInstructions: "python train.py",
          warnings: [],
        });
      }
      case "Reproduction Planner":
        if (turn === 0) return [{ name: "board_read", input: { kinds: ["paper_claim", "repository_mapping"] } }];
        return finish({
          status: "ready",
          summary: "Run train.py unchanged from a writable copy; it writes the accuracy to artifacts/result.json.",
          blockedReason: null,
          entrypoint: "train.py",
          command: { argv: ["python", "train.py"], cwd: "work/repo" },
          python: "3.11",
          requirements: [],
          compatibilityConstraints: [],
          dataset: { name: "UCI Urban Land Cover", source: { kind: "repository", paths: ["train.py"] } },
          metricParser: { source: "json", path: "artifacts/result.json", key: "metrics.accuracyPercent" },
          expectedRuntimeSeconds: 30,
          stopConditions: ["the command exits non-zero"],
          adapter: null,
          risks: [],
          ...this.plan,
        });
      case "Lab Engineer": {
        if (turn === 0 && this.tamper) return [{ name: "lab_run", input: { argv: ["touch", "work/.venv/x"] } }];
        const result = last();
        if (turn === 0 || (this.tamper && turn === 1)) return [{ name: "lab_run_official", input: {} }];
        if (lastFailed && this.debugOnFailure && typeof result.receiptId === "string" && turn < 4) {
          return [{ name: "request_debugging", input: { question: "The approved run failed; why?", receiptIds: [result.receiptId] } }];
        }
        if (typeof result.diagnosis === "string") return [{ name: "lab_run_official", input: {} }];
        if (typeof result.receiptId === "string" && result.exitCode === 0) {
          return finish({
            status: "measured",
            summary: "PRIVATE-ENGINEER-NOTE: ran the approved command.",
            officialReceiptId: result.receiptId,
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
      }
      case "Debugger":
        if (turn === 0) return [{ name: "lab_logs", input: {} }];
        return finish({
          diagnosis: "The script looked for its data in the wrong directory.",
          rootCause: "working directory",
          suggestedFix: "Run the approved command again.",
          fixableWithoutChangingThePlan: true,
          changesMethodology: false,
        });
      case "Independent Reviewer": {
        const key = String(inputs.submissionKey ?? "");
        if (turn === 0) return [{ name: "board_read", input: { key } }];
        if (turn === 1) return [{ name: "artifact_read", input: { engineerAgentId: key, path: "artifacts/result.json" } }];
        const approve = this.review.equivalence === "equivalent" || this.review.equivalence === "partially_equivalent";
        return finish({
          equivalence: this.review.equivalence,
          summary: approve ? "The approved official command ran and wrote the metric." : "The metric does not come from the paper's model.",
          checks: [
            { name: "official command ran", passed: true, explanation: "the official receipt exited 0" },
            { name: "metric from the run", passed: true, explanation: "artifact digest matches the official receipt" },
            {
              name: "dataset and metric match",
              passed: approve,
              explanation: "same dataset and metric as the claim",
            },
          ],
          concerns: [],
        });
      }
      default:
        return [{ name: "give_up", input: { reason: `unscripted role ${role}` } }];
    }
  }
}
