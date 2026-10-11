import { expect, test, vi } from "vitest";
import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import type { Budget } from "@usagekit/core";
import { createCatalog, dataforseo, decimalQuantity } from "./index.js";
import { executeProviderRequest } from "../test-support/execute.js";
import type { ProviderRequest } from "./index.js";

const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });
const connection = { id: "c", provider: "dataforseo", fundingSource: "byok" as const };
const itemPaths = [
  "dataforseo_labs/google/keyword_ideas",
  "dataforseo_labs/google/keyword_suggestions",
  "dataforseo_labs/google/related_keywords",
  "dataforseo_labs/google/keyword_overview",
  "dataforseo_labs/google/historical_rank_overview",
  "dataforseo_labs/google/relevant_pages",
  "backlinks/backlinks",
  "dataforseo_labs/google/ranked_keywords",
  "dataforseo_labs/google/domain_rank_overview",
  "backlinks/history",
];
const unknownPaths = [
  "backlinks/history",
  "dataforseo_labs/google/keyword_overview",
  "dataforseo_labs/google/historical_rank_overview",
];
const defaultPages = [
  {
    path: "dataforseo_labs/google/keyword_ideas",
    count: "700",
    base: "9.6",
    clickstream: "19.2",
    manual: "15.2",
    measured: "1.305",
  },
  {
    path: "dataforseo_labs/google/keyword_suggestions",
    count: "100",
    base: "2.4",
    clickstream: "4.8",
    manual: "3.2",
    measured: "1.215",
  },
  {
    path: "dataforseo_labs/google/related_keywords",
    count: "100",
    base: "2.4",
    clickstream: "4.8",
    manual: "3.2",
    measured: "1.215",
  },
  {
    path: "dataforseo_labs/google/relevant_pages",
    count: "100",
    base: "2.4",
    clickstream: "4.8",
    manual: "3.2",
    measured: "1.215",
  },
  {
    path: "backlinks/backlinks",
    count: "100",
    base: "2.76",
    clickstream: "2.76",
    manual: "4.4",
    measured: "2.415",
  },
];
for (const name of ["ranked_keywords", "domain_rank_overview"]) {
  defaultPages.push({
    path: `dataforseo_labs/google/${name}`,
    count: "100",
    base: "2.4",
    clickstream: "4.8",
    manual: "3.2",
    measured: "1.215",
  });
}
const request = (path: string, task: Record<string, unknown> = {}) => ({
  method: "POST",
  url: `/v3/${path}/live`,
  body: [task],
});
const estimate = (path: string, task?: Record<string, unknown>) => {
  const match = catalog.match("dataforseo", request(path, task));
  if (match.operation === "unknown") throw new Error("expected known operation");
  return catalog.estimate(connection, match.operation.id, match.options);
};
const unknown = { source: "unknown", quantities: [decimalQuantity("1", "requests")] };

test.each(unknownPaths)("missing item count is unknown for %s", (path) => {
  expect(estimate(path)).toEqual(unknown);
});

test.each(defaultPages)("omitted limit uses the documented page size for $path", (page) => {
  for (const include_clickstream_data of [false, true]) {
    const match = catalog.match(
      "dataforseo",
      request(
        page.path,
        page.path === "backlinks/backlinks" || page.path.endsWith("domain_rank_overview")
          ? {}
          : { include_clickstream_data },
      ),
    );
    if (match.operation === "unknown") throw new Error("expected known operation");
    expect(match.options.itemCount).toBe(page.count);
    expect(catalog.estimate(connection, match.operation.id, match.options)).toMatchObject({
      source: "list",
      quantities: [
        decimalQuantity(
          include_clickstream_data && !page.path.endsWith("domain_rank_overview")
            ? page.clickstream
            : page.base,
          "cents",
        ),
        decimalQuantity("1", "requests"),
      ],
    });
  }
});

