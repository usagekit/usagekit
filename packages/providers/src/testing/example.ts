import type { ProviderDescriptor } from "@usagekit/core";
import type { Extractors, ProviderModule } from "../types.js";
import { listEstimate } from "../prices.js";
import { moneyFromCents, requestsMeasured } from "../receipts.js";

const source = "https://example.com/pricing";
/**
 * A synthetic descriptor that exercises every catalog rule: a base path, match precedence, plan
 * and option axes, an overage row, a free probe. It is the template for new descriptors and is
 * never enabled by hosts.
 */
export const exampleDescriptor: ProviderDescriptor = {
  id: "example",
  label: "Example provider",
  pricingInputs: ["query"],
  upstream: "https://api.example.com/v1",
  auth: { kind: "header", name: "X-Api-Key" },
  billing: { unit: "units", cycle: "monthly_plan" },
  plans: [
    {
      id: "basic",
      label: "Basic",
      cycle: "monthly_plan",
      allowance: { unit: "units", value: 1000n },
      allowanceMode: "hard",
    },
    {
      id: "pro",
      label: "Pro",
      cycle: "monthly_plan",
      allowance: { unit: "units", value: 5000n },
      allowanceMode: "soft",
    },
    { id: "credits", label: "Credits", cycle: "prepaid", allowanceMode: "hard" },
  ],
  prices: [
    { validFrom: "2026-01-01", operation: "search", plan: "basic", unit: "units", perUnit: "1" },
    {
      validFrom: "2026-01-01",
      operation: "search",
      plan: "basic",
      option: { priority: "high" },
      unit: "units",
      perUnit: "2",
    },
    { validFrom: "2026-01-01", operation: "search", plan: "pro", unit: "units", perUnit: "1" },
    {
      validFrom: "2026-01-01",
      operation: "search",
      plan: "pro",
      overage: true,
      unit: "cents",
      perUnit: "0.5000",
    },
    { validFrom: "2026-01-01", operation: "search", plan: "credits", unit: "units", perUnit: "1" },
    { validFrom: "2026-01-01", operation: "search.images", unit: "cents", perUnit: "0.30" },
    { validFrom: "2026-10-01", operation: "search.images", unit: "cents", perUnit: "0.40" },
    { validFrom: "2026-01-01", operation: "items.get", unit: "cents", perUnit: "0.1" },
    { validFrom: "2026-01-01", operation: "items.special", unit: "cents", perUnit: "0.2" },
  ].map((row) => ({ ...row, source, checkedAt: "2026-09-25" }) as ProviderDescriptor["prices"][0]),
  priceList: { kind: "static" },
  operations: [
    {
      id: "search",
      label: "Web search",
      billable: true,
      match: [{ method: "GET", path: "/search" }],
      optionKeys: ["priority"],
      costEvidence: "response",
    },
    {
      id: "search.images",
      label: "Image search",
      billable: true,
      match: [{ method: "GET", path: "/search", query: { engine: "images" } }],
      costEvidence: "response",
    },
    {
      id: "items.get",
      label: "Item",
      billable: true,
      match: [{ method: "GET", path: "/items/:id" }],
      costEvidence: "response",
    },
    {
      id: "items.special",
      label: "Special item",
      billable: true,
      match: [{ method: "GET", path: "/items/special" }],
      costEvidence: "response",
    },
    {
      id: "files",
      label: "Files",
      billable: true,
      match: [{ method: "ANY", path: "/files/*" }],
      costEvidence: "none",
    },
    {
      id: "account",
      label: "Account",
      billable: false,
      match: [{ method: "GET", path: "/account" }],
      costEvidence: "none",
    },
  ],
  balance: {
    operation: "account",
    fields: {
      remaining: "/searches_left",
      remainingUnit: "units",
      allowance: "/searches_per_month",
      used: "/used",
      resetsAt: "/renews_on",
      plan: "/plan",
      accountIdentity: "/email",
      rateLimitPerHour: "/hourly_limit",
    },
  },
  billingExport: { kind: "none", granularity: "per-request", matchKey: "providerRequestId" },
  docs: { pricing: source, api: "https://example.com/docs" },
};

export const exampleExtractors: Extractors = {
  estimate: listEstimate,
  options: (operation, request) => {
    const priority = new URL(request.url).searchParams.get("priority");
    return operation.optionKeys?.includes("priority") && priority ? { priority } : {};
  },
  extract: (_operation, _request, response, body) => {
    const b = (body ?? {}) as { id?: string; cost_cents?: string };
    const id = typeof b.id === "string" ? b.id : undefined;
    return {
      measurements: [requestsMeasured()],
      cost:
        typeof b.cost_cents === "string"
          ? { certainty: "measured", money: moneyFromCents(b.cost_cents) }
          : { certainty: "unknown", money: null },
      ...(id ? { providerRequestId: id } : {}),
      cached: false,
      failed: response.status >= 400,
    };
  },
  requestId: (body) => {
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
  },
};

export const exampleProvider: ProviderModule = {
  descriptor: exampleDescriptor,
  extractors: exampleExtractors,
};
