# Sub-phase 6.9 — Record and replay of agent sessions

**Status:** `IN PROGRESS` (built and tested in code; first real replay on the Mac still to do)
**Completed:** `—`
**Commit:** `fill after the first Mac replay`
**Owner:** `aayush`

## Objective

Make a causal test possible: record one agent session on a deterministic, locally served model, then run
the same study again changing only the number the agents are shown, and find the first turn where an
agent acts differently. Before any counterfactual, a replay with nothing changed must come out identical.
This follows Pedro Reviriego's suggestion. His tools (BlockLock, GeulPU) need a Linux CUDA or Vulkan GPU
and do not run on Apple Silicon. Devstral Small 2 on llama.cpp was byte-identical on the Mac on 9 Nov 2026
(temperature 0, seed 0, one slot), so this sub-phase targets that setup.

## Delivered

- **Tape** (`packages/agent-runtime/src/tape.ts`). A run's tape holds, per agent, every model request and
  response and every tool call with the result the model read back, as JSONL. Agents are matched across
  runs by role, label and start order (`lab_engineer|engineer-1|1`).
- **Replay.** The new run is compared step by step with the recorded one:
  - **Requests** must equal the recorded ones after the operator's substitutions. Anything else is
    reported as `request` drift.
  - **Responses** are compared on text, tool names and arguments. The first difference is reported as a
    `response` divergence, and the agent is marked off its recorded path from then on.
  - **Tool results.** While an agent is on its path, each tool still runs for its side effects (labs, the
    board), but the model reads the recorded result, so the environment is frozen. A live result that
    differs goes into `environmentDrift`, apart from model behaviour.
  - **Ids.** Run, agent, receipt and board ids, salted commitments and provider tool-call ids differ
    between runs. The replay learns each pair where the only difference is an id of the same shape, and
    sends the model the recorded one. This keeps the model's input byte-identical.
- **Runtime hook.** `BoundedRuntimeOptions.tape` wraps every model call and tool run. Failed and refused
  tools are recorded like any other result.
- **Study wiring.** `MultiAgentDependencies.tape`, set from the environment (`apps/api/src/study/tape-files.ts`):

  | Variable | Effect |
  | --- | --- |
  | `DEJAML_TAPE_DIR` | Record every study to `<dir>/<runId>.tape.jsonl` |
  | `DEJAML_REPLAY_TAPE` | Replay that tape against every new study; write `<dir>/<runId>.replay.json` as it goes |
  | `DEJAML_REPLAY_SUBSTITUTE` | The intended differences, `from=>to;…` (for example `81.66=>77.66`); unset = the nothing-changed check |

  The study report carries the comparison as `report.study.replay`.

## The replay report

| Field | Meaning |
| --- | --- |
| `identical` | Every agent read the same requests and did the same things, to the last recorded step |
| `firstBehaviourDivergence` | The first `response` or `tool_call` difference: where the shown number changed what an agent did |
| `divergences` | `request`, `response`, `tool_call`, `unrecorded_agent`, `not_reached` |
| `environmentDrift` | Tool results that differed live (timestamps, durations, a changed output); the model did not read them |
| `agents` | Per agent: model turns and tool calls against the recorded counts, and whether it stayed on its path |

## How to use it (Mac)

1. Start `llama-server` with Devstral, `--jinja -c 49152 --parallel 1 -ngl 99`, at temperature 0 and seed 0
   (`DEJAML_CUSTOM_TEMPERATURE=0`, `DEJAML_CUSTOM_SEED=0`). Record the llama.cpp version and the GGUF's sha256.
2. Record: start the API with `DEJAML_TAPE_DIR=<dir>` and run one study in the chosen arm.
3. Gate: restart the API with `DEJAML_REPLAY_TAPE=<dir>/<runId>.tape.jsonl` and no substitution, and run the
   same arm. `identical` must be `true`. If not, `divergences` names the first agent and turn that drifted.
4. Counterfactual: replay with `DEJAML_REPLAY_SUBSTITUTE='81.66=>77.66'` (or the arm's own text), with the
   study's condition set to the new arm. Report `firstBehaviourDivergence`.

## Verification

- `packages/agent-runtime/src/tape.test.ts` uses a deterministic stand-in model that gives each tool call a
  random id. It covers four cases:
  - A nothing-changed replay is identical, and the model reads byte-identical requests.
  - Changing only the shown number finds the turn where the agent tunes.
  - An unintended input change is reported as request drift.
  - Environment drift is reported apart, and the model still reads the recorded result.
- `apps/api/src/study/sentinel.test.ts` records a full scripted study (6 agents, more than 10 model turns),
  then replays it. The replay is identical. The only differences were timestamps and durations in tool
  output, which landed in `environmentDrift`.
- `apps/api/src/study/tape-files.test.ts` covers the environment settings.
- `npm run check` passes.

## Known limitations

- The id learning accepts only tokens of the same shape: an optional prefix and underscore, then 12 or more
  hex digits, or a UUID. Any other run-specific text the model reads is reported as request drift.
- A substitution is plain text replacement over the recorded request, tool results included. A shown number
  that also appears in a measured output is replaced there too, and that shows as request drift.
- Determinism is claimed only for the pinned setup (llama.cpp version, GGUF hash, one slot, one Mac model).
  A rented CUDA box with BlockLock is the cross-check if a nothing-changed replay drifts on the Mac, or if a
  reviewer asks about other hardware.
- Replay of a replay works, but the new tape is written in the recorded run's id space.

## Next

Record one Urban Land Cover session per arm on Devstral, pass the nothing-changed gate, then replay each
under the other arms' numbers (main study plan, deterministic replay arm).
