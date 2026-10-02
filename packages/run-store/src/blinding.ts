import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * The persisted record of a blinded study: the commitments that keep the
 * paper's reported value away from every agent until the observation and the
 * blind review are locked, and the order in which that happened.
 *
 * Each phase is one append-only row; SQLite triggers refuse any UPDATE or
 * DELETE of a recorded phase or of the sealed target, so a commitment, once
 * written, cannot be changed by anyone, including this code. The sealed target
 * (the reported value, tolerance and private nonce) lives in its own table
 * that only trusted orchestrator code reads, through `sealedTarget()`; no
 * agent tool, event, or report reads it before `target_revealed`.
 */

export const BLINDING_PHASES = [
  "target_sealed",
  "agents_started",
  "execution_completed",
  "observation_locked",
  "blind_review_locked",
  "target_revealed",
  "deterministic_comparison",
  "final_status",
] as const;
export type BlindingPhase = (typeof BLINDING_PHASES)[number];

/**
 * Which phase may follow which. A study may stop at any point before the
 * reveal (`final_status` with the target still sealed); a blind rejection may
 * lead to one more round of execution; the reveal needs both locks first.
 */
const NEXT: Record<BlindingPhase | "none", readonly BlindingPhase[]> = {
  none: ["target_sealed"],
  target_sealed: ["agents_started", "final_status"],
  agents_started: ["execution_completed", "final_status"],
  execution_completed: ["observation_locked", "execution_completed", "final_status"],
  observation_locked: ["blind_review_locked", "final_status"],
  blind_review_locked: ["target_revealed", "execution_completed", "final_status"],
  target_revealed: ["deterministic_comparison"],
  deterministic_comparison: ["final_status"],
  final_status: [],
};

export type BlindingRecord = {
  runId: string;
  sequence: number;
  phase: BlindingPhase;
  round: number;
  /** SHA-256 commitment recorded by this phase, if it makes one. */
  commitment: string | null;
  /** Public facts of the phase. Never the sealed value before `target_revealed`. */
  record: Record<string, unknown>;
  at: string;
};

export type SealedTargetRow = {
  runId: string;
  /** The exact canonical JSON whose SHA-256 is the commitment (it holds the private nonce). */
  canonical: string;
  commitment: string;
  sealedAt: string;
};

export class BlindingOrderError extends Error {
  readonly code = "invalid_blinding_transition";
  constructor(
    readonly from: BlindingPhase | "none",
    readonly to: BlindingPhase,
  ) {
    super(`blinding phase ${to} cannot follow ${from}`);
    this.name = "BlindingOrderError";
  }
}

