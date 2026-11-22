import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSubstitutions, tapeFromEnv } from "./tape-files.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("record and replay settings", () => {
  it("reads from=>to pairs and refuses a malformed one", () => {
    expect(parseSubstitutions(" 81.66=>77.66 ; 1 pp=>2 pp ")).toEqual([
      { from: "81.66", to: "77.66" },
      { from: "1 pp", to: "2 pp" },
    ]);
    expect(parseSubstitutions("")).toEqual([]);
    expect(() => parseSubstitutions("81.66")).toThrow(/not a from=>to pair/u);
  });

  it("is off unless asked, and a replay needs a directory for its output", () => {
    expect(tapeFromEnv({})).toBeUndefined();
    expect(() => tapeFromEnv({ DEJAML_REPLAY_TAPE: "x.jsonl" })).toThrow(/needs DEJAML_TAPE_DIR/u);
  });

  it("records to <runId>.tape.jsonl and replays with the comparison in <runId>.replay.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dejaml-tape-"));
    dirs.push(dir);
    const record = tapeFromEnv({ DEJAML_TAPE_DIR: dir })!("run_a");
    const agent = record.forAgent({ runId: "run_a", agentId: "agt_a", role: "supervisor", label: "supervisor-verdict" });
    expect(readFileSync(join(dir, "run_a.tape.jsonl"), "utf8")).toContain('"kind":"agent"');
    expect(agent).toBeTruthy();
    const tapePath = join(dir, "recorded.jsonl");
    writeFileSync(tapePath, readFileSync(join(dir, "run_a.tape.jsonl")));
    const replay = tapeFromEnv({ DEJAML_TAPE_DIR: dir, DEJAML_REPLAY_TAPE: tapePath })!("run_b");
    replay.forAgent({ runId: "run_b", agentId: "agt_b", role: "lab_engineer", label: "engineer-1" });
    const report = JSON.parse(readFileSync(join(dir, "run_b.replay.json"), "utf8")) as { divergences: Array<{ kind: string }> };
    expect(report.divergences.map((item) => item.kind)).toContain("unrecorded_agent");
  });
});
