import { expect, test } from "vitest";
import {
  createTransactionBoundStore,
  type PostgresExecutor,
  type ParameterizedQuery,
} from "./index.js";
import { bound, command, fixture, prismaClient, receipt, request } from "./test-fixture.js";

test("custom bigint executor preserves quantities, counts and both cursor snapshots", async () => {
  const f = await fixture(),
    client = await f.client().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path',$1,true)", [`"${f.schema}"`]);
    // Match raw Prisma/pg int8 and integral numeric results. int2/int4 metadata remains numeric.
    const transaction: PostgresExecutor = {
      async query<T>({ text, values, integerColumns = [] }: ParameterizedQuery) {
        const result = await client.query(text, values);
        return result.rows.map((row) =>
          Object.fromEntries(
            result.fields.map((field) => [
              field.name,
              row[field.name] !== null &&
              ([20, 1700].includes(field.dataTypeID) || integerColumns.includes(field.name))
                ? BigInt(row[field.name])
                : row[field.name],
            ]),
          ),
        ) as T[];
      },
      async execute({ text, values }) {
        return (await client.query(text, values)).rowCount ?? 0;
      },
    };
    const store = await createTransactionBoundStore({ transaction, clock: f.clock });
    await store.putBudget({ ...bound(), limit: null });
    for (const provider of ["one", "two"]) {
      const reserved = await store.reserve({ ...request(provider), provider });
      if (reserved.outcome !== "reserved") throw new Error("fixture");
      const granted = await store.markDispatchIntent({
        ...command(reserved.operation),
        holder: "h",
        leaseTtlMs: 1000,
      });
      if (!("granted" in granted) || !granted.granted) throw new Error("fixture");
      expect(
        (
          await store.settle({
            ...command(granted.operation),
            authority: { kind: "lease", leaseId: granted.lease.leaseId },
            receipt: receipt(),
          })
        ).outcome,
      ).toBe("settled");
    }
    const q = {
      scope: { kind: "namespace" as const, namespace: "test" },
      from: "2026-09-01T00:00:00Z",
      to: "2026-10-01T00:00:00Z",
      limit: 1,
    };
    const budgets = await store.applicableBudgets({
      scope: request().scope,
      surface: "app",
      units: ["requests"],
    });
    expect(budgets[0]!.used?.value).toBe(2n);
    await store.countRequest({
      commandId: "count",
      scope: request().scope,
      surface: "programmatic",
      source: "proxy",
      provider: "search",
      operation: "search",
      state: "passthrough",
    });
    expect((await store.requestCounts({ ...q, groupBy: [] })).rows[0]!.count).toBe(1n);
    const operations = await store.listOperations(q);
    expect(typeof operations.watermark).toBe("string");
    expect(operations.nextCursor).toBeTruthy();
    expect((await store.listOperations({ ...q, cursor: operations.nextCursor! })).watermark).toBe(
      operations.watermark,
    );
    const usageQuery = { ...q, units: ["requests"], groupBy: ["provider" as const] };
    const usage = await store.aggregate(usageQuery);
    expect(typeof usage.watermark).toBe("string");
    expect(usage.nextCursor).toBeTruthy();
    expect((await store.aggregate({ ...usageQuery, cursor: usage.nextCursor! })).watermark).toBe(
      usage.watermark,
    );
    expect(usage.rows[0]!.measurements[0]!.quantity!.value).toBe(1n);
    expect(usage.rows[0]!.cost.money!.units).toBe(1n);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await f.close();
  }
});

test("raw Prisma custom executor preserves mixed-scale budget totals and usage", async () => {
  const f = await fixture();
  const prisma = await prismaClient();
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe("SELECT set_config('search_path',$1,true)", `"${f.schema}"`);
        const transaction: PostgresExecutor = {
          query: ({ text, values }) => tx.$queryRawUnsafe(text, ...values),
          execute: ({ text, values }) => tx.$executeRawUnsafe(text, ...values),
        };
        const store = await createTransactionBoundStore({ transaction, clock: f.clock });
        await store.putBudget({ ...bound(), limit: null });
        const max = 2n ** 63n - 1n;
        for (const scale of [0, 18]) {
          const quantity = { unit: "requests", value: max, scale };
          const reserved = await store.reserve({
            ...request(`scale-${scale}`),
            estimate: [quantity],
          });
          if (reserved.outcome !== "reserved") throw new Error("fixture");
          const granted = await store.markDispatchIntent({
            ...command(reserved.operation),
            holder: "h",
            leaseTtlMs: 1000,
          });
          if (!("granted" in granted) || !granted.granted) throw new Error("fixture");
          expect(
            (
              await store.settle({
                ...command(granted.operation),
                authority: { kind: "lease", leaseId: granted.lease.leaseId },
                receipt: {
                  ...receipt(),
                  measurements: [{ unit: quantity.unit, quantity, certainty: "measured" }],
                },
              })
            ).outcome,
          ).toBe("settled");
        }
        const budgets = await store.applicableBudgets({
          scope: request().scope,
          surface: "app",
          units: ["requests"],
        });
        expect(budgets[0]!.used).toMatchObject({ value: max * 10n ** 18n + max, scale: 18 });
        expect(budgets[0]!.reserved?.value).toBe(0n);
        const usage = await store.aggregate({
          scope: { kind: "namespace", namespace: "test" },
          from: "2026-09-01T00:00:00Z",
          to: "2026-10-01T00:00:00Z",
          units: ["requests"],
          groupBy: [],
        });
        expect(usage.rows[0]!.measurements[0]!.quantity).toMatchObject({
          value: max * 10n ** 18n + max,
          scale: 18,
        });
        expect(usage.rows[0]!.cost.money!.units).toBe(2n);
        await store.countRequest({
          commandId: "raw-count",
          scope: request().scope,
          surface: "programmatic",
          source: "proxy",
          provider: "search",
          operation: "search",
          state: "passthrough",
        });
        expect(
          (
            await store.requestCounts({
              scope: { kind: "namespace", namespace: "test" },
              from: "2026-09-01T00:00:00Z",
              to: "2026-10-01T00:00:00Z",
              groupBy: [],
            })
          ).rows[0]!.count,
        ).toBe(1n);
      },
      { timeout: 30000, maxWait: 10000, isolationLevel: "ReadCommitted" },
    );
  } finally {
    await prisma.$disconnect();
    await f.close();
  }
});
