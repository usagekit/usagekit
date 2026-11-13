import { Decimal } from "@prisma/client/runtime/client";
import { expect, test } from "vitest";
import { PostgresIntegrityError } from "./integrity.js";
import { integerText, integerValue } from "./numeric.js";

const exact = "9223372036854775807000000000000000000";

test("shared read conversion accepts exact strings, bigint and raw Decimal-like values", () => {
  const decimal = new Decimal(exact);
  expect(decimal.toString()).toBe("9.223372036854775807e+36");
  for (const value of [
    exact,
    BigInt(exact),
    decimal,
    {
      toFixed: () => exact,
      valueOf: () => {
        throw new Error("lossy coercion");
      },
    },
  ]) {
    expect(integerValue(value, "value")).toBe(BigInt(exact));
    expect(integerText(value, "value")).toBe(exact);
  }
});

test("shared read conversion refuses fractional and non-finite custom executor values", () => {
  for (const text of ["1.0000000000000000001", "NaN", "Infinity", "-Infinity"]) {
    for (const value of [text, new Decimal(text)]) {
      expect(() => integerValue(value, "settled_value")).toThrow(PostgresIntegrityError);
      expect(() => integerValue(value, "settled_value")).toThrow("settled_value");
    }
  }
});
