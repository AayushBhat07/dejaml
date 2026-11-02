# Changelog

All notable changes to DéjàML are recorded here. The project follows
[Semantic Versioning](https://semver.org/); while it is below 1.0, minor
versions may change interfaces. Detailed records of each development phase are
in [docs/phases/](docs/phases/).

## [Unreleased]

### Added

- Software paper for Science of Computer Programming (`paper/scp/`),
  contributing guide, code of conduct, citation file and this changelog.

### Fixed

- A web test that compared two renders of the live clock could fail when the
  renders fell in different seconds; the test now pins the clock.
- The README reported the Urban Land Cover run as _Partially reproduced_
  within ±2 pp; its sealed tolerance is 1 pp and the recorded status is
  _Not reproduced_.

## [0.1.0] - 2026-11-01

First public development line, built from 28 September to 1 November 2026.

### Added

- PDF intake with page-anchored text and repository discovery; guarded
  repository acquisition at a pinned commit (September 2026).
- Paper and repository analysts running in parallel, and a deterministic
  policy gate for experiment plans (September 2026).
- Pinned Python CPU lab image and a Lab Manager that runs offline,
  non-root, resource-limited Docker labs and verifies their removal
  (September 2026).
- Metric verification, the web interface and an end-to-end Urban Land Cover
  vertical slice, with a one-command `npm run bootstrap` (September 2026).
- Native multi-agent study runtime with seven agents, a typed evidence board,
  SHA-256 target sealing and deterministic status decisions; Anthropic, OpenAI
  and OpenAI-compatible providers (#4, October 2026).
- Real-model acceptance cases for pyts BOSS on GunPoint, ROCKET on ECG200 and
  Urban Land Cover (October 2026).
- 3D Research Campus view of a live study (#7) and the Inside DéjàML explainer
  site (#19, #22).
- Research conditions for a blinded versus sighted study, a smoke-test
  matrix, an unguarded-lab comparison arm and released run records
  (#18, #21, #24, #25).

### Fixed

- Show Docker's own error when the lab image fails to prepare (#6).
- Save downloads whose names contain an encoded `+` under a safe name (#23).
