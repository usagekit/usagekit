import { addQuantity, compareQuantity } from "@usagekit/core";
import type { ProviderModule } from "./types.js";
import { expect, test } from "vitest";
import {
  createCatalog,
  dataforseo,
  serpapi,
  decimalQuantity,
  listEstimate,
  requestsMeasured,
} from "./index.js";
const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });
test("an item manual price replaces the coefficient and scales by keyword count", () => {
  const operation = "dataforseo_labs.google.keyword_overview.live";
  const connection = {
    id: "c1",
    provider: "dataforseo",
    fundingSource: "byok" as const,
    manualPrices: { [operation]: decimalQuantity("0.02", "cents") },
    manualPriceBasis: { [operation]: "item" as const },
  };
  expect(catalog.estimate(connection, operation, { itemCount: "3" })).toMatchObject({
    source: "manual",
    quantities: [decimalQuantity("1.26", "cents"), { unit: "requests", value: 1n, scale: 0 }],
  });
  const base = catalog.estimate(connection, operation, { itemCount: "0" }).quantities[0]!;
  expect(base).toEqual(decimalQuantity("1.2", "cents"));
  expect(base).toEqual(
    catalog.estimate(
      { id: "c1", provider: "dataforseo", fundingSource: "byok" as const },
      operation,
      { itemCount: "0" },
    ).quantities[0],
  );
  const manual = connection.manualPrices[operation];
  for (const [n, expected] of [
    [3, "0.06"],
    [1000, "20"],
  ] as const) {
    const estimate = catalog.estimate(connection, operation, { itemCount: String(n) })
      .quantities[0]!;
    const difference = addQuantity(estimate, { ...base, value: -base.value });
    expect(compareQuantity(difference, decimalQuantity(expected, "cents"))).toBe(0);
    expect(compareQuantity(difference, { ...manual, value: BigInt(n) * manual.value })).toBe(0);
  }
});

test.each([
  ["serp.google.organic.live.advanced", { depth: "100" }, "2"],
  ["serp.google.organic.live.advanced", { depth: "11" }, "0.4"],
  ["serp.google.organic.task_post", { depth: "100", priority: "normal" }, "0.6"],
  ["serp.google.organic.task_post", { depth: "100", priority: "high" }, "1.2"],
  ["dataforseo_labs.google.keyword_overview.live", { itemCount: "1000" }, "13.2"],
  ["dataforseo_labs.google.keyword_ideas.live", { itemCount: "100" }, "2.4"],
  [
    "dataforseo_labs.google.keyword_suggestions.live",
    { itemCount: "100", clickstream: "true" },
    "4.8",
  ],
  [
    "dataforseo_labs.google.related_keywords.live",
    { itemCount: "100", clickstream: "true" },
    "4.8",
  ],
  ["dataforseo_labs.google.ranked_keywords.live", { itemCount: "1000" }, "13.2"],
  ["dataforseo_labs.google.domain_rank_overview.live", { itemCount: "1000" }, "13.2"],
  ["dataforseo_labs.google.historical_rank_overview.live", { itemCount: "3" }, "12.36"],
  ["dataforseo_labs.google.relevant_pages.live", { itemCount: "100" }, "2.4"],
  ["backlinks.summary.live", { itemCount: "1" }, "2.4036"],
  ["backlinks.history.live", { itemCount: "3" }, "2.4108"],
  ["backlinks.backlinks.live", { itemCount: "100", clickstream: "true" }, "2.76"],
])("characterization: %s %j = %s cents", (operation, options, expected) => {
  expect(
    catalog.estimate(
      { id: "c", provider: "dataforseo", fundingSource: "byok" as const },
      operation,
      options,
    ).quantities[0],
  ).toEqual(decimalQuantity(expected, "cents"));
});

