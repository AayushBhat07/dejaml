# Sub-phase 2.3 — Parallel Analysts

**Status:** `DONE`  
**Completed:** `2026-09-28`  
**Commit:** `resolve with git log for parallel analysts`  
**Owner:** `Codex`

> **Note (2026-09-30):** OpenClaw is not required and not used. The OpenClaw setup steps below no longer apply. DéjàML runs its own native agents (`packages/agent-runtime`) and reaches OpenAI or Anthropic through its own provider adapters; the OpenClaw adapters and scripts referenced below were removed. This historical note is otherwise unchanged.

## Objective

Run Paper Analyst and Code Analyst as independent, truly concurrent sessions with bounded evidence, validated structured outputs, separate live events, and no general host or repository tools.

## Delivered

- Added the `@dejaml/research-runtime` package.
- Added structured `ready`/`inconclusive` contracts that do not force either analyst to fabricate an answer.
- Added prioritized page evidence with page anchors and hard context limits.
- Added read-only repository snapshotting with file/hash evidence, path and file limits, symlink/secret/output exclusions, token redaction, and notebook-output stripping.
- Added Paper Analyst and Code Analyst prompts that treat all supplied content as untrusted evidence.
- Added deterministic validation against paper pages, discovered repository candidates, approved repository identity/commit, supplied file paths, and SHA-256 hashes.
- Added genuinely concurrent orchestration with per-lane started/completed/warning/failed events and partial-success preservation.
- Added an isolated `agent exec` adapter for API-key/local-provider deployments.
- Added a Gateway adapter for dedicated OAuth-backed analyst agents.
- Created local `dejaml-paper` and `dejaml-code` agents with separate workspaces, no channel bindings, and only `session_status` available.
- Added an optional visible curated target hint so both lanes independently investigate Random Forest accuracy without waiting on each other.
- Added a full live verification from arXiv PDF through repository acquisition and both model sessions.

## Files changed

- `packages/research-runtime/` — evidence builders, prompts, provider adapters, orchestrator, tests, and live verification.
- `packages/contracts/src/index.ts` — analyst result contracts.
- `docs/decisions/0007-parallel-analyst-runtime.md` — runtime and trust-boundary decision.
- `ARCHITECTURE.md`, `ROADMAP.md`, `README.md`, restoration runbook, and dependency lockfile.
- `THIRD_PARTY_NOTICES.md` — pinned external runtime notice.

## Decisions and deviations

- Product-visible events name domain roles only; internal runtime branding stays in technical documentation.
- The local OAuth demo uses dedicated Gateway agents because isolated temporary `agent exec` state intentionally cannot borrow shared OAuth refresh ownership.
- The OpenClaw CLI contract is pinned instead of copying upstream source for the overnight build. Source-level extraction remains a later engineering decision.
- A curated target hint is transparent and evidence constrained; it cannot turn an unsupported result into `ready`.
- A 250 KB raw limit was too small for the output-heavy curated notebook. Notebooks now have a separate 10 MiB raw bound, after which outputs are removed and the transmitted text remains within the 500,000-character repository budget.

## Verification

```bash
npm run check
npm audit --audit-level=moderate

OPENCLAW_BIN=/absolute/path/to/openclaw \
  npm run verify:curated:live --workspace @dejaml/research-runtime

git diff --check
```

**Observed result:**

```text
Contracts: 4 tests passed
Paper intake: 4 tests passed
Repository intake: 5 tests passed
Research runtime: 6 tests passed
Run store and fixture: 6 tests passed
Total: 25 tests passed
Audit: 0 vulnerabilities

Live Paper Analyst: ready — Random Forest, test accuracy, 81.66%
Live Code Analyst: ready — Urban Land Cover Classification.ipynb
Live event order: Paper started, Code started, Paper completed, Code completed
Live analyst wall time: 25.635 seconds
Final run status: planning
Repository checkout cleanup: confirmed
```

## Known limitations

- The two dedicated local Gateway agent entries are machine configuration and must be recreated on another machine.
- Anonymous GitHub and arXiv network availability affect the live verification.
- The model may still return `inconclusive`; this is expected when evidence or schema requirements are not met.
- The analyst output is not yet reconciled into an executable plan. That is Phase 2.4.
- No model reasoning trace is persisted or shown.

## Restore procedure

1. Install Node.js 24+, Git, and OpenClaw `2026.9.5`.
2. Run `npm install` and `npm run check`.
3. Create `dejaml-paper` and `dejaml-code` in separate workspaces outside the repository.
4. Give both the selected model/runtime, no channel bindings, and only `tools: { profile: "minimal", allow: ["session_status"] }`.
5. Run `openclaw agents list --json` and inspect both agent entries before any model call.
6. Run the live verification command above and require both `ready` results plus the expected event order.
7. Confirm temporary paper prompts and repository checkouts were removed.

## Remaining work

- Reconcile both validated records through Lead Researcher.
- Apply deterministic plan policy before any lab is created.
- Expose stored events through the HTTP/SSE API.

## Next sub-phase

`2.4 — Lead Researcher and policy gate`
