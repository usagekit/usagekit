import { expect, test, vi } from "vitest";
import type { Budget, ConnectionPolicy } from "@usagekit/core";
import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createCatalog, dataforseo, decimalQuantity } from "./index.js";
import { executeProviderRequest } from "../test-support/execute.js";

const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });
const connection = { id: "c", provider: "dataforseo", fundingSource: "byok" as const };
const live = "serp.google.organic.live.advanced";
const post = "serp.google.organic.task_post";
const unknown = { source: "unknown", quantities: [decimalQuantity("1", "requests")] };
const request = (operation: string, task: Record<string, unknown>) => ({
  method: "POST",
  url: `/v3/${operation.replaceAll(".", "/")}`,
  body: [task],
});
function estimate(operation: string, task: Record<string, unknown>, policy = connection) {
  const matched = catalog.match("dataforseo", request(operation, task));
  if (matched.operation === "unknown") throw new Error("missing operation");
  return catalog.estimate(policy, operation, matched.options);
}
const budget: Budget = {
  id: "money",
  version: 1,
  scope: { kind: "principal", namespace: "test", principal: "u" },
  surface: "any",
  unit: "cents",
  limit: decimalQuantity("3", "cents"),
  window: { kind: "calendar_month", timezone: "UTC" },
  onExceed: "block",
};

test.each(["money", "platform", "passthrough", "unbounded"] as const)(
  "uncertain execute request delegates %s to Meter and ignores explicit price",
  async (mode) => {
    const clock = createManualClock();
    const store = createMemoryStore({ clock, budgets: mode === "money" ? [budget] : [] });
    const policy: ConnectionPolicy = {
      ...connection,
      fundingSource: mode === "platform" ? "platform" : "byok",
      ...(mode === "passthrough" ? { tracking: { [live]: "passthrough" } } : {}),
    };
    const meter = createMeter({ store, clock, catalog, resolveConnection: () => policy });
    const reserve = vi.spyOn(meter, "reserve");
    const dispatch = vi.fn(async () => ({ response: { status: 200 }, body: {} }));
    const result = await executeProviderRequest({
      catalog,
      meter,
      request: request(live, { keyword: "example", future_paid_parameter: true }),
      dispatch,
      input: {
        operationId: "uncertain",
        scope: { namespace: "test", principal: "u", connection: "c" },
        provider: "dataforseo",
        source: "app",
        surface: "app",
        fundingSource: policy.fundingSource,
        costOwner: "u",
        estimate: [decimalQuantity("1", mode === "platform" ? "credits" : "cents")],
        estimateSource: "list",
        providerPriceVersion: "caller-version",
      },
    });
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve.mock.calls[0]![0]).toMatchObject({
      estimate: unknown.quantities,
      estimateSource: "unknown",
    });
    expect(reserve.mock.calls[0]![0]).not.toHaveProperty("providerPriceVersion");
    if (mode === "money")
      expect(result).toMatchObject({
        outcome: "not_dispatched",
        result: { outcome: "invalid", reason: "missing_estimate_unit" },
      });
    else if (mode === "platform")
      expect(result).toMatchObject({
        outcome: "not_dispatched",
        result: { outcome: "invalid", field: "estimate" },
      });
    else {
      expect(result).toMatchObject({
        outcome: "completed",
        accounting: mode === "passthrough" ? "passthrough" : "metered",
      });
      expect(dispatch).toHaveBeenCalledOnce();
      if (mode === "unbounded")
        expect(result).toMatchObject({
          operation: {
            estimate: unknown.quantities,
            estimateSource: "unknown",
            receipts: [{ cost: { certainty: "unknown", money: null } }],
          },
        });
    }
    if (mode === "money" || mode === "platform") expect(dispatch).not.toHaveBeenCalled();
  },
);

