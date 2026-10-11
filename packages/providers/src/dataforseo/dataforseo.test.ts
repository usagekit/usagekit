import { describe, expect, test } from "vitest";
import { createCatalog, loadFixtures } from "../index.js";
import { dataforseo } from "../index.js";
import { runDescriptorConformance } from "../testing/index.js";

const files = import.meta.glob("./fixtures/**/*.json", { eager: true, import: "default" });
runDescriptorConformance(dataforseo.descriptor, dataforseo.extractors, files);

describe("provider A (dataforseo)", () => {
  const catalog = createCatalog({
    providers: [dataforseo],
    enabled: ["dataforseo"],
    now: () => new Date("2026-09-25T12:00:00.000Z"),
  });
  const connection = {
    id: "c1",
    provider: "dataforseo",
    fundingSource: "byok" as const,
    plan: "prepaid",
  };

  test("one prepaid hard plan, basic auth, per-request billing export by task id", () => {
    const d = dataforseo.descriptor;
    expect(d.auth).toEqual({ kind: "basic" });
    expect(d.plans).toEqual([
      { id: "prepaid", label: "Prepaid balance", cycle: "prepaid", allowanceMode: "hard" },
    ]);
    expect(d.billingExport).toMatchObject({
      kind: "task-history",
      granularity: "per-request",
      matchKey: "providerRequestId",
    });
    expect(d.operations.filter((o) => !o.billable).map((o) => o.id)).toEqual([
      "serp.google.organic.tasks_ready",
      "serp.google.organic.task_get.advanced",
      "appendix.user_data",
      "dataforseo_labs.status",
    ]);
    expect(d.operations.find((o) => o.id === "serp.google.organic.task_post")?.costEvidence).toBe(
      "deferred",
    );
  });

  test("list estimates in cents per call, priority from the request body", () => {
    expect(catalog.estimate(connection, "serp.google.organic.live.advanced", {})).toEqual({
      quantities: [
        { value: 2n, scale: 1, unit: "cents" },
        { value: 1n, scale: 0, unit: "requests" },
      ],
      source: "list",
      priceVersion: "dataforseo:2026-09-25",
      checkedAt: "2026-09-25",
    });
    const post = (priority?: number) =>
      catalog.match("dataforseo", {
        method: "POST",
        url: "https://api.dataforseo.com/v3/serp/google/organic/task_post",
        body: [{ keyword: "x", ...(priority ? { priority } : {}) }],
      });
    const high = post(2);
    if (high.operation === "unknown") throw new Error("fixture");
    expect(catalog.estimate(connection, high.operation.id, high.options).quantities[0]).toEqual({
      value: 12n,
      scale: 2,
      unit: "cents",
    });
    expect(post(1)).toMatchObject({ options: { priority: "normal" } });
    expect(() => post(7)).toThrow("InvalidInput: DataForSEO priority");
    expect(() =>
      catalog.match("dataforseo", {
        method: "POST",
        url: "https://api.dataforseo.com/v3/serp/google/organic/task_post",
        body: "not json",
      }),
    ).toThrow("InvalidInput: DataForSEO body must be an array with one task object");
  });

  test("a price row for every billable operation with explicit pricing dimensions", () => {
    const billable = dataforseo.descriptor.operations.filter((o) => o.billable);
    expect(billable).toHaveLength(13);
    for (const op of billable) {
      const estimate = catalog.estimate(connection, op.id, { priority: "normal", itemCount: "1" });
      expect(estimate.source).toBe("list");
      expect(estimate.quantities.map((q) => q.unit)).toEqual(["cents", "requests"]);
    }
  });

  test.each([
    ["dataforseo_labs/google/keyword_ideas", { itemCount: "100", clickstream: "true" }],
    ["dataforseo_labs/google/keyword_suggestions", { itemCount: "100", clickstream: "true" }],
    ["dataforseo_labs/google/related_keywords", { itemCount: "100", clickstream: "true" }],
    ["dataforseo_labs/google/relevant_pages", { itemCount: "100", clickstream: "true" }],
    ["dataforseo_labs/google/keyword_overview", { itemCount: "2", clickstream: "true" }],
    ["dataforseo_labs/google/historical_rank_overview", { clickstream: "true" }],
    ["backlinks/backlinks", { itemCount: "100" }],
    ["dataforseo_labs/google/ranked_keywords", { itemCount: "100", clickstream: "true" }],
    ["dataforseo_labs/google/domain_rank_overview", { itemCount: "100" }],
    ["backlinks/summary", { itemCount: "1" }],
    ["backlinks/history", {}],
  ])("request dimensions follow the price row for %s", (path, options) => {
    const matched = catalog.match("dataforseo", {
      method: "POST",
      url: `https://api.dataforseo.com/v3/${path}/live`,
      body: [
        Object.fromEntries(
          Object.entries({
            keywords: ["seed one", "seed two"],
            limit: 100,
            include_clickstream_data: true,
          }).filter(([field]) => {
            const op = dataforseo.descriptor.operations.find(
              (o) => o.id === `${path.replaceAll("/", ".")}.live`,
            )!;
            return (
              Object.hasOwn(op.requestPricing!.priceFields, field) ||
              op.requestPricing!.neutralFields.includes(field)
            );
          }),
        ),
      ],
    });
    if (matched.operation === "unknown") throw new Error("missing operation");
    expect(matched.options).toEqual(options);
    const keys = matched.operation.optionKeys ?? [];
    if (path === "backlinks/backlinks") expect(keys).toEqual(["itemCount"]);
    if (path === "backlinks/history") expect(keys).toEqual(["itemCount"]);
    if (path === "dataforseo_labs/google/keyword_ideas")
      expect(
        catalog.estimate(connection, matched.operation.id, matched.options).quantities[0],
      ).toEqual({
        unit: "cents",
        value: 48n,
        scale: 1,
      });
  });

  test("item_count cannot replace the documented limit default", () => {
    for (const [path, itemCount] of [
      ["dataforseo_labs/google/keyword_ideas", "700"],
      ["backlinks/backlinks", "100"],
    ]) {
      const matched = catalog.match("dataforseo", {
        method: "POST",
        url: `https://api.dataforseo.com/v3/${path}/live`,
        body: [{ item_count: 2 }],
      });
      if (matched.operation === "unknown") throw new Error("missing operation");
      expect(matched.options).toEqual({ itemCount, pricingUnknown: "true" });
    }
  });

  test("every catalog list price matches the recorded provider price list", () => {
    const fixture = loadFixtures(files).find((f) => f.operation === "appendix.user_data")!;
    const parsed = dataforseo.extractors.priceList!(fixture.response.body, "2026-09-25");
    const prices = (rows: typeof parsed) =>
      rows.map(({ operation, option, unit, perUnit }) => ({
        operation,
        ...(option ? { option } : {}),
        unit,
        perUnit,
      }));
    // Compare against the fixture's independent expected rows, including the Labs base charges.
    const recorded = fixture.expect.priceList!;
    expect(prices([...dataforseo.descriptor.prices])).toEqual(prices([...recorded.rows]));
    expect(prices(parsed)).toEqual(prices([...recorded.rows]));
    const strip = (rows: readonly { source: string }[]) =>
      rows.map(({ source: _, ...rest }) => rest);
    expect(strip(parsed)).toEqual(strip(dataforseo.descriptor.prices));
    expect(dataforseo.extractors.priceList!({}, "2026-09-25")).toEqual([]);
  });

  test("a transport-level failure is a failed receipt with its reported cost", () => {
    const failed = catalog.extract(
      "dataforseo",
      "serp.google.organic.live.advanced",
      { method: "POST", url: "https://api.dataforseo.com/v3/serp/google/organic/live/advanced" },
      { status: 401 },
      { status_code: 40100, status_message: "You are not authorized.", cost: 0, tasks: [] },
    );
    expect(failed).toMatchObject({ failed: true, cost: { certainty: "measured" } });
    expect(
      catalog.extract(
        "dataforseo",
        "serp.google.organic.live.advanced",
        { method: "POST", url: "https://api.dataforseo.com/v3/serp/google/organic/live/advanced" },
        { status: 502 },
        "Bad gateway",
      ),
    ).toMatchObject({ failed: true, cost: { certainty: "unknown", money: null } });
    expect(dataforseo.extractors.requestId(null)).toBeUndefined();
    expect(dataforseo.extractors.billingExport!({ tasks: [{ id: "x" }] })).toEqual([]);
    expect(dataforseo.extractors.balance!({})).toEqual({ plan: "prepaid" });
  });
});
