import { addQuantity, formatQuantity } from "@usagekit/core";
import type { BalanceSnapshot, BillingLine, Measurement, PriceRow } from "@usagekit/core";
import { descriptor } from "./descriptor.js";
import { historyWindowOptions } from "./history-window.js";
import type { Extractors, ReceiptDraft } from "../types.js";
import { listEstimate } from "../prices.js";
import { pointer } from "../pointer.js";
import { decimalQuantity, moneyFromDollars, requestsMeasured } from "../receipts.js";

type Task = {
  id?: unknown;
  status_code?: unknown;
  cost?: unknown;
  path?: unknown;
  result?: unknown;
};
const tasksOf = (body: unknown): Task[] => {
  const tasks = pointer(body, "/tasks");
  return Array.isArray(tasks) ? (tasks as Task[]) : [];
};
const isCost = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const centsQuantity = (dollars: number) => ({
  value: moneyFromDollars(dollars).units,
  scale: 4,
  unit: "cents",
});
const priceListSource = "https://docs.dataforseo.com/v3/appendix/user_data/";

/**
 * Price object keys `api.func_type.func_name` to operation ids. The key layout follows the
 * documented field schema; a recorded user_data fixture confirms it. Unmapped keys, per-result
 * entries and free functions are skipped.
 */
export const priceKeys: Readonly<Record<string, string>> = {
  "serp.live.advanced": "serp.google.organic.live.advanced",
  "serp.task_post.organic": "serp.google.organic.task_post",
  ...Object.fromEntries(
    [
      "keyword_ideas",
      "keyword_suggestions",
      "related_keywords",
      "keyword_overview",
      "ranked_keywords",
      "domain_rank_overview",
      "historical_rank_overview",
      "relevant_pages",
    ].map((n) => [`dataforseo_labs.live.${n}`, `dataforseo_labs.google.${n}.live`]),
  ),
  ...Object.fromEntries(
    ["summary", "history", "backlinks"].map((n) => [`backlinks.live.${n}`, `backlinks.${n}.live`]),
  ),
};
const withPriority = new Set(["serp.google.organic.task_post"]);
const itemCountFields: Readonly<Record<string, "keywords" | "limit">> = {
  "dataforseo_labs.google.keyword_overview.live": "keywords",
  "dataforseo_labs.google.keyword_ideas.live": "limit",
  "dataforseo_labs.google.keyword_suggestions.live": "limit",
  "dataforseo_labs.google.related_keywords.live": "limit",
  "dataforseo_labs.google.relevant_pages.live": "limit",
  "backlinks.backlinks.live": "limit",
  "dataforseo_labs.google.ranked_keywords.live": "limit",
  "dataforseo_labs.google.domain_rank_overview.live": "limit",
};
function timestamp(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+00:00$/.exec(text);
  return m ? new Date(`${m[1]}T${m[2]}Z`).toISOString() : undefined;
}

const nonNegativeInteger = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/**
 * The single task of a present billable body, with documented JSON types for every pricing
 * field. Ambiguous body shapes (text, bare objects, empty or nested arrays) are InvalidInput.
 * Unlisted keys, including alternate spellings, are separately marked unpriceable.
 * Undefined fields count as omitted, as JSON serialization drops them. A request without a
 * body carries no task and keeps the defaults.
 */
function billableTask(body: unknown): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  if (Array.isArray(body) && body.length > 1)
    throw new Error("InvalidInput: multiple DataForSEO tasks");
  const task: unknown = Array.isArray(body) ? body[0] : undefined;
  if (!task || typeof task !== "object" || Array.isArray(task))
    throw new Error("InvalidInput: DataForSEO body must be an array with one task object");
  const t = task as Record<string, unknown>;
  for (const field of ["limit", "depth"] as const)
    if (t[field] !== undefined && !nonNegativeInteger(t[field]))
      throw new Error(`InvalidInput: DataForSEO ${field}`);
  if (t.priority !== undefined && t.priority !== 1 && t.priority !== 2)
    throw new Error("InvalidInput: DataForSEO priority");
  if (
    t.keywords !== undefined &&
    (!Array.isArray(t.keywords) || t.keywords.some((keyword) => typeof keyword !== "string"))
  )
    throw new Error("InvalidInput: DataForSEO keywords");
  for (const field of ["include_clickstream_data", "include_seed_keyword"])
    if (t[field] !== undefined && typeof t[field] !== "boolean")
      throw new Error(`InvalidInput: DataForSEO ${field}`);
  return t;
}

const isSerp = (id: string) => id.startsWith("serp.google.organic.");

