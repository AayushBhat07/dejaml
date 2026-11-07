// Re-runs the current plan review on every recorded contract in the blinding run
// records, to see which recorded plans it approves or refuses and why.
// Usage (after npm run build): node acceptance/blinding/replay-plan-review.mjs [repo root]
// STRICT=1 applies plan revision mode's output-path check. Recorded contracts are
// blinded, so a stand-in reported value is used; data hosts and packages are
// treated as allowed, so only the command, paths and adapter are re-checked.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2] ?? process.cwd();
const { reviewPolicy } = await import(join(root, "apps/api/dist/study/contract.js"));
const results = join(root, "acceptance/blinding/results");
const targets = Object.fromEntries(
  readdirSync(join(root, "config/reviewed-targets")).map((f) => {
    const t = JSON.parse(readFileSync(join(root, "config/reviewed-targets", f), "utf8"));
    return [t.caseId ?? f, t];
  }),
);
for (const dir of readdirSync(results).filter((d) => /^0\d/.test(d))) {
  const reports = join(results, dir, "reports");
  for (const file of readdirSync(reports)) {
    const r = JSON.parse(readFileSync(join(reports, file), "utf8"));
    const board = r.study?.board ?? [];
    const contracts = [r.study?.contract, ...board.filter((e) => e.payload?.contract).map((e) => e.payload.contract)].filter(Boolean);
    if (!contracts.length) continue;
    const contract = { ...contracts.at(-1), reportedValue: 12345.678, tolerance: 1 };
    const t =
      Object.values(targets).find((x) => x.adapter && r.study?.adapter?.reviewedAdapterId === x.adapter.id) ??
      Object.values(targets).find((x) => contract.command.argv.join(" ").includes(x.adapter?.path?.split("/").pop() ?? "@@"));
    const adapter = t?.adapter ? { path: t.adapter.path, content: "import subprocess", why: "w", source: "s", differences: [] } : null;
    const files = new Set([contract.entrypoint, ...(contract.dataset.source.paths ?? [])]);
    const review = reviewPolicy({
      contract,
      adapter,
      repository: { commitSha: contract.repository.commitSha, files },
      datasetPolicy: {
        allowedHosts: [new URL(contract.dataset.source.url ?? "https://x.invalid").hostname],
        maxRedirects: 3,
        maxBytes: 1,
        timeoutMs: 1,
      },
      dependencies: { screen: () => ({ refused: [] }) },
      commandTimeoutSeconds: 100000,
      strictOutputPaths: process.env.STRICT === "1",
      trustedConstraints: contract.environment.compatibilityConstraints ?? [],
    });
    const recorded = JSON.parse(
      readFileSync(join(results, dir, "results.jsonl"), "utf8")
        .split("\n")
        .find((l) => l.includes(r.runId)) ?? "{}",
    );
    const paths = review.violations.filter((v) => /resolves to/.test(v));
    console.log(
      `${dir.padEnd(32)} ${r.runId.slice(4, 12)} recorded=${(recorded.status ?? "?").padEnd(16)} now=${review.outcome.padEnd(13)} ${paths.join(" | ").slice(0, 230)}`,
    );
  }
}