export class BlindingIntegrityError extends Error {
  readonly code = "commitment_mismatch";
  constructor(message: string) {
    super(message);
    this.name = "BlindingIntegrityError";
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class BlindingLedger {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(database: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = database;
    this.#now = now;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS study_blinding (
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence INTEGER NOT NULL,
        phase TEXT NOT NULL,
        round INTEGER NOT NULL,
        commitment TEXT,
        record_json TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS study_sealed_targets (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        canonical TEXT NOT NULL,
        commitment TEXT NOT NULL,
        sealed_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS study_blinding_immutable_update BEFORE UPDATE ON study_blinding
        BEGIN SELECT RAISE(ABORT, 'blinding records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS study_blinding_immutable_delete BEFORE DELETE ON study_blinding
        BEGIN SELECT RAISE(ABORT, 'blinding records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS study_sealed_targets_immutable_update BEFORE UPDATE ON study_sealed_targets
        BEGIN SELECT RAISE(ABORT, 'a sealed target is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS study_sealed_targets_immutable_delete BEFORE DELETE ON study_sealed_targets
        BEGIN SELECT RAISE(ABORT, 'a sealed target is immutable'); END;
    `);
  }

  /**
   * Seals the target: stores the canonical payload (restricted) and records
   * `target_sealed` with only the commitment and the public facts. The
   * commitment must be the SHA-256 of the canonical text.
   */
  seal(runId: string, input: { canonical: string; commitment: string; record: Record<string, unknown> }): BlindingRecord {
    if (sha256Hex(input.canonical) !== input.commitment)
      throw new BlindingIntegrityError("the commitment is not the hash of the sealed payload");
    return this.#tx(() => {
      const at = this.#iso();
      this.#db
        .prepare("INSERT INTO study_sealed_targets (run_id, canonical, commitment, sealed_at) VALUES (?, ?, ?, ?)")
        .run(runId, input.canonical, input.commitment, at);
      return this.#append(runId, "target_sealed", 0, input.commitment, { ...input.record, sealedAt: at }, at);
    });
  }

  /**
   * Records the next phase, refusing any phase out of order. Recording
   * `target_revealed` again returns the first reveal unchanged.
   */
  record(
    runId: string,
    phase: BlindingPhase,
    input: { round?: number; commitment?: string | null; record?: Record<string, unknown> } = {},
  ): BlindingRecord {
    if (phase === "target_sealed") throw new BlindingOrderError(this.last(runId)?.phase ?? "none", phase);
    return this.#tx(() => {
      const last = this.last(runId);
      if (phase === "target_revealed") {
        const revealed = this.records(runId).find((item) => item.phase === "target_revealed");
        if (revealed) return revealed;
      }
      const from = last?.phase ?? "none";
      if (!NEXT[from].includes(phase)) throw new BlindingOrderError(from, phase);
      return this.#append(runId, phase, input.round ?? last?.round ?? 0, input.commitment ?? null, input.record ?? {}, this.#iso());
    });
  }

  records(runId: string): BlindingRecord[] {
    const rows = this.#db
      .prepare("SELECT run_id, sequence, phase, round, commitment, record_json, at FROM study_blinding WHERE run_id = ? ORDER BY sequence")
      .all(runId) as Array<{
      run_id: string;
      sequence: number;
      phase: string;
      round: number;
      commitment: string | null;
      record_json: string;
      at: string;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      sequence: row.sequence,
      phase: row.phase as BlindingPhase,
      round: row.round,
      commitment: row.commitment,
      record: JSON.parse(row.record_json) as Record<string, unknown>,
      at: row.at,
    }));
  }

  last(runId: string): BlindingRecord | null {
    return this.records(runId).at(-1) ?? null;
  }

  find(runId: string, phase: BlindingPhase, round?: number): BlindingRecord | null {
    return (
      this.records(runId)
        .filter((item) => item.phase === phase && (round === undefined || item.round === round))
        .at(-1) ?? null
    );
  }

  /** Trusted orchestrator code only: the sealed payload, for the reveal and for an administrator's audit. */
  sealedTarget(runId: string): SealedTargetRow | null {
    const row = this.#db
      .prepare("SELECT run_id, canonical, commitment, sealed_at FROM study_sealed_targets WHERE run_id = ?")
      .get(runId) as { run_id: string; canonical: string; commitment: string; sealed_at: string } | undefined;
    return row ? { runId: row.run_id, canonical: row.canonical, commitment: row.commitment, sealedAt: row.sealed_at } : null;
  }

  #append(
    runId: string,
    phase: BlindingPhase,
    round: number,
    commitment: string | null,
    record: Record<string, unknown>,
    at: string,
  ): BlindingRecord {
    const next =
      ((this.#db.prepare("SELECT MAX(sequence) AS n FROM study_blinding WHERE run_id = ?").get(runId) as { n: number | null }).n ?? 0) + 1;
    this.#db
      .prepare("INSERT INTO study_blinding (run_id, sequence, phase, round, commitment, record_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(runId, next, phase, round, commitment, JSON.stringify(record), at);
    return { runId, sequence: next, phase, round, commitment, record, at };
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
