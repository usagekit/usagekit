import { Decimal } from "@prisma/client/runtime/client";
import type { PoolClient } from "pg";
import { expect, test } from "vitest";
import { PostgresIntegrityError } from "./index.js";
import { nodePostgresExecutor, prismaPostgresExecutor } from "./driver.js";

const query = { text: "SELECT value", values: [], integerColumns: ["value"] };
const exact = "9223372036854775807000000000000000000";
const executor = (mode: "pg" | "prisma", value: unknown) =>
  mode === "pg"
    ? nodePostgresExecutor({
        query: async () => ({ rows: [[value]], fields: [{ name: "value", dataTypeID: 1700 }] }),
      } as unknown as PoolClient)
    : prismaPostgresExecutor({
        $queryRawUnsafe: async <T>() => [{ value }] as T,
        $executeRawUnsafe: async () => 0,
      });

test("Prisma expands exponent-form Decimal without rounding", async () => {
  const decimal = new Decimal(exact);
  expect(decimal.toString()).toBe("9.223372036854775807e+36");
  expect(decimal.toFixed()).toBe(exact);
  expect(await executor("prisma", decimal).query(query)).toEqual([{ value: exact }]);
});

// Exactness through pg is exercised against the real driver in numeric.postgres.test.ts.
test.each(["pg", "prisma"] as const)(
  "%s refuses fractional and non-finite numerics without rounding",
  async (mode) => {
    for (const text of ["1.5", "0.0000001", "-1.5", "NaN", "Infinity", "-Infinity"]) {
      const value = mode === "pg" ? text : new Decimal(text);
      await expect(executor(mode, value).query(query)).rejects.toBeInstanceOf(
        PostgresIntegrityError,
      );
      await expect(executor(mode, value).query(query)).rejects.toThrow(
        "expected an exact PostgreSQL integer",
      );
    }
  },
);

test.each(["pg", "prisma"] as const)(
  "%s preserves zero, signed integers and integral fixed-point text",
  async (mode) => {
    for (const [text, expected] of [
      ["0", "0"],
      ["-42", "-42"],
      ["42.000", "42"],
      ["99999999999999999999999999999999999999", "99999999999999999999999999999999999999"],
    ] as const) {
      const value = mode === "pg" ? text : new Decimal(text);
      expect(await executor(mode, value).query(query)).toEqual([{ value: expected }]);
    }
  },
);

test("Prisma normalizes bigint fields without changing JSON, dates, nulls or int4 metadata", async () => {
  const body = { value: "1e+30", count: 2, nested: { value: "1.5" } };
  const date = new Date("2026-09-01T00:00:00Z");
  const row = { n: 9223372036854775807n, version: 2, body, date, value: null };
  const sql = prismaPostgresExecutor({
    $queryRawUnsafe: async <T>() => [row] as T,
    $executeRawUnsafe: async () => 0,
  });
  expect(await sql.query(query)).toEqual([{ ...row, n: "9223372036854775807" }]);
  expect(row.n).toBe(9223372036854775807n);
});

test("pg refuses already rounded numerics from a custom parser", async () => {
  await expect(executor("pg", 1e36).query(query)).rejects.toMatchObject({
    name: "TypeError",
    message: expect.stringContaining("pg.types.setTypeParser"),
  });
  expect(await executor("pg", 42).query(query)).toEqual([{ value: "42" }]);
});

test.each(["pg", "prisma"] as const)(
  "%s normalizes exact custom parser value types",
  async (mode) => {
    for (const value of [42n, new Decimal("42.000")]) {
      expect(await executor(mode, value).query(query)).toEqual([{ value: "42" }]);
    }
  },
);

test.each(["pg", "prisma"] as const)("%s uses canonical fractional text", async (mode) => {
  for (const [text, expected] of [
    ["0.125000", "0.125"],
    ["-1.5000", "-1.5"],
    ["100.000", "100"],
    ["0.000", "0"],
    ["-0.000", "0"],
  ]) {
    const value = mode === "pg" ? text : new Decimal(text!);
    expect(await executor(mode, value).query({ text: "SELECT value", values: [] })).toEqual([
      { value: expected },
    ]);
  }
});

test.each(["pg", "prisma"] as const)("%s preserves unconsumed fractions exactly", async (mode) => {
  const text = "1.0000000000000000001";
  const value = mode === "pg" ? text : new Decimal(text);
  expect(await executor(mode, value).query({ text: "SELECT fraction", values: [] })).toEqual([
    { value: text },
  ]);
});