function validateSerpDepth(depth: unknown): void {
  if (
    depth !== undefined &&
    (!/^\d+$/.test(String(depth)) ||
      BigInt(String(depth)) < 1n ||
      BigInt(String(depth)) > BigInt(Number.MAX_SAFE_INTEGER))
  )
    throw new Error("InvalidInput: DataForSEO SERP depth must be a positive safe integer");
}

// "Contains" is intentional, including embedded forms such as android: (id:).
// Each distinct documented substring contributes a factor of five.
// https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/
// https://docs.dataforseo.com/v3/serp/google/organic/task_post/
// https://dataforseo.com/pricing/serp/google-organic-serp-api
const searchOperators = [
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
function operatorCount(task: Record<string, unknown>): number {
  const values = [
    ...(typeof task.keyword === "string" ? [task.keyword, decodeKeyword(task.keyword)] : []),
    ...(typeof task.search_param === "string"
      ? [task.search_param, decodeSearchParam(task.search_param)]
      : []),
  ];
  const normalized = values
    .flatMap((v) => [
      v.normalize("NFKC").toLowerCase(),
      v.normalize("NFKC").toUpperCase().toLowerCase(),
      v
        .normalize("NFKD")
        .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "")
        .toLowerCase(),
    ])
    .map((v) => v.replaceAll("-site:", ""));
  // -site: is explicitly free. Other operator matches are conservative upper bounds.
  // https://dataforseo.com/help-center/rules-and-limitations-of-keyword-and-keywords-fields-in-dataforseo-apis
  return searchOperators.filter((op) => normalized.some((value) => value.includes(op))).length;
}

/** Keywords are text, not query strings: preserve literal percent signs. Decode each
 * valid escape run leniently; invalid UTF-8 bytes become replacement characters. */
function decodeKeyword(value: string): string {
  value = value.normalize("NFKC");
  for (let i = 0; i < 16; i++) {
    const decoded = value
      .replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
        try {
          return decodeURIComponent(run);
        } catch {
          return new TextDecoder().decode(
            Uint8Array.from(run.match(/[0-9a-f]{2}/gi)!, (hex) => parseInt(hex, 16)),
          );
        }
      })
      .normalize("NFKC");
    if (decoded === value) return decoded;
    value = decoded;
  }
  throw new Error("InvalidInput: DataForSEO keyword encoding depth");
}

function validateSerpOptions(options: Readonly<Record<string, string>>): void {
  validateSerpDepth(options.depth);
  for (const [field, max] of [
    ["operatorCount", searchOperators.length],
    ["clicks", 4],
  ] as const) {
    const value = options[field];
    if (value !== undefined && (!/^\d+$/.test(value) || BigInt(value) > BigInt(max)))
      throw new Error(`InvalidInput: DataForSEO SERP ${field}`);
  }
}

function decodeSearchParam(value: string): string {
  value = value.normalize("NFKC");
  // Decode nested query escapes before checking operators. Fail closed when malformed
  // or still changing after the bound rather than passing an unchecked encoded operator.
  for (let i = 0; i < 16; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value.replace(/\+/g, " ")).normalize("NFKC");
    } catch {
      throw new Error("InvalidInput: DataForSEO malformed search_param escape");
    }
    if (decoded === value) return decoded;
    value = decoded;
  }
  throw new Error("InvalidInput: DataForSEO search_param encoding depth");
}

function validateSerpTask(task: Record<string, unknown>): void {
  validateSerpDepth(task.depth);
  for (const field of ["calculate_rectangles", "load_async_ai_overview"])
    if (task[field] !== undefined && typeof task[field] !== "boolean")
      throw new Error(`InvalidInput: DataForSEO ${field}`);
  for (const [field, max] of [
    ["people_also_ask_click_depth", 4],
    ["max_crawl_pages", 100],
  ] as const)
    if (
      task[field] !== undefined &&
      (!nonNegativeInteger(task[field]) || Number(task[field]) < 1 || Number(task[field]) > max)
    )
      throw new Error(`InvalidInput: DataForSEO ${field}`);
  if (task.stop_crawl_on_match !== undefined && !Array.isArray(task.stop_crawl_on_match))
    throw new Error("InvalidInput: DataForSEO stop_crawl_on_match");
  for (const field of ["keyword", "search_param"])
    if (task[field] !== undefined && typeof task[field] !== "string")
      throw new Error(`InvalidInput: DataForSEO ${field}`);
}

