# DéjàML Research Runtime

Runs Paper Analyst and Code Analyst concurrently, reconciles their validated outputs through Lead Researcher, and applies a deterministic experiment-policy gate without exposing private reasoning.

## Runtime choices

- `HostedModelClient` is the application path. It connects to a
  server-configured OpenAI-compatible endpoint and keeps separate in-process
  transcripts per run/role; no OpenClaw installation or agent setup is needed.
- `OpenClawGatewayStructuredClient` and `OpenClawStructuredClient` remain
  legacy adapters for explicit compatibility experiments. The API does not use
  them.
- The Lab Agent chooses bounded lab actions through the application loop;
  the Lab Manager owns execution and validates the approved plan.

OpenClaw source has not yet been embedded. The next runtime extraction must
preserve upstream and third-party notices.

Curated examples may provide a visible model/dataset/metric target hint to both concurrent analysts. The hint narrows selection but never overrides evidence; either analyst must return `inconclusive` when the target is unsupported.

## Evidence limits

- prioritized paper evidence: 180,000 characters total, 24,000 per page;
- repository evidence: 500,000 transmitted characters and 80 files; ordinary files are capped at 250,000 raw bytes, while notebooks may be up to 10 MiB before outputs are stripped;
- ignore symlinks, data/output/build directories, credential-like files, and binary files;
- strip notebook outputs and redact common token formats;
- cross-check returned page references, repository identity, commit, file paths, and file hashes.

## Verification

```bash
npm run check
```

The older `verify:curated:live` scripts explicitly exercise the legacy
OpenClaw adapter and are not part of the hosted application path.
