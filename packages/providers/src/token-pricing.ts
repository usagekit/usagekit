import { moneyScale } from "@usagekit/core";
import type { Cost, Money, Quantity } from "@usagekit/core";

/**
 * Tokens of one call or one turn. `input` excludes the cached tokens counted separately.
 * `input` and `output` are required: an absent count is unknown usage, never zero.
 */
export type TokenCounts = {
  input: number | bigint;
  /** Every generated token, reasoning included. */
  output: number | bigint;
  cacheRead?: number | bigint;
  cacheWrite?: number | bigint;
};
/**
 * Host-owned prices: money per one million tokens. The library ships no provider prices.
 * A missing cache price falls back to the input price, which never undercharges a read.
 */
export type TokenPrices = { input: Money; output: Money; cacheRead?: Money; cacheWrite?: Money };

const million = 1_000_000n;
/** A missing count fails here like any other malformed one; callers default the optional ones. */
function count(value: number | bigint): bigint {
  if (typeof value === "bigint" ? value < 0n : !Number.isSafeInteger(value) || value < 0)
    throw new Error("InvalidInput: tokens");
  return BigInt(value);
}
function rate(price: Money, scale: number): bigint {
  if (typeof price?.units !== "bigint" || price.units < 0n || price.currency !== "USD")
    throw new Error("InvalidInput: prices");
  return price.units * 10n ** BigInt(scale - moneyScale(price));
}
/** Exact cost of the counts, rounded up to one unit at the finest declared price scale (legacy: 1/10000 cent). */
export function priceTokens(counts: TokenCounts, prices: TokenPrices): Money {
  const scale = Math.max(
    ...[prices.input, prices.output, prices.cacheRead, prices.cacheWrite]
      .filter((p): p is Money => p != null)
      .map(moneyScale),
  );
  const input = rate(prices.input, scale);
  const exact =
    count(counts.input) * input +
    count(counts.output) * rate(prices.output, scale) +
    count(counts.cacheRead ?? 0) * (prices.cacheRead ? rate(prices.cacheRead, scale) : input) +
    count(counts.cacheWrite ?? 0) * (prices.cacheWrite ? rate(prices.cacheWrite, scale) : input);
  return {
    units: (exact + million - 1n) / million,
    currency: "USD",
    ...(Object.values(prices).some((p) => p?.scale !== undefined) ? { scale } : {}),
  };
}
export type TokenQuantityOptions = {
  prices?: TokenPrices;
  /** Budget unit of the token total; defaults to "tokens". */
  tokensUnit?: string;
  /** Budget unit of the priced amount, in cents at the price scale. Requires prices. */
  moneyUnit?: string;
};
/**
 * Quantities for a reserve estimate or a settlement, in the host's budget units. The cost is
 * `estimated` because it comes from the host's price table, not from a provider invoice.
 * Without prices the cost is unknown. The operation stays pending unless its settlement policy allows optional money.
 */
export function tokenQuantities(
  counts: TokenCounts,
  options: TokenQuantityOptions = {},
): { usage: Quantity[]; cost: Cost } {
  if (options.moneyUnit !== undefined && !options.prices)
    throw new Error("InvalidInput: moneyUnit requires prices");
  const usage: Quantity[] = [
    {
      unit: options.tokensUnit ?? "tokens",
      value:
        count(counts.input) +
        count(counts.output) +
        count(counts.cacheRead ?? 0) +
        count(counts.cacheWrite ?? 0),
      scale: 0,
    },
  ];
  if (!options.prices) return { usage, cost: { certainty: "unknown", money: null } };
  const money = priceTokens(counts, options.prices);
  if (options.moneyUnit !== undefined)
    usage.push({ unit: options.moneyUnit, value: money.units, scale: moneyScale(money) });
  return { usage, cost: { certainty: "estimated", money } };
}
