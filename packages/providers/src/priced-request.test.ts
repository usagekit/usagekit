import { expect, test, vi } from "vitest";
import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import {
  createCatalog,
  dataforseo,
  serpapi,
  PricedRequest,
  RequestPricingError,
  executeProviderRequest,
  dispatchPricedRequest,
} from "./index.js";
import type { ProviderAuth } from "@usagekit/core";
import type { ProviderRequest } from "./index.js";

test("pricing snapshots method, URL, body and estimate before awaiting admission", async () => {
  const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });
  const clock = createManualClock();
  const meter = createMeter({
    store: createMemoryStore({ budgets: [], clock }),
    clock,
    catalog,
    resolveConnection: () => ({ provider: "dataforseo", fundingSource: "byok" }),
  });
  const originalMatch = catalog.match.bind(catalog);
  let matcherView: ProviderRequest | undefined;
  vi.spyOn(catalog, "match").mockImplementation((id, request) => {
    matcherView = request;
    return originalMatch(id, request);
  });
  const original = meter.reserve.bind(meter);
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(meter, "reserve").mockImplementation(async (input) => {
    await paused;
    return original(input);
  });
  const request: ProviderRequest = {
    method: "POST",
    url: "/v3/serp/google/organic/live/advanced",
    body: [{ keyword: "example", depth: 100 }],
  };
  const input = {
    operationId: "snapshot",
    provider: "dataforseo",
    scope: { namespace: "test", principal: "u", connection: "c" },
    source: "app" as const,
    surface: "app" as const,
    fundingSource: "byok" as const,
    costOwner: "u",
  };
  const pending = PricedRequest.price({ catalog, meter, input, request });
  matcherView!.method = "DELETE";
  matcherView!.body = [{ depth: 700 }];
  request.method = "DELETE";
  request.url = "/changed";
  request.body = [{ depth: 700 }];
  input.operationId = "changed";
  resume();
  const priced = await pending;
  expect(priced.method).toBe("POST");
  expect(priced.url).toBe("https://api.dataforseo.com/v3/serp/google/organic/live/advanced");
  expect(new TextDecoder().decode(priced.body)).toBe('[{"keyword":"example","depth":100}]');
  expect(priced.input.operationId).toBe("snapshot");
  expect(priced.estimate).toContainEqual({ unit: "cents", value: 2n, scale: 0 });
  priced.body!.fill(0);
  expect(new TextDecoder().decode(priced.body)).toBe('[{"keyword":"example","depth":100}]');
  expect(() => {
    priced.matched.operation = "unknown";
  }).toThrow();
});

// Compile-time regression: transport and execution do not accept unpriced data.
function rejectsRawRequests(
  request: ProviderRequest,
  priced: PricedRequest,
  meter: Parameters<typeof executeProviderRequest>[0]["meter"],
  catalog: ReturnType<typeof createCatalog>,
) {
  // @ts-expect-error Only the pricing step can create the nominal request.
  void dispatchPricedRequest(request, fetch, new AbortController().signal, null);
  // @ts-expect-error Authenticated credentials or an explicit null are required.
  void dispatchPricedRequest(priced, fetch, new AbortController().signal);
  void executeProviderRequest({
    meter,
    catalog,
    // @ts-expect-error A plain provider request cannot enter execution.
    request,
    dispatch: async () => ({ response: { status: 200 }, body: null }),
  });
  const input = {
    operationId: "unpriced",
    provider: "example",
    scope: { namespace: "test", principal: "u", connection: "c" },
    fundingSource: "byok" as const,
    costOwner: "u",
    source: "app" as const,
    surface: "app" as const,
  };
  // @ts-expect-error Even correctly shaped constructor inputs cannot bypass pricing.
  new PricedRequest(
    "GET",
    "https://example.com",
    {},
    request,
    { operation: "unknown" },
    input,
    { outcome: "invalid", field: "estimate", reason: "test" },
    [],
    undefined,
  );
}
void rejectsRawRequests;

test.each(["bigint", "cycle"])(
  "host %s body is a pricing error before any Meter call",
  async (kind) => {
    const catalog = createCatalog({ providers: [dataforseo], enabled: ["dataforseo"] });
    const clock = createManualClock();
    const meter = createMeter({
      store: createMemoryStore({ budgets: [], clock }),
      clock,
      catalog,
      resolveConnection: () => ({ provider: "dataforseo", fundingSource: "byok" }),
    });
    const reserve = vi.spyOn(meter, "reserve");
    const body: Record<string, unknown> = { value: 1n };
    if (kind === "cycle") body.value = body;
    const failure = await PricedRequest.price({
      meter,
      catalog,
      input: {
        operationId: "invalid",
        provider: "dataforseo",
        scope: { namespace: "test", principal: "u", connection: "c" },
        source: "app",
        surface: "app",
        fundingSource: "byok",
        costOwner: "u",
      },
      request: { method: "POST", url: "/v3/serp/google/organic/live/advanced", body },
    }).catch((error: unknown) => error);
    expect.soft(failure).toBeInstanceOf(RequestPricingError);
    expect.soft(failure).toMatchObject({ code: "invalid_provider_request" });
    expect(reserve).not.toHaveBeenCalled();
  },
);

