# DéjàML Result Verifier

Turns one finished attempt into an evidence-backed comparison with the paper claim.

## Flow

1. `extractMetric` reads the value exactly as the approved plan says:
   - `json`: a dotted key in the metric artifact, own properties only;
   - `csv`: a column in the last row (unquoted CSV only);
   - `stdout`: the last match of a pattern with exactly one capture group.

   The artifact's bytes are rehashed and must match the digest the Lab Manager recorded for the attempt.
2. `assessResult` runs comparability checks before any arithmetic: attempt completed, unmodified baseline, metric extracted, same metric definition, convertible unit, same dataset, same split. Seed behavior is reported but does not block. Only when every blocking check passes are the signed and absolute differences computed and the tolerance applied.
3. `verifyResult` does both and emits `result_verifier` events (`comparison_started`, `metric_extracted`, `comparison_completed`). Extraction failures become an `inconclusive` assessment, not an exception.

Units convert only between `fraction` and `percent`; `score` compares only with `score`. Differences are rounded to six decimals to remove floating-point noise.

## Verdicts

- `reproduced_within_tolerance`: comparable, and the absolute difference is within the case tolerance.
- `different_result`: comparable, and outside the tolerance. Known discrepancies from the case manifest are attached, each prefixed `Hypothesis:`.
- `inconclusive`: any blocking check failed.

The tolerance comes from the case manifest (`comparison.tolerance`, 1.0 percentage point for Urban Land Cover). It is a product threshold, not a test of statistical equivalence.

## Verification

```bash
npm run check
```

With the Phase 3.1 image and dataset present, `npm run verify:curated --workspace @dejaml/lab-manager` runs the real experiment and passes its artifact through `verifyResult`, expecting `different_result` at −1.78 percentage points.
