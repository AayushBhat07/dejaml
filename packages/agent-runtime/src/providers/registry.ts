import { type EndpointAccess, NetGuardError, validateEndpointUrl } from "@dejaml/net-guard";

import { AnthropicChatProvider } from "./anthropic.js";
import { OPENAI_DEFAULT_BASE_URL, OpenAIChatProvider, OpenAICompatibleChatProvider } from "./openai.js";
import { DEFAULT_PRICES, PRICE_TABLE_ENV, PriceTableError, parsePriceTable } from "./pricing.js";
import type { FetchLike, NetGuardSeams, RetryOptions } from "./retry.js";
import type { ChatProvider, ModelPrice } from "./types.js";

/**
 * Server-side provider configuration, read once from the environment at
 * startup. Provider keys come only from the server's environment: the browser
 * picks a provider id and a model name and nothing else. Keys never live on
 * the returned objects: they are held in a module-private WeakMap keyed by
 * the config object, so logging or serializing a config cannot leak them.
 */

export const PROVIDER_ENV = {
  openaiKey: "DEJAML_OPENAI_API_KEY",
  openaiModels: "DEJAML_OPENAI_MODELS",
  openaiBaseUrl: "DEJAML_OPENAI_BASE_URL",
  anthropicKey: "DEJAML_ANTHROPIC_API_KEY",
  anthropicModels: "DEJAML_ANTHROPIC_MODELS",
  customBaseUrl: "DEJAML_CUSTOM_BASE_URL",
  customModels: "DEJAML_CUSTOM_MODELS",
  customKey: "DEJAML_CUSTOM_API_KEY",
  customLabel: "DEJAML_CUSTOM_LABEL",
  /** Development only: plain http to a loopback custom endpoint. Refused when NODE_ENV=production. */
  customAllowLocalHttp: "DEJAML_CUSTOM_ALLOW_LOCAL_HTTP",
  /** Development only: a custom endpoint on a private network or internal name. Refused when NODE_ENV=production. */
  customAllowPrivate: "DEJAML_CUSTOM_ALLOW_PRIVATE",
  prices: PRICE_TABLE_ENV,
} as const;

/**
 * Settings that no longer exist. Uploader-supplied keys were removed, and the
 * legacy single-model settings could route a base URL around the custom
 * endpoint's checks; setting any of them is a configuration error so a server
 * never silently runs with a key or endpoint it thinks it has.
 */
export const REMOVED_PROVIDER_ENV = {
  allowUploaderKeys: "DEJAML_ALLOW_UPLOADER_KEYS",
  legacyModel: "DEJAML_MODEL",
  legacyModelBaseUrl: "DEJAML_MODEL_BASE_URL",
  legacyModelKey: "DEJAML_MODEL_API_KEY",
} as const;

export const DEFAULT_ANTHROPIC_MODELS: readonly string[] = ["claude-opus-5-5", "claude-sonnet-5-5"];
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;

export type ProviderId = "openai" | "anthropic" | "custom";

export type ProviderConfig = {
  readonly id: ProviderId;
  readonly kind: "openai" | "anthropic" | "openai_compatible";
  readonly label: string;
  readonly models: readonly string[];
  /** Normalized endpoint; only set for `custom` and an overridden `openai`. Never public. */
  readonly baseUrl?: string;
  /** Which addresses the endpoint may reach (`custom` only; `public` unless a development flag widened it). */
  readonly endpointAccess?: EndpointAccess;
  /** Plain http to a loopback custom endpoint (development only). */
  readonly allowHttp?: boolean;
  readonly hasServerKey: boolean;
  readonly available: boolean;
};

export type LoadedProviderConfig = {
  readonly providers: readonly ProviderConfig[];
  readonly prices: Readonly<Record<string, ModelPrice>>;
};

/** What the browser may see: ids, labels and models. Never a key, base URL or key source. */
export type PublicProvider = {
  id: ProviderId;
  label: string;
  models: string[];
};

export class ProviderConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid model-provider configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ProviderConfigError";
  }
}

export class ProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSelectionError";
  }
}

const serverKeys = new WeakMap<ProviderConfig, string>();

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Keys: 8–512 characters, no whitespace or control characters. Never echoes the key. */
export function isValidApiKey(key: string): boolean {
  // eslint-disable-next-line no-control-regex
  return key.length >= 8 && key.length <= 512 && !/[\s\u0000-\u001f\u007f-\u009f]/.test(key);
}

