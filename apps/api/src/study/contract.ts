import { createHash } from "node:crypto";
import { posix } from "node:path";

import { buildPlatformSpec, type ClaimContract, ClaimContractSchema, type PlatformSpec } from "@dejaml/contracts";
import type { FetchPolicy } from "@dejaml/net-guard";
import { findLiteral } from "@dejaml/research-runtime";

import type { DependencyPort } from "./context.js";
import type { PaperClaim, Plan } from "./roles.js";
import { type ClaimTarget, targetViolations } from "./targets.js";

/**
 * Deterministic reconciliation and policy review. The Planner proposes; this
 * code turns the Paper Analyst's claim and the plan into one bounded claim
 * contract, refuses anything outside policy, and fixes the plan digest that
 * every later stage checks against. No model decides any of it.
 */

/** Tolerance by the paper's unit: 2 percentage points, or 0.02 on a 0-1 scale. */
export const TOLERANCE = { percent: 2, fraction: 0.02, score: 0.02 } as const;

/** Canonical JSON: object keys sorted, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return item;
  });
}

export function planDigest(contract: ClaimContract, adapter: Plan["adapter"]): string {
  return createHash("sha256").update(canonicalJson({ contract, adapter })).digest("hex");
}

export type Reconciled = { ok: true; contract: ClaimContract; adapter: Plan["adapter"] } | { ok: false; reasons: string[] };

/** Builds the claim contract from the claim, the plan, the pinned repository, and the platform. */
export function reconcile(input: {
  claim: PaperClaim;
  plan: Plan;
  repository: { url: string; commitSha: string };
  platform: PlatformSpec;
  /** The paper's extracted pages; when given, the excerpt must be on the cited page and hold the reported value. */
  pages?: ReadonlyArray<{ pageNumber: number; text: string }>;
  /** A reviewed target's tolerance replaces the default for its unit. */
  tolerance?: number;
}): Reconciled {
  const { claim, plan } = input;
  if (input.pages) {
    const problem = checkExcerpt(claim, input.pages);
    if (problem) return { ok: false, reasons: [problem] };
  }
  const platform = buildPlatformSpec({
    architecture: input.platform.architecture,
    python: plan.python,
    packageIndex: input.platform.packageIndex,
    glibc: input.platform.libc.version,
  });
  const candidate = {
    schemaVersion: 1 as const,
    method: claim.method,
    dataset: { name: plan.dataset.name, source: plan.dataset.source },
    split: claim.split,
    preprocessing: claim.preprocessing,
    seedPolicy: claim.seedPolicy,
    metric: claim.metric,
    reportedValue: claim.reportedValue,
    paperReference: { page: claim.page, location: claim.location, excerpt: claim.excerpt },
    repository: { url: input.repository.url, commitSha: input.repository.commitSha },
    entrypoint: plan.entrypoint,
    command: { argv: plan.command.argv, cwd: plan.command.cwd },
    environment: { platform, requirements: plan.requirements, compatibilityConstraints: plan.compatibilityConstraints },
    expectedRuntimeSeconds: plan.expectedRuntimeSeconds,
    metricParser: plan.metricParser,
    tolerance: input.tolerance ?? TOLERANCE[claim.metric.unit],
    stopConditions: plan.stopConditions,
  };
  const parsed = ClaimContractSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reasons: parsed.error.issues.map((issue) => `${issue.path.join(".") || "contract"}: ${issue.message}`) };
  }
  return { ok: true, contract: parsed.data, adapter: plan.adapter };
}

