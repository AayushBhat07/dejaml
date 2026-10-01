import type { RunEvent } from "@dejaml/contracts";

import { describeArgv, redact } from "./redact";

/**
 * Everything the Live Run Dashboard shows is derived here from the run's
 * public event stream, in one pass, in sequence order. Nothing is invented:
 * a card, a lab, or a stage exists only because an event said so, and a
 * waiting role says what it waits for according to the study's real
 * dependency order. Hidden reasoning is never read: `agent_turn` carries a
 * bounded copy of the model's visible text in its payload, and the dashboard
 * deliberately shows only the turn's tool names.
 */

export type Role = RunEvent["actor"];

export type AgentStatus = "waiting" | "running" | "using_tool" | "blocked" | "reviewing" | "done" | "failed" | "cancelled";

export const TERMINAL_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set(["done", "failed", "cancelled"]);

export type AgentCard = {
  /** Stable React key: the agent id, or `role:<role>` / `engineer:<label>` before an instance exists. */
  key: string;
  agentId: string | null;
  role: Role;
  label: string | null;
  status: AgentStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** The latest public activity: a summary, a tool name, a lab step. Never model text. */
  activity: string;
  /** Why the card waits or is blocked, in the study's own dependency terms. */
  waitingReason: string | null;
  /** Tool calls so far; null where the stream has no tool calls (older recorded runs). */
  toolCalls: number | null;
  turns: number;
  tokens: { input: number; output: number } | null;
  warnings: number;
  failures: number;
  failureReason: string | null;
  parentAgentId: string | null;
  /** A role with no instance yet. */
  placeholder: boolean;
};

export type TerminalLine = { stream: "stdout" | "stderr"; text: string; key: string };

export type LabState = "creating" | "ready" | "running" | "idle" | "failed" | "cancelled" | "timed_out" | "removed" | "cleanup_failed";

export type LabCard = {
  labId: string;
  /** The engineer this lab belongs to, such as `engineer-1`; null until the stream names it. */
  label: string | null;
  state: LabState;
  image: string | null;
  platform: string | null;
  isolation: {
    network: string;
    readOnlyRoot: boolean;
    sealed: boolean | null;
    cpus: number | null;
    memoryMb: number | null;
    pids: number | null;
    timeoutSeconds: number | null;
    lifetimeSeconds: number | null;
  } | null;
  createdAt: string;
  endedAt: string | null;
  /** The latest command the lab ran or is running. */
  current: {
    step: number | null;
    text: string;
    startedAt: string;
    running: boolean;
    exitCode: number | null;
    durationMs: number | null;
    timedOut: boolean;
  } | null;
  steps: number;
  /** The approved command's run, once the engineer ran it. */
  official: { exitCode: number | null; durationMs: number | null; summary: string } | null;
  environment: string | null;
  lines: TerminalLine[];
  /** Lines the server held back from the live stream (kept in the bounded attempt log). */
  serverDroppedLines: number;
  /** Lines truncated inside single events by the server. */
  truncatedLines: number;
  telemetry: Array<{
    elapsedMs: number;
    cpuPercent: number;
    memoryBytes: number;
    memoryLimitBytes: number;
    pids: number;
    cpuLimit: number | null;
    pidLimit: number | null;
  }>;
  artifacts: Array<{ path: string; bytes: number | null; sha256: string | null }>;
  cleanup: { clean: boolean; summary: string; containerRemoved: boolean | null; verifiedAbsent: boolean | null } | null;
  cancelRequested: boolean;
  /** Execution round (1 unless the study re-planned). */
  round: number;
};

export type Category =
  "agents" | "messages" | "tools" | "evidence" | "repository" | "claims" | "plan" | "preparation" | "lab" | "review" | "stages";

export const CATEGORY_LABELS: Record<Category, string> = {
  agents: "Agent status",
  messages: "Messages",
  tools: "Tool calls",
  evidence: "Evidence",
  repository: "Repository",
  claims: "Claim",
  plan: "Plan",
  preparation: "Preparation",
  lab: "Lab",
  review: "Review",
  stages: "Stages",
};

export type StreamItem = {
  event: RunEvent;
  category: Category;
  /** The agent card this event belongs to, if any. */
  agentKey: string | null;
  /** Public text for the row, redacted and bounded. */
  text: string;
  /** A sanitized command or tool list shown under the text. */
  detail: string | null;
  /** The lab the event belongs to, for evidence links. */
  labId: string | null;
};

export type StageStep = { id: string; label: string; state: "done" | "current" | "upcoming" | "skipped" | "failed" };

export type Preparation = {
  image: string | null;
  wheels: { count: number; manifestSha256: string | null } | null;
  dataset: string | null;
  failure: string | null;
};

