import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import type { AccessContext, ConnectionPolicy, MeterReserveInput } from "@usagekit/core";
import { expect, test, vi } from "vitest";
import { createCatalog, dataforseo, decimalQuantity } from "./index.js";
const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });

test("real catalog quotes match reservations for list, manual and measured item prices", async () => {
  for (const override of ["list", "manual", "measured"] as const) {
    const operation = "dataforseo_labs.google.keyword_ideas.live",
      clock = createManualClock(),
      store = createMemoryStore({ clock, budgets: [] });
    const c = {
      fundingSource: "byok" as const,
      provider: "dataforseo",
      ...(override === "manual"
        ? {
            manualPrices: { [operation]: decimalQuantity("0.02", "cents") },
            manualPriceBasis: { [operation]: "item" as const },
          }
        : {}),
      ...(override === "measured"
        ? {
            measured: () => ({
              quantity: decimalQuantity("0.00015", "cents"),
              basis: "item" as const,
              samples: 5,
            }),
          }
        : {}),
    };
    const meter = createMeter({
      store,
      clock,
      catalog,
      resolveConnection: () => c,
      resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u" }),
    });
    const access: AccessContext = {
      namespace: "test",
      readablePrincipals: ["u"],
      readableGroups: [],
      readablePools: [],
      canReadBillingDetail: true,
      canManageBudgets: false,
    };
    const i = {
      scope: { namespace: "test", principal: "u", connection: "c" },
      provider: "dataforseo",
      operation,
      fundingSource: "byok" as const,
      costOwner: "u",
      surface: "app" as const,
      source: "app" as const,
      options: { itemCount: "100", clickstream: "true" },
    };
    const quote = await meter.quote(access, i),
      reserved = await meter.reserve({ ...i, operationId: crypto.randomUUID() });
    if (quote.outcome !== "ok" || reserved.outcome !== "reserved")
      throw new Error("missing estimate");
    expect(quote.value.quantities).toEqual([
      decimalQuantity({ list: "4.8", manual: "6.4", measured: "4.8" }[override], "cents"),
      decimalQuantity("1", "requests"),
    ]);
    expect(quote.value.estimateSource).toBe(override);
    expect(quote.value.quantities).toEqual(reserved.operation.estimate);
    expect(quote.value.estimateSource).toBe(reserved.operation.estimateSource);
    expect(quote.value.providerPriceVersion).toBe(reserved.operation.providerPriceVersion);
  }
});

