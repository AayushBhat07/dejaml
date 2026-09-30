import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, normalize, resolve, sep } from "node:path";

/**
 * Deployment boundaries (docs/AWS_DEPLOYMENT_DESIGN.md). The API talks to
 * these interfaces only; the local implementations below run everything in
 * one process for development. A cloud deployment replaces them (SQS jobs,
 * S3 artifacts, Secrets Manager) without changing the orchestrator. Lab
 * creation is behind `LabWorker` in @dejaml/lab-manager.
 */

/** One unit of work for a worker: a new study or the resumption of a saved one. */
export type Job = {
  runId: string;
  kind: "study" | "resume";
  run(signal: AbortSignal): Promise<void>;
};

export type JobDispatcher = {
  /** Starts the job now, or returns false when no worker is free (the API answers 409). */
  submit(job: Job): boolean;
  /** Waits for a free worker, then runs the job to its end. */
  enqueue(job: Job): Promise<void>;
  /** Signals the job's cancellation; false when it is not running. */
  cancel(runId: string): boolean;
  /** Resolves when no job is running. */
  idle(): Promise<void>;
  /** Cancels every running job and waits for them to stop. */
  close(): Promise<void>;
};

/** One job at a time in this process (ARCHITECTURE.md §17: no parallel labs on one host). */
export class InProcessJobDispatcher implements JobDispatcher {
  #active: Promise<void> | null = null;
  readonly #controllers = new Map<string, AbortController>();

  submit(job: Job): boolean {
    if (this.#active) return false;
    this.#start(job);
    return true;
  }

  async enqueue(job: Job): Promise<void> {
    while (this.#active) await this.#active;
    await this.#start(job);
  }

  cancel(runId: string): boolean {
    const controller = this.#controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async idle(): Promise<void> {
    while (this.#active) await this.#active;
  }

  async close(): Promise<void> {
    for (const controller of this.#controllers.values()) controller.abort();
    await this.idle();
  }

  #start(job: Job): Promise<void> {
    const controller = new AbortController();
    this.#controllers.set(job.runId, controller);
    const running = job
      .run(controller.signal)
      .catch(() => undefined)
      .finally(() => {
        this.#controllers.delete(job.runId);
        if (this.#active === running) this.#active = null;
      });
    this.#active = running;
    return running;
  }
}

/** Where exported lab artifacts are kept after a lab is destroyed. */
export type ArtifactStore = {
  put(input: { runId: string; scope: string; path: string; content: Buffer }): Promise<{ uri: string; sha256: string; bytes: number }>;
};

/** Files under a private directory, one folder per run and scope. */
export class LocalArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async put(input: {
    runId: string;
    scope: string;
    path: string;
    content: Buffer;
  }): Promise<{ uri: string; sha256: string; bytes: number }> {
    const base = resolve(this.root, input.runId, input.scope);
    const target = resolve(base, normalize(input.path));
    if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error(`artifact path ${input.path} escapes its directory`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, input.content, { mode: 0o600 });
    return { uri: target, sha256: createHash("sha256").update(input.content).digest("hex"), bytes: input.content.byteLength };
  }
}

/** Server-side secrets, read by name; values are never logged, returned, or persisted. */
export type SecretProvider = {
  get(name: string): string | undefined;
};

/** Secrets from the process environment (development and single-host deployments). */
export function environmentSecrets(env: Record<string, string | undefined>): SecretProvider {
  return { get: (name) => env[name] };
}

/**
 * The provider configuration's view of the environment: settings from `env`,
 * keys from the secret provider. Only the three key names are ever read.
 */
export function withSecrets(env: Record<string, string | undefined>, secrets: SecretProvider): Record<string, string | undefined> {
  const merged = { ...env };
  for (const name of ["DEJAML_OPENAI_API_KEY", "DEJAML_ANTHROPIC_API_KEY", "DEJAML_CUSTOM_API_KEY"]) {
    const value = secrets.get(name);
    if (value === undefined) delete merged[name];
    else merged[name] = value;
  }
  return merged;
}
