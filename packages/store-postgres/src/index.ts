import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Budget } from "@usagekit/core";
import type { Clock, Store } from "@usagekit/store";
import { billingImports } from "./billing.js";
import { currentBudgets, matchingScopes, saveBudget, status } from "./budgets.js";
import { commands } from "./commands.js";
import { requestCounters } from "./counters.js";
import { createNodePostgresDriver, type PostgresDriver, type PostgresExecutor } from "./driver.js";
import { operationsReader } from "./operations.js";
import { usageReader } from "./reads.js";
import { find } from "./records.js";
import { verifySchemaVersion } from "./schema-version.js";
import { createSql, SQL, transactions, type Counters } from "./sql.js";

export {
  createNodePostgresDriver,
  createPrismaPostgresDriver,
  nodePostgresExecutor,
  prismaPostgresExecutor,
} from "./driver.js";
export type {
  PostgresDriver,
  PostgresExecutor,
  PrismaPostgresClient,
  PrismaPostgresTransaction,
} from "./driver.js";
export type { ParameterizedQuery } from "./statement.js";
export type { Counters as PostgresStoreCounters } from "./sql.js";
export { migratePostgresStore } from "./migrate.js";
export { PostgresSchemaVersionError } from "./schema-version.js";

type Storage = { pool: Pool; driver?: never } | { driver: PostgresDriver; pool?: never };
export type PostgresStoreOptions = Storage & {
  clock: Clock;
  schema?: string;
  counters?: Counters;
  testHooks?: { afterOperationWrite?: () => void };
};
export async function createPostgresStore(options: PostgresStoreOptions) {
  const counters = options.counters ?? { statements: 0, changes: 0n, rowsRead: 0 };
  const driver = options.driver ?? createNodePostgresDriver(options.pool);
  return compose(
    transactions(driver, options.schema ?? "public", counters),
    options.clock,
    counters,
    options.testHooks?.afterOperationWrite,
  );
}
/** Caller owns the transaction, search_path, isolation, commit and rollback. */
export async function createTransactionBoundStore({
  transaction,
  clock,
  counters = {
    statements: 0,
    changes: 0n,
    rowsRead: 0,
  },
  afterOperationWrite,
}: {
  transaction: PostgresExecutor;
  clock: Clock;
  counters?: Counters;
  afterOperationWrite?: () => void;
}) {
  const sql = createSql(transaction, counters);
  const run = <T>(body: (client: typeof sql) => Promise<T>) => body(sql);
  return compose({ read: run, write: run }, clock, counters, afterOperationWrite);
}
async function compose(
  tx: ReturnType<typeof transactions>,
  clock: Clock,
  counters: Counters,
  afterOperationWrite?: () => void,
) {
  const secret = await tx.write(async (sql) => {
    await verifySchemaVersion(sql);
    await sql.execute(SQL.sql`INSERT INTO metering_metadata(key,value)
      VALUES('cursor_key',${randomBytes(32).toString("hex")}) ON CONFLICT(key) DO NOTHING`);
    const [row] = await sql.query<{ value: string }>(
      SQL.sql`SELECT value FROM metering_metadata WHERE key='cursor_key'`,
    );
    if (!row) throw new Error("Missing metering cursor key");
    return row.value;
  });
  const aggregate = usageReader(clock, secret),
    operations = operationsReader(clock, secret);
  const store: Store = {
    ...billingImports(tx, clock, afterOperationWrite),
    ...commands(tx, clock, afterOperationWrite),
    ...requestCounters(tx, clock),
    listOperations: (query) => tx.read((sql) => operations(sql, query)),
    getOperation: (ref) => tx.read(async (sql) => (await find(sql, ref))?.op ?? null),
    aggregate: (query) => tx.read((sql) => aggregate(sql, query)),
    definedBudgets: (query) =>
      tx.read((sql) => currentBudgets(sql, query.scope.namespace, [query.scope])),
    applicableBudgets: (query) =>
      tx.read(async (sql) => {
        const budgets = await currentBudgets(
          sql,
          query.scope.namespace,
          matchingScopes(query),
          query.surface,
          query.source,
        );
        const result = [];
        for (const budget of budgets) result.push(await status(sql, budget, clock.now()));
        return result;
      }),
  };
  return {
    ...store,
    putBudget: (budget: Budget) => tx.write((sql) => saveBudget(sql, budget)),
    listBudgets: (namespace: string) => tx.read((sql) => currentBudgets(sql, namespace)),
    counters,
  };
}
export type PostgresStore = Awaited<ReturnType<typeof createPostgresStore>>;
