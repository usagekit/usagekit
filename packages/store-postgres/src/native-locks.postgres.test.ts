import { expect, test } from "vitest";
import type { ReserveInput } from "@usagekit/core";
import { createNodePostgresDriver, createPostgresStore } from "./index.js";
import type { ParameterizedQuery, PostgresDriver } from "./index.js";
import { bound, command, fixture, receipt, request } from "./test-fixture.js";
import { key } from "./codec.js";

const barrier = () => {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
};

test("E1 connection-less concurrent corrections cannot commit a canonical chain", async () => {
  const f = await fixture();
  const checked = [barrier(), barrier()];
  const resume = [barrier(), barrier()];
  const pending: Promise<unknown>[] = [];
  try {
    const settled = [];
    for (const id of ["a", "b", "c"]) {
      const r = await f.store.reserve({
        ...request(id),
        // Defensive runtime case: the public Scope type requires a connection.
        scope: { namespace: "test", principal: "u1" } as ReserveInput["scope"],
        settlementPolicy: { requiredUnits: ["requests"], requireMoney: false },
      });
      if (r.outcome !== "reserved") throw new Error("reserve fixture");
      const g = await f.store.markDispatchIntent({
        ...command(r.operation),
        holder: "test",
        leaseTtlMs: 1000,
      });
      if (!("granted" in g) || !g.granted) throw new Error("dispatch fixture");
      const original = { ...receipt(), providerRequestId: "same-native-request" };
      const result = await f.store.settle({
        ...command(g.operation),
        authority: { kind: "lease", leaseId: g.lease.leaseId },
        receipt: original,
      });
      if (result.outcome !== "settled") throw new Error("settle fixture");
      settled.push({ operation: result.operation, receiptId: original.id });
    }
    const base = createNodePostgresDriver(f.client());
    for (const [index, target] of ["c", "a"].entries()) {
      const store = await createPostgresStore({
        schema: f.schema,
        clock: f.clock,
        driver: {
          transaction: (readOnly, body) =>
            base.transaction(readOnly, async (sql) =>
              body({
                execute: (q) => sql.execute(q),
                async query<T>(q: ParameterizedQuery) {
                  const result = await sql.query<T>(q);
                  if (q.text.includes("SELECT 1 FROM metering_receipt r JOIN")) {
                    // Both canonical snapshots and empty dependent sets precede either commit.
                    expect(result).toEqual([]);
                    checked[index]!.release();
                    await resume[index]!.reached;
                  }
                  return result;
                },
              }),
            ),
        },
      });
      const original = settled[index]!;
      pending.push(
        store.correct({
          ...command(original.operation),
          authority: { kind: "late_evidence", source: "test" },
          replacesReceiptId: original.receiptId,
          reason: "canonical correction",
          receipt: {
            ...receipt(),
            providerRequestId: "same-native-request",
            canonicalOperationId: target,
            measurements: [],
            cost: { certainty: "unknown", money: null },
          },
        }),
      );
    }
    await Promise.all(checked.map((b) => b.reached));
    resume[0]!.release();
    const first = await pending[0];
    resume[1]!.release();
    expect([first, await pending[1]]).toEqual([
      expect.objectContaining({ outcome: "rejected", reason: "receipt_conflict" }),
      expect.objectContaining({ outcome: "rejected", reason: "receipt_conflict" }),
    ]);
    for (const operationId of ["a", "b", "c"]) {
      const operation = await f.store.getOperation({
        namespace: "test",
        principal: "u1",
        operationId,
      });
      expect(operation?.receipts).toHaveLength(1);
      expect(operation?.receipts[0]?.canonicalOperationId).toBeUndefined();
    }
  } finally {
    resume.forEach((b) => b.release());
    await Promise.allSettled(pending);
    await f.close();
  }
});

