import { afterEach, expect, test, vi } from "vitest";
import type { ProviderAuth } from "@usagekit/core";
import { createMeter } from "@usagekit/meter";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createCatalog, PricedRequest, serpapi } from "@usagekit/providers";
import { createProviderProxy } from "./index.js";

afterEach(() => vi.restoreAllMocks());

const serialize = (value: unknown) =>
  JSON.stringify(value, (_, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
const auths: ProviderAuth[] = [
  { kind: "bearer" },
  { kind: "basic" },
  { kind: "header", name: "X-Provider-Key", prefix: "Key " },
  { kind: "query", param: "provider_key" },
];
test.each(auths.flatMap((auth) => [false, true].map((failure) => ({ auth, failure }))))(
  "proxy keeps $auth.kind credentials outside pricing and accounting (transport failure: $failure)",
  async ({ auth, failure }) => {
    const catalog = createCatalog({
      providers: [{ ...serpapi, descriptor: { ...serpapi.descriptor, auth } }],
      enabled: ["serpapi"],
    });
    const clock = createManualClock();
    const meter = createMeter({
      store: createMemoryStore({ budgets: [], clock }),
      clock,
      catalog,
      resolveConnection: () => ({ provider: "serpapi", fundingSource: "byok", plan: "starter" }),
    });
    const match = vi.spyOn(catalog, "match"),
      extract = vi.spyOn(catalog, "extract");
    const reserve = vi.spyOn(meter, "reserve"),
      settle = vi.spyOn(meter, "settle");
    const price = vi.spyOn(PricedRequest, "price");
    const trusted = "vault-user:vault-password",
      caller = "caller-secret";
    const transport = vi.fn<typeof fetch>(async () => {
      if (failure) throw new Error(`Transport echoed ${trusted}`);
      return Response.json({ search_metadata: { id: "id", status: "Success" } });
    });
    const recordFixture = vi.fn();
    const proxy = createProviderProxy({
      meter,
      catalog,
      transport,
      recordFixture,
      owner: { namespace: "test", principal: "u" },
      connection: () => ({ provider: "serpapi", secret: trusted }),
      authenticate: async () => ({
        namespace: "test",
        readablePrincipals: ["u"],
        readableGroups: [],
        readablePools: [],
        canReadBillingDetail: true,
        canManageBudgets: false,
      }),
    });
    const response = await proxy(
      new Request(
        `http://localhost/proxy/c/search.json?q=example&api_key=${caller}&custom_credential=${caller}${auth.kind === "query" ? `&${auth.param}=${caller}` : ""}`,
        {
          headers: {
            Authorization: caller,
            Cookie: caller,
            "X-Custom-Credential": caller,
            "X-Usagekit-Record-Fixture": "true",
          },
        },
      ),
    );
    expect(response.status).toBe(failure ? 502 : 200);
    expect(await response.text()).not.toContain(trusted);
    if (failure) expect(recordFixture).not.toHaveBeenCalled();
    else expect(recordFixture).toHaveBeenCalledOnce();
    expect(match).toHaveBeenCalledOnce();
    const priced = await price.mock.results.at(-1)!.value;
    for (const observed of [
      priced,
      match.mock.calls,
      extract.mock.calls,
      reserve.mock.calls,
      settle.mock.calls,
      recordFixture.mock.calls[0]?.[0].request,
    ].filter((value) => value !== undefined)) {
      expect(serialize(observed)).not.toContain(trusted);
      expect(serialize(observed)).not.toContain(caller);
      expect(serialize(observed)).not.toContain(btoa(trusted));
    }
    const [url, init] = transport.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    if (auth.kind === "query")
      expect(new URL(String(url)).searchParams.get(auth.param)).toBe(trusted);
    else if (auth.kind === "basic")
      expect(headers.get("Authorization")).toBe(`Basic ${btoa(trusted)}`);
    else if (auth.kind === "bearer") expect(headers.get("Authorization")).toBe(`Bearer ${trusted}`);
    else expect(headers.get(auth.name)).toBe(`Key ${trusted}`);
    expect(serialize([String(url), [...headers]])).not.toContain(caller);
  },
);

test.each(["bearer", "header"] as const)(
  "malformed trusted %s credentials fail before admission",
  async (kind) => {
    const auth: ProviderAuth = kind === "header" ? { kind, name: "X-Provider-Key" } : { kind };
    const catalog = createCatalog({
      providers: [{ ...serpapi, descriptor: { ...serpapi.descriptor, auth } }],
      enabled: ["serpapi"],
    });
    const clock = createManualClock();
    const meter = createMeter({
      store: createMemoryStore({ budgets: [], clock }),
      clock,
      catalog,
      resolveConnection: () => ({ provider: "serpapi", fundingSource: "byok", plan: "starter" }),
    });
    const match = vi.spyOn(catalog, "match"),
      reserve = vi.spyOn(meter, "reserve"),
      intent = vi.spyOn(meter, "markDispatchIntent");
    const transport = vi.fn<typeof fetch>();
    for (const secret of ["private-marker\nsecond-line", "private-marker-\u2011-unicode"]) {
      const proxy = createProviderProxy({
        meter,
        catalog,
        transport,
        owner: { namespace: "test", principal: "u" },
        connection: () => ({ provider: "serpapi", secret }),
        authenticate: async () => ({
          namespace: "test",
          readablePrincipals: ["u"],
          readableGroups: [],
          readablePools: [],
          canReadBillingDetail: true,
          canManageBudgets: false,
        }),
      });
      const response = await proxy(new Request("http://localhost/proxy/c/search.json"));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_provider_credentials" });
    }
    expect(match).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(intent).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);

test.each(["admission", "transport"] as const)(
  "proxy pins connection credentials when the host rotates them during %s",
  async (phase) => {
    const auth: ProviderAuth = { kind: "bearer" };
    const catalog = createCatalog({
      providers: [{ ...serpapi, descriptor: { ...serpapi.descriptor, auth } }],
      enabled: ["serpapi"],
    });
    const clock = createManualClock();
    const meter = createMeter({
      store: createMemoryStore({ budgets: [], clock }),
      clock,
      catalog,
      resolveConnection: () => ({ provider: "serpapi", fundingSource: "byok", plan: "starter" }),
    });
    const trusted = "original-key";
    const shared = { provider: "serpapi", secret: trusted };
    if (phase === "admission") {
      const reserve = meter.reserve.bind(meter);
      vi.spyOn(meter, "reserve").mockImplementation(async (input) => {
        const result = await reserve(input);
        shared.secret = "rotated\ninvalid-header";
        return result;
      });
    }
    const transport = vi.fn<typeof fetch>(async () => {
      if (phase === "transport") shared.secret = "rotated-key";
      return Response.json({ search_metadata: { id: "id", status: "Success" } });
    });
    const recordFixture = vi.fn();
    const proxy = createProviderProxy({
      meter,
      catalog,
      transport,
      recordFixture,
      owner: { namespace: "test", principal: "u" },
      connection: () => shared,
      authenticate: async () => ({
        namespace: "test",
        readablePrincipals: ["u"],
        readableGroups: [],
        readablePools: [],
        canReadBillingDetail: true,
        canManageBudgets: false,
      }),
    });
    const response = await proxy(
      new Request("http://localhost/proxy/c/search.json", {
        headers: { "X-Usagekit-Record-Fixture": "true" },
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(transport).toHaveBeenCalledOnce();
    expect(new Headers(transport.mock.calls[0]![1]?.headers).get("Authorization")).toBe(
      `Bearer ${trusted}`,
    );
    expect(recordFixture).toHaveBeenCalledOnce();
    expect(recordFixture.mock.calls[0]![0].secrets).toContain(trusted);
  },
);
