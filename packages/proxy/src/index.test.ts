import { expect, test, vi } from "vitest";
import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createCatalog, dataforseo, serpapi } from "@usagekit/providers";
import { createProviderProxy } from "./index.js";

test.each([
  ["dataforseo", "/v3/appendix/user_data", "passthrough"],
  ["serpapi", "/search.json", "metered"],
])(
  "%s matched operations without body pricing preserve JSON bytes",
  async (provider, path, accounting) => {
    // POST variants allow bodies on the bundled free and query-priced operations.
    const providers = [dataforseo, serpapi].map((module) => ({
      ...module,
      descriptor: {
        ...module.descriptor,
        operations: module.descriptor.operations.map((operation) => ({
          ...operation,
          match: operation.match.map((match) => ({ ...match, method: "POST" as const })),
        })),
      },
    }));
    const catalog = createCatalog({ providers, enabled: [provider] });
    const owner = { namespace: "local", principal: "local" };
    const clock = createManualClock();
    const meter = createMeter({
      store: createMemoryStore({ budgets: [], clock }),
      clock,
      catalog,
      resolveConnection: () => ({ provider, fundingSource: "byok", plan: "starter" }),
    });
    const transport = vi.fn<typeof fetch>(async () => Response.json({}));
    const proxy = createProviderProxy({
      meter,
      catalog,
      owner,
      authenticate: async () => ({
        namespace: "local",
        readablePrincipals: ["local"],
        readableGroups: [],
        readablePools: [],
        canReadBillingDetail: true,
        canManageBudgets: false,
      }),
      connection: () => ({ provider, secret: "test-secret" }),
      transport,
    });
    const contentType = "application/merge-patch+json; charset=utf-8";
    for (const body of [' { "id": 9007199254740993, "huge": 1e400 } ', "{"]) {
      const response = await proxy(
        new Request(`http://localhost/proxy/c${path}`, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body,
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Usagekit-Accounting")).toBe(accounting);
      await response.text();
      const [, init] = transport.mock.calls.at(-1)!;
      expect.soft(new TextDecoder().decode(init?.body as Uint8Array)).toBe(body);
      expect.soft(new Headers(init?.headers).get("Content-Type")).toBe(contentType);
    }
  },
);

function bodyPricingHarness(module = dataforseo) {
  const provider = module.descriptor.id;
  const catalog = createCatalog({ providers: [module], enabled: [provider] });
  const clock = createManualClock();
  const store = createMemoryStore({ budgets: [], clock });
  const meter = createMeter({
    store,
    clock,
    catalog,
    resolveConnection: () => ({ provider, fundingSource: "byok" }),
  });
  const reserve = vi.spyOn(meter, "reserve");
  const transport = vi.fn<typeof fetch>(async () => Response.json({}));
  const proxy = createProviderProxy({
    meter,
    catalog,
    owner: { namespace: "local", principal: "local" },
    authenticate: async () => ({
      namespace: "local",
      readablePrincipals: ["local"],
      readableGroups: [],
      readablePools: [],
      canReadBillingDetail: true,
      canManageBudgets: false,
    }),
    connection: () => ({ provider, secret: "test-secret" }),
    transport,
  });
  return { proxy, catalog, reserve, transport, meter, store };
}
test.each(
  ["dataforseo", "body-provider"].flatMap((provider) =>
    ["Application/JSON", "application/vnd.api+json", "text/plain"].map((type) => ({
      provider,
      type,
    })),
  ),
)(
  "$provider descriptor body pricing handles $type before admission",
  async ({ provider, type }) => {
    const h = bodyPricingHarness({
      ...dataforseo,
      descriptor: { ...dataforseo.descriptor, id: provider },
    });
    const body = ' [ { "keyword": "example", "depth": 100 } ] ';
    const response = await h.proxy(
      new Request("http://localhost/proxy/c/v3/serp/google/organic/live/advanced", {
        method: "POST",
        headers: { "Content-Type": type },
        body,
      }),
    );
    await response.text();
    expect(response.status).toBe(type === "text/plain" ? 400 : 200);
    if (type === "text/plain") {
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.transport).not.toHaveBeenCalled();
    } else {
      const [, init] = h.transport.mock.calls[0]!;
      expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(
        '[{"keyword":"example","depth":100}]',
      );
    }
  },
);
test.each(["dataforseo", "body-provider"])(
  "%s rejects a non-JSON billable body even when its extractor accepts text",
  async (provider) => {
    // Only the declared body pricing input can reject this: the extractor reads no body.
    const h = bodyPricingHarness({
      ...dataforseo,
      descriptor: { ...dataforseo.descriptor, id: provider },
      extractors: { ...dataforseo.extractors, options: () => ({}) },
    });
    const response = await h.proxy(
      new Request("http://localhost/proxy/c/v3/serp/google/organic/live/advanced", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: '[{"keyword":"example","depth":100}]',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_provider_request" });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  },
);
test("proxy uses one body-aware match for admission and bytes", async () => {
  // URL-only routing selects this free operation; the body-aware catalog selects paid SERP.
  const paid = dataforseo.descriptor.operations.find(
    (op) => op.id === "serp.google.organic.live.advanced",
  )!;
  const free = dataforseo.descriptor.operations.find((op) => !op.billable)!;
  const module = {
    ...dataforseo,
    descriptor: {
      ...dataforseo.descriptor,
      operations: [
        { ...free, match: paid.match },
        ...dataforseo.descriptor.operations.filter((op) => op.id !== free.id),
      ],
    },
  };
  const h = bodyPricingHarness(module);
  expect(
    h.catalog.match("dataforseo", { method: "POST", url: "/v3/serp/google/organic/live/advanced" }),
  ).toMatchObject({ operation: { id: free.id, billable: false } });
  const match = vi
    .spyOn(h.catalog, "match")
    .mockImplementation((_id, request) =>
      Array.isArray(request.body)
        ? { operation: paid, options: dataforseo.extractors.options(paid, request) }
        : { operation: free, options: {} },
    );
  const response = await h.proxy(
    new Request("http://localhost/proxy/c/v3/serp/google/organic/live/advanced", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '[{"depth":100}]',
    }),
  );
  await response.text();
  expect(response.status).toBe(200);
  expect(match).toHaveBeenCalledTimes(1);
  const [url, init] = h.transport.mock.calls[0]!;
  expect(String(url)).toBe(match.mock.calls[0]![1].url);
  expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('[{"depth":100}]');
  expect(h.reserve).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "serp.google.organic.live.advanced",
      options: expect.objectContaining({ depth: "100" }),
    }),
  );
});

