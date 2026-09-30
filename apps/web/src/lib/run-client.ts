import { RunEventSchema, type RunEvent } from "@dejaml/contracts";

import recordedRun from "../../../../fixtures/events/urban-land-cover-success.json";
import recordedRunMeta from "../../../../fixtures/events/urban-land-cover-success.meta.json";

export type RunHandle = { runId: string };

/**
 * The model the agents use for one study: a provider and model the server
 * offers. An optional key is sent with the upload and kept only in memory.
 */
export type ModelSettings = { providerId: string; model: string; apiKey?: string };

export type StudyOptions = {
  model?: ModelSettings;
  /** A GitHub repository to use when the paper does not link one. */
  repositoryUrl?: string;
};

/** A provider the server's administrator configured. `uploader` means the study must bring a key. */
export type ProviderOption = { id: string; label: string; models: string[]; keySource: "server" | "uploader" };

export type ServerConfig = { providers: ProviderOption[] };

/** Where replayed events came from, so the UI can label them honestly. */
export type ReplaySource =
  | { kind: "prepared" }
  | { kind: "recorded"; runId: string; recordedAt: string };

export function replaySourceFrom(meta: unknown): ReplaySource {
  const value = (meta ?? {}) as Record<string, unknown>;
  return value.source === "recorded" && typeof value.runId === "string" && typeof value.recordedAt === "string"
    ? { kind: "recorded", runId: value.runId, recordedAt: value.recordedAt }
    : { kind: "prepared" };
}

export type RunSubscription = {
  onEvent: (event: RunEvent) => void;
  onError?: (message: string) => void;
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
}

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
      if (options.model.apiKey) body.append("apiKey", options.model.apiKey);
    }
    if (options.repositoryUrl) body.append("repositoryUrl", options.repositoryUrl);
    const response = await fetch(`${this.#base}/runs`, { method: "POST", body });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `The server refused the paper (${response.status}).`);
    }
    const created = (await response.json()) as { runId?: unknown };
    if (typeof created.runId !== "string") throw new Error("The server did not return a run ID.");
    return { runId: created.runId };
  }

  subscribe(runId: string, afterSequence: number, subscription: RunSubscription): () => void {
    const source = new EventSource(
      `${this.#base}/runs/${encodeURIComponent(runId)}/events?after=${afterSequence}`,
    );
    source.onmessage = (message: MessageEvent<string>) => {
      const parsed = RunEventSchema.safeParse(JSON.parse(message.data));
      if (parsed.success) subscription.onEvent(parsed.data);
      else subscription.onError?.("The server sent an event this page does not understand.");
    };
    source.onerror = () => subscription.onError?.("Lost the live connection. Reconnecting…");
    return () => source.close();
  }

  async cancel(runId: string): Promise<void> {
    await fetch(`${this.#base}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  }

  reportUrl(runId: string): string {
    return `${this.#base}/runs/${encodeURIComponent(runId)}/report`;
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
