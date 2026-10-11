import { expect, test, vi } from "vitest";
import { createMemoryStore, createManualClock } from "@usagekit/store";
import type {
  AccessContext,
  Budget,
  ConnectionPolicy,
  MeterReserveInput,
  PricingCatalog,
  Quantity,
} from "@usagekit/core";
import { createMeter } from "./meter.js";
const access: AccessContext = {
  namespace: "test",
  readablePrincipals: ["u1"],
  readableGroups: [],
  readablePools: [],
  canReadBillingDetail: true,
  canManageBudgets: false,
};
const money: Quantity = { unit: "cents", value: 7n, scale: 0 };
const requests: Quantity = { unit: "requests", value: 1n, scale: 0 };
const input = (): MeterReserveInput => ({
  operationId: crypto.randomUUID(),
  scope: { namespace: "test", principal: "u1", connection: "c1" },
  fundingSource: "byok",
  costOwner: "u1",
  surface: "app",
  source: "app",
  provider: "search",
  operation: "search",
});
function harness(manual = false, fundingSource: "byok" | "platform" = "byok") {
  const clock = createManualClock();
  const store = createMemoryStore({ clock, budgets: [] });
  const policy: ConnectionPolicy = {
    fundingSource,
    provider: "search",
    ...(manual ? { manualPrices: { search: { ...money, value: 0n } } } : {}),
  };
  const catalog: PricingCatalog = {
    operationsOf: () => [
      { id: "search", label: "Search", billable: true, match: [], costEvidence: "none" },
    ],
    estimate: (c) => ({
      quantities: [c.manualPrices?.search ?? money, requests],
      source: c.manualPrices?.search ? "manual" : "list",
    }),
  };
  return {
    clock,
    store,
    meter: createMeter({
      clock,
      store,
      catalog,
      resolveConnection: () => policy,
      resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u1" }),
    }),
  };
}
function platformHarness(manual = false, tracking?: "passthrough") {
  const clock = createManualClock();
  const store = createMemoryStore({ clock, budgets: [] });
  const estimate = vi.fn(() => ({
    quantities: [manual ? { ...money, value: 0n } : money, requests],
    source: manual ? ("manual" as const) : ("list" as const),
  }));
  const meter = createMeter({
    clock,
    store,
    catalog: {
      operationsOf: () => [
        { id: "search", label: "Search", billable: true, match: [], costEvidence: "none" },
        { id: "account", label: "Account", billable: false, match: [], costEvidence: "none" },
      ],
      estimate,
    },
    resolveConnection: () => ({
      fundingSource: "platform",
      provider: "search",
      ...(manual
        ? { manualPrices: { search: { ...money, value: 0n }, account: { ...money, value: 0n } } }
        : {}),
      ...(tracking ? { tracking: { search: tracking, account: tracking } } : {}),
    }),
    resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u1" }),
  });
  return { clock, store, meter, estimate };
}
test.each([undefined, "passthrough"] as const)(
  "platform nonbillable calls without host estimates are admitted without charges (tracking=%s)",
  async (tracking) => {
    const { store, meter, estimate } = platformHarness(false, tracking);
    const counted = vi.spyOn(store, "countRequest");
    const reserved = vi.spyOn(store, "reserve");
    const settled = vi.spyOn(store, "settle");
    const i = { ...input(), fundingSource: "platform" as const, operation: "account" };
    const quote = await meter.quote(access, i);
    expect.soft(quote).toMatchObject({
      outcome: "ok",
      value: { tracking: "passthrough", quantities: [], budgets: [] },
    });
    expect.soft(counted).not.toHaveBeenCalled();
    expect.soft(await meter.reserve(i)).toEqual({
      outcome: "passthrough",
      replayed: false,
      operation: null,
    });
    expect.soft(await meter.reserve(i)).toEqual({
      outcome: "passthrough",
      replayed: true,
      operation: null,
    });
    expect.soft(counted).toHaveBeenCalledTimes(2);
    expect.soft(counted).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: i.operationId,
        operation: "account",
        state: "passthrough",
      }),
    );
    expect
      .soft(
        await meter.requestCounts(access, {
          scope: { kind: "principal", namespace: "test", principal: "u1" },
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-10-01T00:00:00.000Z",
          groupBy: ["operation"],
        }),
      )
      .toMatchObject({
        outcome: "ok",
        value: {
          rows: [{ dimensions: { operation: "account" }, state: "passthrough", count: 1n }],
        },
      });
    expect(
      await meter.getOperation(access, {
        namespace: "test",
        principal: "u1",
        operationId: i.operationId,
      }),
    ).toEqual({ outcome: "ok", value: null });
    expect(estimate).not.toHaveBeenCalled();
    expect(reserved).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  },
);
test.each([
  [false, undefined],
  [false, "passthrough"],
  [true, undefined],
  [true, "passthrough"],
] as const)(
  "platform billable calls without host estimates stay invalid (manual zero=%s, tracking=%s)",
  async (manual, tracking) => {
    const { store, meter, estimate } = platformHarness(manual, tracking);
    const counted = vi.spyOn(store, "countRequest");
    const reserved = vi.spyOn(store, "reserve");
    const i = { ...input(), fundingSource: "platform" as const };
    const invalid = {
      outcome: "invalid",
      field: "estimate",
      reason: "required from host customer-price policy for platform funding",
    };
    expect(await meter.quote(access, i)).toEqual(invalid);
    expect(await meter.reserve(i)).toEqual(invalid);
    expect(await meter.reserve(i)).toEqual(invalid);
    expect(
      await meter.getOperation(access, {
        namespace: "test",
        principal: "u1",
        operationId: i.operationId,
      }),
    ).toEqual({ outcome: "ok", value: null });
    expect(estimate).not.toHaveBeenCalled();
    expect(counted).not.toHaveBeenCalled();
    expect(reserved).not.toHaveBeenCalled();
  },
);
test("billable and unknown platform operations require a host estimate regardless of tracking", async () => {
  const { clock, store } = harness();
  const counted = vi.spyOn(store, "countRequest");
  const reserved = vi.spyOn(store, "reserve");
  const estimate = vi.fn(() => ({ quantities: [money, requests], source: "list" as const }));
  for (const tracking of [undefined, "passthrough"] as const) {
    const meter = createMeter({
      clock,
      store,
      catalog: {
        operationsOf: () => [
          { id: "search", label: "Search", billable: true, match: [], costEvidence: "none" },
          { id: "account", label: "Account", billable: false, match: [], costEvidence: "none" },
        ],
        estimate,
      },
      resolveConnection: () => ({
        fundingSource: "platform",
        provider: "search",
        manualPrices: { search: { ...money, value: 0n } },
        ...(tracking ? { tracking: { search: tracking } } : {}),
      }),
      resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u1" }),
    });
    for (const operation of ["search", "missing"]) {
      const i = { ...input(), fundingSource: "platform" as const, operation };
      const invalid = {
        outcome: "invalid",
        field: "estimate",
        reason: "required from host customer-price policy for platform funding",
      };
      expect.soft(await meter.quote(access, i)).toEqual(invalid);
      expect.soft(await meter.reserve(i)).toEqual(invalid);
      expect.soft(await meter.reserve(i)).toEqual(invalid);
      expect
        .soft(
          await meter.getOperation(access, {
            namespace: "test",
            principal: "u1",
            operationId: i.operationId,
          }),
        )
        .toEqual({ outcome: "ok", value: null });
    }
  }
  expect(estimate).not.toHaveBeenCalled();
  expect(counted).not.toHaveBeenCalled();
  expect(reserved).not.toHaveBeenCalled();
});
test.each([
  ["unknown connection", true, true],
  ["unknown connection", false, true],
  ["required without a catalog", true, false],
] as const)(
  "platform omitted estimates are invalid (%s, catalog=%s, resolver=%s) for reserve and quote",
  async (reason, withCatalog, withResolver) => {
    const { clock, store } = harness();
    const counted = vi.spyOn(store, "countRequest");
    const meter = createMeter({
      clock,
      store,
      ...(withCatalog ? { catalog: { operationsOf: () => [], estimate: vi.fn() } } : {}),
      ...(withResolver ? { resolveConnection: () => undefined } : {}),
      resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u1" }),
    });
    const i = { ...input(), fundingSource: "platform" as const };
    const invalid = { outcome: "invalid", field: "estimate", reason };
    expect.soft(await meter.reserve(i)).toEqual(invalid);
    expect.soft(await meter.quote(access, i)).toEqual(invalid);
    expect(counted).not.toHaveBeenCalled();
  },
);
test("manual zero preserves the host customer estimate and provider settlement evidence", async () => {
  for (const manual of [false, true]) {
    const { meter, clock } = harness(manual, "platform");
    const customer = { ...money, unit: "customer_cents", value: 9n };
    const i = {
      ...input(),
      fundingSource: "platform" as const,
      estimate: [customer, requests],
      customerPriceVersion: "host-v1",
    };
    const quote = await meter.quote(access, i);
    expect(quote).toMatchObject({ outcome: "ok", value: { quantities: [customer, requests] } });
    const reserved = await meter.reserve(i);
    expect(reserved).toMatchObject({
      outcome: "reserved",
      operation: { estimate: [customer, requests] },
    });
    if (reserved.outcome !== "reserved") throw new Error("not reserved");
    const ref = { namespace: "test", principal: "u1", operationId: i.operationId };
    const grant = await meter.markDispatchIntent({
      ...ref,
      commandId: crypto.randomUUID(),
      expectedVersion: reserved.operation.version,
      holder: "worker",
      leaseTtlMs: 60000,
    });
    if (!("granted" in grant) || !grant.granted) throw new Error("no dispatch grant");
    expect(
      await meter.settle({
        ...ref,
        commandId: crypto.randomUUID(),
        expectedVersion: grant.operation.version,
        authority: { kind: "lease", leaseId: grant.lease.leaseId },
        receipt: {
          id: crypto.randomUUID(),
          occurredAt: clock.now().toISOString(),
          recordedAt: clock.now().toISOString(),
          measurements: [{ unit: "cents", quantity: money, certainty: "estimated" }],
          cost: { certainty: "estimated", money: { currency: "USD", units: 70000n } },
          cached: false,
          failed: false,
        },
      }),
    ).toMatchObject({
      outcome: "settled",
      operation: {
        state: "pending",
        estimate: [customer, requests],
        customerPriceVersion: "host-v1",
        receipts: [{ cost: { money: { units: 70000n } } }],
      },
    });
  }
});
test("quote and reservation use exactly the same request price", async () => {
  const { meter } = harness();
  const i = input();
  const quote = await meter.quote(access, i);
  const reservation = await meter.reserve(i);
  expect(quote.outcome).toBe("ok");
  expect(reservation.outcome).toBe("reserved");
  if (quote.outcome !== "ok" || reservation.outcome !== "reserved")
    throw new Error("missing price");
  expect(quote.value.quantities).toEqual(reservation.operation.estimate);
  expect(quote.value.estimateSource).toEqual(reservation.operation.estimateSource);
});

