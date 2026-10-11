import type { PriceRow, ProviderDescriptor, ProviderPlan } from "@usagekit/core";

export const pricing = "https://serpapi.com/pricing";
const checked = "2026-09-25";
const monthly: readonly [id: string, label: string, searches: bigint, feeCents: bigint][] = [
  ["free", "Free (250 searches per month)", 250n, 0n],
  ["starter", "Starter (25 USD, 1,000 searches per month)", 1000n, 2500n],
  ["developer", "Developer (75 USD, 5,000 searches per month)", 5000n, 7500n],
  ["production", "Production (150 USD, 15,000 searches per month)", 15000n, 15000n],
  ["bigdata", "Big Data (275 USD, 30,000 searches per month)", 30000n, 27500n],
  ["searcher", "Searcher (725 USD, 100,000 searches per month)", 100000n, 72500n],
  ["volume", "Volume (1,475 USD, 250,000 searches per month)", 250000n, 147500n],
  ["infrastructure", "Infrastructure (2,750 USD, 500,000 searches per month)", 500000n, 275000n],
];
const row = (extra: Partial<PriceRow>): PriceRow => ({
  validFrom: checked,
  operation: "search",
  unit: "units",
  perUnit: "1",
  source: pricing,
  checkedAt: checked,
  ...extra,
});

/**
 * Provider B: no per-call cost, monthly plans with a search allowance, query-parameter auth.
 * A search costs one plan unit; past the allowance it draws one extra credit. Cloud and
 * enterprise tiers are left to manual prices on the connection.
 */
export const descriptor: ProviderDescriptor = {
  id: "serpapi",
  label: "SerpApi",
  upstream: "https://serpapi.com",
  pricingInputs: [],
  auth: { kind: "query", param: "api_key" },
  billing: { unit: "units", cycle: "monthly_plan" },
  plans: [
    ...monthly.map(
      ([id, label, searches, feeCents]): ProviderPlan => ({
        id,
        label,
        cycle: "monthly_plan",
        allowance: { unit: "units", value: searches },
        allowanceMode: "hard",
        subscription: {
          period: "month",
          fee: { currency: "USD", units: feeCents * 10000n },
          source: pricing,
          checkedAt: checked,
        },
      }),
    ),
    { id: "extra_credits", label: "Extra credits", cycle: "prepaid", allowanceMode: "hard" },
  ],
  prices: [
    ...monthly.map(([plan]) => row({ plan })),
    row({ plan: "extra_credits" }),
    row({ overage: true }),
  ],
  priceList: { kind: "static" },
  operations: [
    {
      id: "search",
      label: "Search",
      billable: true,
      match: [
        { method: "GET", path: "/search" },
        { method: "GET", path: "/search.json" },
      ],
      costEvidence: "none",
      cacheable: {
        keyParams: ["engine", "q", "location", "hl", "gl", "device"],
        defaultTtlMs: 3600000,
      },
    },
    {
      id: "account",
      label: "Account",
      billable: false,
      match: [
        { method: "GET", path: "/account" },
        { method: "GET", path: "/account.json" },
      ],
      costEvidence: "none",
    },
    {
      id: "locations",
      label: "Locations",
      billable: false,
      match: [{ method: "GET", path: "/locations.json" }],
      costEvidence: "none",
    },
  ],
  balance: {
    operation: "account",
    fields: {
      remaining: "/plan_searches_left",
      remainingUnit: "units",
      allowance: "/searches_per_month",
      used: "/this_month_usage",
      resetsAt: "/plan_renewal_date",
      plan: "/plan_id",
      accountIdentity: "/account_email",
      rateLimitPerHour: "/account_rate_limit_per_hour",
    },
  },
  billingExport: { kind: "none", granularity: "per-day", matchKey: "window" },
  docs: { pricing, api: "https://serpapi.com/search-api" },
};
