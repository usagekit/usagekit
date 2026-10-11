import fc from "fast-check";
import type { Budget, ConnectionPolicy, Quantity } from "@usagekit/core";
import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createCatalog, dataforseo } from "@usagekit/providers";

// Proxy-local test transcription of the 2026-10-11 evidence table. Keep test support
// within its workspace; never derive the oracle from production pricing metadata.
// Independent test transcription: do not derive
// expected prices, defaults, fields or operators from the production descriptor.
// https://dataforseo.com/pricing/serp/google-organic-serp-api
// https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api
// https://dataforseo.com/pricing/backlinks/backlinks
export const operations = [
  "serp.google.organic.live.advanced",
  "serp.google.organic.task_post",
  "dataforseo_labs.google.keyword_ideas.live",
  "dataforseo_labs.google.keyword_suggestions.live",
  "dataforseo_labs.google.related_keywords.live",
  "dataforseo_labs.google.keyword_overview.live",
  "dataforseo_labs.google.ranked_keywords.live",
  "dataforseo_labs.google.domain_rank_overview.live",
  "dataforseo_labs.google.historical_rank_overview.live",
  "dataforseo_labs.google.relevant_pages.live",
  "backlinks.backlinks.live",
  "backlinks.summary.live",
  "backlinks.history.live",
] as const;
export type Task = Record<string, unknown>;
export const runs = { numRuns: 100, seed: 901031 };
export const mediaType = fc
  .tuple(
    fc.constantFrom("application/json", "application/problem+json", "application/vnd.test+json"),
    fc.array(fc.boolean(), { minLength: 32, maxLength: 32 }),
    fc.constantFrom("", "; charset=utf-8", '; Charset="UTF-8"; profile="test"'),
  )
  .map(
    ([type, uppercase, parameters]) =>
      [...type].map((char, i) => (uppercase[i] ? char.toUpperCase() : char)).join("") + parameters,
  );
export const unknownKey = fc.oneof(
  fc.constantFrom("Depth", "LIMIT", "ｄｅｐｔｈ", "dеpth", "__proto__", "constructor"),
  fc.string({ minLength: 1, maxLength: 24 }).map((key) => `future_${key}`),
);

const operators = [
  "allinanchor:",
  "allintext:",
  "allintitle:",
  "allinurl:",
  "cache:",
  "define:",
  "definition:",
  "filetype:",
  "id:",
  "inanchor:",
  "info:",
  "intext:",
  "intitle:",
  "inurl:",
  "link:",
  "site:",
];
const fullWidth = (value: string) =>
  value.replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0));
const keyword = fc
  .tuple(
    fc.array(fc.constantFrom(...operators), { maxLength: 3 }),
    fc.constantFrom("", "android: ", "-site:free "),
    fc.integer({ min: 0, max: 5 }),
    fc.integer({ min: 0, max: 3 }),
  )
  .map(([ops, prefix, style, escapes]) => {
    const plain = `${prefix}${ops.map((op) => `${op}example`).join(" ")} shoes`;
    const count = operators.filter((op) => plain.replaceAll("-site:", "").includes(op)).length;
    let value = plain;
    if (style === 1) value = value.toUpperCase();
    if (style === 2) value = fullWidth(value);
    if (style === 3) value = value.replace(/[a-z]/g, (char) => `${char}\u00ad`);
    if (style === 4) value = value.replace(/[a-z]/g, (char) => `${char}\u0307`);
    if (style === 5) value = value.replaceAll("i", "İ");
    for (let i = 0; i < escapes; i++) value = encodeURIComponent(value);
    return { value, count };
  });

export function taskVariant(operation: string) {
  const generated = fc
    .record({
      keyword,
      depth: fc.oneof(
        fc.constantFrom(1, 10, 11, 100, 200),
        fc.integer({ min: 1, max: operation.endsWith("task_post") ? 700 : 200 }),
      ),
      pages: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
      count: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
      priority: fc.constantFrom(1, 2),
      rectangles: fc.boolean(),
      overview: fc.boolean(),
      clicks: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
      clickstream: fc.boolean(),
      seed: fc.boolean(),
      token: fc.boolean(),
      searchOperators: fc.boolean(),
    })
    .map((v) => {
      let task: Task;
      if (operation.startsWith("serp.")) {
        task = {
          keyword: v.keyword.value,
          depth: v.depth,
          search_param: v.searchOperators ? `&q=${encodeURIComponent(v.keyword.value)}` : "&nfpr=1",
          stop_crawl_on_match: [{ match_type: "domain", match_value: "example.com" }],
          calculate_rectangles: v.rectangles,
          load_async_ai_overview: v.overview,
          ...(v.pages === undefined ? {} : { max_crawl_pages: v.pages }),
          ...(v.clicks === undefined ? {} : { people_also_ask_click_depth: v.clicks }),
          ...(operation.endsWith("task_post") ? { priority: v.priority } : {}),
        };
      } else {
        task =
          operation.includes("keyword_overview") || operation.includes("keyword_ideas")
            ? { keywords: Array.from({ length: v.count ?? 3 }, (_, i) => `shoes ${i}`) }
            : operation.includes("keyword_suggestions") || operation.includes("related_keywords")
              ? { keyword: v.keyword.value }
              : { target: "example.com" };
        if (
          !operation.includes("historical_rank") &&
          !operation.includes(".history.") &&
          !operation.includes(".summary.") &&
          !operation.includes("keyword_overview") &&
          v.count !== undefined
        )
          task.limit = v.count;
        if (operation.startsWith("dataforseo_labs.") && !operation.includes("domain_rank_overview"))
          task.include_clickstream_data = v.clickstream;
        if (operation.includes("keyword_suggestions") || operation.includes("related_keywords"))
          task.include_seed_keyword = v.seed;
        if (
          (operation.includes("keyword_suggestions") || operation.includes("keyword_ideas")) &&
          v.token
        )
          task.offset_token = "previous-task";
      }
      return { task, operatorCount: v.keyword.count };
    });
  const plain: Task = operation.startsWith("serp.")
    ? { keyword: "50% off shoes", depth: 100, search_param: "&nfpr=1", stop_crawl_on_match: [] }
    : operation.includes("keyword_overview") || operation.includes("keyword_ideas")
      ? { keywords: ["shoes"] }
      : operation.includes("keyword_suggestions") || operation.includes("related_keywords")
        ? { keyword: "shoes" }
        : { target: "example.com" };
  return fc.oneof(generated, fc.constant({ task: plain, operatorCount: 0 }));
}

