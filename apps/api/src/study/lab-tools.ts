import { randomUUID } from "node:crypto";
import { posix } from "node:path";

import { defineTool, sha256, type ToolContext, type ToolDefinition, ToolDenied } from "@dejaml/agent-runtime";
import { type CommandOutcome, LabError } from "@dejaml/lab-manager";
import { inspectEnvironmentCommand } from "@dejaml/prep";
import { z } from "zod";

import { executionContract } from "./blinding.js";

import { type CommandRecord, type EngineerLab, LAB_LAYOUT, PreparationFailure, type StudyContext } from "./context.js";
import { DiagnosisSchema, INSTRUCTIONS, RESULT_DESCRIPTIONS, ROLE_GRANTS, ROLE_LIMITS } from "./roles.js";
import { failed, MAX_READ_BYTES, MAX_SEARCH_MATCHES, ok, RelativePathInput, tail } from "./tool-helpers.js";

/**
 * The narrow lab tools. There is no host shell: every command runs inside the
 * agent's own sealed lab (no network, non-root, read-only root filesystem),
 * the approved command runs only through lab_run_official after an integrity
 * check, and the metric is parsed by the orchestrator, never typed by a model.
 */

/** Who ran a command: an agent's tool call, or the orchestrator itself. */
export type CommandActor = { receiptId: string; agentId: string; role: string };

export function orchestratorActor(): CommandActor {
  return { receiptId: `sys_${randomUUID().replaceAll("-", "")}`, agentId: "orchestrator", role: "system" };
}

export function requireLab(ctx: StudyContext, agentId: string): EngineerLab {
  const own = ctx.labsByAgent.get(agentId);
  if (own) {
    if (own.destroyed) throw new ToolDenied("your lab has been destroyed");
    return own;
  }
  // A Debugger reads the lab of the Engineer that asked for help.
  const parent = ctx.store.ledger.getAgent(agentId).parentId;
  const lab = parent ? ctx.labsByAgent.get(parent) : undefined;
  if (!lab || lab.destroyed) throw new ToolDenied("you have no lab");
  return lab;
}

function labCwd(requested: string | undefined): string {
  const cwd = requested?.trim() || ".";
  if (cwd.includes("\0") || posix.isAbsolute(cwd) || cwd.split("/").includes("..")) {
    throw new ToolDenied("cwd must be relative to /workspace/case and must not contain '..'");
  }
  return cwd === "." ? LAB_LAYOUT.workdir : posix.join(LAB_LAYOUT.workdir, posix.normalize(cwd));
}

export async function runInLab(
  ctx: StudyContext,
  lab: EngineerLab,
  actor: CommandActor,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutSeconds: number,
  options: { official?: boolean } = {},
): Promise<CommandRecord> {
  const [first, ...rest] = argv;
  if (!first) throw new ToolDenied("argv must name a program");
  // The lab accepts bare program names; an absolute path (such as the venv's
  // python) is run through env, which is itself a bare name.
  const command = first.startsWith("/") ? { executable: "env", args: ["--", first, ...rest] } : { executable: first, args: rest };
  let outcome: CommandOutcome;
  try {
    outcome = await ctx.labs.runCommand(
      lab.labId,
      { ...command, cwd, env },
      {
        timeoutSeconds: Math.min(timeoutSeconds, ctx.config.commandTimeoutSeconds),
        step: lab.commands.length + 1,
        observe: true,
        agent: lab.label,
      },
    );
  } catch (error) {
    if (error instanceof LabError && error.code === "command_rejected") throw new ToolDenied(error.message);
    throw error;
  }
  for (const artifact of outcome.artifacts) lab.artifacts.set(artifact.path, artifact);
  const official = options.official === true;
  const record: CommandRecord = {
    receiptId: actor.receiptId,
    agentId: actor.agentId,
    argv,
    cwd,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: Math.max(0, Math.round(outcome.durationMs)),
    stdoutSha256: sha256(outcome.stdout.text),
    stderrSha256: sha256(outcome.stderr.text),
    stdoutExcerpt: tail(outcome.stdout.text, 1_500),
    stderrExcerpt: tail(outcome.stderr.text, 1_500),
    artifacts: outcome.artifacts.map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
    stdoutTail: tail(outcome.stdout.text, 16_000),
    stderrTail: tail(outcome.stderr.text, 16_000),
    official,
    stdoutFull: official ? outcome.stdout.text : null,
    stdoutTruncated: outcome.stdout.truncated,
  };
  lab.commands.push(record);
  if (official) lab.official = record;
  ctx.runtime.board(ctx.runId).post({
    kind: "command_receipt",
    authorAgentId: actor.agentId === "orchestrator" ? null : actor.agentId,
    authorRole: actor.agentId === "orchestrator" ? "system" : (actor.role as never),
    key: lab.agentId,
    payload: {
      receiptId: record.receiptId,
      argv: record.argv,
      cwd: record.cwd,
      exitCode: record.exitCode,
      timedOut: record.timedOut,
      durationMs: record.durationMs,
      stdoutSha256: record.stdoutSha256,
      stderrSha256: record.stderrSha256,
      stdoutExcerpt: record.stdoutExcerpt,
      stderrExcerpt: record.stderrExcerpt,
      artifacts: record.artifacts,
      official,
      lab: lab.label,
      strayProcessesStopped: outcome.strayProcesses,
      stdoutTruncated: outcome.stdout.truncated,
      stderrTruncated: outcome.stderr.truncated,
    },
  });
  return record;
}

