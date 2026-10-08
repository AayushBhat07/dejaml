import type { AgentCard, AgentStatus, LabCard, Role, RunView, StageStep, StreamItem } from "./live-run";
import { roleLabel } from "./live-run";
import type { ReportSummary } from "./run-client";

/**
 * The Research Campus is a picture of the same run the dashboard shows: every
 * room, agent, walk, KPI and feed row here is derived from the run's public
 * event stream (through `analyzeRun`) and, at the end, the server's report.
 * Nothing is scripted. An agent walks only because an event said it handed
 * work on, and the paper's number appears only after the target is revealed.
 */

export type Zone = "read" | "repo" | "plan" | "lab" | "ver" | "store";
export type Tone = "paper" | "code" | "lead" | "lab" | "ver" | "system";
export type Carry = "claim" | "code" | "plan" | "metric" | "report";

export type CampusAgentState = "working" | "idle" | "blocked" | "done" | "stopped";

export type CampusAgent = {
  key: string;
  role: Role;
  name: string;
  /** The instance label, such as `engineer-2`, when the stream names one. */
  label: string | null;
  initial: string;
  tone: Tone;
  zone: Zone;
  /** Position among the agents that share the room, so several engineers stand apart. */
  slot: number;
  status: AgentStatus;
  state: CampusAgentState;
  /** Public activity or waiting reason, never model text. */
  activity: string;
};

/** One agent carrying work from one room to the next, because a real event said so. */
export type Handoff = {
  /** The event id, so a walk is animated once however often the view is rebuilt. */
  id: string;
  agentKey: string;
  from: Zone;
  to: Zone;
  carry: Carry;
  at: string;
};

export type CampusLab = {
  labId: string;
  label: string | null;
  state: LabCard["state"];
  image: string | null;
  platform: string | null;
  cpus: number | null;
  memoryMb: number | null;
  network: string | null;
  timeoutSeconds: number | null;
  running: boolean;
  /** When the running command started, for an elapsed clock (never a guessed percentage). */
  runningSince: string | null;
  exitCode: number | null;
  durationMs: number | null;
};

export type LabPresence = "absent" | "active" | "removed";

export type Kpi = { value: string | null; foot: string };

export type CampusModel = {
  agents: CampusAgent[];
  handoffs: Handoff[];
  labPresence: LabPresence;
  lab: CampusLab | null;
  labCount: number;
  labsActive: number;
  paper: Kpi & { sealed: boolean };
  observed: Kpi & { locked: boolean };
  delta: Kpi;
  /** The study's own status word (`reproduced`, `different_result`, ...), from the server. */
  status: string | null;
  steps: StageStep[];
  currentStage: string;
  stepsDone: number;
  feed: Array<{ id: string; tone: Tone; text: string; at: string; offsetMs: number | null }>;
  /** The run will not change any more: the scene stops ticking clocks. */
  ended: boolean;
};

const ZONE: Record<Role, Zone | null> = {
  system: null,
  paper_analyst: "read",
  code_analyst: "repo",
  repository_analyst: "repo",
  lead_researcher: "plan",
  reproduction_planner: "plan",
  supervisor: "plan",
  lab_engineer: "lab",
  lab_reviewer: "lab",
  debugger: "lab",
  result_verifier: "ver",
  independent_reviewer: "ver",
  audit_agent: "ver",
};

const ZONE_TONE: Record<Zone, Tone> = { read: "paper", repo: "code", plan: "lead", lab: "lab", ver: "ver", store: "paper" };

const INITIALS: Record<Role, string> = {
  system: "D",
  paper_analyst: "P",
  code_analyst: "C",
  repository_analyst: "C",
  lead_researcher: "R",
  reproduction_planner: "R",
  supervisor: "S",
  lab_engineer: "L",
  lab_reviewer: "L",
  debugger: "D",
  result_verifier: "V",
  independent_reviewer: "V",
  audit_agent: "A",
};

export function roleTone(role: Role): Tone {
  const zone = ZONE[role];
  return zone ? ZONE_TONE[zone] : "system";
}

function agentState(status: AgentStatus): CampusAgentState {
  switch (status) {
    case "running":
    case "using_tool":
    case "reviewing":
      return "working";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "failed":
    case "cancelled":
      return "stopped";
    default:
      return "idle";
  }
}

