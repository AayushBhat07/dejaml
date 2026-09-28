# ADR 0006 — Guarded GitHub Acquisition

**Status:** Accepted  
**Date:** 2026-09-28

## Context

A paper can contain arbitrary links, and a linked repository is untrusted code. DéjàML needs enough network access to identify and download a public repository without turning model-selected URLs into general server-side requests or executing repository content.

## Decision

Repository discovery may recognize HTTP or HTTPS GitHub links in page text, but it converts them to an evidence-bearing canonical `https://github.com/{owner}/{repository}` candidate. Acquisition accepts only that canonical form.

The trusted backend queries a fixed GitHub API endpoint with redirects disabled, confirms the repository is public and within the demo size limit, and then performs a bounded shallow clone. Git is invoked with an argument array rather than a shell; credential prompts, submodules, tags, and local-file transport are disabled. The resulting origin and full HEAD commit are verified before the checkout is made available for read-only analysis.

## Cleanup boundary

Each checkout is created with an internal prefix immediately beneath a configured absolute acquisition root. Cleanup refuses paths outside that exact boundary or paths without the managed prefix.

## Consequences

- Paper links cannot select arbitrary hosts or local paths.
- Repository acquisition is repeatable through a recorded full commit SHA.
- Renamed repositories, private repositories, oversized repositories, and ambiguous redirects stop safely.
- Repository dependency installation and execution remain separate Lab Manager responsibilities.
