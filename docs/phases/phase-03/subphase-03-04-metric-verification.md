# Sub-phase 3.4 — Metric Verification

**Status:** `DONE`
**Completed:** `2026-09-28`
**Commit:** `c2e822c`
**Owner:** `Claude`

## Objective

Extract the observed metric, normalize units, calculate differences, and generate an assessment.

## Delivered

- Added `@dejaml/result-verifier`:
  - `extractMetric` for JSON keys, CSV columns, and stdout patterns. JSON artifacts are rehashed against the attempt's recorded digest, and prototype keys are refused.
  - `convertMetricValue` for fraction ↔ percent.
  - `assessResult`, with seven blocking comparability checks, a non-blocking seed check, rounded signed and absolute differences, a tolerance verdict, labelled hypotheses, evidence, and limitations. It returns a schema-valid `Assessment`.
  - `describeAssessment` for the public one-line summary.
  - `verifyResult`, which emits `result_verifier` events and turns extraction failures into `inconclusive`.
- Added `comparison.tolerance` (1.0 percentage point) to `cases/urban-land-cover/case.json`.
- `verify:curated` in the Lab Manager now passes the real artifact through `verifyResult` and expects `different_result` at −1.78 pp.

## Files changed

- `packages/result-verifier/src/extract.ts` — metric extraction and unit conversion.
- `packages/result-verifier/src/assess.ts` — assessment, summary, and events.
- `packages/result-verifier/src/verifier.test.ts` — 10 tests using the real policy, case manifest, and runner output shape.
- `packages/result-verifier/README.md` — flow and verdicts.
- `cases/urban-land-cover/case.json` — comparison tolerance.
- `services/lab-manager/scripts/verify-curated.mjs` — chain into the verifier.
- `docs/decisions/0012-result-verification.md` — verification decision.

## Decisions and deviations

- **Tolerance of 1.0 percentage point** for the curated case. With the observed 79.88% against 81.66%, the demo verdict is `different_result`. This threshold is a product choice that the owner can change in `case.json`.
- The seed check is reported but does not block, so the comparison still happens and the unknown seed is shown as a finding.
- Hypotheses are attached only to a `different_result` and always start with `Hypothesis:`.

## Verification

```bash
find packages services -name dist -maxdepth 2 -exec rm -rf {} +
npm ci
npm run check
npm audit --audit-level=moderate
git diff --check
```

**Observed result** (Linux amd64 cloud container, Node 22.22.2):

```text
npm run check: 7 workspaces, 73 tests passed (10 new in result-verifier)
Curated assessment from the runner's result shape:
  comparable=true, paper 81.66, observed 79.88, signed −1.78, |Δ| 1.78, tolerance 1.0
  verdict different_result, 5 hypotheses (unstated seed + 4 documented discrepancies)
  summary "Observed 79.88%, which is 1.78 percentage points below the paper"
Tampered artifact bytes: refused with artifact_digest_mismatch
Timeout, modified attempt, wrong metric, score unit, unknown split: inconclusive
npm audit: 0 vulnerabilities
```

**Not executed here:** `verify:curated`, for the reasons in the 3.2 record. It fails fast with `image_missing`.

## Known limitations

- The observed unit is not recorded in the artifact; the policy's key implies it.
- CSV support excludes quoted fields.
- Stdout patterns come from the reviewed policy and are not protected against catastrophic backtracking.
- One attempt is compared; variance across seeds is not measured.

## Restore procedure

1. Run `npm ci` and `npm run check`; require 73 passing tests.
2. Confirm `cases/urban-land-cover/case.json` has `comparison.tolerance: 1.0` unless a change was deliberately recorded.
3. With the image and dataset present, run `npm run build` and `npm run verify:curated --workspace @dejaml/lab-manager`; require `verdict: different_result` and `signedDifference: -1.78`.

## Remaining work

- Assemble the report from plan, attempt, logs, assessment, and cleanup receipt (5.1).
- Render the comparison in the Findings screen (4.3).

## Next sub-phase

`4.1 — New Study and application shell`
