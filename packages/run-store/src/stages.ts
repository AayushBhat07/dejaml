import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  STAGE_PREREQUISITES,
  type StageRetryReason,
  StageRetryReasonSchema,
  type StageRunStatus,
  type StudyResultStatus,
  StudyResultStatusSchema,
  type StudyStage,
  StudyStageSchema,
  TERMINAL_STUDY_STAGES,
  type TerminalStudyStage,
  WORK_STAGES,
  type WorkStage,
} from "@dejaml/contracts";

/**
 * The persisted study state machine. Each work stage of a run has one row:
 * who owns it (a lease), how many attempts it took, why it ran again, and its
 * output. Transitions are compare-and-set inside SQLite transactions, so only
 * one owner can run a stage, a completed stage is never rerun unless it is
 * explicitly invalidated with a typed reason, and a terminal study never
 * changes again. Models never write here; only orchestrator code does.
 */

export type StageRecord = {
  runId: string;
  stage: WorkStage;
  status: StageRunStatus;
  attempt: number;
  owner: string | null;
  leaseExpiresAt: string | null;
  retryReason: StageRetryReason | null;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
};

export type StudyStateRecord = {
  runId: string;
  /** Inputs needed to resume after a restart (paper text, candidates, provider selection, platform). */
  inputs: Record<string, unknown>;
  terminal: TerminalStudyStage | null;
  resultStatus: StudyResultStatus | null;
  createdAt: string;
  updatedAt: string;
};

export type StageTransition = {
  runId: string;
  stage: StudyStage;
  from: string;
  to: string;
  owner: string | null;
  attempt: number;
  reason: string | null;
  at: string;
};

/** A stage is already running under another owner whose lease has not expired. */
export class StageOwnershipError extends Error {
  constructor(
    readonly stage: StudyStage,
    readonly owner: string,
  ) {
    super(`stage ${stage} is owned by ${owner}`);
    this.name = "StageOwnershipError";
  }
}

/** An illegal move: a missing prerequisite, a retry without a reason, or a change after the end. */
export class StageTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageTransitionError";
  }
}

type Row = Record<string, unknown>;

export class StudyStages {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(database: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = database;
    this.#now = now;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS study_state (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        inputs_json TEXT NOT NULL,
        terminal TEXT,
        result_status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS study_stages (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        owner TEXT,
        lease_expires_at TEXT,
        retry_reason TEXT,
        output_json TEXT,
        error TEXT,
        started_at TEXT,
        ended_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, stage)
      );

