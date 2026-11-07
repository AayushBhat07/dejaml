# Sub-phase 6.8 — Open-weight models in the study

**Status:** `IN PROGRESS` (built and verified with deterministic tests and a replay of the recorded runs; no real open-model run yet)
**Completed:** `—`
**Commit:** `fill after the first open-model run`
**Owner:** `aayush`

## Objective

Get an open-weight coding model through the whole blinded study (plan review
through execution) on the same harness, without weakening the plan review that
stopped the weaker models. This is the first step toward a follow-up study that
records one agent session on a locally served model with deterministic
inference and replays it, changing only the number shown to the agents.

## Why the weaker models failed

Every non-Sonnet run in `acceptance/blinding/results/` (`04` Haiku 4.5, `05`
Haiku 5.5, `06` Qwen3-Coder-30B-A3B) ended before a valid measurement. The run
records show three causes, none of them about the claim itself:

| Cause | Runs | What happened |
| --- | --- | --- |
| Object sent as a JSON string | Qwen3-Coder, 4 of 4 | The Planner sent `metricParser` as `"{\"source\": ...}"`. The runtime refused it six or more times ("expected object, received string") and the Planner gave up with a correct plan in its reason. |
| Adapter path from the wrong cwd | Haiku 4.5 and 5.5, 6 of 9 | The prompt's example (`../work/adapter/<file>.py` from `repo`) was used with cwd `work/repo`, which resolves to `work/work/adapter/...`. The plan review refused it correctly. |
| Output written relative to cwd | Haiku 4.5 and 5.5, 2 of 9 | `--output artifacts/result.json` from `work/repo` writes `work/repo/artifacts/result.json`, but the lab reads `/workspace/case/artifacts/result.json`. The plan review did not check this, so the run executed and then failed to parse the metric. |

One Haiku 5.5 run planned `inconclusive` because it read `dependency_check`'s
package list as "wheel availability unconfirmed".

The same output-path mistake is in 6 Sonnet plans (smoke `168baafd`, `482ba41f`,
`9eedd0ad`, `ed21198a`, `facb8e14`, and r-STSF `3c23e8c2`). Sonnet's open-lab
Engineers worked around it with a symlink and declared it as a deviation, so
those runs still measured.

## Delivered

- **JSON-string argument decoding** (`packages/agent-runtime/src/argument-repair.ts`).
  When a tool or `finish` input fails validation because an object or array
  arrived as a JSON string, the runtime decodes that string and validates the
  decoded value against the same schema. Nothing else is coerced, every check
  still applies, the model is told, and the receipt records the decoded paths
  (`decodedJsonStrings`). If the decoded input still fails, the model sees the
  errors for what it actually sent. Always on: this is wire format, not
  protocol.
- **Plan revision mode** (`DEJAML_PLAN_REVISION=1`, `planRevision` in the study
  config, `condition.planRevision` in every report). Off by default, so the
  published protocol is unchanged. When on:
  - the Planner gets `lab.layout` (the absolute path of every lab folder),
    `reviewedAdapter.runAs` (the adapter's absolute path) and an instruction to
    write the adapter, outside data and outputs as absolute paths;
  - the plan review refuses an output argument that names the metric file but
    resolves elsewhere (without the mode it is a warning, as before);
  - a plan the review finds unusable (`inconclusive`, never `policy_blocked`)
    goes back to the Planner once, with the exact refusal, as the typed re-plan
    `plan_refused_replan`. The refused plan and the refusal stay on the board;
  - `dependency_check` states its verdict in words.
- **Clearer refusal for a wrong script path**, in both modes: the message now
  says what the path resolved to from the cwd and what the entry point and
  adapter paths are.
- **Fixed sampling for the custom endpoint**: `DEJAML_CUSTOM_TEMPERATURE` and
  `DEJAML_CUSTOM_SEED` are sent with every request to the administrator's
  OpenAI-compatible endpoint (llama.cpp, vLLM, SGLang, Ollama, LM Studio, MLX
  servers). Model access stays generic: any such server, local or rented, is
  the existing `custom` provider.

## Files changed

- `packages/agent-runtime/src/argument-repair.ts`, `runtime.ts` — decoding and receipts
- `packages/agent-runtime/src/providers/openai.ts`, `registry.ts` — sampling settings
- `packages/contracts/src/study.ts` — `plan_refused_replan`
- `apps/api/src/study/contract.ts` — path resolution, output-path check, messages
- `apps/api/src/study/study.ts`, `context.ts`, `roles.ts`, `targets.ts`, `lab-tools.ts`, `main.ts` — plan revision mode
- tests: `argument-repair.test.ts`, `runtime.test.ts`, `registry.test.ts`, `verdict.test.ts`, `sentinel.test.ts`
- `.env.example`

## Decisions and deviations

- No check was relaxed. Plan revision only adds a check (output paths), adds
  information (absolute paths) and gives one chance to fix a deterministic
  refusal, which is reported as a re-plan. The finding that the plan review
  stops sloppy agents still holds and is now measurable: a run records whether
  the model recovered from a refusal.
- Every prompt and tool-output change is behind the mode, so a rerun of the
  published matrices without it sees the same prompts.

## Verification

```text
npm run check
node acceptance/blinding/replay-plan-review.mjs             # without plan revision
STRICT=1 node acceptance/blinding/replay-plan-review.mjs    # with its output-path check
```

**Observed result:** `npm run check` passed (build, typecheck, lint, format,
native checks, script tests, all workspace tests). Replaying the recorded
contracts: without plan revision every recorded Sonnet plan is still approved,
so the published outcomes are unchanged; with it, all 8 recorded Haiku plans
and the 6 Sonnet plans with the output-path mistake are refused at plan review
with a message that names the correct path. The sentinel test runs a whole
study in which the first plan writes the metric relative to cwd: without the
mode it is approved with a warning; with it the plan is refused, re-planned
once, measured, and the blinding proof passes.

## First real runs (2026-11-07)

Qwen3-Coder-30B-A3B through Cheaper Inference, Urban Land Cover, blind,
unguarded lab, plan revision on, 3 runs per batch:

| Batch | Commit | Cost | Outcome |
| --- | --- | --- | --- |
| a | `5b8d9a1` | $0.083 | 1 of 3 measured 79.88 (control and replay 79.88, no edits, not reproduced against 81.66); 2 named the adapter as the entry point and repeated it after the refusal. The JSON-string decoding fired on `metricParser` in every run. |
| b | `2bea2e9` (entry point stays the official file) | $0.098 | 2 of 3 plans approved first try. One Engineer destroyed its own lab after the official run, which broke the open lab's replay; one Reviewer ran out of turns reading the repository; one repeated the adapter entry point. |

After batch b, three more fixes:

- `lab_destroy` closes the Engineer's lab tools at once, but the orchestrator
  destroys the lab only when its own work there is done, so the final-setup
  replay can still run (always on; the agent sees the same result).
- In plan revision mode, the Reviewer is told to work from the receipts and
  logs first, and every agent is reminded to finish when 4 turns remain
  (`finishReminderTurns`).
- `blinding-lib.mjs` counts official runs from the events when a failed study
  wrote no edit records.

## Known limitations

- No real open-model run yet; it needs the owner's Mac (Docker, datasets) and a
  model server.
- Record and replay of an agent session is not built yet.
- Deterministic inference depends on the server (temperature 0 and a seed are
  not enough on most GPU stacks); the setup is undecided.

## Remaining work

- One open model through the Urban Land Cover blind arm with plan revision on.
- Record and replay in the runtime, then the blind/sighted/decoy/reward replays.

## Next sub-phase

`6.9 — Record and replay of agent sessions`
