import { RunEventSchema, type RunEvent } from "@dejaml/contracts";

import recordedRun from "../../../../fixtures/events/urban-land-cover-success.json";
import recordedRunMeta from "../../../../fixtures/events/urban-land-cover-success.meta.json";

export type RunHandle = { runId: string };

/**
 * The model the agents use for one study: a provider and model the server
 * offers. Keys live only in the server's environment; the browser never sends one.
 */
export type ModelSettings = { providerId: string; model: string };

export type StudyOptions = {
  model?: ModelSettings;
  /** A GitHub repository to use when the paper does not link one. */
  repositoryUrl?: string;
  /**
   * A reviewed case on this server, by id only. The server holds the case's
   * claim, repository, and policy; the browser never sends a command, an
   * expected value, or any other part of a case.
   */
  reviewedCaseId?: string;
};

/** A provider the server's administrator configured with a server-held key. */
export type ProviderOption = { id: string; label: string; models: string[] };

/**
 * A reviewed case as the server publishes it: which paper and claim it covers
 * and whether it can run. Never the paper's reported value (it is sealed until
 * the run's observation and blind review are locked), its page or location, an
 * observed value, a tolerance, a command, or any policy detail.
 */
export type ReviewedCase = {
  caseId: string;
  title: string;
  paperTitle: string;
  /** SHA-256 of the exact PDF the case was reviewed against. */
  paperSha256: string;
  claim: {
    method: string;
    dataset: string;
    split: string;
    metric: { name: string; unit: "fraction" | "percent" | "score" };
  };
  repository: { url: string; commitSha: string };
  available: boolean;
};

export type ServerConfig = { providers: ProviderOption[]; reviewedCases?: ReviewedCase[] };

/** What the page knows about its live connection. */
export type ConnectionState = "connecting" | "live" | "reconnecting" | "closed";

/** Public facts about a run that are not in its events (the uploaded file's name). */
export type RunInfo = { fileName: string | null };

/** The report's blinding record: the sealed commitment and, once revealed, its verification. */
export type ReportBlinding = {
  sealed: boolean;
  revealed: boolean;
  commitment: string | null;
  sealedAt: string | null;
  /** The reveal recomputed the sealed commitment and it matched. */
  verified: boolean | null;
  observationVerified: boolean | null;
  comparison: {
    observed: number | null;
    reported: number | null;
    absoluteDelta: number | null;
    tolerance: number | null;
    withinTolerance: boolean | null;
    rule: string | null;
    blindVerdicts: string[];
  } | null;
  errors: string[];
};

/**
 * The parts of the server's final report the dashboard shows; read only after
 * the study finished. `paperValue`, `tolerance` and `signedDifference` are null
 * unless the report says the sealed target was revealed.
 */
export type ReportSummary = {
  /** The sealed target was revealed (and so the paper value may be shown). */
  revealed: boolean;
  blinding: ReportBlinding | null;
  paperValue: number | null;
  observedValue: number | null;
  signedDifference: number | null;
  tolerance: number | null;
  unit: "fraction" | "percent" | "score" | null;
  verdict: string | null;
  checks: Array<{ name: string; passed: boolean; explanation: string }>;
  hypotheses: string[];
  reviews: Array<{ engineer: string; verdict: string; equivalence: string | null; summary: string | null; concerns: string[] }>;
};

/** Where replayed events came from, so the UI can label them honestly. */
export type ReplaySource = { kind: "prepared" } | { kind: "recorded"; runId: string; recordedAt: string };

export function replaySourceFrom(meta: unknown): ReplaySource {
  const value = (meta ?? {}) as Record<string, unknown>;
  return value.source === "recorded" && typeof value.runId === "string" && typeof value.recordedAt === "string"
    ? { kind: "recorded", runId: value.runId, recordedAt: value.recordedAt }
    : { kind: "prepared" };
}

