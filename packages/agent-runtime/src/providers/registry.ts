import { AnthropicChatProvider } from "./anthropic.js";
import { OPENAI_DEFAULT_BASE_URL, OpenAIChatProvider, OpenAICompatibleChatProvider } from "./openai.js";
import { DEFAULT_PRICES, PRICE_TABLE_ENV, PriceTableError, parsePriceTable } from "./pricing.js";
import type { FetchLike, RetryOptions } from "./retry.js";
import type { ChatProvider, ModelPrice } from "./types.js";

/**
 * Server-side provider configuration, read once from the environment at
 * startup. API keys never live on the returned objects: they are held in a
 * module-private WeakMap keyed by the config object, so logging or
 * serializing a config cannot leak them.
 */

export const PROVIDER_ENV = {
  allowUploaderKeys: "DEJAML_ALLOW_UPLOADER_KEYS",
  openaiKey: "DEJAML_OPENAI_API_KEY",
  openaiModels: "DEJAML_OPENAI_MODELS",
  openaiBaseUrl: "DEJAML_OPENAI_BASE_URL",
  anthropicKey: "DEJAML_ANTHROPIC_API_KEY",
  anthropicModels: "DEJAML_ANTHROPIC_MODELS",
  customBaseUrl: "DEJAML_CUSTOM_BASE_URL",
  customModels: "DEJAML_CUSTOM_MODELS",
  customKey: "DEJAML_CUSTOM_API_KEY",
  customLabel: "DEJAML_CUSTOM_LABEL",
  customAllowLocalHttp: "DEJAML_CUSTOM_ALLOW_LOCAL_HTTP",
  prices: PRICE_TABLE_ENV,
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
  readonly hasServerKey: boolean;
  /** Whether a study may supply its own key (never for `custom`). */
  readonly allowUploaderKey: boolean;
  readonly available: boolean;
};

export type LoadedProviderConfig = {
  readonly providers: readonly ProviderConfig[];
  readonly prices: Readonly<Record<string, ModelPrice>>;
};

export type PublicProvider = {
  id: ProviderId;
  label: string;
  models: string[];
  keySource: "server" | "uploader";
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

/** Returns the normalized URL or pushes a problem. */
function parseBaseUrl(name: string, raw: string, allowLocalHttp: boolean, problems: string[]): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} is not a valid URL`);
    return undefined;
  }
  const errs: string[] = [];
  if (url.protocol === "http:") {
    if (!(allowLocalHttp && LOCAL_HOSTS.has(url.hostname))) {
      errs.push(
        allowLocalHttp
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
  return url.href.replace(/\/+$/, "");
}

/**
 * Reads and validates provider configuration. Throws `ProviderConfigError`
 * listing every problem found.
 */
export function loadProviderConfig(env: Env): LoadedProviderConfig {
  const problems: string[] = [];
  const allowUploader = parseFlag(env, PROVIDER_ENV.allowUploaderKeys, true, problems);
  const providers: ProviderConfig[] = [];
  const keys = new Map<ProviderConfig, string>();

  const add = (config: ProviderConfig, key: string | undefined) => {
    providers.push(config);
    if (key !== undefined) keys.set(config, key);
  };

  // OpenAI
  {
    const key = parseKey(env, PROVIDER_ENV.openaiKey, problems);
    const models = parseModels(env, PROVIDER_ENV.openaiModels, problems) ?? [];
    const rawBase = read(env, PROVIDER_ENV.openaiBaseUrl);
    const baseUrl = rawBase === undefined ? undefined : parseBaseUrl(PROVIDER_ENV.openaiBaseUrl, rawBase, false, problems);
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
        allowUploaderKey: allowUploader,
        available: models.length > 0 && (hasServerKey || allowUploader),
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
        allowUploaderKey: allowUploader,
        available: models.length > 0 && (hasServerKey || allowUploader),
      },
      key,
    );
  }

  // Custom (administrator-only OpenAI-compatible endpoint)
  {
    const rawBase = read(env, PROVIDER_ENV.customBaseUrl);
    const rawModels = read(env, PROVIDER_ENV.customModels);
    const allowLocal = parseFlag(env, PROVIDER_ENV.customAllowLocalHttp, false, problems);
    const key = parseKey(env, PROVIDER_ENV.customKey, problems);
    const label = read(env, PROVIDER_ENV.customLabel);
    if (rawBase !== undefined || rawModels !== undefined) {
      if (rawBase === undefined) problems.push(`${PROVIDER_ENV.customBaseUrl} is required when ${PROVIDER_ENV.customModels} is set`);
      if (rawModels === undefined) problems.push(`${PROVIDER_ENV.customModels} is required when ${PROVIDER_ENV.customBaseUrl} is set`);
      const baseUrl = rawBase === undefined ? undefined : parseBaseUrl(PROVIDER_ENV.customBaseUrl, rawBase, allowLocal, problems);
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
            hasServerKey: key !== undefined,
            allowUploaderKey: false,
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

/** Browser-safe provider list: no keys, no base URLs; only available providers. */
export function publicProviders(config: LoadedProviderConfig): PublicProvider[] {
  return config.providers
    .filter((p) => p.available)
    .map((p) => ({ id: p.id, label: p.label, models: [...p.models], keySource: p.hasServerKey || !p.allowUploaderKey ? "server" : "uploader" }));
}

export type CreateChatProviderOptions = {
  /** A study-supplied key for `openai`/`anthropic`, used only when uploader keys are allowed. */
  uploaderKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retry?: Omit<RetryOptions, "signal">;
};

/**
 * Builds the adapter for a configured provider and allowlisted model. An
 * uploader key, when given, must be allowed for the provider and is used in
 * place of the server key; otherwise the server key is required.
 */
export function createChatProvider(
  config: LoadedProviderConfig,
  providerId: string,
  model: string,
  options: CreateChatProviderOptions = {},
): ChatProvider {
  const provider = config.providers.find((p) => p.id === providerId);
  if (!provider || !provider.available) throw new ProviderSelectionError(`Provider ${JSON.stringify(providerId.slice(0, 64))} is not configured`);
  if (!provider.models.includes(model)) {
    throw new ProviderSelectionError(`Model ${JSON.stringify(model.slice(0, 128))} is not allowed for provider ${provider.id}`);
  }

  let key: string | undefined;
  if (options.uploaderKey !== undefined) {
    if (!provider.allowUploaderKey) throw new ProviderSelectionError(`Provider ${provider.id} does not accept uploader-supplied keys`);
    if (!isValidApiKey(options.uploaderKey)) {
      throw new ProviderSelectionError("Uploader API key is invalid (8-512 characters, no whitespace or control characters)");
    }
    key = options.uploaderKey;
  } else {
    key = serverKeys.get(provider);
    if (key === undefined && provider.kind !== "openai_compatible") {
      throw new ProviderSelectionError(`Provider ${provider.id} has no server key; an uploader key is required`);
    }
  }

  const common = {
    prices: config.prices,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
  };
  switch (provider.kind) {
    case "openai":
      return new OpenAIChatProvider({ ...common, apiKey: key as string, baseUrl: provider.baseUrl ?? OPENAI_DEFAULT_BASE_URL, id: provider.id });
    case "anthropic":
      return new AnthropicChatProvider({ ...common, apiKey: key as string, id: provider.id });
    case "openai_compatible":
      return new OpenAICompatibleChatProvider({
        ...common,
        baseUrl: provider.baseUrl as string,
        ...(key !== undefined ? { apiKey: key } : {}),
        id: provider.id,
        label: provider.label,
      });
  }
}