/** Whitespace- and compatibility-normalized text, so PDF line breaks and ligatures do not matter. */
function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** The claim's excerpt must be copied from its page and contain the reported value as a number. */
export function checkExcerpt(
  claim: Pick<PaperClaim, "page" | "excerpt" | "reportedValue">,
  pages: ReadonlyArray<{ pageNumber: number; text: string }>,
): string | null {
  const page = pages.find((item) => item.pageNumber === claim.page);
  if (!page) return `the claim cites page ${claim.page}, which the paper does not have`;
  const excerpt = normalizeText(claim.excerpt);
  if (!normalizeText(page.text).includes(excerpt)) return `the claim's excerpt is not on page ${claim.page} verbatim`;
  const numbers = excerpt.match(/-?\d+(?:\.\d+)?/gu) ?? [];
  if (!numbers.some((item) => Number(item) === claim.reportedValue))
    return `the claim's excerpt does not contain the reported value ${claim.reportedValue}`;
  return null;
}

export type PolicyReview = {
  /** `policy_blocked` refuses the study; `inconclusive` means the plan is unusable but not forbidden. */
  outcome: "approved" | "policy_blocked" | "inconclusive";
  violations: string[];
  warnings: string[];
  planDigest: string;
};

/** A regular expression with exactly one capture group, or the reason it is not. */
export function checkMetricPattern(pattern: string): string | null {
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "u");
  } catch (error) {
    return `the metric pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }
  const groups = (new RegExp(`${expression.source}|`, "u").exec("")?.length ?? 1) - 1;
  return groups === 1 ? null : `the metric pattern must have exactly one capture group (it has ${groups})`;
}

/**
 * The deterministic policy review. It checks the contract against the pinned
 * checkout, the administrator's dataset and package policies, and the lab's
 * limits. Anything it refuses never reaches preparation or a lab.
 */
export function reviewPolicy(input: {
  contract: ClaimContract;
  adapter: Plan["adapter"];
  repository: { commitSha: string; files: ReadonlySet<string> };
  datasetPolicy: FetchPolicy;
  dependencies: DependencyPort | null;
  commandTimeoutSeconds: number;
  /** The project-owned constraints file; a plan constraint outside it is refused. */
  trustedConstraints: ReadonlyArray<{ requirement: string; reason: string }>;
  /** A reviewed claim target narrows what is accepted; it never relaxes a check. */
  target?: ClaimTarget | null;
}): PolicyReview {
  const { contract, adapter } = input;
  const blocked: string[] = [];
  const unusable: string[] = [];
  const warnings: string[] = [];
  const exists = (path: string): boolean =>
    input.repository.files.has(path) || [...input.repository.files].some((file) => file.startsWith(`${path.replace(/\/$/u, "")}/`));

  if (contract.repository.commitSha !== input.repository.commitSha)
    unusable.push("the contract names a different commit than the pinned checkout");
  if (!input.repository.files.has(contract.entrypoint))
    unusable.push(`the entry point ${contract.entrypoint} is not a file in the pinned checkout`);

  // The command: `python <script> [args]`, where the script resolves to the entry point or the declared adapter.
  const [program, script] = contract.command.argv;
  const cwd = contract.command.cwd;
  if (program !== "python") unusable.push("the command must start with `python`");
  if (cwd !== "repo" && cwd !== "work/repo") unusable.push("the command must run from `repo` or `work/repo`");
  if (script === undefined || script.startsWith("-")) {
    unusable.push("the command must name a script file (no `-c` or `-m`)");
  } else {
    const resolved = posix.isAbsolute(script)
      ? posix.normalize(script).replace(/^\/workspace\/case\//u, "")
      : posix.normalize(posix.join(cwd, script));
    const allowed = new Set([posix.join(cwd, contract.entrypoint), ...(adapter ? [adapter.path] : [])]);
    if (!allowed.has(resolved)) unusable.push(`the command runs ${script}, which is neither the entry point nor the declared adapter`);
  }
  if (adapter) {
    warnings.push(`an adapter (${adapter.path}) wraps the official code; the result can be at most partially reproduced`);
    const literal = findLiteral(contract.reportedValue, [adapter.content]);
    if (literal) unusable.push(`the adapter contains the paper's reported value ${literal}`);
  }
  if (findLiteral(contract.reportedValue, [contract.command.argv.join(" ")])) {
    unusable.push("the command contains the paper's reported value");
  }

  // Data: repository files, or an allowlisted, checksummed download.
  const source = contract.dataset.source;
  if (source.kind === "repository") {
    const missing = source.paths.filter((path) => !exists(path));
    if (missing.length) unusable.push(`dataset paths not in the pinned checkout: ${missing.join(", ")}`);
  } else if (source.kind === "package") {
    // The data is identified by the wheel's hash, so the package must be pinned exactly.
    const name = packageName(source.package);
    const pinned = contract.environment.requirements.some((line) => {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*===?\s*[A-Za-z0-9.+!_-]+\s*$/u.exec(line);
      return match !== null && packageName(match[1] ?? "") === name;
    });
    if (!pinned)
      unusable.push(`the dataset comes from package ${source.package}, which the plan must pin exactly (${source.package}==<version>)`);
    if (source.path.split("/").includes("..") || source.path.startsWith("/"))
      unusable.push("the dataset path inside the package must be relative");
  } else {
    let host = "";
    try {
      const url = new URL(source.url);
      host = url.hostname.toLowerCase();
      if (url.protocol !== "https:") blocked.push("dataset downloads must use HTTPS");
      if (url.username || url.password) blocked.push("dataset URLs must not carry credentials");
    } catch {
      blocked.push("the dataset URL is not a valid URL");
    }
    if (host && !input.datasetPolicy.allowedHosts.map((item) => item.toLowerCase()).includes(host)) {
      blocked.push(`dataset host ${host} is not on the administrator's allowlist`);
    }
    if (source.sha256 === null) blocked.push("a downloaded dataset needs its SHA-256; unchecksummed data is not used");
  }

  // Dependencies: no URLs, paths, source builds, or GPU packages.
  if (input.dependencies) {
    const screen = input.dependencies.screen(
      [...contract.environment.requirements, ...contract.environment.compatibilityConstraints.map((item) => item.requirement)],
      contract.environment.platform,
    );
    for (const refusal of screen.refused) blocked.push(`${refusal.requirement}: ${refusal.reason} (${refusal.code})`);
  } else if (contract.environment.requirements.length > 0) {
    blocked.push("dependency preparation is disabled on this server, and the plan needs Python packages");
  }
  const trusted = new Map(input.trustedConstraints.map((item) => [normalizeConstraint(item.requirement), item.reason]));
  for (const constraint of contract.environment.compatibilityConstraints) {
    const reason = trusted.get(normalizeConstraint(constraint.requirement));
    if (reason === undefined) {
      blocked.push(`compatibility constraint ${constraint.requirement} is not in the project's trusted constraints file`);
    } else {
      warnings.push(`compatibility change: ${constraint.requirement} (${reason})`);
    }
  }

  if (contract.expectedRuntimeSeconds > input.commandTimeoutSeconds) {
    blocked.push(
      `the expected runtime (${contract.expectedRuntimeSeconds} s) exceeds the lab's command limit (${input.commandTimeoutSeconds} s)`,
    );
  }
  if (contract.metricParser.source === "stdout") {
    const problem = checkMetricPattern(contract.metricParser.pattern);
    if (problem) unusable.push(problem);
  }

  if (input.target) unusable.push(...targetViolations(input.target, { contract, adapter }));

  const outcome = blocked.length ? "policy_blocked" : unusable.length ? "inconclusive" : "approved";
  return { outcome, violations: [...blocked, ...unusable], warnings, planDigest: planDigest(contract, adapter) };
}

/** Whitespace- and case-insensitive form of a constraint line, for matching against the trusted file. */
function normalizeConstraint(requirement: string): string {
  return requirement.replace(/\s+/gu, "").toLowerCase();
}

/** PEP 503 normalized package name. */
function packageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, "-");
}