export type RunSubscription = {
  onEvent: (event: RunEvent) => void;
  onError?: (message: string) => void;
  /** Connection changes: connecting, live, reconnecting, or closed. */
  onStatus?: (state: ConnectionState) => void;
};

export interface RunClient {
  readonly mode: "live" | "replay";
  /** Set in replay mode. */
  readonly replaySource?: ReplaySource;
  createRun(paper: File, options?: StudyOptions): Promise<RunHandle>;
  /** What the server needs before a study can start; null in replay mode. */
  config?(): Promise<ServerConfig | null>;
  /** Replays events after `afterSequence`, then streams new ones. Returns an unsubscribe function. */
  subscribe(runId: string, afterSequence: number, subscription: RunSubscription): () => void;
  cancel(runId: string): Promise<void>;
  /** Server-generated report URL, or null when the report is built in the browser. */
  reportUrl(runId: string): string | null;
  /** The run's public facts (live mode). */
  runInfo?(runId: string): Promise<RunInfo | null>;
  /** Reads the finished study's report for the completion section (live mode). */
  reportSummary?(runId: string): Promise<ReportSummary | null>;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function summarizeBlinding(raw: unknown): ReportBlinding | null {
  if (!raw || typeof raw !== "object") return null;
  const blinding = record(raw);
  const reveal = blinding.reveal && typeof blinding.reveal === "object" ? record(blinding.reveal) : null;
  const comparison = blinding.comparison && typeof blinding.comparison === "object" ? record(blinding.comparison) : null;
  const revealed = blinding.revealed === true;
  return {
    sealed: blinding.sealed === true,
    revealed,
    commitment: text(blinding.commitment),
    sealedAt: text(blinding.sealedAt),
    verified: reveal ? bool(reveal.verified) : null,
    observationVerified: reveal ? bool(reveal.observationVerified) : null,
    // A comparison holds the paper value: read only once the report says it was revealed.
    comparison:
      revealed && comparison
        ? {
            observed: num(comparison.observed),
            reported: num(comparison.reported),
            absoluteDelta: num(comparison.absoluteDelta),
            tolerance: num(comparison.tolerance),
            withinTolerance: bool(comparison.withinTolerance),
            rule: text(comparison.rule),
            blindVerdicts: texts(comparison.blindVerdicts),
          }
        : null,
    errors: texts(blinding.errors),
  };
}

/**
 * Picks the public comparison fields from a server report; anything else in it
 * is ignored. The paper value, tolerance and difference are read only from a
 * report whose blinding section says the target was revealed.
 */
export function summarizeReport(raw: unknown): ReportSummary | null {
  const report = record(raw);
  if (Object.keys(report).length === 0) return null;
  const assessment = record(report.assessment);
  const study = record(report.study);
  const result = record(study.result);
  const unit = record(record(study.contract).metric).unit ?? record(report.metric).unit;
  const engineers = Array.isArray(study.engineers) ? study.engineers.map(record) : [];
  const blinding = summarizeBlinding(study.blinding);
  const revealed = blinding?.revealed === true;
  const paperValue = revealed ? (num(result.paperValue) ?? num(assessment.paperValue) ?? blinding.comparison?.reported ?? null) : null;
  const observedValue = num(result.observedValue) ?? num(assessment.observedValue);
  return {
    revealed,
    blinding,
    paperValue,
    observedValue,
    signedDifference:
      paperValue === null
        ? null
        : (num(assessment.signedDifference) ?? (observedValue !== null ? Math.round((observedValue - paperValue) * 1e6) / 1e6 : null)),
    tolerance: revealed ? (num(result.tolerance) ?? num(assessment.tolerance) ?? blinding.comparison?.tolerance ?? null) : null,
    unit: unit === "fraction" || unit === "percent" || unit === "score" ? unit : null,
    verdict: text(assessment.verdict),
    checks: (Array.isArray(assessment.checks) ? assessment.checks.map(record) : []).map((check) => ({
      name: String(check.name ?? ""),
      passed: check.passed === true,
      explanation: String(check.explanation ?? ""),
    })),
    hypotheses: (Array.isArray(assessment.discrepancyHypotheses) ? assessment.discrepancyHypotheses : []).filter(
      (item): item is string => typeof item === "string",
    ),
    reviews: engineers.flatMap((engineer) => {
      const review = record(engineer.review);
      if (typeof review.verdict !== "string") return [];
      return [
        {
          engineer: String(engineer.label ?? ""),
          verdict: review.verdict,
          equivalence: text(review.equivalence),
          summary: text(review.summary),
          concerns: (Array.isArray(review.concerns) ? review.concerns : []).filter((item): item is string => typeof item === "string"),
        },
      ];
    }),
  };
}

/** Reconnect delays after the browser gives up on a stream: 1 s, 2 s, 4 s, then at most 15 s. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** Talks to the Run API described in ARCHITECTURE.md section 6.2. */
export class HttpRunClient implements RunClient {
  readonly mode = "live" as const;
  readonly #base: string;

