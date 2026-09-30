import type { Claim } from "@dejaml/contracts";
import { describe, expect, it } from "vitest";

import type { CommandRecord, EngineerLab, ExportedArtifact } from "./context.js";
import type { Review, Submission } from "./roles.js";
import { applySupervisor, checkProvenance, decideStatus, type EngineerOutcome, runStatusFor } from "./verdict.js";

const SHA = "a".repeat(64);
const claim: Claim = {
  experimentLabel: "RF",
  dataset: "UCI",
  split: "test",
  model: "RF",
  metric: { name: "accuracy", unit: "percent", reportedValue: 81.66 },
  seed: null,
  hyperparameters: {},
  evidence: [{ kind: "paper_page", reference: "page 1", excerpt: "81.66" }],
  missingFields: [],
  confidence: "high",
};

function command(overrides: Partial<CommandRecord> = {}): CommandRecord {
  return {
    receiptId: "rcp_1",
    agentId: "agt_1",
    argv: ["python", "work/run.py"],
    cwd: "/workspace/case",
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    stdoutSha256: SHA,
    stderrSha256: SHA,
    stdoutExcerpt: "",
    stderrExcerpt: "",
    artifacts: [{ path: "artifacts/result.json", sha256: SHA, bytes: 30 }],
    stdoutTail: "",
    stderrTail: "",
    ...overrides,
  };
}

function lab(commands: CommandRecord[], written: Record<string, string> = { "work/run.py": "import runpy\nrunpy.run_path('repo/train.py')\n" }): EngineerLab {
  return {
    agentId: "agt_1",
    label: "engineer-1-1",
    labId: "lab_1",
    imageId: "sha256:x",
    commands,
    written: new Map(Object.entries(written).map(([path, content]) => [path, { sha256: SHA, content }])),
    artifacts: new Map(),
    environment: null,
    destroyed: true,
  };
}

const exported: ExportedArtifact[] = [{ path: "artifacts/result.json", sha256: SHA, bytes: 30, hostPath: "/x", text: '{"metrics":{"accuracyPercent":79.88}}' }];

const submission: Submission = {
  status: "measured",
  summary: "ran it",
  metricFile: "artifacts/result.json",
  metricKey: "metrics.accuracyPercent",
  unit: "percent",
  producingReceiptId: "rcp_1",
  officialCodeRan: true,
  officialCommands: ["python work/run.py"],
  adapters: [{ path: "work/run.py", why: "wrap", source: "repo/train.py", differences: [], changesEvidenceEquivalence: false }],
  deviations: [],
  failureReason: null,
};

const approve: Review = {
  verdict: "approve",
  equivalence: "equivalent",
  summary: "ok",
  checks: [
    { name: "a", passed: true, explanation: "x" },
    { name: "b", passed: true, explanation: "x" },
    { name: "c", passed: true, explanation: "x" },
  ],
  concerns: [],
};

function outcome(label: string, value: number | null, overrides: Partial<EngineerOutcome> = {}): EngineerOutcome {
  return {
    engineerAgentId: `agt_${label}`,
    label,
    agentStatus: "completed",
    agentReason: null,
    submission: { ...submission, adapters: [] },
    provenance: { ok: true, problems: [], warnings: [] },
    metricArtifact: exported[0]!,
    producingCommand: command(),
    rawValue: value,
    value,
    review: approve,
    reviewerAgentId: "agt_r",
    ...overrides,
  };
}

const within = (limit: number) => (item: EngineerOutcome) => ({ within: Math.abs((item.value ?? 0) - 81.66) <= limit, absoluteDifference: Math.abs((item.value ?? 0) - 81.66) });

