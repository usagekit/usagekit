const historyOperations = new Set([
  "backlinks.history.live",
  "dataforseo_labs.google.historical_rank_overview.live",
]);

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Both history APIs return at most one item per month. Include partial boundary months.
 * https://docs.dataforseo.com/v3/backlinks-history-live/
 * https://docs.dataforseo.com/v3/dataforseo_labs-google-historical_rank_overview-live/
 */
export function historyWindowOptions(
  operation: string,
  task: Readonly<Record<string, unknown>>,
): Record<string, string> {
  if (!historyOperations.has(operation)) return {};
  const from = task.date_from;
  const to = task.date_to;
  const options: Record<string, string> = {};
  if (validDate(from)) options.dateFrom = from;
  else if (from !== undefined) options.pricingUnknown = "true";
  if (validDate(to)) options.dateTo = to;
  else if (to !== undefined) options.pricingUnknown = "true";
  if (!validDate(from) || !validDate(to)) return options;
  if (from > to) return { ...options, pricingUnknown: "true" };
  const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
  options.itemCount = String(monthIndex(to) - monthIndex(from) + 1);
  return options;
}
