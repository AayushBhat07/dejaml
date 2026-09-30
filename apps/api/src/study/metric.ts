import { Worker } from "node:worker_threads";

import type { MetricParser } from "@dejaml/contracts";

/**
 * Reads the metric from the official run, by code. The parser comes from the
 * approved contract; agents never type the number. A stdout pattern is a
 * model-written regular expression, so it runs in a worker thread with a
 * time limit and cannot stall the service.
 */

export type ParsedMetric =
  | { ok: true; value: number; unit: "fraction" | "percent" | "score" | null; source: string; matches: number }
  | { ok: false; reason: string };

const PATTERN_TIMEOUT_MS = 1_000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const expression = new RegExp(workerData.pattern, "gu");
const found = [];
for (const match of workerData.text.matchAll(expression)) {
  found.push(match[1] ?? null);
  if (found.length > 1000) break;
}
parentPort.postMessage(found);
`;

export async function matchAllBounded(pattern: string, text: string, timeoutMs = PATTERN_TIMEOUT_MS): Promise<Array<string | null>> {
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, text }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  try {
    return await new Promise<Array<string | null>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the metric pattern did not finish within ${timeoutMs} ms`)), timeoutMs);
      worker.once("message", (value: Array<string | null>) => {
        clearTimeout(timer);
        resolve(value);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    await worker.terminate();
  }
}

export function readDotPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current) && /^\d+$/u.test(part) ? current[Number(part)] : (current as Record<string, unknown>)[part];
  }
  return current;
}

function toNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw.trim().replace(/%$/u, "");
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/u.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses the metric. For stdout, the last match counts (training scripts often
 * print intermediate values first); the number of matches is reported.
 */
export async function parseMetric(parser: MetricParser, output: { stdout: string; artifacts: ReadonlyMap<string, string | null> }): Promise<ParsedMetric> {
  const unit = parser.unit ?? null;
  if (parser.source === "stdout") {
    let found: Array<string | null>;
    try {
      found = await matchAllBounded(parser.pattern, output.stdout);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (found.length === 0) return { ok: false, reason: "the metric pattern did not match the official run's output" };
    const value = toNumber(found.at(-1));
    if (value === null) return { ok: false, reason: `the last match (${String(found.at(-1)).slice(0, 80)}) is not a number` };
    return { ok: true, value, unit, source: `stdout /${parser.pattern}/ (last of ${found.length})`, matches: found.length };
  }
  const text = output.artifacts.get(parser.path);
  if (text === undefined) return { ok: false, reason: `the official run did not write ${parser.path}` };
  if (text === null) return { ok: false, reason: `${parser.path} is not a text file` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${parser.path} is not valid JSON` };
  }
  const raw = readDotPath(parsed, parser.key);
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : typeof raw === "string" ? toNumber(raw) : null;
  if (value === null) return { ok: false, reason: `${parser.key} in ${parser.path} is not a finite number` };
  return { ok: true, value, unit, source: `${parser.path}#${parser.key}`, matches: 1 };
}

/** Converts between fraction and percent; a score is compared as is. */
export function convertUnit(value: number, from: "fraction" | "percent" | "score" | null, to: "fraction" | "percent" | "score"): number {
  if (!from || from === to || from === "score" || to === "score") return value;
  return from === "fraction" ? value * 100 : value / 100;
}
