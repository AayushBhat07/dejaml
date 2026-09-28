import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ExperimentPolicySchema, type ExperimentPolicy } from "@dejaml/contracts";
import { z } from "zod";

const CaseManifestSchema = z.object({
  caseId: z.string().min(1),
  title: z.string().min(1),
  paper: z.object({
    claim: z.object({ model: z.string(), dataset: z.string(), metric: z.string() }),
  }),
  comparison: z.object({ tolerance: z.number().nonnegative() }),
  knownDiscrepancies: z.array(z.string()),
});

export type CaseManifest = z.infer<typeof CaseManifestSchema>;

/** A reviewed case: the only kind of study that may reach a lab. */
export type CuratedCase = {
  policy: ExperimentPolicy;
  manifest: CaseManifest;
};

/** Loads every `cases/<name>/` directory that has both a policy and a manifest. */
export async function loadCases(projectRoot: string): Promise<CuratedCase[]> {
  const root = join(projectRoot, "cases");
  const cases: CuratedCase[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const read = async (name: string): Promise<unknown> =>
      JSON.parse(await readFile(join(root, entry.name, name), "utf8"));
    const [policy, manifest] = await Promise.all([
      read("policy.json").catch(() => null),
      read("case.json").catch(() => null),
    ]);
    if (!policy || !manifest) continue;
    const parsed = { policy: ExperimentPolicySchema.parse(policy), manifest: CaseManifestSchema.parse(manifest) };
    if (parsed.policy.caseId !== parsed.manifest.caseId) {
      throw new Error(`case ${entry.name} has mismatched policy and manifest IDs`);
    }
    cases.push(parsed);
  }
  return cases;
}
