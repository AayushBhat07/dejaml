import { posix } from "node:path";

import { AttemptSchema, type Attempt, type Claim, type CodeMapping } from "@dejaml/contracts";
import type { ArtifactContent, ArtifactSummary, CommandOutcome, LabManager } from "@dejaml/lab-manager";
import type { RunStore } from "@dejaml/run-store";
import { z } from "zod";

import { diagnoseLabFailure, planLabWork, type LabDiagnosis, type LabPlan } from "./lab-team.js";
import type { StructuredModelClient } from "./model.js";

const Why = z.string().min(1).max(300);

export const AutonomousLabActionSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("run"),
    argv: z.array(z.string().max(20_000)).min(1).max(64),
    cwd: z.string().max(256).optional(),
    timeoutSeconds: z.number().int().positive().max(3_600).optional(),
    why: Why,
  }),
  z.object({
    tool: z.literal("write_file"),
    path: z.string().min(1).max(256),
    content: z.string().max(64 * 1024),
    why: Why,
  }),
  z.object({
    tool: z.literal("submit"),
    metricFile: z.string().min(1).max(256),
    key: z.string().min(1).max(200),
    metricName: z.string().min(1).max(120),
    unit: z.enum(["fraction", "percent", "score"]),
    split: z.string().min(1).max(120),
    dataset: z.string().min(1).max(200),
    summary: z.string().min(1).max(600),
  }),
  z.object({
    tool: z.literal("give_up"),
    reason: z.string().min(1).max(600),
  }),
]);
export type AutonomousLabAction = z.infer<typeof AutonomousLabActionSchema>;
export type AutonomousSubmission = Extract<AutonomousLabAction, { tool: "submit" }>;

export type AutonomousLabBudget = {
  /** Model turns, including rejected ones. */
  maxSteps: number;
  /** Wall time for the whole session, commands included. */
  wallSeconds: number;
  /** Default and ceiling for one command. */
  commandTimeoutSeconds: number;
};

export const DEFAULT_AUTONOMOUS_BUDGET: AutonomousLabBudget = {
  maxSteps: 30,
  wallSeconds: 1_200,
  commandTimeoutSeconds: 300,
};

export type AutonomousLabLayout = {
  workdir: string;
  repoDir: string;
  scratchDir: string;
  artifactsDir: string;
};

export type TranscriptEntry = {
  step: number;
  action: AutonomousLabAction | null;
  observation: Record<string, unknown>;
};

export type AutonomousLabResult = {
  status: "submitted" | "rejected" | "gave_up" | "exhausted" | "lab_failed";
  reason: string | null;
  submission: AutonomousSubmission | null;
  /** The command that produced the metric file, recorded as an unmodified-repository attempt. */
  attempt: Attempt | null;
  stdout: string;
  artifact: ArtifactContent | null;
  transcript: TranscriptEntry[];
  files: Array<ArtifactSummary & { content: string }>;
  steps: number;
  /** Present when the agent worked as a team: the Planner's plan and the Debugger's diagnoses. */
  team?: { plan: LabPlan | null; diagnoses: Array<{ step: number; diagnosis: LabDiagnosis }> };
};

/** The Debugger is consulted at most this many times per session. */
const MAX_DIAGNOSES = 6;

type Labs = Pick<LabManager, "runCommand" | "writeScratchFile" | "freezeLab" | "readArtifact" | "state">;

const WRITER_EXECUTABLES = new Set(["echo", "printf", "cat", "tee", "cp", "mv", "ln", "dd", "install", "touch"]);

