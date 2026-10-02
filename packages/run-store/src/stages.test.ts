import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunStore, StageOwnershipError, StageTransitionError, downstreamOf } from "./index.js";

let dir: string;
let store: RunStore;
const RUN = "run_stages";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dejaml-stages-"));
  store = new RunStore(join(dir, "runs.sqlite"));
  store.createRun({}, RUN);
  store.stages.begin(RUN, { paper: "p" });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const lease = { leaseMs: 60_000 };

describe("study stage machine", () => {
  it("lets exactly one owner run a stage and refuses a second concurrent owner", () => {
    expect(store.stages.claim(RUN, "ingesting", "owner-a", lease).completed).toBe(false);
    expect(() => store.stages.claim(RUN, "ingesting", "owner-b", lease)).toThrow(StageOwnershipError);
    expect(() => store.stages.complete(RUN, "ingesting", "owner-b", {})).toThrow(StageOwnershipError);
    store.stages.complete(RUN, "ingesting", "owner-a", { pages: 3 });
  });

  it("enforces prerequisites: the Planner waits for both analysts", () => {
    expect(() => store.stages.claim(RUN, "analyzing_paper", "o", lease)).toThrow(/cannot start before ingesting/u);
    store.stages.claim(RUN, "ingesting", "o", lease);
    store.stages.complete(RUN, "ingesting", "o", {});
    store.stages.claim(RUN, "analyzing_paper", "o", lease);
    store.stages.claim(RUN, "analyzing_repository", "o", lease);
    store.stages.complete(RUN, "analyzing_paper", "o", {});
    expect(() => store.stages.claim(RUN, "reconciling", "o", lease)).toThrow(/analyzing_repository/u);
    store.stages.complete(RUN, "analyzing_repository", "o", {});
    expect(store.stages.claim(RUN, "reconciling", "o", lease).completed).toBe(false);
  });

  it("never reruns a completed stage: a second claim returns the stored output", () => {
    store.stages.claim(RUN, "ingesting", "o", lease);
    store.stages.complete(RUN, "ingesting", "o", { pages: 7 });
    const again = store.stages.claim(RUN, "ingesting", "someone-else", lease);
    expect(again).toMatchObject({ completed: true, record: { status: "completed", attempt: 1, output: { pages: 7 } } });
  });

  it("requires a typed reason for a retry and records it", () => {
    store.stages.claim(RUN, "ingesting", "o", lease);
    store.stages.fail(RUN, "ingesting", "o", "boom");
    expect(() => store.stages.claim(RUN, "ingesting", "o2", lease)).toThrow(/typed reason/u);
    expect(() => store.stages.claim(RUN, "ingesting", "o2", { ...lease, retryReason: "because" as never })).toThrow();
    const retry = store.stages.claim(RUN, "ingesting", "o2", { ...lease, retryReason: "transient_provider_error" });
    expect(retry.record).toMatchObject({ attempt: 2, retryReason: "transient_provider_error", owner: "o2" });
    expect(store.stages.transitions(RUN).map((item) => `${item.stage}:${item.from}->${item.to}:${item.reason ?? ""}`)).toEqual([
      "ingesting:pending->running:",
      "ingesting:running->failed:boom",
      "ingesting:failed->running:transient_provider_error",
    ]);
  });

  it("invalidates a stage and everything after it, only with a typed reason", () => {
    for (const stage of ["ingesting", "analyzing_paper", "analyzing_repository", "reconciling", "policy_review", "preparing"] as const) {
      store.stages.claim(RUN, stage, "o", lease);
      store.stages.complete(RUN, stage, "o", {});
    }
    const changed = store.stages.invalidate(RUN, "reconciling", "dependency_failure_replan");
    expect(changed.map((item) => item.stage)).toEqual(["reconciling", "policy_review", "preparing"]);
    expect(store.stages.stage(RUN, "analyzing_paper").status).toBe("completed");
    expect(() => store.stages.claim(RUN, "policy_review", "o", lease)).toThrow(/reconciling/u);
    expect(store.stages.claim(RUN, "reconciling", "o", { ...lease, retryReason: "dependency_failure_replan" }).record.attempt).toBe(2);
    expect(downstreamOf("analyzing_paper")).toEqual([
      "analyzing_paper",
      "reconciling",
      "policy_review",
      "preparing",
      "executing",
      "reviewing",
      "deciding",
    ]);
  });

  it("recovers after a process restart: running stages fail with reason process_restart and resume with it", () => {
    store.stages.claim(RUN, "ingesting", "o", lease);
    store.stages.complete(RUN, "ingesting", "o", { pages: 2 });
    store.stages.claim(RUN, "analyzing_paper", "process-1", lease);
    store.close();
    // A new process opens the same database.
    store = new RunStore(join(dir, "runs.sqlite"));
    expect(store.stages.unfinished().map((item) => item.runId)).toEqual([RUN]);
    expect(store.stages.state(RUN)?.inputs).toEqual({ paper: "p" });
    const recovered = store.stages.recoverAfterRestart(RUN);
    expect(recovered.map((item) => item.stage)).toEqual(["analyzing_paper"]);
    expect(store.stages.claim(RUN, "ingesting", "process-2", lease).completed).toBe(true);
    const resumed = store.stages.claim(RUN, "analyzing_paper", "process-2", { ...lease, retryReason: "process_restart" });
    expect(resumed.record).toMatchObject({ attempt: 2, retryReason: "process_restart" });
  });

  it("takes over an expired lease only with a reason", async () => {
    store.stages.claim(RUN, "ingesting", "a", { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(() => store.stages.claim(RUN, "ingesting", "b", lease)).toThrow(/typed reason/u);
    expect(store.stages.claim(RUN, "ingesting", "b", { ...lease, retryReason: "process_restart" }).record.owner).toBe("b");
    expect(() => store.stages.complete(RUN, "ingesting", "a", {})).toThrow(StageOwnershipError);
  });

  it("makes a terminal study immutable", () => {
    store.stages.claim(RUN, "ingesting", "o", lease);
    store.stages.finish(RUN, "cancelled", "cancelled");
    expect(store.stages.stage(RUN, "ingesting").status).toBe("failed");
    expect(() => store.stages.claim(RUN, "ingesting", "o", { ...lease, retryReason: "operator_request" })).toThrow(StageTransitionError);
    expect(() => store.stages.invalidate(RUN, "ingesting", "operator_request")).toThrow(/already ended/u);
    expect(() => store.stages.finish(RUN, "completed", "reproduced")).toThrow(/already ended/u);
    expect(() => store.stages.begin(RUN, {})).toThrow(/already exists/u);
    expect(store.stages.state(RUN)).toMatchObject({ terminal: "cancelled", resultStatus: "cancelled" });
    expect(store.stages.unfinished()).toEqual([]);
  });
});
