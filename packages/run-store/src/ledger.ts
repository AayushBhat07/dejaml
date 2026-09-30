import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Durable records for autonomous agents: identity, task, grants, limits,
 * conversation, tool receipts, messages between agents, and the shared
 * evidence board. Everything an agent did can be replayed from here, and an
 * interrupted agent can be resumed from its persisted conversation.
 */

export type AgentStatus = "created" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "exhausted" | "interrupted";

export type AgentRecord = {
  id: string;
  runId: string;
  role: string;
  parentId: string | null;
  status: AgentStatus;
  provider: string;
  model: string;
  task: Record<string, unknown>;
  grants: string[];
  limits: Record<string, number>;
  usage: AgentUsage;
  result: unknown;
  failure: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentUsage = {
  iterations: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  providerAttempts: number;
  /** Conversation segments; a new one starts when the bounded context is full. */
  segments: number;
};

export type AgentTurn = {
  agentId: string;
  sequence: number;
  segment: number;
  /** Provider-neutral chat message (see @dejaml/agent-runtime ChatMessage). */
  message: Record<string, unknown>;
  createdAt: string;
};

export type ToolReceipt = {
  id: string;
  agentId: string;
  runId: string;
  sequence: number;
  tool: string;
  toolCallId: string;
  input: unknown;
  inputSha256: string;
  status: "ok" | "error" | "denied" | "interrupted";
  summary: string;
  output: Record<string, unknown>;
  outputSha256: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
};

export type BoardEntry = {
  id: string;
  runId: string;
  sequence: number;
  authorAgentId: string | null;
  authorRole: string;
  kind: string;
  key: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AgentMessageRecord = {
  id: string;
  runId: string;
  fromAgentId: string | null;
  toAgentId: string;
  sequence: number;
  content: Record<string, unknown>;
  delivered: boolean;
  createdAt: string;
};

const EMPTY_USAGE: AgentUsage = {
  iterations: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  providerAttempts: 0,
  segments: 1,
};

type Row = Record<string, unknown>;

export class AgentLedger {
  readonly #db: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#db = database;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        parent_id TEXT,
        status TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        task_json TEXT NOT NULL,
        grants_json TEXT NOT NULL,
        limits_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        result_json TEXT,
        failure TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agents_run_idx ON agents(run_id, created_at);

      CREATE TABLE IF NOT EXISTS agent_turns (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        segment INTEGER NOT NULL,
        message_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS tool_receipts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        tool TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        input_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        output_json TEXT NOT NULL,
        output_sha256 TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS tool_receipts_run_idx ON tool_receipts(run_id, started_at);

      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        from_agent_id TEXT,
        to_agent_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_entries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        author_agent_id TEXT,
        author_role TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      );
    `);
  }

  createAgent(input: {
    id?: string;
    runId: string;
    role: string;
    parentId?: string | null;
    provider: string;
    model: string;
    task: Record<string, unknown>;
    grants: string[];
    limits: Record<string, number>;
  }): AgentRecord {
    const id = input.id ?? `agt_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO agents (id, run_id, role, parent_id, status, provider, model, task_json, grants_json,
           limits_json, usage_json, result_json, failure, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.role,
        input.parentId ?? null,
        input.provider,
        input.model,
        JSON.stringify(input.task),
        JSON.stringify(input.grants),
        JSON.stringify(input.limits),
        JSON.stringify(EMPTY_USAGE),
        now,
        now,
      );
    return this.getAgent(id);
  }

  getAgent(id: string): AgentRecord {
    const row = this.#db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`agent not found: ${id}`);
    return agentFromRow(row);
  }

  listAgents(runId: string): AgentRecord[] {
    return (this.#db.prepare("SELECT * FROM agents WHERE run_id = ? ORDER BY created_at, id").all(runId) as Row[]).map(
      agentFromRow,
    );
  }

  /** Agents that were mid-flight when the process stopped. */
  listUnfinishedAgents(): AgentRecord[] {
    return (
      this.#db
        .prepare("SELECT * FROM agents WHERE status IN ('created','running','waiting') ORDER BY created_at")
        .all() as Row[]
    ).map(agentFromRow);
  }

  updateAgent(
    id: string,
    patch: Partial<Pick<AgentRecord, "status" | "usage" | "result" | "failure">>,
  ): AgentRecord {
    const current = this.getAgent(id);
    const next = { ...current, ...patch };
    this.#db
      .prepare(
        `UPDATE agents SET status = ?, usage_json = ?, result_json = ?, failure = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        JSON.stringify(next.usage),
        next.result === undefined || next.result === null ? null : JSON.stringify(next.result),
        next.failure,
        new Date().toISOString(),
        id,
      );
    return this.getAgent(id);
  }

  appendTurn(agentId: string, segment: number, message: Record<string, unknown>): AgentTurn {
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM agent_turns WHERE agent_id = ?")
      .get(agentId) as { next: number };
    const createdAt = new Date().toISOString();
    this.#db
      .prepare("INSERT INTO agent_turns (agent_id, sequence, segment, message_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(agentId, row.next, segment, JSON.stringify(message), createdAt);
    return { agentId, sequence: row.next, segment, message, createdAt };
  }

  listTurns(agentId: string, segment?: number): AgentTurn[] {
    const rows = (
      segment === undefined
        ? this.#db.prepare("SELECT * FROM agent_turns WHERE agent_id = ? ORDER BY sequence").all(agentId)
        : this.#db
            .prepare("SELECT * FROM agent_turns WHERE agent_id = ? AND segment = ? ORDER BY sequence")
            .all(agentId, segment)
    ) as Row[];
    return rows.map((item) => ({
      agentId: String(item.agent_id),
      sequence: Number(item.sequence),
      segment: Number(item.segment),
      message: JSON.parse(String(item.message_json)) as Record<string, unknown>,
      createdAt: String(item.created_at),
    }));
  }

  startReceipt(input: Omit<ToolReceipt, "id" | "sequence" | "endedAt" | "durationMs" | "status" | "summary" | "output" | "outputSha256">): ToolReceipt {
    const id = `rcpt_${randomUUID().replaceAll("-", "")}`;
    const row = this.#db
      .prepare("SELECT COUNT(*) + 1 AS next FROM tool_receipts WHERE agent_id = ?")
      .get(input.agentId) as { next: number };
    this.#db
      .prepare(
        `INSERT INTO tool_receipts (id, agent_id, run_id, sequence, tool, tool_call_id, input_json, input_sha256,
           status, summary, output_json, output_sha256, started_at, ended_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'interrupted', 'started', '{}', '', ?, NULL, NULL)`,
      )
      .run(id, input.agentId, input.runId, row.next, input.tool, input.toolCallId, JSON.stringify(input.input ?? null), input.inputSha256, input.startedAt);
    return this.getReceipt(id);
  }

  finishReceipt(
    id: string,
    patch: { status: ToolReceipt["status"]; summary: string; output: Record<string, unknown>; outputSha256: string; endedAt: string; durationMs: number },
  ): ToolReceipt {
    this.#db
      .prepare(
        `UPDATE tool_receipts SET status = ?, summary = ?, output_json = ?, output_sha256 = ?, ended_at = ?, duration_ms = ? WHERE id = ?`,
      )
      .run(patch.status, patch.summary, JSON.stringify(patch.output), patch.outputSha256, patch.endedAt, patch.durationMs, id);
    return this.getReceipt(id);
  }

  getReceipt(id: string): ToolReceipt {
    const row = this.#db.prepare("SELECT * FROM tool_receipts WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`receipt not found: ${id}`);
    return receiptFromRow(row);
  }

  listReceipts(filter: { runId?: string; agentId?: string }): ToolReceipt[] {
    const rows = (
      filter.agentId
        ? this.#db.prepare("SELECT * FROM tool_receipts WHERE agent_id = ? ORDER BY sequence").all(filter.agentId)
        : this.#db.prepare("SELECT * FROM tool_receipts WHERE run_id = ? ORDER BY started_at, sequence").all(filter.runId ?? "")
    ) as Row[];
    return rows.map(receiptFromRow);
  }

  postMessage(input: { runId: string; fromAgentId: string | null; toAgentId: string; content: Record<string, unknown> }): AgentMessageRecord {
    const id = `msg_${randomUUID().replaceAll("-", "")}`;
    const row = this.#db
      .prepare("SELECT COUNT(*) + 1 AS next FROM agent_messages WHERE to_agent_id = ?")
      .get(input.toAgentId) as { next: number };
    const createdAt = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO agent_messages (id, run_id, from_agent_id, to_agent_id, sequence, content_json, delivered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(id, input.runId, input.fromAgentId, input.toAgentId, row.next, JSON.stringify(input.content), createdAt);
    return { id, ...input, sequence: row.next, delivered: false, createdAt };
  }

  /** Every explicit message of a run, in order, for the report (content is not returned). */
  listMessages(filter: { runId: string }): AgentMessageRecord[] {
    const rows = this.#db.prepare("SELECT * FROM agent_messages WHERE run_id = ? ORDER BY created_at, sequence").all(filter.runId) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      fromAgentId: row.from_agent_id === null ? null : String(row.from_agent_id),
      toAgentId: String(row.to_agent_id),
      sequence: Number(row.sequence),
      content: JSON.parse(String(row.content_json)) as Record<string, unknown>,
      delivered: Number(row.delivered) === 1,
      createdAt: String(row.created_at),
    }));
  }

  /** Undelivered messages for an agent, marked delivered in the same call. */
  takeMessages(agentId: string): AgentMessageRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM agent_messages WHERE to_agent_id = ? AND delivered = 0 ORDER BY sequence")
      .all(agentId) as Row[];
    this.#db.prepare("UPDATE agent_messages SET delivered = 1 WHERE to_agent_id = ? AND delivered = 0").run(agentId);
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      fromAgentId: row.from_agent_id === null ? null : String(row.from_agent_id),
      toAgentId: String(row.to_agent_id),
      sequence: Number(row.sequence),
      content: JSON.parse(String(row.content_json)) as Record<string, unknown>,
      delivered: true,
      createdAt: String(row.created_at),
    }));
  }

  postBoard(input: {
    runId: string;
    authorAgentId: string | null;
    authorRole: string;
    kind: string;
    key?: string | null;
    payload: Record<string, unknown>;
  }): BoardEntry {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM board_entries WHERE run_id = ?")
        .get(input.runId) as { next: number };
      const entry: BoardEntry = {
        id: `brd_${randomUUID().replaceAll("-", "")}`,
        runId: input.runId,
        sequence: row.next,
        authorAgentId: input.authorAgentId,
        authorRole: input.authorRole,
        kind: input.kind,
        key: input.key ?? null,
        payload: input.payload,
        createdAt: new Date().toISOString(),
      };
      this.#db
        .prepare(
          `INSERT INTO board_entries (id, run_id, sequence, author_agent_id, author_role, kind, key, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(entry.id, entry.runId, entry.sequence, entry.authorAgentId, entry.authorRole, entry.kind, entry.key, JSON.stringify(entry.payload), entry.createdAt);
      this.#db.exec("COMMIT");
      return entry;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listBoard(runId: string, kinds?: readonly string[]): BoardEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM board_entries WHERE run_id = ? ORDER BY sequence")
      .all(runId) as Row[];
    return rows
      .map((row) => ({
        id: String(row.id),
        runId: String(row.run_id),
        sequence: Number(row.sequence),
        authorAgentId: row.author_agent_id === null ? null : String(row.author_agent_id),
        authorRole: String(row.author_role),
        kind: String(row.kind),
        key: row.key === null ? null : String(row.key),
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
        createdAt: String(row.created_at),
      }))
      .filter((entry) => !kinds || kinds.includes(entry.kind));
  }
}

function agentFromRow(row: Row): AgentRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    role: String(row.role),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    status: String(row.status) as AgentStatus,
    provider: String(row.provider),
    model: String(row.model),
    task: JSON.parse(String(row.task_json)) as Record<string, unknown>,
    grants: JSON.parse(String(row.grants_json)) as string[],
    limits: JSON.parse(String(row.limits_json)) as Record<string, number>,
    usage: JSON.parse(String(row.usage_json)) as AgentUsage,
    result: row.result_json === null ? null : (JSON.parse(String(row.result_json)) as unknown),
    failure: row.failure === null ? null : String(row.failure),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function receiptFromRow(row: Row): ToolReceipt {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    tool: String(row.tool),
    toolCallId: String(row.tool_call_id),
    input: JSON.parse(String(row.input_json)) as unknown,
    inputSha256: String(row.input_sha256),
    status: String(row.status) as ToolReceipt["status"],
    summary: String(row.summary),
    output: JSON.parse(String(row.output_json)) as Record<string, unknown>,
    outputSha256: String(row.output_sha256),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  };
}
