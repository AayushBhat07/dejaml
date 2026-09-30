# Provider wire-format fixtures

These files are **constructed**, not recorded. They were written by hand from
the providers' published wire formats (OpenAI Chat Completions and Anthropic
Messages API documentation: response objects, streaming chunk/event shapes,
and error bodies). **None of them was captured from a live API call**: no API
key was available in the environment where they were written, and the tests
never touch the network (every test injects a fake `fetchImpl`).

What that means in practice:

- Field names, nesting, event names and ordering follow the documented
  formats, including details the adapters depend on (OpenAI tool-call deltas
  keyed by `index` with argument fragments, a final `choices: []` usage chunk,
  `data: [DONE]`; Anthropic `message_start` / `content_block_*` /
  `message_delta` / `message_stop` events, `input_json_delta`,
  `thinking_delta`, `signature_delta`, `ping`, and the `error` event).
- Ids (`chatcmpl-fixture-…`, `msg_fixture_…`, `toolu_fixture_…`), model name
  `gpt-fixture-1`, token counts, thinking signatures and message text are
  placeholders. Signatures are not valid cryptographic signatures.
- Real responses may carry extra fields not shown here; the adapters ignore
  unknown fields.
- `openai/error-401-echoes-key.json` contains a fake key string
  (`sk-test-FIXTURE-SECRET-…`) to check that a key echoed by a provider is
  redacted from error messages. It is not, and never was, a real key.

If these fixtures are ever replaced with recordings from live calls, scrub
keys, organization ids and request ids first, and update this note.

Layout:

| File | Used for |
| --- | --- |
| `openai/chat-text.json` | non-streaming text completion with cached-token usage |
| `openai/chat-tool-call.json` | non-streaming response with two tool calls |
| `openai/chat-invalid-tool-args.json` | tool call whose `arguments` is not valid JSON |
| `openai/stream-text-and-tools.sse` | streaming text plus two interleaved tool calls split across chunks, final usage chunk |
| `openai/error-429.json`, `error-400.json`, `error-500.json` | error bodies (`{error:{message,type,param,code}}`) |
| `openai/error-401-echoes-key.json` | error body that echoes a (fake) key |
| `anthropic/message-text.json` | non-streaming text with cache-read usage |
| `anthropic/message-tool-use.json` | text plus two `tool_use` blocks |
| `anthropic/message-thinking.json` | `thinking` + `redacted_thinking` + text + `tool_use` (replayed verbatim) |
| `anthropic/message-refusal.json` | `stop_reason: "refusal"` with `stop_details` |
| `anthropic/stream-text-tool-thinking.sse` | thinking/signature deltas, text deltas, split `input_json_delta`, `ping`, `message_delta` usage |
| `anthropic/stream-error-midstream.sse` | `error` event (`overloaded_error`) after `message_start` |
| `anthropic/stream-invalid-tool-json.sse` | truncated tool input JSON at `max_tokens` |
| `anthropic/error-529-overloaded.json`, `error-400.json` | error bodies (`{type:"error", error:{type,message}}`) |
