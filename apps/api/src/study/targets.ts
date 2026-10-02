import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";

import { type MetricParser, MetricParserSchema, PythonVersionSchema } from "@dejaml/contracts";
import { z } from "zod";

import { canonicalJson, checkExcerpt } from "./contract.js";
import type { Adapter, PaperClaim } from "./roles.js";

/**
 * Reviewed claim targets: a server-owned registry of claims a person has
 * checked against a paper and its repository. A target only says which claim
 * to investigate and narrows what policy accepts for it; the agents still
 * read the paper and the repository, the plan still passes policy review, the
 * lab still runs the official code, and an independent Reviewer still judges
 * the evidence. A target never carries an observed result.
 *
 * Uploaders may choose a target by id. The server may also select the sole
 * target whose reviewed paper hash matches the upload; nothing in the target
 * itself can come from a request.
 */

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const RelativePath = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "a relative path without `..`");

export const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const ClaimTargetFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  caseId: z.string().regex(CASE_ID),
  paper: z.strictObject({ title: z.string().min(1).max(300), sha256: Sha256 }),
  claim: z.strictObject({
    page: z.number().int().positive(),
    location: z.string().min(1).max(200),
    /** Copied from the extracted text of `page`; it must contain the reported value. */
    excerpt: z.string().min(1).max(1_000),
    method: z.string().min(1).max(300),
    dataset: z.string().min(1).max(300),
    split: z.string().min(1).max(300),
    preprocessing: z.string().min(1).max(1_000),
    seedPolicy: z.string().min(1).max(500),
    metric: z.strictObject({ name: z.string().min(1).max(200), unit: z.enum(["fraction", "percent", "score"]) }),
    reportedValue: z.number().finite(),
    /** How the Paper Analyst's claim is recognized as this one (case-insensitive substrings). */
    identify: z.strictObject({
      methodIncludes: z.array(z.string().min(1).max(100)).min(1).max(5),
      methodExcludes: z.array(z.string().min(1).max(100)).max(5),
      datasetIncludes: z.array(z.string().min(1).max(100)).min(1).max(5),
    }),
  }),
  repository: z.strictObject({
    url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    entrypoint: RelativePath,
  }),
  environment: z.strictObject({
    python: z.array(PythonVersionSchema).min(1).max(4),
    /** Requirement lines a plan may use (exact pins reviewed for this claim). */
    requirements: z.array(z.string().min(1).max(200)).max(150),
    /** Compatibility constraints a plan may add; each must also be in the trusted constraints file. */
    allowedCompatibilityConstraints: z.array(z.string().min(1).max(200)).max(30),
  }),
  dataset: z.strictObject({
    source: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("package"), package: z.string().min(1).max(100) }),
      z.strictObject({ kind: z.literal("repository") }),
      z.strictObject({
        kind: z.literal("download"),
        url: z.string().max(2_000),
        sha256: Sha256,
        extract: z.boolean(),
        /** Files the reviewed archive holds, as the lab sees them under `data/extracted/`; a planning aid, not a check. */
        files: z.array(RelativePath).max(20).optional(),
      }),
    ]),
  }),
  /** A reviewed adapter the plan may use by id; the file is checked against its hash when the registry loads. */
  adapter: z
    .strictObject({
      id: z.string().regex(CASE_ID),
      path: z.string().regex(/^work\/adapter\/[A-Za-z0-9_.-]{1,80}\.py$/u),
      file: RelativePath,
      sha256: Sha256,
      why: z.string().min(1).max(1_000),
      source: z.string().min(1).max(500),
      differences: z.array(z.string().min(1).max(500)).min(1).max(20),
    })
    .nullable(),
  metricParser: MetricParserSchema,
  additionalMetrics: z
    .array(
      z.strictObject({
        page: z.number().int().positive(),
        location: z.string().min(1).max(200),
        excerpt: z.string().min(1).max(1_000),
        metric: z.strictObject({ name: z.string().min(1).max(200), unit: z.enum(["fraction", "percent", "score"]) }),
        reportedValue: z.number().finite(),
        metricParser: MetricParserSchema,
        tolerance: z.number().positive().max(100),
      }),
    )
    .max(20)
    .default([]),
  expectedRuntimeCeilingSeconds: z
    .number()
    .int()
    .positive()
    .max(24 * 3_600),
  tolerance: z.number().positive().max(100),
  /** The most favourable status the evidence can honestly support for this claim (an adapter caps it). */
  maximumVerdict: z.enum(["reproduced", "partially_reproduced"]),
});

