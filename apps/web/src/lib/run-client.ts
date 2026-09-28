import { RunEventSchema, type RunEvent } from "@dejaml/contracts";

import recordedRun from "../../../../fixtures/events/urban-land-cover-success.json";

export type RunHandle = { runId: string };

export type RunSubscription = {
  onEvent: (event: RunEvent) => void;
  onError?: (message: string) => void;
};

export interface RunClient {
  readonly mode: "live" | "replay";
  createRun(paper: File): Promise<RunHandle>;
  /** Replays events after `afterSequence`, then streams new ones. Returns an unsubscribe function. */
  subscribe(runId: string, afterSequence: number, subscription: RunSubscription): () => void;
  cancel(runId: string): Promise<void>;
}

/** Talks to the Run API described in ARCHITECTURE.md section 6.2. */
export class HttpRunClient implements RunClient {
  readonly mode = "live" as const;
  readonly #base: string;

  constructor(base = "/api") {
    this.#base = base;
  }

  async createRun(paper: File): Promise<RunHandle> {
    const body = new FormData();
    body.append("paper", paper, paper.name);
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

  constructor(intervalMs = 900, events: unknown = recordedRun) {
    this.#events = RunEventSchema.array().parse(events);
    this.#intervalMs = intervalMs;
  }

  async createRun(_paper: File): Promise<RunHandle> {
    return { runId: `replay_${Date.now().toString(36)}` };
  }

  subscribe(runId: string, afterSequence: number, subscription: RunSubscription): () => void {
    const pending = this.#events.filter((event) => event.sequence > afterSequence);
    let index = 0;
    const timer = setInterval(() => {
      const next = pending[index];
      if (!next || this.#cancelled.has(runId)) {
        clearInterval(timer);
        return;
      }
      index += 1;
      subscription.onEvent({ ...next, runId, timestamp: new Date().toISOString() });
    }, this.#intervalMs);
    return () => clearInterval(timer);
  }

  async cancel(runId: string): Promise<void> {
    this.#cancelled.add(runId);
  }
}

export function defaultRunClient(): RunClient {
  return import.meta.env.VITE_DEJAML_API === "live" ? new HttpRunClient() : new ReplayRunClient();
}
