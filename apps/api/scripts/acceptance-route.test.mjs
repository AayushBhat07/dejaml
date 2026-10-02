// Run with: node --test apps/api/scripts/acceptance-route.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { CHEAPER_INFERENCE, NATIVE_RUNTIME, checkAcceptanceProvider, classifyAcceptanceRoute } from "./acceptance-route.mjs";

const GATEWAY = Object.freeze({
  id: "cheaper_inference",
  kind: "openai_compatible",
  endpointHost: "api.cheaperinference.com",
  official: false,
  route: "trusted_gateway",
  https: true,
});
const ANTHROPIC = Object.freeze({
  id: "anthropic",
  kind: "anthropic",
  endpointHost: "api.anthropic.com",
  official: true,
  route: "official",
  https: true,
});
const OPENAI = Object.freeze({
  id: "openai",
  kind: "openai",
  endpointHost: "api.openai.com",
  official: true,
  route: "official",
  https: true,
});

test("trusts the Cheaper Inference gateway only on its fixed https host, trusted route and claude-sonnet-5.5", () => {
  const result = classifyAcceptanceRoute({ providerId: "cheaper_inference", model: "claude-sonnet-5.5", health: GATEWAY });
  assert.equal(result.ok, true);
  assert.match(result.label, /trusted third-party gateway/u);
  assert.match(result.reason, /trusted third-party gateway api\.cheaperinference\.com/u);
  assert.doesNotMatch(`${result.label} ${result.reason}`, /direct Anthropic/iu);
  assert.deepEqual(CHEAPER_INFERENCE, { id: "cheaper_inference", endpointHost: "api.cheaperinference.com", model: "claude-sonnet-5.5" });
});

test("refuses Cheaper Inference with any other host, http, route, official claim or model", () => {
  const refused = [
    { health: { ...GATEWAY, endpointHost: "api.cheaperinference.com.evil.test" } },
    { health: { ...GATEWAY, endpointHost: "127.0.0.1:8080" } },
    { health: { ...GATEWAY, endpointHost: "localhost" } },
    { health: { ...GATEWAY, endpointHost: "api.cheaperinference.com:8443" } },
    { health: { ...GATEWAY, https: false } },
    { health: { ...GATEWAY, https: undefined } },
    { health: { ...GATEWAY, route: "custom" } },
    { health: { ...GATEWAY, route: "official" } },
    { health: { ...GATEWAY, route: undefined } },
    { health: { ...GATEWAY, official: true } },
    { health: { ...GATEWAY, id: "custom" } },
    { health: null },
    { health: GATEWAY, model: "claude-opus-5-5" },
    { health: GATEWAY, model: "claude-sonnet-5-5" },
    { health: GATEWAY, model: null },
  ];
  for (const { health, model = "claude-sonnet-5.5" } of refused) {
    const result = classifyAcceptanceRoute({ providerId: "cheaper_inference", model, health });
    assert.equal(result.ok, false, JSON.stringify({ health, model }));
    assert.equal(result.label, "refused");
  }
});

test("keeps refusing the generic custom endpoint, localhost bridges and unknown providers", () => {
  const cases = [
    { providerId: "custom", model: "claude-sonnet-5.5", health: { ...GATEWAY, id: "custom" } },
    {
      providerId: "custom",
      model: "lab",
      health: { id: "custom", endpointHost: "127.0.0.1:11434", official: false, route: "custom", https: false },
    },
    {
      providerId: "custom",
      model: "lab",
      health: { id: "custom", endpointHost: "llm.example.test", official: false, route: "custom", https: true },
    },
    {
      providerId: "bridge",
      model: "m",
      health: { id: "bridge", endpointHost: "localhost:18000", official: true, route: "official", https: false },
    },
  ];
  for (const input of cases) assert.equal(classifyAcceptanceRoute(input).ok, false, JSON.stringify(input));
});

test("keeps trusting the official OpenAI and Anthropic APIs, and only those", () => {
  assert.deepEqual(classifyAcceptanceRoute({ providerId: "anthropic", model: "claude-opus-5-5", health: ANTHROPIC }), {
    ok: true,
    label: "direct Anthropic API",
    reason: "anthropic via its official endpoint api.anthropic.com",
  });
  assert.equal(classifyAcceptanceRoute({ providerId: "openai", model: "gpt-fixture-1", health: OPENAI }).ok, true);
  // An older health payload without route/https still identifies the official API.
  assert.equal(
    classifyAcceptanceRoute({
      providerId: "openai",
      model: "gpt-fixture-1",
      health: { id: "openai", endpointHost: "api.openai.com", official: true },
    }).ok,
    true,
  );
  // An overridden OpenAI base URL is not official.
  assert.equal(
    classifyAcceptanceRoute({
      providerId: "openai",
      model: "gpt-fixture-1",
      health: { ...OPENAI, endpointHost: "proxy.example.test", official: false, route: "custom" },
    }).ok,
    false,
  );
  // The gateway cannot borrow the Anthropic id.
  assert.equal(
    classifyAcceptanceRoute({ providerId: "anthropic", model: "claude-sonnet-5.5", health: { ...GATEWAY, id: "anthropic" } }).ok,
    false,
  );
});

test("the post-run check accepts the gateway on the native runtime and says trusted third-party gateway", () => {
  const study = { provider: { id: "cheaper_inference", model: "claude-sonnet-5.5" }, runtime: NATIVE_RUNTIME };
  const result = checkAcceptanceProvider({ providerId: "cheaper_inference", model: "claude-sonnet-5.5", health: GATEWAY, study });
  assert.equal(result.pass, true);
  assert.equal(result.name, "trusted provider route through DéjàML's own adapter");
  assert.match(result.detail, /^cheaper_inference\/claude-sonnet-5\.5 via trusted third-party gateway/u);
  assert.doesNotMatch(result.detail, /direct Anthropic/iu);

  // Another runtime, a different model, or a different provider in the report fails the check.
  for (const other of [
    { ...study, runtime: "scripted" },
    { ...study, provider: { id: "cheaper_inference", model: "claude-opus-5-5" } },
    { ...study, provider: { id: "custom", model: "claude-sonnet-5.5" } },
    { runtime: NATIVE_RUNTIME },
  ]) {
    assert.equal(
      checkAcceptanceProvider({ providerId: "cheaper_inference", model: "claude-sonnet-5.5", health: GATEWAY, study: other }).pass,
      false,
    );
  }
  assert.equal(
    checkAcceptanceProvider({
      providerId: "anthropic",
      model: "claude-opus-5-5",
      health: ANTHROPIC,
      study: { provider: { id: "anthropic", model: "claude-opus-5-5" }, runtime: NATIVE_RUNTIME },
    }).pass,
    true,
  );
});
