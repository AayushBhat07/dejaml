import { RunStore } from "@dejaml/run-store";
import { describe, expect, it } from "vitest";

import { runLeadResearch } from "./lead.js";
import { type StructuredModelClient } from "./model.js";
import { codeFixture, paperFixture, planFixture, policyFixture } from "./test-fixtures.js";

function planningRun(store: RunStore, id: string): void {
  store.createRun({}, id);
  store.transitionRun(id, "ingesting");
  store.transitionRun(id, "discovering_repository");
  store.transitionRun(id, "analyzing");
  store.transitionRun(id, "planning");
}

describe("Lead Researcher reconciliation", () => {
  it("moves an approved plan to lab preparation with public events", async () => {
    const client: StructuredModelClient = {
      async complete(request) {
        expect(request.role).toBe("lead_researcher");
        return {
          value: request.schema.parse({
            schemaVersion: 1,
            status: "ready",
            summary: "The reports support the reviewed bounded experiment.",
            plan: planFixture,
            reasons: [],
            warnings: [],
          }),
        };
      },
    };
    const store = new RunStore();
    planningRun(store, "run_approved");
    const result = await runLeadResearch({
      runId: "run_approved",
      runStore: store,
      paperAnalysis: paperFixture,
      codeAnalysis: codeFixture,
      policy: policyFixture,
      modelClient: client,
    });
    expect(result.policy?.approved).toBe(true);
    expect(store.getRun("run_approved").status).toBe("preparing_lab");
    expect(store.listEvents("run_approved").map((event) => `${event.actor}:${event.type}:${event.status}`)).toEqual([
      "lead_researcher:reconciliation_started:started",
      "lead_researcher:reconciliation_completed:completed",
      "system:plan_policy_started:started",
      "system:plan_policy_completed:completed",
    ]);
    store.close();
  });

  it("rejects a widened command and ends inconclusive", async () => {
    const changed = structuredClone(planFixture);
    changed.command.args.push("--unsafe");
    const client: StructuredModelClient = {
      async complete(request) {
        return {
          value: request.schema.parse({
            schemaVersion: 1,
            status: "ready",
            summary: "Proposed an altered experiment.",
            plan: changed,
            reasons: [],
            warnings: [],
          }),
        };
      },
    };
    const store = new RunStore();
    planningRun(store, "run_rejected");
    const result = await runLeadResearch({
      runId: "run_rejected",
      runStore: store,
      paperAnalysis: paperFixture,
      codeAnalysis: codeFixture,
      policy: policyFixture,
      modelClient: client,
    });
    expect(result.policy?.approved).toBe(false);
    expect(store.getRun("run_rejected").status).toBe("inconclusive");
    expect(store.listEvents("run_rejected").at(-1)?.publicPayload).not.toHaveProperty("privateReasoning");
    store.close();
  });

  it("stops without policy evaluation when reconciliation is inconclusive", async () => {
    const client: StructuredModelClient = {
      async complete(request) {
        return {
          value: request.schema.parse({
            schemaVersion: 1,
            status: "inconclusive",
            summary: "The reports do not support one experiment.",
            plan: null,
            reasons: ["claim and repository mapping disagree"],
            warnings: [],
          }),
        };
      },
    };
    const store = new RunStore();
    planningRun(store, "run_inconclusive");
    const result = await runLeadResearch({
      runId: "run_inconclusive",
      runStore: store,
      paperAnalysis: paperFixture,
      codeAnalysis: codeFixture,
      policy: policyFixture,
      modelClient: client,
    });
    expect(result.policy).toBeNull();
    expect(store.getRun("run_inconclusive").status).toBe("inconclusive");
    expect(store.listEvents("run_inconclusive")).toHaveLength(2);
    store.close();
  });
});
