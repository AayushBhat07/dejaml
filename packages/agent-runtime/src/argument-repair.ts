import type { z } from "zod";

/**
 * Some models, open-weight ones especially, send a nested object or array
 * argument as a JSON-encoded string: `{"metricParser": "{\"source\": ...}"}`
 * instead of `{"metricParser": {"source": ...}}`. That is a wire-format slip,
 * not a different answer, so the runtime decodes such a string and validates
 * the decoded value against the same schema. Nothing else is coerced: the
 * decoded value must still pass every check, and each decoded path is
 * recorded on the receipt so the repair is visible in the run record.
 */
export type ParsedToolInput<T> = { success: true; data: T; decoded: string[] } | { success: false; error: z.ZodError; decoded: string[] };

const MAX_ROUNDS = 8;

export function parseToolInput<T>(schema: z.ZodType<T>, input: unknown): ParsedToolInput<T> {
  const first = schema.safeParse(input);
  if (first.success) return { success: true, data: first.data, decoded: [] };
  let current = input;
  let issues = first.error.issues;
  const decoded: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let changed = false;
    for (const issue of issues) {
      if (!wantsStructure(issue)) continue;
      const path = issue.path as PropertyKey[];
      const value = getAt(current, path);
      if (typeof value !== "string") continue;
      const structure = decodeStructure(value);
      if (structure === undefined) continue;
      current = setAt(current, path, structure);
      decoded.push(path.map(String).join(".") || "(root)");
      changed = true;
    }
    if (!changed) break;
    const result = schema.safeParse(current);
    if (result.success) return { success: true, data: result.data, decoded };
    issues = result.error.issues;
  }
  // The model sees what was wrong with what it actually sent.
  return { success: false, error: first.error, decoded: [] };
}

function wantsStructure(issue: z.core.$ZodIssue): boolean {
  if (issue.code === "invalid_type") return issue.expected === "object" || issue.expected === "array";
  // A union of objects (for example an inline adapter or a reviewed adapter reference).
  if (issue.code === "invalid_union") return true;
  return false;
}

function decodeStructure(text: string): object | undefined {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value !== null && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function getAt(root: unknown, path: PropertyKey[]): unknown {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

/** Returns a copy of `root` with the value at `path` replaced; the original input is never mutated. */
function setAt(root: unknown, path: PropertyKey[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [key, ...rest] = path;
  const node = root as Record<PropertyKey, unknown> | unknown[];
  const copy: Record<PropertyKey, unknown> | unknown[] = Array.isArray(node) ? [...node] : { ...node };
  (copy as Record<PropertyKey, unknown>)[key as PropertyKey] = setAt(
    (node as Record<PropertyKey, unknown>)[key as PropertyKey],
    rest,
    value,
  );
  return copy;
}