function campusAgents(cards: readonly AgentCard[]): CampusAgent[] {
  const perZone = new Map<Zone, number>();
  const agents: CampusAgent[] = [];
  for (const card of cards) {
    const zone = ZONE[card.role];
    if (!zone) continue;
    const slot = perZone.get(zone) ?? 0;
    perZone.set(zone, slot + 1);
    const waiting = card.status === "waiting" || card.status === "blocked";
    agents.push({
      key: card.key,
      role: card.role,
      name: roleLabel(card.role),
      label: card.label,
      initial: INITIALS[card.role],
      tone: ZONE_TONE[zone],
      zone,
      slot,
      status: card.status,
      state: agentState(card.status),
      activity: (waiting ? card.waitingReason : card.activity) || card.waitingReason || "",
    });
  }
  return agents;
}

/** Which events mean work moved between rooms, and who carried it. */
function campusHandoffs(view: RunView, agents: readonly CampusAgent[]): Handoff[] {
  const first = (...roles: Role[]) => {
    for (const role of roles) {
      const agent = agents.find((candidate) => candidate.role === role);
      if (agent) return agent.key;
    }
    return null;
  };
  const known = new Set(agents.map((agent) => agent.key));
  const handoffs: Handoff[] = [];
  const add = (item: StreamItem, agentKey: string | null, from: Zone, to: Zone, carry: Carry) => {
    if (!agentKey || !known.has(agentKey)) return;
    handoffs.push({ id: item.event.id, agentKey, from, to, carry, at: item.event.timestamp });
  };
  for (const item of view.stream) {
    const { event } = item;
    const completed = event.type === "agent_finished" && event.publicPayload.status === "completed";
    if (event.type === "claim_found" || (completed && event.actor === "paper_analyst")) {
      add(item, item.agentKey ?? first("paper_analyst"), "read", "plan", "claim");
    } else if (event.type === "mapping_completed" || (completed && event.actor === "repository_analyst")) {
      add(item, item.agentKey ?? first("repository_analyst", "code_analyst"), "repo", "plan", "code");
    } else if (event.type === "plan_approved") {
      add(item, first("reproduction_planner", "lead_researcher"), "plan", "lab", "plan");
    } else if ((view.native && event.type === "engineer_finished") || (!view.native && event.type === "artifact_read")) {
      add(item, item.agentKey ?? first("lab_engineer"), "lab", "ver", "metric");
    } else if ((view.native && event.type === "final_status") || (!view.native && event.type === "comparison_completed")) {
      add(item, first("result_verifier", "independent_reviewer", "audit_agent"), "ver", "store", "report");
    }
  }
  return handoffs;
}

const LIVE_LAB = new Set<LabCard["state"]>(["creating", "ready", "running", "idle"]);

function campusLab(labs: readonly LabCard[]): { presence: LabPresence; lab: CampusLab | null; active: number } {
  if (labs.length === 0) return { presence: "absent", lab: null, active: 0 };
  const active = labs.filter((lab) => LIVE_LAB.has(lab.state));
  const chosen = active.find((lab) => lab.state === "running") ?? active.at(-1) ?? labs.at(-1)!;
  const running = chosen.state === "running" || chosen.current?.running === true;
  return {
    presence: active.length > 0 ? "active" : "removed",
    active: active.length,
    lab: {
      labId: chosen.labId,
      label: chosen.label,
      state: chosen.state,
      image: chosen.image,
      platform: chosen.platform,
      cpus: chosen.isolation?.cpus ?? null,
      memoryMb: chosen.isolation?.memoryMb ?? null,
      network: chosen.isolation?.network ?? null,
      timeoutSeconds: chosen.isolation?.timeoutSeconds ?? null,
      running,
      runningSince: running ? (chosen.current?.startedAt ?? null) : null,
      exitCode: chosen.official?.exitCode ?? chosen.current?.exitCode ?? null,
      durationMs: chosen.official?.durationMs ?? chosen.current?.durationMs ?? null,
    },
  };
}

/** A metric value for a KPI tile: four decimals at most, % for percent. */
export function metricText(value: number | null, unit: string | null): string | null {
  if (value === null) return null;
  const rounded = Math.round(value * 10_000) / 10_000;
  return unit === "percent" ? `${rounded}%` : String(rounded);
}

const shortHash = (value: string) => (value.length > 14 ? `${value.slice(0, 8)}…` : value);

/**
 * The three KPI tiles. The paper's value comes only from `target_revealed` (or
 * a report that says it was revealed); before that the tile says sealed.
 */
