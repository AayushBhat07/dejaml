import { randomBytes } from "node:crypto";

import type { ClaimContract } from "@dejaml/contracts";
import { BlindingIntegrityError, sha256Hex } from "@dejaml/run-store";

import { canonicalJson } from "./contract.js";
import type { PaperClaim, RepositoryMapping } from "./roles.js";

/**
 * Blinded execution. Three information domains:
 *
 * - **Sealed target** (`SealedTarget`): the paper's reported value, the
 *   tolerance, the paper reference, the reviewed claim identity, the paper
 *   hash and a private nonce. Only trusted orchestrator code holds it before
 *   the reveal; a SHA-256 commitment to its canonical JSON is recorded before
 *   any execution agent starts. The nonce makes the commitment unguessable
 *   even for a low-entropy value such as 1.000.
 * - **Execution** (`executionClaim`, `executionContract`): method, dataset,
 *   split, preprocessing, metric name, unit and direction, commit, entry
 *   point, command, environment, limits and parser. Never the reported value,
 *   the tolerance, an expected result, a comparison or the paper reference.
 * - **Comparison** (`compareRevealed`): runs only after the observation and
 *   the blind review are locked, on the revealed and verified payload.
 */

export const COMPARISON_RULE = "absolute_difference_within_tolerance" as const;

export type SealedTarget = {
  schemaVersion: 1;
  caseId: string | null;
  caseVersion: string | null;
  paperSha256: string;
  claimLocator: { page: number; location: string };
  metric: { name: string; unit: "fraction" | "percent" | "score" };
  reportedValue: number;
  tolerance: number;
  comparisonRule: typeof COMPARISON_RULE;
  /** 32 random bytes, hex: the commitment cannot be found by guessing the value. */
  nonce: string;
};

export type Sealed = { target: SealedTarget; canonical: string; commitment: string };

export function sealTarget(
  input: Omit<SealedTarget, "schemaVersion" | "comparisonRule" | "nonce">,
  nonce = randomBytes(32).toString("hex"),
): Sealed {
  const target: SealedTarget = { schemaVersion: 1, ...input, comparisonRule: COMPARISON_RULE, nonce };
  const canonical = canonicalJson(target);
  return { target, canonical, commitment: sha256Hex(canonical) };
}

/** Recomputes the commitment of the revealed payload; a mismatch is a typed integrity failure. */
export function revealTarget(sealed: { canonical: string; commitment: string }): SealedTarget {
  const recomputed = sha256Hex(sealed.canonical);
  if (recomputed !== sealed.commitment) {
    throw new BlindingIntegrityError(`the revealed target does not match its commitment (${recomputed} ≠ ${sealed.commitment})`);
  }
  return JSON.parse(sealed.canonical) as SealedTarget;
}

export type Comparison = {
  observed: number;
  reported: number;
  absoluteDelta: number;
  tolerance: number;
  withinTolerance: boolean;
  rule: typeof COMPARISON_RULE;
};

/** The only comparison of an observation with the paper: ordinary code, after the reveal. */
export function compareRevealed(target: SealedTarget, observed: number): Comparison {
  const absoluteDelta = Math.abs(observed - target.reportedValue);
  return {
    observed,
    reported: target.reportedValue,
    absoluteDelta: Math.round(absoluteDelta * 1e9) / 1e9,
    tolerance: target.tolerance,
    withinTolerance: absoluteDelta <= target.tolerance + 1e-9,
    rule: COMPARISON_RULE,
  };
}

// ---------------------------------------------------------------------------
// Leak detection: the forms in which a number is usually written.

type Unit = SealedTarget["metric"]["unit"];

/**
 * Textual forms of a value: its shortest form, fixed decimals, and the same
 * number on the other scale (fraction ↔ percent).
 *
 * `detect` (the default) keeps only forms with at least three significant
 * digits once leading and trailing zeros are dropped (`0.314`, `31.42`):
 * shorter forms such as `1.000` or `0.5` occur in ordinary text too often to
 * mean anything, so finding one proves nothing and refusing on it would block
 * honest work. `redact` also keeps every form written with a decimal point
 * (`1.0`, `1.000`, `100.0`), for withholding text where removing an innocent
 * number costs nothing.
 */
