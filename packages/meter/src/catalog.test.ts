import { expect, test } from "vitest";
import { createMemoryStore, createManualClock } from "@usagekit/store";
import type {
  AccessContext,
  ConnectionPolicy,
  MeterReserveInput,
  PricingCatalog,
  ProviderOperation,
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
const requests: Quantity = { unit: "requests", value: 1n, scale: 0 };
const listed: Quantity = { unit: "cents", value: 20n, scale: 4 };
const high: Quantity = { unit: "cents", value: 40n, scale: 4 };
const operation = (id: string, billable: boolean): ProviderOperation => ({
  id,
  label: id,
  billable,
  match: [],
  costEvidence: "none",
});
const request = (operationId = crypto.randomUUID()): MeterReserveInput => ({
  operationId,
  scope: { namespace: "test", principal: "u1", connection: "c1" },
  fundingSource: "byok",
  costOwner: "u1",
  surface: "app",
  source: "app",
  provider: "search",
  operation: "search",
});

function harness(policy: ConnectionPolicy = { fundingSource: "byok", provider: "search" }) {
  let price = listed;
  const calls: string[] = [];
  const catalog: PricingCatalog = {
    operationsOf: (provider) =>
      provider === "search" ? [operation("search", true), operation("account", false)] : [],
    estimate: (connection, operationId, options) => {
      calls.push(`${connection.id}:${operationId}:${options.priority ?? ""}`);
      return {
        quantities: [options.priority === "high" ? high : price, requests],
        source: "list",
        priceVersion: "search:2026-09-01",
      };
    },
  };
  const clock = createManualClock();
  const meter = createMeter({
    store: createMemoryStore({ clock, budgets: [] }),
    clock,
    catalog,
    resolveConnection: async ({ namespace, connection }) =>
      namespace === "test" && connection === "c1" ? policy : undefined,
  });
  return {
    meter,
    calls,
    setPrice: (quantity: Quantity) => {
      price = quantity;
    },
  };
}

test("catalog estimate is stored with provenance and a retry does not reprice", async () => {
  const { meter, calls, setPrice } = harness(),
    i = { ...request(), options: { priority: "high" } },
    reserved = await meter.reserve(i);
  expect(calls).toEqual(["c1:search:high"]);
  expect(reserved).toMatchObject({
    outcome: "reserved",
    replayed: false,
    operation: {
      estimate: [high, requests],
      estimateSource: "list",
      providerPriceVersion: "search:2026-09-01",
    },
  });
  setPrice({ unit: "cents", value: 1n, scale: 0 });
  expect(await meter.reserve(i)).toMatchObject({
    outcome: "reserved",
    replayed: true,
    operation: { estimate: [high, requests], estimateSource: "list" },
  });
  expect(calls).toEqual(["c1:search:high"]);
  expect(await meter.reserve({ ...i, estimate: [high, requests] })).toMatchObject({
    replayed: true,
  });
  expect(await meter.reserve({ ...i, estimate: [listed, requests] })).toMatchObject({
    outcome: "conflict",
    reason: "semantic_mismatch",
  });
});

test("tracking passthrough and free operations are counted and never reserved", async () => {
  const tracked = harness({
      fundingSource: "byok",
      provider: "search",
      tracking: { search: "passthrough" },
    }),
    i = request();
  expect(await tracked.meter.reserve(i)).toEqual({
    outcome: "passthrough",
    replayed: false,
    operation: null,
  });
  expect(await tracked.meter.reserve({ ...i, estimate: [requests] })).toEqual({
    outcome: "passthrough",
    replayed: true,
    operation: null,
  });
  expect(tracked.calls).toEqual([]);
  expect(
    await tracked.meter.getOperation(access, {
      namespace: "test",
      principal: "u1",
      operationId: i.operationId,
    }),
  ).toEqual({ outcome: "ok", value: null });

  const free = harness(),
    account = { ...request(), operation: "account", estimate: [requests] };
  expect(await free.meter.reserve(account)).toMatchObject({
    outcome: "passthrough",
    replayed: false,
  });
  expect(free.calls).toEqual([]);
});

test("an unknown operation is unpriced unless the caller supplies an estimate", async () => {
  const { meter, calls } = harness(),
    missing = { ...request(), operation: "missing" };
  expect(await meter.reserve(missing)).toEqual({
    outcome: "unpriced",
    replayed: false,
    operation: null,
  });
  expect(await meter.reserve(missing)).toEqual({
    outcome: "unpriced",
    replayed: true,
    operation: null,
  });
  const priced = await meter.reserve({
    ...request(),
    operation: "missing",
    estimate: [requests],
    estimateSource: "manual",
  });
  expect(priced).toMatchObject({
    outcome: "reserved",
    operation: { estimate: [requests], estimateSource: "manual" },
  });
  expect(calls).toEqual([]);
  expect(
    await meter.reserve({ ...request(), operation: "account", operationId: missing.operationId }),
  ).toMatchObject({
    outcome: "invalid",
    field: "operationId",
  });
});

test("a disabled provider is unpriced and a different provider is invalid", async () => {
  const disabled = harness({ fundingSource: "byok", provider: "other" });
  expect(
    await disabled.meter.reserve({ ...request(), provider: "other", operation: "search" }),
  ).toEqual({ outcome: "unpriced", replayed: false, operation: null });
  const { meter } = harness();
  expect(await meter.reserve({ ...request(), provider: "other" })).toMatchObject({
    outcome: "invalid",
    field: "provider",
    reason: "differs from the connection provider",
  });
});

test("omitted estimate without a resolvable connection is invalid", async () => {
  const clock = createManualClock();
  const bare = createMeter({ store: createMemoryStore({ clock, budgets: [] }), clock });
  expect(await bare.reserve(request())).toMatchObject({
    outcome: "invalid",
    field: "estimate",
    reason: "required without a catalog",
  });
  const { meter } = harness();
  const i = request();
  expect(await meter.reserve({ ...i, scope: { ...i.scope, connection: "missing" } })).toMatchObject(
    { outcome: "invalid", field: "estimate", reason: "unknown connection" },
  );
  expect(
    await meter.reserve({ ...request(), estimate: [requests], estimateSource: "guess" as "list" }),
  ).toMatchObject({ outcome: "invalid", field: "estimateSource" });
});

test("passthrough and unpriced counts share the usage window", async () => {
  const { meter } = harness();
  await meter.reserve({ ...request(), operation: "account" });
  await meter.reserve({ ...request(), operation: "missing" });
  expect(
    await meter.requestCounts(access, {
      scope: { kind: "principal", namespace: "test", principal: "u1" },
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      groupBy: ["operation"],
    }),
  ).toMatchObject({
    outcome: "ok",
    value: {
      rows: [
        { dimensions: { operation: "account" }, state: "passthrough", count: 1n },
        { dimensions: { operation: "missing" }, state: "unpriced", count: 1n },
      ],
    },
  });
});
