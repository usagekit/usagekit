import { expect, test, vi } from "vitest";
import { validateConnectionPolicy } from "@usagekit/core";
import type { AccessContext, ConnectionPolicy, MeterReserveInput, Quantity } from "@usagekit/core";
import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createCatalog, serpapi } from "./index.js";

const catalog = createCatalog({ providers: [serpapi], enabled: ["serpapi"] });
const requests: Quantity = { unit: "requests", value: 1n, scale: 0 };
const price: Quantity = { unit: "customer_cents", value: 7n, scale: 0 };
const access: AccessContext = {
  namespace: "test",
  readablePrincipals: ["u"],
  readableGroups: [],
  readablePools: [],
  canReadBillingDetail: true,
  canManageBudgets: false,
};
const input = (): MeterReserveInput => ({
  operationId: crypto.randomUUID(),
  scope: { namespace: "test", principal: "u", connection: "shared-id" },
  fundingSource: "platform",
  costOwner: "u",
  surface: "app",
  source: "app",
  provider: "serpapi",
  operation: "search",
});

for (const withCatalog of [false, true]) {
  test.each(["byok", "platform"] as const)(
    `unknown connection rejects an explicit %s estimate (catalog=${withCatalog})`,
    async (fundingSource) => {
      const clock = createManualClock();
      const store = createMemoryStore({ clock, budgets: [] });
      const meter = createMeter({
        store,
        clock,
        ...(withCatalog ? { catalog } : {}),
        resolveConnection: () => undefined,
        resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u" }),
      });
      const i = { ...input(), fundingSource, estimate: [price, requests] };
      const invalid = { outcome: "invalid", field: "estimate", reason: "unknown connection" };
      expect.soft(await meter.quote(access, i)).toEqual(invalid);
      expect.soft(await meter.reserve(i)).toEqual(invalid);
      expect(await store.getOperation({ ...i.scope, operationId: i.operationId })).toBeNull();
      // An existing reservation still replays after its connection disappears.
      expect((await store.reserve(i)).outcome).toBe("reserved");
      expect(await meter.reserve(i)).toMatchObject({ outcome: "reserved", replayed: true });
    },
  );

  test.each([undefined, "legacy"])(
    `invalid resolved funding %s is reported as missing (catalog=${withCatalog})`,
    async (fundingSource) => {
      const clock = createManualClock();
      const store = createMemoryStore({ clock, budgets: [] });
      const meter = createMeter({
        store,
        clock,
        ...(withCatalog ? { catalog } : {}),
        // Simulate a JavaScript host returning a legacy or malformed database row.
        resolveConnection: () => ({ provider: "serpapi", fundingSource }) as ConnectionPolicy,
        resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u" }),
      });
      const i = { ...input(), estimate: [price, requests] };
      const invalid = {
        outcome: "invalid",
        field: "fundingSource",
        reason: "missing from the resolved connection policy",
      };
      expect.soft(await meter.quote(access, i)).toEqual(invalid);
      expect.soft(await meter.reserve(i)).toEqual(invalid);
      expect(await store.getOperation({ ...i.scope, operationId: i.operationId })).toBeNull();
    },
  );
}
function harness(withCatalog = true, withBudget = false, withResolver = true) {
  const clock = createManualClock();
  const policy = {
    provider: "serpapi",
    fundingSource: "platform" as const,
    plan: "starter",
  };
  const store = createMemoryStore({
    clock,
    budgets: withBudget
      ? [
          {
            id: "customer",
            scope: { kind: "principal", namespace: "test", principal: "u" },
            unit: price.unit,
            limit: { ...price, value: 100n },
            version: 1,
            surface: "any",
            window: { kind: "calendar_month", timezone: "UTC" },
            onExceed: "block",
          },
        ]
      : [],
  });
  const meter = createMeter({
    store,
    clock,
    ...(withCatalog ? { catalog } : {}),
    ...(withResolver ? { resolveConnection: () => policy } : {}),
    resolveOwnership: async (scope) => ({
      kind: "principal",
      namespace: scope.namespace,
      principal: "u",
    }),
  });
  return { meter, store };
}

