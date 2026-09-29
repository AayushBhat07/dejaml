import type { RunEvent } from "@dejaml/contracts";

export type LaneStatus = "waiting" | "working" | "done" | "failed";

export type Lane = {
  actor: RunEvent["actor"];
  status: LaneStatus;
  warnings: number;
  events: RunEvent[];
  latest: RunEvent | null;
};

/**
 * Summarizes one research role from the public event stream. A role is done
 * when its last terminal event completed, failed when it failed, and working
 * between its first event and a terminal one.
 */
export function laneFor(events: readonly RunEvent[], actor: RunEvent["actor"]): Lane {
  const own = events.filter((event) => event.actor === actor);
  const latest = own.at(-1) ?? null;
  const warnings = own.filter((event) => event.status === "warning").length;
  let status: LaneStatus = own.length === 0 ? "waiting" : "working";
  for (const event of own) {
    if (event.status === "failed") status = "failed";
    else if (event.status === "completed" && status !== "failed") status = "done";
    else if (event.status === "started" && status !== "failed") status = "working";
  }
  return { actor, status, warnings, events: own, latest };
}

/** True when both analysts were working at the same moment somewhere in the stream. */
export function analystsOverlapped(events: readonly RunEvent[]): boolean {
  const active = new Set<string>();
  for (const event of events) {
    if (event.actor !== "paper_analyst" && event.actor !== "code_analyst") continue;
    if (event.status === "completed" || event.status === "failed") active.delete(event.actor);
    else active.add(event.actor);
    if (active.size === 2) return true;
  }
  return false;
}
