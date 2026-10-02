import { lstat, readFile } from "node:fs/promises";

import { PrepError } from "./errors.js";
import { logicalLines, parseRequirementLine, type ParsedRequirement } from "./requirements.js";

/**
 * Project-owned compatibility constraints.
 *
 * These never come from the repository being reproduced. They are written by
 * the DéjàML project (for example `cases/<id>/constraints.txt`) or passed by
 * the caller, applied with pip `-c`, and every one of them is recorded in the
 * manifest with its reason, next to what the repository itself asked for.
 * A constraint narrows what pip may choose; it never rewrites a repository
 * requirement, so a conflict fails as `resolution_conflict` instead of being
 * silently replaced.
 */

export type CompatibilityConstraint = {
  /** A PEP 508 specifier such as `numpy<2` or `scipy==1.11.4` (no extras, URLs, or options). */
  spec: string;
  /** Why the project needs it, e.g. "the paper's code uses np.float, removed in NumPy 1.24". */
  reason: string;
  source?: { file: string; line: number };
};

export type ValidatedConstraint = CompatibilityConstraint & { name: string; requirement: ParsedRequirement };

const MAX_CONSTRAINTS = 200;
const MAX_REASON = 500;
const MAX_FILE_BYTES = 64 * 1024;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function validateConstraints(constraints: readonly CompatibilityConstraint[]): ValidatedConstraint[] {
  if (constraints.length > MAX_CONSTRAINTS)
    throw new PrepError("invalid_requirement", `at most ${MAX_CONSTRAINTS} compatibility constraints are allowed`);
  const seen = new Set<string>();
  return constraints.map((constraint) => {
    const where = constraint.source ? ` (${constraint.source.file}:${constraint.source.line})` : "";
    const parsed = parseRequirementLine(constraint.spec);
    if (!parsed.ok)
      throw new PrepError("invalid_requirement", `compatibility constraint rejected${where}: ${parsed.reason}`, {
        detail: constraint.spec.slice(0, 200),
      });
    const requirement = parsed.requirement;
    if (!requirement) throw new PrepError("invalid_requirement", `empty compatibility constraint${where}`);
    if (requirement.extras.length > 0) throw new PrepError("invalid_requirement", `compatibility constraints cannot have extras${where}`);
    if (requirement.hashes.length > 0) throw new PrepError("invalid_requirement", `compatibility constraints cannot carry hashes${where}`);
    if (requirement.specifiers.length === 0)
      throw new PrepError("invalid_requirement", `compatibility constraint ${requirement.name} has no version specifier${where}`);
    const reason = constraint.reason.trim();
    if (reason === "" || reason.length > MAX_REASON || CONTROL.test(reason)) {
      throw new PrepError(
        "invalid_requirement",
        `compatibility constraint ${requirement.name} needs a reason (one line, at most ${MAX_REASON} characters)${where}`,
      );
    }
    if (seen.has(requirement.name))
      throw new PrepError("invalid_requirement", `compatibility constraint for ${requirement.name} is listed twice${where}`);
    seen.add(requirement.name);
    return { ...constraint, spec: requirement.spec, reason, name: requirement.name, requirement };
  });
}

/**
 * Parse a project constraints file. Each constraint line must carry its
 * reason as a trailing comment: `numpy<2  # reason: uses np.float`.
 */
export function parseCompatibilityConstraints(text: string, file: string): CompatibilityConstraint[] {
  const constraints: CompatibilityConstraint[] = [];
  for (const { line, text: raw } of logicalLines(text)) {
    const comment = /(^|\s)#(.*)$/u.exec(raw);
    const body = (comment ? raw.slice(0, comment.index) : raw).trim();
    if (body === "") continue;
    const reason = (comment?.[2] ?? "").trim().replace(/^reason:\s*/iu, "");
    if (reason === "")
      throw new PrepError("invalid_requirement", `${file}:${line}: every compatibility constraint needs a "# reason: …" comment`);
    constraints.push({ spec: body, reason, source: { file, line } });
  }
  validateConstraints(constraints);
  return constraints;
}

/** Read a project-owned constraints file (a regular file of at most 64 KiB; never from the repository checkout). */
export async function loadCompatibilityConstraints(path: string, label = path): Promise<CompatibilityConstraint[]> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile()) throw new PrepError("invalid_requirement", `constraints file ${label} must be a regular file`);
  if (stat.size > MAX_FILE_BYTES) throw new PrepError("invalid_requirement", `constraints file ${label} is larger than 64 KiB`);
  return parseCompatibilityConstraints(await readFile(path, "utf8"), label);
}
