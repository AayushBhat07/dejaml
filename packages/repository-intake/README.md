# DéjàML Repository Intake

Finds public GitHub repository links in page-anchored paper text and acquires one repository for inspection without executing its code.

## Safety policy

- accept only canonical `https://github.com/{owner}/{repository}` targets;
- query the fixed GitHub API origin with redirects disabled;
- reject private repositories and repositories over 100,000 KiB;
- invoke Git without a shell, interactive credentials, repository hooks, configured LFS smudge commands, submodules, or local-file transport;
- shallow-clone one branch with blob filtering and no tags;
- cap command time/output plus checked-out file count and size;
- verify the origin URL and record the full immutable commit SHA;
- clean up only internally named acquisition directories beneath the configured root.

Repository contents remain untrusted. Acquisition does not install dependencies or execute repository scripts.

## Curated verification

```bash
npm run build
npm run verify:curated --workspace @dejaml/repository-intake
```

The command acquires the curated public repository, verifies its pinned commit, prints a small JSON receipt, and removes the temporary checkout.
