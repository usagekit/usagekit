import type { Pool, PoolClient } from "pg";
import { integerText, isDecimal, numericText } from "./numeric.js";
import type { ParameterizedQuery } from "./statement.js";

/**
 * Values are bound separately from text by every driver implementation.
 * Built-in executors return numeric and int8 fields as exact, exponent-free strings.
 * Custom executors may also return bigint or Decimal-like values for integral fields.
 * int2/int4 metadata, JSON, dates and nulls retain their types.
 */
export interface PostgresExecutor {
  query<T>(query: ParameterizedQuery): Promise<T[]>;
  execute(query: ParameterizedQuery): Promise<number>;
}
export interface PostgresDriver {
  transaction<T>(readOnly: boolean, body: (sql: PostgresExecutor) => Promise<T>): Promise<T>;
}
function normalizeValue(value: unknown, column: string, numeric: boolean, integer: boolean) {
  if (value === null) return value;
  if (!numeric && !integer) return value;
  return integer ? integerText(value, column) : numericText(value, column);
}
export function nodePostgresExecutor(client: PoolClient): PostgresExecutor {
  return {
    async query<T>({ text, values, integerColumns = [] }: ParameterizedQuery) {
      // pg object rows retain the last duplicate name. Keep its matching field index and type.
      const result = await client.query<unknown[]>({ text, values, rowMode: "array" });
      const fields = new Map(result.fields.map((field, index) => [field.name, { field, index }]));
      return result.rows.map((row) =>
        Object.fromEntries(
          [...fields.values()].map(({ field, index }) => [
            field.name,
            normalizeValue(
              row[index],
              field.name,
              field.dataTypeID === 20 || field.dataTypeID === 1700,
              integerColumns.includes(field.name),
            ),
          ]),
        ),
      ) as T[];
    },
    async execute({ text, values }) {
      return (await client.query(text, values)).rowCount ?? 0;
    },
  };
}
/** One checked-out connection owns BEGIN, every statement, COMMIT and ROLLBACK. */
export function createNodePostgresDriver(pool: Pool): PostgresDriver {
  return {
    async transaction(readOnly, body) {
      const client = await pool.connect();
      let destroy = false;
      try {
        await client.query(
          readOnly
            ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
            : "BEGIN ISOLATION LEVEL READ COMMITTED",
        );
        await client.query("SET LOCAL statement_timeout = '30s'");
        await client.query("SET LOCAL lock_timeout = '10s'");
        const result = await body(nodePostgresExecutor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroy = true;
        }
        throw error;
      } finally {
        client.release(destroy);
      }
    },
  };
}

export interface PrismaPostgresTransaction {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
export interface PrismaPostgresClient {
  $transaction<T>(
    body: (transaction: PrismaPostgresTransaction) => Promise<T>,
    options: {
      timeout: number;
      maxWait: number;
      isolationLevel: "RepeatableRead" | "ReadCommitted";
    },
  ): Promise<T>;
}
/** The Unsafe-named Prisma methods still bind every value as a positional parameter. */
export function prismaPostgresExecutor(transaction: PrismaPostgresTransaction): PostgresExecutor {
  // Prisma's pg adapter encodes Date without an offset. Preserve the UTC instant for timestamptz
  // even when a host connection uses a non-UTC TimeZone, including caller-owned transactions.
  const parameters = (values: unknown[]) =>
    values.map((value) => (value instanceof Date ? value.toISOString() : value));
  return {
    async query<T>({ text, values, integerColumns = [] }: ParameterizedQuery) {
      const rows = await transaction.$queryRawUnsafe<Record<string, unknown>[]>(
        text,
        ...parameters(values),
      );
      // Only top-level SQL values; JSON bodies must retain the host's representation.
      return rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([column, value]) => [
            column,
            normalizeValue(
              value,
              column,
              typeof value === "bigint" || isDecimal(value),
              integerColumns.includes(column),
            ),
          ]),
        ),
      ) as T[];
    },
    execute: ({ text, values }) => transaction.$executeRawUnsafe(text, ...parameters(values)),
  };
}
export function createPrismaPostgresDriver(prisma: PrismaPostgresClient): PostgresDriver {
  return {
    transaction: (readOnly, body) =>
      prisma.$transaction(
        async (transaction) => {
          if (readOnly) await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          return body(prismaPostgresExecutor(transaction));
        },
        {
          timeout: 30000,
          maxWait: 10000,
          isolationLevel: readOnly ? "RepeatableRead" : "ReadCommitted",
        },
      ),
  };
}