test.each([undefined, false, true])(
  "ranked keywords charge items with clickstream=%s",
  (include_clickstream_data) => {
    const match = catalog.match("dataforseo", {
      method: "POST",
      url: "/v3/dataforseo_labs/google/ranked_keywords/live",
      body: [
        {
          limit: 1000,
          ...(include_clickstream_data === undefined ? {} : { include_clickstream_data }),
        },
      ],
    });
    if (match.operation === "unknown") throw new Error("missing operation");
    expect(match.options).toEqual({
      itemCount: "1000",
      ...(include_clickstream_data === undefined
        ? {}
        : { clickstream: String(include_clickstream_data) }),
    });
    expect(
      catalog.estimate(
        { id: "c", provider: "dataforseo", fundingSource: "byok" },
        match.operation.id,
        match.options,
      ).quantities[0],
    ).toEqual(decimalQuantity(include_clickstream_data ? "26.4" : "13.2", "cents"));
  },
);

test("clickstream keeps its list floor for item and whole-call overrides", () => {
  const operation = "dataforseo_labs.google.keyword_ideas.live";
  const c = {
    id: "c",
    provider: "dataforseo",
    fundingSource: "byok" as const,
    measured: () => ({
      quantity: decimalQuantity("0.00015", "cents"),
      samples: 5,
      basis: "item" as const,
      checkedAt: "2026-09-20",
    }),
  };
  expect(catalog.estimate(c, operation, { itemCount: "100", clickstream: "true" })).toMatchObject({
    quantities: [decimalQuantity("4.8", "cents"), { unit: "requests" }],
    source: "measured",
    sampleSize: 5,
    checkedAt: "2026-09-20",
  });
  for (const basis of [undefined, "call"] as const) {
    const result = catalog.estimate(
      {
        ...c,
        manualPrices: { [operation]: decimalQuantity("0", "cents") },
        ...(basis ? { manualPriceBasis: { [operation]: basis } } : {}),
      },
      operation,
      { itemCount: "100", clickstream: "true" },
    );
    expect(result.quantities[0]).toEqual(decimalQuantity("4.8", "cents"));
    expect(result.source).toBe("manual");
  }
});

test("invalid formula options reject rather than inventing quantities", () => {
  for (const depth of ["0", "-1", "1.5", "NaN"])
    expect(() =>
      catalog.estimate(
        { id: "c", provider: "dataforseo", fundingSource: "byok" as const },
        "serp.google.organic.live.advanced",
        {
          depth,
        },
      ),
    ).toThrow("InvalidInput");
  expect(() =>
    catalog.estimate(
      { id: "c", provider: "dataforseo", fundingSource: "byok" as const },
      "dataforseo_labs.google.keyword_ideas.live",
      { itemCount: "2.5" },
    ),
  ).toThrow("InvalidInput");
});

test("extractor reads requested dimensions without replacing observed settlement evidence", () => {
  const request = {
    method: "POST",
    url: "/v3/dataforseo_labs/google/keyword_overview/live",
    body: [{ keywords: ["one", "two", "three"], include_clickstream_data: true }],
  };
  expect(catalog.match("dataforseo", request)).toMatchObject({
    options: { itemCount: "3", clickstream: "true" },
  });
  const receipt = catalog.extract(
    "dataforseo",
    "dataforseo_labs.google.keyword_overview.live",
    request,
    { status: 200 },
    { cost: 0.002 },
  );
  expect(receipt.cost).toEqual({ certainty: "measured", money: { currency: "USD", units: 2000n } });
});

test("manual money preserves SerpApi native searches and does not invent unknown usage", () => {
  const c = createCatalog({ providers: [serpapi], enabled: ["serpapi"] });
  const connection = {
    id: "s",
    provider: "serpapi",
    fundingSource: "byok" as const,
    plan: "production",
    manualPrices: { search: decimalQuantity("0", "cents") },
  };
  expect(c.estimate(connection, "search", {}).quantities).toEqual([
    decimalQuantity("0", "cents"),
    decimalQuantity("1", "units"),
    decimalQuantity("1", "requests"),
  ]);
  expect(
    c.estimate(
      {
        id: connection.id,
        provider: connection.provider,
        fundingSource: "byok" as const,
        manualPrices: connection.manualPrices,
      },
      "search",
      {},
    ).quantities,
  ).toEqual([decimalQuantity("0", "cents"), decimalQuantity("1", "requests")]);
  for (const manual of [undefined, connection.manualPrices])
    expect(
      c.estimate(
        {
          id: "s",
          provider: "serpapi",
          plan: "production",
          fundingSource: "platform",
          ...(manual ? { manualPrices: manual } : {}),
        },
        "search",
        {},
      ),
    ).toEqual({ source: "unknown", quantities: [decimalQuantity("1", "requests")] });
});

