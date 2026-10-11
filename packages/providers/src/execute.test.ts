import { expect, test, vi } from "vitest";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createMeter } from "@usagekit/meter";
import type { ProviderRequest } from "./index.js";
import type { Budget } from "@usagekit/core";
import {
  PricedRequest,
  executeProviderRequest as executePriced,
  createCatalog,
  dataforseo,
  serpapi,
} from "./index.js";
import { executeProviderRequest } from "../test-support/execute.js";

function harness(tracking?: "passthrough", fundingSource: "byok" | "platform" = "byok") {
  const clock = createManualClock("2026-09-26T12:00:00Z");
  const catalog = createCatalog({
    providers: [dataforseo, serpapi],
    enabled: ["dataforseo", "serpapi"],
    now: clock.now,
  });
  const budgets: Budget[] = [];
  const store = createMemoryStore({ clock, budgets });
  const meter = createMeter({
    store,
    clock,
    catalog,
    resolveConnection: () => ({
      fundingSource,
      provider: "dataforseo",
      plan: "prepaid",
      ...(tracking ? { tracking: { "serp.google.organic.live.advanced": tracking } } : {}),
    }),
  });
  const input = {
    operationId: "one",
    scope: { namespace: "test", principal: "u", connection: "c" },
    provider: "dataforseo",
    source: "app" as const,
    surface: "app" as const,
    fundingSource: "byok" as const,
    costOwner: "u",
  };
  const request: ProviderRequest = {
    method: "POST",
    url: "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
    body: [{ keyword: "example" }],
  };
  const dispatch = vi.fn(async () => ({
    response: { status: 200 },
    body: {
      status_code: 20000,
      cost: 0.002,
      tasks: [{ id: "task", status_code: 20000, cost: 0.002, result: [] }],
    },
  }));
  return { meter, store, budgets, catalog, input, request, dispatch, now: clock.now };
}
test("one parallel execution wins dispatch; later replay also cannot dispatch", async () => {
  const h = harness();
  const results = await Promise.all([executeProviderRequest(h), executeProviderRequest(h)]);
  expect(results.map((r) => r.outcome).sort()).toEqual(["completed", "not_dispatched"]);
  expect(results.find((r) => r.outcome === "completed")).toMatchObject({
    accounting: "metered",
    operation: { state: "settled" },
  });
  expect((await executeProviderRequest(h)).outcome).toBe("not_dispatched");
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});
test("unknown routes and denied reservations never dispatch", async () => {
  const h = harness();
  expect(
    (await executeProviderRequest({ ...h, request: { ...h.request, url: "/unknown" } })).outcome,
  ).toBe("not_dispatched");
  expect(h.dispatch).not.toHaveBeenCalled();
  vi.spyOn(h.meter, "reserve").mockResolvedValue({
    outcome: "invalid",
    field: "estimate",
    reason: "test denial",
  });
  expect((await executeProviderRequest(h)).outcome).toBe("not_dispatched");
  expect(h.dispatch).not.toHaveBeenCalled();
});
test("passthrough and free requests dispatch once with a persistent replay guard", async () => {
  for (const free of [false, true]) {
    const h = harness("passthrough");
    if (free) h.request.url = "https://api.dataforseo.com/v3/appendix/user_data";
    if (free) h.request.method = "GET";
    expect(await executeProviderRequest(h)).toMatchObject({
      outcome: "completed",
      accounting: "passthrough",
      operation: null,
    });
    expect((await executeProviderRequest(h)).outcome).toBe("not_dispatched");
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  }
});
test("transport failure remains pending and cannot authorize a paid retry", async () => {
  const h = harness();
  h.dispatch.mockRejectedValueOnce(new Error("secret transport message"));
  expect(await executeProviderRequest(h)).toMatchObject({
    outcome: "transport_failed",
    operation: { state: "pending", receipts: [{ cost: { certainty: "unknown" } }] },
  });
  expect((await executeProviderRequest(h)).outcome).toBe("not_dispatched");
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});
test("an accounting failure is distinct from a provider failure", async () => {
  const h = harness();
  vi.spyOn(h.meter, "settle").mockResolvedValue({
    outcome: "invalid",
    field: "receipt",
    reason: "test",
  });
  expect(await executeProviderRequest(h)).toMatchObject({ outcome: "accounting_failed" });
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});

