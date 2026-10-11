import { expect, test } from "vitest";
import { createCatalog, dataforseo } from "./index.js";
const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });
const path = "/v3/serp/google/organic/live/advanced";

// Documented fields that existing hosts send today must keep their depth price.
test.each([
  { location_name: "Poland" },
  { find_targets_in: ["featured_snippet"] },
  { stop_crawl_on_match: [{ match_type: "domain", match_value: "example.com" }] },
])("documented SERP fields keep the depth price: %j", (task) => {
  const matched = catalog.match("dataforseo", {
    method: "POST",
    url: path,
    body: [{ keyword: "example", depth: 100, search_param: "&nfpr=1", ...task }],
  });
  expect(matched).toMatchObject({ options: { depth: "100" } });
  if (matched.operation === "unknown") throw new Error("missing operation");
  expect(
    catalog.estimate(
      { id: "c", provider: "dataforseo", fundingSource: "byok" },
      matched.operation.id,
      matched.options,
    ).quantities,
  ).toContainEqual({ unit: "cents", value: 2n, scale: 0 });
});

test.each([
  [
    "/v3/dataforseo_labs/google/relevant_pages/live",
    { target: "example.com", offset: 5, order_by: ["metrics.organic.count,desc"] },
  ],
  [
    "/v3/backlinks/backlinks/live",
    {
      target: "example.com",
      backlinks_status_type: "live",
      exclude_internal_backlinks: true,
      rank_scale: "one_hundred",
      offset: 5,
      mode: "one_per_domain",
    },
  ],
])("existing host request to %s keeps its list price", (url, task) => {
  const matched = catalog.match("dataforseo", { method: "POST", url, body: [task] });
  if (matched.operation === "unknown") throw new Error("missing operation");
  expect(
    catalog.estimate(
      { id: "c", provider: "dataforseo", fundingSource: "byok" },
      matched.operation.id,
      matched.options,
    ),
  ).toMatchObject({
    source: "list",
    quantities: [
      {
        unit: "cents",
        value: url.includes("backlinks") ? 276n : 24n,
        scale: url.includes("backlinks") ? 2 : 1,
      },
      { unit: "requests", value: 1n, scale: 0 },
    ],
  });
});

// This field appears on summary, not on the backlinks rows endpoint:
// https://docs.dataforseo.com/v3/backlinks/backlinks/live/
test("undocumented include_indirect_links makes backlinks rows unknown", () => {
  const matched = catalog.match("dataforseo", {
    method: "POST",
    url: "/v3/backlinks/backlinks/live",
    body: [{ target: "example.com", include_indirect_links: true }],
  });
  if (matched.operation === "unknown") throw new Error("missing operation");
  expect(
    catalog.estimate(
      { id: "c", provider: "dataforseo", fundingSource: "byok" },
      matched.operation.id,
      matched.options,
    ),
  ).toEqual({ source: "unknown", quantities: [{ unit: "requests", value: 1n, scale: 0 }] });
});
