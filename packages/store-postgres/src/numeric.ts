import { PostgresIntegrityError } from "./integrity.js";

export type IntegerValue = string | bigint | { toFixed(): string };

export function isDecimal(value: unknown): value is { toFixed(): string } {
  return (
    !!value &&
    typeof value === "object" &&
    "toFixed" in value &&
    typeof value.toFixed === "function"
  );
}

export function numericText(value: unknown, column: string): string {
  let text: string;
  if (isDecimal(value)) text = value.toFixed();
  else if (typeof value === "string" || typeof value === "bigint") text = String(value);
  else if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
  else
    throw new TypeError(
      `PostgreSQL numeric parser returned an inexact or unsupported value in ${column}; ` +
        "check pg.types.setTypeParser for int8/numeric or the custom executor; " +
        "return exact strings, bigint or Decimal-like values instead of JavaScript numbers",
    );
  // Remove scale padding without passing any digit through floating-point arithmetic.
  if (/^-?\d+\.\d+$/.test(text)) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

export function integerText(value: unknown, column: string): string {
  const text = numericText(value, column);
  if (!/^-?\d+$/.test(text))
    throw new PostgresIntegrityError(column, "expected an exact PostgreSQL integer");
  return text;
}

/** Custom executors may return a raw Decimal whose valueOf/toString uses exponent notation. */
export function integerValue(value: unknown, column: string): bigint {
  return BigInt(integerText(value, column));
}
