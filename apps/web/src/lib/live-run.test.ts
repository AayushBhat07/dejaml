import type { RunEvent } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";

import recorded from "../../../../fixtures/events/urban-land-cover-success.json";
import { byType, engineerOne, labOne, makeEvent, studyEvents, until } from "../test/stream";
import { analyzeRun, formatElapsed, type AgentCard } from "./live-run";
import { redact } from "./redact";

const cardsOf = (cards: AgentCard[], role: AgentCard["role"]) => cards.filter((card) => card.role === role);
const last = studyEvents.at(-1)!.sequence;

describe("analyzeRun: agent roster", () => {
  it("shows every agent instance, not one card per role", () => {
    const view = analyzeRun(studyEvents);
    expect(view.native).toBe(true);
    const engineers = cardsOf(view.cards, "lab_engineer");
    expect(engineers.map((card) => card.label)).toEqual(["engineer-1", "engineer-2"]);
    expect(new Set(engineers.map((card) => card.agentId)).size).toBe(2);
    expect(cardsOf(view.cards, "independent_reviewer").map((card) => card.label)).toEqual(["reviewer-engineer-1", "reviewer-engineer-2"]);
    // Roster order follows the study: Supervisor, analysts, Planner, Engineers, Reviewers.
    expect([...new Set(view.cards.map((card) => card.role))]).toEqual([
      "supervisor",
      "paper_analyst",
      "repository_analyst",
      "reproduction_planner",
      "lab_engineer",
      "independent_reviewer",
    ]);
    const engineer = engineers[0]!;
    expect(engineer).toMatchObject({ status: "done", toolCalls: 2, turns: 2, placeholder: false, tokens: { input: 400, output: 80 } });
    expect(engineer.startedAt).toBe(engineerOne.timestamp);
  });

  it("explains what each waiting role waits for, in the study's dependency order", () => {
    const analysts = analyzeRun(until(byType("agent_turn", (event) => event.publicPayload.role === "repository_analyst")));
    const status = (role: AgentCard["role"]) => cardsOf(analysts.cards, role).map((card) => card.status);
    // Both analysts work at once; nothing downstream is animated as working.
    expect(status("paper_analyst")).toEqual(["using_tool"]);
    expect(status("repository_analyst")).toEqual(["using_tool"]);
    expect(analysts.currentStage).toBe("Analyzing the paper and the repository");
    const reason = (role: AgentCard["role"]) => cardsOf(analysts.cards, role)[0]!.waitingReason;
    expect(status("reproduction_planner")).toEqual(["waiting"]);
    expect(reason("reproduction_planner")).toBe("Waiting for the Paper Analyst and the Repository Analyst to finish.");
    expect(reason("lab_engineer")).toBe("Waiting for an approved plan.");
    expect(reason("independent_reviewer")).toBe("Waiting for execution evidence from the Lab Engineers.");
    expect(reason("supervisor")).toMatch(/^Waits for checkpoints/u);
    expect(analysts.debuggerNote).toMatch(/only if a Lab Engineer asks for help/u);

    const oneDone = analyzeRun(until(byType("agent_finished", (event) => event.publicPayload.role === "paper_analyst")));
    expect(cardsOf(oneDone.cards, "reproduction_planner")[0]!.waitingReason).toBe("Waiting for the Repository Analyst to finish.");

    const planning = analyzeRun(until(byType("agent_started", (event) => event.publicPayload.role === "reproduction_planner")));
    expect(cardsOf(planning.cards, "lab_engineer")[0]!.waitingReason).toBe(
      "Waiting for an approved plan: the Planner's plan must pass policy review first.",
    );
    const approved = analyzeRun(until(byType("plan_approved")));
    expect(cardsOf(approved.cards, "lab_engineer")[0]!.waitingReason).toBe(
      "The plan is approved; waiting for the lab image and dependency preparation.",
    );

    // Before its agent starts, each engineer has its own card while the orchestrator sets up its lab.
    const setup = analyzeRun(until(byType("lab_ready", (event) => event.publicPayload.engineer === "engineer-1")));
    const waiting = cardsOf(setup.cards, "lab_engineer");
    expect(waiting.map((card) => [card.label, card.status, card.placeholder])).toEqual([
      ["engineer-1", "waiting", true],
      ["engineer-2", "waiting", true],
    ]);
    expect(waiting[0]!.waitingReason).toBe("Lab ready; the engineer starts next");
    expect(waiting[1]!.waitingReason).toMatch(/^The orchestrator is setting up this engineer's sealed lab \(step \d\)$/u);

    const executing = analyzeRun(until(byType("agent_turn", (event) => event.publicPayload.label === "engineer-2")));
    expect(cardsOf(executing.cards, "independent_reviewer")[0]!.waitingReason).toBe(
      "Waiting for execution evidence: 2 Lab Engineers are still working.",
    );
  });

  it("keeps earlier agents' cards after later stages begin, and shows Reviewers reviewing", () => {
    const reviewing = analyzeRun(until(byType("agent_turn", (event) => event.publicPayload.label === "reviewer-engineer-2")));
    expect(cardsOf(reviewing.cards, "independent_reviewer").map((card) => card.status)).toEqual(["reviewing", "reviewing"]);
    for (const role of ["paper_analyst", "repository_analyst", "reproduction_planner", "lab_engineer"] as const) {
      expect(cardsOf(reviewing.cards, role).every((card) => card.status === "done")).toBe(true);
    }
    expect(reviewing.currentStage).toBe("Independent review");
    // The Debugger is optional: absent, it is a note, never a card.
    expect(cardsOf(reviewing.cards, "debugger")).toEqual([]);
    const end = analyzeRun(studyEvents);
    expect(end.debuggerNote).toBe("No Debugger was needed in this study.");
    expect(end.finished).toBe(true);
    expect(end.result).toEqual({ status: "reproduced", reasons: [expect.stringContaining("within tolerance")] });
    expect(end.cleanup).toMatchObject({ verified: true, labsRemoved: 2, labsTotal: 2, leftovers: 0, liveAgents: 0 });
    expect(end.stages.map((step) => step.state)).toEqual(Array(8).fill("done"));
  });

  it("adds a Debugger only when an Engineer asks, and shows the Engineer blocked until it answers", () => {
    const upTo = until(byType("agent_turn", (event) => event.publicPayload.label === "engineer-1"));
    const parent = String(engineerOne.publicPayload.agentId);
    const debuggerId = "agt_debugger0000000000000000000001";
    const base = upTo.at(-1)!.sequence;
    const events: RunEvent[] = [
      ...upTo,
      makeEvent(base + 1, {
        type: "agent_turn",
        actor: "lab_engineer",
        publicPayload: {
          agentId: parent,
          role: "lab_engineer",
          label: "engineer-1",
          iteration: 2,
          tools: ["request_debugging"],
          text: null,
        },
      }),
      makeEvent(base + 2, {
        type: "agent_started",
        actor: "debugger",
        status: "started",
        summary: "Debugger started (engineer-1-debugger-1)",
        publicPayload: { agentId: debuggerId, role: "debugger", label: "engineer-1-debugger-1", parentAgentId: parent },
      }),
    ];
    const blocked = analyzeRun(events);
    const engineer = blocked.cards.find((card) => card.agentId === parent)!;
    expect(engineer.status).toBe("blocked");
    expect(engineer.waitingReason).toBe("Waiting for engineer-1-debugger-1 to diagnose a failure");
    expect(cardsOf(blocked.cards, "debugger")).toHaveLength(1);
    expect(blocked.debuggerNote).toBeNull();
    expect(blocked.stream.find((item) => item.event.sequence === base + 1)?.category).toBe("messages");

    const answered = analyzeRun([
      ...events,
      makeEvent(base + 3, {
        type: "agent_finished",
        actor: "debugger",
        status: "completed",
        publicPayload: {
          agentId: debuggerId,
          role: "debugger",
          label: "engineer-1-debugger-1",
          status: "completed",
          usage: { toolCalls: 3 },
        },
      }),
    ]);
    expect(answered.cards.find((card) => card.agentId === parent)).toMatchObject({ status: "using_tool", waitingReason: null });
    expect(cardsOf(answered.cards, "debugger")[0]).toMatchObject({ status: "done", toolCalls: 3 });
  });
});

describe("analyzeRun: activity stream and privacy", () => {
  it("files events under their agent instance, including lab steps and system receipts", () => {
    const view = analyzeRun(studyEvents);
    const engineer2 = cardsOf(view.cards, "lab_engineer")[1]!;
    const own = view.stream.filter((item) => item.agentKey === engineer2.key);
    expect(own.length).toBeGreaterThan(5);
    const lab2 = view.labs.find((lab) => lab.label === "engineer-2")!.labId;
    expect(
      own.every(
        (item) =>
          JSON.stringify(item.event).includes("engineer-2") ||
          item.event.publicPayload.agentId === engineer2.agentId ||
          item.event.publicPayload.labId === lab2,
      ),
    ).toBe(true);
    expect(own.some((item) => JSON.stringify(item.event).includes("engineer-1"))).toBe(false);
    // Setup steps run before the agent started still belong to engineer-2.
    expect(own.some((item) => item.event.type === "agent_command" && item.event.publicPayload.step === 1)).toBe(true);
    expect(own.some((item) => item.event.type === "official_run")).toBe(true);
    // Terminal output and samples stay in the lab panel.
    expect(view.stream.some((item) => item.event.type === "lab_output")).toBe(false);
    const categories = new Set(view.stream.map((item) => item.category));
    for (const category of ["agents", "tools", "evidence", "repository", "claims", "plan", "preparation", "lab", "review", "stages"]) {
      expect(categories.has(category as never)).toBe(true);
    }
  });

  it("never shows a turn's model text, and masks secrets and private host paths", () => {
    const turn = studyEvents.find(byType("agent_turn"))!;
    const view = analyzeRun([
      { ...turn, publicPayload: { ...turn.publicPayload, text: "HIDDEN-REASONING: I think the key is sk-proj-abcdefghijklmnop" } },
      makeEvent(turn.sequence + 1, {
        type: "lab_output",
        actor: "lab_engineer",
        publicPayload: {
          labId: labOne,
          stream: "stderr",
          lines: ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "OPENAI_API_KEY=sk-test-0000000000000000", "/home/alice/data.csv"],
        },
      }),
    ]);
    const shown =
      JSON.stringify(view.stream.map((item) => [item.text, item.detail])) + JSON.stringify(view.cards) + JSON.stringify(view.labs);
    expect(shown).not.toContain("HIDDEN-REASONING");
    expect(shown).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(shown).not.toContain("sk-test-0000000000000000");
    expect(shown).not.toContain("/home/alice");
    expect(view.labs[0]!.lines.map((line) => line.text)).toEqual([
      "Authorization: [redacted]",
      "OPENAI_API_KEY=[redacted]",
      "[host path]/data.csv",
    ]);
    expect(redact("cwd /workspace/case/work/repo")).toBe("cwd /workspace/case/work/repo");
  });
});