test("platform calls hold customer budget until host charge evidence arrives despite passthrough tracking", async () => {
  const h = harness("passthrough", "platform");
  const reserve = vi.spyOn(h.store, "reserve");
  const settle = vi.spyOn(h.store, "settle");
  const count = vi.spyOn(h.store, "countRequest");
  let operationAtDispatch: Awaited<ReturnType<typeof h.store.getOperation>> = null;
  const dispatch = vi.fn(async () => {
    operationAtDispatch = await h.store.getOperation({
      namespace: "test",
      principal: "u",
      operationId: "one",
    });
    return h.dispatch();
  });
  const estimate = [{ unit: "customer_cents", value: 9n, scale: 0 }];
  h.budgets.push({
    id: "customer",
    version: 1,
    scope: { kind: "principal", namespace: "test", principal: "u" },
    surface: "any",
    unit: "customer_cents",
    limit: { ...estimate[0]!, value: 100n },
    window: { kind: "calendar_month", timezone: "UTC" },
    onExceed: "block",
  });
  expect(
    await executeProviderRequest({
      ...h,
      dispatch,
      input: { ...h.input, fundingSource: "platform", estimate, customerPriceVersion: "host-v1" },
    }),
  ).toMatchObject({
    outcome: "completed",
    accounting: "metered",
    operation: {
      state: "pending",
      fundingSource: "platform",
      estimate,
      customerPriceVersion: "host-v1",
      receipts: [{ cost: { money: { currency: "USD", units: 2000n } } }],
    },
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(operationAtDispatch).toMatchObject({
    state: "dispatch_intended",
    fundingSource: "platform",
  });
  expect(
    await h.store.getOperation({ namespace: "test", principal: "u", operationId: "one" }),
  ).toMatchObject({
    state: "pending",
    estimate,
    customerPriceVersion: "host-v1",
    receipts: [{ cost: { money: { units: 2000n } } }],
  });
  expect(settle).toHaveBeenCalledTimes(1);
  expect(count).not.toHaveBeenCalled();
  const budgets = () =>
    h.store.applicableBudgets({
      scope: h.input.scope,
      surface: h.input.surface,
      source: h.input.source,
      units: ["customer_cents"],
    });
  expect(await budgets()).toMatchObject([{ reserved: estimate[0], used: { value: 0n } }]);
  const pending = await h.store.getOperation({
    namespace: "test",
    principal: "u",
    operationId: "one",
  });
  if (!pending) throw new Error("pending customer evidence missing");
  const receipt = pending.receipts[0]!;
  expect(
    await h.meter.settle({
      namespace: "test",
      principal: "u",
      operationId: "one",
      commandId: "customer-evidence",
      expectedVersion: pending.version,
      authority: { kind: "late_evidence", source: "host-billing" },
      receipt: {
        ...receipt,
        id: "customer-receipt",
        measurements: [
          ...receipt.measurements,
          { unit: "customer_cents", quantity: estimate[0]!, certainty: "measured" },
        ],
      },
    }),
  ).toMatchObject({
    outcome: "settled",
    operation: { state: "settled", estimate, customerPriceVersion: "host-v1" },
  });
  expect(await budgets()).toMatchObject([{ reserved: { value: 0n }, used: estimate[0] }]);
});

test.each(["byok", "platform"] as const)(
  "%s free calls forward without a reservation or charge",
  async (fundingSource) => {
    const h = harness("passthrough", fundingSource);
    const reserve = vi.spyOn(h.store, "reserve");
    const settle = vi.spyOn(h.store, "settle");
    h.request.url = "https://api.dataforseo.com/v3/appendix/user_data";
    h.request.method = "GET";
    expect(
      await executeProviderRequest({ ...h, input: { ...h.input, fundingSource } }),
    ).toMatchObject({
      outcome: "completed",
      accounting: "passthrough",
      operation: null,
    });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  },
);

test("BYOK passthrough still forwards billable calls without reserving or charging", async () => {
  const h = harness("passthrough");
  const reserve = vi.spyOn(h.store, "reserve");
  const settle = vi.spyOn(h.store, "settle");
  expect(await executeProviderRequest(h)).toMatchObject({
    outcome: "completed",
    accounting: "passthrough",
    operation: null,
  });
  expect(h.dispatch).toHaveBeenCalledTimes(1);
  expect(reserve).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test("execution transports the canonical priced bytes and snapshots caller mutations", async () => {
  const h = harness();
  h.request.body = [{ keyword: "example", depth: 100 }];
  const match = vi.spyOn(h.catalog, "match");
  const dispatch = vi.fn(async (request: { body?: unknown; url: string }) => {
    expect(new TextDecoder().decode(request.body as Uint8Array)).toBe(
      '[{"keyword":"example","depth":100}]',
    );
    expect(request.url).toBe(h.request.url);
    return h.dispatch();
  });
  expect(await executeProviderRequest({ ...h, dispatch })).toMatchObject({ outcome: "completed" });
  expect(match).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  "unknown execution leaves no reservation or budget hold (explicit estimate: %s)",
  async (explicit) => {
    const h = harness();
    h.budgets.push({
      id: "requests",
      version: 1,
      scope: { kind: "principal", namespace: "test", principal: "u" },
      surface: "any",
      unit: "requests",
      limit: { unit: "requests", value: 10n, scale: 0 },
      window: { kind: "calendar_month", timezone: "UTC" },
      onExceed: "block",
    });
    const priced = await PricedRequest.price({
      ...h,
      input: {
        ...h.input,
        ...(explicit ? { estimate: [{ unit: "requests", value: 9n, scale: 0 }] } : {}),
      },
      request: { ...h.request, url: "/unknown" },
    });
    expect(await executePriced({ ...h, request: priced })).toMatchObject({
      outcome: "not_dispatched",
    });
    expect.soft(priced.admission.outcome).toBe("unpriced");
    expect
      .soft(await h.store.getOperation({ namespace: "test", principal: "u", operationId: "one" }))
      .toBeNull();
    expect
      .soft(
        await h.store.applicableBudgets({
          scope: h.input.scope,
          surface: h.input.surface,
          source: h.input.source,
          units: ["requests"],
        }),
      )
      .toMatchObject([{ reserved: { value: 0n } }]);
    expect(h.dispatch).not.toHaveBeenCalled();
  },
);
