# ADR 0002 — Use a Deterministic Repository-Faithful Protocol

**Status:** Accepted  
**Date:** 2026-09-28

## Context

The paper describes a stratified validation split and reuse of training normalization statistics. The linked notebook uses neither, and leaves the validation split seed unspecified. Searching for a seed that recreates the reported result would undermine the audit.

## Decision

The initial run follows the repository notebook's split and scaling behavior but fixes the missing validation seed to 42. The generated result states that seed 42 is a DéjàML choice and lists the paper/code discrepancies.

## Consequences

- The experiment is deterministic and restorable.
- The result may differ from the paper, which is an expected and useful finding.
- A later version may add a separately labelled paper-faithful attempt, but it must not overwrite or replace this baseline.

