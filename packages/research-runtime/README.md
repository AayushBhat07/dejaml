# DéjàML Research Runtime

Runs Paper Analyst and Code Analyst concurrently, reconciles their validated outputs through Lead Researcher, and applies a deterministic experiment-policy gate without exposing private reasoning.

## Runtime choices

- `OpenClawGatewayStructuredClient` is the demo path for OAuth-backed models. It targets three dedicated Gateway agents with separate sessions.
- `OpenClawStructuredClient` is the headless path for API-key or local providers that can run through isolated `openclaw agent exec` state.
- Both paths are hidden behind `StructuredModelClient`; product events use research-role names only.

The integration is pinned and tested against OpenClaw `2026.9.5`. The installed OpenClaw CLI remains an external MIT-licensed runtime dependency; no upstream source is copied into this package.

Curated examples may provide a visible model/dataset/metric target hint to both concurrent analysts. The hint narrows selection but never overrides evidence; either analyst must return `inconclusive` when the target is unsupported.

## Dedicated Gateway agents

The local demo uses:

- `dejaml-paper` → identity `Paper Analyst`
- `dejaml-code` → identity `Code Analyst`
- `dejaml-lead` → identity `Lead Researcher`

Each agent must have:

```json
{
  "model": "openai/gpt-5.6-sol",
  "models": {
    "openai/gpt-5.6-sol": { "agentRuntime": { "id": "codex" } }
  },
  "tools": {
    "profile": "minimal",
    "allow": ["session_status"]
  }
}
```

They must have separate workspaces and no channel bindings. The model sees only prompt-bundled evidence; it cannot read the acquired repository directly.

## Evidence limits

- prioritized paper evidence: 180,000 characters total, 24,000 per page;
- repository evidence: 500,000 transmitted characters and 80 files; ordinary files are capped at 250,000 raw bytes, while notebooks may be up to 10 MiB before outputs are stripped;
- ignore symlinks, data/output/build directories, credential-like files, and binary files;
- strip notebook outputs and redact common token formats;
- cross-check returned page references, repository identity, commit, file paths, and file hashes.

## Verification

```bash
npm run check

OPENCLAW_BIN=/absolute/path/to/openclaw \
  npm run verify:curated:live --workspace @dejaml/research-runtime
```

The analyst-only verifier downloads the curated paper, discovers and acquires its repository, runs both analyst sessions concurrently, prints public statuses, and cleans up the checkout.

For the complete research-plan handoff:

```bash
OPENCLAW_BIN=/absolute/path/to/openclaw \
  npm run verify:curated:plan:live --workspace @dejaml/research-runtime
```

This adds Lead Researcher reconciliation and requires the deterministic gate to approve the committed case policy before the run may enter `preparing_lab`.