export const extractors: Extractors = {
  canEstimate: (options) => options.pricingUnknown !== "true",

  // https://dataforseo.com/pricing/serp/google-organic-serp-api
  // https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api
  requiresListPriceFloor: (options) =>
    Number(options.operatorCount ?? "0") > 0 ||
    options.rectangles === "true" ||
    options.asyncOverview === "true" ||
    Number(options.clicks ?? "0") > 0 ||
    options.crawlPages !== undefined ||
    options.clickstream === "true",

  estimate: (input) => {
    if (isSerp(input.operation.id)) validateSerpOptions(input.options);
    if (!extractors.canEstimate!(input.options)) return [];
    const estimates = listEstimate(input);
    if (!isSerp(input.operation.id)) return estimates;
    // Bound every page and operator combination, including add-ons. Field docs give
    // $0.002 live / $0.0006 queued; the pricing table gives one base (higher for high priority).
    // https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/
    // https://docs.dataforseo.com/v3/serp/google/organic/task_post/
    // https://dataforseo.com/pricing/serp/google-organic-serp-api
    // https://dataforseo.com/help-center/serp-api-cost-explained
    const pages = (BigInt(input.options.depth ?? "10") + 9n) / 10n;
    const operators = BigInt(input.options.operatorCount ?? "0");
    const factor = 5n ** operators;
    const addOns =
      Number(input.options.rectangles === "true") + Number(input.options.asyncOverview === "true");
    const extra = decimalQuantity(
      input.operation.id.endsWith("task_post")
        ? input.options.priority === "high"
          ? "0.12"
          : "0.06"
        : "0.2",
      "cents",
    );
    const clicks = decimalQuantity("0.015", "cents");
    return estimates.map((q) => {
      if (q.unit !== "cents") return q;
      const total = addQuantity(
        addQuantity(q, { ...extra, value: extra.value * BigInt(addOns) * pages }),
        { ...clicks, value: clicks.value * BigInt(input.options.clicks ?? "0") * pages },
      );
      return decimalQuantity(formatQuantity({ ...total, value: total.value * factor }), "cents");
    });
  },
  /** Request dimensions and documented defaults, separate from observed response quantities. */
  options: (operation, request) => {
    const first: unknown = operation.billable
      ? billableTask(request.body)
      : Array.isArray(request.body)
        ? request.body[0]
        : null;
    if (!first || typeof first !== "object") return {};
    const task = first as Record<string, unknown>,
      options: Record<string, string> = {};
    const keys = operation.optionKeys ?? [];
    Object.assign(options, historyWindowOptions(operation.id, task));
    if (operation.billable) {
      const fields = operation.requestPricing;
      const unlisted =
        !fields ||
        Object.keys(task).some(
          (key) =>
            task[key] !== undefined &&
            !Object.hasOwn(fields.priceFields, key) &&
            !fields.neutralFields.includes(key),
        );
      if (
        unlisted ||
        task.limit === 0 ||
        Number(task.limit) > 1000 ||
        Object.entries(fields?.priceFields ?? {}).some(([field, rule]) =>
          rule.unpricedWhen === "present"
            ? task[field] !== undefined
            : rule.unpricedWhen === "true" && task[field] === true,
        )
      )
        options.pricingUnknown = "true";
    }
    if (operation.billable && isSerp(operation.id)) validateSerpTask(task);
    if (keys.includes("priority")) {
      const priority = task.priority ?? 1;
      if (priority === 1) options.priority = "normal";
      else if (priority === 2) options.priority = "high";
    }
    if (keys.includes("depth") && task.depth !== undefined) options.depth = String(task.depth);
    if (operation.billable && isSerp(operation.id)) {
      if (task.max_crawl_pages !== undefined) {
        options.crawlPages = String(task.max_crawl_pages);
        options.depth = String(
          Math.max(Number(task.depth ?? 10), Number(task.max_crawl_pages) * 10),
        );
      }
      const count = operatorCount(task);
      if (count) options.operatorCount = String(count);
      if (task.calculate_rectangles === true) options.rectangles = "true";
      if (task.load_async_ai_overview === true) options.asyncOverview = "true";
      if (task.people_also_ask_click_depth !== undefined)
        options.clicks = String(task.people_also_ask_click_depth);
    }
    if (keys.includes("itemCount")) {
      const field = itemCountFields[operation.id];
      const count =
        field === "keywords"
          ? Array.isArray(task.keywords)
            ? task.keywords.length
            : undefined
          : field === "limit"
            ? // Only omission uses the documented default; zero marks the request unknown.
              task.limit === undefined
              ? operation.requestPricing?.priceFields.limit?.defaultCount
              : task.limit
            : // Summary returns one row; explicit history dates were bounded above.
              // https://docs.dataforseo.com/v3/backlinks/summary/live/
              operation.id === "backlinks.summary.live"
              ? 1
              : undefined;
      if (count !== undefined) options.itemCount = String(count);
    }
    if (keys.includes("clickstream") && task.include_clickstream_data !== undefined)
      options.clickstream = task.include_clickstream_data === false ? "false" : "true";
    return options;
  },
  /**
   * Cost from the envelope `cost` (USD, every task of the call). A task status of 40000 or
   * more, or an HTTP error, marks the receipt failed with whatever the provider charged.
   * Deferred operations keep cost unknown and carry the task id for resolution.
   */
  extract: (operation, _request, response, body): ReceiptDraft => {
    const tasks = tasksOf(body),
      id = extractors.requestId(body),
      cost = pointer(body, "/cost"),
      status = pointer(body, "/status_code");
    const failed =
      response.status >= 400 ||
      (typeof status === "number" && status >= 40000) ||
      tasks.some((t) => typeof t.status_code === "number" && t.status_code >= 40000);
    const known = operation.costEvidence !== "deferred" && isCost(cost);
    const cents: Measurement = known
      ? { unit: "cents", quantity: centsQuantity(cost), certainty: "measured" }
      : { unit: "cents", quantity: null, certainty: "unknown" };
    return {
      measurements: [cents, requestsMeasured()],
      cost: known
        ? { certainty: "measured", money: moneyFromDollars(cost) }
        : { certainty: "unknown", money: null },
      ...(id ? { providerRequestId: id } : {}),
      cached: false,
      failed,
    };
  },
  requestId: (body) => {
    const id = tasksOf(body)[0]?.id;
    return typeof id === "string" && id ? id : undefined;
  },
  balance: (body): BalanceSnapshot => {
    const result = pointer(body, "/tasks/0/result/0") as Record<string, unknown> | undefined;
    const snapshot: BalanceSnapshot = { plan: "prepaid" };
    const balance = pointer(result, "/money/balance"),
      total = pointer(result, "/money/total"),
      login = pointer(result, "/login"),
      perMinute = pointer(result, "/rates/limits/minute/total");
    if (isCost(balance)) snapshot.remaining = centsQuantity(balance);
    if (isCost(balance) && isCost(total) && total >= balance)
      snapshot.used = {
        ...centsQuantity(total),
        value: centsQuantity(total).value - centsQuantity(balance).value,
      };
    if (typeof login === "string" && login) snapshot.accountIdentity = login;
    if (typeof perMinute === "number" && Number.isSafeInteger(perMinute))
      snapshot.rateLimitPerHour = perMinute * 60;
    return snapshot;
  },
  /** Maps price.api.func_type.func_name.priority to operation and priority option. */
  priceList: (body, checkedAt): PriceRow[] => {
    const price = pointer(body, "/tasks/0/result/0/price");
    const rows: PriceRow[] = [];
    if (!price || typeof price !== "object") return rows;
    for (const [api, types] of Object.entries(price as Record<string, unknown>))
      for (const [type, names] of Object.entries((types ?? {}) as Record<string, unknown>))
        for (const [name, priorities] of Object.entries((names ?? {}) as Record<string, unknown>)) {
          const operation = priceKeys[`${api}.${type}.${name}`];
          if (!operation) continue;
          for (const [priority, entry] of Object.entries(
            (priorities ?? {}) as Record<string, { cost_type?: unknown; cost?: unknown }>,
          )) {
            const level = priority.replace(/^priority_/, "");
            if (entry?.cost_type !== "per_request" || !isCost(entry.cost)) continue;
            if (!withPriority.has(operation) && level !== "normal") continue;
            const calculation = descriptor.prices.find(
              (r) => r.operation === operation && (!r.option || r.option.priority === level),
            )?.calculation;
            rows.push({
              validFrom: checkedAt,
              operation,
              ...(withPriority.has(operation) ? { option: { priority: level } } : {}),
              unit: "cents",
              perUnit: formatQuantity(centsQuantity(entry.cost)),
              // The endpoint refreshes base prices; retain static formula metadata.
              ...(calculation ? { calculation } : {}),
              source: priceListSource,
              checkedAt,
            });
          }
        }
    return rows;
  },
  /** Task history lines: the charge of each posted task, matched by task id. */
  billingExport: (input): BillingLine[] =>
    tasksOf(input).flatMap((t) => {
      const occurredAt = timestamp(pointer(t, "/result/0/datetime"));
      if (typeof t.id !== "string" || !isCost(t.cost) || !occurredAt) return [];
      return [
        {
          providerRequestId: t.id,
          operation: "serp.google.organic.task_post",
          occurredAt,
          cost: moneyFromDollars(t.cost),
        },
      ];
    }),
};
