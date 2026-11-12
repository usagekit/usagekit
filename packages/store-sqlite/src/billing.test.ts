import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import type {
  BillingImportInput,
  BillingImportResult,
  Budget,
  ReserveInput,
  Operation,
  Receipt,
} from "@usagekit/core";
import { createManualClock } from "@usagekit/store";
import { createSqliteStore } from "./index.js";
import { migrate } from "./migrate.js";

const ref = (op: ReserveInput) => ({
  namespace: op.scope.namespace,
  principal: op.scope.principal,
  operationId: op.operationId,
});
const command = (op: Operation) => ({
  ...ref(op),
  commandId: crypto.randomUUID(),
  expectedVersion: op.version,
});
const input = (): ReserveInput => ({
  operationId: crypto.randomUUID(),
  scope: { namespace: "test", principal: "u1", connection: "c1" },
  fundingSource: "byok",
  costOwner: "u1",
  surface: "app",
  source: "app",
  provider: "search",
  operation: "search",
  estimate: [{ value: 1n, scale: 0, unit: "requests" }],
});
const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({
  id: crypto.randomUUID(),
  measurements: [
    {
      unit: "requests",
      quantity: { value: 1n, scale: 0, unit: "requests" },
      certainty: "measured",
    },
  ],
  cost: { certainty: "measured", money: { units: 1n, currency: "USD" } },
  occurredAt: "2026-09-23T12:00:00.000Z",
  recordedAt: "2026-09-23T12:00:00.000Z",
  cached: false,
  failed: false,
  ...overrides,
});
const budget = (overrides: Partial<Budget>): Budget => ({
  id: crypto.randomUUID(),
  version: 1,
  scope: { kind: "principal", namespace: "test", principal: "u1" },
  surface: "any",
  unit: "requests",
  limit: { value: 2n, scale: 0, unit: "requests" },
  window: { kind: "calendar_month", timezone: "UTC" },
  onExceed: "block",
  ...overrides,
});

const billingInput = (overrides: Partial<BillingImportInput> = {}): BillingImportInput => ({
  scope: { namespace: "test", principal: "u1", connection: "c1" },
  provider: "search",
  fileHash: "a".repeat(64),
  window: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
  expectedPreviousImportId: null,
  attribution: { fundingSource: "byok", costOwner: "u1" },
  lines: [
    {
      providerRequestId: "provider-request",
      operation: "search",
      occurredAt: "2026-09-23T12:00:00.000Z",
      cost: { units: 9007199254740993n, currency: "USD" },
    },
  ],
  ...overrides,
});
const billingQuery = {
  scope: { namespace: "test", principal: "u1" },
  connection: "c1",
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-10-01T00:00:00.000Z",
};

