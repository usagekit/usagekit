import { expect, test } from "vitest";
import { fromDecimalString, toDecimalString, add, sub, compare } from "./money.js";
import * as q from "./quantity.js";
test("decimal cents are exact and bounded to four fractional digits", () => {
  expect(fromDecimalString("0.0001").units).toBe(1n);
  expect(fromDecimalString("12.3456").units).toBe(123456n);
  expect(() => fromDecimalString("0.00001")).toThrow();
  expect(() => fromDecimalString("-1")).toThrow();
  expect(toDecimalString(fromDecimalString("-1.23", { allowNegative: true }))).toBe("-1.2300");
  expect(() => fromDecimalString("NaN")).toThrow();
});
test("ten thousand tiny receipts add without rounding", () => {
  let m = fromDecimalString("0");
  for (let n = 0; n < 10000; n++) m = add(m, fromDecimalString("0.0001"));
  expect(m.units).toBe(10000n);
  expect(sub(m, fromDecimalString("1")).units).toBe(0n);
  expect(compare(m, fromDecimalString("2"))).toBe(-1);
  expect(compare(m, m)).toBe(0);
  expect(compare(m, fromDecimalString("0"))).toBe(1);
});
test("quantities normalize scale, compare and reject different units", () => {
  const a = { value: 12n, scale: 1, unit: "units" },
    b = { value: 1n, scale: 2, unit: "units" };
  expect(q.add(a, b)).toEqual({ value: 121n, scale: 2, unit: "units" });
  expect(q.normalizeScale(a, 2).value).toBe(120n);
  expect(q.compare(a, b)).toBe(1);
  expect(q.compare(b, a)).toBe(-1);
  expect(q.compare(a, a)).toBe(0);
  expect(() => q.add(a, { ...b, unit: "other" })).toThrow("UnitMismatch");
  expect(() => q.normalizeScale(a, 0)).toThrow();
});

test("explicit precision aligns exact arithmetic without changing legacy shapes", () => {
  const fine = fromDecimalString("0.00000013", { scale: 8 });
  const legacy = fromDecimalString("0.0001");
  expect(fine).toEqual({ units: 13n, currency: "USD", scale: 8 });
  expect(toDecimalString(add(fine, legacy))).toBe("0.00010013");
  expect(toDecimalString(sub(legacy, fine))).toBe("0.00009987");
  expect(compare(fine, legacy)).toBe(-1);
  expect(compare(fromDecimalString("1", { scale: 0 }), fromDecimalString("1"))).toBe(0);
  expect(toDecimalString(fromDecimalString("-2", { scale: 0, allowNegative: true }))).toBe("-2");
  expect(add(legacy, legacy)).toEqual({ units: 2n, currency: "USD" });
  for (const scale of [-1, 19, 1.2, NaN])
    expect(() => fromDecimalString("1", { scale })).toThrow("money.scale");
  expect(() => fromDecimalString("0.000000131", { scale: 8 })).toThrow("cents");
});

test("explicit legacy precision has the same constructor and arithmetic shape", () => {
  const legacy = fromDecimalString("0.0001");
  const explicit = fromDecimalString("0.0001", { scale: 4 });
  expect(explicit).toEqual(legacy);
  expect(add({ ...legacy, scale: 4 }, legacy)).toEqual({ units: 2n, currency: "USD" });
  expect(sub({ ...legacy, scale: 4 }, legacy)).toEqual({ units: 0n, currency: "USD" });
});