describe("provenance", () => {
  it("accepts a metric written by the producing command and read from the exported file", () => {
    const result = checkProvenance({ submission, lab: lab([command()]), exported });
    expect(result).toMatchObject({ ok: true, rawValue: 79.88, problems: [] });
  });

  it("rejects a number typed into a command or a file the engineer wrote", () => {
    const typed = checkProvenance({
      submission,
      lab: lab([command({ argv: ["bash", "-c", "echo '{\"metrics\":{\"accuracyPercent\":79.88}}' > artifacts/result.json"] })]),
      exported,
    });
    expect(typed.ok).toBe(false);
    expect(typed.problems.join(" ")).toMatch(/appears literally/u);
    const inFile = checkProvenance({ submission, lab: lab([command()], { "work/run.py": "print(79.88)" }), exported });
    expect(inFile.ok).toBe(false);
  });

  it("rejects a failed producing command, a foreign receipt, a changed artifact, and undeclared adapters", () => {
    expect(checkProvenance({ submission, lab: lab([command({ exitCode: 1 })]), exported }).problems.join(" ")).toMatch(/exited with 1/u);
    expect(checkProvenance({ submission: { ...submission, producingReceiptId: "rcp_other" }, lab: lab([command()]), exported }).ok).toBe(false);
    expect(checkProvenance({ submission, lab: lab([command({ artifacts: [{ path: "artifacts/result.json", sha256: "b".repeat(64), bytes: 30 }] })]), exported }).problems.join(" ")).toMatch(/changed after/u);
    const undeclared = checkProvenance({ submission: { ...submission, adapters: [] }, lab: lab([command()]), exported });
    expect(undeclared.problems.join(" ")).toMatch(/undeclared files: work\/run.py/u);
  });

  it("refuses a submission that did not measure", () => {
    expect(checkProvenance({ submission: { ...submission, status: "not_measured" }, lab: lab([]), exported }).ok).toBe(false);
  });
});

describe("status decision", () => {
  const base = { claim, plan: null, engineersLaunched: 2, policyBlocks: [] };

  it("reproduced only when independent engineers agree, reviews are equivalent, and nothing was adapted", () => {
    const decision = decideStatus({ ...base, outcomes: [outcome("e1", 81.5), outcome("e2", 81.6)], compare: within(2) });
    expect(decision.status).toBe("reproduced");
    expect(decision.consensus?.status).toBe("agreed");
  });

  it("partially reproduced when an adapter or a relaxed dependency is involved", () => {
    const adapted = { submission };
    const decision = decideStatus({ ...base, outcomes: [outcome("e1", 81.5, adapted), outcome("e2", 81.6, adapted)], compare: within(2) });
    expect(decision.status).toBe("partially_reproduced");
  });

  it("not reproduced when the agreed value is outside tolerance", () => {
    const decision = decideStatus({ ...base, outcomes: [outcome("e1", 70), outcome("e2", 70.2)], compare: within(2) });
    expect(decision.status).toBe("not_reproduced");
  });

  it("never counts a not-equivalent review, a changed-evidence adapter, or a rejected review", () => {
    const notEquivalent = outcome("e1", 81.5, { review: { ...approve, equivalence: "not_equivalent" } });
    const changed = outcome("e2", 81.5, { submission: { ...submission, adapters: [{ ...submission.adapters[0]!, changesEvidenceEquivalence: true }] } });
    const rejected = outcome("e3", 81.5, { review: { ...approve, verdict: "reject" } });
    const decision = decideStatus({ ...base, engineersLaunched: 3, outcomes: [notEquivalent, changed, rejected], compare: within(2) });
    expect(decision.status).toBe("inconclusive");
    expect(decision.reasons).toHaveLength(3);
  });

  it("is inconclusive when engineers disagree or too few agree", () => {
    expect(decideStatus({ ...base, outcomes: [outcome("e1", 81.5), outcome("e2", 60)], compare: within(2) }).status).toBe("inconclusive");
    expect(decideStatus({ ...base, outcomes: [outcome("e1", 81.5), outcome("e2", null, { submission: null })], compare: within(2) }).status).toBe("inconclusive");
  });

  it("reports policy blocks when nothing was measured", () => {
    expect(decideStatus({ ...base, engineersLaunched: 0, outcomes: [], policyBlocks: ["dataset host not allowed"], compare: within(2) }).status).toBe("policy_blocked");
    expect(decideStatus({ ...base, claim: null, outcomes: [], compare: within(2) }).status).toBe("inconclusive");
  });

  it("lets the Supervisor only make the result more cautious", () => {
    expect(applySupervisor("reproduced", "partially_reproduced")).toEqual({ status: "partially_reproduced", overridden: true });
    expect(applySupervisor("inconclusive", "reproduced")).toEqual({ status: "inconclusive", overridden: false });
    expect(applySupervisor("not_reproduced", "reproduced")).toEqual({ status: "not_reproduced", overridden: false });
    expect(applySupervisor("partially_reproduced", "reproduced").status).toBe("partially_reproduced");
    expect(runStatusFor("policy_blocked")).toBe("inconclusive");
    expect(runStatusFor("not_reproduced")).toBe("completed");
  });
});