test("real DataForSEO catalog ignores zero call and item manual prices for platform Meter accounting", async () => {
  const operation = "dataforseo_labs.google.keyword_ideas.live";
  const customerCharge = decimalQuantity("7", "customer_cents");
  const hostEstimate = [customerCharge, decimalQuantity("1", "requests")];
  const access: AccessContext = {
    namespace: "test",
    readablePrincipals: ["u"],
    readableGroups: [],
    readablePools: [],
    canReadBillingDetail: true,
    canManageBudgets: false,
  };
  async function run(explicit: boolean, basis?: "call" | "item") {
    const clock = createManualClock();
    const store = createMemoryStore({
      clock,
      budgets: [
        {
          id: "credits",
          version: 1,
          scope: { kind: "principal", namespace: "test", principal: "u" },
          surface: "any",
          unit: "customer_cents",
          limit: decimalQuantity("100", "customer_cents"),
          window: { kind: "calendar_month", timezone: "UTC" },
          onExceed: "block",
        },
      ],
    });
    const reserve = vi.spyOn(store, "reserve");
    const countRequest = vi.spyOn(store, "countRequest");
    const meter = createMeter({
      store,
      clock,
      catalog,
      resolveConnection: () => ({
        fundingSource: "platform",
        provider: "dataforseo",
        plan: "prepaid",
        ...(basis
          ? {
              manualPrices: { [operation]: decimalQuantity("0", "cents") },
              manualPriceBasis: { [operation]: basis },
            }
          : {}),
      }),
      resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u" }),
    });
    const input: MeterReserveInput = {
      operationId: "platform-call",
      scope: { namespace: "test", principal: "u", connection: "c" },
      provider: "dataforseo",
      operation,
      fundingSource: "platform",
      costOwner: "u",
      surface: "app",
      source: "app",
      options: { itemCount: "100", clickstream: "true" },
      ...(explicit
        ? {
            estimate: hostEstimate,
            providerPriceVersion: "host-provider-v1",
            customerPriceVersion: "host-v1",
          }
        : {}),
    };
    const quote = await meter.quote(access, input);
    const reserved = await meter.reserve(input);
    const ref = { namespace: "test", principal: "u", operationId: input.operationId };
    const receipt = {
      ...catalog.extract(
        "dataforseo",
        operation,
        { method: "POST", url: "/v3/dataforseo_labs/google/keyword_ideas/live" },
        { status: 200 },
        { cost: 0.048 },
      ),
      id: "provider-receipt",
      occurredAt: clock.now().toISOString(),
      recordedAt: clock.now().toISOString(),
      providerPriceVersion: "dataforseo:2026-09-25",
    };
    let expectedVersion = 1;
    let leaseId = "no-reservation";
    if (reserved.outcome === "reserved") {
      const grant = await meter.markDispatchIntent({
        ...ref,
        commandId: "dispatch",
        expectedVersion: reserved.operation.version,
        holder: "worker",
        leaseTtlMs: 60000,
      });
      if (!("granted" in grant) || !grant.granted) throw new Error("no dispatch grant");
      expectedVersion = grant.operation.version;
      leaseId = grant.lease.leaseId;
    }
    const settled = await meter.settle({
      ...ref,
      commandId: "settle",
      expectedVersion,
      authority: { kind: "lease", leaseId },
      receipt,
    });
    if (explicit) {
      expect(quote).toMatchObject({
        outcome: "ok",
        value: {
          tracking: "metered",
          quantities: hostEstimate,
          providerPriceVersion: "host-provider-v1",
        },
      });
      expect(reserved).toMatchObject({
        outcome: "reserved",
        operation: {
          estimate: hostEstimate,
          providerPriceVersion: "host-provider-v1",
          customerPriceVersion: "host-v1",
        },
      });
      expect(settled).toMatchObject({
        outcome: "settled",
        operation: {
          state: "pending",
          estimate: hostEstimate,
          providerPriceVersion: "host-provider-v1",
          customerPriceVersion: "host-v1",
          receipts: [receipt],
        },
      });
      // Provider cost is evidence of upstream spend, not of the host's customer charge.
      expect(receipt.cost).toEqual({
        certainty: "measured",
        money: { currency: "USD", units: 48000n },
      });
      const budgetStatus = () =>
        store.applicableBudgets({
          scope: input.scope,
          surface: input.surface,
          units: ["customer_cents"],
        });
      expect(await budgetStatus()).toMatchObject([
        { reserved: customerCharge, used: { value: 0n } },
      ]);
      if (settled.outcome !== "settled") throw new Error("missing provider settlement");
      const charged = await meter.settle({
        ...ref,
        commandId: "host-charge",
        expectedVersion: settled.operation.version,
        authority: { kind: "late_evidence", source: "host-billing" },
        receipt: {
          ...receipt,
          id: "host-receipt",
          measurements: [
            ...receipt.measurements,
            {
              unit: "customer_cents",
              quantity: customerCharge,
              certainty: "measured",
            },
          ],
        },
      });
      expect(charged).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
      expect(await budgetStatus()).toMatchObject([
        { reserved: { value: 0n }, used: customerCharge },
      ]);
    } else {
      const invalid = {
        outcome: "invalid",
        field: "estimate",
        reason: "required from host customer-price policy for platform funding",
      };
      expect(quote).toEqual(invalid);
      expect(reserved).toEqual(invalid);
      expect(reserve).not.toHaveBeenCalled();
      expect(countRequest).not.toHaveBeenCalled();
      expect(await store.getOperation(ref)).toBeNull();
      expect(settled).toEqual({ outcome: "rejected", reason: "invalid_state", operation: null });
    }
    return { quote, reserved, settled };
  }
  for (const explicit of [false, true]) {
    const baseline = await run(explicit);
    for (const basis of ["call", "item"] as const)
      expect(await run(explicit, basis)).toEqual(baseline);
  }
});

test.each(["list", "measured", "manual"] as const)(
  "real %s pricing works for BYOK but cannot admit an unpriced platform call",
  async (source) => {
    const clock = createManualClock();
    const store = createMemoryStore({ clock, budgets: [] });
    const operation = "serp.google.organic.live.advanced";
    const policy: ConnectionPolicy = {
      fundingSource: "byok",
      provider: "dataforseo",
      plan: "prepaid",
      ...(source === "manual"
        ? {
            manualPrices: {
              [operation]: decimalQuantity("3", "cents"),
            },
          }
        : {}),
      ...(source === "measured"
        ? {
            measured: () => ({
              quantity: decimalQuantity("2", "cents"),
              samples: 5,
            }),
          }
        : {}),
    };
    const meter = createMeter({
      clock,
      store,
      catalog,
      resolveConnection: () => policy,
      resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u" }),
    });
    const access: AccessContext = {
      namespace: "test",
      readablePrincipals: ["u"],
      readableGroups: [],
      readablePools: [],
      canReadBillingDetail: true,
      canManageBudgets: false,
    };
    const input: MeterReserveInput = {
      operationId: "priced",
      scope: { namespace: "test", principal: "u", connection: "c" },
      provider: "dataforseo",
      operation,
      fundingSource: "byok",
      costOwner: "u",
      source: "app",
      surface: "app",
    };
    const quantities = [
      decimalQuantity({ list: "0.2", measured: "2", manual: "3" }[source], "cents"),
      decimalQuantity("1", "requests"),
    ];
    expect(await meter.quote(access, input)).toMatchObject({
      outcome: "ok",
      value: { estimateSource: source, quantities },
    });
    expect(await meter.reserve(input)).toMatchObject({
      outcome: "reserved",
      operation: { estimateSource: source, estimate: quantities },
    });
    policy.fundingSource = "platform";
    const platformInput = { ...input, operationId: "unpriced", fundingSource: "platform" as const };
    const invalid = { outcome: "invalid", field: "estimate" };
    expect(await meter.quote(access, platformInput)).toMatchObject(invalid);
    expect(await meter.reserve(platformInput)).toMatchObject(invalid);
    expect(
      await store.getOperation({
        namespace: "test",
        principal: "u",
        operationId: "unpriced",
      }),
    ).toBeNull();
  },
);