type ClaimTargetFile = z.infer<typeof ClaimTargetFileSchema>;

/**
 * A loaded target: the reviewed file with its adapter's content read and
 * verified, and its version (the SHA-256 of the file's canonical JSON), which
 * the sealed-target commitment binds.
 */
export type ClaimTarget = Omit<ClaimTargetFile, "adapter"> & {
  adapter: (Adapter & { id: string; sha256: string }) | null;
  version: string;
};

export class ReviewedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewedTargetError";
  }
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Validates one target file and reads its adapter from `root`, refusing a hash mismatch. */
export async function loadClaimTarget(raw: unknown, root: string): Promise<ClaimTarget> {
  const parsed = ClaimTargetFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReviewedTargetError(
      `invalid reviewed target: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  const file = parsed.data;
  const value = file.claim.reportedValue;
  const numbers = file.claim.excerpt.normalize("NFKC").match(/-?\d+(?:\.\d+)?/gu) ?? [];
  if (!numbers.some((item) => Number(item) === value))
    throw new ReviewedTargetError(`${file.caseId}: the excerpt does not contain the reported value`);
  for (const additional of file.additionalMetrics) {
    const values = additional.excerpt.normalize("NFKC").match(/-?\d+(?:\.\d+)?/gu) ?? [];
    if (!values.some((item) => Number(item) === additional.reportedValue))
      throw new ReviewedTargetError(`${file.caseId}: the ${additional.metric.name} excerpt does not contain its reported value`);
  }
  let adapter: ClaimTarget["adapter"] = null;
  if (file.adapter) {
    const path = normalize(join(root, file.adapter.file));
    const inside = relative(root, path);
    if (inside.startsWith("..") || isAbsolute(inside))
      throw new ReviewedTargetError(`${file.caseId}: the adapter file is outside the project`);
    const content = await readFile(path, "utf8").catch(() => {
      throw new ReviewedTargetError(`${file.caseId}: the adapter file ${file.adapter!.file} is missing`);
    });
    if (sha256(content) !== file.adapter.sha256)
      throw new ReviewedTargetError(`${file.caseId}: the adapter file ${file.adapter.file} does not match its reviewed hash`);
    adapter = {
      id: file.adapter.id,
      sha256: file.adapter.sha256,
      path: file.adapter.path,
      content,
      why: file.adapter.why,
      source: file.adapter.source,
      differences: file.adapter.differences,
    };
  }
  return Object.freeze({ ...file, adapter, version: sha256(canonicalJson(file)) });
}

/** Loads every `*.json` target in `dir` (missing directory: none). Duplicate ids are refused. */
export async function loadReviewedTargets(dir: string, root: string): Promise<Map<string, ClaimTarget>> {
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const targets = new Map<string, ClaimTarget>();
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const raw: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
    const target = await loadClaimTarget(raw, root);
    if (targets.has(target.caseId)) throw new ReviewedTargetError(`duplicate reviewed target ${target.caseId}`);
    targets.set(target.caseId, target);
  }
  return targets;
}

/** The uploaded paper must be the reviewed one, and the reviewed excerpt must be on its cited page. */
export function checkTargetPaper(
  target: ClaimTarget,
  paper: { sha256: string; pages: ReadonlyArray<{ pageNumber: number; text: string }> },
): string | null {
  if (paper.sha256 !== target.paper.sha256) return `the uploaded paper is not the one reviewed for ${target.caseId}`;
  const primary = checkExcerpt(target.claim, paper.pages);
  if (primary) return primary;
  for (const item of target.additionalMetrics) {
    const problem = checkExcerpt({ page: item.page, excerpt: item.excerpt, reportedValue: item.reportedValue }, paper.pages);
    if (problem) return `${item.metric.name}: ${problem}`;
  }
  return null;
}

/** Why the Paper Analyst's claim is not the reviewed target, or null when it is. */
export function claimMismatch(target: ClaimTarget, claim: PaperClaim): string | null {
  const reasons: string[] = [];
  const has = (text: string, part: string): boolean => text.toLowerCase().includes(part.toLowerCase());
  if (claim.page !== target.claim.page) reasons.push(`page ${claim.page} instead of ${target.claim.page}`);
  // Never the values themselves: this message reaches events and the Supervisor before the reveal.
  if (claim.reportedValue !== target.claim.reportedValue) reasons.push("a different reported value");
  if (claim.metric.unit !== target.claim.metric.unit) reasons.push(`unit ${claim.metric.unit} instead of ${target.claim.metric.unit}`);
  const { identify } = target.claim;
  if (!identify.methodIncludes.every((part) => has(claim.method, part)) || identify.methodExcludes.some((part) => has(claim.method, part)))
    reasons.push(`method "${claim.method}" is not ${target.claim.method}`);
  if (!identify.datasetIncludes.every((part) => has(claim.dataset, part)))
    reasons.push(`dataset "${claim.dataset}" is not ${target.claim.dataset}`);
  return reasons.length ? `the Paper Analyst returned a different claim than the reviewed target: ${reasons.join("; ")}` : null;
}

/**
 * What the Paper Analyst is told: the claim to find and check, with the value
 * the paper reports (it reads the paper anyway). Its history is never shared;
 * code reduces its result to the execution claim before anyone else sees it.
 */
export function paperAnalystTarget(target: ClaimTarget): Record<string, unknown> {
  const { claim } = target;
  return {
    caseId: target.caseId,
    page: claim.page,
    location: claim.location,
    method: claim.method,
    dataset: claim.dataset,
    split: claim.split,
    metric: claim.metric,
    reportedValue: claim.reportedValue,
  };
}

/** What the Repository Analyst is told: the pinned repository and the claim it must map, not the paper analysis. */
export function repositoryAnalystTarget(target: ClaimTarget): Record<string, unknown> {
  return {
    caseId: target.caseId,
    repositoryUrl: target.repository.url,
    pinnedCommit: target.repository.commitSha,
    claim: { method: target.claim.method, dataset: target.claim.dataset, split: target.claim.split, metric: target.claim.metric.name },
  };
}

/** What the Planner is told: the reviewed limits its plan must fit. Never the value, tolerance, or paper reference. */
export function plannerTarget(target: ClaimTarget): Record<string, unknown> {
  return {
    caseId: target.caseId,
    claim: {
      method: target.claim.method,
      dataset: target.claim.dataset,
      split: target.claim.split,
      metric: target.claim.metric,
    },
    repository: target.repository,
    environment: target.environment,
    dataset: target.dataset,
    metricParser: target.metricParser,
    additionalMetrics: target.additionalMetrics.map(({ metric, metricParser }) => ({ metric, metricParser })),
    expectedRuntimeCeilingSeconds: target.expectedRuntimeCeilingSeconds,
    reviewedAdapter: target.adapter
      ? {
          id: target.adapter.id,
          path: target.adapter.path,
          why: target.adapter.why,
          source: target.adapter.source,
          differences: target.adapter.differences,
          content: target.adapter.content,
        }
      : null,
  };
}

/**
 * Public view for events, reports, and the browser before the reveal: which
 * claim is under study, never its value, tolerance, excerpt, or adapter text.
 */
export function publicTargetSummary(target: ClaimTarget): Record<string, unknown> {
  return {
    caseId: target.caseId,
    caseVersion: target.version,
    paperSha256: target.paper.sha256,
    claim: {
      method: target.claim.method,
      dataset: target.claim.dataset,
      split: target.claim.split,
      metric: target.claim.metric,
      additionalMetrics: target.additionalMetrics.map((item) => item.metric),
    },
    repository: target.repository,
    adapter: target.adapter ? { id: target.adapter.id, path: target.adapter.path, sha256: target.adapter.sha256 } : null,
    maximumVerdict: target.maximumVerdict,
  };
}

/** The adapter text's hash, as recorded for a reviewed adapter. */
export function adapterSha256(content: string): string {
  return sha256(content);
}

/**
 * Checks an approved-looking contract against the reviewed target. Every
 * mismatch is a reason to refuse the plan; a target only ever narrows policy.
 */
export function targetViolations(
  target: ClaimTarget,
  input: {
    contract: {
      repository: { url: string; commitSha: string };
      entrypoint: string;
      reportedValue: number;
      paperReference: { page: number };
      metric: { unit: string };
      metricParser: unknown;
      additionalMetrics?: Array<{
        metric: { name: string; unit: string };
        reportedValue: number;
        metricParser: unknown;
        tolerance: number;
      }>;
      expectedRuntimeSeconds: number;
      dataset: { source: { kind: string; package?: string; url?: string; sha256?: string | null; extract?: boolean } };
      environment: {
        platform: { python: { version: string } };
        requirements: string[];
        compatibilityConstraints: Array<{ requirement: string }>;
      };
    };
    adapter: Adapter | null;
  },
): string[] {
  const { contract, adapter } = input;
  const out: string[] = [];
  const norm = (line: string): string => line.replace(/\s+/gu, "").toLowerCase();
  if (contract.repository.url !== target.repository.url || contract.repository.commitSha !== target.repository.commitSha)
    out.push(`the plan does not use the reviewed repository ${target.repository.url}@${target.repository.commitSha.slice(0, 12)}`);
  if (contract.entrypoint !== target.repository.entrypoint)
    out.push(`the plan's entry point ${contract.entrypoint} is not the reviewed ${target.repository.entrypoint}`);
  if (contract.paperReference.page !== target.claim.page || contract.reportedValue !== target.claim.reportedValue)
    out.push("the plan's claim is not the reviewed target claim");
  if (contract.metric.unit !== target.claim.metric.unit) out.push("the plan's metric unit differs from the reviewed claim");
  if (!sameParser(contract.metricParser as MetricParser, target.metricParser, target.claim.metric.unit))
    out.push("the plan's metric parser is not the reviewed parser");
  const additional = contract.additionalMetrics ?? [];
  if (additional.length !== target.additionalMetrics.length) out.push("the plan's additional metrics differ from the reviewed target");
  for (const reviewed of target.additionalMetrics) {
    const planned = additional.find((item) => item.metric.name.toLowerCase() === reviewed.metric.name.toLowerCase());
    if (
      !planned ||
      planned.metric.unit !== reviewed.metric.unit ||
      planned.reportedValue !== reviewed.reportedValue ||
      planned.tolerance !== reviewed.tolerance ||
      !sameParser(planned.metricParser as MetricParser, reviewed.metricParser, reviewed.metric.unit)
    )
      out.push(`the plan's ${reviewed.metric.name} metric is not the reviewed metric`);
  }
  if (contract.expectedRuntimeSeconds > target.expectedRuntimeCeilingSeconds)
    out.push(`the plan's expected runtime exceeds the reviewed ceiling (${target.expectedRuntimeCeilingSeconds} s)`);
  if (!target.environment.python.includes(contract.environment.platform.python.version as never))
    out.push(`Python ${contract.environment.platform.python.version} is not a reviewed version (${target.environment.python.join(", ")})`);
  const reviewed = new Set(target.environment.requirements.map(norm));
  const extra = contract.environment.requirements.filter((line) => !reviewed.has(norm(line)));
  if (extra.length) out.push(`requirements outside the reviewed set: ${extra.join(", ")}`);
  const allowed = new Set(target.environment.allowedCompatibilityConstraints.map(norm));
  const changes = contract.environment.compatibilityConstraints.filter((item) => !allowed.has(norm(item.requirement)));
  if (changes.length)
    out.push(`compatibility constraints not allowed for this claim: ${changes.map((item) => item.requirement).join(", ")}`);
  const source = contract.dataset.source;
  const expected = target.dataset.source;
  if (source.kind !== expected.kind) out.push(`the plan's dataset source (${source.kind}) is not the reviewed one (${expected.kind})`);
  else if (expected.kind === "package" && norm(source.package ?? "") !== norm(expected.package))
    out.push(`the plan's dataset package ${source.package} is not the reviewed ${expected.package}`);
  else if (
    expected.kind === "download" &&
    (source.url !== expected.url || source.sha256 !== expected.sha256 || source.extract !== expected.extract)
  )
    out.push("the plan's dataset download is not the reviewed one");
  if (adapter) {
    if (!target.adapter) out.push("this claim has no reviewed adapter, so the plan may not use one");
    else if (adapter.path !== target.adapter.path || adapterSha256(adapter.content) !== target.adapter.sha256)
      out.push(`the plan's adapter is not the reviewed adapter ${target.adapter.id}`);
  }
  return out;
}

/** Two metric parsers read the same number the same way (an omitted unit means the claim's unit). */
function sameParser(a: MetricParser, b: MetricParser, claimUnit: string): boolean {
  if ((a.unit ?? claimUnit) !== (b.unit ?? claimUnit)) return false;
  if (a.source === "stdout" && b.source === "stdout") return a.pattern === b.pattern;
  if (a.source === "json" && b.source === "json") return a.path === b.path && a.key === b.key;
  return false;
}