const credentialAuth: ProviderAuth[] = [
  { kind: "bearer" },
  { kind: "basic" },
  { kind: "header", name: "X-Provider-Key", prefix: "Key " },
  { kind: "query", param: "provider_key" },
];
const serialize = (value: unknown) =>
  JSON.stringify(value, (_, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );

test.each(credentialAuth)(
  "$kind credentials never enter pricing or its immutable snapshot",
  async (auth) => {
    const module = { ...serpapi, descriptor: { ...serpapi.descriptor, auth } };
    const catalog = createCatalog({ providers: [module], enabled: ["serpapi"] });
    const clock = createManualClock();
    const meter = createMeter({
      store: createMemoryStore({ budgets: [], clock }),
      clock,
      catalog,
      resolveConnection: () => ({ provider: "serpapi", fundingSource: "byok", plan: "starter" }),
    });
    const match = vi.spyOn(catalog, "match");
    const reserve = vi.spyOn(meter, "reserve");
    const extract = vi.spyOn(catalog, "extract");
    const settle = vi.spyOn(meter, "settle");
    const trusted = "trusted-user:trusted-password";
    const caller = "caller-credential";
    const priced = await PricedRequest.price({
      meter,
      catalog,
      input: {
        operationId: "credentials",
        provider: "serpapi",
        scope: { namespace: "test", principal: "u", connection: "c" },
        source: "app",
        surface: "app",
        fundingSource: "byok",
        costOwner: "u",
      },
      request: {
        method: "GET",
        url: `/search.json?q=example&api_key=${caller}&token=${caller}&custom_credential=${caller}${auth.kind === "query" ? `&${auth.param}=${caller}` : ""}`,
        headers: {
          Authorization: caller,
          Cookie: caller,
          "X-Api-Key": caller,
          "X-Custom-Credential": caller,
          ...(auth.kind === "header" ? { [auth.name]: caller } : {}),
          Accept: "application/json",
        },
      },
    });
    expect(match).toHaveBeenCalledOnce();
    // Descriptor-specific credentials and generic credentials are absent at the match boundary.
    const matching = serialize(match.mock.calls);
    expect(matching).not.toContain(caller);
    const snapshot = serialize(priced);
    expect(snapshot).not.toContain(caller);
    expect(snapshot).not.toContain(trusted);
    expect(snapshot).not.toContain(btoa(trusted));
    expect(priced.url).toBe("https://serpapi.com/search.json?q=example");
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({ search_metadata: { id: "id", status: "Success" } }),
    );
    await executeProviderRequest({
      meter,
      catalog,
      request: priced,
      dispatch: async (request) => {
        const response = await dispatchPricedRequest(
          request,
          transport,
          new AbortController().signal,
          { secret: trusted },
        );
        return { response: { status: response.status }, body: await response.json() };
      },
    });
    expect(match).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    if (auth.kind === "query")
      expect(new URL(String(url)).searchParams.get(auth.param)).toBe(trusted);
    else if (auth.kind === "basic")
      expect(headers.get("Authorization")).toBe(`Basic ${btoa(trusted)}`);
    else if (auth.kind === "bearer") expect(headers.get("Authorization")).toBe(`Bearer ${trusted}`);
    else expect(headers.get(auth.name)).toBe(`Key ${trusted}`);
    expect(serialize([String(url), [...headers]])).not.toContain(caller);
    expect(serialize([reserve.mock.calls, extract.mock.calls, settle.mock.calls])).not.toContain(
      trusted,
    );
    expect(serialize([reserve.mock.calls, extract.mock.calls, settle.mock.calls])).not.toContain(
      caller,
    );
    expect(serialize(priced)).toBe(snapshot);
  },
);

