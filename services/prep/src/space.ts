import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";

import { PrepError } from "./errors.js";

/**
 * Bounded, disk-backed temporary storage for preparation containers.
 *
 * Filesystem quotas are not available portably, so the per-run directory is
 * measured (apparent bytes and inode count) while the worker runs and again
 * afterwards, and free space is checked with statfs before each phase.
 */

export type FreeSpace = { freeBytes: number };
export type FreeSpaceProbe = (path: string) => Promise<FreeSpace>;

export const defaultFreeSpaceProbe: FreeSpaceProbe = async (path) => {
  const stats = await statfs(path);
  return { freeBytes: Number(stats.bavail) * Number(stats.bsize) };
};

export type TreeUsage = { bytes: number; inodes: number; exceeded: "bytes" | "inodes" | null };

/**
 * Apparent size and entry count of a directory tree (symlinks are counted,
 * never followed). Stops early once a limit is exceeded. Unreadable
 * directories count as one entry.
 */
export async function measureTree(root: string, limits: { maxBytes: number; maxInodes: number }): Promise<TreeUsage> {
  const usage: TreeUsage = { bytes: 0, inodes: 0, exceeded: null };
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      usage.inodes += 1;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else {
        const stat = await lstat(path).catch(() => null);
        if (stat) usage.bytes += stat.size;
      }
      if (usage.bytes > limits.maxBytes) usage.exceeded = "bytes";
      else if (usage.inodes > limits.maxInodes) usage.exceeded = "inodes";
      if (usage.exceeded) return usage;
    }
  }
  return usage;
}

export function spaceError(message: string, detail?: string): PrepError {
  return new PrepError("insufficient_preparation_space", message, detail ? { detail } : {});
}

/** Require `requiredBytes` of free space plus the configured margin at `path`. */
export async function assertFreeSpace(
  probe: FreeSpaceProbe,
  path: string,
  requiredBytes: number,
  marginBytes: number,
  phase: string,
): Promise<number> {
  let free: FreeSpace;
  try {
    free = await probe(path);
  } catch (error) {
    throw spaceError(`could not determine free space before ${phase}`, error instanceof Error ? error.message : String(error));
  }
  const needed = requiredBytes + marginBytes;
  if (free.freeBytes < needed) {
    throw spaceError(
      `not enough free disk space for ${phase}: ${formatBytes(free.freeBytes)} free, ${formatBytes(needed)} needed ` +
        `(${formatBytes(requiredBytes)} plus a ${formatBytes(marginBytes)} safety margin)`,
    );
  }
  return free.freeBytes;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export type QuotaLimits = { maxBytes: number; maxInodes: number; minFreeBytes: number; pollMs: number };

/**
 * Polls a directory while a worker runs. When the tree exceeds its byte or
 * inode quota, or free space drops below the margin, it records the reason
 * and fires `onExceeded` (which aborts the worker). `peak` is the largest
 * usage seen, for the manifest.
 */
export class QuotaWatcher {
  readonly #dir: string;
  readonly #limits: QuotaLimits;
  readonly #probe: FreeSpaceProbe;
  readonly #onExceeded: () => void;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  violation: string | null = null;
  peak: { bytes: number; inodes: number } = { bytes: 0, inodes: 0 };

  constructor(dir: string, limits: QuotaLimits, probe: FreeSpaceProbe, onExceeded: () => void) {
    this.#dir = dir;
    this.#limits = limits;
    this.#probe = probe;
    this.#onExceeded = onExceeded;
  }

  start(): void {
    const tick = (): void => {
      this.#running = this.check().then(
        () => {
          if (this.#timer !== null && this.violation === null) this.#timer = setTimeout(tick, this.#limits.pollMs);
        },
        () => undefined,
      );
    };
    this.#timer = setTimeout(tick, this.#limits.pollMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  /** One measurement; returns the violation (also recorded) or null. */
  async check(): Promise<string | null> {
    if (this.violation) return this.violation;
    const usage = await measureTree(this.#dir, { maxBytes: this.#limits.maxBytes, maxInodes: this.#limits.maxInodes });
    this.peak = { bytes: Math.max(this.peak.bytes, usage.bytes), inodes: Math.max(this.peak.inodes, usage.inodes) };
    if (usage.exceeded === "bytes") {
      this.violation = `the preparation temp directory exceeded its ${formatBytes(this.#limits.maxBytes)} quota`;
    } else if (usage.exceeded === "inodes") {
      this.violation = `the preparation temp directory exceeded its ${this.#limits.maxInodes}-file quota`;
    } else {
      const free = await this.#probe(this.#dir).catch(() => null);
      if (free && free.freeBytes < this.#limits.minFreeBytes) {
        this.violation = `free disk space fell to ${formatBytes(free.freeBytes)}, below the ${formatBytes(this.#limits.minFreeBytes)} margin`;
      }
    }
    if (this.violation) this.#onExceeded();
    return this.violation;
  }
}
