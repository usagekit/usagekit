import { formatMoney, formatQuantity } from "@usagekit/core";
import type { Certainty, Cost, Measurement, Quantity, ReadResult } from "@usagekit/core";

/**
 * An exact amount as text. Text comes from formatQuantity or formatMoney, never from a number.
 * Unknown certainty carries empty text: the figure does not exist, and a component renders its
 * own unknown label instead of a zero.
 */
export type Amount = { text: string; unit: string; certainty: Certainty };
/** "unavailable" names a figure that is missing, forbidden or redacted. It is never zero. */
export type Figure = Amount | "unavailable";
export type ViewState = "ok" | "forbidden" | "unavailable" | "empty";
export type Problem =
  | { kind: "invalid"; field: string; reason: string }
  | { kind: "error"; message: string };
/** Unit label of money amounts: formatMoney prints exact cents at the declared precision. */
export const moneyUnit = "cents";

export const quantityAmount = (q: Quantity, certainty: Certainty = "measured"): Amount => ({
  text: formatQuantity(q),
  unit: q.unit,
  certainty,
});
export const measurementAmount = (m: Measurement): Amount =>
  m.certainty === "unknown"
    ? { text: "", unit: m.unit, certainty: "unknown" }
    : quantityAmount(m.quantity, m.certainty);
export const costAmount = (c: Cost): Amount =>
  c.certainty === "unknown"
    ? { text: "", unit: moneyUnit, certainty: "unknown" }
    : { text: formatMoney(c.money), unit: moneyUnit, certainty: c.certainty };

const rank: Record<Certainty, number> = { measured: 0, estimated: 1, unknown: 2 };
/** The weakest certainty wins: one unknown figure makes the whole row unknown. */
export const weakest = (values: readonly Certainty[]): Certainty =>
  values.reduce<Certainty>((a, b) => (rank[b] > rank[a] ? b : a), "measured");

const scaled = (q: Quantity, scale: number) => q.value * 10n ** BigInt(scale - q.scale);
/** Exact comparison at any scale; both quantities share the budget unit. */
export function compare(a: Quantity, b: Quantity): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale),
    x = scaled(a, scale),
    y = scaled(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
export function plus(a: Quantity, b: Quantity): Quantity {
  const scale = Math.max(a.scale, b.scale);
  return { unit: a.unit, scale, value: scaled(a, scale) + scaled(b, scale) };
}
/** percent of a quantity without rounding: value * percent at two more fractional digits. */
export const percentOf = (q: Quantity, percent: bigint): Quantity => ({
  unit: q.unit,
  value: q.value * percent,
  scale: q.scale + 2,
});
/** Share of total in percent, truncated to two fractional digits, as exact text. */
export const share = (count: bigint, total: bigint): string | null =>
  total === 0n ? null : formatQuantity({ value: (count * 10000n) / total, scale: 2, unit: "%" });

export type Attempt<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "forbidden" }
  | { outcome: "unavailable"; problem: Problem };
/** Maps a Meter read to the view states. A throw or a malformed answer is unavailable. */
export async function attempt<T>(call: () => Promise<ReadResult<T>>): Promise<Attempt<T>> {
  try {
    const r = await call();
    if (r.outcome === "ok") return { outcome: "ok", value: r.value };
    if (r.outcome === "forbidden") return { outcome: "forbidden" };
    if (r.outcome === "invalid")
      return {
        outcome: "unavailable",
        problem: { kind: "invalid", field: r.field, reason: r.reason },
      };
    throw new Error("Unexpected read result");
  } catch (error) {
    return { outcome: "unavailable", problem: failure(error) };
  }
}
export const failure = (error: unknown): Problem => ({
  kind: "error",
  message: error instanceof Error ? error.message : String(error),
});
