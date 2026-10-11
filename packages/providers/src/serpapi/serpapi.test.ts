import { describe, expect, test } from "vitest";
import { validateBudget } from "@usagekit/store";
import { createCatalog, serpapi } from "../index.js";
import { runDescriptorConformance } from "../testing/index.js";

const files = import.meta.glob("./fixtures/**/*.json", { eager: true, import: "default" });
runDescriptorConformance(serpapi.descriptor, serpapi.extractors, files);

describe("provider B (serpapi)", () => {
  const catalog = createCatalog({
    providers: [serpapi],
    enabled: ["serpapi"],
    now: () => new Date("2026-09-25T12:00:00.000Z"),
  });
  const units = (value: bigint) => ({ value, scale: 0, unit: "units" });

  test("query auth, monthly plans from the pricing page and extra credits as a prepaid plan", () => {
    const d = serpapi.descriptor;
    expect(d.auth).toEqual({ kind: "query", param: "api_key" });
    expect(d.billingExport.kind).toBe("none");
    expect(d.plans.map((p) => [p.id, p.allowance?.value ?? null, p.cycle])).toEqual([
      ["free", 250n, "monthly_plan"],
      ["starter", 1000n, "monthly_plan"],
      ["developer", 5000n, "monthly_plan"],
      ["production", 15000n, "monthly_plan"],
      ["bigdata", 30000n, "monthly_plan"],
      ["searcher", 100000n, "monthly_plan"],
      ["volume", 250000n, "monthly_plan"],
      ["infrastructure", 500000n, "monthly_plan"],
      ["extra_credits", null, "prepaid"],
    ]);
    expect(d.plans.every((p) => p.allowanceMode === "hard")).toBe(true);
    expect(d.prices.every((r) => r.source === "https://serpapi.com/pricing")).toBe(true);
    expect(d.prices.every((r) => r.checkedAt === "2026-09-25")).toBe(true);
  });

  test("a search costs one plan unit, past the allowance one extra credit, without a plan unknown", () => {
    const c = { id: "c1", provider: "serpapi", fundingSource: "byok" as const, plan: "developer" };
    expect(catalog.estimate(c, "search", {})).toEqual({
      quantities: [units(1n), { value: 1n, scale: 0, unit: "requests" }],
      source: "list",
      priceVersion: "serpapi:2026-09-25",
      checkedAt: "2026-09-25",
    });
    expect(catalog.estimate({ ...c, overage: true }, "search", {}).quantities[0]).toEqual(
      units(1n),
    );
    expect(
      catalog.estimate(
        { id: "c1", provider: "serpapi", fundingSource: "byok" as const },
        "search",
        {},
      ).source,
    ).toBe("unknown");
    expect(catalog.estimate(c, "account", {})).toEqual({ quantities: [], source: "list" });
  });

  test("both search paths match; account and locations are free", () => {
    for (const path of ["/search", "/search.json"])
      expect(
        catalog.match("serpapi", { method: "GET", url: `https://serpapi.com${path}?q=x` }),
      ).toMatchObject({ operation: { id: "search", billable: true } });
    expect(
      catalog.match("serpapi", { method: "GET", url: "https://serpapi.com/account?api_key=k" }),
    ).toMatchObject({ operation: { id: "account", billable: false } });
  });

  test("proposed budgets are valid for every plan and use the probe", () => {
    const probe = catalog.probe(serpapi.descriptor.id, {
      plan_id: "bigdata",
      plan_renewal_date: "2026-10-25",
      plan_searches_left: 5958,
      searches_per_month: 30000,
    });
    for (const plan of catalog.plansOf("serpapi")) {
      const b = catalog.proposeBudget("serpapi", plan.id, {
        namespace: "local",
        connection: "c1",
        probe,
        now: new Date("2026-09-25T12:00:00.000Z"),
      });
      expect(() => validateBudget(b)).not.toThrow();
      expect(b).toMatchObject({ unit: "units", onExceed: "block" });
    }
    expect(
      catalog.proposeBudget("serpapi", "bigdata", { namespace: "local", connection: "c1", probe }),
    ).toMatchObject({
      limit: units(30000n),
      window: { kind: "provider_cycle", endsAt: "2026-10-25T00:00:00.000Z" },
    });
    expect(
      catalog.proposeBudget("serpapi", "extra_credits", {
        namespace: "local",
        connection: "c1",
        probe,
      }),
    ).toMatchObject({ limit: units(5958n), window: { kind: "since_reset" } });
  });

  test("a response without search metadata has no request id", () => {
    expect(serpapi.extractors.requestId({ search_metadata: {} })).toBeUndefined();
    expect(serpapi.extractors.requestId("text")).toBeUndefined();
  });
});