export type CleanupSummary = {
  verified: boolean;
  summary: string;
  labsRemoved: number;
  labsTotal: number;
  dependenciesRemoved: boolean | null;
  datasetsRemoved: boolean | null;
  workDirRemoved: boolean | null;
  leftovers: number;
  liveAgents: number;
};

export type RunView = {
  /** The stream comes from separate native agents (as opposed to an older role-per-lane recording). */
  native: boolean;
  cards: AgentCard[];
  /** Shown instead of a Debugger card while no Debugger was needed. */
  debuggerNote: string | null;
  labs: LabCard[];
  stream: StreamItem[];
  stages: StageStep[];
  currentStage: string;
  preparation: Preparation;
  provider: string | null;
  model: string | null;
  caseId: string | null;
  claim: { method: string; dataset: string; metric: string; unit: string; reportedValue: number | null; page: number | null } | null;
  paperFileName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** The run has finished (`run_finished`); nothing else will stream. */
  finished: boolean;
  /** The study's deterministic final status, from `study_result`. */
  result: { status: string; reasons: string[] } | null;
  runStatus: string | null;
  verdict: string | null;
  cleanup: CleanupSummary | null;
  cancelling: boolean;
};

export const ROLE_LABELS: Record<Role, string> = {
  system: "DéjàML",
  paper_analyst: "Paper Analyst",
  code_analyst: "Code Analyst",
  lead_researcher: "Lead Researcher",
  lab_engineer: "Lab Engineer",
  lab_reviewer: "Lab Reviewer",
  result_verifier: "Result Verifier",
  audit_agent: "Audit Agent",
  repository_analyst: "Repository Analyst",
  reproduction_planner: "Reproduction Planner",
  debugger: "Debugger",
  independent_reviewer: "Independent Reviewer",
  supervisor: "Supervisor",
};

/** Roster order: the study's dependency order, with the Supervisor first because it spans the whole study. */
const NATIVE_ROLES: readonly Role[] = [
  "supervisor",
  "paper_analyst",
  "repository_analyst",
  "reproduction_planner",
  "lab_engineer",
  "debugger",
  "independent_reviewer",
];
const LEGACY_ROLES: readonly Role[] = [
  "paper_analyst",
  "code_analyst",
  "lead_researcher",
  "lab_engineer",
  "result_verifier",
  "audit_agent",
];

const WORK_STAGES: ReadonlyArray<{ id: string; label: string; stages: readonly string[] }> = [
  { id: "ingesting", label: "Ingest", stages: ["ingesting"] },
  { id: "analyzing", label: "Analyze", stages: ["analyzing_paper", "analyzing_repository"] },
  { id: "reconciling", label: "Plan", stages: ["reconciling"] },
  { id: "policy_review", label: "Policy", stages: ["policy_review"] },
  { id: "preparing", label: "Prepare", stages: ["preparing"] },
  { id: "executing", label: "Execute", stages: ["executing"] },
  { id: "reviewing", label: "Review", stages: ["reviewing"] },
  { id: "deciding", label: "Decide", stages: ["deciding"] },
];

const STAGE_NAMES: Record<string, string> = {
  ingesting: "Ingesting the paper",
  analyzing_paper: "Analyzing the paper",
  analyzing_repository: "Analyzing the repository",
  reconciling: "Planning",
  policy_review: "Policy review",
  preparing: "Preparing the lab",
  executing: "Executing in sealed labs",
  reviewing: "Independent review",
  deciding: "Deciding the result",
};

const LAB_TYPES = new Set([
  "lab_create",
  "lab_prepare",
  "lab_output",
  "lab_telemetry",
  "attempt",
  "artifact_changed",
  "artifact_read",
  "agent_command",
  "agent_file",
  "lab_cancel",
  "lab_cleanup",
  "lab_timeout",
  "lab_strays_stopped",
  "lab_strays_unchecked",
  "lab_disk_limit",
]);

const CATEGORY_BY_TYPE: Record<string, Category> = {
  agent_started: "agents",
  agent_finished: "agents",
  agent_resumed: "agents",
  analysis_started: "agents",
  agent_message: "messages",
  agent_turn: "tools",
  agent_command: "tools",
  agent_file: "tools",
  lab_prepare: "preparation",
  repository_found: "repository",
  repository_acquired: "repository",
  repository_reacquired: "repository",
  repository_unsupported: "repository",
  repository_commit_mismatch: "repository",
  entrypoint_found: "repository",
  mapping_completed: "repository",
  reviewed_target: "claims",
  reviewed_target_refused: "claims",
  claim_mismatch: "claims",
  claim_found: "claims",
  paper_rejected: "claims",
  reproducibility_warning: "claims",
  plan_approved: "plan",
  plan_refused: "plan",
  replan: "plan",
  reconciliation_started: "plan",
  lab_image_ready: "preparation",
  dependencies_prepared: "preparation",
  dataset_acquired: "preparation",
  preparation_failed: "preparation",
  lab_create: "preparation",
  lab_ready: "preparation",
  attempt: "lab",
  official_run: "evidence",
  engineer_finished: "evidence",
  artifact_read: "evidence",
  metric_extracted: "evidence",
  lab_cancel: "lab",
  lab_cleanup: "lab",
  lab_timeout: "lab",
  lab_strays_stopped: "lab",
  lab_strays_unchecked: "lab",
  lab_disk_limit: "lab",
  comparison_started: "review",
  comparison_completed: "review",
  audit_started: "review",
  audit_completed: "review",
};