function kpis(view: RunView, report: ReportSummary | null, labRunning: boolean) {
  const { blinding } = view;
  const revealedReport = report?.revealed ? report : null;
  const reveal = blinding.reveal;
  const unit = reveal?.metric?.unit ?? blinding.observation?.metric?.unit ?? revealedReport?.unit ?? view.claim?.unit ?? null;

  const reportedValue = reveal ? reveal.reportedValue : (revealedReport?.paperValue ?? null);
  const page = reveal?.claimLocator?.page ?? null;
  const metricName = reveal?.metric?.name ?? blinding.observation?.metric?.name ?? blinding.sealed?.metric ?? view.claim?.metric ?? null;
  // Hidden until revealed; "sealed" only where the run follows the blinding protocol (older recordings did not).
  const hidden = !reveal && !revealedReport;
  // An older recording shows agent work without any blinding event; a new study seals its target before any agent starts.
  const blinded = view.native || blinding.present || !view.stream.some((item) => item.event.actor !== "system");
  const paper = {
    sealed: hidden && blinded,
    value: hidden ? null : metricText(reportedValue, unit),
    foot: hidden
      ? !blinded
        ? "shown after the comparison"
        : blinding.sealed
          ? `sealed · ${shortHash(blinding.sealed.commitment)}`
          : "hidden until review locks"
      : [metricName, page !== null ? `p.${page}` : null].filter(Boolean).join(" · ") ||
        (blinded ? "revealed" : "from the recorded comparison"),
  };

  const lockedValues = blinding.observation?.observed.map((item) => item.value).filter((value): value is number => value !== null) ?? [];
  const observedValue = blinding.comparison?.observed ?? lockedValues[0] ?? revealedReport?.observedValue ?? null;
  const locked = observedValue !== null;
  const observedFoot = blinding.observation
    ? `locked${blinding.observation.round !== null ? ` · round ${blinding.observation.round}` : ""}${
        lockedValues.length > 1 ? ` · ${lockedValues.length} engineers` : ""
      }`
    : locked
      ? "measured"
      : labRunning
        ? "measuring in the lab"
        : "awaiting the run";
  const observed = { locked, value: metricText(observedValue, unit), foot: observedFoot };

  const tolerance = reveal?.tolerance ?? revealedReport?.tolerance ?? null;
  let deltaValue: string | null = null;
  const points = unit === "percent" ? " pp" : "";
  if (!hidden) {
    const signed = revealedReport?.signedDifference ?? null;
    const absolute = blinding.comparison?.absoluteDelta ?? null;
    if (signed !== null)
      deltaValue = `${signed > 0 ? "+" : signed < 0 ? "−" : "±"}${Math.round(Math.abs(signed) * 10_000) / 10_000}${points}`;
    else if (absolute !== null) deltaValue = `|${Math.round(absolute * 10_000) / 10_000}|${points}`;
    else if (reportedValue !== null && observedValue !== null)
      deltaValue = `|${Math.round(Math.abs(observedValue - reportedValue) * 10_000) / 10_000}|${points}`;
  }
  const delta = {
    value: deltaValue,
    foot:
      tolerance !== null
        ? `tolerance ±${tolerance}`
        : hidden
          ? blinded
            ? "after the reveal"
            : "after the comparison"
          : "tolerance not stated",
  };
  return { paper, observed, delta };
}

function offsetFrom(start: string | null, at: string): number | null {
  if (!start) return null;
  const value = Date.parse(at) - Date.parse(start);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

export function campusModel(view: RunView, report: ReportSummary | null): CampusModel {
  const agents = campusAgents(view.cards);
  const { presence, lab, active } = campusLab(view.labs);
  const ended = view.finished || view.result !== null;
  const status = view.blinding.final?.status ?? view.result?.status ?? (report?.revealed ? report.verdict : null) ?? null;
  return {
    agents,
    handoffs: campusHandoffs(view, agents),
    labPresence: presence,
    lab,
    labCount: view.labs.length,
    labsActive: active,
    ...kpis(view, report, lab?.running ?? false),
    status,
    steps: view.stages,
    // Older recordings have no closing stage event: once every step is done, say so rather than "Starting".
    currentStage:
      view.stages.length > 0 && view.stages.every((step) => step.state === "done") && !ended ? "All stages complete" : view.currentStage,
    stepsDone: view.stages.filter((step) => step.state === "done" || step.state === "skipped").length,
    feed: view.stream
      .slice(-6)
      .reverse()
      .map((item) => ({
        id: item.event.id,
        tone: roleTone(item.event.actor),
        text: item.text,
        at: item.event.timestamp,
        offsetMs: offsetFrom(view.startedAt, item.event.timestamp),
      })),
    ended,
  };
}
