import type { RunEvent } from "@dejaml/contracts";

import type { Tone } from "../components/Badge";

export const ROLE_LABELS: Record<RunEvent["actor"], string> = {
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

export const STATUS_TONES: Record<RunEvent["status"], Tone> = {
  started: "accent",
  progress: "neutral",
  completed: "positive",
  warning: "warning",
  failed: "negative",
};
