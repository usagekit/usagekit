import { addMoney, addQuantity } from "@usagekit/core";
import type {
  Certainty,
  FundingSource,
  Quantity,
  Money,
  UsagePage,
  UsageQuery,
  UsageRow,
} from "@usagekit/core";
import { costAmount, measurementAmount, quantityAmount, weakest } from "./amount.js";
import type { Amount, Figure, Problem, ViewState } from "./amount.js";

/** Totals always start at the first page and use additive, ungrouped rows. */
export type UsageSummaryInput = Omit<UsageQuery, "groupBy" | "cursor"> & { maxPages?: number };
export type UsageFundingSummary = {
  key: string;
  fundingSource: FundingSource;
  costOwner: string;
  measurements: Readonly<Record<string, Figure>>;
  /** Upstream provider cost; a customer charge remains a separate measurement. */
  cost: Amount;
  unknownOperations: string;
};
export type UsageSummaryView = {
  state: ViewState;
  complete: boolean;
  measurements: Readonly<Record<string, Figure>>;
  cost: Figure;
  funding: readonly UsageFundingSummary[];
  unknownOperations: string | null;
  /** Aggregate rows, never a count of operations. */
  rowCount: number;
  pages: number;
  nextCursor: string | null;
  watermark: string | null;
  asOf: string | null;
  problem: Problem | null;
};
export type UsageSummary = UsageSummaryView;

export function unavailableSummary(
  units: readonly string[],
  state: "unavailable" | "forbidden" = "unavailable",
  problem: Problem | null = null,
): UsageSummaryView {
  return {
    state,
    complete: false,
    measurements: Object.fromEntries(units.map((unit) => [unit, "unavailable"])),
    cost: "unavailable",
    funding: [],
    unknownOperations: null,
    rowCount: 0,
    pages: 0,
    nextCursor: null,
    watermark: null,
    asOf: null,
    problem,
  };
}

function measurementTotal(rows: readonly UsageRow[], unit: string): Figure {
  const found = rows.map((row) => row.measurements.find((m) => m.unit === unit));
  if (found.some((m) => !m)) return "unavailable";
  if (found.some((m) => m?.certainty === "unknown"))
    return { text: "", unit, certainty: "unknown" };
  let total: Quantity = { unit, scale: 0, value: 0n };
  const certainties: Certainty[] = [];
  for (const m of found) {
    if (!m || m.certainty === "unknown") continue;
    total = addQuantity(total, m.quantity);
    certainties.push(m.certainty);
  }
  return quantityAmount(total, weakest(certainties));
}

function costTotal(rows: readonly UsageRow[]): Amount {
  if (rows.some((row) => row.cost.certainty === "unknown"))
    return costAmount({ certainty: "unknown", money: null });
  let money: Money = { units: 0n, currency: "USD" };
  const certainties: Certainty[] = [];
  for (const row of rows) {
    if (row.cost.certainty === "unknown") continue;
    money = addMoney(money, row.cost.money);
    certainties.push(row.cost.certainty);
  }
  const certainty = weakest(certainties);
  return certainty === "unknown"
    ? costAmount({ certainty, money: null })
    : costAmount({ certainty, money });
}

/**
 * Pure mapping of a sequence beginning with the first ungrouped usage page. An unfinished
 * sequence exposes its cursor, but no figures that could be mistaken for query totals.
 */
export function usageSummaryFromPages(
  pages: readonly UsagePage[],
  units: readonly string[],
): UsageSummaryView {
  const first = pages[0];
  if (!first) return unavailableSummary(units);
  const invalid = (reason: string) =>
    unavailableSummary(units, "unavailable", { kind: "invalid", field: "pagination", reason });
  if (!first.watermark || !Number.isFinite(Date.parse(first.asOf)))
    return invalid("missing snapshot watermark or timestamp");
  const rows: UsageRow[] = [];
  const keys = new Set<string>();
  const cursors = new Set<string>();
  for (const [index, page] of pages.entries()) {
    if (page.watermark !== first.watermark || page.asOf !== first.asOf)
      return invalid("snapshot changed between pages");
    if (index > 0 && !pages[index - 1]?.nextCursor) return invalid("page after end of snapshot");
    if (page.nextCursor !== undefined) {
      if (!page.nextCursor || cursors.has(page.nextCursor))
        return invalid("empty or repeated cursor");
      cursors.add(page.nextCursor);
    }
    for (const row of page.rows) {
      if (Object.keys(row.dimensions).length)
        return invalid("summary requires ungrouped, additive rows");
      if (row.measurements.some((m) => m.certainty !== "unknown" && m.quantity.unit !== m.unit))
        return invalid("measurement unit differs from its quantity");
      if (row.cost.certainty !== "unknown" && row.cost.money.currency !== "USD")
        return invalid("unsupported cost currency");
      if (typeof row.unknownOperations !== "bigint" || row.unknownOperations < 0n)
        return invalid("invalid unknown operation count");
      const key = JSON.stringify([row.fundingSource, row.costOwner]);
      if (keys.has(key)) return invalid("duplicate aggregate row");
      keys.add(key);
      rows.push(row);
    }
  }
  const nextCursor = pages.at(-1)?.nextCursor ?? null;
  if (nextCursor)
    return {
      ...unavailableSummary(units, "unavailable", {
        kind: "invalid",
        field: "maxPages",
        reason: "usage summary is incomplete",
      }),
      pages: pages.length,
      nextCursor,
      watermark: first.watermark,
      asOf: first.asOf,
    };
  const funding = rows.map(
    (row): UsageFundingSummary => ({
      key: JSON.stringify([row.fundingSource, row.costOwner]),
      fundingSource: row.fundingSource,
      costOwner: row.costOwner,
      measurements: Object.fromEntries(
        units.map((unit) => {
          const m = row.measurements.find((m) => m.unit === unit);
          return [unit, m ? measurementAmount(m) : "unavailable"];
        }),
      ),
      cost: costAmount(row.cost),
      unknownOperations: row.unknownOperations.toString(),
    }),
  );
  return {
    state: rows.length ? "ok" : "empty",
    complete: true,
    measurements: Object.fromEntries(units.map((unit) => [unit, measurementTotal(rows, unit)])),
    cost: costTotal(rows),
    funding,
    unknownOperations: rows.reduce((sum, row) => sum + row.unknownOperations, 0n).toString(),
    rowCount: rows.length,
    pages: pages.length,
    nextCursor: null,
    watermark: first.watermark,
    asOf: first.asOf,
    problem: null,
  };
}