test.each(defaultPages)(
  "documented count prices manual and measured item coefficients for $path",
  (page) => {
    const match = catalog.match("dataforseo", request(page.path));
    if (match.operation === "unknown") throw new Error("expected known operation");
    const operation = match.operation.id;
    for (const source of ["manual", "measured"] as const) {
      const policy =
        source === "manual"
          ? {
              manualPrices: { [operation]: decimalQuantity("0.02", "cents") },
              manualPriceBasis: { [operation]: "item" as const },
            }
          : {
              measured: () => ({
                quantity: decimalQuantity("0.00015", "cents"),
                samples: 5,
                basis: "item" as const,
              }),
            };
      expect(
        catalog.estimate({ ...connection, ...policy }, operation, match.options),
      ).toMatchObject({
        source,
        quantities: [decimalQuantity(page[source], "cents"), decimalQuantity("1", "requests")],
      });
    }
  },
);

test.each(itemPaths)("direct catalog estimates do not invent an item count for %s", (path) => {
  expect(catalog.estimate(connection, `${path.replaceAll("/", ".")}.live`, {})).toEqual(unknown);
});

test.each(defaultPages)("explicit limits override the documented default for $path", ({ path }) => {
  for (const limit of [1, 1000]) {
    const match = catalog.match("dataforseo", request(path, { limit }));
    if (match.operation === "unknown") throw new Error("expected known operation");
    expect(match.options.itemCount).toBe(String(limit));
  }
  expect(() => estimate(path, { limit: null })).toThrow("InvalidInput:");
});

test.each(["manual", "measured"] as const)(
  "missing count cannot price a %s item coefficient, but a whole-call price still works",
  (source) => {
    const operation = "dataforseo_labs.google.keyword_ideas.live";
    for (const basis of ["item", "call"] as const) {
      const policy =
        source === "manual"
          ? {
              manualPrices: { [operation]: decimalQuantity("3", "cents") },
              manualPriceBasis: { [operation]: basis },
            }
          : { measured: () => ({ quantity: decimalQuantity("3", "cents"), samples: 5, basis }) };
      const result = catalog.estimate({ ...connection, ...policy }, operation, {});
      if (basis === "item") expect(result).toEqual(unknown);
      else
        expect(result).toMatchObject({
          source,
          quantities: [decimalQuantity("3", "cents"), decimalQuantity("1", "requests")],
        });
    }
  },
);

test.each([true].map((value) => ({ value })))(
  "present clickstream value $value reserves the higher price",
  ({ value: include_clickstream_data }) => {
    for (const [path, expected] of [
      ["dataforseo_labs/google/keyword_ideas", "4.8"],
      ["dataforseo_labs/google/ranked_keywords", "4.8"],
    ] as const)
      expect(estimate(path, { limit: 100, include_clickstream_data }).quantities[0]).toEqual(
        decimalQuantity(expected, "cents"),
      );
  },
);

test.each([{}, { include_clickstream_data: false }])(
  "absent or false clickstream keeps the base multiplier: %j",
  (task) => {
    expect(estimate("dataforseo_labs/google/keyword_ideas", { limit: 100, ...task })).toMatchObject(
      {
        source: "list",
        quantities: [decimalQuantity("2.4", "cents"), decimalQuantity("1", "requests")],
      },
    );
  },
);

function execution(
  providerRequest: ProviderRequest = request("dataforseo_labs/google/keyword_ideas"),
) {
  const clock = createManualClock();
  const budget: Budget = {
    id: "money",
    version: 1,
    scope: { kind: "principal", namespace: "test", principal: "u" },
    surface: "any",
    unit: "cents",
    limit: decimalQuantity("3", "cents"),
    window: { kind: "calendar_month", timezone: "UTC" },
    onExceed: "block",
  };
  const store = createMemoryStore({ clock, budgets: [budget] });
  const meter = createMeter({ store, clock, catalog, resolveConnection: () => connection });
  const input = {
    operationId: "call",
    scope: { namespace: "test", principal: "u", connection: "c" },
    provider: "dataforseo",
    source: "app" as const,
    surface: "app" as const,
    fundingSource: "byok" as const,
    costOwner: "u",
  };
  const dispatch = vi.fn(async () => ({ response: { status: 200 }, body: { cost: 0.024 } }));
  return { catalog, meter, store, input, request: providerRequest, dispatch };
}

