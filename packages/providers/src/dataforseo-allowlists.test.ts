import { expect, test, vi } from "vitest";
import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createCatalog, dataforseo, decimalQuantity } from "./index.js";
import { executeProviderRequest } from "../test-support/execute.js";

const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });
const connection = { id: "c", provider: "dataforseo", fundingSource: "byok" as const };
const live = "serp/google/organic/live/advanced";
const post = "serp/google/organic/task_post";
const request = (path: string, task: Record<string, unknown>) => ({
  method: "POST",
  url: `/v3/${path}`,
  body: [task],
});
function estimate(path: string, task: Record<string, unknown>) {
  const match = catalog.match("dataforseo", request(path, task));
  if (match.operation === "unknown") throw new Error("missing operation");
  return catalog.estimate(connection, match.operation.id, match.options);
}
const unknown = { source: "unknown", quantities: [decimalQuantity("1", "requests")] };
const billable = dataforseo.descriptor.operations.filter((op) => op.billable);
test.each(billable)("unlisted task field makes $id unknown", (op) => {
  expect(estimate(op.match[0]!.path.slice(4), { future_paid_parameter: true })).toEqual(unknown);
});
test.each(["Depth", "LIMIT", "Ｆｕｔｕｒｅ", "future_paid_parameter"])(
  "unknown spelling %s never falls back to base",
  (key) => {
    expect(estimate(live, { [key]: 1 })).toEqual(unknown);
  },
);
test.each([
  ["android substring", { keyword: "android:" }, "1"],
  ["two operators", { keyword: "site:example.com intitle:foo" }, "5"],
  ["NFKC operators", { keyword: "ＳＩＴＥ：foo ＩＮＴＩＴＬＥ：bar" }, "5"],
  ["decoded keyword", { keyword: "site%3Aexample.com" }, "1"],
  ["decoded search_param", { search_param: "&q=site%253Afoo+intitle%3Abar" }, "5"],
  ["operators across fields", { keyword: "site:foo", search_param: "&q=intitle:bar" }, "5"],
  ["rectangles", { calculate_rectangles: true }, "0.4"],
  ["async overview", { load_async_ai_overview: true }, "0.4"],
  ["one click", { people_also_ask_click_depth: 1 }, "0.215"],
  ["four clicks", { people_also_ask_click_depth: 4 }, "0.26"],
  ["crawl dominates depth", { depth: 10, max_crawl_pages: 10 }, "2"],
  ["depth dominates crawl", { depth: 100, max_crawl_pages: 1 }, "2"],
  [
    "combined bound",
    {
      depth: 20,
      keyword: "site:x intitle:y",
      calculate_rectangles: true,
      load_async_ai_overview: true,
      people_also_ask_click_depth: 4,
    },
    "33",
  ],
] as const)("live prices %s", (_name, task, cents) => {
  expect(estimate(live, task).quantities[0]).toEqual(decimalQuantity(cents, "cents"));
});
test.each([
  ["normal rectangles", { calculate_rectangles: true }, "0.12"],
  ["normal async", { load_async_ai_overview: true }, "0.12"],
  ["high rectangles", { priority: 2, calculate_rectangles: true }, "0.24"],
  ["high async", { priority: 2, load_async_ai_overview: true }, "0.24"],
  ["high four clicks", { priority: 2, people_also_ask_click_depth: 4 }, "0.18"],
  ["high two operators", { priority: 2, keyword: "site:x intitle:y" }, "3"],
] as const)("task post prices %s", (_name, task, cents) => {
  expect(estimate(post, task).quantities[0]).toEqual(decimalQuantity(cents, "cents"));
});
test.each(["ranked_keywords", "domain_rank_overview"])(
  "%s bounds 1000 and default rows",
  (name) => {
    const path = `dataforseo_labs/google/${name}/live`;
    expect(estimate(path, { limit: 1000 }).quantities[0]).toEqual(decimalQuantity("13.2", "cents"));
    expect(estimate(path, {}).quantities[0]).toEqual(decimalQuantity("2.4", "cents"));
  },
);
test.each(billable.filter((op) => op.optionKeys?.includes("itemCount")))(
  "limit zero is unknown for $id",
  (op) => {
    expect(estimate(op.match[0]!.path.slice(4), { limit: 0 })).toEqual(unknown);
  },
);
test("summary bounds one row and history has no count", () => {
  expect(estimate("backlinks/summary/live", {}).quantities[0]).toEqual(
    decimalQuantity("2.4036", "cents"),
  );
  expect(estimate("backlinks/history/live", {})).toEqual(unknown);
});
test.each([false, true])(
  "unlisted fields ignore explicit prices and leave admission to Meter (platform=%s)",
  async (platform) => {
    const clock = createManualClock();
    const store = createMemoryStore({ clock, budgets: [] });
    const policy = {
      ...connection,
      fundingSource: platform ? ("platform" as const) : ("byok" as const),
    };
    const meter = createMeter({ store, clock, catalog, resolveConnection: () => policy });
    const reserve = vi.spyOn(meter, "reserve");
    const dispatch = vi.fn(async () => ({ response: { status: 200 }, body: {} }));
    const result = await executeProviderRequest({
      catalog,
      meter,
      request: request(live, { future_paid_parameter: true }),
      dispatch,
      input: {
        operationId: "unlisted",
        scope: { namespace: "test", principal: "u", connection: "c" },
        provider: "dataforseo",
        source: "app",
        surface: "app",
        fundingSource: policy.fundingSource,
        costOwner: "u",
        estimate: [decimalQuantity("1", platform ? "credits" : "cents")],
      },
    });
    expect(result.outcome).toBe(platform ? "not_dispatched" : "completed");
    expect(dispatch).toHaveBeenCalledTimes(platform ? 0 : 1);
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve.mock.calls[0]![0]).toMatchObject({
      estimate: unknown.quantities,
      estimateSource: "unknown",
    });
  },
);

test.each(["keyword", "search_param"])("NFKC normalization precedes decoding in %s", (field) => {
  expect(estimate(live, { [field]: "ｓｉｔｅ％３Ａexample.com" }).quantities[0]).toEqual(
    decimalQuantity("1", "cents"),
  );
});
test.each(["keyword_ideas", "keyword_suggestions"])(
  "%s opaque token cannot hide prior paid options",
  (name) => {
    expect(
      estimate(`dataforseo_labs/google/${name}/live`, {
        offset_token: "previous-task",
        limit: 100,
      }),
    ).toEqual(unknown);
  },
);

test.each(["true", "false", 0, 1, null])("seed flag rejects non-boolean %j", (value) => {
  expect(() =>
    estimate("dataforseo_labs/google/keyword_suggestions/live", { include_seed_keyword: value }),
  ).toThrow("InvalidInput:");
});
