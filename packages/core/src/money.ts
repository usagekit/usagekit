import type { Money } from "./contracts.js";
/** Validated fractional-cent precision. Legacy values omit scale and use four digits. */
export function moneyScale(m: Pick<Money, "scale">): number {
  const scale = m.scale === undefined ? 4 : m.scale;
  if (!Number.isInteger(scale) || scale < 0 || scale > 18)
    throw new Error("InvalidInput: money.scale");
  return scale;
}
export function fromDecimalString(
  cents: string,
  options: { allowNegative?: boolean; scale?: number } = {},
): Money {
  const scale = moneyScale(options);
  if (!/^-?\d+(\.\d+)?$/.test(cents) || (!options.allowNegative && cents.startsWith("-")))
    throw new Error("InvalidInput: cents");
  const [whole, fraction = ""] = cents.replace("-", "").split(".");
  if (fraction.length > scale) throw new Error("InvalidInput: cents");
  return {
    currency: "USD",
    units:
      (BigInt(whole!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0")) *
      (cents.startsWith("-") ? -1n : 1n),
    ...(scale === 4 ? {} : { scale }),
  };
}
export function toDecimalString(m: Money): string {
  const scale = moneyScale(m),
    factor = 10n ** BigInt(scale);
  const n = m.units < 0n ? -m.units : m.units;
  return `${m.units < 0n ? "-" : ""}${n / factor}${scale ? "." + (n % factor).toString().padStart(scale, "0") : ""}`;
}
function aligned(a: Money, b: Money) {
  const scale = Math.max(moneyScale(a), moneyScale(b));
  return {
    scale,
    a: a.units * 10n ** BigInt(scale - moneyScale(a)),
    b: b.units * 10n ** BigInt(scale - moneyScale(b)),
  };
}
export function add(a: Money, b: Money): Money {
  const p = aligned(a, b);
  return {
    currency: "USD",
    units: p.a + p.b,
    ...(p.scale === 4 ? {} : { scale: p.scale }),
  };
}
export function sub(a: Money, b: Money): Money {
  const p = aligned(a, b);
  return {
    currency: "USD",
    units: p.a - p.b,
    ...(p.scale === 4 ? {} : { scale: p.scale }),
  };
}
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  const p = aligned(a, b);
  return p.a < p.b ? -1 : p.a > p.b ? 1 : 0;
}
/** Exact cents text, retaining the declared precision (four digits for legacy values). */
export const formatMoney: (m: Money) => string = toDecimalString;

/** Canonicalize explicit legacy money scales throughout a DTO without mutating the caller. */
export function normalizeLegacyMoney<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeLegacyMoney) as T;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return value;
  const object = value as Record<string, unknown>;
  const legacy = object.currency === "USD" && object.scale === 4 && "units" in object;
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !(legacy && key === "scale"))
      .map(([key, item]) => [key, normalizeLegacyMoney(item)]),
  ) as T;
}
