# ADR 0012 — Deterministic Result Verification

**Status:** Accepted
**Date:** 2026-09-28

## Context

The Result Verifier is the step a viewer trusts most, because it produces the verdict. A model must not decide whether numbers match, and a result must not be compared when the metric, unit, dataset, or split differ.

## Decision

Implement verification as deterministic TypeScript in `@dejaml/result-verifier`.

- The metric is read only by the rule in the approved plan. JSON artifacts are rehashed and must match the digest the Lab Manager recorded at the end of the attempt, so a modified or substituted artifact is refused.
- The extracted value is taken to be in the claim's unit unless the caller states otherwise. The reviewed case policy pairs each key (such as `metrics.accuracyPercent`) with its unit.
- Blocking checks run before any comparison. Any failure yields `inconclusive` with no observed value or difference.
- An unstated paper seed is reported as a failed, non-blocking `seed` check and becomes a hypothesis and a limitation. It never blocks the comparison and never triggers a seed search, per the curated-case rules.
- The tolerance is per case. Urban Land Cover uses 1.0 percentage point, recorded in `case.json`.
- Discrepancy hypotheses are copied from the reviewed case manifest and prefixed `Hypothesis:`. They are attached only to a `different_result`.

## Consequences

- With the Phase 3.1 observation of 79.88%, the curated verdict is `different_result` at −1.78 percentage points. That verdict comes with the unstated-seed hypothesis and the four documented notebook/paper differences.
- Changing the tolerance changes the demo verdict. It must be edited in `case.json` deliberately and recorded.
- Reports (5.1) can quote the assessment's checks, evidence pointers, and limitations directly.