test.each(unknownPaths)(
  "a money budget blocks %s without a count before dispatch",
  async (path) => {
    const h = execution(request(path));
    expect(await executeProviderRequest(h)).toMatchObject({
      outcome: "not_dispatched",
      result: { outcome: "invalid", reason: "missing_estimate_unit", unit: "cents" },
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(await h.store.getOperation({ ...h.input.scope, operationId: "call" })).toBeNull();
  },
);

test.each(itemPaths)("direct Meter calls without itemCount remain unknown for %s", async (path) => {
  const h = execution();
  expect(
    await h.meter.reserve({
      ...h.input,
      operation: `${path.replaceAll("/", ".")}.live`,
      options: {},
    }),
  ).toMatchObject({
    outcome: "invalid",
    reason: "missing_estimate_unit",
    unit: "cents",
  });
  expect(await h.store.getOperation({ ...h.input.scope, operationId: "call" })).toBeNull();
});

test("keyword ideas without limit exceeds a 3-cent budget using its default page size", async () => {
  const h = execution();
  expect(await executeProviderRequest(h)).toMatchObject({
    outcome: "not_dispatched",
    result: { outcome: "exceeded" },
  });
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(await h.store.getOperation({ ...h.input.scope, operationId: "call" })).toBeNull();
});

test.each(defaultPages.slice(1))(
  "$path without limit is admitted at the documented count",
  async (page) => {
    const h = execution(request(page.path));
    expect(await executeProviderRequest(h)).toMatchObject({
      outcome: "completed",
      operation: {
        state: "settled",
        estimate: [decimalQuantity(page.base, "cents"), decimalQuantity("1", "requests")],
      },
    });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  },
);

test("numeric clickstream cannot slip under a money budget", async () => {
  const h = execution(
    request("dataforseo_labs/google/keyword_ideas", {
      limit: 100,
      include_clickstream_data: 1,
    }),
  );
  expect(await executeProviderRequest(h)).toMatchObject({
    outcome: "not_dispatched",
    result: { outcome: "invalid", field: "request" },
  });
  expect(h.dispatch).not.toHaveBeenCalled();
});

test("an explicit count with false clickstream is admitted and settles real evidence", async () => {
  const h = execution(
    request("dataforseo_labs/google/keyword_ideas", {
      limit: 100,
      include_clickstream_data: false,
    }),
  );
  expect(await executeProviderRequest(h)).toMatchObject({
    outcome: "completed",
    operation: {
      state: "settled",
      estimate: [decimalQuantity("2.4", "cents"), decimalQuantity("1", "requests")],
      receipts: [{ cost: { certainty: "measured", money: { units: 24000n } } }],
    },
  });
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});

const batch = {
  method: "POST",
  url: "/v3/serp/google/organic/task_post",
  body: [
    { keyword: "one", depth: 100 },
    { keyword: "two", depth: 100, priority: 2 },
  ],
};
test("catalog match rejects a multi-task body instead of pricing its first task", () => {
  expect(() => catalog.match("dataforseo", batch)).toThrow(
    "InvalidInput: multiple DataForSEO tasks",
  );
});

test.each([false, true])(
  "multi-task execution never dispatches (explicit estimate=%s)",
  async (explicit) => {
    const h = execution(batch);
    const result = await executeProviderRequest({
      ...h,
      input: { ...h.input, ...(explicit ? { estimate: [decimalQuantity("1", "cents")] } : {}) },
    });
    expect(result).toMatchObject({
      outcome: "not_dispatched",
      result: {
        outcome: "invalid",
        field: "request",
        reason: "InvalidInput: multiple DataForSEO tasks",
      },
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(await h.store.getOperation({ ...h.input.scope, operationId: "call" })).toBeNull();
  },
);

test.each([
  ...["limit", "depth"].flatMap((field) =>
    ["1000", null, true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, {}, []].map(
      (value) => ({ field, value }),
    ),
  ),
  ...["2", null, true, 0, 3, 1.5, {}, []].map((value) => ({ field: "priority", value })),
  ...["seed", null, [1], ["seed", null], {}].map((value) => ({ field: "keywords", value })),
  ...["false", "true", 0, 1, null, {}, []].map((value) => ({
    field: "include_clickstream_data",
    value,
  })),
])("billable request rejects invalid JSON type/value for $field: $value", ({ field, value }) => {
  expect(() =>
    catalog.match(
      "dataforseo",
      request("dataforseo_labs/google/keyword_ideas", { [field]: value }),
    ),
  ).toThrow("InvalidInput:");
});

test("undocumented limit zero makes the estimate unknown", () => {
  expect(estimate("dataforseo_labs/google/keyword_ideas", { limit: 0 })).toEqual(unknown);
});

test("free DataForSEO operations do not validate billable pricing fields", () => {
  expect(() =>
    catalog.match("dataforseo", {
      method: "GET",
      url: "/v3/serp/google/organic/tasks_ready",
      body: [{ priority: "2", limit: "1000" }, {}],
    }),
  ).not.toThrow();
});

test("undefined pricing fields count as omitted, as JSON serialization drops them", () => {
  for (const path of itemPaths) {
    const omitted = catalog.match("dataforseo", request(path));
    const undefinedFields = catalog.match(
      "dataforseo",
      request(path, {
        limit: undefined,
        depth: undefined,
        priority: undefined,
        keywords: undefined,
        include_clickstream_data: undefined,
      }),
    );
    expect(undefinedFields).toEqual(omitted);
  }
});

test.each(
  ["Depth", "LIMIT", "Priority", "Keywords", "INCLUDE_CLICKSTREAM_DATA"].concat([
    "\u212Aeywords",
    "l\u0131m\u0131t",
    "\uFF44\uFF45\uFF50\uFF54\uFF48",
    "include_click\u017Ftream_data",
  ]),
)("billable request makes unknown pricing key spelling %s unpriceable", (key) => {
  expect(estimate("dataforseo_labs/google/keyword_ideas", { [key]: 1 })).toEqual(unknown);
});

const advanced = (body: unknown): ProviderRequest => ({
  method: "POST",
  url: "/v3/serp/google/organic/live/advanced",
  ...(body === undefined ? {} : { body }),
});
test.each([
  ["JSON text", JSON.stringify([{ keyword: "example", depth: 700 }])],
  ["bare task object", { keyword: "example", depth: 700 }],
  ["numeric-key object", { 0: { depth: 700 }, 1: { depth: 700 } }],
  ["empty task array", []],
  ["nested task array", [[{ depth: 700 }]]],
  ["null task", [null]],
])("billable execution rejects %s before reservation or dispatch", async (_case, body) => {
  expect(() => catalog.match("dataforseo", advanced(body))).toThrow("InvalidInput:");
  const h = execution(advanced(body));
  expect(await executeProviderRequest(h)).toMatchObject({
    outcome: "not_dispatched",
    result: { outcome: "invalid", field: "request" },
  });
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(await h.store.getOperation({ ...h.input.scope, operationId: "call" })).toBeNull();
});

// Public request matching, estimation and execution regressions for the review findings.
test.each(defaultPages)("limit zero makes pricing unknown for $path", (page) => {
  expect(estimate(page.path, { limit: 0 })).toEqual(unknown);
});

test("Backlinks summary charges one row", () => {
  expect(estimate("backlinks/summary")).toMatchObject({
    source: "list",
    quantities: [decimalQuantity("2.4036", "cents"), decimalQuantity("1", "requests")],
  });
});

test.each(["ranked_keywords", "domain_rank_overview"])("%s prices every requested item", (name) => {
  for (const include_clickstream_data of [false, true]) {
    expect(
      estimate(`dataforseo_labs/google/${name}`, {
        limit: 1000,
        ...(name === "ranked_keywords" ? { include_clickstream_data } : {}),
      }).quantities[0],
    ).toEqual(
      decimalQuantity(
        include_clickstream_data && name === "ranked_keywords" ? "26.4" : "13.2",
        "cents",
      ),
    );
  }
});

const serpPaths = ["serp/google/organic/live/advanced", "serp/google/organic/task_post"];
const serpRequest = (path: string, task: Record<string, unknown>): ProviderRequest => ({
  method: "POST",
  url: `/v3/${path}`,
  body: [task],
});
const unpricedSerpTasks = [
  { keyword: 123 },
  { people_also_ask_click_depth: 0 },
  { depth: 0 },
  { load_async_ai_overview: "false" },
  { calculate_rectangles: null },
  { people_also_ask_click_depth: "0" },
];
test.each(serpPaths.flatMap((path) => unpricedSerpTasks.map((task) => ({ path, task }))))(
  "unpriced SERP fields reject before dispatch on $path: $task",
  async ({ path, task }) => {
    expect(
      () => catalog.match("dataforseo", serpRequest(path, task)),
      JSON.stringify(task),
    ).toThrow("InvalidInput:");
    for (const explicit of [false, true]) {
      const h = execution(serpRequest(path, task));
      expect(
        await executeProviderRequest({
          ...h,
          input: { ...h.input, ...(explicit ? { estimate: [decimalQuantity("1", "cents")] } : {}) },
        }),
      ).toMatchObject({
        outcome: "not_dispatched",
        result: { outcome: "invalid", field: "request" },
      });
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(await h.store.getOperation({ ...h.input.scope, operationId: "call" })).toBeNull();
    }
  },
);

test.each(serpPaths)("single-page SERP defaults and free flags remain priced on %s", (path) => {
  for (const task of [
    { keyword: "example" },
    {
      keyword: "example -site:example.com",
      depth: 10,
      calculate_rectangles: false,
      load_async_ai_overview: false,
    },
  ]) {
    const match = catalog.match("dataforseo", serpRequest(path, task));
    if (match.operation === "unknown") throw new Error("missing operation");
    expect(catalog.estimate(connection, match.operation.id, match.options).quantities[0]).toEqual(
      decimalQuantity(path.endsWith("task_post") ? "0.06" : "0.2", "cents"),
    );
  }
});

test.each(["serp.google.organic.live.advanced", "serp.google.organic.task_post"])(
  "direct %s estimates reject invalid depths",
  (operation) => {
    for (const depth of ["0", "-1", "1.5", "bad", "9007199254740992"]) {
      expect(() => catalog.estimate(connection, operation, { depth, priority: "normal" })).toThrow(
        "InvalidInput:",
      );
    }
  },
);

test("unconfirmed seed-item billing fails a money budget with an unknown estimate", async () => {
  const h = execution(
    request("dataforseo_labs/google/keyword_ideas", { include_seed_keyword: true }),
  );
  expect(await executeProviderRequest(h)).toMatchObject({
    outcome: "not_dispatched",
    result: { outcome: "invalid", reason: "missing_estimate_unit" },
  });
  expect(h.dispatch).not.toHaveBeenCalled();
});

const serpCases = [
  {
    path: serpPaths[0]!,
    priority: 1,
    level: undefined,
    base: "0.2",
    twoPages: "0.4",
    tenPages: "2",
  },
  {
    path: serpPaths[1]!,
    priority: 1,
    level: "normal",
    base: "0.06",
    twoPages: "0.12",
    tenPages: "0.6",
  },
  {
    path: serpPaths[1]!,
    priority: 2,
    level: "high",
    base: "0.12",
    twoPages: "0.24",
    tenPages: "1.2",
  },
];
const rankTask = {
  keyword: "best running shoes",
  location_code: 2840,
  language_code: "en",
  device: "desktop",
  depth: 100,
  search_param: "&nfpr=1",
  tag: "t",
  find_targets_in: ["organic"],
  stop_crawl_on_match: [{ match_type: "with_subdomains", match_value: "example.com" }],
};

test.each(serpCases.flatMap((row) => ["direct", "extracted"].map((mode) => ({ ...row, mode }))))(
  "$mode page prices for $path $level",
  ({ path, priority, level, base, twoPages, tenPages, mode }) => {
    for (const [depth, expected] of [
      [undefined, base],
      [10, base],
      [11, twoPages],
      [20, twoPages],
      [50, String(Number(base) * 5)],
      [100, tenPages],
    ] as const) {
      const operation = path.replaceAll("/", ".");
      const options = {
        ...(depth === undefined ? {} : { depth: String(depth) }),
        ...(level ? { priority: level } : {}),
      };
      if (mode === "direct") {
        expect(catalog.estimate(connection, operation, options).quantities[0]).toEqual(
          decimalQuantity(expected, "cents"),
        );
        continue;
      }
      const match = catalog.match(
        "dataforseo",
        serpRequest(path, {
          ...(level ? { priority } : {}),
          ...(depth === undefined ? {} : { depth }),
        }),
      );
      if (match.operation === "unknown") throw new Error("missing operation");
      expect(catalog.estimate(connection, match.operation.id, match.options).quantities[0]).toEqual(
        decimalQuantity(expected, "cents"),
      );
    }
  },
);

test.each(serpCases)(
  "rank check dispatch reserves depth price for $path $level",
  async ({ path, priority, tenPages }) => {
    const h = execution(
      serpRequest(path, { ...rankTask, ...(path.endsWith("task_post") ? { priority } : {}) }),
    );
    h.dispatch.mockResolvedValue({ response: { status: 200 }, body: { cost: 0.001 } });
    expect(await executeProviderRequest(h)).toMatchObject({
      outcome: "completed",
      operation: {
        state: path.endsWith("task_post") ? "pending" : "settled",
        estimate: [decimalQuantity(tenPages, "cents"), decimalQuantity("1", "requests")],
        receipts: [
          {
            cost: path.endsWith("task_post")
              ? { certainty: "unknown", money: null }
              : { certainty: "measured", money: { units: 1000n } },
          },
        ],
      },
    });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  },
);

test.each(serpCases)(
  "direct Meter reserves depth price for $path $level",
  async ({ path, level, tenPages }) => {
    const h = execution();
    expect(
      await h.meter.reserve({
        ...h.input,
        operation: path.replaceAll("/", "."),
        options: { depth: "100", ...(level ? { priority: level } : {}) },
      }),
    ).toMatchObject({ outcome: "reserved" });
    expect(await h.store.getOperation({ ...h.input.scope, operationId: "call" })).toMatchObject({
      estimate: [decimalQuantity(tenPages, "cents"), decimalQuantity("1", "requests")],
    });
  },
);

const acceptedSerpFields = [
  { search_param: "&nfpr=1" },
  { search_param: "" },
  { search_param: "&q=ordinary+words" },
  { search_param: "&q=-SITE%253Aexample.com" },
  { stop_crawl_on_match: rankTask.stop_crawl_on_match, find_targets_in: ["organic"] },
  { stop_crawl_on_match: [] },
];
test.each(serpPaths.flatMap((path) => acceptedSerpFields.map((task) => ({ path, task }))))(
  "safe SERP fields retain depth pricing on $path: $task",
  async ({ path, task }) => {
    const req = serpRequest(path, { ...task, depth: 100 });
    const match = catalog.match("dataforseo", req);
    if (match.operation === "unknown") throw new Error("missing operation");
    const expected = decimalQuantity(path.endsWith("task_post") ? "0.6" : "2", "cents");
    expect(catalog.estimate(connection, match.operation.id, match.options).quantities[0]).toEqual(
      expected,
    );
    const h = execution(req);
    expect(await executeProviderRequest(h)).toMatchObject({
      outcome: "completed",
      operation: { estimate: [expected, decimalQuantity("1", "requests")] },
    });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  },
);

const invalidSerpFields = [
  ...["%", "%GG", "%25", "%E0%A4%A", "%" + "25".repeat(40) + "3Asite"].map((search_param) => ({
    search_param,
  })),
  ...[null, 1, false, {}, []].map((search_param) => ({ search_param })),
  ...[null, 1, false, {}, "target"].map((stop_crawl_on_match) => ({ stop_crawl_on_match })),
  ...[0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1].map((depth) => ({ depth })),
];
test.each(serpPaths.flatMap((path) => invalidSerpFields.map((task) => ({ path, task }))))(
  "invalid SERP input rejects before dispatch on $path: $task",
  async ({ path, task }) => {
    expect(() => catalog.match("dataforseo", serpRequest(path, task))).toThrow("InvalidInput:");
    const h = execution(serpRequest(path, task));
    expect(await executeProviderRequest(h)).toMatchObject({
      outcome: "not_dispatched",
      result: { outcome: "invalid", field: "request" },
    });
    expect(h.dispatch).not.toHaveBeenCalled();
  },
);
