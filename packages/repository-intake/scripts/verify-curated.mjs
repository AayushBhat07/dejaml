import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireGithubRepository,
  cleanupAcquiredRepository,
} from "../dist/index.js";

const expectedCommit = "49ece7ff4cc43fd4cb258678d44854f1cb2a417d";
const destinationRoot = await mkdtemp(join(tmpdir(), "dejaml-curated-verification-"));
let destination;

try {
  const acquisition = await acquireGithubRepository({
    repositoryUrl: "https://github.com/mtesha/tdl-vs-ml-urbanlandcover",
    destinationRoot,
  });
  destination = acquisition.destination;
  if (acquisition.commitSha !== expectedCommit) {
    throw new Error(
      `curated repository moved: expected ${expectedCommit}, received ${acquisition.commitSha}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        repositoryUrl: acquisition.repositoryUrl,
        commitSha: acquisition.commitSha,
        defaultBranch: acquisition.defaultBranch,
        repositorySizeKb: acquisition.repositorySizeKb,
        cleanedUp: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (destination) {
    await cleanupAcquiredRepository({ destination, destinationRoot });
  }
  await rm(destinationRoot, { recursive: true, force: true });
}