for (const { withCatalog, withResolver } of [
  { withCatalog: false, withResolver: false },
  { withCatalog: false, withResolver: true },
  { withCatalog: true, withResolver: false },
  { withCatalog: true, withResolver: true },
]) {
  for (const withBudget of [false, true]) {
    test.each([
      { label: "empty", estimate: [] },
      { label: "requests only", estimate: [requests] },
    ])(
      `platform estimate $label needs a customer dimension (catalog=${withCatalog}, resolver=${withResolver}, budget=${withBudget})`,
      async ({ estimate }) => {
        const { meter, store } = harness(withCatalog, withBudget, withResolver);
        const i = { ...input(), estimate };
        const invalid = {
          outcome: "invalid",
          field: "estimate",
          reason: "platform funding requires a host customer price",
        };
        expect.soft(await meter.quote(access, i)).toEqual(invalid);
        expect.soft(await meter.reserve(i)).toEqual(invalid);
        expect(await store.getOperation({ ...i.scope, operationId: i.operationId })).toBeNull();
      },
    );
  }
  test.each(["manual", "list", "measured"] as const)(
    `platform explicit %s provider provenance is rejected (catalog=${withCatalog}, resolver=${withResolver})`,
    async (estimateSource) => {
      const { meter } = harness(withCatalog, false, withResolver);
      const i = { ...input(), estimate: [price, requests], estimateSource };
      expect
        .soft(await meter.quote(access, i))
        .toMatchObject({ outcome: "invalid", field: "estimateSource" });
      expect
        .soft(await meter.reserve(i))
        .toMatchObject({ outcome: "invalid", field: "estimateSource" });
    },
  );
  test.each([undefined, "unknown"] as const)(
    `explicit host provenance %s matches the stored operation (catalog=${withCatalog}, resolver=${withResolver})`,
    async (estimateSource) => {
      const { meter } = harness(withCatalog, false, withResolver);
      const i = {
        ...input(),
        estimate: [price, requests],
        ...(estimateSource ? { estimateSource } : {}),
      };
      const quote = await meter.quote(access, i),
        reserved = await meter.reserve(i);
      expect(quote.outcome).toBe("ok");
      expect(reserved.outcome).toBe("reserved");
      if (quote.outcome !== "ok" || reserved.outcome !== "reserved")
        throw new Error("host price missing");
      expect(quote.value.estimateSource).toBe(reserved.operation.estimateSource);
      if (!estimateSource) expect(quote.value).not.toHaveProperty("estimateSource");
    },
  );
  if (withResolver)
    test(`connection funding cannot be spoofed (catalog=${withCatalog}, resolver=${withResolver})`, async () => {
      const { meter } = harness(withCatalog, false, withResolver);
      const i = { ...input(), fundingSource: "byok" as const, estimate: [price] };
      const invalid = {
        outcome: "invalid",
        field: "fundingSource",
        reason: "differs from the connection funding source",
      };
      expect.soft(await meter.quote(access, i)).toEqual(invalid);
      expect.soft(await meter.reserve(i)).toEqual(invalid);
    });
}

test("catalog fails closed for a JavaScript caller that omits funding", () => {
  const connection = {
    id: "c",
    provider: "serpapi",
    plan: "starter",
    manualPrices: { search: { ...price, value: 0n } },
  };
  // @ts-expect-error Exercise a legacy JavaScript caller without the now-required funding field.
  expect(catalog.estimate(connection, "search", {})).toEqual({
    quantities: [requests],
    source: "unknown",
  });
});

test.each([undefined, "passthrough"] as const)(
  "platform connection cannot be priced or bypassed by declaring BYOK (tracking=%s)",
  async (tracking) => {
    const clock = createManualClock();
    const store = createMemoryStore({ clock, budgets: [] });
    const meter = createMeter({
      store,
      clock,
      catalog,
      resolveConnection: () => ({
        provider: "serpapi",
        fundingSource: "platform",
        plan: "starter",
        manualPrices: { search: { ...price, value: 0n } },
        ...(tracking ? { tracking: { search: tracking } } : {}),
      }),
      resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u" }),
    });
    const i = { ...input(), fundingSource: "byok" as const };
    expect
      .soft(await meter.quote(access, i))
      .toMatchObject({ outcome: "invalid", field: "fundingSource" });
    expect
      .soft(await meter.reserve(i))
      .toMatchObject({ outcome: "invalid", field: "fundingSource" });
    expect(await store.getOperation({ ...i.scope, operationId: i.operationId })).toBeNull();
  },
);

test("replays retain an existing platform estimate despite newer admission rules", async () => {
  const { meter, store } = harness();
  const i = { ...input(), estimate: [], estimateSource: "list" as const };
  expect((await store.reserve(i)).outcome).toBe("reserved");
  expect(await meter.reserve(i)).toMatchObject({
    outcome: "reserved",
    replayed: true,
    operation: { estimate: [], estimateSource: "list" },
  });
});