/** Event types the stream leaves to the Virtual Lab panel (live output and samples). */
const LAB_ONLY = new Set(["lab_output", "lab_telemetry", "artifact_changed"]);

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function shortAgentId(agentId: string): string {
  return agentId.startsWith("agt_") ? `agt_${agentId.slice(4, 10)}` : agentId.slice(0, 10);
}

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}

function newCard(key: string, role: Role, partial: Partial<AgentCard> = {}): AgentCard {
  return {
    key,
    agentId: null,
    role,
    label: null,
    status: "waiting",
    startedAt: null,
    endedAt: null,
    activity: "",
    waitingReason: null,
    toolCalls: 0,
    turns: 0,
    tokens: null,
    warnings: 0,
    failures: 0,
    failureReason: null,
    parentAgentId: null,
    placeholder: false,
    ...partial,
  };
}

function newLab(labId: string, timestamp: string): LabCard {
  return {
    labId,
    label: null,
    state: "creating",
    image: null,
    platform: null,
    isolation: null,
    createdAt: timestamp,
    endedAt: null,
    current: null,
    steps: 0,
    official: null,
    environment: null,
    lines: [],
    serverDroppedLines: 0,
    truncatedLines: 0,
    telemetry: [],
    artifacts: [],
    cleanup: null,
    cancelRequested: false,
    round: 1,
  };
}