/**
 * Digests of what the approved command depends on: code and configuration in
 * work/repo, the plan's repository data files, the approved adapter, and the
 * virtual environment.
 * New output files are allowed; changed or added code is not.
 */
const INTEGRITY_SCRIPT = [
  "import hashlib, json, os, sys",
  "root, venv, data, adapter = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), sys.argv[4]",
  "CODE = ('.py', '.pyx', '.pxd', '.pth', '.so', '.c', '.cc', '.cpp', '.h', '.sh', '.cfg', '.ini', '.toml', '.yaml', '.yml', '.ipynb')",
  "def digest(base, keep):",
  "    if not os.path.isdir(base): return None",
  "    total, count = hashlib.sha256(), 0",
  "    for d, dirs, files in os.walk(base):",
  "        dirs.sort()",
  "        for name in sorted(files):",
  "            path = os.path.join(d, name); rel = os.path.relpath(path, base)",
  "            if os.path.islink(path):",
  "                total.update(b'L' + rel.encode() + b'\\0' + os.readlink(path).encode() + b'\\n'); count += 1; continue",
  "            if not keep(rel): continue",
  "            h = hashlib.sha256()",
  "            with open(path, 'rb') as handle:",
  "                for chunk in iter(lambda: handle.read(1 << 20), b''): h.update(chunk)",
  "            total.update(rel.encode() + b'\\0' + h.hexdigest().encode() + b'\\n'); count += 1",
  "    return total.hexdigest() + ':' + str(count)",
  "def code(rel):",
  "    parts = rel.split(os.sep)",
  "    if rel.endswith('.pyc'): return '__pycache__' not in parts",
  "    return rel.endswith(CODE) or any(rel == p or rel.startswith(p.rstrip('/') + '/') for p in data)",
  "print(json.dumps({'workRepo': digest(root, code), 'venv': digest(venv, lambda rel: '__pycache__' not in rel.split(os.sep)), 'adapter': digest(adapter, lambda rel: True)}))",
].join("\n");

export async function measureIntegrity(ctx: StudyContext, lab: EngineerLab, dataPaths: string[]): Promise<EngineerLab["integrity"]> {
  const record = await runInLab(
    ctx,
    lab,
    orchestratorActor(),
    [
      "python",
      "-I",
      "-S",
      "-c",
      INTEGRITY_SCRIPT,
      `${LAB_LAYOUT.workdir}/${LAB_LAYOUT.workRepo}`,
      LAB_LAYOUT.venv,
      JSON.stringify(dataPaths),
      `${LAB_LAYOUT.workdir}/${LAB_LAYOUT.adapterDir}`,
    ],
    LAB_LAYOUT.workdir,
    {},
    300,
  );
  if (record.exitCode !== 0)
    throw new PreparationFailure("integrity_check_failed", `the lab's integrity check failed: ${record.stderrTail.slice(-500)}`, "failed");
  const parsed = JSON.parse(record.stdoutTail) as { workRepo: string | null; venv: string | null; adapter?: string | null };
  return { workRepo: parsed.workRepo, venv: parsed.venv, adapter: parsed.adapter ?? null };
}