test("E2 command retries if a concurrent reserve was invisible when resolving locks", async () => {
  const f = await fixture();
  const inserted = barrier(),
    resume = barrier(),
    attempting = barrier();
  const pending: Promise<unknown>[] = [];
  let holderPid = 0,
    waiterPid = 0;
  const locks: string[] = [];
  let invisible = false;
  try {
    const base = createNodePostgresDriver(f.client());
    const instrumented = (holder: boolean): PostgresDriver => ({
      transaction: (readOnly, body) =>
        base.transaction(readOnly, async (sql) => {
          const [pid] = await sql.query<{ pid: number }>({
            text: "SELECT pg_backend_pid() AS pid",
            values: [],
          });
          if (holder) holderPid = pid!.pid;
          else waiterPid = pid!.pid;
          return body({
            async execute(q) {
              const result = await sql.execute(q);
              if (holder && q.text.includes("INSERT INTO metering_operation")) {
                inserted.release();
                await resume.reached;
              }
              return result;
            },
            async query<T>(q: ParameterizedQuery) {
              if (!holder)
                for (const v of q.values) {
                  if (typeof v === "string" && v.startsWith("metering:")) locks.push(v);
                  if (v === `metering:operation:${key("test", "invisible")}`) attempting.release();
                }
              const result = await sql.query<T>(q);
              if (
                !holder &&
                q.text.includes("SELECT * FROM metering_operation") &&
                result.length === 0
              )
                invisible = true;
              return result;
            },
          });
        }),
    });
    const holder = await createPostgresStore({
      driver: instrumented(true),
      schema: f.schema,
      clock: f.clock,
    });
    const waiter = await createPostgresStore({
      driver: instrumented(false),
      schema: f.schema,
      clock: f.clock,
    });
    const reserve = holder.reserve(request("invisible"));
    pending.push(reserve);
    await inserted.reached;
    const input = {
      namespace: "test",
      principal: "u1",
      operationId: "invisible",
      expectedVersion: 1,
      commandId: "invisible-intent",
      holder: "test",
      leaseTtlMs: 1000,
    };
    const intent = waiter.markDispatchIntent(input);
    pending.push(intent);
    await attempting.reached;
    let blocked: number[] = [];
    const deadline = Date.now() + 3000;
    while (!blocked.includes(holderPid) && Date.now() < deadline) {
      blocked = (await f.client().query("SELECT pg_blocking_pids($1) AS pids", [waiterPid])).rows[0]
        .pids;
      if (!blocked.includes(holderPid)) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(blocked).toContain(holderPid);
    expect(invisible).toBe(true);
    resume.release();
    expect(await reserve).toMatchObject({ outcome: "reserved" });
    expect(await intent).toMatchObject({
      granted: false,
      reason: "version_conflict",
      operation: { state: "reserved", version: 1 },
    });
    expect(locks).toEqual([`metering:operation:${key("test", "invisible")}`]);
    expect(await waiter.markDispatchIntent(input)).toMatchObject({ granted: true });
  } finally {
    resume.release();
    await Promise.allSettled(pending);
    await f.close();
  }
});

test("D3 mirrored cross-connection links never lock the target's budgets", async () => {
  const f = await fixture();
  const resume = barrier();
  const pending: Promise<unknown>[] = [];
  try {
    const grants = [];
    for (const connection of ["x", "y"]) {
      await f.store.putBudget({
        ...bound(),
        id: connection,
        scope: { kind: "connection", namespace: "test", connection },
      });
      const r = await f.store.reserve({
        ...request(connection),
        scope: { namespace: "test", principal: "u1", connection },
        settlementPolicy: { requiredUnits: ["requests"], requireMoney: false },
      });
      if (r.outcome !== "reserved") throw new Error("reserve fixture");
      const g = await f.store.markDispatchIntent({
        ...command(r.operation),
        holder: "test",
        leaseTtlMs: 1000,
      });
      if (!("granted" in g) || !g.granted) throw new Error("dispatch fixture");
      const original = { ...receipt(), providerRequestId: "same" };
      const settled = await f.store.settle({
        ...command(g.operation),
        authority: { kind: "lease", leaseId: g.lease.leaseId },
        receipt: original,
      });
      if (settled.outcome !== "settled") throw new Error("settlement fixture");
      grants.push({ operation: settled.operation, receiptId: original.id });
    }
    const base = createNodePostgresDriver(f.client());
    const locks: string[][] = [[], []];
    const loaded = [barrier(), barrier()];
    const stores = [];
    for (const [index, target] of ["y", "x"].entries())
      stores.push(
        await createPostgresStore({
          schema: f.schema,
          clock: f.clock,
          driver: {
            transaction: (readOnly, body) =>
              base.transaction(readOnly, async (sql) =>
                body({
                  execute: (q) => sql.execute(q),
                  async query<T>(q: ParameterizedQuery) {
                    for (const value of q.values)
                      if (typeof value === "string" && value.startsWith("metering:budget:"))
                        locks[index]!.push(value);
                    const result = await sql.query<T>(q);
                    if (
                      q.text.includes("SELECT body FROM metering_receipt") &&
                      q.values[0] === key("test", target)
                    ) {
                      loaded[index]!.release();
                      await resume.reached;
                    }
                    return result;
                  },
                }),
              ),
          },
        }),
      );
    for (const [index, g] of grants.entries())
      pending.push(
        stores[index]!.correct({
          ...command(g.operation),
          authority: { kind: "late_evidence", source: "test" },
          replacesReceiptId: g.receiptId,
          reason: "canonical link",
          receipt: {
            ...receipt(),
            canonicalOperationId: index === 0 ? "y" : "x",
            providerRequestId: "same",
            measurements: [],
            cost: { certainty: "unknown", money: null },
          },
        }),
      );
    await Promise.all(loaded.map((b) => b.reached));
    resume.release();
    expect(await Promise.all(pending)).toEqual([
      expect.objectContaining({ outcome: "rejected", reason: "receipt_conflict" }),
      expect.objectContaining({ outcome: "rejected", reason: "receipt_conflict" }),
    ]);
    expect(locks).toEqual([[`metering:budget:["test","x"]`], [`metering:budget:["test","y"]`]]);
  } finally {
    resume.release();
    await Promise.allSettled(pending);
    await f.close();
  }
});

// Explicit SQL barriers observe lock acquisition, never infer interleaving from Promise.all.
for (const first of ["correction", "link"] as const)
  test(`C4 ${first} holds connection accounting before the competing command can read canonical`, async () => {
    const f = await fixture();
    const paused = barrier(),
      resume = barrier(),
      competingLock = barrier();
    const pending: Promise<unknown>[] = [];
    let holderPid = 0,
      waiterPid = 0;
    try {
      const dispatch = async (id: string) => {
        const r = await f.store.reserve({
          ...request(id),
          settlementPolicy: { requiredUnits: ["requests"], requireMoney: false },
        });
        if (r.outcome !== "reserved") throw new Error("reserve fixture");
        const g = await f.store.markDispatchIntent({
          ...command(r.operation),
          holder: "native",
          leaseTtlMs: 1000,
        });
        if (!("granted" in g) || !g.granted) throw new Error("dispatch fixture");
        return g;
      };
      const a = await dispatch("canonical");
      const original = { ...receipt(), providerRequestId: "native" };
      const settled = await f.store.settle({
        ...command(a.operation),
        authority: { kind: "lease", leaseId: a.lease.leaseId },
        receipt: original,
      });
      if (settled.outcome !== "settled") throw new Error("settle fixture");
      const b = await dispatch("duplicate");
      const base = createNodePostgresDriver(f.client());
      const instrumented = (holder: boolean): PostgresDriver => ({
        transaction: (readOnly, body) =>
          base.transaction(readOnly, async (sql) => {
            const [pid] = await sql.query<{ pid: number }>({
              text: "SELECT pg_backend_pid() AS pid",
              values: [],
            });
            if (holder) holderPid = pid!.pid;
            else waiterPid = pid!.pid;
            return body({
              async query<T>(q: ParameterizedQuery) {
                if (
                  !holder &&
                  q.values.some(
                    (v) => typeof v === "string" && v.startsWith("metering:connection-accounting:"),
                  )
                )
                  competingLock.release();
                const result = await sql.query<T>(q);
                if (
                  holder &&
                  first === "link" &&
                  q.text.includes("SELECT body FROM metering_receipt") &&
                  q.values[0] === key("test", "canonical")
                ) {
                  paused.release();
                  await resume.reached;
                }
                return result;
              },
              async execute(q: ParameterizedQuery) {
                const result = await sql.execute(q);
                if (
                  holder &&
                  first === "correction" &&
                  q.text.includes("UPDATE metering_operation SET")
                ) {
                  paused.release();
                  await resume.reached;
                }
                return result;
              },
            });
          }),
      });
      const holder = await createPostgresStore({
        driver: instrumented(true),
        schema: f.schema,
        clock: f.clock,
      });
      const waiter = await createPostgresStore({
        driver: instrumented(false),
        schema: f.schema,
        clock: f.clock,
      });
      const correction = (store: typeof holder) =>
        store.correct({
          ...command(settled.operation),
          authority: { kind: "late_evidence", source: "test" },
          replacesReceiptId: original.id,
          reason: "missing required dimension",
          receipt: {
            ...receipt(),
            providerRequestId: "native",
            measurements: [],
            cost: { certainty: "unknown", money: null },
          },
        });
      const link = (store: typeof holder) =>
        store.settle({
          ...command(b.operation),
          authority: { kind: "lease", leaseId: b.lease.leaseId },
          receipt: {
            ...receipt(),
            providerRequestId: "native",
            canonicalOperationId: "canonical",
            measurements: [],
            cost: { certainty: "unknown", money: null },
          },
        });
      const held = first === "correction" ? correction(holder) : link(holder);
      pending.push(held);
      await paused.reached;
      const waiting = first === "correction" ? link(waiter) : correction(waiter);
      pending.push(waiting);
      await competingLock.reached;
      // Wait for the server, not a timer-based approximation of the command ordering.
      let blocked: number[] = [];
      const deadline = Date.now() + 3000;
      while (!blocked.includes(holderPid) && Date.now() < deadline) {
        blocked = (await f.client().query("SELECT pg_blocking_pids($1) AS pids", [waiterPid]))
          .rows[0].pids;
        if (!blocked.includes(holderPid)) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toContain(holderPid);
      resume.release();
      const heldResult = await held,
        waitingResult = await waiting;
      expect(heldResult).toMatchObject({ outcome: "settled" });
      expect(waitingResult).toMatchObject(
        first === "correction"
          ? { outcome: "rejected", reason: "receipt_conflict" }
          : { outcome: "settled" },
      );
      const canonical = await f.store.getOperation({
        namespace: "test",
        principal: "u1",
        operationId: "canonical",
      });
      expect(canonical).toMatchObject({
        state: "pending",
        receipts: [original, { measurements: [], cost: { certainty: "unknown", money: null } }],
      });
    } finally {
      resume.release();
      await Promise.allSettled(pending);
      await f.close();
    }
  });
