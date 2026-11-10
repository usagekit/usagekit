import type { Cost, Money, Quantity } from "@usagekit/core";

/** Tokens of one call or one turn. `input` excludes the cached tokens counted separately. */
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
function count(value: number | bigint | undefined): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "bigint" ? value < 0n : !Number.isSafeInteger(value) || value < 0)
    throw new Error("InvalidInput: tokens");
  return BigInt(value);
}
function rate(price: Money): bigint {
  if (typeof price?.units !== "bigint" || price.units < 0n || price.currency !== "USD")
    throw new Error("InvalidInput: prices");
  return price.units;
}
/** Exact cost of the counts, rounded up to one money unit (1/10000 cent). */
export function priceTokens(counts: TokenCounts, prices: TokenPrices): Money {
  const input = rate(prices.input);
  const exact =
    count(counts.input) * input +
    count(counts.output) * rate(prices.output) +
    count(counts.cacheRead) * (prices.cacheRead ? rate(prices.cacheRead) : input) +
    count(counts.cacheWrite) * (prices.cacheWrite ? rate(prices.cacheWrite) : input);
  return { units: (exact + million - 1n) / million, currency: "USD" };
}
export type TokenQuantityOptions = {
  prices?: TokenPrices;
  /** Budget unit of the token total; defaults to "tokens". */
  tokensUnit?: string;
  /** Budget unit of the priced amount, in cents with four decimals. Requires prices. */
  moneyUnit?: string;
};
/**
 * Quantities for a reserve estimate or a settlement, in the host's budget units. The cost is
 * `estimated` because it comes from the host's price table, not from a provider invoice.
 * Without prices the cost is unknown and the operation that settles with it stays pending.
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
        count(counts.cacheRead) +
        count(counts.cacheWrite),
      scale: 0,
    },
  ];
  if (!options.prices) return { usage, cost: { certainty: "unknown", money: null } };
  const money = priceTokens(counts, options.prices);
  if (options.moneyUnit !== undefined)
    usage.push({ unit: options.moneyUnit, value: money.units, scale: 4 });
  return { usage, cost: { certainty: "estimated", money } };
}
