import { describe, expect, test } from "vitest";
import { validateDescriptor } from "./index.js";
import type { DescriptorProblem, PriceCalculation, ProviderDescriptor } from "./index.js";

const descriptor = (overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor => ({
  id: "example",
  label: "Example",
  upstream: "https://api.example.com",
  pricingInputs: [],
  auth: { kind: "bearer" },
  billing: { unit: "cents", cycle: "monthly_plan" },
  plans: [
    { id: "basic", label: "Basic", cycle: "monthly_plan", allowanceMode: "hard" },
    { id: "pro", label: "Pro", cycle: "monthly_plan", allowanceMode: "soft" },
  ],
  prices: [
    {
      validFrom: "2026-09-01",
      operation: "search",
      plan: "basic",
      option: { priority: "high" },
      unit: "cents",
      perUnit: "0.1500",
      source: "https://example.com/pricing",
      checkedAt: "2026-09-25",
    },
  ],
  priceList: { kind: "static" },
  operations: [
    {
      id: "search",
      label: "Search",
      billable: true,
      match: [{ method: "GET", path: "/search" }],
      optionKeys: ["priority"],
      costEvidence: "response",
    },
    {
      id: "account",
      label: "Account",
      billable: false,
      match: [{ method: "GET", path: "/account" }],
      costEvidence: "none",
    },
  ],
  balance: { operation: "account", fields: { remaining: "/left", remainingUnit: "units" } },
  billingExport: { kind: "none", granularity: "per-request", matchKey: "providerRequestId" },
  docs: { pricing: "https://example.com/pricing", api: "https://example.com/docs" },
  ...overrides,
});
const kinds = (problems: readonly DescriptorProblem[]) => problems.map((p) => p.kind);

describe("validateDescriptor", () => {
  test("a consistent descriptor has no problems", () => {
    expect(validateDescriptor(descriptor())).toEqual([]);
  });

  test("duplicate operation ids", () => {
    const d = descriptor();
    expect(validateDescriptor({ ...d, operations: [...d.operations, d.operations[0]!] })).toEqual([
      { kind: "duplicate_operation", operation: "search" },
    ]);
  });

  test("duplicate plan ids", () => {
    const d = descriptor();
    expect(validateDescriptor({ ...d, plans: [...d.plans, d.plans[1]!] })).toEqual([
      { kind: "duplicate_plan", plan: "pro" },
    ]);
  });

  test("price rows naming an unknown operation or plan", () => {
    const d = descriptor(),
      row = d.prices[0]!;
    expect(
      validateDescriptor({
        ...d,
        prices: [row, { ...row, operation: "missing" }, { ...row, plan: "gold" }],
      }),
    ).toEqual([
      { kind: "unknown_price_operation", row: 1, operation: "missing" },
      { kind: "unknown_price_plan", row: 2, plan: "gold" },
    ]);
  });

  test("price rows with an option key the operation does not declare", () => {
    const d = descriptor(),
      row = d.prices[0]!;
    expect(
      validateDescriptor({ ...d, prices: [{ ...row, option: { device: "mobile" } }] }),
    ).toEqual([{ kind: "unknown_price_option", row: 0, option: "device" }]);
  });

  test.each([
    ["perUnit", { perUnit: "0,15" }],
    ["perUnit", { perUnit: "-1" }],
    ["validFrom", { validFrom: "September" }],
    ["checkedAt", { checkedAt: "" }],
    ["source", { source: "" }],
  ] as const)("price rows with an invalid %s", (field, change) => {
    const d = descriptor();
    expect(validateDescriptor({ ...d, prices: [{ ...d.prices[0]!, ...change }] })).toEqual([
      { kind: "invalid_price", row: 0, field },
    ]);
  });

  test("a probe referencing a billable operation", () => {
    expect(
      validateDescriptor(descriptor({ balance: { operation: "search", fields: {} } })),
    ).toEqual([{ kind: "billable_probe", operation: "search" }]);
  });

  test("a probe, price list or billing export referencing an unknown operation", () => {
    expect(
      kinds(
        validateDescriptor(
          descriptor({
            balance: { operation: "nope", fields: {} },
            priceList: {
              kind: "endpoint",
              operation: "gone",
              pointer: "/price",
              mapping: "provider-specific",
            },
            billingExport: {
              kind: "task-history",
              operation: "absent",
              granularity: "per-request",
              matchKey: "providerRequestId",
            },
          }),
        ),
      ),
    ).toEqual([
      "unknown_probe_operation",
      "unknown_price_list_operation",
      "unknown_export_operation",
    ]);
  });

  test("an advertised operation without match", () => {
    const d = descriptor();
    expect(
      validateDescriptor({
        ...d,
        operations: [{ ...d.operations[0]!, match: [] }, d.operations[1]!],
      }),
    ).toEqual([{ kind: "missing_match", operation: "search" }]);
  });

  test("problems accumulate in a stable order", () => {
    const d = descriptor();
    expect(
      kinds(
        validateDescriptor({
          ...d,
          operations: [d.operations[0]!, d.operations[0]!, { ...d.operations[1]!, match: [] }],
          prices: [{ ...d.prices[0]!, operation: "missing" }],
        }),
      ),
    ).toEqual(["duplicate_operation", "missing_match", "unknown_price_operation"]);
  });
});

test("formula metadata validates declared options and exact nonnegative coefficients", () => {
  const d = descriptor(),
    row = d.prices[0]!;
  expect(
    validateDescriptor({
      ...d,
      prices: [
        {
          ...row,
          calculation: {
            kind: "additional_pages",
            depthOption: "depth",
            pageSize: 0,
            additionalPageFactor: "-0.75",
          },
        },
      ],
    }),
  ).toEqual([
    { kind: "unknown_price_option", row: 0, option: "depth" },
    { kind: "invalid_calculation", row: 0, field: "pageSize" },
    { kind: "invalid_calculation", row: 0, field: "additionalPageFactor" },
  ]);
  expect(
    validateDescriptor({
      ...d,
      prices: [
        {
          ...row,
          calculation: {
            kind: "base_plus_items",
            itemCountOption: "priority",
            perItem: "0.00015",
            multiplierOption: { key: "priority", value: "high", factor: "2" },
          },
        },
      ],
    }),
  ).toEqual([]);
  expect(
    validateDescriptor({
      ...d,
      prices: [
        {
          ...row,
          calculation: {
            kind: "base_plus_items",
            itemCountOption: "missing",
            perItem: "1e-3",
            multiplierOption: { key: "priority", value: "high", factor: "-2" },
          },
        },
      ],
    }),
  ).toEqual([
    { kind: "unknown_price_option", row: 0, option: "missing" },
    { kind: "invalid_calculation", row: 0, field: "perItem" },
    { kind: "invalid_calculation", row: 0, field: "multiplierOption" },
  ]);
});

test("structured subscriptions validate money and provenance, including genuine zero", () => {
  const d = descriptor(),
    plan = d.plans[0]!;
  expect(
    validateDescriptor({
      ...d,
      plans: [
        {
          ...plan,
          subscription: {
            period: "month",
            fee: { units: 0n, currency: "USD" },
            source: "https://example.com/pricing",
            checkedAt: "2026-09-25",
          },
        },
      ],
    }),
  ).toEqual([]);
  expect(
    validateDescriptor({
      ...d,
      plans: [
        {
          ...plan,
          subscription: {
            period: "month",
            fee: { units: -1n, currency: "USD" },
            source: "",
            checkedAt: "invalid",
          },
        },
      ],
    }),
  ).toEqual([
    { kind: "invalid_subscription", plan: "basic", field: "fee" },
    { kind: "invalid_subscription", plan: "basic", field: "source" },
    { kind: "invalid_subscription", plan: "basic", field: "checkedAt" },
  ]);
});

test("request option multipliers validate declared options and nonnegative factors", () => {
  const d = descriptor();
  const validate = (key: string, value: string, factor: string) =>
    validateDescriptor({
      ...d,
      prices: [
        {
          ...d.prices[0]!,
          calculation: {
            kind: "option_multiplier",
            multiplierOption: { key, value, factor },
          },
        },
      ],
    });
  expect.soft(validate("priority", "high", "2")).toEqual([]);
  expect.soft(validate("priority", "high", "0")).toEqual([]);
  expect
    .soft(validate("missing", "high", "2"))
    .toEqual([{ kind: "unknown_price_option", row: 0, option: "missing" }]);
  for (const factor of ["-2", "1e-3", "NaN"])
    expect
      .soft(validate("priority", "high", factor))
      .toEqual([{ kind: "invalid_calculation", row: 0, field: "multiplierOption" }]);
  expect
    .soft(validate("priority", " ", "2"))
    .toEqual([{ kind: "invalid_calculation", row: 0, field: "multiplierOption" }]);
  expect(
    validateDescriptor({
      ...d,
      prices: [
        {
          ...d.prices[0]!,
          calculation: { kind: "option_multiplier" } as PriceCalculation,
        },
      ],
    }),
  ).toEqual([{ kind: "invalid_calculation", row: 0, field: "multiplierOption" }]);
});

test.each([undefined, null, ["headers"], ["body", "body"]])(
  "descriptor rejects invalid pricing input declarations: %j",
  (pricingInputs) => {
    const invalid = { ...descriptor(), pricingInputs } as unknown as ProviderDescriptor;
    expect(validateDescriptor(invalid)).toContainEqual({ kind: "invalid_pricing_inputs" });
  },
);

test("query constraints require declared query pricing input", () => {
  const d = descriptor();
  d.operations[0]!.match = [{ method: "GET", path: "/search", query: { engine: "images" } }];
  expect(validateDescriptor(d)).toEqual([{ kind: "undeclared_query_input", operation: "search" }]);
  expect(validateDescriptor({ ...d, pricingInputs: ["query"] })).toEqual([]);
});

test.each([1, true, {}])(
  "invalid pricing input declaration is reported without throwing: %j",
  (pricingInputs) => {
    expect(
      validateDescriptor({ ...descriptor(), pricingInputs } as unknown as ProviderDescriptor),
    ).toContainEqual({ kind: "invalid_pricing_inputs" });
  },
);