describe("analyzeRun: Virtual Lab", () => {
  it("follows each engineer's sealed lab: isolation, commands, live output, approved run, artifacts, cleanup", () => {
    const running = analyzeRun(until(byType("lab_output", (event) => event.publicPayload.labId === labOne)));
    const lab = running.labs.find((item) => item.labId === labOne)!;
    expect(lab.label).toBe("engineer-1");
    expect(lab.state).toBe("running");
    expect(lab.isolation).toMatchObject({ network: "none", readOnlyRoot: true });
    expect(lab.current).toMatchObject({ running: true, text: "/workspace/case/work/.venv/bin/python train.py", step: 6 });
    expect(lab.lines.map((line) => line.text)).toEqual(["stand-in progress 1/3", "stand-in progress 2/3"]);
    expect(lab.environment).toMatch(/^engineer-1's lab is ready/u);

    const end = analyzeRun(studyEvents);
    expect(end.labs.map((item) => item.label)).toEqual(["engineer-1", "engineer-2"]);
    const done = end.labs[0]!;
    expect(done.state).toBe("removed");
    expect(done.official).toMatchObject({ exitCode: 0, summary: "engineer-1 ran the approved command: exit 0" });
    expect(done.artifacts).toEqual([
      expect.objectContaining({ path: "artifacts/result.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    ]);
    expect(done.cleanup).toMatchObject({ clean: true, verifiedAbsent: true });
    expect(done.lines.at(-1)?.text).toBe('DEJAML_RESULT={"accuracyPercent":79.88}');
  });

  it("reads resource samples, the server's held-back lines, and cancellation", () => {
    const base = until(byType("lab_output", (event) => event.publicPayload.labId === labOne));
    const next = base.at(-1)!.sequence;
    const view = analyzeRun([
      ...base,
      makeEvent(next + 1, {
        type: "lab_telemetry",
        actor: "lab_engineer",
        publicPayload: {
          labId: labOne,
          elapsedMs: 4200,
          cpuPercent: 87.5,
          memoryBytes: 512 * 1024 * 1024,
          memoryLimitBytes: 2048 * 1024 * 1024,
          pids: 9,
          limits: { cpus: 2, pids: 256 },
        },
      }),
      makeEvent(next + 2, {
        type: "lab_output",
        actor: "lab_engineer",
        status: "warning",
        publicPayload: { labId: labOne, droppedLines: 1200 },
      }),
      makeEvent(next + 3, { type: "lab_cancel", actor: "lab_engineer", publicPayload: { labId: labOne } }),
    ]);
    const lab = view.labs.find((item) => item.labId === labOne)!;
    expect(lab.telemetry.at(-1)).toMatchObject({ cpuPercent: 87.5, pids: 9, cpuLimit: 2, pidLimit: 256 });
    expect(lab.serverDroppedLines).toBe(1200);
    expect(lab.cancelRequested).toBe(true);
    expect(view.cancelling).toBe(true);
  });
});

describe("analyzeRun: older recordings", () => {
  it("shows one card per role for a recording made before separate agents", () => {
    const view = analyzeRun(recorded as RunEvent[]);
    expect(view.native).toBe(false);
    expect(view.cards.map((card) => [card.role, card.status])).toEqual([
      ["paper_analyst", "done"],
      ["code_analyst", "done"],
      ["lead_researcher", "done"],
      ["lab_engineer", "done"],
      ["result_verifier", "done"],
    ]);
    expect(view.cards.find((card) => card.role === "code_analyst")!.warnings).toBe(1);
    expect(view.labs).toHaveLength(1);
    expect(view.labs[0]!.current?.text).toMatch(/python runner\.py --training data\/training\.csv/u);
    expect(view.labs[0]!.telemetry.length).toBeGreaterThanOrEqual(2);
  });
});

describe("formatElapsed", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatElapsed(42_000)).toBe("0:42");
    expect(formatElapsed(185_000)).toBe("3:05");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(last).toBeGreaterThan(90);
  });
});
