import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test } from "vitest";
import {
  createPostgresStore,
  createPrismaPostgresDriver,
  createTransactionBoundStore,
  migratePostgresStore,
  prismaPostgresExecutor,
} from "./index.js";
import type { PrismaPostgresClient, PrismaPostgresTransaction } from "./index.js";
import { createSql, SQL } from "./sql.js";
import { bound, fixture, request, testDatabaseUrl } from "./test-fixture.js";

interface TestClient extends PrismaPostgresClient, PrismaPostgresTransaction {
  $disconnect(): Promise<void>;
}
test("real Prisma and pg share migration locks, admission and caller-owned rollback", async () => {
  const generated = await import(
    pathToFileURL(resolve("node_modules/.cache/usagekit-prisma-fixture/client/client.ts")).href
  );
  const Client = generated.PrismaClient as new (options: { adapter: PrismaPg }) => TestClient;
  const db = new Client({
    adapter: new PrismaPg({
      connectionString: testDatabaseUrl(),
      max: 6,
      options: "-c TimeZone=Europe/Warsaw",
    }),
  });
  const f = await fixture();
  try {
    const driver = createPrismaPostgresDriver(db);
    await migratePostgresStore({ driver, schema: f.schema });
    const store = await createPostgresStore({ driver, schema: f.schema, clock: f.clock });
    for (let epoch = 1; epoch <= 10; epoch++) {
      await store.putBudget(bound(epoch));
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) => (index % 2 ? store : f.store).reserve(request())),
      );
      expect(results.filter((r) => r.outcome === "reserved")).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "exceeded")).toHaveLength(9);
    }
    await db.$executeRawUnsafe(`CREATE TABLE "${f.schema}".host_marker(id text PRIMARY KEY)`);
    await expect(
      db.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe(`SET LOCAL search_path TO "${f.schema}"`);
          await transaction.$executeRawUnsafe(
            "INSERT INTO host_marker(id) VALUES($1)",
            "host-write",
          );
          const joined = await createTransactionBoundStore({
            transaction: prismaPostgresExecutor(transaction),
            clock: f.clock,
          });
          const input = request("joined");
          input.scope.namespace = "rollback";
          expect((await joined.reserve(input)).outcome).toBe("reserved");
          throw new Error("owned rollback");
        },
        { timeout: 30000, maxWait: 10000, isolationLevel: "ReadCommitted" },
      ),
    ).rejects.toThrow("owned rollback");
    expect(
      await f.store.getOperation({ namespace: "rollback", principal: "u1", operationId: "joined" }),
    ).toBeNull();
    expect(
      (await f.client().query(`SELECT count(*) AS n FROM "${f.schema}".host_marker`)).rows[0].n,
    ).toBe("0");
    await expect(
      driver.transaction(false, (executor) =>
        createSql(executor, { statements: 0, changes: 0n, rowsRead: 0 }).query(
          SQL.sql`SELECT ${"100000000000000000000000000000000000000"}::numeric(38,0)`,
        ),
      ),
    ).rejects.toThrow("InvalidInput: quantity");
    const hostile = "literal $1 ' ); DROP TABLE host_marker; --";
    expect(
      await driver.transaction(true, (sql) =>
        sql.query({ text: "SELECT $1::text AS value", values: [hostile] }),
      ),
    ).toEqual([{ value: hostile }]);
    await expect(
      driver.transaction(true, (sql) =>
        sql.execute({
          text: `INSERT INTO "${f.schema}".host_marker(id) VALUES($1)`,
          values: ["forbidden-read-write"],
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await db.$disconnect();
    await f.close();
  }
});