test("proxy propagates a Meter reserve failure unchanged", async () => {
  const h = bodyPricingHarness();
  const failure = new Error("reserve failed");
  h.reserve.mockRejectedValueOnce(failure);
  await expect(
    h.proxy(
      new Request("http://localhost/proxy/c/v3/serp/google/organic/live/advanced", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '[{"depth":100}]',
      }),
    ),
  ).rejects.toBe(failure);
  expect(h.transport).not.toHaveBeenCalled();
});

test("declared query duplicates are rejected by proxy before reservation", async () => {
  const h = bodyPricingHarness({
    ...dataforseo,
    descriptor: { ...dataforseo.descriptor, pricingInputs: ["body", "query"] },
    extractors: { ...dataforseo.extractors, options: () => ({}) },
  });
  const response = await h.proxy(
    new Request("http://localhost/proxy/c/v3/serp/google/organic/live/advanced?x=1&%78=2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '[{"depth":100}]',
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_provider_request" });
  expect(h.reserve).not.toHaveBeenCalled();
  expect(h.transport).not.toHaveBeenCalled();
});

test("BYOK-only proxy rejects a resolved platform connection at Meter admission", async () => {
  const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });
  const clock = createManualClock();
  const meter = createMeter({
    store: createMemoryStore({ clock, budgets: [] }),
    clock,
    catalog,
    resolveConnection: () => ({ provider: "dataforseo", fundingSource: "platform" }),
  });
  const reserve = vi.spyOn(meter, "reserve");
  const transport = vi.fn<typeof fetch>(async () => Response.json({}));
  const proxy = createProviderProxy({
    meter,
    catalog,
    owner: { namespace: "local", principal: "local" },
    authenticate: async () => ({
      namespace: "local",
      readablePrincipals: ["local"],
      readableGroups: [],
      readablePools: [],
      canReadBillingDetail: true,
      canManageBudgets: false,
    }),
    connection: () => ({ provider: "dataforseo", secret: "test:password" }),
    transport,
  });
  const response = await proxy(
    new Request("http://localhost/proxy/c/v3/serp/google/organic/live/advanced", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ future_paid_parameter: true }]),
    }),
  );
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error: "cannot_estimate_bounded_usage" });
  expect(reserve).toHaveBeenCalledOnce();
  expect(transport).not.toHaveBeenCalled();
});
