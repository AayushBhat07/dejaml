import { z } from "zod";
import type { ModelPrice, TokenUsage } from "./types.js";

/** Environment variable holding an administrator-supplied price table (JSON). */
export const PRICE_TABLE_ENV = "DEJAML_MODEL_PRICES";

/**
 * Built-in prices in USD per million tokens. Empty on purpose: prices change
 * and are not guessed here, so cost is reported as unknown (null) unless the
 * administrator supplies a table through `DEJAML_MODEL_PRICES`.
 */
export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({});

const nonNegative = z.number().finite().nonnegative();

export const ModelPriceSchema = z.strictObject({
  inputPerMTok: nonNegative,
  outputPerMTok: nonNegative,
  cacheReadPerMTok: nonNegative.optional(),
});

export const PriceTableSchema = z.record(z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/), ModelPriceSchema);

export class PriceTableError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid ${PRICE_TABLE_ENV}: ${problems.join("; ")}`);
    this.name = "PriceTableError";
  }
}

/** Parses and validates a price table JSON string. Throws `PriceTableError`. */
export function parsePriceTable(json: string): Record<string, ModelPrice> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new PriceTableError(["not valid JSON"]);
  }
  const result = PriceTableSchema.safeParse(raw);
  if (!result.success) {
    throw new PriceTableError(
      result.error.issues.map((i) => `${i.path.length ? i.path.map(String).join(".") : "(root)"}: ${i.message}`),
    );
  }
  const out: Record<string, ModelPrice> = {};
  for (const [model, p] of Object.entries(result.data)) {
    out[model] =
      p.cacheReadPerMTok !== undefined
        ? { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok, cacheReadPerMTok: p.cacheReadPerMTok }
        : { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok };
  }
  return out;
}

/**
 * Estimated cost in USD, or null when no price is known. `inputTokens` is
 * billed at the input rate; cache reads at the cache-read rate (input rate
 * when none is configured). Cache writes are billed at the input rate because
 * no cache-write price is configured (a lower bound for Anthropic).
 */
export function estimateCostUsd(usage: TokenUsage, price: ModelPrice | undefined): number | null {
  if (!price) return null;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cost =
    (usage.inputTokens + cacheWrite) * price.inputPerMTok +
    cacheRead * (price.cacheReadPerMTok ?? price.inputPerMTok) +
    usage.outputTokens * price.outputPerMTok;
  return Math.round((cost / 1_000_000) * 1e9) / 1e9;
}

/** Looks up a model's price in `prices` (defaults to `DEFAULT_PRICES`). */
export function priceFor(model: string, prices: Readonly<Record<string, ModelPrice>> = DEFAULT_PRICES): ModelPrice | undefined {
  return Object.prototype.hasOwnProperty.call(prices, model) ? prices[model] : undefined;
}
