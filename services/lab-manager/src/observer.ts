import { lstat, readdir } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";

import type { OutputStream } from "./runtime.js";

export type ObserveOptions = {
  /** How often buffered output lines are published. */
  flushIntervalMs?: number;
  /** Minimum spacing between published CPU/RAM telemetry samples. */
  telemetryIntervalMs?: number;
  /** How often the artifact directory is checked for changes. */
  artifactIntervalMs?: number;
  maxLinesPerEvent?: number;
  maxLineChars?: number;
  /** Total output characters published per attempt; the full bounded log stays in the attempt outcome. */
  maxPublishedChars?: number;
};

export const DEFAULT_OBSERVE_OPTIONS: Required<ObserveOptions> = {
  flushIntervalMs: 250,
  telemetryIntervalMs: 1_000,
  artifactIntervalMs: 500,
  maxLinesPerEvent: 50,
  maxLineChars: 400,
  maxPublishedChars: 64 * 1024,
};

export type OutputBatch = {
  stream: OutputStream;
  lines: string[];
  truncatedLines: number;
};

// CSI/OSC escape sequences and remaining C0/C1 controls except tab.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** Makes untrusted terminal output safe to display as plain text. */
export function sanitizeLine(line: string, maxChars: number): { text: string; truncated: boolean } {
  const withoutCarriageReturns = line.includes("\r") ? (line.split("\r").at(-1) ?? "") : line;
  const clean = withoutCarriageReturns.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
  if (clean.length <= maxChars) return { text: clean, truncated: false };
  return { text: `${clean.slice(0, maxChars)}…`, truncated: true };
}

/**
 * Splits streamed chunks into complete, sanitized lines and releases them in
 * bounded batches. Publishing stops at a character budget; one final notice
 * records that the public view was cut off.
 */
export class OutputBatcher {
  readonly #options: Required<ObserveOptions>;
  readonly #partial: Record<OutputStream, string> = { stdout: "", stderr: "" };
  readonly #pending: Record<OutputStream, string[]> = { stdout: [], stderr: [] };
  readonly #truncatedLines: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
  #publishedChars = 0;
  #limitReached = false;
  #droppedLines = 0;

  constructor(options: Required<ObserveOptions>) {
    this.#options = options;
  }

  get limitReached(): boolean {
    return this.#limitReached;
  }

  get droppedLines(): number {
    return this.#droppedLines;
  }

  push(stream: OutputStream, chunk: string): void {
    const text = this.#partial[stream] + chunk;
    const parts = text.split("\n");
    this.#partial[stream] = parts.pop() ?? "";
    // A runaway line without newlines must not grow without bound.
    if (this.#partial[stream].length > this.#options.maxLineChars * 4) {
      parts.push(this.#partial[stream]);
      this.#partial[stream] = "";
    }
    for (const part of parts) this.#accept(stream, part);
  }

  /** Returns the batches ready to publish. `final` also releases incomplete trailing lines. */
  drain(final = false): OutputBatch[] {
    if (final) {
      for (const stream of ["stdout", "stderr"] as const) {
        if (this.#partial[stream] !== "") this.#accept(stream, this.#partial[stream]);
        this.#partial[stream] = "";
      }
    }
    const batches: OutputBatch[] = [];
    for (const stream of ["stdout", "stderr"] as const) {
      const lines = this.#pending[stream];
      while (lines.length > 0) {
        const batch = lines.splice(0, this.#options.maxLinesPerEvent);
        batches.push({ stream, lines: batch, truncatedLines: this.#truncatedLines[stream] });
        this.#truncatedLines[stream] = 0;
      }
    }
    return batches;
  }

  #accept(stream: OutputStream, raw: string): void {
    if (this.#limitReached) {
      this.#droppedLines += 1;
      return;
    }
    const line = sanitizeLine(raw, this.#options.maxLineChars);
    if (this.#publishedChars + line.text.length > this.#options.maxPublishedChars) {
      this.#limitReached = true;
      this.#droppedLines += 1;
      return;
    }
    this.#publishedChars += line.text.length;
    if (line.truncated) this.#truncatedLines[stream] += 1;
    this.#pending[stream].push(line.text);
  }
}

export type LabTelemetry = {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  pids: number;
};

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
  kib: 1_024,
  mib: 1_024 ** 2,
  gib: 1_024 ** 3,
  tib: 1_024 ** 4,
};

export function parseSize(value: string): number | null {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-z]+)\s*$/iu.exec(value);
  if (!match) return null;
  const unit = SIZE_UNITS[(match[2] ?? "").toLowerCase()];
  if (unit === undefined) return null;
  return Math.round(Number(match[1]) * unit);
}

function parsePercent(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)%\s*$/u.exec(value);
  return match ? Number(match[1]) : null;
}

/**
 * Parses one line of `docker stats --format '{{json .}}'`. Streaming output
 * prefixes each frame with terminal cursor codes, so only the JSON object is read.
 */
export function parseDockerStats(line: string): LabTelemetry | null {
  const start = line.indexOf("{");
  const end = line.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const cpuPercent = parsePercent(record.CPUPerc);
  const memoryPercent = parsePercent(record.MemPerc);
  const [used, limit] = typeof record.MemUsage === "string" ? record.MemUsage.split("/") : [];
  const memoryBytes = used ? parseSize(used) : null;
  const memoryLimitBytes = limit ? parseSize(limit) : null;
  const pids = typeof record.PIDs === "string" ? Number.parseInt(record.PIDs, 10) : Number.NaN;
  if (
    cpuPercent === null ||
    memoryPercent === null ||
    memoryBytes === null ||
    memoryLimitBytes === null ||
    !Number.isFinite(pids)
  ) {
    return null;
  }
  return { cpuPercent, memoryBytes, memoryLimitBytes, memoryPercent, pids };
}

export type ArtifactChange = {
  path: string;
  bytes: number;
  change: "created" | "modified";
};

/** Detects new or resized artifact files between samples without following symlinks. */
export class ArtifactWatcher {
  readonly #root: string;
  readonly #prefix: string;
  readonly #maxFiles: number;
  readonly #seen = new Map<string, string>();

  constructor(root: string, prefix: string, maxFiles: number) {
    this.#root = root;
    this.#prefix = prefix;
    this.#maxFiles = maxFiles;
  }

  async sample(): Promise<ArtifactChange[]> {
    const changes: ArtifactChange[] = [];
    let files = 0;
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files >= this.#maxFiles) return;
        const hostPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(hostPath);
          continue;
        }
        if (!entry.isFile()) continue;
        files += 1;
        const stats = await lstat(hostPath).catch(() => null);
        if (!stats?.isFile()) continue;
        const path = posix.join(this.#prefix, ...relative(this.#root, hostPath).split(sep));
        const signature = `${stats.size}:${stats.mtimeMs}`;
        const previous = this.#seen.get(path);
        if (previous === signature) continue;
        this.#seen.set(path, signature);
        changes.push({ path, bytes: stats.size, change: previous === undefined ? "created" : "modified" });
      }
    };
    await walk(this.#root);
    return changes;
  }
}