test.each([
  "https://user:password@serpapi.com/search.json",
  "https://elsewhere.example/search.json",
  "http://serpapi.com/search.json",
  "http://[invalid",
])("direct pricing rejects unsafe destination %s before match or reservation", async (url) => {
  const catalog = createCatalog({ providers: [serpapi], enabled: ["serpapi"] });
  const clock = createManualClock();
  const meter = createMeter({ store: createMemoryStore({ budgets: [], clock }), clock, catalog });
  const match = vi.spyOn(catalog, "match"),
    reserve = vi.spyOn(meter, "reserve");
  await expect(
    PricedRequest.price({
      meter,
      catalog,
      input: {
        operationId: "unsafe",
        provider: "serpapi",
        scope: { namespace: "test", principal: "u", connection: "c" },
        source: "app",
        surface: "app",
        fundingSource: "byok",
        costOwner: "u",
      },
      request: { method: "GET", url },
    }),
  ).rejects.toMatchObject({
    code: "invalid_provider_request",
    message: "invalid_provider_request",
  });
  expect(match).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
});

test("pricing errors cannot echo credential headers or query values", async () => {
  const catalog = createCatalog({ providers: [serpapi], enabled: ["serpapi"] });
  const clock = createManualClock();
  const meter = createMeter({ store: createMemoryStore({ budgets: [], clock }), clock, catalog });
  const reserve = vi.spyOn(meter, "reserve");
  const input = {
    operationId: "error",
    provider: "serpapi",
    scope: { namespace: "test", principal: "u", connection: "c" },
    source: "app" as const,
    surface: "app" as const,
    fundingSource: "byok" as const,
    costOwner: "u",
  };
  vi.spyOn(catalog, "match").mockImplementation((_, request) => {
    throw new Error(JSON.stringify(request));
  });
  const failure = await PricedRequest.price({
    meter,
    catalog,
    input,
    request: {
      method: "GET",
      url: "/search.json?api_key=caller-query",
      headers: { Authorization: "caller-header" },
    },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RequestPricingError);
  expect((failure as Error).message).not.toContain("caller-query");
  expect((failure as Error).message).not.toContain("caller-header");
  await expect(
    PricedRequest.price({
      meter,
      catalog,
      input,
      request: {
        method: "GET",
        url: "/search.json",
        headers: { Authorization: "invalid\nsecret" },
      },
    }),
  ).rejects.toMatchObject({
    code: "invalid_provider_request",
    message: "invalid_provider_request",
  });
  expect(reserve).not.toHaveBeenCalled();
});

test("query authentication preserves every non-auth query byte", async () => {
  const catalog = createCatalog({ providers: [serpapi], enabled: ["serpapi"] });
  const clock = createManualClock();
  const meter = createMeter({
    store: createMemoryStore({ budgets: [], clock }),
    clock,
    catalog,
    resolveConnection: () => ({ provider: "serpapi", fundingSource: "byok", plan: "starter" }),
  });
  const url = "https://serpapi.com/search.json?q=caf%C3%A9~&no_cache&bad=%FF";
  const priced = await PricedRequest.price({
    meter,
    catalog,
    input: {
      operationId: "query-bytes",
      provider: "serpapi",
      scope: { namespace: "test", principal: "u", connection: "c" },
      source: "app",
      surface: "app",
      fundingSource: "byok",
      costOwner: "u",
    },
    request: { method: "GET", url },
  });
  const transport = vi.fn<typeof fetch>(async () => Response.json({}));
  await dispatchPricedRequest(priced, transport, new AbortController().signal, { secret: "a+b&c" });
  expect(priced.url).toBe(url);
  expect(transport.mock.calls[0]![0]).toBe(`${url}&api_key=a%2Bb%26c`);
});

test.each(["bearer", "header"] as const)(
  "invalid %s credentials reject asynchronously without leaking their value",
  async (kind) => {
    const auth: ProviderAuth = kind === "header" ? { kind, name: "X-Provider-Key" } : { kind };
    const catalog = createCatalog({
      providers: [{ ...serpapi, descriptor: { ...serpapi.descriptor, auth } }],
      enabled: ["serpapi"],
    });
    const clock = createManualClock();
    const meter = createMeter({ store: createMemoryStore({ budgets: [], clock }), clock, catalog });
    const priced = await PricedRequest.price({
      meter,
      catalog,
      input: {
        operationId: "invalid-credential",
        provider: "serpapi",
        scope: { namespace: "test", principal: "u", connection: "c" },
        source: "app",
        surface: "app",
        fundingSource: "byok",
        costOwner: "u",
      },
      request: { method: "GET", url: "/search.json" },
    });
    const transport = vi.fn<typeof fetch>();
    for (const secret of ["private-marker\nsecond-line", "private-marker-\u2011-unicode"]) {
      let pending: Promise<Response> | undefined;
      expect(() => {
        pending = dispatchPricedRequest(priced, transport, new AbortController().signal, {
          secret,
        });
      }).not.toThrow();
      await expect(pending).rejects.toMatchObject({ message: "invalid_provider_credentials" });
      await pending!.catch((error: Error) => expect(String(error)).not.toContain("private-marker"));
    }
    expect(transport).not.toHaveBeenCalled();
  },
);