test("billing journal upgrades v5 and retains exact imports, revisions and replays across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-import-")),
    path = join(dir, "usage.db"),
    clock = createManualClock();
  const legacy = new Database(path);
  migrate(legacy, 5);
  legacy.close();
  let store = createSqliteStore({ path, clock });
  try {
    expect(store.database.prepare("SELECT MAX(version) AS version FROM migrations").get()).toEqual({
      version: 7n,
    });
    const first = await store.importBilling(billingInput());
    if (first.outcome !== "imported") throw new Error("fixture import");
    const operationId = first.record.unobservedOperationIds[0]!;
    store.close();
    store = createSqliteStore({ path, clock });
    expect(await store.importBilling(billingInput())).toEqual({ ...first, replayed: true });
    const original = await store.getOperation({ namespace: "test", principal: "u1", operationId });
    expect(original).toMatchObject({
      state: "pending",
      source: "import",
      budgetEpochs: [],
      estimate: [],
      lease: null,
      receipts: [{ cost: { money: { units: 9007199254740993n } } }],
    });
    expect(
      await store.markDispatchIntent({ ...command(original!), holder: "h", leaseTtlMs: 1000 }),
    ).toMatchObject({ granted: false, reason: "already_dispatched" });
    const revisedInput = billingInput({
      fileHash: "b".repeat(64),
      expectedPreviousImportId: first.record.id,
      lines: [{ ...billingInput().lines[0]!, cost: { units: 9007199254740995n, currency: "USD" } }],
    });
    const revision = await store.importBilling(revisedInput);
    if (revision.outcome !== "imported") throw new Error("fixture revision");
    store.close();
    store = createSqliteStore({ path, clock });
    expect(await store.importBilling(revisedInput)).toEqual({ ...revision, replayed: true });
    const latest = await store.getOperation({ namespace: "test", principal: "u1", operationId });
    expect(latest!.receipts).toHaveLength(2);
    expect(latest!.receipts[1]!.cost.money!.units).toBe(9007199254740995n);
    expect(latest!.receipts[1]!.supersedes).toBe(latest!.receipts[0]!.id);
    expect((await store.billingImports(billingQuery)).records.map((r) => r.id)).toEqual([
      revision.record.id,
    ]);
    const history = (await store.billingImports({ ...billingQuery, history: true })).records;
    expect(history).toHaveLength(2);
    expect(history.find((r) => r.id === first.record.id)!.supersededBy).toBe(revision.record.id);
    expect((await store.billingImports({ ...billingQuery, connection: "other" })).records).toEqual(
      [],
    );
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM operations").get()).toEqual({ n: 1n });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("billing failure after a second operation write rolls back receipts, events, projections and marker", async () => {
  let fail = false,
    writes = 0;
  const clock = createManualClock(),
    store = createSqliteStore({
      path: ":memory:",
      clock,
      budgets: [budget({ limit: null })],
      testHooks: {
        afterOperationWrite: () => {
          if (fail && ++writes === 2) throw new Error("import crash");
        },
      },
    });
  try {
    const before = [];
    for (const providerRequestId of ["a", "b"]) {
      const reserved = await store.reserve(input());
      if (reserved.outcome !== "reserved") throw new Error("fixture reserve");
      const grant = await store.markDispatchIntent({
        ...command(reserved.operation),
        holder: "h",
        leaseTtlMs: 1000,
      });
      if (!("granted" in grant) || !grant.granted) throw new Error("fixture intent");
      const settled = await store.settle({
        ...command(grant.operation),
        authority: { kind: "lease", leaseId: grant.lease.leaseId },
        receipt: receipt({ providerRequestId, cost: { certainty: "unknown", money: null } }),
      });
      if (settled.outcome !== "settled") throw new Error("fixture receipt");
      before.push(settled.operation);
    }
    const projection = store.database.prepare("SELECT * FROM budget_usage").all();
    const events = store.database.prepare("SELECT * FROM operation_events").all();
    const imported = billingInput({
      lines: ["a", "b"].map((providerRequestId) => ({
        providerRequestId,
        operation: "search",
        occurredAt: "2026-09-23T12:00:00.000Z",
        cost: { units: 7n, currency: "USD" },
      })),
    });
    fail = true;
    await expect(store.importBilling(imported)).rejects.toThrow("import crash");
    expect(await Promise.all(before.map((op) => store.getOperation(ref(op))))).toEqual(before);
    expect(store.database.prepare("SELECT * FROM budget_usage").all()).toEqual(projection);
    expect(store.database.prepare("SELECT * FROM operation_events").all()).toEqual(events);
    for (const table of ["billing_imports", "billing_import_families"])
      expect(store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0n });
    fail = false;
    expect(await store.importBilling(imported)).toMatchObject({
      outcome: "imported",
      replayed: false,
    });
    expect(
      store.database.prepare("SELECT settled_value,outstanding_value FROM budget_usage").get(),
    ).toEqual({ settled_value: 2n, outstanding_value: 0n });
  } finally {
    store.close();
  }
});

