# @dejaml/agent-runtime

A bounded autonomous agent runtime. It is DéjàML's own code: it does not embed
OpenClaw or any other external agent SDK. A model provider is only the model
behind an agent's loop.

## Agents

`BoundedAgentRuntime` implements `AgentRuntime`:

| Method | What it does |
| --- | --- |
| `startAgent(task)` | Creates an agent with a fresh `agt_` id, its own system prompt, conversation, tool grants and limits, persists it in the run's `AgentLedger`, and starts its loop. Returns a handle whose `result` settles when the agent finishes. |
| `sendMessage(agentId, message)` | Delivers an explicit message into that agent's own conversation. |
| `subscribe(agentId, listener)` | Streams the agent's lifecycle and tool events. |
| `cancelAgent(agentId)` | Aborts the agent and its children; the in-flight model call and tool see the abort signal. |
| `resumeAgent(agentId)` | Rebuilds the loop from the persisted conversation after a restart. |

Every agent has its own loop and never shares a conversation with another
agent. Agents coordinate only through the typed `EvidenceBoard` (one ledger per
run) and explicit messages. `BOARD_VISIBILITY` decides what each role may read.
The Independent Reviewer sees the paper, repository, plan, receipts, artifacts
and submissions, but never the Engineer's diagnoses or notes.

Each agent finishes by calling `finish` with a result that must match its
schema, or `give_up` with a reason. Limits (`DEFAULT_AGENT_LIMITS`) cover
iterations, tool calls, input and output tokens, wall time, context size and
tool-result size. A long conversation rolls over into a new segment that restates the
objective, the inputs and the agent's receipts, instead of growing without
bound; saved history is never rewritten.

Every model call and tool call is persisted as a receipt: its input and output
digests, status (`ok`, `error`, `denied`, `cancelled`), timing and token usage.
A tool refuses a request by throwing `ToolDenied`, which is recorded as a
denied receipt and returned to the model as an error.

## Providers

`providers/` holds real chat clients for Anthropic (Messages API) and OpenAI
(Chat Completions), plus one administrator-configured OpenAI-compatible
endpoint. `loadProviderConfig(env)` reads the provider settings, and
`publicProviders` returns only ids, labels, models and key source for the
browser: never a key or a base URL. Clients retry rate limits, overloads,
server errors and network failures with jittered backoff, honour abort
signals, and report token usage. Cost is reported only for models listed in
`DEJAML_MODEL_PRICES`; no prices are built in.

## Tests

```bash
npm test --workspace @dejaml/agent-runtime
```

Provider tests replay recorded response fixtures (`providers/fixtures/`), so
they need no key or network.
