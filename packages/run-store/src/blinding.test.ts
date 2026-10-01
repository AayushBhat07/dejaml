import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlindingIntegrityError, BlindingOrderError, RunStore, sha256Hex } from "./index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dejaml-blinding-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const canonical = JSON.stringify({ nonce: "ab".repeat(32), reportedValue: 0.3141592653589793, tolerance: 0.02 });
const seal = (store: RunStore, runId: string) =>
  store.blinding.seal(runId, { canonical, commitment: sha256Hex(canonical), record: { caseId: "case", metric: "accuracy" } });

describe("blinding ledger", () => {
  it("records the full order once, and refuses every phase out of order", () => {
    const store = new RunStore();
    const { id } = store.createRun({});
    expect(() => store.blinding.record(id, "agents_started")).toThrow(BlindingOrderError);
    seal(store, id);
    expect(() => store.blinding.record(id, "target_revealed")).toThrow(/cannot follow target_sealed/u);
    store.blinding.record(id, "agents_started");
    store.blinding.record(id, "execution_completed", { round: 1 });
    // Reveal before the observation lock, and before the blind-review lock, are both refused.
    expect(() => store.blinding.record(id, "target_revealed")).toThrow(BlindingOrderError);
    store.blinding.record(id, "observation_locked", { commitment: "c".repeat(64) });
    expect(() => store.blinding.record(id, "target_revealed")).toThrow(/cannot follow observation_locked/u);
    store.blinding.record(id, "blind_review_locked", { commitment: "d".repeat(64) });
    const revealed = store.blinding.record(id, "target_revealed", { record: { verified: true } });
    // A second reveal is idempotent: the first record comes back and nothing new is written.
    expect(store.blinding.record(id, "target_revealed", { record: { verified: false } })).toEqual(revealed);
    store.blinding.record(id, "deterministic_comparison");
    store.blinding.record(id, "final_status");
    expect(() => store.blinding.record(id, "final_status")).toThrow(BlindingOrderError);
    expect(store.blinding.records(id).map((item) => item.phase)).toEqual([
      "target_sealed",
      "agents_started",
      "execution_completed",
      "observation_locked",
      "blind_review_locked",
      "target_revealed",
      "deterministic_comparison",
      "final_status",
    ]);
    store.close();
  });

  it("keeps the target sealed when a study stops before the locks", () => {
    const store = new RunStore();
    const { id } = store.createRun({});
    seal(store, id);
    store.blinding.record(id, "agents_started");
    store.blinding.record(id, "final_status", { record: { sealed: true } });
    expect(store.blinding.records(id).some((item) => item.phase === "target_revealed")).toBe(false);
    store.close();
  });

  it("refuses a commitment that is not the payload's hash, and any change to a recorded phase or the sealed target", () => {
    const store = new RunStore(join(dir, "runs.sqlite"));
    const { id } = store.createRun({});
    expect(() => store.blinding.seal(id, { canonical, commitment: "0".repeat(64), record: {} })).toThrow(BlindingIntegrityError);
    seal(store, id);
    expect(() => seal(store, id)).toThrow();
    store.close();
    // Even direct SQL cannot rewrite the commitments.
    const raw = new DatabaseSync(join(dir, "runs.sqlite"));
    expect(() => raw.exec("UPDATE study_sealed_targets SET canonical = '{}'")).toThrow(/immutable/u);
    expect(() => raw.exec("UPDATE study_blinding SET commitment = 'x'")).toThrow(/immutable/u);
    expect(() => raw.exec("DELETE FROM study_blinding")).toThrow(/immutable/u);
    raw.close();
  });

  it("survives a restart with every commitment and the stage order intact", () => {
    const file = join(dir, "runs.sqlite");
    const first = new RunStore(file);
    const { id } = first.createRun({});
    seal(first, id);
    first.blinding.record(id, "agents_started");
    first.blinding.record(id, "execution_completed", { round: 1 });
    first.blinding.record(id, "observation_locked", { commitment: "e".repeat(64) });
    first.close();
    const second = new RunStore(file);
    expect(second.blinding.sealedTarget(id)).toMatchObject({ canonical, commitment: sha256Hex(canonical) });
    expect(second.blinding.find(id, "observation_locked")?.commitment).toBe("e".repeat(64));
    expect(() => second.blinding.record(id, "target_revealed")).toThrow(BlindingOrderError);
    second.blinding.record(id, "blind_review_locked");
    expect(second.blinding.record(id, "target_revealed").phase).toBe("target_revealed");
    second.close();
  });
});
