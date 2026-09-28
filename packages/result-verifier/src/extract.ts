import { createHash } from "node:crypto";

import {
  AttemptSchema,
  ExperimentPlanSchema,
  MetricSchema,
  type Attempt,
  type ExperimentPlan,
  type Metric,
} from "@dejaml/contracts";

export type MetricUnit = Metric["unit"];

export class MetricExtractionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MetricExtractionError";
    this.code = code;
  }
}

export type ExportedArtifact = {
  path: string;
  sha256: string;
  content: Buffer | string;
};

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_STDOUT_CHARS = 1024 * 1024;
const MAX_PATTERN_CHARS = 200;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Reads the observed metric exactly as the approved plan says: a dotted key in
 * a JSON artifact, a column in the last CSV row, or the last capture of a
 * stdout pattern. The value is assumed to be in the claim's unit unless
 * `observedUnit` says otherwise; the reviewed policy pairs each key with a unit.
 */
export function extractMetric(input: {
  plan: ExperimentPlan;
  attempt: Attempt;
  artifact?: ExportedArtifact;
  stdout?: string;
  observedUnit?: MetricUnit;
}): Metric {
  const plan = ExperimentPlanSchema.parse(input.plan);
  const attempt = AttemptSchema.parse(input.attempt);
  const rule = plan.metricExtraction;
  const split = plan.claim.split ?? "unspecified";
  const unit = input.observedUnit ?? plan.claim.metric.unit;

  if (rule.source === "stdout") {
    const pattern = rule.pattern ?? "";
    const value = extractFromStdout(pattern, input.stdout ?? "");
    return MetricSchema.parse({
      name: plan.claim.metric.name,
      value: value.value,
      unit,
      split,
      attemptId: attempt.id,
      extractionRule: `stdout /${pattern}/ (last match)`,
      evidence: { kind: "log_line", reference: `${attempt.id}/stdout`, excerpt: value.excerpt },
    });
  }

  const path = rule.path ?? "";
  const key = rule.key ?? "";
  const artifact = input.artifact;
  if (!artifact) throw new MetricExtractionError("artifact_missing", `metric artifact ${path} was not exported`);
  if (artifact.path !== path) {
    throw new MetricExtractionError("artifact_mismatch", `expected ${path}, received ${artifact.path}`);
  }
  const recordedDigest = attempt.artifactDigests[path];
  if (!recordedDigest) {
    throw new MetricExtractionError("artifact_missing", `attempt did not produce ${path}`);
  }
  const bytes = typeof artifact.content === "string" ? Buffer.from(artifact.content) : artifact.content;
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new MetricExtractionError("artifact_too_large", `${path} exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== recordedDigest || artifact.sha256 !== recordedDigest) {
    throw new MetricExtractionError("artifact_digest_mismatch", `${path} differs from the digest recorded by the attempt`);
  }
  const content = bytes.toString("utf8");

  const value = rule.source === "json" ? readJsonKey(content, key) : readCsvColumn(content, key);
  return MetricSchema.parse({
    name: plan.claim.metric.name,
    value,
    unit,
    split,
    attemptId: attempt.id,
    extractionRule: `${rule.source} ${path} → ${key}`,
    evidence: {
      kind: "artifact",
      reference: `${path}#sha256=${artifact.sha256}`,
      excerpt: `${key} = ${value}`,
    },
  });
}

function readJsonKey(content: string, key: string): number {
  let current: unknown;
  try {
    current = JSON.parse(content) as unknown;
  } catch {
    throw new MetricExtractionError("artifact_invalid", "metric artifact is not valid JSON");
  }
  for (const segment of key.split(".")) {
    if (
      FORBIDDEN_KEYS.has(segment) ||
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      throw new MetricExtractionError("metric_missing", `metric key ${key} is missing`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return finiteNumber(current, key);
}

function readCsvColumn(content: string, column: string): number {
  const rows = content
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "");
  const [header, ...data] = rows;
  if (!header || data.length === 0) {
    throw new MetricExtractionError("artifact_invalid", "metric CSV needs a header and at least one row");
  }
  if (content.includes('"')) {
    throw new MetricExtractionError("artifact_invalid", "quoted CSV fields are not supported");
  }
  const index = header.split(",").map((name) => name.trim()).indexOf(column);
  if (index < 0) throw new MetricExtractionError("metric_missing", `metric column ${column} is missing`);
  const cell = data.at(-1)?.split(",")[index]?.trim();
  if (cell === undefined || cell === "") {
    throw new MetricExtractionError("metric_missing", `metric column ${column} is empty`);
  }
  return finiteNumber(Number(cell), column);
}

function extractFromStdout(pattern: string, stdout: string): { value: number; excerpt: string } {
  if (pattern.length > MAX_PATTERN_CHARS) {
    throw new MetricExtractionError("rule_invalid", "stdout pattern is too long");
  }
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "gu");
  } catch {
    throw new MetricExtractionError("rule_invalid", "stdout pattern is not a valid regular expression");
  }
  const text = stdout.slice(-MAX_STDOUT_CHARS);
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(expression)) last = match;
  if (!last) throw new MetricExtractionError("metric_missing", "stdout pattern did not match");
  if (last.length !== 2 || last[1] === undefined) {
    throw new MetricExtractionError("rule_invalid", "stdout pattern must have exactly one capture group");
  }
  return { value: finiteNumber(Number(last[1]), "stdout capture"), excerpt: last[0].slice(0, 200) };
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MetricExtractionError("metric_invalid", `${label} is not a finite number`);
  }
  return value;
}

/** Converts between fraction and percent. Scores convert only to themselves. */
export function convertMetricValue(value: number, from: MetricUnit, to: MetricUnit): number | null {
  if (from === to) return value;
  if (from === "fraction" && to === "percent") return value * 100;
  if (from === "percent" && to === "fraction") return value / 100;
  return null;
}
