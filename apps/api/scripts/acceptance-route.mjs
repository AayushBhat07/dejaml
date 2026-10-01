// Which provider routes a real-model acceptance run may use. Pure: no I/O.
//
// Trusted: the vendor's own API (provider id openai or anthropic, reported by
// /api/health as `official`), or the fixed Cheaper Inference gateway, a
// trusted third party in front of Claude that is NOT the official Anthropic
// API. Everything else - the generic custom endpoint, localhost bridges, any
// other host, plain http, or another model - is refused.

export const CHEAPER_INFERENCE = Object.freeze({
  id: "cheaper_inference",
  endpointHost: "api.cheaperinference.com",
  model: "claude-sonnet-5.5",
});

export const NATIVE_RUNTIME = "native autonomous agent runtime";

/**
 * @param {{ providerId: unknown, model: unknown, health: unknown }} input
 *   `health` is the provider's entry from /api/health `providers`, or null.
 * @returns {{ ok: boolean, label: string, reason: string }}
 *   `label` names the route for reports ("direct OpenAI API", "direct Anthropic API",
 *   "trusted third-party gateway (Cheaper Inference)", or "refused").
 */
export function classifyAcceptanceRoute({ providerId, model, health }) {
  const refuse = (reason) => ({ ok: false, label: "refused", reason });
  const route = health && typeof health === "object" ? health : null;
  const host = typeof route?.endpointHost === "string" ? route.endpointHost : "unknown endpoint";
  if (route === null || route.id !== providerId) return refuse(`no health entry for provider ${String(providerId)}`);

  if (providerId === "openai" || providerId === "anthropic") {
    if (route.official !== true || (route.route !== undefined && route.route !== "official")) {
      return refuse(`provider ${providerId} (${host}) is not the vendor's own API`);
    }
    if (route.https === false) return refuse(`provider ${providerId} (${host}) does not use https`);
    return {
      ok: true,
      label: providerId === "openai" ? "direct OpenAI API" : "direct Anthropic API",
      reason: `${providerId} via its official endpoint ${host}`,
    };
  }

  if (providerId === CHEAPER_INFERENCE.id) {
    if (route.endpointHost !== CHEAPER_INFERENCE.endpointHost) {
      return refuse(`Cheaper Inference must use ${CHEAPER_INFERENCE.endpointHost}, not ${host}`);
    }
    if (route.https !== true) return refuse(`Cheaper Inference (${host}) is not reported as https`);
    if (route.route !== "trusted_gateway") return refuse(`Cheaper Inference (${host}) is not reported as the trusted gateway route`);
    if (route.official !== false) return refuse("Cheaper Inference must not be reported as an official vendor API");
    if (model !== CHEAPER_INFERENCE.model) {
      return refuse(`Cheaper Inference acceptance only allows ${CHEAPER_INFERENCE.model}, not ${String(model)}`);
    }
    return {
      ok: true,
      label: "trusted third-party gateway (Cheaper Inference)",
      reason: `${CHEAPER_INFERENCE.id}/${CHEAPER_INFERENCE.model} via the trusted third-party gateway ${CHEAPER_INFERENCE.endpointHost} (not the official Anthropic API)`,
    };
  }

  return refuse(
    `provider ${String(providerId)} (${host}) is neither a direct OpenAI or Anthropic API nor the trusted Cheaper Inference gateway; acceptance refuses custom endpoints, local bridges, and stand-in models`,
  );
}

/**
 * The post-run check: the study used the provider and model that were
 * classified as trusted (re-classified here against the same health entry),
 * and its agents ran on DéjàML's own native runtime.
 */
export function checkAcceptanceProvider({ providerId, model, health, study }) {
  const classification = classifyAcceptanceRoute({ providerId, model, health });
  const pass =
    classification.ok &&
    study?.provider?.id === providerId &&
    study?.provider?.model === model &&
    classifyAcceptanceRoute({ providerId: study.provider.id, model: study.provider.model, health }).ok &&
    study?.runtime === NATIVE_RUNTIME;
  const detail = `${study?.provider?.id}/${study?.provider?.model} via ${classification.label}: ${classification.reason}; ${study?.runtime}`;
  return { name: "trusted provider route through DéjàML's own adapter", pass, detail };
}