const workerCode = `const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {createSqliteStore}=await import(workerData.module);const {createManualClock}=await import('@usagekit/store');const store=createSqliteStore({path:workerData.path,clock:createManualClock()});parentPort.postMessage('ready');parentPort.once('message',async()=>{try{parentPort.postMessage({result:await store.importBilling(workerData.input)});}catch(error){parentPort.postMessage({error:String(error)});}finally{store.close();}});})().catch(error=>parentPort.postMessage({error:String(error)}));`;
async function race(path: string, inputs: BillingImportInput[]): Promise<BillingImportResult[]> {
  const workers = inputs.map(
    (input) =>
      new Worker(workerCode, {
        eval: true,
        workerData: { path, input, module: new URL("../dist/index.js", import.meta.url).href },
      }),
  );
  const message = (worker: Worker) =>
    new Promise<any>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  try {
    expect(await Promise.all(workers.map(message))).toEqual(inputs.map(() => "ready"));
    const pending = Promise.all(workers.map(message));
    for (const worker of workers) worker.postMessage("go");
    const results = await pending;
    for (const result of results) if (result.error) throw new Error(result.error);
    return results.map((r) => r.result as BillingImportResult);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

test("independent SQLite workers serialize file replay and competing revision pointers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-import-race-")),
    path = join(dir, "usage.db"),
    store = createSqliteStore({ path, clock: createManualClock() });
  try {
    const initial = await race(path, [billingInput(), billingInput()]);
    expect(initial).toHaveLength(2);
    expect(initial.every((r) => r.outcome === "imported")).toBe(true);
    expect(initial.map((r) => r.outcome === "imported" && r.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const first = initial[0]!;
    if (first.outcome !== "imported") throw new Error("fixture initial");
    const revisions = await race(
      path,
      ["b", "c"].map((hash) =>
        billingInput({ fileHash: hash.repeat(64), expectedPreviousImportId: first.record.id }),
      ),
    );
    expect(revisions.map((r) => r.outcome).sort()).toEqual(["imported", "rejected"]);
    expect(revisions.find((r) => r.outcome === "rejected")).toMatchObject({
      reason: "previous_import_conflict",
    });
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM billing_imports").get()).toEqual({
      n: 2n,
    });
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM operations").get()).toEqual({ n: 1n });
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM receipts").get()).toEqual({ n: 2n });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("independent SQLite import snapshots admit one distinct initial file per family", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-import-initial-race-")),
    path = join(dir, "usage.db"),
    store = createSqliteStore({ path, clock: createManualClock() });
  try {
    const results = await race(path, [billingInput(), billingInput({ fileHash: "b".repeat(64) })]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["imported", "rejected"]);
    expect(results.find((result) => result.outcome === "rejected")).toMatchObject({
      reason: "previous_import_conflict",
    });
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM billing_imports").get()).toEqual({
      n: 1n,
    });
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM operations").get()).toEqual({ n: 1n });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an active recovery lease rejects an entire billing batch before ledger mutation", async () => {
  const clock = createManualClock(),
    store = createSqliteStore({ path: ":memory:", clock, budgets: [budget({ limit: null })] });
  const tables = [
    "operations",
    "receipts",
    "commands",
    "operation_events",
    "budget_usage",
    "budget_alerts",
    "billing_imports",
    "billing_import_families",
  ];
  const snapshot = () =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  try {
    for (const providerRequestId of ["safe", "active"]) {
      const reserved = await store.reserve(input());
      if (reserved.outcome !== "reserved") throw new Error("fixture reserve");
      const grant = await store.markDispatchIntent({
        ...command(reserved.operation),
        holder: "h",
        leaseTtlMs: 1000,
      });
      if (!("granted" in grant) || !grant.granted) throw new Error("fixture intent");
      const settled = await store.settle({
        ...command(grant.operation),
        authority: { kind: "lease", leaseId: grant.lease.leaseId },
        receipt: receipt({ providerRequestId, cost: { certainty: "unknown", money: null } }),
      });
      if (settled.outcome !== "settled") throw new Error("fixture receipt");
      if (providerRequestId === "active")
        expect(
          await store.claimForRecovery({
            ...ref(settled.operation),
            holder: "recovery",
            leaseTtlMs: 1000,
          }),
        ).toMatchObject({ claimed: true });
    }
    const before = snapshot();
    const imported = billingInput({
      lines: ["safe", "active"].map((providerRequestId) => ({
        providerRequestId,
        operation: "search",
        occurredAt: "2026-09-23T12:00:00.000Z",
        cost: { units: 7n, currency: "USD" },
      })),
    });
    expect(await store.importBilling(imported)).toMatchObject({
      outcome: "rejected",
      reason: "active_operation",
      line: 1,
    });
    expect(snapshot()).toEqual(before);
    clock.advance(1001);
    expect(await store.importBilling(imported)).toMatchObject({
      outcome: "imported",
      replayed: false,
    });
  } finally {
    store.close();
  }
});

test("receipt-less application work remains unknown in billing comparisons", async () => {
  const store = createSqliteStore({ path: ":memory:", clock: createManualClock() });
  try {
    const reserved = await store.reserve(input());
    if (reserved.outcome !== "reserved") throw new Error("fixture reserve");
    const result = await store.importBilling(
      billingInput({
        lines: [
          {
            occurredAt: "2026-09-23T12:00:00.000Z",
            window: billingInput().window,
            cost: { units: 0n, currency: "USD" },
          },
        ],
      }),
    );
    if (result.outcome !== "imported") throw new Error("fixture import");
    expect(result.record.reconciliations).toHaveLength(2);
    for (const reconciliation of result.record.reconciliations)
      expect(reconciliation).toMatchObject({
        ledgerTotal: { certainty: "unknown", money: null },
        unknownOperations: 1n,
        differenceUnits: null,
      });
    expect(await store.getOperation(ref(reserved.operation))).toEqual(reserved.operation);
    expect(result.record.matchedOperationIds).toEqual([]);
    expect(result.record.unobservedOperationIds).toEqual([]);
  } finally {
    store.close();
  }
});