/** Derives the whole dashboard from the event stream. */
export function analyzeRun(events: readonly RunEvent[]): RunView {
  const native = events.some((event) => event.type === "agent_started" || event.type === "study_team");
  const cards = new Map<string, AgentCard>();
  /** The live card for an engineer label (`engineer-1`): its agent id, or a placeholder key before it starts. */
  const byLabel = new Map<string, string>();
  const labs = new Map<string, LabCard>();
  const labLabel = new Map<string, string>();
  /** A waiting engineer card that became a running agent: events filed under the old key move with it. */
  const aliases = new Map<string, string>();
  const stream: StreamItem[] = [];
  const startedStages = new Set<string>();
  const failedStages = new Set<string>();
  let latestStage: string | null = null;
  let executingRound = 1;
  const preparation: Preparation = { image: null, wheels: null, dataset: null, failure: null };
  const view: Omit<RunView, "cards" | "debuggerNote" | "labs" | "stream" | "stages" | "currentStage" | "preparation"> = {
    native,
    provider: null,
    model: null,
    caseId: null,
    claim: null,
    paperFileName: null,
    startedAt: events[0]?.timestamp ?? null,
    endedAt: null,
    finished: false,
    result: null,
    runStatus: null,
    verdict: null,
    cleanup: null,
    cancelling: false,
  };

  const engineerCard = (label: string, timestamp: string): AgentCard => {
    const key = byLabel.get(label);
    const existing = key ? cards.get(key) : undefined;
    if (existing && !TERMINAL_AGENT_STATUSES.has(existing.status)) return existing;
    // Before its agent starts, the orchestrator sets the engineer's lab up; the card waits and says so.
    const placeholderKey = `engineer:${label}:${timestamp}`;
    const card = newCard(placeholderKey, "lab_engineer", {
      label,
      placeholder: true,
      toolCalls: 0,
      waitingReason: "The orchestrator is setting up this engineer's sealed lab",
    });
    cards.set(placeholderKey, card);
    byLabel.set(label, placeholderKey);
    return card;
  };

  const labFor = (event: RunEvent): LabCard | null => {
    const labId = str(event.publicPayload.labId);
    if (!labId) {
      // Older recordings (and the replay's cancellation tail) name no lab: attribute to the only one.
      return labs.size > 0 ? [...labs.values()].at(-1)! : null;
    }
    let lab = labs.get(labId);
    if (!lab) {
      lab = newLab(labId, event.timestamp);
      lab.round = executingRound;
      labs.set(labId, lab);
    }
    return lab;
  };

  const legacyCard = (role: Role): AgentCard => {
    const key = `role:${role}`;
    let card = cards.get(key);
    if (!card) {
      card = newCard(key, role, { toolCalls: null });
      cards.set(key, card);
    }
    return card;
  };

  for (const event of events) {
    const payload = record(event.publicPayload);
    let agentKey: string | null = null;
    let lab: LabCard | null = null;
    let detail: string | null = null;
    let text = redact(event.summary, 400);

    // ---- Agent lifecycle (native runtime events carry the agent id).
    const agentId = str(payload.agentId);
    if (native && agentId && event.type.startsWith("agent_")) {
      agentKey = agentId;
      let card = cards.get(agentId);
      if (event.type === "agent_started" || !card) {
        const role = (str(payload.role) as Role | null) ?? event.actor;
        const label = str(payload.label);
        let carried = { warnings: 0, failures: 0 };
        if (role === "lab_engineer" && label) {
          const previous = byLabel.get(label);
          const placeholder = previous ? cards.get(previous) : undefined;
          if (placeholder?.placeholder) {
            carried = { warnings: placeholder.warnings, failures: placeholder.failures };
            cards.delete(placeholder.key);
            aliases.set(placeholder.key, agentId);
          }
        }
        card =
          card ??
          newCard(agentId, role, {
            agentId,
            label,
            status: "running",
            startedAt: event.timestamp,
            activity: "Started",
            parentAgentId: str(payload.parentAgentId),
            ...carried,
          });
        cards.set(agentId, card);
        if (label) byLabel.set(label, agentId);
        if (role === "debugger" && card.parentAgentId) {
          const parent = cards.get(card.parentAgentId);
          if (parent && !TERMINAL_AGENT_STATUSES.has(parent.status)) {
            parent.status = "blocked";
            parent.waitingReason = `Waiting for ${label ?? "a Debugger"} to diagnose a failure`;
            parent.activity = "Asked a Debugger for help";
          }
        }
        if (event.type === "agent_started") {
          const provider = str(payload.provider);
          const model = str(payload.model);
          if (provider && !view.provider) view.provider = provider;
          if (model && !view.model) view.model = model;
          detail = card.parentAgentId ? `requested by ${shortAgentId(card.parentAgentId)}` : null;
        }
      }
      switch (event.type) {
        case "agent_resumed":
          card.status = card.role === "independent_reviewer" ? "reviewing" : "running";
          card.activity = "Resumed from its saved conversation";
          break;
        case "agent_turn": {
          const tools = strings(payload.tools);
          const tokens = record(payload.tokens);
          card.turns = num(payload.iteration) ?? card.turns + 1;
          card.toolCalls = (card.toolCalls ?? 0) + tools.length;
          card.tokens = {
            input: (card.tokens?.input ?? 0) + (num(tokens.input) ?? 0),
            output: (card.tokens?.output ?? 0) + (num(tokens.output) ?? 0),
          };
          card.waitingReason = null;
          if (tools.length === 0) {
            card.status = "running";
            card.activity = `Turn ${card.turns}: no tool call`;
          } else if (tools.includes("finish")) {
            card.status = "running";
            card.activity = "Submitting its result";
          } else if (tools.includes("give_up")) {
            card.status = "running";
            card.activity = "Stopping: the task cannot be done with the evidence available";
          } else if (tools.includes("request_debugging")) {
            card.status = "blocked";
            card.activity = "Asked a Debugger for help";
            card.waitingReason = "Waiting for a Debugger's diagnosis";
          } else {
            card.status = "using_tool";
            card.activity = `Using ${tools.join(", ")}`;
          }
          if (card.role === "independent_reviewer" && (card.status === "running" || card.status === "using_tool"))
            card.status = "reviewing";
          detail = tools.length ? `tools: ${tools.join(", ")}` : null;
          // The turn's model text is not shown: only tool names and the public summary.
          text = redact(`${roleLabel(card.role)} turn ${card.turns}: ${tools.length ? tools.join(", ") : "no tool call"}`, 400);
          break;
        }
        case "agent_finished": {
          const status = str(payload.status);
          const usage = record(payload.usage);
          card.status = status === "completed" ? "done" : status === "cancelled" ? "cancelled" : "failed";
          card.endedAt = event.timestamp;
          card.waitingReason = null;
          card.toolCalls = num(usage.toolCalls) ?? card.toolCalls;
          if (num(usage.inputTokens) !== null || num(usage.outputTokens) !== null) {
            card.tokens = { input: num(usage.inputTokens) ?? 0, output: num(usage.outputTokens) ?? 0 };
          }
          const reason = str(payload.reason);
          card.failureReason = card.status === "done" ? null : reason ? redact(reason, 300) : null;
          card.activity =
            card.status === "done" ? "Finished and handed back its result" : card.status === "cancelled" ? "Cancelled" : "Stopped";
          if (card.status === "failed") card.failures += 1;
          if (card.role === "debugger" && card.parentAgentId) {
            const parent = cards.get(card.parentAgentId);
            if (parent?.status === "blocked") {
              parent.status = "using_tool";
              parent.waitingReason = null;
              parent.activity = card.status === "done" ? "Reading the Debugger's diagnosis" : "The Debugger did not finish";
            }
          }
          break;
        }
        default:
          break;
      }
      if (event.status === "warning" && event.type !== "agent_finished") card.warnings += 1;
    }

    // ---- Lab events (the Lab Manager reports them as lab_engineer, keyed by lab id).
    if (LAB_TYPES.has(event.type)) {
      lab = labFor(event);
      const commandAgent = str(payload.agent);
      if (lab && commandAgent && !lab.label) {
        lab.label = commandAgent;
        labLabel.set(lab.labId, commandAgent);
      }
      if (lab) {
        switch (event.type) {
          case "lab_create": {
            if (event.status === "failed") lab.state = "failed";
            if (event.status === "completed") {
              const resources = record(payload.resources);
              lab.state = "ready";
              lab.image = str(payload.image);
              lab.platform = str(payload.platform);
              lab.isolation = {
                network: str(payload.network) ?? "none",
                readOnlyRoot: payload.readOnlyRoot === true,
                sealed: payload.sealed === undefined ? null : Boolean(payload.sealed),
                cpus: num(resources.cpus),
                memoryMb: num(resources.memoryMb),
                pids: num(resources.pids),
                timeoutSeconds: num(resources.timeoutSeconds),
                lifetimeSeconds: num(payload.labTimeoutSeconds),
              };
            }
            break;
          }
          case "agent_command":
          case "attempt": {
            if (event.status === "started") {
              const executable = str(payload.executable) ?? "";
              const command = describeArgv(executable, strings(payload.args));
              lab.state = "running";
              lab.steps += 1;
              lab.current = {
                step: num(payload.step),
                text: command,
                startedAt: event.timestamp,
                running: true,
                exitCode: null,
                durationMs: null,
                timedOut: false,
              };
              detail = command;
            } else {
              const timedOut = payload.timedOut === true;
              const cancelled = payload.cancelled === true;
              if (lab.current) {
                lab.current = {
                  ...lab.current,
                  running: false,
                  exitCode: num(payload.exitCode),
                  durationMs: num(payload.durationMs),
                  timedOut,
                };
              }
              lab.state = timedOut
                ? "timed_out"
                : cancelled
                  ? "cancelled"
                  : event.type === "attempt" && event.status === "failed"
                    ? "failed"
                    : "idle";
              for (const artifact of Array.isArray(payload.artifacts) ? payload.artifacts.map(record) : []) {
                const path = str(artifact.path);
                if (path) upsertArtifact(lab, path, num(artifact.bytes), str(artifact.sha256));
              }
              if (event.type === "attempt" && event.status === "completed") {
                lab.official = { exitCode: num(payload.exitCode), durationMs: num(payload.durationMs), summary: event.summary };
              }
            }
            break;
          }
          case "lab_output": {
            if (event.status === "warning") {
              lab.serverDroppedLines += num(payload.droppedLines) ?? 0;
              break;
            }
            const stream = payload.stream === "stderr" ? "stderr" : "stdout";
            strings(payload.lines).forEach((line, index) =>
              lab!.lines.push({ stream, text: redact(line, 2_100), key: `${event.sequence}:${index}` }),
            );
            lab.truncatedLines += num(payload.truncatedLines) ?? 0;
            break;
          }
          case "lab_telemetry": {
            const limits = record(payload.limits);
            lab.telemetry.push({
              elapsedMs: num(payload.elapsedMs) ?? 0,
              cpuPercent: num(payload.cpuPercent) ?? 0,
              memoryBytes: num(payload.memoryBytes) ?? 0,
              memoryLimitBytes: num(payload.memoryLimitBytes) ?? (num(limits.memoryMb) ?? 0) * 1024 * 1024,
              pids: num(payload.pids) ?? 0,
              cpuLimit: num(limits.cpus),
              pidLimit: num(limits.pids),
            });
            break;
          }
          case "artifact_changed":
          case "artifact_read":
          case "agent_file": {
            const path = str(payload.path);
            if (path) upsertArtifact(lab, path, num(payload.bytes), str(payload.sha256));
            break;
          }
          case "lab_cancel":
            lab.cancelRequested = true;
            view.cancelling = true;
            break;
          case "lab_timeout":
            lab.state = "timed_out";
            break;
          case "lab_cleanup": {
            const clean = event.status === "completed";
            lab.state = clean ? "removed" : "cleanup_failed";
            lab.endedAt = event.timestamp;
            lab.cleanup = {
              clean,
              summary: event.summary,
              containerRemoved: typeof payload.containerRemoved === "boolean" ? payload.containerRemoved : null,
              verifiedAbsent: typeof payload.verifiedAbsent === "boolean" ? payload.verifiedAbsent : null,
            };
            break;
          }
          default:
            break;
        }
      }
      // Lab steps belong to the engineer card named by the lab's label.
      const label = commandAgent ?? (lab ? labLabel.get(lab.labId) : undefined) ?? null;
      if (native && label && (event.type === "agent_command" || event.type === "agent_file")) {
        const card = engineerCard(label, event.timestamp);
        agentKey = card.key;
        const step = num(payload.step);
        if (card.placeholder) {
          if (event.status === "started")
            card.waitingReason = `The orchestrator is setting up this engineer's sealed lab (step ${step ?? "?"})`;
        } else if (event.type === "agent_command" && event.status === "started") {
          card.status = "using_tool";
          card.activity = `Running lab step ${step ?? "?"}: ${describeArgv(str(payload.executable) ?? "", strings(payload.args), 120)}`;
        } else if (event.type === "agent_command") {
          card.activity = `Lab step ${step ?? "?"} exited with code ${String(num(payload.exitCode))}`;
        }
        if (event.status === "failed") card.warnings += 1;
      } else if (native && label && agentKey === null) {
        const key = byLabel.get(label);
        if (key) agentKey = key;
      }
    }

    // ---- System facts.
    switch (event.type) {
      case "run_created": {
        const reference = event.evidence.find((item) => item.kind === "artifact")?.reference ?? null;
        if (reference) view.paperFileName = reference.split("#")[0] ?? null;
        break;
      }
      case "reviewed_target": {
        view.caseId = str(payload.caseId);
        const claim = record(payload.claim);
        const metric = record(claim.metric);
        view.claim = {
          method: str(claim.method) ?? "",
          dataset: str(claim.dataset) ?? "",
          metric: str(metric.name) ?? "",
          unit: str(metric.unit) ?? "",
          reportedValue: num(claim.reportedValue),
          page: num(claim.page),
        };
        break;
      }
      case "repository_found":
        view.caseId = view.caseId ?? str(payload.reviewedTarget);
        break;
      case "model_connection":
      case "study_team":
        view.provider = str(payload.provider) ?? view.provider;
        view.model = str(payload.model) ?? view.model;
        break;
      case "stage_started": {
        const stage = str(payload.stage);
        if (stage) {
          startedStages.add(stage);
          latestStage = stage;
          if (stage === "executing") executingRound = num(payload.attempt) ?? executingRound;
        }
        break;
      }
      case "replan":
        failedStages.delete("reconciling");
        break;
      case "lab_image_ready":
        preparation.image = str(payload.image);
        break;
      case "dependencies_prepared":
        preparation.wheels = { count: num(payload.packages) ?? 0, manifestSha256: str(payload.manifestSha256) };
        break;
      case "dataset_acquired":
        preparation.dataset = event.summary;
        break;
      case "preparation_failed":
        preparation.failure = event.summary;
        break;
      case "lab_ready": {
        const label = str(payload.engineer);
        if (label) {
          for (const item of labs.values()) if (item.label === label && item.state !== "removed") item.environment = event.summary;
          if (native) {
            const card = engineerCard(label, event.timestamp);
            agentKey = card.key;
            if (card.placeholder) card.waitingReason = "Lab ready; the engineer starts next";
          }
        }
        break;
      }
      case "official_run":
      case "engineer_finished": {
        const label = str(payload.engineer);
        const key = str(payload.agentId) ?? (label ? (byLabel.get(label) ?? null) : null);
        agentKey = key;
        const card = key ? cards.get(key) : undefined;
        if (card && event.status !== "completed") card.warnings += 1;
        if (card && event.type === "official_run") card.activity = redact(event.summary, 200);
        if (event.type === "official_run" && label) {
          for (const item of labs.values()) {
            if (item.label === label && item.state !== "removed") {
              item.official = { exitCode: num(payload.exitCode), durationMs: num(payload.durationMs), summary: event.summary };
            }
          }
        }
        break;
      }
      case "plan_refused":
      case "claim_mismatch":
        failedStages.add(event.type === "plan_refused" ? "policy_review" : "reconciling");
        break;
      case "study_result":
        view.result = { status: str(payload.status) ?? "unknown", reasons: strings(payload.reasons).map((reason) => redact(reason, 600)) };
        break;
      case "study_cleanup": {
        const labReceipts = Array.isArray(payload.labs) ? payload.labs.map(record) : [];
        view.cleanup = {
          verified: payload.verified === true,
          summary: event.summary,
          labsRemoved: labReceipts.filter((receipt) => receipt.verifiedAbsent === true).length,
          labsTotal: labReceipts.length,
          dependenciesRemoved: typeof payload.dependenciesRemoved === "boolean" ? payload.dependenciesRemoved : null,
          datasetsRemoved: typeof payload.datasetsRemoved === "boolean" ? payload.datasetsRemoved : null,
          workDirRemoved: typeof payload.workDirRemoved === "boolean" ? payload.workDirRemoved : null,
          leftovers: strings(payload.leftoverContainers).length + strings(payload.leftoverNetworks).length,
          liveAgents: strings(payload.liveAgents).length,
        };
        break;
      }
      case "run_cancelled":
        view.cancelling = true;
        break;
      case "run_finished":
        view.finished = true;
        view.endedAt = event.timestamp;
        view.runStatus = str(payload.runStatus);
        view.verdict = str(payload.verdict);
        break;
      default:
        break;
    }

    // ---- Older recordings: one card per role, following its own events.
    if (!native && LEGACY_ROLES.includes(event.actor)) {
      const card = legacyCard(event.actor);
      agentKey = card.key;
      card.startedAt = card.startedAt ?? event.timestamp;
      card.activity = text;
      if (event.status === "failed") {
        card.status = "failed";
        card.failures += 1;
        card.endedAt = event.timestamp;
      } else if (event.status === "warning") {
        card.warnings += 1;
        if (card.status === "waiting") card.status = "running";
      } else if (event.status === "completed" && card.status !== "failed" && event.actor !== "lab_engineer") {
        card.status = "done";
        card.endedAt = event.timestamp;
      } else if (card.status !== "failed") {
        card.status = event.actor === "lab_engineer" && event.type === "attempt" ? "using_tool" : "running";
      }
      if (event.actor === "lab_engineer" && event.type === "lab_cleanup") {
        card.status = event.status === "completed" ? "done" : "failed";
        card.endedAt = event.timestamp;
      }
      if (event.actor === "lab_engineer" && event.type === "attempt")
        card.toolCalls = (card.toolCalls ?? 0) + (event.status === "started" ? 1 : 0);
    }

    if (!LAB_ONLY.has(event.type)) {
      const category: Category =
        event.type === "agent_turn" && strings(payload.tools).includes("request_debugging")
          ? "messages"
          : event.actor === "independent_reviewer" && event.type !== "agent_turn" && event.type.startsWith("agent_")
            ? "review"
            : (CATEGORY_BY_TYPE[event.type] ?? (event.evidence.length > 0 ? "evidence" : "stages"));
      if (event.type === "agent_turn" && category === "messages") {
        text = `${text} — asked a Debugger for a diagnosis`;
      }
      stream.push({ event, category, agentKey, text, detail, labId: lab?.labId ?? null });
    }
  }

  for (const item of stream) if (item.agentKey && aliases.has(item.agentKey)) item.agentKey = aliases.get(item.agentKey)!;

  // ---- Waiting roles: every role stays visible, and says why it waits.
  const all = [...cards.values()];
  const roles = native ? NATIVE_ROLES : LEGACY_ROLES.filter((role) => role !== "audit_agent" || all.some((card) => card.role === role));
  const ended = view.finished || view.result !== null;
  const of = (role: Role) => all.filter((card) => card.role === role);
  const done = (role: Role) => of(role).length > 0 && of(role).every((card) => TERMINAL_AGENT_STATUSES.has(card.status));
  const planApproved = events.some((event) => event.type === "plan_approved");
  const ordered: AgentCard[] = [];
  let debuggerNote: string | null = null;
  for (const role of roles) {
    const instances = of(role).sort(
      (a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || (a.label ?? "").localeCompare(b.label ?? ""),
    );
    if (instances.length > 0) {
      ordered.push(...instances);
      continue;
    }
    if (role === "debugger") {
      debuggerNote = ended
        ? "No Debugger was needed in this study."
        : "No Debugger yet. One appears only if a Lab Engineer asks for help with a failure.";
      continue;
    }
    ordered.push(
      newCard(`role:${role}`, role, {
        placeholder: true,
        toolCalls: native ? 0 : null,
        waitingReason: native
          ? nativeWaitingReason(role, { ended, done, of, planApproved, startedStages })
          : legacyWaitingReason(role, { ended, done }),
      }),
    );
  }

  const stages = native ? stageSteps(startedStages, failedStages, latestStage, view) : legacyStageSteps(events, view);
  const currentStage = ended
    ? view.result
      ? `Finished: ${view.result.status.replaceAll("_", " ")}`
      : `Finished${view.runStatus ? `: ${view.runStatus.replaceAll("_", " ")}` : ""}`
    : native
      ? startedStages.has("analyzing_paper") && latestStage === "analyzing_repository" && !done("paper_analyst")
        ? "Analyzing the paper and the repository"
        : latestStage
          ? (STAGE_NAMES[latestStage] ?? latestStage.replaceAll("_", " "))
          : "Starting the study"
      : (stages.find((step) => step.state === "current")?.label ?? "Starting the study");

  return {
    ...view,
    cards: ordered,
    debuggerNote,
    labs: [...labs.values()],
    stream,
    stages,
    currentStage,
    preparation,
  };
}

function upsertArtifact(lab: LabCard, path: string, bytes: number | null, sha256: string | null): void {
  const existing = lab.artifacts.find((item) => item.path === path);
  if (existing) {
    existing.bytes = bytes ?? existing.bytes;
    existing.sha256 = sha256 ?? existing.sha256;
  } else {
    lab.artifacts.push({ path, bytes, sha256 });
  }
}

type ReasonContext = {
  ended: boolean;
  done: (role: Role) => boolean;
  of: (role: Role) => AgentCard[];
  planApproved: boolean;
  startedStages: ReadonlySet<string>;
};

function nativeWaitingReason(role: Role, context: ReasonContext): string {
  const { ended, done, of } = context;
  const notDone = (roles: Role[]) => roles.filter((item) => !done(item)).map(roleLabel);
  switch (role) {
    case "supervisor":
      return ended
        ? "Was not called: no checkpoint or final decision needed it."
        : "Waits for checkpoints: it is called if execution or review needs a decision, and to propose the final status. It can only make the result more cautious.";
    case "paper_analyst":
    case "repository_analyst":
      return ended
        ? "Did not start: the study ended before analysis."
        : `Starts once the paper is ingested, at the same time as the ${role === "paper_analyst" ? "Repository Analyst" : "Paper Analyst"}.`;
    case "reproduction_planner": {
      if (ended) return "Did not start: the study stopped before planning.";
      const missing = notDone(["paper_analyst", "repository_analyst"]);
      return missing.length ? `Waiting for the ${missing.join(" and the ")} to finish.` : "Both analyses are in; planning starts next.";
    }
    case "lab_engineer":
      if (ended) return "Did not start: no plan was approved for execution.";
      if (context.planApproved) return "The plan is approved; waiting for the lab image and dependency preparation.";
      return of("reproduction_planner").length
        ? "Waiting for an approved plan: the Planner's plan must pass policy review first."
        : "Waiting for an approved plan.";
    case "independent_reviewer": {
      if (ended) return "Did not start: no engineer submitted a measurement to review.";
      const engineers = of("lab_engineer").filter((card) => !card.placeholder);
      const working = engineers.filter((card) => !TERMINAL_AGENT_STATUSES.has(card.status)).length;
      return working > 0
        ? `Waiting for execution evidence: ${working} Lab Engineer${working === 1 ? " is" : "s are"} still working.`
        : "Waiting for execution evidence from the Lab Engineers.";
    }
    default:
      return ended ? "Did not start." : "Waiting.";
  }
}

function legacyWaitingReason(role: Role, context: { ended: boolean; done: (role: Role) => boolean }): string {
  if (context.ended) return "Did not start.";
  switch (role) {
    case "paper_analyst":
      return "Starts soon.";
    case "code_analyst":
      return "Starts once the repository is acquired.";
    case "lead_researcher":
      return "Waiting for the Paper Analyst and the Code Analyst to finish.";
    case "lab_engineer":
      return "Waiting for an approved plan.";
    case "result_verifier":
      return "Waiting for the lab's attempt to finish.";
    default:
      return "Waiting.";
  }
}

function stageSteps(
  started: ReadonlySet<string>,
  failed: ReadonlySet<string>,
  latest: string | null,
  view: Pick<RunView, "finished" | "result">,
): StageStep[] {
  const ended = view.finished || view.result !== null;
  const latestIndex = WORK_STAGES.findIndex((step) => step.stages.includes(latest ?? ""));
  return WORK_STAGES.map((step, index) => {
    const reached = step.stages.some((stage) => started.has(stage));
    const state: StageStep["state"] = step.stages.some((stage) => failed.has(stage))
      ? "failed"
      : reached && (index < latestIndex || ended)
        ? "done"
        : reached
          ? "current"
          : ended || index < latestIndex
            ? "skipped"
            : "upcoming";
    return { id: step.id, label: step.label, state };
  });
}

/** Older recordings have no stage events; their roles stand in for the stages. */
function legacyStageSteps(events: readonly RunEvent[], view: Pick<RunView, "finished">): StageStep[] {
  const steps: Array<{ id: string; label: string; actors: Role[] }> = [
    { id: "analyzing", label: "Analyze", actors: ["paper_analyst", "code_analyst"] },
    { id: "planning", label: "Plan", actors: ["lead_researcher"] },
    { id: "executing", label: "Execute", actors: ["lab_engineer"] },
    { id: "comparing", label: "Compare", actors: ["result_verifier", "audit_agent"] },
  ];
  const reached = steps.map((step) => events.some((event) => step.actors.includes(event.actor)));
  const last = reached.lastIndexOf(true);
  const complete = view.finished || events.some((event) => event.type === "comparison_completed");
  return steps.map((step, index) => ({
    id: step.id,
    label: step.label,
    state: reached[index] && (index < last || complete) ? "done" : reached[index] ? "current" : "upcoming",
  }));
}

/** Formats elapsed milliseconds as 0:42, 3:05, or 1:02:03. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function elapsedBetween(start: string | null, end: string | null, now: number): number | null {
  if (!start) return null;
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : now;
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : null;
}