      CREATE TABLE IF NOT EXISTS study_transitions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        stage TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        owner TEXT,
        attempt INTEGER NOT NULL,
        reason TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS study_transitions_run_idx ON study_transitions(run_id, sequence);
    `);
  }

  /** Records a new study. Starting the same run twice is refused. */
  begin(runId: string, inputs: Record<string, unknown>): StudyStateRecord {
    return this.#tx(() => {
      if (this.#stateRow(runId)) throw new StageTransitionError(`study ${runId} already exists`);
      const now = this.#iso();
      this.#db
        .prepare(
          "INSERT INTO study_state (run_id, inputs_json, terminal, result_status, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)",
        )
        .run(runId, JSON.stringify(inputs), now, now);
      for (const stage of WORK_STAGES) {
        this.#db
          .prepare(
            `INSERT INTO study_stages (run_id, stage, status, attempt, owner, lease_expires_at, retry_reason, output_json, error, started_at, ended_at, updated_at)
             VALUES (?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
          )
          .run(runId, stage, now);
      }
      return this.state(runId)!;
    });
  }

  state(runId: string): StudyStateRecord | null {
    const row = this.#stateRow(runId);
    if (!row) return null;
    return {
      runId: String(row.run_id),
      inputs: JSON.parse(String(row.inputs_json)) as Record<string, unknown>,
      terminal: row.terminal === null ? null : (String(row.terminal) as TerminalStudyStage),
      resultStatus: row.result_status === null ? null : StudyResultStatusSchema.parse(row.result_status),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  stage(runId: string, stage: WorkStage): StageRecord {
    const row = this.#db.prepare("SELECT * FROM study_stages WHERE run_id = ? AND stage = ?").get(runId, stage) as Row | undefined;
    if (!row) throw new StageTransitionError(`study ${runId} has no stage ${stage}`);
    return stageFromRow(row);
  }

  stages(runId: string): StageRecord[] {
    const order = new Map(WORK_STAGES.map((stage, index) => [stage, index]));
    return (this.#db.prepare("SELECT * FROM study_stages WHERE run_id = ?").all(runId) as Row[])
      .map(stageFromRow)
      .sort((a, b) => (order.get(a.stage) ?? 0) - (order.get(b.stage) ?? 0));
  }

  transitions(runId: string): StageTransition[] {
    return (this.#db.prepare("SELECT * FROM study_transitions WHERE run_id = ? ORDER BY sequence").all(runId) as Row[]).map((row) => ({
      runId: String(row.run_id),
      stage: StudyStageSchema.parse(row.stage),
      from: String(row.from_status),
      to: String(row.to_status),
      owner: row.owner === null ? null : String(row.owner),
      attempt: Number(row.attempt),
      reason: row.reason === null ? null : String(row.reason),
      at: String(row.at),
    }));
  }

  /** Studies that have not ended, for restart recovery. */
  unfinished(): StudyStateRecord[] {
    return (this.#db.prepare("SELECT run_id FROM study_state WHERE terminal IS NULL ORDER BY created_at").all() as Row[])
      .map((row) => this.state(String(row.run_id))!)
      .filter(Boolean);
  }

  /**
   * Takes ownership of a stage. Returns `{ completed }` with the stored output
   * when the stage already finished (it is not run again), or the running
   * record when this owner now holds the lease. A stage that failed, was
   * invalidated, or whose owner's lease expired runs again only with a typed
   * retry reason.
   */
  claim(
    runId: string,
    stage: WorkStage,
    owner: string,
    options: { leaseMs: number; retryReason?: StageRetryReason },
  ): { completed: true; record: StageRecord } | { completed: false; record: StageRecord } {
    return this.#tx(() => {
      this.#assertOpen(runId);
      const current = this.stage(runId, stage);
      if (current.status === "completed" || current.status === "skipped") return { completed: true, record: current };
      for (const prerequisite of STAGE_PREREQUISITES[stage]) {
        const before = this.stage(runId, prerequisite);
        if (before.status !== "completed" && before.status !== "skipped") {
          throw new StageTransitionError(`${stage} cannot start before ${prerequisite} completes (it is ${before.status})`);
        }
      }
      const now = this.#now();
      if (
        current.status === "running" &&
        current.owner !== owner &&
        current.leaseExpiresAt &&
        Date.parse(current.leaseExpiresAt) > now.getTime()
      ) {
        throw new StageOwnershipError(stage, current.owner ?? "unknown");
      }
      const isRetry = current.attempt > 0;
      if (isRetry && current.owner !== owner && !options.retryReason) {
        throw new StageTransitionError(`${stage} already ran ${current.attempt} time(s); a retry needs a typed reason`);
      }
      if (options.retryReason) StageRetryReasonSchema.parse(options.retryReason);
      const attempt = current.status === "running" && current.owner === owner ? current.attempt : current.attempt + 1;
      const lease = new Date(now.getTime() + options.leaseMs).toISOString();
      this.#db
        .prepare(
          `UPDATE study_stages SET status = 'running', attempt = ?, owner = ?, lease_expires_at = ?, retry_reason = ?, error = NULL,
             started_at = ?, ended_at = NULL, updated_at = ? WHERE run_id = ? AND stage = ?`,
        )
        .run(
          attempt,
          owner,
          lease,
          isRetry ? (options.retryReason ?? current.retryReason) : null,
          now.toISOString(),
          now.toISOString(),
          runId,
          stage,
        );
      this.#log(runId, stage, current.status, "running", owner, attempt, isRetry ? (options.retryReason ?? null) : null);
      return { completed: false, record: this.stage(runId, stage) };
    });
  }

  /** Extends the owner's lease while long work continues. */
  renew(runId: string, stage: WorkStage, owner: string, leaseMs: number): void {
    this.#tx(() => {
      const current = this.#owned(runId, stage, owner);
      this.#db
        .prepare("UPDATE study_stages SET lease_expires_at = ?, updated_at = ? WHERE run_id = ? AND stage = ?")
        .run(new Date(this.#now().getTime() + leaseMs).toISOString(), this.#iso(), runId, current.stage);
    });
  }

  complete(runId: string, stage: WorkStage, owner: string, output: Record<string, unknown>): StageRecord {
    return this.#finish(runId, stage, owner, "completed", output, null);
  }

  fail(runId: string, stage: WorkStage, owner: string, error: string): StageRecord {
    return this.#finish(runId, stage, owner, "failed", null, error.slice(0, 2_000));
  }

  /** Marks a stage that was not needed (for example, preparation with no requirements). */
  skip(runId: string, stage: WorkStage, owner: string, output: Record<string, unknown>): StageRecord {
    return this.#finish(runId, stage, owner, "skipped", output, null);
  }

  /**
   * Invalidates a finished stage and every stage after it, so they run again.
   * The reason is typed and recorded; a terminal study cannot be invalidated.
   */
  invalidate(runId: string, stage: WorkStage, reason: StageRetryReason): StageRecord[] {
    return this.#tx(() => {
      this.#assertOpen(runId);
      StageRetryReasonSchema.parse(reason);
      const affected = downstreamOf(stage);
      const changed: StageRecord[] = [];
      for (const name of affected) {
        const current = this.stage(runId, name);
        if (current.status === "pending") continue;
        if (current.status === "running") throw new StageTransitionError(`${name} is running; stop it before invalidating`);
        this.#db
          .prepare(
            "UPDATE study_stages SET status = 'invalidated', owner = NULL, lease_expires_at = NULL, retry_reason = ?, updated_at = ? WHERE run_id = ? AND stage = ?",
          )
          .run(reason, this.#iso(), runId, name);
        this.#log(runId, name, current.status, "invalidated", null, current.attempt, reason);
        changed.push(this.stage(runId, name));
      }
      return changed;
    });
  }

  /**
   * After a process restart: stages that were running have no live owner.
   * They are marked failed with reason `process_restart`, so the next claim
   * retries them with that typed reason. Completed stages keep their output.
   */
  recoverAfterRestart(runId: string): StageRecord[] {
    return this.#tx(() => {
      const recovered: StageRecord[] = [];
      for (const record of this.stages(runId)) {
        if (record.status !== "running") continue;
        this.#db
          .prepare(
            "UPDATE study_stages SET status = 'failed', owner = NULL, lease_expires_at = NULL, retry_reason = 'process_restart', error = ?, ended_at = ?, updated_at = ? WHERE run_id = ? AND stage = ?",
          )
          .run("the service restarted while this stage was running", this.#iso(), this.#iso(), runId, record.stage);
        this.#log(runId, record.stage, "running", "failed", record.owner, record.attempt, "process_restart");
        recovered.push(this.stage(runId, record.stage));
      }
      return recovered;
    });
  }

  /** Ends the study. After this, no stage or result can change. */
  finish(runId: string, terminal: TerminalStudyStage, resultStatus: StudyResultStatus): StudyStateRecord {
    return this.#tx(() => {
      this.#assertOpen(runId);
      if (!(TERMINAL_STUDY_STAGES as readonly string[]).includes(terminal))
        throw new StageTransitionError(`${terminal} is not a terminal stage`);
      StudyResultStatusSchema.parse(resultStatus);
      const now = this.#iso();
      for (const record of this.stages(runId)) {
        if (record.status === "running") {
          this.#db
            .prepare(
              "UPDATE study_stages SET status = 'failed', owner = NULL, lease_expires_at = NULL, error = ?, ended_at = ?, updated_at = ? WHERE run_id = ? AND stage = ?",
            )
            .run(`the study ended (${terminal}) while this stage was running`, now, now, runId, record.stage);
          this.#log(runId, record.stage, "running", "failed", record.owner, record.attempt, terminal);
        }
      }
      this.#db
        .prepare("UPDATE study_state SET terminal = ?, result_status = ?, updated_at = ? WHERE run_id = ?")
        .run(terminal, resultStatus, now, runId);
      this.#log(runId, terminal, "open", terminal, null, 0, resultStatus);
      return this.state(runId)!;
    });
  }

  #finish(
    runId: string,
    stage: WorkStage,
    owner: string,
    status: "completed" | "failed" | "skipped",
    output: Record<string, unknown> | null,
    error: string | null,
  ): StageRecord {
    return this.#tx(() => {
      this.#assertOpen(runId);
      const current = this.#owned(runId, stage, owner);
      const now = this.#iso();
      this.#db
        .prepare(
          `UPDATE study_stages SET status = ?, owner = NULL, lease_expires_at = NULL, output_json = ?, error = ?, ended_at = ?, updated_at = ?
           WHERE run_id = ? AND stage = ?`,
        )
        .run(
          status,
          output === null ? (current.output === null ? null : JSON.stringify(current.output)) : JSON.stringify(output),
          error,
          now,
          now,
          runId,
          stage,
        );
      this.#log(runId, stage, "running", status, owner, current.attempt, error);
      return this.stage(runId, stage);
    });
  }

  #owned(runId: string, stage: WorkStage, owner: string): StageRecord {
    const current = this.stage(runId, stage);
    if (current.status !== "running") throw new StageTransitionError(`${stage} is not running (it is ${current.status})`);
    if (current.owner !== owner) throw new StageOwnershipError(stage, current.owner ?? "unknown");
    return current;
  }

  #assertOpen(runId: string): void {
    const state = this.state(runId);
    if (!state) throw new StageTransitionError(`study ${runId} does not exist`);
    if (state.terminal) throw new StageTransitionError(`study ${runId} already ended (${state.terminal}); its state cannot change`);
  }

  #stateRow(runId: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM study_state WHERE run_id = ?").get(runId) as Row | undefined;
  }

  #log(runId: string, stage: StudyStage, from: string, to: string, owner: string | null, attempt: number, reason: string | null): void {
    const row = this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM study_transitions WHERE run_id = ?").get(runId) as {
      next: number;
    };
    this.#db
      .prepare(
        "INSERT INTO study_transitions (id, run_id, sequence, stage, from_status, to_status, owner, attempt, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(`stt_${randomUUID().replaceAll("-", "")}`, runId, row.next, stage, from, to, owner, attempt, reason, this.#iso());
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  #tx<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** A stage and every work stage that depends on it, directly or not. */
export function downstreamOf(stage: WorkStage): WorkStage[] {
  const result = new Set<WorkStage>([stage]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of WORK_STAGES) {
      if (result.has(candidate)) continue;
      if (STAGE_PREREQUISITES[candidate].some((item) => result.has(item))) {
        result.add(candidate);
        grew = true;
      }
    }
  }
  return WORK_STAGES.filter((item) => result.has(item));
}

function stageFromRow(row: Row): StageRecord {
  return {
    runId: String(row.run_id),
    stage: String(row.stage) as WorkStage,
    status: String(row.status) as StageRunStatus,
    attempt: Number(row.attempt),
    owner: row.owner === null ? null : String(row.owner),
    leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
    retryReason: row.retry_reason === null ? null : (String(row.retry_reason) as StageRetryReason),
    output: row.output_json === null ? null : (JSON.parse(String(row.output_json)) as Record<string, unknown>),
    error: row.error === null ? null : String(row.error),
    startedAt: row.started_at === null ? null : String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    updatedAt: String(row.updated_at),
  };
}