export function labTools(ctx: StudyContext): ToolDefinition[] {
  const inspect = async (agentId: string, request: Parameters<StudyContext["labs"]["inspectFiles"]>[1]) => {
    const lab = requireLab(ctx, agentId);
    try {
      return await ctx.labs.inspectFiles(lab.labId, request);
    } catch (error) {
      if (error instanceof LabError) throw new ToolDenied(error.message);
      throw error;
    }
  };
  const ownLab = (context: ToolContext): EngineerLab => {
    const lab = requireLab(ctx, context.agentId);
    if (ctx.labsByAgent.get(context.agentId) !== lab) throw new ToolDenied("only the lab's engineer may do this");
    return lab;
  };
  const contract = () => {
    if (!ctx.contract) throw new ToolDenied("there is no approved claim contract");
    return ctx.contract;
  };
  const commandView = (record: CommandRecord, bytes = 6_000) => ({
    receiptId: record.receiptId,
    official: record.official,
    argv: record.argv,
    exitCode: record.exitCode,
    timedOut: record.timedOut,
    durationMs: record.durationMs,
    stdout: tail(record.stdoutTail, bytes),
    stderr: tail(record.stderrTail, bytes),
    artifacts: record.artifacts,
  });

  return [
    defineTool({
      name: "lab_list",
      description: "List files in the lab, relative to /workspace/case (repo/, wheels/, data/, work/, artifacts/).",
      input: z.object({ path: RelativePathInput.default("."), depth: z.number().int().min(1).max(5).default(2) }),
      async run(input, context) {
        return ok(`Listed ${input.path}`, await inspect(context.agentId, { op: "list", path: input.path, depth: input.depth }));
      },
    }),
    defineTool({
      name: "lab_read",
      description: "Read a file in the lab, relative to /workspace/case.",
      input: z.object({
        path: RelativePathInput,
        offset: z.number().int().nonnegative().default(0),
        maxBytes: z.number().int().positive().max(MAX_READ_BYTES).default(MAX_READ_BYTES),
      }),
      async run(input, context) {
        return ok(
          `Read ${input.path}`,
          await inspect(context.agentId, { op: "read", path: input.path, offset: input.offset, maxBytes: input.maxBytes }),
        );
      },
    }),
    defineTool({
      name: "lab_search",
      description: "Search files in the lab for a regular expression, relative to /workspace/case.",
      input: z.object({ path: RelativePathInput.default("."), pattern: z.string().min(1).max(200) }),
      async run(input, context) {
        return ok(
          `Searched ${input.path} for ${input.pattern}`,
          await inspect(context.agentId, { op: "search", path: input.path, pattern: input.pattern, maxMatches: MAX_SEARCH_MATCHES }),
        );
      },
    }),
    defineTool({
      name: "lab_logs",
      description: "Read the bounded stdout and stderr of a command run in this lab, by receipt id (omit it for the latest).",
      input: z.object({ receiptId: z.string().max(100).optional() }),
      async run(input, context) {
        const lab = requireLab(ctx, context.agentId);
        const record = input.receiptId ? lab.commands.find((item) => item.receiptId === input.receiptId) : lab.commands.at(-1);
        if (!record)
          throw new ToolDenied(input.receiptId ? `no command with receipt ${input.receiptId} in this lab` : "no command has run yet");
        return ok(`Logs of ${record.receiptId}`, commandView(record, 12_000));
      },
    }),
    defineTool({
      name: "lab_artifacts",
      description: "List the files under artifacts/ with their size and SHA-256, as recorded after each command.",
      input: z.object({}),
      async run(_input, context) {
        const lab = requireLab(ctx, context.agentId);
        const items = [...lab.artifacts.values()];
        return ok(`${items.length} artifacts`, items.length ? items : "No artifacts yet.");
      },
    }),
    defineTool({
      name: "lab_run",
      description:
        "Run one command in your sealed lab (no network, non-root, read-only system) to inspect or prepare, for example creating an output directory. argv is the program and its arguments, not a shell string. cwd is relative to /workspace/case. It does not count as the approved run; use lab_run_official for that.",
      input: z.object({
        argv: z.array(z.string().max(20_000)).min(1).max(200),
        cwd: z.string().max(300).optional(),
        env: z
          .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u), z.string().max(1_000))
          .optional()
          .describe("Extra environment variables (PATH, HOME, PYTHONPATH and LD_* are not allowed)."),
        timeoutSeconds: z.number().int().min(1).max(3_600).default(300),
      }),
      async run(input, context) {
        const lab = ownLab(context);
        const record = await runInLab(ctx, lab, context, input.argv, labCwd(input.cwd), input.env ?? {}, input.timeoutSeconds);
        const summary = `exit ${String(record.exitCode)}${record.timedOut ? " (timed out)" : ""}: ${input.argv.join(" ").slice(0, 160)}`;
        return record.exitCode === 0
          ? ok(summary, commandView(record), { exitCode: record.exitCode })
          : failed(summary, commandView(record), { exitCode: record.exitCode });
      },
    }),
    defineTool({
      name: "lab_run_official",
      description:
        "Run the approved command exactly as the claim contract states it (the plan's argv with the prepared Python, from the plan's cwd). The lab first checks that the code, the plan's data files, and the Python environment are unchanged since setup, and refuses otherwise. The metric is parsed from this run by the lab.",
      input: z.object({}),
      async run(_input, context) {
        const lab = ownLab(context);
        const approved = contract();
        if (lab.official && lab.official.exitCode === 0 && !lab.official.timedOut) {
          throw new ToolDenied(`the approved command already succeeded (receipt ${lab.official.receiptId}); finish with that receipt`);
        }
        const dataPaths = approved.dataset.source.kind === "repository" ? approved.dataset.source.paths : [];
        const now = await measureIntegrity(ctx, lab, dataPaths);
        const changed = [
          now.workRepo !== lab.integrity.workRepo ? "the code or data in work/repo" : null,
          now.venv !== lab.integrity.venv ? "the Python environment" : null,
          now.adapter !== lab.integrity.adapter ? "the approved adapter" : null,
        ].filter(Boolean);
        if (changed.length) {
          return {
            ...failed(
              "Refused: the prepared state changed",
              `Refused: ${changed.join(" and ")} changed since the lab was set up. The approved command runs only on the prepared state; report the change as a deviation or request a re-plan with dependency_request.`,
            ),
            status: "denied",
          };
        }
        const [, ...args] = approved.command.argv;
        const timeout = Math.min(ctx.config.commandTimeoutSeconds, Math.max(120, approved.expectedRuntimeSeconds * 4));
        const record = await runInLab(
          ctx,
          lab,
          context,
          [`${LAB_LAYOUT.venv}/bin/python`, ...args],
          posix.join(LAB_LAYOUT.workdir, approved.command.cwd),
          {},
          timeout,
          { official: true },
        );
        ctx.event(
          "official_run",
          record.exitCode === 0 ? "completed" : "warning",
          `${lab.label} ran the approved command: exit ${String(record.exitCode)}${record.timedOut ? " (timed out)" : ""}`,
          {
            engineer: lab.label,
            receiptId: record.receiptId,
            exitCode: record.exitCode,
            durationMs: record.durationMs,
          },
        );
        const summary = `approved command exit ${String(record.exitCode)}${record.timedOut ? " (timed out)" : ""}`;
        return record.exitCode === 0
          ? ok(summary, commandView(record), { exitCode: record.exitCode, official: true })
          : failed(summary, commandView(record), { exitCode: record.exitCode, official: true });
      },
    }),
    defineTool({
      name: "lab_destroy",
      description:
        "Tell the lab you are done: its artifacts are exported and the lab is destroyed. Lab tools stop working afterwards; call finish next.",
      input: z.object({ reason: z.string().min(1).max(300) }),
      async run(input, context) {
        const lab = ownLab(context);
        await ctx.finishLab(lab.agentId, input.reason);
        return ok("Lab destroyed", `${lab.label}'s artifacts were exported and its lab destroyed.`);
      },
    }),
    defineTool({
      name: "dependency_manifest",
      description: "Show the prepared dependency manifest: exact packages, versions, wheel file names, platform tags, and SHA-256.",
      input: z.object({}),
      async run() {
        const prepared = ctx.prepared;
        if (!prepared) return ok("No dependencies were prepared", "The plan needs no Python packages beyond the standard library.");
        return ok(`${prepared.packages.length} prepared packages`, {
          manifestSha256: prepared.manifestSha256,
          python: prepared.python,
          platform: prepared.containerPlatform,
          packages: prepared.packages.map((item) => ({
            name: item.name,
            version: item.version,
            filename: item.filename,
            tags: item.tags,
            sha256: item.sha256,
          })),
          compatibilityChanges: prepared.changes,
        });
      },
    }),
    defineTool({
      name: "dependency_inspectEnvironment",
      description: "List the Python version and installed distributions of the lab's virtual environment.",
      input: z.object({}),
      async run(_input, context) {
        const lab = requireLab(ctx, context.agentId);
        const record = await runInLab(ctx, lab, context, inspectEnvironmentCommand(LAB_LAYOUT.venv), LAB_LAYOUT.workdir, {}, 60);
        if (record.exitCode !== 0) return failed("Environment inspection failed", record.stderrTail);
        try {
          const parsed = JSON.parse(record.stdoutTail) as { python: string; distributions: Array<{ name: string; version: string }> };
          lab.environment = { python: parsed.python, distributions: parsed.distributions };
          return ok(`Python ${parsed.python} with ${parsed.distributions.length} distributions`, parsed);
        } catch {
          return failed("Environment inspection returned unreadable output", record.stdoutTail);
        }
      },
    }),
    defineTool({
      name: "dependency_request",
      description:
        "Record that the approved command needs a different or additional Python package. The study re-plans (once) with your request; nothing is installed into this lab. Finish as not_measured afterwards.",
      input: z.object({ requirements: z.array(z.string().min(1).max(200)).min(1).max(20), reason: z.string().min(1).max(1_000) }),
      async run(input, context) {
        const lab = ownLab(context);
        lab.dependencyRequest = { requirements: input.requirements, reason: input.reason };
        context.board.post({
          kind: "dependency_request",
          authorAgentId: context.agentId,
          authorRole: context.role,
          key: lab.agentId,
          payload: { requirements: input.requirements, reason: input.reason },
        });
        return ok(
          "Dependency request recorded",
          "Recorded. The Supervisor and Planner will decide on a re-plan; finish now as not_measured.",
        );
      },
    }),
    defineTool({
      name: "dependency_check",
      description:
        "Check, without installing anything, whether binary wheels exist for these requirements on the lab platform and the Python version you plan to use. GPU packages (CUDA, ROCm) and source builds are refused.",
      input: z.object({
        requirements: z.array(z.string().min(1).max(200)).min(1).max(100),
        python: z.enum(["3.10", "3.11", "3.12", "3.13"]),
      }),
      async run(input, context) {
        if (!ctx.dependencies) throw new ToolDenied("dependency preparation is disabled on this server");
        const platform = {
          ...ctx.config.platform,
          python: { ...ctx.config.platform.python, version: input.python, abi: `cp${input.python.replace(".", "")}` },
        };
        const screen = ctx.dependencies.screen(input.requirements, platform);
        if (screen.refused.length)
          return failed("Some requirements are refused by policy", screen.refused, { refused: screen.refused.length });
        try {
          const result = await ctx.dependencies.check({
            runId: ctx.runId,
            platform,
            requirements: input.requirements,
            signal: context.signal,
          });
          return result.ok
            ? ok("Binary wheels exist for every requirement", result.detail)
            : failed("Some requirements have no compatible wheel", result.detail);
        } catch (error) {
          if (error instanceof PreparationFailure)
            return failed(`Check failed: ${error.code}`, { code: error.code, message: error.message, requirement: error.requirement });
          throw error;
        }
      },
    }),
    defineTool({
      name: "request_debugging",
      description:
        "Ask an independent Debugger agent to diagnose a failure. It reads the approved plan, your command receipts, and your lab's files (read-only) and returns a diagnosis and the smallest faithful fix. It cannot change your lab.",
      input: z.object({ question: z.string().min(1).max(2_000), receiptIds: z.array(z.string().max(100)).max(10).default([]) }),
      async run(input, context) {
        const lab = ownLab(context);
        const record = ctx.store.ledger.getAgent(context.agentId);
        const count = ctx.store.ledger.listAgents(ctx.runId).filter((item) => item.parentId === context.agentId).length;
        if (count >= 2) throw new ToolDenied("two Debuggers already helped with this lab; finish with what you know");
        const helper = await ctx.runtime.startAgent({
          runId: ctx.runId,
          role: "debugger",
          parentAgentId: context.agentId,
          label: `${lab.label}-debugger-${count + 1}`,
          instructions: INSTRUCTIONS.debugger,
          objective: `Diagnose this failure in ${lab.label}'s lab: ${input.question}`,
          inputs: {
            question: input.question,
            failingReceiptIds: input.receiptIds,
            engineer: lab.label,
            boardKey: lab.agentId,
            // The execution view only: never the reported value, tolerance, or paper excerpt.
            contract: ctx.contract ? executionContract(ctx.contract) : null,
            hint: "Read command_receipt entries with key equal to boardKey and lab_logs for full output; the lab is at /workspace/case.",
          },
          grants: [...ROLE_GRANTS.debugger],
          limits: ROLE_LIMITS.debugger,
          result: { schema: DiagnosisSchema, description: RESULT_DESCRIPTIONS.debugger },
          provider: { id: record.provider, model: record.model },
        });
        const outcome = await helper.done;
        if (outcome.status !== "completed" || !outcome.result) {
          return failed(`The Debugger did not finish (${outcome.status})`, outcome.reason ?? outcome.status);
        }
        context.board.post({
          kind: "diagnosis",
          authorAgentId: helper.agentId,
          authorRole: "debugger",
          key: lab.agentId,
          payload: outcome.result,
        });
        return ok(`Diagnosis from ${helper.agentId}`, outcome.result, { debuggerAgentId: helper.agentId });
      },
    }),
    defineTool({
      name: "artifact_read",
      description:
        "Read an artifact exported from a finished engineer's lab. Give the engineer's agent id (the submission key) and the artifact path.",
      input: z.object({ engineerAgentId: z.string().min(1).max(100), path: z.string().min(1).max(300) }),
      async run(input) {
        const exported = ctx.exports.get(input.engineerAgentId);
        if (!exported) throw new ToolDenied("no exported artifacts for that engineer");
        const item = exported.find((artifact) => artifact.path === input.path);
        if (!item) throw new ToolDenied(`not exported; available: ${exported.map((artifact) => artifact.path).join(", ") || "none"}`);
        if (item.text === null)
          return ok(`${item.path} is binary`, { path: item.path, sha256: item.sha256, bytes: item.bytes, binary: true });
        return ok(`Read ${item.path}`, {
          path: item.path,
          sha256: item.sha256,
          bytes: item.bytes,
          content: item.text.slice(0, MAX_READ_BYTES),
        });
      },
    }),
    defineTool({
      name: "logs_read",
      description:
        "Read the bounded stdout and stderr of a command a finished engineer ran, by the engineer's agent id and the receipt id.",
      input: z.object({ engineerAgentId: z.string().min(1).max(100), receiptId: z.string().min(1).max(100) }),
      async run(input) {
        const lab = ctx.labsByAgent.get(input.engineerAgentId);
        if (!lab) throw new ToolDenied("no lab for that engineer");
        const record = lab.commands.find((item) => item.receiptId === input.receiptId);
        if (!record) throw new ToolDenied(`no command with receipt ${input.receiptId}`);
        return ok(`Logs of ${record.receiptId}`, commandView(record, 12_000));
      },
    }),
  ];
}
