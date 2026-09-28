import { AssessmentSchema, type Assessment, type RunEvent } from "@dejaml/contracts";

import type { ReplaySource } from "./run-client";

export type LabPhase = "waiting" | "preparing" | "running" | "finished" | "failed" | "timed_out" | "cancelled";

export type TerminalLine = { stream: "stdout" | "stderr"; text: string; key: string };

export type TelemetrySample = {
  elapsedMs: number;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  pids: number;
  cpuLimit: number;
  pidLimit: number;
};

export type LabView = {
  phase: LabPhase;
  image: string | null;
  isolation: { network: string; readOnlyRoot: boolean; cpus: number; memoryMb: number; pids: number; timeoutSeconds: number } | null;
  command: { executable: string; args: string[]; cwd: string } | null;
  lines: TerminalLine[];
  heldBackLines: number;
  telemetry: TelemetrySample[];
  artifacts: Array<{ path: string; bytes: number; sha256: string | null }>;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string | null;
  cleanup: { clean: boolean; summary: string } | null;
};

/** Maximum terminal lines kept on screen; the full bounded log is in the report. */
export const MAX_TERMINAL_LINES = 500;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function labViewFor(events: readonly RunEvent[]): LabView {
  const view: LabView = {
    phase: "waiting",
    image: null,
    isolation: null,
    command: null,
    lines: [],
    heldBackLines: 0,
    telemetry: [],
    artifacts: [],
    exitCode: null,
    durationMs: null,
    startedAt: null,
    cleanup: null,
  };
  const artifacts = new Map<string, { path: string; bytes: number; sha256: string | null }>();

  for (const event of events) {
    if (event.actor !== "lab_engineer") continue;
    const payload = record(event.publicPayload);
    switch (event.type) {
      case "lab_create": {
        if (event.status === "started") view.phase = "preparing";
        if (event.status === "failed") view.phase = "failed";
        if (event.status === "completed") {
          const resources = record(payload.resources);
          view.image = typeof payload.image === "string" ? payload.image : null;
          view.isolation = {
            network: String(payload.network ?? "none"),
            readOnlyRoot: payload.readOnlyRoot === true,
            cpus: num(resources.cpus) ?? 0,
            memoryMb: num(resources.memoryMb) ?? 0,
            pids: num(resources.pids) ?? 0,
            timeoutSeconds: num(resources.timeoutSeconds) ?? 0,
          };
        }
        break;
      }
      case "attempt": {
        if (event.status === "started") {
          view.phase = "running";
          view.startedAt = event.timestamp;
          view.command = {
            executable: String(payload.executable ?? ""),
            args: Array.isArray(payload.args) ? payload.args.map(String) : [],
            cwd: String(payload.cwd ?? ""),
          };
        } else {
          view.exitCode = num(payload.exitCode);
          view.durationMs = num(payload.durationMs);
          view.phase =
            payload.timedOut === true
              ? "timed_out"
              : payload.cancelled === true
                ? "cancelled"
                : event.status === "completed"
                  ? "finished"
                  : "failed";
          if (Array.isArray(payload.artifacts)) {
            for (const item of payload.artifacts.map(record)) {
              const path = String(item.path ?? "");
              artifacts.set(path, { path, bytes: num(item.bytes) ?? 0, sha256: typeof item.sha256 === "string" ? item.sha256 : null });
            }
          }
        }
        break;
      }
      case "lab_output": {
        if (event.status === "warning") {
          view.heldBackLines += num(payload.droppedLines) ?? 0;
          break;
        }
        const stream = payload.stream === "stderr" ? "stderr" : "stdout";
        const lines = Array.isArray(payload.lines) ? payload.lines.map(String) : [];
        lines.forEach((text, index) => view.lines.push({ stream, text, key: `${event.sequence}:${index}` }));
        break;
      }
      case "lab_telemetry": {
        const limits = record(payload.limits);
        view.telemetry.push({
          elapsedMs: num(payload.elapsedMs) ?? 0,
          cpuPercent: num(payload.cpuPercent) ?? 0,
          memoryBytes: num(payload.memoryBytes) ?? 0,
          memoryLimitBytes: num(payload.memoryLimitBytes) ?? (num(limits.memoryMb) ?? 0) * 1024 * 1024,
          pids: num(payload.pids) ?? 0,
          cpuLimit: num(limits.cpus) ?? 1,
          pidLimit: num(limits.pids) ?? 0,
        });
        break;
      }
      case "artifact_changed": {
        const path = String(payload.path ?? "");
        artifacts.set(path, { path, bytes: num(payload.bytes) ?? 0, sha256: artifacts.get(path)?.sha256 ?? null });
        break;
      }
      case "lab_cleanup":
        view.cleanup = { clean: event.status === "completed", summary: event.summary };
        break;
      case "lab_cancel":
        break;
      default:
        break;
    }
  }
  if (view.lines.length > MAX_TERMINAL_LINES) {
    view.heldBackLines += view.lines.length - MAX_TERMINAL_LINES;
    view.lines = view.lines.slice(-MAX_TERMINAL_LINES);
  }
  view.artifacts = [...artifacts.values()];
  return view;
}

export type AuditSummary = {
  verdict: "confirmed" | "uncertain" | "disputed";
  metricAligned: boolean;
  summary: string;
  concerns: string[];
};

export type Findings = {
  assessment: Assessment;
  unit: "fraction" | "percent" | "score";
  summary: string;
  audit: AuditSummary | null;
};

export function findingsFor(events: readonly RunEvent[]): Findings | null {
  const completed = [...events]
    .reverse()
    .find((event) => event.actor === "result_verifier" && event.type === "comparison_completed");
  if (!completed) return null;
  const payload = record(completed.publicPayload);
  const parsed = AssessmentSchema.safeParse(payload.assessment);
  if (!parsed.success) return null;
  const unit = payload.unit === "fraction" || payload.unit === "score" ? payload.unit : "percent";

  const auditEvent = [...events]
    .reverse()
    .find((event) => event.actor === "audit_agent" && event.type === "audit_completed");
  let audit: AuditSummary | null = null;
  if (auditEvent) {
    const ap = record(auditEvent.publicPayload);
    const ar = ap.audit && typeof ap.audit === "object" ? (ap.audit as Record<string, unknown>) : null;
    if (ar && (ar.verdict === "confirmed" || ar.verdict === "uncertain" || ar.verdict === "disputed")) {
      audit = {
        verdict: ar.verdict,
        metricAligned: ar.metricAligned === true,
        summary: typeof ar.summary === "string" ? ar.summary : auditEvent.summary,
        concerns: Array.isArray(ar.concerns) ? (ar.concerns as string[]) : [],
      };
    }
  }

  return { assessment: parsed.data, unit, summary: completed.summary, audit };
}

/** A self-contained JSON report built from the public event stream. */
export function buildReport(runId: string, events: readonly RunEvent[], replay: ReplaySource | null) {
  const findings = findingsFor(events);
  const lab = labViewFor(events);
  return {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    source:
      replay === null
        ? "live run"
        : replay.kind === "recorded"
          ? `recorded run ${replay.runId} from ${replay.recordedAt}, replayed (nothing was executed now)`
          : "example replay (nothing was executed)",
    verdict: findings?.assessment.verdict ?? null,
    summary: findings?.summary ?? null,
    assessment: findings?.assessment ?? null,
    lab: {
      image: lab.image,
      isolation: lab.isolation,
      command: lab.command,
      exitCode: lab.exitCode,
      durationMs: lab.durationMs,
      artifacts: lab.artifacts,
      cleanup: lab.cleanup,
    },
    events,
  };
}