for (const withCatalog of [false, true]) {
  test.each([
    { change: "funding", provider: "serpapi", fundingSource: "platform" as const },
    { change: "provider", provider: "dataforseo", fundingSource: "byok" as const },
    { change: "funding and provider", provider: "dataforseo", fundingSource: "platform" as const },
  ])(
    `replay retains frozen admission after resolved $change changes (catalog=${withCatalog})`,
    async ({ provider, fundingSource }) => {
      const clock = createManualClock();
      const store = createMemoryStore({ clock, budgets: [] });
      let policy: ConnectionPolicy = { provider: "serpapi", fundingSource: "byok" };
      const resolveConnection = vi.fn(() => policy);
      const meter = createMeter({
        store,
        clock,
        ...(withCatalog ? { catalog } : {}),
        resolveConnection,
        resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u" }),
      });
      const i = { ...input(), fundingSource: "byok" as const };
      const first = await meter.reserve({
        ...i,
        estimate: [{ unit: "cents", value: 25n, scale: 0 }, requests],
        estimateSource: "manual",
        providerPriceVersion: "frozen-v1",
      });
      expect(first.outcome).toBe("reserved");
      if (first.outcome !== "reserved") throw new Error("initial reservation failed");
      expect(resolveConnection).toHaveBeenCalledTimes(1);

      policy = { provider, fundingSource };
      // Omit the estimate and provenance: the replay must recover their original values.
      expect(await meter.reserve(i)).toMatchObject({
        outcome: "reserved",
        replayed: true,
        operation: first.operation,
      });
      expect(resolveConnection).toHaveBeenCalledTimes(1);
      expect(await store.getOperation({ ...i.scope, operationId: i.operationId })).toEqual(
        first.operation,
      );

      // The same old provider/funding is invalid for a new quote or reservation.
      const next = { ...i, operationId: crypto.randomUUID(), estimate: first.operation.estimate };
      const invalid = {
        outcome: "invalid",
        field: provider === i.provider ? "fundingSource" : "provider",
        reason:
          provider === i.provider
            ? "differs from the connection funding source"
            : "differs from the connection provider",
      };
      expect(await meter.quote(access, next)).toEqual(invalid);
      expect(await meter.reserve(next)).toEqual(invalid);
      expect(await store.getOperation({ ...next.scope, operationId: next.operationId })).toBeNull();
    },
  );
}

test.each(["manualPrices", "manualPriceBasis"] as const)("platform policy rejects %s", (field) => {
  const policy = {
    fundingSource: "platform" as const,
    ...(field === "manualPrices"
      ? { manualPrices: { search: { ...price, value: 0n } } }
      : { manualPriceBasis: { search: "call" as const } }),
  };
  expect(validateConnectionPolicy(policy, catalog.operationsOf("serpapi"))).toMatchObject({
    outcome: "invalid",
    field,
  });
  expect(
    validateConnectionPolicy({ ...policy, fundingSource: "byok" }, catalog.operationsOf("serpapi")),
  ).toBeNull();
});

test("same connection ID resolves independent policies by namespace for quote, reserve and billing", async () => {
  const clock = createManualClock();
  const store = createMemoryStore({ clock, budgets: [] });
  const policies: Record<string, ConnectionPolicy> = Object.fromEntries(
    ["test", "other"].map((namespace, index) => [
      namespace,
      {
        provider: "serpapi",
        fundingSource: "byok",
        plan: "starter",
        manualPrices: { search: { unit: "cents", value: BigInt(index + 1), scale: 0 } },
      },
    ]),
  );
  const meter = createMeter({
    store,
    clock,
    catalog,
    resolveConnection: ({ namespace, connection }) =>
      connection === "shared-id" ? policies[namespace] : undefined,
    resolveOwnership: async (scope) => ({
      kind: "principal",
      namespace: scope.namespace,
      principal: "u",
    }),
  });
  for (const [index, namespace] of ["test", "other"].entries()) {
    const i = {
      ...input(),
      scope: { ...input().scope, namespace },
      fundingSource: "byok" as const,
    };
    const authorized = { ...access, namespace, canImportBilling: true };
    const expected = { unit: "cents", value: BigInt(index + 1), scale: 0 };
    expect
      .soft(await meter.quote(authorized, i))
      .toMatchObject({ outcome: "ok", value: { quantities: expect.arrayContaining([expected]) } });
    expect.soft(await meter.reserve(i)).toMatchObject({
      outcome: "reserved",
      operation: { estimate: expect.arrayContaining([expected]) },
    });
    expect
      .soft(
        await meter.importBilling(authorized, {
          scope: i.scope,
          provider: i.provider,
          fileHash: "a".repeat(64),
          window: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
          expectedPreviousImportId: null,
          attribution: { fundingSource: "byok", costOwner: "u" },
          lines: [
            {
              providerRequestId: "external",
              operation: "search",
              occurredAt: "2026-09-23T12:00:00.000Z",
              cost: { units: 100n, currency: "USD" },
            },
          ],
        }),
      )
      .toMatchObject({ outcome: "imported" });
  }
});
