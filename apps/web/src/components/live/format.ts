import { useEffect, useState } from "react";

import type { Tone } from "../Badge";
import type { AgentStatus } from "../../lib/live-run";

export function formatClock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

/** The current time, ticking once a second while `active`; elapsed times stop when the run ends. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export const AGENT_STATUS: Record<AgentStatus, { label: string; tone: Tone }> = {
  waiting: { label: "Waiting", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  using_tool: { label: "Using a tool", tone: "accent" },
  blocked: { label: "Blocked", tone: "warning" },
  reviewing: { label: "Reviewing", tone: "accent" },
  done: { label: "Done", tone: "positive" },
  failed: { label: "Failed", tone: "negative" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** A metric value as the dashboard shows it: four decimals at most, with % for percent. */
export function formatMetricValue(value: number | null, unit: string | null): string {
  if (value === null) return "–";
  const rounded = Math.round(value * 10_000) / 10_000;
  return unit === "percent" ? `${rounded}%` : String(rounded);
}

/** A 64-hex commitment shortened for display; the full value goes in a title. */
export function shortHash(value: string): string {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

export function formatNumber(value: number): string {
  return value >= 10_000 ? `${(value / 1000).toFixed(0)}k` : value >= 1_000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}
