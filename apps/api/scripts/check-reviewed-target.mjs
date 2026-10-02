// Checks one reviewed claim target against its real sources before anyone runs it:
// the paper PDF's SHA-256, that the reviewed excerpt is on the cited page (and
// the text around it, for a human to compare with the table), that the pinned
// commit exists in the repository and holds the entry point, and that the
// adapter file still matches its reviewed hash (the registry refuses it otherwise).
// Nothing is executed from the repository and no model is called.
//
//   npm run build && node apps/api/scripts/check-reviewed-target.mjs <caseId> <paper.pdf>
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ingestPdf } from "@dejaml/paper-intake";

import { checkTargetPaper, loadReviewedTargets } from "../dist/study/index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [caseId, paperArgument] = process.argv.slice(2);
if (!caseId || !paperArgument) {
  console.error("usage: node apps/api/scripts/check-reviewed-target.mjs <caseId> <paper.pdf>");
  process.exit(2);
}
// Loading verifies the schema, the excerpt-contains-value rule and the adapter's hash.
const target = (await loadReviewedTargets(join(projectRoot, "config/reviewed-targets"), projectRoot)).get(caseId);
if (!target) {
  console.error(`No reviewed target ${caseId} in config/reviewed-targets.`);
  process.exit(2);
}
const results = [];
const check = (name, pass, info = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${info ? `\n      ${info}` : ""}`);
};
check(
  "target loads; adapter matches its reviewed hash",
  true,
  target.adapter ? `${target.adapter.id} ${target.adapter.sha256}` : "no adapter",
);

const paper = await ingestPdf({ fileName: "paper.pdf", data: new Uint8Array(await readFile(resolve(paperArgument))) });
check("paper SHA-256 is the reviewed one", paper.file.sha256 === target.paper.sha256, paper.file.sha256);
const refusal = checkTargetPaper(target, { sha256: target.paper.sha256, pages: paper.pages });
check(`excerpt "${target.claim.excerpt}" is on page ${target.claim.page}`, refusal === null, refusal ?? "");
const page = paper.pages.find((item) => item.pageNumber === target.claim.page)?.text ?? "";
const at = page.includes(target.claim.excerpt) ? page.indexOf(target.claim.excerpt) : page.indexOf(String(target.claim.reportedValue));
console.log(
  `      page ${target.claim.page} around ${target.claim.reportedValue} (${target.claim.location}):\n      ${
    at < 0 ? "(value not found)" : page.slice(Math.max(0, at - 400), at + 200).replace(/\s+/gu, " ")
  }`,
);

const dir = await mkdtemp(join(tmpdir(), "dejaml-target-check-"));
try {
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  git("init", "-q");
  const fetched = git("fetch", "-q", "--depth", "1", target.repository.url, target.repository.commitSha);
  check(
    `commit ${target.repository.commitSha.slice(0, 12)} exists in ${target.repository.url}`,
    fetched.status === 0,
    fetched.stderr.trim(),
  );
  if (fetched.status === 0) {
    const listed = git("ls-tree", "--name-only", "-r", "FETCH_HEAD").stdout.split("\n");
    check(`entry point ${target.repository.entrypoint} is in the pinned tree`, listed.includes(target.repository.entrypoint));
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
process.exit(results.every(Boolean) ? 0 : 1);
