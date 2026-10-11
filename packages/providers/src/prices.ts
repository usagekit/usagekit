import { addQuantity, formatQuantity } from "@usagekit/core";
import type { PriceRow, Quantity } from "@usagekit/core";
import type { EstimateInput } from "./types.js";
import { decimalQuantity } from "./receipts.js";

/**
 * The price row behind a list estimate. Rows must name the operation, match the connection plan
 * (rows without plan apply to any plan) and the overage state, and every option they name must
 * equal the request option. Plan-specific rows beat any-plan rows, then rows naming more options
 * win, then later validFrom. An operation priced per plan resolves nothing without a plan.
 */
export function selectPriceRow(input: EstimateInput): PriceRow | undefined {
  const rows = input.prices.filter((r) => r.operation === input.operation.id);
  if (input.plan === undefined && rows.some((r) => r.plan !== undefined)) return undefined;
  const candidates = rows.filter(
    (r) =>
      (r.plan === undefined || r.plan === input.plan) &&
      Boolean(r.overage) === Boolean(input.overage) &&
      Object.entries(r.option ?? {}).every(([k, v]) => input.options[k] === v),
  );
  const rank = (r: PriceRow) => [r.plan ? 1 : 0, Object.keys(r.option ?? {}).length] as const;
  return candidates.sort((a, b) => {
    const [ap, ao] = rank(a),
      [bp, bo] = rank(b);
    return bp - ap || bo - ao || b.validFrom.localeCompare(a.validFrom);
  })[0];
}

/** Exact multiplication; reduce only trailing zeros, never round a coefficient. */
function multiply(a: Quantity, b: Quantity): Quantity {
  let value = a.value * b.value,
    scale = a.scale + b.scale;
  while (scale > 18 && value % 10n === 0n) {
    value /= 10n;
    scale--;
  }
  if (scale > 18) throw new Error("InvalidInput: calculation precision exceeds 18");
  return decimalQuantity(formatQuantity({ value, scale, unit: a.unit }), a.unit);
}
const count = (value: string | undefined, fallback: bigint): bigint => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error("InvalidInput: expected integer pricing count");
  return BigInt(value);
};
/** List formula or item override; an absent required item count leaves the price unknown. */
export function calculatePrice(
  row: PriceRow,
  options: Readonly<Record<string, string>>,
  itemPrice?: Quantity,
): Quantity | undefined {
  const base = decimalQuantity(row.perUnit, row.unit),
    c = row.calculation;
  if (!c) {
    if (itemPrice) throw new Error("InvalidInput: item price requires a base-plus-items row");
    return base;
  }
  if (c.kind === "additional_pages") {
    if (itemPrice) throw new Error("InvalidInput: item price requires a base-plus-items row");
    const depth = count(options[c.depthOption], BigInt(c.pageSize));
    if (depth < 1n) throw new Error("InvalidInput: depth must be positive");
    const pages = (depth + BigInt(c.pageSize) - 1n) / BigInt(c.pageSize);
    const extra = multiply(base, decimalQuantity(c.additionalPageFactor, row.unit));
    return decimalQuantity(
      formatQuantity(addQuantity(base, { ...extra, value: extra.value * (pages - 1n) })),
      row.unit,
    );
  }
  if (c.kind === "option_multiplier") {
    if (itemPrice) throw new Error("InvalidInput: item price requires a base-plus-items row");
    return options[c.multiplierOption.key] === c.multiplierOption.value
      ? multiply(base, decimalQuantity(c.multiplierOption.factor, row.unit))
      : base;
  }
  if (itemPrice && itemPrice.unit !== row.unit)
    throw new Error("InvalidInput: item price unit differs from row");
  // An omitted count is unknown, not zero. Never reserve just the base for an item formula.
  if (options[c.itemCountOption] === undefined) return undefined;
  const coefficient = itemPrice ?? decimalQuantity(c.perItem, row.unit);
  const items = count(options[c.itemCountOption], 0n);
  let total = addQuantity(base, { ...coefficient, value: coefficient.value * items });
  if (c.multiplierOption && options[c.multiplierOption.key] === c.multiplierOption.value)
    total = multiply(total, decimalQuantity(c.multiplierOption.factor, row.unit));
  return decimalQuantity(formatQuantity(total), row.unit);
}

/** Default estimate: selected base price and optional formula; empty without a row or count. */
export function listEstimate(input: EstimateInput): Quantity[] {
  const row = selectPriceRow(input);
  const quantity = row && calculatePrice(row, input.options);
  return quantity ? [quantity] : [];
}