export function valueForms(value: number, unit: Unit | null = null, mode: "detect" | "redact" = "detect"): string[] {
  const forms = new Set<string>();
  const add = (number: number): void => {
    if (!Number.isFinite(number)) return;
    forms.add(String(number));
    for (let digits = 1; digits <= 6; digits += 1) forms.add(number.toFixed(digits));
  };
  add(value);
  if (unit === "fraction" || (unit === null && Math.abs(value) <= 1)) add(Math.round(value * 100 * 1e9) / 1e9);
  if (unit === "percent" || (unit === null && Math.abs(value) > 1 && Math.abs(value) <= 100)) add(Math.round((value / 100) * 1e12) / 1e12);
  const significant = (form: string): number =>
    form
      .replace(/[^0-9]/gu, "")
      .replace(/^0+/u, "")
      .replace(/0+$/u, "").length;
  return [...forms].filter((form) => significant(form) >= 3 || (mode === "redact" && form.includes(".") && significant(form) >= 1));
}

function formPattern(form: string): RegExp {
  // A whole number token: not part of a longer number or a version string such as 0.10.0.
  return new RegExp(`(?<![0-9.])${form.replace(/[.-]/gu, "\\$&")}(?![0-9]|\\.[0-9])`, "u");
}

/** The first form of `value` found in `text`, or null. */
export function findValue(value: number, unit: Unit | null, text: string): string | null {
  for (const form of valueForms(value, unit)) if (formPattern(form).test(text)) return form;
  return null;
}

/** Replaces every form of `value` in `text` (including the short decimal forms) with a neutral marker. */
export function withholdValue(value: number, unit: Unit | null, text: string): string {
  let out = text;
  for (const form of valueForms(value, unit, "redact").sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(formPattern(form).source, "gu"), "[withheld]");
  }
  return out;
}

/** Applies `withholdValue` to every string inside a JSON value, and nulls numbers equal to it. */
export function withholdInJson<T>(value: number, unit: Unit | null, json: T): T {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return withholdValue(value, unit, item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    if (typeof item === "number" && item === value) return null;
    return item;
  };
  return walk(json) as T;
}

/**
 * Language that states what the result should be, in a plan. Each pattern
 * needs a metric word and a number or a comparison with the paper, so plain
 * planning text ("the paper's accuracy", "stop within 600 seconds") passes.
 */
const METRIC_WORD = String.raw`(?:accuracy|score|f1|auc|error|metric|precision|recall|result)`;
/** A number that can be a metric value: with a decimal point, or a percentage. */
const NUMBER = String.raw`(?:\d*\.\d+|\d+\s*(?:%|percent))`;
const EXPECTATION = [
  new RegExp(String.raw`\b(?:expected|target|reported|published|paper'?s?)\s*[_-]?\s*${METRIC_WORD}\b[^\n]{0,30}${NUMBER}`, "iu"),
  new RegExp(String.raw`\b${METRIC_WORD}\b[^\n]{0,40}\b(?:should|must|will|expected to)\b[^\n]{0,30}${NUMBER}`, "iu"),
  new RegExp(String.raw`\b(?:expect\w*|should|must|will)\b[^\n]{0,30}\b${METRIC_WORD}\b[^\n]{0,30}${NUMBER}`, "iu"),
  new RegExp(
    String.raw`\b${METRIC_WORD}\b[^\n]{0,30}\b(?:close to|approximately|around|roughly|about|near|within)\s+(?:±\s*)?${NUMBER}`,
    "iu",
  ),
  new RegExp(String.raw`\btolerance\b[^\n]{0,20}${NUMBER}`, "iu"),
  /\b(?:higher|lower|better|worse)\s+than\s+(?:the\s+)?(?:paper|reported|published)\b/iu,
];

export function statesExpectation(text: string): boolean {
  return EXPECTATION.some((pattern) => pattern.test(text));
}

