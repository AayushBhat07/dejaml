# Sub-phase 6.1 — Audit Agent

**Status:** `DONE` (cloud-verified with stand-ins; production requires `dejaml-audit` agent in OpenClaw on the Mac)
**Completed:** `2026-09-28`
**Owner:** `Claude`

## Objective

Add an LLM-based post-run verification step that checks whether the measured metric semantically matches what the paper claimed, going beyond the seven deterministic comparability checks in the Result Verifier.

## Delivered

- **`AuditDecisionSchema`** in `@dejaml/contracts`: verdict `confirmed | uncertain | disputed`, `metricAligned` flag, free-text `summary`, structured `evidence` pointers, and a `concerns` list.
- **`"audit_agent"`** added to `ActorSchema` and `ResearchRole`.
- **`"auditing"` run status** added between `comparing` and terminal states, with allowed transitions updated in `RunStore`.
- **`runAudit()`** in `@dejaml/research-runtime/src/audit.ts`:
  - receives `paperAnalysis`, the extracted `metric`, the deterministic `assessment`, and the `plan`;
  - builds the Audit Agent prompt via `buildAuditAgentPrompt()` in `prompts.ts`;
  - emits `audit_started`, `audit_completed`, and `audit_failed` events;
  - is **non-fatal**: an audit failure (network, model error) does not abort the run — the deterministic verdict is the authoritative result.
- **Pipeline step 6** in `apps/api/src/pipeline.ts`: after `verifyResult`, if the metric was parsed and the verdict is not `inconclusive`, the pipeline transitions to `auditing`, calls `runAudit`, and records `report.audit`.
- **Web**: `Findings.tsx` renders an `AuditSection` card showing the verdict badge (`confirmed` → green, `uncertain` → neutral, `disputed` → red), the summary, and the concerns list. `ROLE_LABELS` and `STATUS_STAGE` updated for the new actor and status.
- **Stand-in**: `ScriptedModel` returns a pre-canned `confirmed` decision for the `audit_agent` role so the full pipeline test passes without a real model.
- `main.ts` reads `DEJAML_AUDIT_AGENT` env var (default `"dejaml-audit"`) and passes it to the OpenClaw gateway client.

## Files changed

- `packages/contracts/src/index.ts` — `AuditDecisionSchema`, `"audit_agent"` actor, and `"auditing"` status.
- `packages/research-runtime/src/audit.ts` — new file: `runAudit`.
- `packages/research-runtime/src/prompts.ts` — `buildAuditAgentPrompt`.
- `packages/research-runtime/src/model.ts` — `ResearchRole` union extended.
- `packages/research-runtime/src/openclaw-client.ts` — `analystAgents` type updated.
- `packages/research-runtime/src/index.ts` — re-export `audit.ts`.
- `packages/run-store/src/index.ts` — `auditing` transitions.
- `apps/api/src/pipeline.ts` — step 6 (audit), `report.audit`.
- `apps/api/src/stand-ins.ts` — `ScriptedModel` audit branch.
- `apps/api/src/main.ts` — `DEJAML_AUDIT_AGENT` wiring.
- `apps/api/src/api.test.ts` — `audit_agent:audit_completed` assertion.
- `apps/web/src/lib/lab.ts` — `AuditSummary` type, `findingsFor` extraction.
- `apps/web/src/screens/Findings.tsx` — `AuditSection` component.
- `apps/web/src/lib/roles.ts` — `audit_agent` label.
- `apps/web/src/lib/stages.ts` — `auditing` stage mapping.

## Setting up the dejaml-audit agent on your Mac

Before real-model audit runs work, create the agent in OpenClaw:

```bash
# 1. Open the OpenClaw dashboard (same place you created dejaml-paper, dejaml-code, dejaml-lead).
# 2. Create a new structured-output agent named exactly: dejaml-audit
# 3. Paste the system prompt from buildAuditAgentPrompt() in
#    packages/research-runtime/src/prompts.ts (the `systemPrompt` field).
# 4. Set the output schema to match AuditDecisionSchema:
#    {
#      "schemaVersion": 1 (literal),
#      "verdict": "confirmed" | "uncertain" | "disputed",
#      "metricAligned": boolean,
#      "summary": string (min 1 char),
#      "evidence": array of EvidencePointer objects,
#      "concerns": array of strings
#    }
# 5. Copy the agent ID that OpenClaw assigns.
# 6. Add it to .env (or export before npm start):
#    DEJAML_AUDIT_AGENT=<the-agent-id>
# 7. Restart the server: npm start
```

Until those steps are done, `runAudit` silently catches the error and the run completes without an audit card.

## Not yet proven in production

- No paper has been run with audit against a live model in this cloud environment (no OpenClaw access, no Mac Docker).

## Verification

```bash
npm run check   # all 59 tests pass, full typecheck clean
```
