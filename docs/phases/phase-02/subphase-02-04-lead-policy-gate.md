# Sub-phase 2.4 — Lead Researcher and Policy Gate

**Status:** `DONE`
**Completed:** `2026-09-28`
**Commit:** `e84de5c`
**Owner:** `Codex`

## Objective

Reconcile the validated Paper Analyst and Code Analyst records into one bounded experiment proposal, then permit lab preparation only when deterministic application policy approves every material field.

## Delivered

- Added structured Lead Researcher `ready`/`inconclusive` decisions.
- Added a dedicated `dejaml-lead` local agent with its own workspace, no channel bindings, and only `session_status` available.
- Added one committed Urban Land Cover experiment policy covering immutable repository, dataset, adapter, command, resources, metric extraction, attempts, and stop conditions.
- Explicitly separated repository code evidence from the SHA-256-pinned DéjàML execution adapter.
- Added deterministic plan checks and a canonical approved-plan digest.
- Added public Lead and policy events with no private reasoning trace.
- Added approval, rejection, and inconclusive orchestration tests plus mutation tests for sensitive plan fields.
- Added a live verifier spanning PDF intake, repository discovery/acquisition, parallel analysts, Lead reconciliation, and policy approval.

## Verification

```bash
npm run check
npm audit --audit-level=moderate

OPENCLAW_BIN=/absolute/path/to/openclaw \
  npm run verify:curated:plan:live --workspace @dejaml/research-runtime

git diff --check
```

**Observed live result:**

```text
Paper Analyst: ready
Code Analyst: ready
Lead Researcher: ready
Policy approved: true
Failed policy checks: none
Plan digest: 9edc21b2459124c96570d6cba4b13adaa21087ea53b22ece0e8346945f9066ea
Final run status: preparing_lab
Public events: 8, ordered
Elapsed: 58.670 seconds
Temporary checkout cleanup: confirmed
```

## Security outcome

- The model never self-approves.
- Commands remain argv arrays and must exactly match policy.
- Network remains disabled during execution.
- Dataset and adapter inputs are checksum pinned.
- Resource and attempt counts cannot exceed policy.
- Unknown preparation or stop conditions are rejected.
- Provider credentials are not included in prompts, events, plans, or the future lab.

## Known limitations

- Only the curated Urban Land Cover case has an executable policy.
- The local Gateway agent entry is machine configuration and must be recreated elsewhere.
- Anonymous arXiv/GitHub availability and model variance can make a live analysis conclude `Inconclusive`.
- Phase 2.4 authorizes a plan but intentionally does not create or execute a lab.
- The adapter checksum must be re-reviewed whenever `runner.py` changes.

## Restore procedure

1. Install Node.js 24+, Git, and OpenClaw `2026.9.5`.
2. Run `npm install` and `npm run check`.
3. Recreate all three dedicated role agents using the restoration runbook.
4. Verify the committed policy and `runner.py` SHA-256 agree.
5. Run the complete live verifier and require `policyApproved: true` and final state `preparing_lab`.

## Remaining work

- Build and pin the disposable Python CPU image.
- Make Lab Manager verify the approved plan digest and adapter digest before execution.
- Add actual lab lifecycle, cleanup receipt, metric verification, and report generation.

## Next sub-phase

`3.1 — Python CPU image`