test("SerpApi structured subscription is separate from per-search settlement and amortization", () => {
  const production = serpapi.descriptor.plans.find((p) => p.id === "production")!;
  expect(production.subscription).toEqual({
    period: "month",
    fee: { currency: "USD", units: 150000000n },
    source: "https://serpapi.com/pricing",
    checkedAt: "2026-09-25",
  });
  expect(production.subscription!.fee.units / production.allowance!.value).toBe(10000n);
  expect(
    serpapi.descriptor.plans.filter((p) => p.subscription).map((p) => p.subscription!.fee.units),
  ).toEqual([
    0n,
    25000000n,
    75000000n,
    150000000n,
    275000000n,
    725000000n,
    1475000000n,
    2750000000n,
  ]);
  const receipt = serpapi.extractors.extract(
    serpapi.descriptor.operations[0]!,
    { method: "GET", url: "https://serpapi.com/search" },
    { status: 200 },
    {},
  );
  expect(receipt.cost).toEqual({ certainty: "estimated", money: { currency: "USD", units: 0n } });
});

// A host supplies this module beside its deterministic provider; it is never a default fallback.
const localSequence: ProviderModule = {
  descriptor: {
    id: "local-sequence",
    label: "Local sequence",
    upstream: "https://local.invalid",
    pricingInputs: [],
    auth: { kind: "bearer" },
    billing: { unit: "cents", cycle: "none" },
    plans: [],
    prices: [
      {
        validFrom: "2026-07-26",
        operation: "rank_check",
        unit: "cents",
        perUnit: "0",
        source: "https://example.com/local-provider",
        checkedAt: "2026-07-26",
      },
    ],
    priceList: { kind: "static" },
    operations: [
      {
        id: "rank_check",
        label: "Deterministic rank check",
        billable: true,
        match: [{ method: "POST", path: "/rank-check" }],
        costEvidence: "response",
      },
    ],
    billingExport: { kind: "none", granularity: "per-request", matchKey: "providerRequestId" },
    docs: {
      pricing: "https://example.com/local-provider",
      api: "https://example.com/local-provider",
    },
  },
  extractors: {
    estimate: listEstimate,
    options: () => ({}),
    requestId: () => undefined,
    extract: () => ({
      cost: { certainty: "measured", money: { currency: "USD", units: 0n } },
      measurements: [
        { unit: "cents", quantity: { unit: "cents", value: 0n, scale: 0 }, certainty: "measured" },
        requestsMeasured(),
      ],
      cached: false,
      failed: false,
    }),
  },
};
test("host-supplied local sequence is genuine zero only when explicitly enabled", () => {
  const enabled = createCatalog({
    providers: [dataforseo, serpapi, localSequence],
    enabled: ["dataforseo", "serpapi", "local-sequence"],
  });
  expect(
    enabled.estimate(
      { id: "local", provider: "local-sequence", fundingSource: "byok" as const },
      "rank_check",
      {},
    ),
  ).toMatchObject({
    source: "list",
    quantities: [decimalQuantity("0", "cents"), decimalQuantity("1", "requests")],
  });
  expect(
    enabled
      .providers()
      .filter((p) => p.id !== "local-sequence")
      .map((p) => p.id),
  ).toEqual(["dataforseo", "serpapi"]);
  expect(
    localSequence.extractors.extract(
      localSequence.descriptor.operations[0]!,
      { method: "POST", url: "/rank-check" },
      { status: 200 },
      {},
    ),
  ).toMatchObject({
    measurements: [
      { unit: "cents", quantity: decimalQuantity("0", "cents"), certainty: "measured" },
      { unit: "requests" },
    ],
    cost: { certainty: "measured", money: { units: 0n } },
  });
  for (const provider of ["unknown", "local-sequence"]) {
    const disabled = createCatalog({ providers: [localSequence], enabled: [] });
    expect(
      disabled.estimate({ id: "local", provider, fundingSource: "byok" }, "rank_check", {}).source,
    ).toBe("unknown");
  }
});
