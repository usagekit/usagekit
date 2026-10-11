import { expect, test } from "vitest";
import { formatQuantity } from "@usagekit/core";
import { createCatalog, dataforseo } from "./index.js";

const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });
const connection = { id: "history", provider: "dataforseo", fundingSource: "byok" as const };
function quote(path: string, task: Record<string, unknown>) {
  const matched = catalog.match("dataforseo", {
    method: "POST",
    url: `/v3/${path}/live`,
    body: [{ target: "example.com", ...task }],
  });
  if (matched.operation === "unknown") throw new Error("Missing history operation");
  return { matched, quote: catalog.estimate(connection, matched.operation.id, matched.options) };
}

test.each([
  ["backlinks/history", "2025-10-01", "2026-09-30", "12", "2.4432"],
  ["dataforseo_labs/google/historical_rank_overview", "2026-01-01", "2026-06-30", "6", "12.72"],
  ["backlinks/history", "2024-02-29", "2024-02-29", "1", "2.4036"],
  ["backlinks/history", "2023-12-31", "2024-01-01", "2", "2.4072"],
])("%s bounds monthly rows from %s through %s", (path, from, to, count, cents) => {
  const result = quote(path, { date_from: from, date_to: to });
  expect(result.matched.options).toMatchObject({ itemCount: count, dateFrom: from, dateTo: to });
  expect(result.quote.source).toBe("list");
  expect(result.quote.quantities.filter((q) => q.unit === "cents").map(formatQuantity)).toEqual([
    cents,
  ]);
});

test("history clickstream applies to the complete bounded request", () => {
  const result = quote("dataforseo_labs/google/historical_rank_overview", {
    date_from: "2026-01-01",
    date_to: "2026-06-30",
    include_clickstream_data: true,
  });
  expect(result.quote.quantities.filter((q) => q.unit === "cents").map(formatQuantity)).toEqual([
    "25.44",
  ]);
});

test.each([
  {},
  { date_from: "2026-01-01" },
  { date_to: "2026-06-30" },
  { date_from: "2026-02-30", date_to: "2026-06-30" },
  { date_from: "2026-06-30", date_to: "2026-01-01" },
  { date_from: "2026-01-01T00:00:00Z", date_to: "2026-06-30" },
])("unbounded or invalid history dates remain unpriced: %j", (task) => {
  for (const path of ["backlinks/history", "dataforseo_labs/google/historical_rank_overview"]) {
    expect(quote(path, task).quote.source).toBe("unknown");
  }
});

test("equal month counts in different windows retain distinct pricing identities", () => {
  const first = quote("backlinks/history", { date_from: "2025-01-01", date_to: "2025-12-31" });
  const second = quote("backlinks/history", { date_from: "2026-01-01", date_to: "2026-12-31" });
  expect(first.matched.options.itemCount).toBe(second.matched.options.itemCount);
  expect(first.matched.options).not.toEqual(second.matched.options);
});