  constructor(base = "/api") {
    this.#base = base;
  }

  async config(): Promise<ServerConfig | null> {
    const response = await fetch(`${this.#base}/config`).catch(() => null);
    return response?.ok ? ((await response.json()) as ServerConfig) : null;
  }

  async createRun(paper: File, options: StudyOptions = {}): Promise<RunHandle> {
    const body = new FormData();
    body.append("paper", paper, paper.name);
    if (options.model) {
      body.append("providerId", options.model.providerId);
      body.append("modelName", options.model.model);
    }
    // A reviewed case names its own repository on the server; only its id is sent.
    if (options.reviewedCaseId) body.append("reviewedCaseId", options.reviewedCaseId);
    else if (options.repositoryUrl) body.append("repositoryUrl", options.repositoryUrl);
    const response = await fetch(`${this.#base}/runs`, { method: "POST", body });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `The server refused the paper (${response.status}).`);
    }
    const created = (await response.json()) as { runId?: unknown };
    if (typeof created.runId !== "string") throw new Error("The server did not return a run ID.");
    return { runId: created.runId };
  }

  /**
   * Streams a run's events over SSE. The server sends each event with its
   * sequence as the SSE id, so the browser's own reconnect resumes with
   * `Last-Event-ID`. If the browser gives up (the stream is closed for good),
   * the page opens a new stream with `?after=` the last sequence it received,
   * with backoff. An event at or below that sequence is never delivered twice.
   */
  subscribe(runId: string, afterSequence: number, subscription: RunSubscription): () => void {
    let last = afterSequence;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let stopped = false;
    const open = (): void => {
      if (stopped) return;
      subscription.onStatus?.(failures === 0 ? "connecting" : "reconnecting");
      const current = new EventSource(`${this.#base}/runs/${encodeURIComponent(runId)}/events?after=${last}`);
      source = current;
      current.onopen = () => {
        failures = 0;
        subscription.onStatus?.("live");
      };
      current.onmessage = (message: MessageEvent<string>) => {
        let data: unknown = null;
        try {
          data = JSON.parse(message.data);
        } catch {
          data = null;
        }
        const parsed = RunEventSchema.safeParse(data);
        if (!parsed.success) {
          subscription.onError?.("The server sent an event this page does not understand.");
          return;
        }
        if (parsed.data.sequence <= last) return;
        last = parsed.data.sequence;
        subscription.onEvent(parsed.data);
      };
      current.onerror = () => {
        if (stopped) return;
        subscription.onStatus?.("reconnecting");
        // CONNECTING: the browser retries by itself and sends Last-Event-ID. CLOSED: it gave up, so reopen after `last`.
        if (current.readyState !== EventSource.CLOSED) return;
        current.close();
        const delay = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)]!;
        failures += 1;
        retry = setTimeout(open, delay);
      };
    };
    open();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      source?.close();
      subscription.onStatus?.("closed");
    };
  }

  async cancel(runId: string): Promise<void> {
    await fetch(`${this.#base}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  }

  reportUrl(runId: string): string {
    return `${this.#base}/runs/${encodeURIComponent(runId)}/report`;
  }

  async runInfo(runId: string): Promise<RunInfo | null> {
    const response = await fetch(`${this.#base}/runs/${encodeURIComponent(runId)}`).catch(() => null);
    if (!response?.ok) return null;
    const snapshot = record(await response.json().catch(() => null));
    return { fileName: text(record(snapshot.input).fileName) };
  }

  async reportSummary(runId: string): Promise<ReportSummary | null> {
    const response = await fetch(this.reportUrl(runId)).catch(() => null);
    if (!response?.ok) return null;
    return summarizeReport(await response.json().catch(() => null));
  }
}

/**
 * Replays the recorded curated run from fixtures/events. The UI labels this
 * mode explicitly so a replay is never presented as a live experiment.
 */
export class ReplayRunClient implements RunClient {
  readonly mode = "replay" as const;
  readonly #events: RunEvent[];
  readonly #intervalMs: number;
  readonly #cancelled = new Set<string>();
  readonly #onCancel = new Map<string, () => void>();

  readonly replaySource: ReplaySource;

  constructor(intervalMs = 900, events: unknown = recordedRun, source: ReplaySource = replaySourceFrom(recordedRunMeta)) {
    this.#events = RunEventSchema.array().parse(events);
    this.#intervalMs = intervalMs;
    this.replaySource = source;
  }

  async createRun(_paper: File, _options?: StudyOptions): Promise<RunHandle> {
    return { runId: `replay_${Date.now().toString(36)}` };
  }

  subscribe(runId: string, afterSequence: number, subscription: RunSubscription): () => void {
    subscription.onStatus?.("live");
    const pending = this.#events.filter((event) => event.sequence > afterSequence);
    let index = 0;
    let lastSequence = afterSequence;
    const emit = (event: RunEvent) => {
      lastSequence = event.sequence;
      subscription.onEvent({ ...event, runId, timestamp: new Date().toISOString() });
    };
    const timer = setInterval(() => {
      const next = pending[index];
      if (!next || this.#cancelled.has(runId)) {
        clearInterval(timer);
        return;
      }
      index += 1;
      emit(next);
    }, this.#intervalMs);
    this.#onCancel.set(runId, () => {
      clearInterval(timer);
      const template = pending[0] ?? this.#events[0]!;
      const labStarted = pending.slice(0, index).some((event) => event.actor === "lab_engineer");
      // Mirrors what the Lab Manager emits when a running attempt is cancelled.
      const tail: Array<Pick<RunEvent, "type" | "status" | "summary" | "publicPayload">> = [
        { type: "lab_cancel", status: "progress", summary: "Cancellation requested", publicPayload: {} },
        ...(labStarted
          ? [
              {
                type: "attempt",
                status: "failed" as const,
                summary: "Attempt cancelled; the lab process tree was terminated",
                publicPayload: { cancelled: true, timedOut: false, exitCode: null },
              },
              { type: "lab_cleanup", status: "completed" as const, summary: "Disposable lab removed", publicPayload: {} },
            ]
          : []),
      ];
      for (const item of tail) {
        emit({
          ...template,
          ...item,
          id: `replay_cancel_${lastSequence + 1}`,
          sequence: lastSequence + 1,
          actor: "lab_engineer",
          evidence: [],
        });
      }
    });
    return () => {
      clearInterval(timer);
      this.#onCancel.delete(runId);
    };
  }

  async cancel(runId: string): Promise<void> {
    if (this.#cancelled.has(runId)) return;
    this.#cancelled.add(runId);
    this.#onCancel.get(runId)?.();
  }

  reportUrl(): null {
    return null;
  }
}

export function defaultRunClient(): RunClient {
  return import.meta.env.VITE_DEJAML_API === "live" ? new HttpRunClient() : new ReplayRunClient();
}
