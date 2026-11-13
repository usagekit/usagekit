import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import type { Budget, Operation, Receipt, ReserveInput } from "@usagekit/core";
import { createManualClock } from "@usagekit/store";
import { saveBudget } from "./budgets.js";
import { encode } from "./codec.js";
import {
  createNodePostgresDriver,
  createPrismaPostgresDriver,
  createPostgresStore,
  migratePostgresStore,
} from "./index.js";
import type { PrismaPostgresClient, PrismaPostgresTransaction } from "./index.js";
import { transactions } from "./sql.js";

export function testDatabaseUrl() {
  const value = process.env.USAGEKIT_POSTGRES_TEST_URL;
  if (!value) throw new Error("Run npm run test:postgres for the owned real Postgres fixture");
  const url = new URL(value);
  if (
    !["127.0.0.1", "localhost", "postgres"].includes(url.hostname) ||
    url.pathname !== "/usagekit_store_fixture"
  )
    throw new Error("Postgres tests require the isolated local/CI usagekit_store_fixture database");
  return value;
}
interface TestClient extends PrismaPostgresClient, PrismaPostgresTransaction {
  $disconnect(): Promise<void>;
}
export async function prismaClient(): Promise<TestClient> {
  const generated = await import(
    pathToFileURL(resolve("node_modules/.cache/usagekit-prisma-fixture/client/client.ts")).href
  );
  return new generated.PrismaClient({
    // Prisma's timestamp decoder assumes UTC on reads; keep this numeric suite in UTC.
    adapter: new PrismaPg({
      connectionString: testDatabaseUrl(),
      max: 5,
      options: "-c TimeZone=UTC",
    }),
  });
}
export async function fixture(mode: "pg" | "prisma" = "pg") {
  const schema = `uk_test_${randomUUID().replaceAll("-", "")}`;
  const connect = () =>
    new Pool({ connectionString: testDatabaseUrl(), max: 5, connectionTimeoutMillis: 5000 });
  let pool = connect();
  let prisma = mode === "prisma" ? await prismaClient() : undefined;
  const driver = () =>
    prisma ? createPrismaPostgresDriver(prisma) : createNodePostgresDriver(pool);
  try {
    await migratePostgresStore({ driver: driver(), schema, createSchema: true });
  } catch (error) {
    await prisma?.$disconnect();
    await pool.end();
    throw error;
  }
  const clock = createManualClock(),
    budgets: Budget[] = [],
    counters = { statements: 0, changes: 0n, rowsRead: 0 };
  let current = await createPostgresStore({ driver: driver(), clock, schema, counters });
  const seen = new Map<string, string>();
  let syncing = Promise.resolve();
  const sync = () =>
    (syncing = syncing.then(async () => {
      for (const budget of budgets) {
        const key = `${budget.scope.namespace}:${budget.id}:${budget.version}`,
          body = encode(budget);
        if (seen.get(key) === body) continue;
        await transactions(driver(), schema, counters).write((sql) =>
          saveBudget(sql, budget, true),
        );
        seen.set(key, body);
      }
    }));
  const store = new Proxy(current, {
    get(_target, name) {
      const value = current[name as keyof typeof current];
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await sync();
        return Reflect.apply(value, current, args);
      };
    },
  });
  return {
    store,
    driver,
    clock,
    budgets,
    schema,
    connect,
    counters,
    client: () => pool,
    async replayMoneyMigration() {
      await pool.query(
        `ALTER TABLE "${schema}".metering_receipt DROP COLUMN cost_scale; DELETE FROM "${schema}".metering_schema_version WHERE version=2`,
      );
      await migratePostgresStore({ driver: driver(), schema });
    },
    async moneyColumns() {
      const rows = await driver().transaction(true, (sql) =>
        sql.query<{ cost_units: string; cost_scale: number }>({
          text: `SELECT cost_units,cost_scale FROM "${schema}".metering_receipt ORDER BY recorded_at,receipt_pk`,
          values: [],
        }),
      );
      return rows.sort((a, b) => a.cost_scale - b.cost_scale);
    },
    async restart() {
      await prisma?.$disconnect();
      await pool.end();
      pool = connect();
      prisma = mode === "prisma" ? await prismaClient() : undefined;
      current = await createPostgresStore({ driver: driver(), clock, schema, counters });
      return store;
    },
    async close() {
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await prisma?.$disconnect();
        await pool.end();
      }
    },
  };
}
export const request = (operationId: string = randomUUID()): ReserveInput => ({
  operationId,
  scope: { namespace: "test", principal: "u1", connection: "c1" },
  fundingSource: "byok",
  costOwner: "u1",
  surface: "app",
  source: "app",
  provider: "search",
  operation: "search",
  estimate: [{ unit: "requests", value: 1n, scale: 0 }],
});
export const bound = (version = 1): Budget => ({
  id: "one-slot",
  version,
  scope: { kind: "principal", namespace: "test", principal: "u1" },
  surface: "any",
  unit: "requests",
  limit: { unit: "requests", value: 1n, scale: 0 },
  onExceed: "block",
  window: { kind: "since_reset", epoch: `epoch-${version}`, startsAt: "2026-09-01T00:00:00.000Z" },
});
export const command = (op: Operation) => ({
  namespace: op.scope.namespace,
  principal: op.scope.principal,
  operationId: op.operationId,
  expectedVersion: op.version,
  commandId: randomUUID(),
});
export const receipt = (): Receipt => ({
  id: randomUUID(),
  measurements: [
    {
      unit: "requests",
      certainty: "measured",
      quantity: { unit: "requests", value: 1n, scale: 0 },
    },
  ],
  cost: { certainty: "measured", money: { units: 1n, currency: "USD" } },
  cached: false,
  failed: false,
  occurredAt: "2026-09-23T12:00:00.000Z",
  recordedAt: "2026-09-23T12:00:00.000Z",
});