/** Code that would report success without measuring, or behave differently near a target. */
const RIGGED = [
  /\bisclose\s*\(/u,
  /\babs\s*\([^)\n]*-[^)\n]*\)\s*[<>]=?/u,
  /\b(expected|target|reported|paper)_?(value|accuracy|score|result)\b/iu,
  /\btolerance\b/iu,
  // A metric line printed with a literal number instead of a computed one.
  /print\s*\(\s*f?["'][^"'\n]*(accuracy|score|f1|auc)[^"'\n{]*?[:=]\s*\d/iu,
];

export function riggedAdapter(source: string): string | null {
  return RIGGED.some((pattern) => pattern.test(source))
    ? "the adapter contains code that states or tests against an expected result"
    : null;
}

// ---------------------------------------------------------------------------
// Execution-domain views.

export type MetricDirection = "higher_is_better" | "lower_is_better";

export function metricDirection(name: string): MetricDirection {
  return /loss|error|rmse|mse|mae|perplexity|distance|regret|wer|cer\b/iu.test(name) ? "lower_is_better" : "higher_is_better";
}

export type ExecutionClaim = {
  method: string;
  dataset: string;
  split: string;
  preprocessing: string;
  seedPolicy: string;
  metric: { name: string; unit: string; direction: MetricDirection };
};

/** What execution agents learn of the Paper Analyst's claim: what to measure, never what the paper measured. */
export function executionClaim(claim: PaperClaim, sealed: { value: number; unit: Unit } | null): ExecutionClaim {
  const view: ExecutionClaim = {
    method: claim.method,
    dataset: claim.dataset,
    split: claim.split,
    preprocessing: claim.preprocessing,
    seedPolicy: claim.seedPolicy,
    metric: { name: claim.metric.name, unit: claim.metric.unit, direction: metricDirection(claim.metric.name) },
  };
  return sealed ? withholdInJson(sealed.value, sealed.unit, view) : view;
}

export type ExecutionContract = Omit<ClaimContract, "reportedValue" | "tolerance" | "paperReference" | "metric"> & {
  metric: { name: string; unit: ClaimContract["metric"]["unit"]; direction: MetricDirection };
};

/** The approved contract as execution agents and the blind Reviewer see it. */
export function executionContract(contract: ClaimContract): ExecutionContract {
  const { reportedValue: _value, tolerance: _tolerance, paperReference: _reference, metric, ...rest } = contract;
  return { ...rest, metric: { name: metric.name, unit: metric.unit, direction: metricDirection(metric.name) } };
}

/** A repository mapping with every form of the sealed value withheld, before it is forwarded. */
export function forwardableMapping(mapping: RepositoryMapping, sealed: { value: number; unit: Unit } | null): RepositoryMapping {
  return sealed ? withholdInJson(sealed.value, sealed.unit, mapping) : mapping;
}

// ---------------------------------------------------------------------------
// The observation lock.

export type ObservationEngineer = {
  engineerAgentId: string;
  label: string;
  receiptId: string | null;
  exitCode: number | null;
  timedOut: boolean;
  stdoutSha256: string | null;
  stderrSha256: string | null;
  artifacts: Array<{ path: string; sha256: string }>;
  metricOk: boolean;
  metricSource: string | null;
  rawValue: number | null;
  observedValue: number | null;
  problem: string | null;
};

export type Observation = {
  schemaVersion: 1;
  runId: string;
  round: number;
  metric: { name: string; unit: string; parser: unknown };
  planDigest: string;
  repository: { url: string; commitSha: string; manifestSha256: string | null; projectionSha256: string | null };
  environment: {
    digest: string;
    labImageId: string | null;
    labImageDigest: string | null;
    dependencyManifestSha256: string | null;
    platform: string;
  };
  datasets: Array<{ name: string; sha256: string }>;
  engineers: ObservationEngineer[];
};

export function lockObservation(observation: Observation): { canonical: string; commitment: string } {
  const canonical = canonicalJson(observation);
  return { canonical, commitment: sha256Hex(canonical) };
}

export function environmentDigest(environment: Omit<Observation["environment"], "digest">): string {
  return sha256Hex(canonicalJson(environment));
}

/** A metric value that cannot be right for its unit, or null when it is plausible. */
export function implausibleValue(value: number, unit: string): string | null {
  if (!Number.isFinite(value)) return "the metric is not a finite number";
  if (unit === "fraction" && (value < 0 || value > 1)) return `a fraction must be between 0 and 1 (got ${value})`;
  if (unit === "percent" && (value < 0 || value > 100)) return `a percentage must be between 0 and 100 (got ${value})`;
  return null;
}
