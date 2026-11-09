import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseTape, recordingTape, replayTape, type RunTape } from "@dejaml/agent-runtime";

/**
 * Record and replay from the environment (sub-phase 6.9).
 *
 * - `DEJAML_TAPE_DIR`: write every study's sessions to `<dir>/<runId>.tape.jsonl`.
 * - `DEJAML_REPLAY_TAPE`: replay that recorded tape against every new study, and write the comparison to
 *   `<dir>/<runId>.replay.json` as it goes (the new run is recorded too).
 * - `DEJAML_REPLAY_SUBSTITUTE`: the intended differences, `from=>to` pairs separated by `;`
 *   (for example `81.66=>77.66`). Unset, the replay is the nothing-changed check.
 */
export function tapeFromEnv(env: NodeJS.ProcessEnv): ((runId: string) => RunTape) | undefined {
  const dir = env.DEJAML_TAPE_DIR;
  const replayFrom = env.DEJAML_REPLAY_TAPE;
  if (!dir && !replayFrom) return undefined;
  if (!dir) throw new Error("DEJAML_REPLAY_TAPE needs DEJAML_TAPE_DIR for the new tape and the comparison");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const substitutions = parseSubstitutions(env.DEJAML_REPLAY_SUBSTITUTE ?? "");
  const recorded = replayFrom ? parseTape(readFileSync(replayFrom, "utf8")) : null;
  return (runId) => {
    const sink = (entry: unknown): void => appendFileSync(join(dir, `${runId}.tape.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (!recorded) return recordingTape(sink);
    return replayTape(recorded, {
      substitutions,
      sink,
      onReport: (report) => writeFileSync(join(dir, `${runId}.replay.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }),
    });
  };
}

export function parseSubstitutions(text: string): Array<{ from: string; to: string }> {
  return text
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [from, to, ...rest] = pair.split("=>");
      if (!from || to === undefined || rest.length) throw new Error(`DEJAML_REPLAY_SUBSTITUTE: "${pair}" is not a from=>to pair`);
      return { from, to };
    });
}