test("quotes read and redact budgets without counting, reserving or sweeping expired operations", async () => {
  const clock = createManualClock();
  const budget = (id: string, scope: Budget["scope"]): Budget => ({
    id,
    scope,
    unit: "cents",
    version: 1,
    surface: "any",
    limit: { ...money, value: 100n },
    window: { kind: "calendar_month", timezone: "UTC" },
    onExceed: "block",
  });
  const store = createMemoryStore({
    clock,
    budgets: [
      budget("own", { kind: "principal", namespace: "test", principal: "u1" }),
      budget("pool", { kind: "platform_pool", namespace: "test", poolId: "private-pool" }),
    ],
  });
  const meter = createMeter({
    store,
    clock,
    resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u1" }),
  });
  const i = {
    ...input(),
    fundingSource: "platform" as const,
    platformPools: ["private-pool"],
    estimate: [money, requests],
  };
  const r = await meter.reserve(i);
  if (r.outcome !== "reserved") throw new Error("reservation missing");
  clock.advance(300001);
  const before = await store.getOperation({
    namespace: "test",
    principal: "u1",
    operationId: i.operationId,
  });
  const writes = [
    "reserve",
    "countRequest",
    "expireReservations",
    "markDispatchIntent",
    "settle",
    "releaseUndispatched",
  ] as const;
  const spies = writes.map((name) => vi.spyOn(store, name));
  const lookup = vi.spyOn(store, "getOperation");
  const quote = await meter.quote(access, i);
  expect(quote).toMatchObject({
    outcome: "ok",
    value: { tracking: "metered", quantities: [money, requests] },
  });
  if (quote.outcome !== "ok") throw new Error("quote missing");
  expect(quote.value.budgets.find((b) => b.budget.id === "pool")).toMatchObject({
    budget: { limit: null },
    used: null,
    reserved: null,
    remaining: null,
    redacted: true,
  });
  expect(quote.value.budgets.find((b) => b.budget.id === "own")).toMatchObject({ reserved: money });
  expect(lookup).not.toHaveBeenCalled();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(
    await store.getOperation({ namespace: "test", principal: "u1", operationId: i.operationId }),
  ).toEqual(before);
});

