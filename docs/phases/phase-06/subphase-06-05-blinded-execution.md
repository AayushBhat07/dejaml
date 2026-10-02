# Sub-phase 6.5 — Cryptographically verifiable blinded execution

**Status:** `IN PROGRESS` (built and verified with deterministic tests and real Docker; the real-model acceptance run through Cheaper Inference is pending on the owner's machine)
**Completed:** `—`
**Commit:** `fill after the real-model acceptance run`
**Owner:** `Claude`

## Objective

The agents that plan, run and judge a reproduction never learn the paper's
reported value. The value is sealed under a commitment before any agent
exists, the measurement and the blind review are locked under their own
commitments, and only then is the value revealed, verified against its
commitment, and compared with the observation in ordinary code.

## Architecture

Three domains:

- **Sealed** — the paper's target (`apps/api/src/study/blinding.ts`
  `sealTarget`): `{schemaVersion, caseId, caseVersion, paperSha256,
  claimLocator, metric, reportedValue, tolerance, comparisonRule, nonce}`,
  canonical JSON (sorted keys), a 32-byte random nonce, and
  `commitment = sha256(canonical)`. Stored once in the run store; the public
  `target_sealed` event carries only `caseId`, `commitment`, `metric` and
  `sealedAt`.
- **Execution** — what blind agents and labs see: the execution claim and
  contract (`executionClaim`, `executionContract`: no reported value, tolerance
  or paper reference; the metric carries only its direction), and the
  repository **projection** (`projection.ts`): notebook outputs, execution
  counts and widget state stripped, documentation with the value withheld,
  code and data byte for byte, and a projection hash recorded.
- **Comparison** — after the reveal: `compareRevealed` computes
  `absoluteDelta = |observed − reported|` (rounded to 1e-9) and
  `withinTolerance` in code. The status comes from `decideStatus` with the
  blind verdicts as caps; the Supervisor can only lower it.

The ledger (`packages/run-store/src/blinding.ts`, `BlindingLedger`) accepts
the phases only in this order, with immutable rows:

```text
target_sealed → agents_started → execution_completed → observation_locked →
blind_review_locked → target_revealed → deterministic_comparison → final_status
```

- **Observation commitment:** `lockObservation` hashes the canonical
  observation: run, round, metric and parser, plan digest, repository commit,
  manifest and projection hashes, environment digest (lab image, wheel
  manifest, platform), datasets, and per Engineer the receipt, exit code,
  stdout/stderr hashes, artifacts and parsed value.
- **Blind review commitment:** `sha256(canonical({observationCommitment,
  reviews}))`; reviewers return `equivalence` (`equivalent`,
  `partially_equivalent`, `not_equivalent`, `insufficient_evidence`) without a
  verdict, and the verdict is derived in code.
- **Reveal:** only when the last phase is `blind_review_locked` and the study
  was neither cancelled nor failed. The sealed commitment and the observation
  commitment are both recomputed; a mismatch is a typed
  `BlindingIntegrityError` and the study fails rather than compare.

### Visibility

| Role | Paper value | Paper tools | What it gets |
| --- | --- | --- | --- |
| Paper Analyst | yes | yes | the paper; its history is never shared |
| Repository Analyst | no | no | the projection; its handoff is withheld |
| Reproduction Planner | no | no | execution claim; a plan stating an expected result is refused |
| Lab Engineer, Debugger | no | no | execution contract, projection mounted read-only |
| Independent Reviewer | no | no | execution contract, observation commitment; returns equivalence only |
| Supervisor | after the reveal | no | computed status; may only lower it |
| Browser / public report | after the reveal | — | commitments and phases; values only after `target_revealed` |
| Administrator | always | — | `GET /api/runs/:id/audit` with `x-dejaml-admin-token` |

The agent runtime's request guard refuses, before it is sent, any model
request from a blind agent whose system prompt or user messages contain the
value (detected forms with three or more significant digits, on both the
fraction and percent scales). Adapters and commands that hold the value, or
that compare with or print a fixed result, are refused by policy.

### Proof

`proveBlinding` (`apps/api/src/study/blinding-proof.ts`) re-checks a finished
study from the stored ledger, agent histories and events (10 checks), and the
server attaches it to every report as `blindingProof`.
`accept-real-paper.mjs` runs `npm run test:blinding` before uploading anything
and refuses to start if a leakage test fails; afterwards it requires every
server check and repeats the commitment, order, event-stream and comparison
checks itself.

## Delivered

- Cheaper Inference as a fixed trusted gateway (`cheaper_inference`,
  `https://api.cheaperinference.com/v1`, `claude-sonnet-5.5` only), labelled
  "trusted third-party gateway", with zero-data-retention disabled disclosed.
- Sealed target, ledger, projection, observation and blind-review locks,
  verified reveal, deterministic comparison, public and audit reports.
- Web: Blinding panel, sealed claim in New Study, values only after the
  reveal, 8-milestone live capture script.

## Verification

```text
npm ci && npm audit && npm run check
npm run test:blinding
npm run verify:docker -w @dejaml/lab-manager
npm run verify:docker -w @dejaml/prep
npm run verify:failures -w @dejaml/api
node apps/api/scripts/verify-study-docker.mjs
```

**Observed result (2026-10-01, cloud container, linux/amd64):** `npm ci`,
`npm audit` (0 vulnerabilities) and `npm run check` exit 0 (API 114 tests,
web 57, run-store blinding 4, sentinel/blinding/projection 19). Both
`verify:docker` suites and `verify:failures` exit 0.
`verify-study-docker.mjs` on pyts BOSS/GunPoint (scripted agents,
infrastructure only): all 25 checks pass, including the 10 blinding checks;
phases 1–8 in order, commitment `8d591fa3…149825` verified, observed 1 vs
revealed 1 (delta 0, tolerance 0.02), blind verdict `partially_equivalent`,
status `partially_reproduced`, cleanup verified. The stand-in capture run
produced all 8 milestones with no paper value in any pre-reveal screenshot.

## Known limitations

- A low-entropy value (pyts reports 1.0) has no distinctive written form, so
  text detection cannot find it; its blinding relies on structural removal
  (no value fields, projection, withheld documentation), which the tests
  check by field.
- Without a reviewed target, the Repository Analyst runs beside the Paper
  Analyst before the claim is sealed, so documentation it reads cannot be
  withheld; notebook outputs are still stripped and its handoff is redacted.
- The live terminal shows the lab's fresh stdout (the observed value) before
  the lock; that is the measurement, not the paper's value.
- Cheaper Inference is a third party with zero-data-retention disabled.

## Restore procedure

1. `npm ci && npm run build`
2. `npm run test:blinding` — must pass before any real run.
3. `node apps/api/scripts/verify-study-docker.mjs` with Docker running.

## Remaining work

- The real pyts BOSS/GunPoint acceptance run through Cheaper Inference, with
  the eight live screenshots, on the owner's machine.
