import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  type RunEvent,
  type RunStatus,
  RunEventSchema,
  RunStatusSchema,
} from "@dejaml/contracts";

import { AgentLedger } from "./ledger.js";
import { StudyStages } from "./stages.js";

export * from "./ledger.js";
export * from "./stages.js";

type AppendEventInput = Omit<RunEvent, "id" | "sequence" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};

export type RunSnapshot = {
  id: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  input: Record<string, unknown>;
};

const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "inconclusive",
  "failed",
  "cancelled",
  "timed_out",
]);

const ALLOWED_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["ingesting", "cancelled", "failed"],
  ingesting: ["discovering_repository", "inconclusive", "cancelled", "failed"],
  discovering_repository: ["analyzing", "inconclusive", "cancelled", "failed"],
  analyzing: ["planning", "inconclusive", "cancelled", "failed"],
  planning: ["validating_plan", "inconclusive", "cancelled", "failed"],
  validating_plan: ["preparing_lab", "inconclusive", "cancelled", "failed"],
  preparing_lab: ["running", "cancelled", "failed", "timed_out"],
  running: ["comparing", "cancelled", "failed", "timed_out"],
  comparing: ["auditing", "completed", "inconclusive", "failed"],
  auditing: ["completed", "inconclusive", "failed"],
  completed: [],
  inconclusive: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export class RunStore {
  readonly #database: DatabaseSync;
  readonly #events = new EventEmitter();
  /** Agent identities, conversations, tool receipts, messages, and the evidence board. */
  readonly ledger: AgentLedger;
  /** The persisted study state machine (stages, owners, retries, terminal state). */
  readonly stages: StudyStages;

  constructor(filename = ":memory:") {
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA foreign_keys = ON");
    if (filename !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL");
      this.#database.exec("PRAGMA busy_timeout = 5000");
    }
    this.#migrate();
    this.ledger = new AgentLedger(this.#database);
    this.stages = new StudyStages(this.#database);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        input_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        public_payload_json TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS events_run_sequence_idx
        ON events(run_id, sequence);
    `);
  }

  createRun(input: Record<string, unknown>, id = `run_${randomUUID()}`): RunSnapshot {
    const timestamp = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO runs (id, status, created_at, updated_at, input_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, "queued", timestamp, timestamp, JSON.stringify(input));
    return this.getRun(id);
  }

  getRun(runId: string): RunSnapshot {
    const row = this.#database
      .prepare(
        `SELECT id, status, created_at, updated_at, input_json
         FROM runs WHERE id = ?`,
      )
      .get(runId) as
      | {
          id: string;
          status: string;
          created_at: string;
          updated_at: string;
          input_json: string;
        }
      | undefined;

    if (!row) {
      throw new Error(`run not found: ${runId}`);
    }

    return {
      id: row.id,
      status: RunStatusSchema.parse(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      input: JSON.parse(row.input_json) as Record<string, unknown>,
    };
  }

  /** Runs that have not reached a terminal status, oldest first. */
  listActiveRuns(): RunSnapshot[] {
    const rows = this.#database
      .prepare("SELECT id FROM runs ORDER BY created_at ASC, id ASC")
      .all() as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)).filter((run) => !TERMINAL_STATUSES.has(run.status));
  }

  isTerminal(runId: string): boolean {
    return TERMINAL_STATUSES.has(this.getRun(runId).status);
  }

  transitionRun(runId: string, nextStatus: RunStatus): RunSnapshot {
    const current = this.getRun(runId);
    const parsedNext = RunStatusSchema.parse(nextStatus);
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new Error(`cannot transition terminal run ${runId} from ${current.status}`);
    }
    if (!ALLOWED_TRANSITIONS[current.status].includes(parsedNext)) {
      throw new Error(`invalid run transition: ${current.status} -> ${parsedNext}`);
    }

    const timestamp = new Date().toISOString();
    this.#database
      .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
      .run(parsedNext, timestamp, runId);
    return this.getRun(runId);
  }

  appendEvent(input: AppendEventInput): RunEvent {
    this.getRun(input.runId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events WHERE run_id = ?",
        )
        .get(input.runId) as { next_sequence: number };

      const event = RunEventSchema.parse({
        ...input,
        id: input.id ?? `evt_${randomUUID()}`,
        sequence: row.next_sequence,
        timestamp: input.timestamp ?? new Date().toISOString(),
      });

      this.#database
        .prepare(
          `INSERT INTO events (
             id, run_id, sequence, timestamp, actor, type, status, summary,
             evidence_json, public_payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.runId,
          event.sequence,
          event.timestamp,
          event.actor,
          event.type,
          event.status,
          event.summary,
          JSON.stringify(event.evidence),
          JSON.stringify(event.publicPayload),
        );
      this.#database.exec("COMMIT");
      this.#events.emit(this.#eventName(event.runId), event);
      return event;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listEvents(runId: string, afterSequence = 0): RunEvent[] {
    this.getRun(runId);
    const rows = this.#database
      .prepare(
        `SELECT id, run_id, sequence, timestamp, actor, type, status, summary,
                evidence_json, public_payload_json
         FROM events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC`,
      )
      .all(runId, afterSequence) as Array<{
      id: string;
      run_id: string;
      sequence: number;
      timestamp: string;
      actor: string;
      type: string;
      status: string;
      summary: string;
      evidence_json: string;
      public_payload_json: string;
    }>;

    return rows.map((row) =>
      RunEventSchema.parse({
        id: row.id,
        runId: row.run_id,
        sequence: row.sequence,
        timestamp: row.timestamp,
        actor: row.actor,
        type: row.type,
        status: row.status,
        summary: row.summary,
        evidence: JSON.parse(row.evidence_json),
        publicPayload: JSON.parse(row.public_payload_json),
      }),
    );
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    this.getRun(runId);
    const eventName = this.#eventName(runId);
    this.#events.on(eventName, listener);
    return () => this.#events.off(eventName, listener);
  }

  close(): void {
    this.#events.removeAllListeners();
    this.#database.close();
  }

  #eventName(runId: string): string {
    return `run:${runId}:event`;
  }
}

