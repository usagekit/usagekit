import { types } from "pg";
import { expect, test } from "vitest";
import { PostgresIntegrityError } from "./index.js";
import { bound, fixture, request } from "./test-fixture.js";

test.each(["pg", "prisma"] as const)(
  "%s reads exact numeric, int8 and aggregate fields",
  async (mode) => {
    const f = await fixture(mode);
    try {
      const rows = await f.driver().transaction(true, (sql) =>
        sql.query({
          text: `SELECT
          9223372036854775807000000000000000000::numeric(38,0) AS settled_value,
          -9223372036854775807000000000000000000::numeric(38,0) AS outstanding_value,
          9223372036854775807::bigint AS cost_units,
          sum(n) AS value, count(*) AS count,
          18::int AS scale, NULL::numeric AS missing,
          '{"value":"1e+36","count":2}'::jsonb AS body
          FROM (VALUES (9999999999999999999999999999999999999::numeric), (1)) AS t(n)`,
          values: [],
          integerColumns: ["settled_value", "outstanding_value", "cost_units", "value", "count"],
        }),
      );
      expect(rows).toEqual([
        {
          settled_value: "9223372036854775807000000000000000000",
          outstanding_value: "-9223372036854775807000000000000000000",
          cost_units: "9223372036854775807",
          value: "10000000000000000000000000000000000000",
          count: "2",
          scale: 18,
          missing: null,
          body: { value: "1e+36", count: 2 },
        },
      ]);
    } finally {
      await f.close();
    }
  },
);

test.each(["pg", "prisma"] as const)(
  "%s refuses fractional numeric results and rolls back atomically",
  async (mode) => {
    const f = await fixture(mode);
    try {
      await f.client().query(`CREATE TABLE "${f.schema}".numeric_marker(id text, value numeric)`);
      await f
        .client()
        .query(
          `INSERT INTO "${f.schema}".numeric_marker VALUES ('corrupt', 1.0000000000000000001)`,
        );
      await expect(
        f.driver().transaction(false, async (sql) => {
          await sql.execute({
            text: `INSERT INTO "${f.schema}".numeric_marker VALUES ('rollback', 0)`,
            values: [],
          });
          await sql.query({
            text: `SELECT value FROM "${f.schema}".numeric_marker WHERE id='corrupt'`,
            values: [],
            integerColumns: ["value"],
          });
        }),
      ).rejects.toBeInstanceOf(PostgresIntegrityError);
      expect(
        (await f.client().query(`SELECT id,value::text FROM "${f.schema}".numeric_marker`)).rows,
      ).toEqual([{ id: "corrupt", value: "1.0000000000000000001" }]);
    } finally {
      await f.close();
    }
  },
);

test.each(["pg", "prisma"] as const)(
  "%s preserves fractional numeric expressions",
  async (mode) => {
    const f = await fixture(mode);
    try {
      const rows = await f.driver().transaction(true, (sql) =>
        sql.query({
          text: `SELECT 1.0000000000000000001::numeric AS fraction,
        EXTRACT(EPOCH FROM TIMESTAMP '1970-01-01 00:00:00.125') AS epoch,
        avg(n) AS average, 1::numeric / 8 AS quotient
        FROM (VALUES (1::numeric), (2::numeric)) t(n)`,
          values: [],
        }),
      );
      expect(rows).toEqual([
        {
          fraction: "1.0000000000000000001",
          epoch: "0.125",
          average: "1.5",
          quotient: "0.125",
        },
      ]);
    } finally {
      await f.close();
    }
  },
);

test("pg normalizes duplicate join columns by field position", async () => {
  const f = await fixture();
  try {
    const rows = await f.driver().transaction(true, (sql) =>
      sql.query({
        text: `SELECT a.*, b.* FROM (SELECT 42::bigint AS value) a
        CROSS JOIN (SELECT 7::integer AS value) b`,
        values: [],
      }),
    );
    expect(rows).toEqual([{ value: 7 }]);
    const reversed = await f.driver().transaction(true, (sql) =>
      sql.query({
        text: `SELECT b.*, a.* FROM (SELECT 42::bigint AS value) a
        CROSS JOIN (SELECT 7::integer AS value) b`,
        values: [],
      }),
    );
    expect(reversed).toEqual([{ value: "42" }]);
  } finally {
    await f.close();
  }
});

test.each([20, 1700] as const)("pg identifies inexact global parser for OID %s", async (oid) => {
  const f = await fixture();
  const original = types.getTypeParser(oid, "text");
  try {
    types.setTypeParser(oid, (text) => Number(text));
    const query = {
      text: `SELECT 9007199254740993::${oid === 20 ? "bigint" : "numeric"} AS value`,
      values: [],
    };
    await expect(f.driver().transaction(true, (sql) => sql.query(query))).rejects.toMatchObject({
      name: "TypeError",
      message: expect.stringContaining("pg.types.setTypeParser"),
    });
  } finally {
    types.setTypeParser(oid, original);
    await f.close();
  }
});

test.each(["pg", "prisma"] as const)(
  "%s classifies stored budget corruption as integrity failure",
  async (mode) => {
    const f = await fixture(mode);
    try {
      await f.store.putBudget({ ...bound(), limit: null });
      expect((await f.store.reserve(request("seed"))).outcome).toBe("reserved");
      await f
        .client()
        .query(
          `ALTER TABLE "${f.schema}".metering_budget_usage ALTER COLUMN settled_value TYPE numeric`,
        );
      for (const value of ["1.0000000000000000001", "NaN", "Infinity", "-Infinity"]) {
        await f
          .client()
          .query(`UPDATE "${f.schema}".metering_budget_usage SET settled_value=$1::numeric`, [
            value,
          ]);
        await expect(f.store.reserve(request("refused"))).rejects.toMatchObject({
          name: "PostgresIntegrityError",
          column: "settled_value",
        });
        expect(
          await f.store.getOperation({
            namespace: "test",
            principal: "u1",
            operationId: "refused",
          }),
        ).toBeNull();
      }
    } finally {
      await f.close();
    }
  },
);
