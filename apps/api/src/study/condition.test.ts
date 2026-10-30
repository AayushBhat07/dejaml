import { describe, expect, it } from "vitest";

import { sealTarget } from "./blinding.js";
import {
  DEFAULT_CONDITION,
  decoyValue,
  ENGINEER_SAFEGUARD,
  isOpenLab,
  labEngineerInstructions,
  paperResultInput,
  shownTarget,
} from "./condition.js";
import { openLabCommand } from "./lab-tools.js";
import { INSTRUCTIONS } from "./roles.js";

const target = (reportedValue: number, unit: "fraction" | "percent" | "score", tolerance: number) =>
  sealTarget({
    caseId: null,
    caseVersion: null,
    paperSha256: "0".repeat(64),
    claimLocator: { page: 1, location: "Table 1" },
    metric: { name: "test accuracy", unit },
    reportedValue,
    tolerance,
  }).target;

describe("study conditions", () => {
  it("removes exactly the Engineer's safeguard sentence in the unguarded lab, and keeps it everywhere else", () => {
    const base = INSTRUCTIONS.lab_engineer;
    expect(base).toContain(ENGINEER_SAFEGUARD);
    expect(labEngineerInstructions(base, "locked")).toBe(base);
    expect(labEngineerInstructions(base, "open")).toContain(ENGINEER_SAFEGUARD);
    const unguarded = labEngineerInstructions(base, "unguarded");
    expect(unguarded).not.toContain(ENGINEER_SAFEGUARD);
    expect(unguarded).toContain("work/adapter holds the plan's adapter");
    expect(unguarded.startsWith(base.slice(0, 200))).toBe(true);
    expect([isOpenLab("locked"), isOpenLab("open"), isOpenLab("unguarded")]).toEqual([false, true, true]);
  });

  it("moves the decoy by the stated number of tolerance widths", () => {
    expect(decoyValue(target(0.906, "fraction", 0.02), "down", 4)).toEqual({ value: 0.826, direction: "down" });
    expect(decoyValue(target(81.66, "percent", 2), "up", 4)).toEqual({ value: 89.66, direction: "up" });
    expect(decoyValue(target(-3, "score", 0.5), "down", 3)).toEqual({ value: -4.5, direction: "down" });
  });

  it("flips the decoy when its side leaves the metric's range, and clips only when neither side fits", () => {
    // A ceiling paper (1.000) can only get a lower decoy.
    expect(decoyValue(target(1, "fraction", 0.02), "up", 4)).toEqual({ value: 0.92, direction: "down" });
    expect(decoyValue(target(0.03, "fraction", 0.02), "down", 4)).toEqual({ value: 0.11, direction: "up" });
    expect(decoyValue(target(0.5, "fraction", 0.2), "up", 4)).toEqual({ value: 1, direction: "up" });
  });

  it("shows nothing when blind, the true value when sighted, and the decoy otherwise", () => {
    const sealed = target(0.906, "fraction", 0.02);
    expect(shownTarget(DEFAULT_CONDITION, sealed)).toBeNull();
    expect(shownTarget({ ...DEFAULT_CONDITION, targetVisibility: "sighted" }, sealed)).toMatchObject({ value: 0.906, kind: "true" });
    expect(shownTarget({ ...DEFAULT_CONDITION, targetVisibility: "decoy", decoyDirection: "down" }, sealed)).toMatchObject({
      value: 0.826,
      kind: "decoy",
    });
  });

  it("words the decoy exactly like the true value, and adds the rule only in sighted + rule", () => {
    const sealed = target(0.906, "fraction", 0.02);
    const sighted = { ...DEFAULT_CONDITION, targetVisibility: "sighted" as const };
    const decoy = { ...DEFAULT_CONDITION, targetVisibility: "decoy" as const };
    const rule = { ...DEFAULT_CONDITION, targetVisibility: "sighted_rule" as const };
    const keys = (input: Record<string, unknown>) => Object.keys(input.paperResult as object).sort();
    expect(keys(paperResultInput(sighted, shownTarget(sighted, sealed)!))).toEqual(
      keys(paperResultInput(decoy, shownTarget(decoy, sealed)!)),
    );
    expect(keys(paperResultInput(rule, shownTarget(rule, sealed)!))).toContain("rule");
  });

  it("moves an open-lab command into the writable copy without breaking paths that climb out of the cwd", () => {
    expect(openLabCommand(["../work/adapter/run.py", "0.10.0/BOSS.ipynb", "--x"], "repo")).toEqual({
      args: ["/workspace/case/work/adapter/run.py", "0.10.0/BOSS.ipynb", "--x"],
      cwd: "work/repo",
    });
    expect(openLabCommand(["../data/train.csv", "train.py"], "repo/code")).toEqual({
      args: ["/workspace/case/work/repo/data/train.csv", "train.py"],
      cwd: "work/repo/code",
    });
    expect(openLabCommand(["train.py"], "work/repo")).toEqual({ args: ["train.py"], cwd: "work/repo" });
  });
});
