import { z } from "zod";

import type { EvidenceBoard } from "./board.js";
import type { ToolSpec } from "./providers/types.js";

/** The seven roles of a reproduction study. Each runs as its own agent instance. */
export const AgentRoleSchema = z.enum([
  "paper_analyst",
  "repository_analyst",
  "reproduction_planner",
  "lab_engineer",
  "debugger",
  "independent_reviewer",
  "supervisor",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const ROLE_LABELS: Record<AgentRole, string> = {
  paper_analyst: "Paper Analyst",
  repository_analyst: "Repository Analyst",
  reproduction_planner: "Reproduction Planner",
  lab_engineer: "Lab Engineer",
  debugger: "Debugger",
  independent_reviewer: "Independent Reviewer",
  supervisor: "Supervisor",
};

/**
 * The most a role may ever be granted. A task can request fewer tools, never
 * more; the runtime rejects a grant outside this set before the agent starts.
 * Wire names use underscores (providers reject dots); `dependency_discover`
 * is the `dependency.discover` tool of the design.
 */
export const ROLE_CAPABILITIES: Record<AgentRole, readonly string[]> = {
  paper_analyst: ["paper_list_pages", "paper_read_page", "paper_search", "board_read"],
  repository_analyst: ["repo_acquire", "repo_list", "repo_read", "repo_search", "dependency_discover", "board_read"],
  reproduction_planner: [
    "board_read",
    "repo_list",
    "repo_read",
    "repo_search",
    "dependency_discover",
    "dependency_resolvePython",
    "dependency_downloadWheels",
    "dataset_fetch",
  ],
  lab_engineer: [
    "board_read",
    "lab_list",
    "lab_read",
    "lab_search",
    "lab_run",
    "lab_write_file",
    "dependency_installOffline",
    "dependency_inspectEnvironment",
    "request_debugging",
  ],
  debugger: ["board_read", "lab_list", "lab_read", "lab_search"],
  independent_reviewer: ["board_read", "repo_list", "repo_read", "paper_read_page", "artifact_read"],
  supervisor: ["board_read", "delegate"],
};

export type ToolContext = {
  runId: string;
  agentId: string;
  role: AgentRole;
  signal: AbortSignal;
  board: EvidenceBoard;
  receiptId: string;
};

export type ToolResult = {
  /** What the model reads back; bounded by the runtime. */
  content: string;
  /** One line for events and receipts. */
  summary: string;
  /** Structured receipt data, persisted and hashed. */
  output?: Record<string, unknown>;
  isError?: boolean;
  /** "denied" when policy refused the action rather than the action failing. */
  status?: "ok" | "error" | "denied";
};

export type ToolDefinition<I = unknown> = {
  name: string;
  description: string;
  input: z.ZodType<I>;
  run(input: I, context: ToolContext): Promise<ToolResult>;
};

/** Returned to the model when a tool throws; the error text is bounded and has no stack. */
export class ToolDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolDenied";
  }
}

export function defineTool<I>(tool: ToolDefinition<I>): ToolDefinition<unknown> {
  return tool as ToolDefinition<unknown>;
}

export function toolSpec(tool: ToolDefinition): ToolSpec {
  const schema = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, inputSchema: schema };
}

export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export function assertGrants(role: AgentRole, grants: readonly string[]): void {
  const allowed = new Set(ROLE_CAPABILITIES[role]);
  for (const grant of grants) {
    if (!allowed.has(grant)) {
      throw new Error(`${ROLE_LABELS[role]} may not be granted ${grant}`);
    }
  }
}