export function buildAutonomousLabSystemPrompt(team = false): string {
  return [
    team
      ? "You are the Engineer on a DéjàML lab team inside a sealed Linux container, reproducing one claim from an ML paper. A Planner wrote the plan in your brief; after a failed command a Debugger may add debuggerAdvice to the observation. You alone run commands and decide what to do."
      : "You are DéjàML's Lab Agent. You work alone inside a sealed Linux container to reproduce one claim from an ML paper.",
    "Each turn, return exactly one JSON action. After each action you receive its observation.",
    "Tools:",
    '- run: execute argv (no shell unless you call ["bash","-lc","..."]) with an optional cwd relative to the workspace.',
    "- write_file: create or replace a file under the scratch directory (scripts, configs, small adapters).",
    "- submit: name the JSON metric file under the artifacts directory and the dotted key holding the measured value.",
    "- give_up: stop when the claim cannot be reproduced here, with the concrete reason.",
    "Rules:",
    "- The container has no network. You cannot install packages or download data. Use what the repository and the image provide.",
    "- The repository is read-only. Put your own code in the scratch directory and make it import or call the repository's code.",
    "- Compute the metric by actually running the experiment. Write it to a JSON file in the artifacts directory from the same run.",
    "- A submission is rejected if the metric file was not produced by a successful run command, or if the reported value appears literally in your files or command.",
    "- Prefer the repository's own entry point, settings, and seed. Keep the claimed setup (data, split, model, hyperparameters); if the limits force a change, say so in the submit summary.",
    "- Be efficient: inspect, run, read errors, fix, and submit. Never claim a number you did not observe.",
  ].join("\n");
}

function briefPrompt(input: {
  plan?: LabPlan | null;
  claim: Claim;
  mapping: CodeMapping | null;
  layout: AutonomousLabLayout;
  budget: AutonomousLabBudget;
  environment: Record<string, unknown>;
}): string {
  return JSON.stringify({
    task: "Reproduce this paper claim and submit the measured metric.",
    claim: input.claim,
    ...(input.plan ? { plannerPlan: input.plan } : {}),
    codeAnalystHints: input.mapping
      ? {
          entrypoint: input.mapping.entrypoint,
          relevantFiles: input.mapping.relevantFiles.map((file) => ({ path: file.path, reason: file.reason })),
          dependencyFiles: input.mapping.dependencyFiles,
          datasetReferences: input.mapping.datasetReferences,
          candidateCommand: input.mapping.candidateCommand,
          warnings: input.mapping.warnings,
        }
      : null,
    workspace: {
      cwd: input.layout.workdir,
      repository: `${input.layout.repoDir}/ (read-only)`,
      scratch: `${input.layout.scratchDir}/ (writable, for your files)`,
      artifacts: `${input.layout.artifactsDir}/ (writable, put the metric JSON here)`,
    },
    environment: input.environment,
    budget: input.budget,
  });
}

/**
 * An autonomous agent session inside one disposable lab. The model decides
 * every command; the host enforces the lab's isolation, the step and time
 * budget, and the provenance rules for the submitted metric.
 */