test("quote authorization checks principal, namespace, group and connection owner even without budgets", async () => {
  const { meter, store } = harness();
  const spy = vi.spyOn(store, "applicableBudgets");
  for (const i of [
    { ...input(), scope: { ...input().scope, namespace: "other" } },
    { ...input(), scope: { ...input().scope, principal: "other" } },
    { ...input(), scope: { ...input().scope, group: "other" } },
  ])
    expect(await meter.quote(access, i)).toEqual({ outcome: "forbidden" });
  expect(await meter.quote({ ...access, canReadBillingDetail: false }, input())).toEqual({
    outcome: "forbidden",
  });
  expect(spy).not.toHaveBeenCalled();
  const { clock } = harness();
  const wrong = createMeter({
    store,
    clock,
    resolveOwnership: async () => ({
      kind: "principal",
      namespace: "test",
      principal: "someone-else",
    }),
  });
  expect(await wrong.quote({ ...access, readablePrincipals: "*" }, input())).toEqual({
    outcome: "forbidden",
  });
  const absent = createMeter({ store, clock });
  expect(await absent.quote(access, input())).toEqual({ outcome: "forbidden" });
});

test("quote exposes unknown and passthrough without counted requests", async () => {
  const { clock, store } = harness();
  for (const tracking of [undefined, "passthrough"] as const) {
    const meter = createMeter({
      clock,
      store,
      catalog: {
        operationsOf: () => [],
        estimate: () => {
          throw new Error("must not price");
        },
      },
      resolveConnection: () => ({
        fundingSource: "byok",
        provider: "search",
        ...(tracking ? { tracking: { search: tracking } } : {}),
      }),
      resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u1" }),
    });
    expect(await meter.quote(access, input())).toMatchObject({
      outcome: "ok",
      value: { quantities: [], estimateSource: "unknown", tracking: tracking ?? "unpriced" },
    });
  }
  expect(
    await store.requestCounts({
      scope: { kind: "principal", namespace: "test", principal: "u1" },
      from: "2026-09-01T00:00:00Z",
      to: "2026-10-01T00:00:00Z",
      groupBy: [],
    }),
  ).toMatchObject({ rows: [] });
});

test("quote validates source, provider and quantities; platform manual provenance is rejected", async () => {
  const { meter } = harness();
  for (const i of [
    { ...input(), source: "import" as const },
    { ...input(), source: "proxy" as const },
    { ...input(), provider: "other" },
    {
      ...input(),
      fundingSource: "platform" as const,
      estimate: [money],
      estimateSource: "manual" as const,
    },
    { ...input(), estimate: [money, money] },
    { ...input(), estimate: [{ ...money, value: -1n }] },
    { ...input(), estimate: [{ ...money, scale: 19 }] },
  ])
    expect(await meter.quote(access, i)).toMatchObject({ outcome: "invalid" });
});

test("platform quotes with host prices stay metered despite passthrough tracking", async () => {
  const { meter } = platformHarness(false, "passthrough");
  const i = { ...input(), fundingSource: "platform" as const, estimate: [money, requests] };
  expect(await meter.quote(access, i)).toMatchObject({
    outcome: "ok",
    value: { tracking: "metered", quantities: [money, requests] },
  });
  expect(await meter.reserve(i)).toMatchObject({ outcome: "reserved" });
});
