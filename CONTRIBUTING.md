# Contributing to DéjàML

Thank you for your interest in DéjàML. Bug reports, questions, case proposals
and pull requests are all welcome.

## Getting help and reporting problems

- **Questions and bug reports:** open an issue at
  <https://github.com/AayushBhat07/dejaml/issues>. Include the command you ran,
  your operating system, Node.js and Docker versions, and the first error in
  the output. For a failed study, attach the sanitized report from
  `artifacts/acceptance/` if you have one; never attach `.env.local` or an API
  key.
- **Security issues** (for example a way to give a lab network access or to
  read the sealed target from an agent tool): please do not open a public
  issue. Email the maintainer at aayushbhat747@gmail.com instead.

## Setting up a development copy

```bash
git clone https://github.com/AayushBhat07/dejaml.git
cd dejaml
npm run bootstrap   # needs Node.js 24+, Python 3 and a running Docker engine
```

Before opening a pull request, run the same checks as continuous integration:

```bash
npm run check
```

This builds every workspace and runs type-checking, ESLint, Prettier and all
tests. Changes to the lab or preparation containers should also pass
`npm run verify:docker -w @dejaml/lab-manager` and
`npm run verify:docker -w @dejaml/prep`.

## Pull requests

- Keep each pull request to one change, with tests for new behaviour.
- Do not weaken a guarantee to make a test pass: lab isolation, target sealing
  and the deterministic status rules are the point of the project. If a change
  touches them, say so in the pull request and explain why it is safe.
- Follow the existing style; Prettier and ESLint are enforced.
- Describe what you changed and how you checked it.

## Adding a paper case

A case is a JSON file under `acceptance/cases/` naming the paper, its pinned
repository commit, dataset sources with checksums and the claim's tolerance.
See the existing cases and `docs/phases/` for how they were added and checked.

## Project governance

DéjàML is maintained by Aayush Bhat, who reviews and merges pull requests and
decides on releases. Issues are usually answered within a week. Changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

All participants are expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
