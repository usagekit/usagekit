import type {
  PriceCalculation,
  PriceRow,
  ProviderDescriptor,
  ProviderOperation,
} from "@usagekit/core";

import { requestPricing } from "./request-pricing.js";

const docs = "https://docs.dataforseo.com/v3/";
export const serpPricing = "https://dataforseo.com/pricing/serp/google-organic-serp-api";
export const labsPricing = "https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api";
export const backlinksPricing = "https://dataforseo.com/pricing/backlinks/backlinks";
const checked = "2026-09-25";

const live = (
  id: string,
  label: string,
  path: string,
  optionKeys?: readonly string[],
): ProviderOperation => ({
  id,
  label,
  billable: true,
  requestPricing: requestPricing[id]!,
  match: [{ method: "POST", path }],
  costEvidence: "response",
  ...(optionKeys ? { optionKeys } : {}),
});
const free = (
  id: string,
  label: string,
  method: "GET" | "POST",
  path: string,
): ProviderOperation => ({
  id,
  label,
  billable: false,
  match: [{ method, path }],
  costEvidence: "response",
});
const labs = [
  ["keyword_ideas", "Keyword ideas"],
  ["keyword_suggestions", "Keyword suggestions"],
  ["related_keywords", "Related keywords"],
  ["keyword_overview", "Keyword overview"],
  ["ranked_keywords", "Ranked keywords"],
  ["domain_rank_overview", "Domain rank overview"],
  ["historical_rank_overview", "Historical rank overview"],
  ["relevant_pages", "Relevant pages"],
] as const;
const backlinks = [
  ["summary", "Backlinks summary"],
  ["history", "Backlinks history"],
  ["backlinks", "Backlinks live"],
] as const;

const row = (
  operation: string,
  perUnit: string,
  source: string,
  option?: Record<string, string>,
  calculation?: PriceCalculation,
): PriceRow => ({
  validFrom: checked,
  operation,
  ...(option ? { option } : {}),
  unit: "cents",
  perUnit,
  ...(calculation ? { calculation } : {}),
  source,
  checkedAt: checked,
});

// Bill each SERP of up to 10 results at the full base: base * ceil(depth / 10).
// https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/
// https://docs.dataforseo.com/v3/serp/google/organic/task_post/
// The pricing page multiplies for each 10 results; the cost formula charges a full page 2.
// https://dataforseo.com/pricing/serp/google-organic-serp-api
// https://dataforseo.com/help-center/serp-api-cost-explained
// The conflicting 25% later-page discount can only lower the charge, so do not apply it.
// Unreturned results are refunded: full base per page is a conservative upper bound
// that never under-reserves; omitted depth still means one page.
// https://dataforseo.com/help-center/above-100-results-with-serp-api
const pages: PriceCalculation = {
  kind: "additional_pages",
  depthOption: "depth",
  pageSize: 10,
  additionalPageFactor: "1",
};
const items = (perItem: string, clickstream = true): PriceCalculation => ({
  kind: "base_plus_items",
  itemCountOption: "itemCount",
  perItem,
  ...(clickstream ? { multiplierOption: { key: "clickstream", value: "true", factor: "2" } } : {}),
});

/**
 * Provider A: cost per call in every response, prepaid money balance, basic auth. List prices
 * include request formulas in cents. Actual settlement continues to use response evidence.
 * Formulas preserve host characterization values; the existing check date is not refreshed.
 */
export const descriptor: ProviderDescriptor = {
  id: "dataforseo",
  label: "DataForSEO",
  upstream: "https://api.dataforseo.com",
  pricingInputs: ["body"],
  auth: { kind: "basic" },
  stripRequestHeaders: ["authorization"],
  billing: { unit: "cents", cycle: "prepaid" },
  plans: [{ id: "prepaid", label: "Prepaid balance", cycle: "prepaid", allowanceMode: "hard" }],
  prices: [
    row("serp.google.organic.live.advanced", "0.2", serpPricing, undefined, pages),
    row("serp.google.organic.task_post", "0.06", serpPricing, { priority: "normal" }, pages),
    row("serp.google.organic.task_post", "0.12", serpPricing, { priority: "high" }, pages),
    ...labs.map(([name]) =>
      row(
        `dataforseo_labs.google.${name}.live`,
        name === "historical_rank_overview" ? "12" : "1.2",
        labsPricing,
        undefined,
        // Per-request plus per-item, including ranked_keywords/domain_rank_overview.
        // https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api
        items(name === "historical_rank_overview" ? "0.12" : "0.012"),
      ),
    ),
    ...backlinks.map(([name]) =>
      row(
        `backlinks.${name}.live`,
        "2.4",
        backlinksPricing,
        undefined,
        // Every returned row is billed, including summary and history.
        // https://dataforseo.com/pricing/backlinks/backlinks
        items("0.0036", false),
      ),
    ),
  ],
  priceList: {
    kind: "endpoint",
    operation: "appendix.user_data",
    pointer: "/tasks/0/result/0/price",
    mapping: "provider-specific",
  },
  operations: [
    live(
      "serp.google.organic.live.advanced",
      "Google organic SERP, live advanced",
      "/v3/serp/google/organic/live/advanced",
      ["depth"],
    ),
    {
      id: "serp.google.organic.task_post",
      label: "Google organic SERP, task post",
      billable: true,
      match: [{ method: "POST", path: "/v3/serp/google/organic/task_post" }],
      optionKeys: ["priority", "depth"],
      costEvidence: "deferred",
      requestPricing: requestPricing["serp.google.organic.task_post"]!,
    },
    free(
      "serp.google.organic.tasks_ready",
      "Google organic SERP, tasks ready",
      "GET",
      "/v3/serp/google/organic/tasks_ready",
    ),
    free(
      "serp.google.organic.task_get.advanced",
      "Google organic SERP, task get advanced",
      "GET",
      "/v3/serp/google/organic/task_get/advanced/:id",
    ),
    ...labs.map(([name, label]) =>
      live(
        `dataforseo_labs.google.${name}.live`,
        label,
        `/v3/dataforseo_labs/google/${name}/live`,
        ["itemCount", "clickstream"],
      ),
    ),
    ...backlinks.map(([name, label]) =>
      live(`backlinks.${name}.live`, label, `/v3/backlinks/${name}/live`, ["itemCount"]),
    ),
    free(
      "appendix.user_data",
      "User data (balance, limits, prices)",
      "GET",
      "/v3/appendix/user_data",
    ),
    free("dataforseo_labs.status", "Labs status", "GET", "/v3/dataforseo_labs/status"),
  ],
  balance: {
    operation: "appendix.user_data",
    // money.balance is USD; the balance extractor converts it to cents. rates.limits.minute.total
    // is per minute; the extractor reports it per hour.
    fields: {
      remaining: "/tasks/0/result/0/money/balance",
      remainingUnit: "cents",
      accountIdentity: "/tasks/0/result/0/login",
      rateLimitPerHour: "/tasks/0/result/0/rates/limits/minute/total",
    },
  },
  billingExport: {
    kind: "task-history",
    operation: "serp.google.organic.task_get.advanced",
    granularity: "per-request",
    matchKey: "providerRequestId",
  },
  rateLimits: [{ scope: "account", perMinute: 2000 }],
  docs: { pricing: serpPricing, api: docs },
};