/** Exact ten-thousandths of a cent; null means the evidence cannot bound this request.
 * Reserve all pages at full price and scale add-ons before applying all multipliers:
 * the conflicting discount/add-on descriptions can only reduce this bound.
 * https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/
 * https://docs.dataforseo.com/v3/serp/google/organic/task_post/
 * https://dataforseo.com/help-center/serp-api-cost-explained
 */
export function worstCase(operation: string, task: Task, operatorCount = 0): bigint | null {
  if (task.include_seed_keyword === true || task.offset_token !== undefined) return null;
  if (operation.startsWith("serp.")) {
    const base = operation.endsWith("task_post") ? (task.priority === 2 ? 1200n : 600n) : 2000n;
    const pages = Math.max(
      Math.ceil(Number(task.depth ?? 10) / 10),
      Number(task.max_crawl_pages ?? 1),
    );
    return (
      BigInt(pages) *
      (base *
        BigInt(
          1 +
            Number(task.calculate_rectangles === true) +
            Number(task.load_async_ai_overview === true),
        ) +
        150n * BigInt(Number(task.people_also_ask_click_depth ?? 0))) *
      5n ** BigInt(operatorCount)
    );
  }
  if (operation.includes("historical_rank") || operation.includes(".history.")) return null;
  const count = operation.includes("keyword_overview")
    ? (task.keywords as string[]).length
    : operation.includes(".summary.")
      ? 1
      : Number(task.limit ?? (operation.includes("keyword_ideas") ? 700 : 100));
  if (operation.startsWith("backlinks.")) return 24000n + 36n * BigInt(count);
  return (12000n + 120n * BigInt(count)) * (task.include_clickstream_data === true ? 2n : 1n);
}

// Duplicates are deliberately written into raw JSON, including escaped spellings of
// the SAME key. The last value must be the value priced AND sent upstream.
export function wireBody(task: Task, duplicate: boolean, whitespace: string): string {
  const entries = Object.entries(task);
  const pricedKey = ["depth", "limit", "include_clickstream_data", "keywords", "keyword"].find(
    (key) => Object.hasOwn(task, key),
  );
  const first = pricedKey ? entries.find(([key]) => key === pricedKey) : entries[0];
  const shadow =
    duplicate && first
      ? `"${[...first[0]].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}":"shadow",`
      : "";
  return `${whitespace}[{${shadow}${entries.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",")}}]${whitespace}`;
}

export const owner = { namespace: "test", principal: "u" };
export const input = {
  operationId: "property",
  provider: "dataforseo",
  scope: { ...owner, connection: "c" },
  source: "app" as const,
  surface: "app" as const,
  fundingSource: "byok" as const,
  costOwner: "u",
};
export const smallPrice: Quantity = { unit: "cents", value: 1n, scale: 4 };
export function harness(
  mode: "open" | "money" | "credits" = "open",
  override?: "manual" | "measured",
  operation?: string,
) {
  const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });
  const clock = createManualClock();
  const budgets: Budget[] =
    mode === "money"
      ? [
          {
            id: "money",
            version: 1,
            scope: { kind: "principal", ...owner },
            surface: "any",
            unit: "cents",
            limit: { unit: "cents", value: 100000000n, scale: 0 },
            window: { kind: "calendar_month", timezone: "UTC" },
            onExceed: "block",
          },
        ]
      : [];
  const policy: ConnectionPolicy = {
    provider: "dataforseo",
    fundingSource: mode === "credits" ? "platform" : "byok",
    ...(override === "manual" && operation ? { manualPrices: { [operation]: smallPrice } } : {}),
    ...(override === "measured" ? { measured: () => ({ quantity: smallPrice, samples: 5 }) } : {}),
  };
  const store = createMemoryStore({ clock, budgets });
  const meter = createMeter({ store, clock, catalog, resolveConnection: () => policy });
  return { catalog, meter, store };
}
