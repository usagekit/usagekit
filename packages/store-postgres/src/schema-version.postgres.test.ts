import { expect, test } from "vitest";
import {
  createPostgresStore,
  createTransactionBoundStore,
  migratePostgresStore,
  nodePostgresExecutor,
  PostgresSchemaVersionError,
} from "./index.js";
import { command, fixture, receipt, request } from "./test-fixture.js";

for (const version of [0, 1, 3])
  test(`D2 schema ${version} refuses store creation before any write`, async () => {
    const f = await fixture();
    try {
      const pool = f.client();
      await pool.query(`TRUNCATE "${f.schema}".metering_metadata`);
      if (version === 0) await pool.query(`DROP TABLE "${f.schema}".metering_schema_version`);
      if (version === 1)
        await pool.query(`ALTER TABLE "${f.schema}".metering_receipt DROP COLUMN cost_scale;
          DELETE FROM "${f.schema}".metering_schema_version WHERE version=2`);
      if (version === 3)
        await pool.query(`INSERT INTO "${f.schema}".metering_schema_version VALUES(3,'future')`);
      const error = {
        name: "PostgresSchemaVersionError",
        actualVersion: version,
        requiredVersion: 2,
        message: expect.stringContaining("migratePostgresStore"),
      };
      const creation = createPostgresStore({ pool, schema: f.schema, clock: f.clock });
      await expect(creation).rejects.toMatchObject(error);
      await expect(creation).rejects.toBeInstanceOf(PostgresSchemaVersionError);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('search_path',$1,true)", [`"${f.schema}"`]);
        const boundCreation = createTransactionBoundStore({
          transaction: nodePostgresExecutor(client),
          clock: f.clock,
        });
        await expect(boundCreation).rejects.toMatchObject(error);
        await expect(boundCreation).rejects.toBeInstanceOf(PostgresSchemaVersionError);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      for (const table of [
        "metering_metadata",
        "metering_operation",
        "metering_receipt",
        "metering_command",
        "metering_event",
        "metering_budget_usage",
      ])
        expect(
          (await pool.query(`SELECT count(*) AS n FROM "${f.schema}".${table}`)).rows[0].n,
        ).toBe("0");
    } finally {
      await f.close();
    }
  });

test("D2 explicit migration makes an older database writable", async () => {
  const f = await fixture();
  try {
    const pool = f.client();
    await pool.query(`ALTER TABLE "${f.schema}".metering_receipt DROP COLUMN cost_scale;
      DELETE FROM "${f.schema}".metering_schema_version WHERE version=2`);
    await migratePostgresStore({ pool, schema: f.schema });
    const store = await createPostgresStore({ pool, schema: f.schema, clock: f.clock });
    const r = await store.reserve(request());
    if (r.outcome !== "reserved") throw new Error("reserve fixture");
    const g = await store.markDispatchIntent({
      ...command(r.operation),
      holder: "test",
      leaseTtlMs: 1000,
    });
    if (!("granted" in g) || !g.granted) throw new Error("dispatch fixture");
    expect(
      await store.settle({
        ...command(g.operation),
        authority: { kind: "lease", leaseId: g.lease.leaseId },
        receipt: receipt(),
      }),
    ).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
  } finally {
    await f.close();
  }
});