export async function runAutonomousLabAgent(input: {
  runId: string;
  labId: string;
  /** Names an independent replica, e.g. "agent-2"; each replica has its own model session. */
  agentName?: string;
  /** Work as a team: a Planner writes the plan and a Debugger diagnoses failed commands. */
  team?: boolean;
  claim: Claim;
  mapping: CodeMapping | null;
  layout: AutonomousLabLayout;
  labs: Labs;
  model: StructuredModelClient;
  store: RunStore;
  budget?: Partial<AutonomousLabBudget>;
  environment?: Record<string, unknown>;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<AutonomousLabResult> {
  const budget = { ...DEFAULT_AUTONOMOUS_BUDGET, ...input.budget };
  const now = input.now ?? Date.now;
  const deadline = now() + budget.wallSeconds * 1_000;
  const { layout } = input;
  const agentName = input.agentName;
  const label = agentName ? `Lab Agent ${agentName.replace(/^agent-/u, "")}` : "Lab Agent";
  const transcript: TranscriptEntry[] = [];
  const files = new Map<string, ArtifactSummary & { content: string }>();
  const commands = new Map<number, CommandOutcome>();
  /** Which step last produced each artifact, and with which digest. */
  const producedBy = new Map<string, { step: number; sha256: string }>();
  let artifacts = new Map<string, string>();
  let consecutiveInvalid = 0;
  let plan: LabPlan | null = null;
  const diagnoses: Array<{ step: number; diagnosis: LabDiagnosis }> = [];

  const event = (
    type: string,
    status: "progress" | "completed" | "warning" | "failed",
    summary: string,
    payload: Record<string, unknown> = {},
  ): void => {
    input.store.appendEvent({
      runId: input.runId,
      actor: "lab_engineer",
      type,
      status,
      summary: summary.slice(0, 300),
      evidence: [],
      publicPayload: agentName ? { agent: agentName, ...payload } : payload,
    });
  };
  const result = (
    status: AutonomousLabResult["status"],
    reason: string | null,
    extra: Partial<AutonomousLabResult> = {},
  ): AutonomousLabResult => ({
    status,
    reason,
    submission: null,
    attempt: null,
    stdout: "",
    artifact: null,
    transcript,
    files: [...files.values()],
    steps: transcript.length,
    ...(input.team ? { team: { plan, diagnoses } } : {}),
    ...extra,
  });

  event("lab_agent_started", "progress", `${label} is working autonomously inside its sealed lab`, {
    budget,
    layout,
  });

  const teamContext = {
    runId: input.runId,
    ...(agentName ? { agentName } : {}),
    model: input.model,
    store: input.store,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  if (input.team) {
    try {
      const listing = await input.labs.runCommand(
        input.labId,
        { executable: "find", args: [layout.repoDir, "-maxdepth", "3", "-not", "-path", "*/.git*"], cwd: layout.workdir, env: {} },
        { timeoutSeconds: 30, step: 0, ...(agentName ? { agent: agentName } : {}) },
      );
      plan = await planLabWork({
        ...teamContext,
        claim: input.claim,
        mapping: input.mapping,
        repositoryListing: listing.stdout.text,
        environment: input.environment ?? {},
      });
    } catch (error) {
      if (input.signal?.aborted) return result("lab_failed", "cancelled");
      event("lab_plan_failed", "warning", `Planner could not write a plan; the Engineer continues alone: ${message(error)}`);
    }
  }

  let observation: Record<string, unknown> = { event: "session_started" };
  for (let step = 1; step <= budget.maxSteps; step += 1) {
    if (input.signal?.aborted) return result("lab_failed", "cancelled");
    const remainingSeconds = Math.floor((deadline - now()) / 1_000);
    if (remainingSeconds <= 0) return result("exhausted", `wall-time budget of ${budget.wallSeconds}s spent`);

    const prompt =
      step === 1
        ? briefPrompt({
            plan,
            claim: input.claim,
            mapping: input.mapping,
            layout,
            budget,
            environment: input.environment ?? {},
          })
        : JSON.stringify({
            step,
            stepsLeft: budget.maxSteps - step + 1,
            secondsLeft: remainingSeconds,
            observation,
            recentSteps: transcript.slice(-12).map(summarizeEntry),
          });

    let action: AutonomousLabAction;
    try {
      const decision = await input.model.complete({
        sessionId: `${input.runId}:lab_agent${agentName ? `:${agentName}` : ""}`,
        role: "lab_agent",
        systemPrompt: buildAutonomousLabSystemPrompt(input.team === true),
        prompt,
        schema: AutonomousLabActionSchema,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      action = decision.value;
      consecutiveInvalid = 0;
    } catch (error) {
      if (input.signal?.aborted) return result("lab_failed", "cancelled");
      consecutiveInvalid += 1;
      observation = { error: `invalid action: ${message(error).slice(0, 500)}` };
      transcript.push({ step, action: null, observation });
      if (consecutiveInvalid >= 3) return result("lab_failed", "the model returned three invalid actions in a row");
      continue;
    }

    if (action.tool === "give_up") {
      transcript.push({ step, action, observation: {} });
      event("lab_agent_gave_up", "warning", `${label} stopped: ${action.reason}`, { step });
      return result("gave_up", action.reason);
    }

    if (action.tool === "write_file") {
      const path = relativeToWorkdir(action.path, layout.workdir);
      try {
        const summary = await input.labs.writeScratchFile(input.labId, path, action.content, step);
        files.set(summary.path, { ...summary, content: action.content });
        observation = { wrote: summary.path, bytes: summary.bytes };
      } catch (error) {
        observation = { error: message(error) };
      }
      transcript.push({ step, action, observation });
      continue;
    }

    if (action.tool === "run") {
      const [executable = "", ...args] = action.argv;
      const cwd = action.cwd ? posix.normalize(posix.join(layout.workdir, relativeToWorkdir(action.cwd, layout.workdir))) : layout.workdir;
      const timeoutSeconds = Math.min(
        action.timeoutSeconds ?? budget.commandTimeoutSeconds,
        budget.commandTimeoutSeconds,
        remainingSeconds,
      );
      let outcome: CommandOutcome;
      try {
        outcome = await input.labs.runCommand(
          input.labId,
          { executable, args, cwd, env: {} },
          { timeoutSeconds, step, observe: true, ...(agentName ? { agent: agentName } : {}) },
        );
      } catch (error) {
        const state = input.labs.state(input.labId);
        observation = { error: message(error) };
        transcript.push({ step, action, observation });
        if (!["ready", "idle"].includes(state)) return result("lab_failed", `the lab stopped: ${message(error)}`);
        continue;
      }
      commands.set(step, outcome);
      const next = new Map(outcome.artifacts.map((item) => [item.path, item.sha256]));
      const changed: string[] = [];
      for (const [path, sha256] of next) {
        if (artifacts.get(path) !== sha256) {
          producedBy.set(path, { step, sha256 });
          changed.push(path);
        }
      }
      artifacts = next;
      observation = {
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        stdout: tail(outcome.stdout.text, 6_000),
        stderr: tail(outcome.stderr.text, 6_000),
        outputTruncated: outcome.stdout.truncated || outcome.stderr.truncated,
        artifactsChanged: changed,
      };
      if (input.team && (outcome.exitCode !== 0 || outcome.timedOut) && diagnoses.length < MAX_DIAGNOSES) {
        try {
          const diagnosis = await diagnoseLabFailure({
            ...teamContext,
            claim: input.claim,
            plan,
            failedCommand: action.argv,
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            stdout: outcome.stdout.text,
            stderr: outcome.stderr.text,
            files: [...files.values()],
            recentSteps: transcript.slice(-8).map(summarizeEntry),
          });
          diagnoses.push({ step, diagnosis });
          observation.debuggerAdvice = diagnosis;
        } catch (error) {
          if (input.signal?.aborted) return result("lab_failed", "cancelled");
        }
      }
      transcript.push({ step, action, observation });
      const state = input.labs.state(input.labId);
      if (!["ready", "idle"].includes(state)) return result("lab_failed", `the lab is ${state}`);
      continue;
    }

    // submit
    const metricFile = relativeToWorkdir(action.metricFile, layout.workdir);
    const producer = producedBy.get(metricFile);
    const producingCommand = producer ? commands.get(producer.step) : undefined;
    const problem = !metricFile.startsWith(`${layout.artifactsDir}/`)
      ? `the metric file must be under ${layout.artifactsDir}/`
      : !producer || !producingCommand
        ? `${metricFile} was not produced by any run command`
        : artifacts.get(metricFile) !== producer.sha256
          ? `${metricFile} changed after step ${producer.step}`
          : producingCommand.exitCode !== 0 || producingCommand.timedOut
            ? `step ${producer.step}, which produced ${metricFile}, did not exit cleanly`
            : WRITER_EXECUTABLES.has(producingCommand.command.executable)
              ? `step ${producer.step} only wrote a file; the metric must come from running the experiment`
              : null;
    if (problem) {
      observation = { submissionRejected: problem };
      transcript.push({ step, action, observation });
      event("lab_agent_submission_rejected", "warning", `Submission rejected: ${problem}`, { step });
      continue;
    }

    // From here on nothing may change the lab: pause it, then export.
    await input.labs.freezeLab(input.labId);
    const artifact = await input.labs.readArtifact(input.labId, metricFile);
    transcript.push({ step, action, observation: { accepted: metricFile, sha256: artifact.sha256 } });
    const attempt = AttemptSchema.parse({
      id: `${input.runId}:${agentName ? `${agentName}:` : ""}step-${producer!.step}`,
      runId: input.runId,
      number: producer!.step,
      label: "baseline",
      command: producingCommand!.command,
      changes: [],
      startedAt: producingCommand!.startedAt,
      endedAt: producingCommand!.endedAt,
      exitCode: producingCommand!.exitCode,
      timedOut: false,
      cancelled: false,
      artifactDigests: Object.fromEntries(producingCommand!.artifacts.map((item) => [item.path, item.sha256])),
    });
    const base = { submission: action, attempt, stdout: producingCommand!.stdout.text, artifact };

    const value = readNumber(artifact.content.toString("utf8"), action.key);
    const literal =
      value === null
        ? null
        : findLiteral(value, [producingCommand!.command.args.join(" "), ...[...files.values()].map((file) => file.content)]);
    if (literal) {
      const reason = `the reported value ${literal} appears literally in the agent's command or files`;
      event("lab_agent_submission_rejected", "failed", `Submission rejected: ${reason}`, { step });
      return result("rejected", reason, base);
    }
    event("lab_agent_submitted", "completed", action.summary, {
      step,
      metricFile,
      key: action.key,
      producedByStep: producer!.step,
      command: [producingCommand!.command.executable, ...producingCommand!.command.args],
      agentFiles: [...files.values()].map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    });
    return result("submitted", null, base);
  }
  return result("exhausted", `step budget of ${budget.maxSteps} spent`);
}

function relativeToWorkdir(path: string, workdir: string): string {
  const trimmed = path.startsWith(`${workdir}/`) ? path.slice(workdir.length + 1) : path.replace(/^\.\//u, "");
  return posix.normalize(trimmed);
}

function tail(text: string, limit: number): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeEntry(entry: TranscriptEntry): string {
  const action = entry.action;
  const outcome =
    "exitCode" in entry.observation
      ? `exit ${String(entry.observation.exitCode)}`
      : "error" in entry.observation
        ? `error`
        : "submissionRejected" in entry.observation
          ? "rejected"
          : "ok";
  if (!action) return `${entry.step}: invalid action`;
  if (action.tool === "run") return `${entry.step}: run ${action.argv.join(" ").slice(0, 160)} -> ${outcome}`;
  if (action.tool === "write_file") return `${entry.step}: write ${action.path} -> ${outcome}`;
  return `${entry.step}: ${action.tool} -> ${outcome}`;
}

function readNumber(content: string, key: string): number | null {
  try {
    let current: unknown = JSON.parse(content);
    for (const segment of key.split(".")) {
      if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, segment)) {
        return null;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return typeof current === "number" && Number.isFinite(current) ? current : null;
  } catch {
    return null;
  }
}

/**
 * Finds the measured value written out literally in agent-controlled text.
 * Only values with at least three significant digits are checked, so small
 * constants such as 0.5 or 10 do not cause false alarms.
 */
export function findLiteral(value: number, texts: string[]): string | null {
  const forms = new Set([String(value), value.toFixed(2), value.toFixed(3), value.toFixed(4)]);
  for (const form of forms) {
    if (form.replace(/^-?0?\.?0*/u, "").replace(/[^0-9]/gu, "").length < 3) continue;
    const pattern = new RegExp(`(?<![0-9.])${form.replace(/[.-]/gu, "\\$&")}(?![0-9])`, "u");
    if (texts.some((text) => pattern.test(text))) return form;
  }
  return null;
}
