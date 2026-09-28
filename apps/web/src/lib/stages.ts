import type { RunEvent, RunStatus } from "@dejaml/contracts";

export const STAGES = [
  { id: "new_study", label: "New Study" },
  { id: "research_team", label: "Research Team" },
  { id: "virtual_lab", label: "Virtual Lab" },
  { id: "findings", label: "Findings" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

const STATUS_STAGE: Record<RunStatus, StageId> = {
  queued: "research_team",
  ingesting: "research_team",
  discovering_repository: "research_team",
  analyzing: "research_team",
  planning: "research_team",
  validating_plan: "research_team",
  preparing_lab: "virtual_lab",
  running: "virtual_lab",
  comparing: "findings",
  auditing: "findings",
  completed: "findings",
  inconclusive: "findings",
  failed: "findings",
  cancelled: "findings",
  timed_out: "findings",
};

export function stageForStatus(status: RunStatus): StageId {
  return STATUS_STAGE[status];
}

/** The furthest product stage the event stream has reached. */
export function stageForEvents(events: readonly RunEvent[]): StageId {
  let stage: StageId = "research_team";
  for (const event of events) {
    if (event.actor === "lab_engineer" && stage === "research_team") stage = "virtual_lab";
    if (event.actor === "result_verifier") stage = "findings";
  }
  return stage;
}