test.each([
  "backlinks.history.live",
  "dataforseo_labs.google.historical_rank_overview.live",
  "dataforseo_labs.google.keyword_overview.live",
])("missing count permits whole-call overrides for %s", (operation) => {
  const price = decimalQuantity("3", "cents");
  for (const source of ["manual", "measured"] as const) {
    const policy = {
      ...connection,
      ...(source === "manual"
        ? { manualPrices: { [operation]: price } }
        : { measured: () => ({ quantity: price, samples: 5 }) }),
    };
    expect(estimate(operation, {}, policy)).toMatchObject({
      source,
      quantities: [price, ...unknown.quantities],
    });
    expect(estimate(operation, { future_paid_parameter: true }, policy)).toEqual(unknown);
  }
});
test("explicit host price still replaces a missing count", async () => {
  const clock = createManualClock();
  const store = createMemoryStore({ clock, budgets: [budget] });
  const meter = createMeter({ store, clock, catalog, resolveConnection: () => connection });
  const result = await executeProviderRequest({
    catalog,
    meter,
    request: request("backlinks.history.live", {}),
    dispatch: async () => ({ response: { status: 200 }, body: {} }),
    input: {
      operationId: "count",
      scope: { namespace: "test", principal: "u", connection: "c" },
      provider: "dataforseo",
      source: "app",
      surface: "app",
      fundingSource: "byok",
      costOwner: "u",
      estimate: [decimalQuantity("3", "cents")],
    },
  });
  expect(result).toMatchObject({
    outcome: "completed",
    operation: { estimate: [decimalQuantity("3", "cents")] },
  });
});

const surcharges = [
  { keyword: "site:x" },
  { calculate_rectangles: true },
  { load_async_ai_overview: true },
  { people_also_ask_click_depth: 4 },
  { max_crawl_pages: 10 },
  {
    keyword: "site:x",
    depth: 20,
    calculate_rectangles: true,
    load_async_ai_overview: true,
    people_also_ask_click_depth: 4,
  },
];
test.each(
  [live, post].flatMap((operation) =>
    ["manual", "measured"].flatMap((source) =>
      surcharges.map((task) => ({ operation, source, task })),
    ),
  ),
)("$source never underprices $operation $task", ({ operation, source, task }) => {
  const listed = estimate(operation, task).quantities[0]!;
  for (const price of [decimalQuantity("0.02", "cents"), decimalQuantity("200", "cents")]) {
    const policy = {
      ...connection,
      ...(source === "manual"
        ? { manualPrices: { [operation]: price } }
        : { measured: () => ({ quantity: price, samples: 5 }) }),
    };
    expect(estimate(operation, task, policy).quantities[0]).toEqual(
      price.value === 2n ? listed : price,
    );
  }
});
test.each(["50% off shoes", "100%", "100% cotton"])(
  "literal percent keyword %s keeps rank-check price",
  (keyword) => {
    expect(
      estimate(live, { keyword, depth: 100, search_param: "&nfpr=1", stop_crawl_on_match: [] })
        .quantities[0],
    ).toEqual(decimalQuantity("2", "cents"));
  },
);
test("encoded operators still multiply and malformed search_param stays strict", () => {
  expect(estimate(live, { keyword: "site%3Ax" }).quantities[0]).toEqual(
    decimalQuantity("1", "cents"),
  );
  expect(() => estimate(live, { search_param: "50% off" })).toThrow("InvalidInput:");
});
test.each(["İNURL:x", "si\u00adte:x", "s\u0307ite:x"])("conservative Unicode %s", (keyword) => {
  expect(estimate(live, { keyword }).quantities[0]).toEqual(decimalQuantity("1", "cents"));
});
test.each(["operatorCount", "clicks"])("malformed direct %s is InvalidInput", (field) => {
  for (const value of ["wat", "1.5", "-1", "9007199254740992"]) {
    expect(() => catalog.estimate(connection, live, { [field]: value })).toThrow("InvalidInput:");
  }
});

test("explicit BYOK price cannot undercut a documented surcharge", async () => {
  const clock = createManualClock();
  const store = createMemoryStore({ clock, budgets: [] });
  const meter = createMeter({ store, clock, catalog, resolveConnection: () => connection });
  const result = await executeProviderRequest({
    catalog,
    meter,
    request: request(live, { keyword: "site:x" }),
    dispatch: async () => ({ response: { status: 200 }, body: {} }),
    input: {
      operationId: "floor",
      scope: { namespace: "test", principal: "u", connection: "c" },
      provider: "dataforseo",
      source: "app",
      surface: "app",
      fundingSource: "byok",
      costOwner: "u",
      estimate: [decimalQuantity("0.2", "cents")],
    },
  });
  expect(result).toMatchObject({
    outcome: "completed",
    operation: { estimate: [decimalQuantity("1", "cents")] },
  });
});
