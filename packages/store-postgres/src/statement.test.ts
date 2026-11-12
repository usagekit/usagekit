import { expect, test } from "vitest";
import { SQL, schemaIdentifier } from "./statement.js";

test("nested fragments bind hostile values without rewriting literal dollar placeholders", () => {
  const hostile = "x'); DROP TABLE metering_operation; --";
  const fragment = SQL.sql`principal=${hostile} AND n IN (${SQL.join([1, 2])})`;
  expect(
    SQL.sql`SELECT '$1' AS literal WHERE ${fragment} AND namespace=${"tenant"}`.compile(),
  ).toEqual({
    text: "SELECT '$1' AS literal WHERE principal=$1 AND n IN ($2,$3) AND namespace=$4",
    values: [hostile, 1, 2, "tenant"],
  });
});
test.each(["public;DROP SCHEMA public", 'x"', "a".repeat(64), "pg_temp.x", ""])(
  "rejects an unsafe or truncated schema identifier: %s",
  (value) => {
    expect(() => schemaIdentifier(value)).toThrow("Invalid metering schema");
  },
);

test("numeric storage refusals remain typed through pg and Prisma executors", async () => {
  const { createSql } = await import("./sql.js");
  for (const error of [
    { code: "22003" },
    { code: "P2010", meta: { code: "22003" } },
    { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "22003" } } } },
  ]) {
    const sql = createSql(
      {
        query: async () => {
          throw error;
        },
        execute: async () => {
          throw error;
        },
      },
      { statements: 0, changes: 0n, rowsRead: 0 },
    );
    await expect(sql.query(SQL.sql`SELECT 1`)).rejects.toThrow("InvalidInput: quantity");
    await expect(sql.execute(SQL.sql`SELECT 1`)).rejects.toThrow("InvalidInput: quantity");
  }
  const error = new Error("unrelated failure");
  const sql = createSql(
    {
      query: async () => {
        throw error;
      },
      execute: async () => {
        throw error;
      },
    },
    { statements: 0, changes: 0n, rowsRead: 0 },
  );
  await expect(sql.query(SQL.sql`SELECT 1`)).rejects.toBe(error);
});