function parseFlag(env: Env, name: string, fallback: boolean, problems: string[]): boolean {
  const v = read(env, name);
  if (v === undefined) return fallback;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  problems.push(`${name} must be "1" or "0"`);
  return fallback;
}

/** A development-only flag: refused (and treated as off) when NODE_ENV=production. */
function parseDevFlag(env: Env, name: string, production: boolean, problems: string[]): boolean {
  const on = parseFlag(env, name, false, problems);
  if (on && production) {
    problems.push(`${name} is a development-only setting and is not allowed when NODE_ENV=production`);
    return false;
  }
  return on;
}

function parseModels(env: Env, name: string, problems: string[]): string[] | undefined {
  const v = read(env, name);
  if (v === undefined) return undefined;
  const models = v
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m !== "");
  const bad = models.filter((m) => !MODEL_NAME_PATTERN.test(m));
  for (const m of bad) problems.push(`${name} contains an invalid model name ${JSON.stringify(m.slice(0, 64))}`);
  if (models.length === 0) problems.push(`${name} is set but lists no models`);
  return [...new Set(models.filter((m) => MODEL_NAME_PATTERN.test(m)))];
}

function parseKey(env: Env, name: string, problems: string[]): string | undefined {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  if (!isValidApiKey(v)) {
    problems.push(`${name} is not a valid API key (8-512 characters, no whitespace or control characters)`);
    return undefined;
  }
  return v;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Returns the normalized URL or pushes a problem. Syntax first (scheme,
 * credentials, query, fragment), then net-guard's endpoint policy for the
 * host: loopback, private, link-local, CGNAT, metadata, multicast and
 * unspecified addresses (IPv4, IPv6 and IPv4-mapped forms) and internal names
 * are refused unless `access` was widened for development. DNS answers are
 * checked again on every request.
 */
function parseBaseUrl(
  name: string,
  raw: string,
  endpoint: { access: EndpointAccess; allowLocalHttp: boolean },
  problems: string[],
): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} is not a valid URL`);
    return undefined;
  }
  const errs: string[] = [];
  if (url.protocol === "http:") {
    if (!(endpoint.allowLocalHttp && LOCAL_HOSTS.has(url.hostname))) {
      errs.push(
        endpoint.allowLocalHttp
          ? "must use https (plain http is only allowed for 127.0.0.1, localhost or [::1])"
          : "must use https",
      );
    }
  } else if (url.protocol !== "https:") errs.push("must use https");
  if (url.username !== "" || url.password !== "") errs.push("must not contain credentials");
  if (url.search !== "" || raw.includes("?")) errs.push("must not contain a query string");
  if (url.hash !== "" || raw.includes("#")) errs.push("must not contain a fragment");
  if (errs.length > 0) {
    // Do not echo the URL: it might embed credentials.
    problems.push(`${name} ${errs.join(", ")}`);
    return undefined;
  }
  try {
    validateEndpointUrl(raw, { access: endpoint.access, allowHttp: endpoint.allowLocalHttp });
  } catch (err) {
    if (!(err instanceof NetGuardError)) throw err;
    const hint =
      endpoint.access === "public" && name === PROVIDER_ENV.customBaseUrl
        ? ` (for a development server set ${PROVIDER_ENV.customAllowPrivate}=1; never in production)`
        : "";
    switch (err.code) {
      case "private_address":
        problems.push(`${name} points at a loopback, private, link-local, metadata or otherwise non-public address${hint}`);
        break;
      case "unsafe_hostname":
        problems.push(`${name} uses a local, internal or single-label hostname${hint}`);
        break;
      case "ip_literal_not_allowed":
        problems.push(`${name} uses a non-canonical IP address`);
        break;
      default:
        problems.push(`${name} is refused by the network policy (${err.code})`);
    }
    return undefined;
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * Reads and validates provider configuration. Throws `ProviderConfigError`
 * listing every problem found. A provider without a server key is listed as
 * unavailable and never offered to the browser.
 */
export function loadProviderConfig(env: Env): LoadedProviderConfig {
  const problems: string[] = [];
  const production = read(env, "NODE_ENV") === "production";
  const providers: ProviderConfig[] = [];
  const keys = new Map<ProviderConfig, string>();

  // Removed settings. "0" for the uploader-key switch matches today's behaviour, so it is tolerated.
  {
    const uploader = read(env, REMOVED_PROVIDER_ENV.allowUploaderKeys);
    if (uploader !== undefined && uploader !== "0" && uploader !== "false") {
      problems.push(
        `${REMOVED_PROVIDER_ENV.allowUploaderKeys} is no longer supported: provider keys come only from ${PROVIDER_ENV.openaiKey}, ${PROVIDER_ENV.anthropicKey} and ${PROVIDER_ENV.customKey}`,
      );
    }
    const legacy = [REMOVED_PROVIDER_ENV.legacyModel, REMOVED_PROVIDER_ENV.legacyModelBaseUrl, REMOVED_PROVIDER_ENV.legacyModelKey].filter(
      (name) => read(env, name) !== undefined,
    );
    if (legacy.length > 0) {
      problems.push(
        `${legacy.join(", ")} ${legacy.length === 1 ? "is" : "are"} no longer supported: use ${PROVIDER_ENV.openaiKey}/${PROVIDER_ENV.openaiModels}, ${PROVIDER_ENV.anthropicKey}/${PROVIDER_ENV.anthropicModels}, or ${PROVIDER_ENV.customBaseUrl}/${PROVIDER_ENV.customModels}/${PROVIDER_ENV.customKey}`,
      );
    }
  }

  const add = (config: ProviderConfig, key: string | undefined) => {
    providers.push(config);
    if (key !== undefined) keys.set(config, key);
  };

  // OpenAI
  {
    const key = parseKey(env, PROVIDER_ENV.openaiKey, problems);
    const models = parseModels(env, PROVIDER_ENV.openaiModels, problems) ?? [];
    const rawBase = read(env, PROVIDER_ENV.openaiBaseUrl);
    const baseUrl =
      rawBase === undefined
        ? undefined
        : parseBaseUrl(PROVIDER_ENV.openaiBaseUrl, rawBase, { access: "public", allowLocalHttp: false }, problems);
    if (key !== undefined && models.length === 0 && read(env, PROVIDER_ENV.openaiModels) === undefined) {
      problems.push(`${PROVIDER_ENV.openaiModels} is required when ${PROVIDER_ENV.openaiKey} is set`);
    }
    const hasServerKey = key !== undefined;
    add(
      {
        id: "openai",
        kind: "openai",
        label: "OpenAI",
        models,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        hasServerKey,
        available: models.length > 0 && hasServerKey,
      },
      key,
    );
  }

  // Anthropic
  {
    const key = parseKey(env, PROVIDER_ENV.anthropicKey, problems);
    const models = parseModels(env, PROVIDER_ENV.anthropicModels, problems) ?? [...DEFAULT_ANTHROPIC_MODELS];
    const hasServerKey = key !== undefined;
    add(
      {
        id: "anthropic",
        kind: "anthropic",
        label: "Anthropic",
        models,
        hasServerKey,
        available: models.length > 0 && hasServerKey,
      },
      key,
    );
  }

  // Custom (administrator-only OpenAI-compatible endpoint; its key is optional, e.g. a local server)
  {
    const rawBase = read(env, PROVIDER_ENV.customBaseUrl);
    const rawModels = read(env, PROVIDER_ENV.customModels);
    const allowLocalHttp = parseDevFlag(env, PROVIDER_ENV.customAllowLocalHttp, production, problems);
    const allowPrivate = parseDevFlag(env, PROVIDER_ENV.customAllowPrivate, production, problems);
    const access: EndpointAccess = allowPrivate ? "private" : allowLocalHttp ? "loopback" : "public";
    const key = parseKey(env, PROVIDER_ENV.customKey, problems);
    const label = read(env, PROVIDER_ENV.customLabel);
    if (rawBase !== undefined || rawModels !== undefined) {
      if (rawBase === undefined) problems.push(`${PROVIDER_ENV.customBaseUrl} is required when ${PROVIDER_ENV.customModels} is set`);
      if (rawModels === undefined) problems.push(`${PROVIDER_ENV.customModels} is required when ${PROVIDER_ENV.customBaseUrl} is set`);
      const baseUrl =
        rawBase === undefined ? undefined : parseBaseUrl(PROVIDER_ENV.customBaseUrl, rawBase, { access, allowLocalHttp }, problems);
      const models = parseModels(env, PROVIDER_ENV.customModels, problems) ?? [];
      // eslint-disable-next-line no-control-regex
      if (label !== undefined && (label.length > 64 || /[\u0000-\u001f\u007f]/.test(label))) {
        problems.push(`${PROVIDER_ENV.customLabel} must be at most 64 printable characters`);
      }
      if (baseUrl !== undefined && models.length > 0) {
        add(
          {
            id: "custom",
            kind: "openai_compatible",
            label: label !== undefined && label.length <= 64 ? label : "Custom endpoint",
            models,
            baseUrl,
            endpointAccess: access,
            allowHttp: allowLocalHttp,
            hasServerKey: key !== undefined,
            available: true,
          },
          key,
        );
      }
    } else {
      for (const name of [PROVIDER_ENV.customKey, PROVIDER_ENV.customLabel]) {
        if (read(env, name) !== undefined) problems.push(`${name} is set but ${PROVIDER_ENV.customBaseUrl} is not`);
      }
    }
  }

  // Prices
  let prices: Record<string, ModelPrice> = { ...DEFAULT_PRICES };
  const rawPrices = read(env, PROVIDER_ENV.prices);
  if (rawPrices !== undefined) {
    try {
      prices = { ...prices, ...parsePriceTable(rawPrices) };
    } catch (err) {
      if (err instanceof PriceTableError) problems.push(err.message);
      else throw err;
    }
  }

  if (problems.length > 0) throw new ProviderConfigError(problems);
  for (const [config, key] of keys) serverKeys.set(config, key);
  return Object.freeze({ providers: Object.freeze(providers.map((p) => Object.freeze(p))), prices: Object.freeze(prices) });
}

/** Browser-safe provider list: ids, labels and models of available providers only. */
export function publicProviders(config: LoadedProviderConfig): PublicProvider[] {
  return config.providers.filter((p) => p.available).map((p) => ({ id: p.id, label: p.label, models: [...p.models] }));
}

export type CreateChatProviderOptions = {
  /**
   * Test seam for `openai`/`anthropic` only. The custom endpoint never takes
   * an injected fetch: it always uses the guarded fetch (see `netGuard`).
   */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxResponseBytes?: number;
  retry?: Omit<RetryOptions, "signal">;
  /** Test seams for the guarded fetch (resolver, transport, address policy). Never wire to configuration. */
  netGuard?: NetGuardSeams;
};

/**
 * Builds the adapter for a configured provider and allowlisted model, with
 * the server's key. The adapter re-checks the model allowlist on every call.
 */
export function createChatProvider(
  config: LoadedProviderConfig,
  providerId: string,
  model: string,
  options: CreateChatProviderOptions = {},
): ChatProvider {
  if ("uploaderKey" in options || "apiKey" in options) {
    throw new ProviderSelectionError("Provider keys come only from the server environment");
  }
  const provider = config.providers.find((p) => p.id === providerId);
  if (!provider || !provider.available) throw new ProviderSelectionError(`Provider ${JSON.stringify(providerId.slice(0, 64))} is not configured`);
  if (!provider.models.includes(model)) {
    throw new ProviderSelectionError(`Model ${JSON.stringify(model.slice(0, 128))} is not allowed for provider ${provider.id}`);
  }
  const key = serverKeys.get(provider);
  if (key === undefined && provider.kind !== "openai_compatible") {
    throw new ProviderSelectionError(`Provider ${provider.id} has no server key`);
  }

  const common = {
    prices: config.prices,
    models: provider.models,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
    ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
  };
  switch (provider.kind) {
    case "openai":
      return new OpenAIChatProvider({
        ...common,
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        apiKey: key as string,
        baseUrl: provider.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
        id: provider.id,
      });
    case "anthropic":
      return new AnthropicChatProvider({
        ...common,
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        apiKey: key as string,
        id: provider.id,
      });
    case "openai_compatible":
      return new OpenAICompatibleChatProvider({
        ...common,
        baseUrl: provider.baseUrl as string,
        ...(key !== undefined ? { apiKey: key } : {}),
        id: provider.id,
        label: provider.label,
        access: provider.endpointAccess ?? "public",
        allowHttp: provider.allowHttp === true,
        ...(options.netGuard !== undefined ? { netGuard: options.netGuard } : {}),
      });
  }
}
