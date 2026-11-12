import { createHash } from "node:crypto";
import { moneyScale, normalizeTags } from "@usagekit/core";
import type { Quantity, ReserveInput, Receipt, Operation } from "@usagekit/core";
import { InvalidInput } from "@usagekit/store";
import { integer } from "./serialize.js";
export function canonical(v: unknown): string {
  if (typeof v === "bigint") return `"bigint:${v}"`;
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const key = (ns: string, id: string) => canonical([ns, id]);
/** Reserve identity: diagnostic ids, estimate provenance and attribution tags are not semantic. */
export const identity = (i: ReserveInput) => {
  const {
    correlationId: _,
    parentOperationId: __,
    estimateSource: _source,
    providerPriceVersion: _priceVersion,
    scope,
    ...rest
  } = i;
  const { tags: ___, ...scopeIdentity } = scope;
  return hash(
    canonical({
      ...rest,
      scope: scopeIdentity,
      estimate: [...i.estimate].sort((a, b) => a.unit.localeCompare(b.unit)),
      platformPools: [...(i.platformPools ?? [])].sort(),
    }),
  );
};
export function withNormalizedTags(i: ReserveInput): ReserveInput {
  if (i.scope.tags === undefined) return i;
  const tags = normalizeTags(i.scope.tags);
  if (!tags) throw new InvalidInput("scope.tags", "1 to 16 unique tags matching the tag pattern");
  return { ...i, scope: { ...i.scope, tags } };
}
export const plus = (a: Quantity, b: Quantity): Quantity => {
  const scale = Math.max(a.scale, b.scale);
  return {
    unit: a.unit,
    scale,
    value: a.value * 10n ** BigInt(scale - a.scale) + b.value * 10n ** BigInt(scale - b.scale),
  };
};
export const greater = (a: Quantity, b: Quantity) =>
  a.value * 10n ** BigInt(b.scale) > b.value * 10n ** BigInt(a.scale);
export const effective = (op: Operation) =>
  [...op.receipts].reverse().find((r) => !op.receipts.some((n) => n.supersedes === r.id));
export function validateQuantity(q: Quantity): void {
  if (
    typeof q.value !== "bigint" ||
    q.value < 0n ||
    !Number.isInteger(q.scale) ||
    q.scale < 0 ||
    q.scale > 18 ||
    !q.unit?.trim()
  )
    throw new InvalidInput("quantity");
  integer(q.value);
  if (q.unit === "cents" && q.value * 10000n > (2n ** 63n - 1n) * 10n ** BigInt(q.scale))
    throw new InvalidInput("quantity", "money storage bound");
}
export function validTtl(ttl: number, field = "leaseTtlMs"): void {
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 86400000) throw new InvalidInput(field);
}
export function validateReceipt(r: Receipt): void {
  if (
    !r.id?.trim() ||
    !Number.isFinite(Date.parse(r.occurredAt)) ||
    !Number.isFinite(Date.parse(r.recordedAt))
  )
    throw new InvalidInput("receipt");
  if (
    r.cost.certainty === "unknown"
      ? r.cost.money !== null
      : !r.cost.money ||
        typeof r.cost.money.units !== "bigint" ||
        r.cost.money.units < 0n ||
        r.cost.money.units > 2n ** 63n - 1n ||
        r.cost.money.currency !== "USD"
  )
    throw new InvalidInput("receipt.cost");
  if (r.cost.money) {
    try {
      moneyScale(r.cost.money);
    } catch {
      throw new InvalidInput("receipt.cost");
    }
  }
  for (const m of r.measurements) {
    if (m.certainty === "unknown") {
      if (m.quantity !== null || !m.unit) throw new InvalidInput("measurement");
    } else {
      validateQuantity(m.quantity);
      if (m.unit !== m.quantity.unit) throw new InvalidInput("measurement.unit");
    }
  }
  if (new Set(r.measurements.map((m) => m.unit)).size !== r.measurements.length)
    throw new InvalidInput("measurements", "duplicate unit");
}
