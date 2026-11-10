import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { priceTokens, tokenQuantities } from "./token-pricing.js";
import type { TokenPrices } from "./token-pricing.js";

const usd = (units: bigint) => ({ units, currency: "USD" as const });
/** $3 and $15 per million tokens: 3 and 15 money units per token. */
const prices: TokenPrices = { input: usd(3_000_000n), output: usd(15_000_000n) };

describe("token pricing", () => {
  it("prices each token class from the host table", () => {
    expect(
      priceTokens(
        { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 100 },
        { ...prices, cacheRead: usd(300_000n), cacheWrite: usd(3_750_000n) },
      ),
    ).toEqual(usd(3000n + 3000n + 1200n + 375n));
  });
  it("charges cached tokens at the input price when the table has no cache price", () => {
    expect(priceTokens({ input: 0, output: 0, cacheRead: 10, cacheWrite: 10 }, prices)).toEqual(
      usd(60n),
    );
  });
  it("rounds a fractional money unit up, never down to zero", () => {
    const cheap: TokenPrices = { input: usd(1n), output: usd(1n) };
    expect(priceTokens({ input: 1, output: 0 }, cheap)).toEqual(usd(1n));
    expect(priceTokens({ input: 1_000_000, output: 1 }, cheap)).toEqual(usd(2n));
    expect(priceTokens({ input: 0, output: 0 }, cheap)).toEqual(usd(0n));
  });
  it("rejects negative, fractional and unsafe counts and negative prices", () => {
    for (const input of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, -1n])
      expect(() => priceTokens({ input, output: 0 }, prices)).toThrow("InvalidInput: tokens");
    expect(() => priceTokens({ input: 1, output: 0 }, { ...prices, input: usd(-1n) })).toThrow(
      "InvalidInput: prices",
    );
  });
  it("is monotonic and never below the exact amount", () => {
    fc.assert(
      fc.property(
        fc.nat(5_000_000),
        fc.nat(5_000_000),
        fc.nat(1000),
        fc.bigInt(0n, 100_000_000n),
        fc.bigInt(0n, 100_000_000n),
        (input, output, more, inputPrice, outputPrice) => {
          const table = { input: usd(inputPrice), output: usd(outputPrice) };
          const cost = priceTokens({ input, output }, table).units;
          const exact = BigInt(input) * inputPrice + BigInt(output) * outputPrice;
          expect(cost * 1_000_000n).toBeGreaterThanOrEqual(exact);
          expect((cost - 1n) * 1_000_000n).toBeLessThan(exact === 0n ? 1n : exact);
          expect(priceTokens({ input: input + more, output }, table).units).toBeGreaterThanOrEqual(
            cost,
          );
        },
      ),
    );
  });
  it("builds token and money quantities in the host's units", () => {
    expect(
      tokenQuantities(
        { input: 1000, output: 200, cacheRead: 50 },
        { prices, tokensUnit: "assistant_tokens", moneyUnit: "customer_cents" },
      ),
    ).toEqual({
      usage: [
        { unit: "assistant_tokens", value: 1250n, scale: 0 },
        // 6150 money units are 0.6150 cents.
        { unit: "customer_cents", value: 6150n, scale: 4 },
      ],
      cost: { certainty: "estimated", money: usd(6150n) },
    });
  });
  it("without prices reports tokens only and an unknown cost", () => {
    expect(tokenQuantities({ input: 7, output: 3 })).toEqual({
      usage: [{ unit: "tokens", value: 10n, scale: 0 }],
      cost: { certainty: "unknown", money: null },
    });
    expect(() => tokenQuantities({ input: 7, output: 3 }, { moneyUnit: "customer_cents" })).toThrow(
      "InvalidInput: moneyUnit requires prices",
    );
  });
});
