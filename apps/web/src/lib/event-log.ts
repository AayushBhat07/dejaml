import type { RunEvent } from "@dejaml/contracts";

/**
 * The client's copy of one run's event stream. Events are kept in sequence
 * order and each sequence is kept once, whatever order or how often the
 * stream delivers them (a reconnect may replay events the page already has).
 *
 * Terminal output is the only part of a stream that can grow without bound,
 * so live output lines are capped per lab: the oldest lines are dropped and
 * counted, and the page says how many it no longer shows. The full bounded
 * log stays on the server and in the report.
 */
export type EventLog = {
  events: RunEvent[];
  /** Highest sequence seen; the next subscription resumes after it. */
  lastSequence: number;
  /** Output lines this page dropped to stay within its memory budget, by lab. */
  droppedOutputLines: Record<string, number>;
  /** Resource samples dropped (only the newest are kept), by lab. */
  droppedTelemetry: Record<string, number>;
  /** Every sequence received, including events later dropped for memory, so a replay never adds one twice. */
  seen: ReadonlySet<number>;
};

/** Live output lines kept per lab on this page. */
export const MAX_OUTPUT_LINES_PER_LAB = 1_000;
/** Characters kept per output line. */
export const MAX_OUTPUT_LINE_CHARS = 2_000;
/** Resource samples kept per lab. */
export const MAX_TELEMETRY_PER_LAB = 120;

export const EMPTY_LOG: EventLog = { events: [], lastSequence: 0, droppedOutputLines: {}, droppedTelemetry: {}, seen: new Set() };

const labOf = (event: RunEvent): string => {
  const labId = event.publicPayload.labId;
  return typeof labId === "string" ? labId : "lab";
};

function boundLine(text: string): string {
  return text.length > MAX_OUTPUT_LINE_CHARS ? `${text.slice(0, MAX_OUTPUT_LINE_CHARS)} … [line shortened]` : text;
}

/** Bounds one output event's own lines before it is stored. */
function boundOutputEvent(event: RunEvent): { event: RunEvent; dropped: number } {
  const lines = event.publicPayload.lines;
  if (!Array.isArray(lines)) return { event, dropped: 0 };
  const kept = lines.slice(-MAX_OUTPUT_LINES_PER_LAB).map((line) => boundLine(String(line)));
  return { event: { ...event, publicPayload: { ...event.publicPayload, lines: kept } }, dropped: lines.length - kept.length };
}

const isOutput = (event: RunEvent): boolean => event.type === "lab_output" && event.status !== "warning";

/** Merges newly received events into the log: ordered, deduplicated, bounded. */
export function appendEvents(log: EventLog, incoming: readonly RunEvent[]): EventLog {
  const seen = new Set(log.seen);
  const fresh: RunEvent[] = [];
  const droppedOutputLines = { ...log.droppedOutputLines };
  const droppedTelemetry = { ...log.droppedTelemetry };
  for (const raw of incoming) {
    if (seen.has(raw.sequence)) continue;
    seen.add(raw.sequence);
    if (isOutput(raw)) {
      const bounded = boundOutputEvent(raw);
      if (bounded.dropped > 0) droppedOutputLines[labOf(raw)] = (droppedOutputLines[labOf(raw)] ?? 0) + bounded.dropped;
      fresh.push(bounded.event);
    } else {
      fresh.push(raw);
    }
  }
  if (fresh.length === 0) return log;

  const last = log.events.at(-1)?.sequence ?? -1;
  const inOrder = fresh.every((event, index) => event.sequence > (index === 0 ? last : fresh[index - 1]!.sequence));
  let events = inOrder ? [...log.events, ...fresh] : [...log.events, ...fresh].sort((a, b) => a.sequence - b.sequence);

  // Keep the newest output lines and telemetry samples of each lab; drop whole old events first.
  const outputLines = new Map<string, number>();
  const telemetry = new Map<string, number>();
  for (const event of events) {
    if (isOutput(event)) {
      const lab = labOf(event);
      outputLines.set(lab, (outputLines.get(lab) ?? 0) + (event.publicPayload.lines as unknown[]).length);
    } else if (event.type === "lab_telemetry") {
      telemetry.set(labOf(event), (telemetry.get(labOf(event)) ?? 0) + 1);
    }
  }
  const overflow = [...outputLines.values()].some((count) => count > MAX_OUTPUT_LINES_PER_LAB);
  const telemetryOverflow = [...telemetry.values()].some((count) => count > MAX_TELEMETRY_PER_LAB);
  if (overflow || telemetryOverflow) {
    const excessLines = new Map([...outputLines].map(([lab, count]) => [lab, Math.max(0, count - MAX_OUTPUT_LINES_PER_LAB)]));
    const excessSamples = new Map([...telemetry].map(([lab, count]) => [lab, Math.max(0, count - MAX_TELEMETRY_PER_LAB)]));
    const kept: RunEvent[] = [];
    for (const event of events) {
      const lab = labOf(event);
      if (isOutput(event) && (excessLines.get(lab) ?? 0) > 0) {
        const lines = event.publicPayload.lines as string[];
        const excess = excessLines.get(lab)!;
        const drop = Math.min(excess, lines.length);
        excessLines.set(lab, excess - drop);
        droppedOutputLines[lab] = (droppedOutputLines[lab] ?? 0) + drop;
        if (drop < lines.length) kept.push({ ...event, publicPayload: { ...event.publicPayload, lines: lines.slice(drop) } });
        continue;
      }
      if (event.type === "lab_telemetry" && (excessSamples.get(lab) ?? 0) > 0) {
        excessSamples.set(lab, excessSamples.get(lab)! - 1);
        droppedTelemetry[lab] = (droppedTelemetry[lab] ?? 0) + 1;
        continue;
      }
      kept.push(event);
    }
    events = kept;
  }
  return {
    events,
    lastSequence: Math.max(
      log.lastSequence,
      fresh.reduce((max, event) => Math.max(max, event.sequence), 0),
    ),
    droppedOutputLines,
    droppedTelemetry,
    seen,
  };
}
