import { normalizeLegacyMoney } from "@usagekit/core";
import { InvalidInput } from "@usagekit/store";
export const encode = (value: unknown): string =>
  JSON.stringify(normalizeLegacyMoney(value), (_, v) =>
    typeof v === "bigint" ? { $bigint: v.toString() } : v,
  );
export const decode = <T>(text: string): T =>
  normalizeLegacyMoney(
    JSON.parse(text, (_, v) =>
      v && typeof v === "object" && Object.keys(v).length === 1 && typeof v.$bigint === "string"
        ? BigInt(v.$bigint)
        : v,
    ),
  ) as T;
export function integer(value: bigint | null): bigint | null {
  if (value !== null && (value < -(2n ** 63n) || value > 2n ** 63n - 1n))
    throw new InvalidInput("quantity", "signed 64-bit quantity bound");
  return value;
}
