import { afterAll, expect, test } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runStoreConformance, runStoreScalingConformance } from "@usagekit/store/conformance";
import { createManualClock, InvalidInput } from "@usagekit/store";
import type { Store } from "@usagekit/store";
import type { Budget, BillingImportInput } from "@usagekit/core";
import type { SqlMetrics } from "../../packages/store-d1/src/index.js";
import { encode, decode } from "../../packages/store-d1/src/serialize.js";
import { input, budget, command, receipt, ref } from "../../packages/store/conformance/helpers.js";

const dir = mkdtempSync(join(tmpdir(), "usagekit-cloudflare-"));
let mf: Miniflare | undefined;
let bundle: string | undefined;
async function start() {
  if (!bundle) {
    const result = await build({
      entryPoints: ["examples/cloudflare-worker/test-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers"],
      alias: {
        "@usagekit/core": resolve("packages/core/src/index.ts"),
        "@usagekit/store": resolve("packages/store/src/index.ts"),
      },
    });
    bundle = result.outputFiles[0]!.text;
  }
  if (!mf) {
    const gateway = `export default { fetch(request, env) { return env.LEDGER.getByName(new URL(request.url).pathname).fetch(request); } };`;
    mf = new Miniflare(
      convertV4MiniflareOptions({
        resourcePersistencePath: dir,
        workers: [
          ...["a", "b"].map((name) => ({
            name,
            modules: true,
            script: gateway,
            compatibilityDate: "2026-09-27",
            durableObjects: {
              LEDGER: { className: "TestLedger", scriptName: "ledger", useSQLite: true },
            },
          })),
          {
            name: "ledger",
            modules: true,
            script: bundle,
            compatibilityDate: "2026-09-27",
            durableObjects: { LEDGER: { className: "TestLedger", useSQLite: true } },
          },
        ],
      }),
    );
    await mf.ready;
  }
  return mf;
}
afterAll(async () => {
  await mf?.dispose();
  rmSync(dir, { recursive: true, force: true });
});
async function fixture(
  hooks: {
    beforeRequest?: (method: string, budgets: Budget[]) => Promise<void>;
    afterRequest?: (method: string, budgets: Budget[]) => void;
  } = {},
) {
  await start();
  const id = crypto.randomUUID(),
    clock = createManualClock(),
    budgets: Budget[] = [];
  let metrics: SqlMetrics = {
    statements: 0,
    changes: 0n,
    rowsRead: 0,
    storageRowsRead: 0,
    storageRowsWritten: 0,
  };
  const seen = new Map<string, string>();
  const transport = async (method: string, args: unknown[], changed: Budget[], worker: string) => {
    // Miniflare 5 ReplaceWorkersTypes incorrectly collapses Fetcher to Request with DOM types.
    const gateway = (await (await start()).getWorker(worker)) as unknown as {
      fetch(url: string, init: RequestInit): Promise<Response>;
    };
    await hooks.beforeRequest?.(method, changed);
    const response = await gateway.fetch(`http://test/${id}`, {
      method: "POST",
      body: encode({ method, args, now: clock.now().toISOString(), budgets: changed }),
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = decode<{
      result?: unknown;
      metrics: SqlMetrics;
      error?: { field?: string; reason?: string; message: string };
    }>(await response.text());
    metrics = payload.metrics;
    if (payload.error) {
      if (payload.error.field) throw new InvalidInput(payload.error.field, payload.error.reason);
      throw new Error(payload.error.message);
    }
    hooks.afterRequest?.(method, changed);
    return payload.result;
  };
  let pendingBudgets: Promise<void> | undefined;
  const call = async (method: string, args: unknown[] = [], worker = "a") => {
    while (pendingBudgets) await pendingBudgets;
    const changed = budgets
      .filter((b) => seen.get(`${b.scope.namespace}:${b.id}:${b.version}`) !== encode(b))
      .map((b) => structuredClone(b));
    if (changed.length) {
      // Finish fixture setup before any competing command can reach the object.
      // Only setup is shared; Store commands still race through independent requests.
      const pending = transport("$metrics", [], changed, worker).then(() => {
        for (const b of changed) seen.set(`${b.scope.namespace}:${b.id}:${b.version}`, encode(b));
      });
      pendingBudgets = pending;
      try {
        await pending;
      } finally {
        if (pendingBudgets === pending) pendingBudgets = undefined;
      }
    }
    return transport(method, args, [], worker);
  };
  const store = new Proxy({} as Store, {
    get: (_, method) =>
      method === "then" ? undefined : (...args: unknown[]) => call(String(method), args),
  });
  await call("$metrics");
  return {
    store,
    clock,
    budgets,
    call,
    snapshot: () => ({ ...metrics }),
    readOnly: async (run: () => Promise<void>) => {
      await call("$readOnly", [true]);
      try {
        await run();
      } finally {
        await call("$readOnly", [false]);
      }
    },
    replayMoneyMigration: async () => {
      await call("$replayMoneyMigration");
    },
    moneyColumns: async () =>
      ((await call("$moneyColumns")) as { cost_units: bigint; cost_scale: number }[]).map((r) => ({
        cost_units: String(r.cost_units),
        cost_scale: r.cost_scale,
      })),
    restart: async () => {
      await mf!.dispose();
      mf = undefined;
      await start();
      return store;
    },
    close: async () => {},
  };
}
runStoreConformance(fixture, {
  durable: true,
  rollingWindows: false,
  maxMoneyUnits: 2n ** 63n - 1n,
  maxQuantityScale: 18,
});
runStoreScalingConformance(async () => {
  const f = await fixture();
  f.budgets.push(budget({ limit: null }));
  await f.store.reserve(input({ operationId: "warmup" }));
  return f;
});

test("concurrent commands see fixture budgets even when transport reorders requests", async () => {
  let otherCommandFinished!: () => void;
  const otherCommand = new Promise<void>((resolve) => {
    otherCommandFinished = resolve;
  });
  const f = await fixture({
    beforeRequest: async (method, budgets) => {
      if (method === "reserve" && budgets.length) await otherCommand;
    },
    afterRequest: (method, budgets) => {
      if (method === "reserve" && !budgets.length) otherCommandFinished();
    },
  });
  f.budgets.push(budget({ limit: { value: 0n, scale: 0, unit: "requests" } }));
  const results = await Promise.all([f.store.reserve(input()), f.store.reserve(input())]);
  expect(results.map((result) => result.outcome)).toEqual(["exceeded", "exceeded"]);
});

test("two independent Workers race on the same object and shared pool", async () => {
  const f = await fixture();
  f.budgets.push(
    budget({
      scope: { kind: "platform_pool", namespace: "test", poolId: "shared" },
      limit: { value: 1n, scale: 0, unit: "requests" },
    }),
  );
  await f.call("$metrics");
  const results = await Promise.all(
    ["a", "b"].map((worker) =>
      f.call(
        "reserve",
        [
          input({
            operationId: worker,
            scope: { namespace: "test", principal: worker, connection: worker },
            platformPools: ["shared"],
          }),
        ],
        worker,
      ),
    ),
  );
  expect(results.map((r) => (r as { outcome: string }).outcome).sort()).toEqual([
    "exceeded",
    "reserved",
  ]);
  const win = results.find((r) => (r as { outcome: string }).outcome === "reserved") as {
    operation: Parameters<typeof command>[0];
  };
  const intent = { ...command(win.operation), holder: "worker", leaseTtlMs: 1000 };
  const grants = await Promise.all(
    ["a", "b"].map((worker) => f.call("markDispatchIntent", [intent], worker)),
  );
  expect(grants.filter((g) => (g as { granted: boolean }).granted)).toHaveLength(1);
});

test("injected failure rolls back the operation, receipt, event, command and budget projection", async () => {
  const f = await fixture();
  f.budgets.push(budget());
  const reserved = await f.store.reserve(input());
  if (reserved.outcome !== "reserved") throw new Error("fixture");
  const grant = await f.store.markDispatchIntent({
    ...command(reserved.operation),
    holder: "h",
    leaseTtlMs: 1000,
  });
  if (!("granted" in grant) || !grant.granted) throw new Error("fixture");
  const settle = {
    ...command(grant.operation),
    authority: { kind: "lease" as const, leaseId: grant.lease.leaseId },
    receipt: receipt(),
  };
  const query = { scope: reserved.operation.scope, surface: "app" as const, units: ["requests"] };
  const before = await f.store.applicableBudgets(query);
  await f.call("$failWrite", [true]);
  await expect(f.store.settle(settle)).rejects.toThrow("injected write failure");
  expect(await f.store.getOperation(ref(reserved.operation))).toEqual(grant.operation);
  expect(await f.store.applicableBudgets(query)).toEqual(before);
  await f.call("$failWrite", [false]);
  expect(await f.store.settle(settle)).toMatchObject({ outcome: "settled" });
  await f.restart();
  expect(await f.store.getOperation(ref(reserved.operation))).toMatchObject({
    state: "settled",
    receipts: [settle.receipt],
  });
});

test("budget versions are immutable across workers and seeded definitions survive activation", async () => {
  const f = await fixture();
  const b = budget();
  await f.call("$seedReopen", [[b]]);
  await f.call("$seedReopen", [[b]]);
  await expect(f.call("$seedReopen", [[{ ...b, limit: null }]])).rejects.toThrow("immutable");
  const next = { ...b, version: 2, limit: null };
  const results = await Promise.all(
    ["a", "b"].map((worker) => f.call("putBudget", [next], worker)),
  );
  expect(results.map((r) => (r as { outcome: string }).outcome).sort()).toEqual([
    "conflict",
    "saved",
  ]);
  await f.restart();
  expect(await f.call("listBudgets")).toEqual([next]);
});

test("signed usage cursors survive process restart and reject tampering", async () => {
  const f = await fixture();
  for (const provider of ["a", "b"]) {
    const r = await f.store.reserve(input({ provider }));
    if (r.outcome !== "reserved") throw new Error("fixture");
    const g = await f.store.markDispatchIntent({
      ...command(r.operation),
      holder: "h",
      leaseTtlMs: 1000,
    });
    if (!("granted" in g) || !g.granted) throw new Error("fixture");
    await f.store.settle({
      ...command(g.operation),
      authority: { kind: "lease", leaseId: g.lease.leaseId },
      receipt: receipt(),
    });
  }
  const q = {
    scope: { kind: "namespace" as const, namespace: "test" },
    from: "2026-09-01T00:00:00Z",
    to: "2026-10-01T00:00:00Z",
    units: ["requests"],
    groupBy: ["provider" as const],
    limit: 1,
  };
  const first = await f.store.aggregate(q);
  expect(first.nextCursor).toBeTruthy();
  await f.restart();
  const second = await f.store.aggregate({ ...q, cursor: first.nextCursor! });
  expect(second.watermark).toBe(first.watermark);
  expect(second.rows).toHaveLength(1);
  expect(second.rows).not.toEqual(first.rows);
  await expect(f.store.aggregate({ ...q, cursor: first.nextCursor! + "x" })).rejects.toThrow(
    "cursor",
  );
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

test("Cloudflare v1 storage upgrades idempotently and import replay survives object restart", async () => {
  const f = await fixture();
  const reserved = await f.store.reserve(input({ operationId: "before-upgrade" }));
  if (reserved.outcome !== "reserved") throw new Error("fixture");
  await f.call("$upgradeVersionOne");
  expect(await f.call("$schemaVersions")).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  expect(await f.store.getOperation(ref(reserved.operation))).toEqual(reserved.operation);
  await expect(f.call("$unsupportedSchema")).rejects.toThrow("Unsupported Cloudflare schema");
  const first = await f.store.importBilling(billingInput());
  if (first.outcome !== "imported") throw new Error("fixture import");
  await f.restart();
  expect(await f.store.importBilling(billingInput())).toEqual({ ...first, replayed: true });
  const op = await f.store.getOperation({
    namespace: "test",
    principal: "u1",
    operationId: first.record.unobservedOperationIds[0]!,
  });
  expect(op).toMatchObject({
    source: "import",
    state: "pending",
    budgetEpochs: [],
    estimate: [],
    lease: null,
  });
  expect(op!.receipts[0]!.cost.money!.units).toBe(9007199254740993n);
});

test("independent Cloudflare Workers serialize identical imports and competing revisions", async () => {
  const f = await fixture();
  const initial = (await Promise.all(
    ["a", "b"].map((worker) => f.call("importBilling", [billingInput()], worker)),
  )) as Awaited<ReturnType<Store["importBilling"]>>[];
  expect(initial.every((r) => r.outcome === "imported")).toBe(true);
  expect(initial.map((r) => r.outcome === "imported" && r.replayed).sort()).toEqual([false, true]);
  const first = initial[0]!;
  if (first.outcome !== "imported") throw new Error("fixture initial");
  const revisions = (await Promise.all(
    ["a", "b"].map((worker, index) =>
      f.call(
        "importBilling",
        [
          billingInput({
            fileHash: String(index + 1).repeat(64),
            expectedPreviousImportId: first.record.id,
          }),
        ],
        worker,
      ),
    ),
  )) as Awaited<ReturnType<Store["importBilling"]>>[];
  expect(revisions.map((r) => r.outcome).sort()).toEqual(["imported", "rejected"]);
  expect(revisions.find((r) => r.outcome === "rejected")).toMatchObject({
    reason: "previous_import_conflict",
  });
  await f.restart();
  const state = (await f.call("$billingState")) as Record<string, unknown[]>;
  expect(state.billing_imports).toHaveLength(2);
  expect(state.operations).toHaveLength(1);
  expect(state.receipts).toHaveLength(2);
});

test("Cloudflare multi-line import failure rolls back complete ledger and import journal", async () => {
  const f = await fixture();
  f.budgets.push(budget({ limit: null }));
  for (const providerRequestId of ["a", "b"]) {
    const reserved = await f.store.reserve(input());
    if (reserved.outcome !== "reserved") throw new Error("fixture reserve");
    const grant = await f.store.markDispatchIntent({
      ...command(reserved.operation),
      holder: "h",
      leaseTtlMs: 1000,
    });
    if (!("granted" in grant) || !grant.granted) throw new Error("fixture intent");
    await f.store.settle({
      ...command(grant.operation),
      authority: { kind: "lease", leaseId: grant.lease.leaseId },
      receipt: receipt({ providerRequestId, cost: { certainty: "unknown", money: null } }),
    });
  }
  const before = await f.call("$billingState");
  const imported = billingInput({
    lines: ["a", "b"].map((providerRequestId) => ({
      providerRequestId,
      operation: "search",
      occurredAt: "2026-09-23T12:00:00.000Z",
      cost: { units: 7n, currency: "USD" },
    })),
  });
  await f.call("$failWriteAt", [2]);
  await expect(f.store.importBilling(imported)).rejects.toThrow("injected write failure");
  expect(await f.call("$billingState")).toEqual(before);
  await f.call("$failWriteAt", [0]);
  const first = await f.store.importBilling(imported);
  expect(first).toMatchObject({ outcome: "imported", replayed: false });
  await f.restart();
  expect(await f.store.importBilling(imported)).toMatchObject({
    outcome: "imported",
    replayed: true,
  });
});
