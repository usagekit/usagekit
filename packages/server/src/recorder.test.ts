import { afterEach, expect, test, vi } from "vitest";
import type { ProviderAuth } from "@usagekit/core";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteMeter } from "@usagekit/client";
import { createManualClock } from "@usagekit/store";
import {
  createCatalog,
  dataforseo,
  serpapi,
  loadFixtures,
  PricedRequest,
} from "@usagekit/providers";
import { startServer } from "./index.js";
import { createRecorder } from "./recorder.js";
import { createMeter } from "@usagekit/meter";
import { createMemoryStore } from "@usagekit/store";
import { redactFixture } from "./redaction.js";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const access = {
  namespace: "local",
  readablePrincipals: "*" as const,
  readableGroups: "*" as const,
  readablePools: "*" as const,
  canReadBillingDetail: true,
  canManageBudgets: true,
};
async function harness(
  response: () => Promise<Response> = async () =>
    Response.json({ search_metadata: { id: "search-1", status: "Success" } }),
  enabledProviders?: string[],
) {
  const dir = mkdtempSync(join(tmpdir(), "usagekit-catalog-"));
  dirs.push(dir);
  const transport = vi.fn<typeof fetch>(response),
    clock = createManualClock("2026-09-26T12:00:00Z");
  let token = "";
  const s = await startServer({
    configDir: dir,
    port: 0,
    passphrase: "fixture-password",
    clock,
    providerFetch: transport,
    ...(enabledProviders ? { enabledProviders } : {}),
    onToken: (t) => {
      token = t;
    },
  });
  const send = (path: string, data: unknown) =>
    s.app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const add = (metadata: Record<string, unknown> = {}) =>
    send("/providers/connections", {
      provider: "serpapi",
      connectionId: "c",
      secret: "secret-marker-123",
      plan: "starter",
      ...metadata,
    });
  const record = (
    data: unknown = {
      operation: "search",
      request: { method: "GET", url: "/search.json?q=example" },
    },
  ) => send("/providers/connections/c/record", data);
  const meter = createRemoteMeter({ baseUrl: s.url, token });
  return { s, dir, transport, clock, token, send, add, record, meter };
}
test("recording dispatches once, settles and saves a private redacted fixture", async () => {
  const h = await harness(async () =>
    Response.json({
      search_metadata: { id: "search-1", status: "Success" },
      account_email: "person@example.com",
      nested: { api_key: "secret-marker-123" },
      url: "https://serpapi.com/search?api_key=secret-marker-123",
    }),
  );
  try {
    expect((await h.add()).status).toBe(200);
    const result = await h.record(),
      data = (await result.json()) as { path: string; operationId: string };
    expect(result.status).toBe(200);
    expect(h.transport).toHaveBeenCalledTimes(1);
    const [url, init] = h.transport.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get("api_key")).toBe("secret-marker-123");
    expect(init?.redirect).toBe("error");
    const text = readFileSync(data.path, "utf8");
    expect(text).not.toContain("secret-marker-123");
    expect(text).not.toContain("person@example.com");
    expect(statSync(data.path).mode & 0o777).toBe(0o600);
    expect(loadFixtures({ [data.path]: JSON.parse(text) })[0]).toMatchObject({
      origin: "recorded",
      operation: "search",
    });
    expect(
      await h.meter.getOperation(access, {
        namespace: "local",
        principal: "local",
        operationId: data.operationId,
      }),
    ).toMatchObject({
      outcome: "ok",
      value: {
        state: "settled",
        estimateSource: "list",
        receipts: [{ providerRequestId: "search-1" }],
      },
    });
  } finally {
    await h.s.stop();
  }
});
test("budget denial and mismatched/foreign requests never dispatch", async () => {
  const h = await harness();
  try {
    await h.add();
    for (const request of [
      { method: "GET", url: "https://example.com/search.json" },
      { method: "GET", url: "https://user:password@serpapi.com/search.json" },
      { method: "GET", url: "/account.json" },
      { method: "GET", url: "/search.json", body: {} },
      { method: "GET", url: "/search.json", headers: { x: 1 } },
    ])
      expect((await h.record({ operation: "search", request })).status).toBe(400);
    h.s.store.putBudget({
      id: "zero",
      version: 1,
      scope: { kind: "principal", namespace: "local", principal: "local" },
      surface: "any",
      unit: "units",
      limit: { value: 0n, scale: 0, unit: "units" },
      window: { kind: "calendar_month", timezone: "UTC" },
      onExceed: "block",
    });
    expect((await h.record()).status).toBe(409);
    expect(h.transport).not.toHaveBeenCalled();
    expect((await h.record({})).status).toBe(400);
  } finally {
    await h.s.stop();
  }
});
test("transport failure keeps possible charges pending and does not retry", async () => {
  const h = await harness(async () => {
    throw new Error("secret-marker-123");
  });
  try {
    await h.add();
    const response = await h.record(),
      text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toContain("secret-marker-123");
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(
      await h.meter.getOperation(access, {
        namespace: "local",
        principal: "local",
        operationId: JSON.parse(text).operationId,
      }),
    ).toMatchObject({ outcome: "ok", value: { state: "pending" } });
  } finally {
    await h.s.stop();
  }
});
test("free and passthrough calls are counted without creating reservations", async () => {
  const h = await harness();
  try {
    await h.add({ tracking: { search: "passthrough" } });
    for (const input of [
      undefined,
      { operation: "account", request: { method: "GET", url: "/account.json" } },
    ]) {
      const response = await h.record(input),
        data = (await response.json()) as { operationId: string };
      expect(response.status).toBe(200);
      expect(
        await h.meter.getOperation(access, {
          namespace: "local",
          principal: "local",
          operationId: data.operationId,
        }),
      ).toEqual({ outcome: "ok", value: null });
    }
    expect(
      await h.meter.requestCounts(access, {
        scope: { kind: "principal", namespace: "local", principal: "local" },
        from: "2026-09-26T00:00:00Z",
        to: "2026-09-27T00:00:00Z",
        groupBy: [],
      }),
    ).toMatchObject({ outcome: "ok", value: { rows: [{ state: "passthrough", count: 2n }] } });
  } finally {
    await h.s.stop();
  }
});
test("connection policy persists through key rotation and restart; invalid policy is rejected", async () => {
  const h = await harness();
  try {
    expect((await h.add({ plan: "typo" })).status).toBe(400);
    expect((await h.add({ tracking: { search: "typo" } })).status).toBe(400);
    expect((await h.add({ tracking: { typo: "passthrough" } })).status).toBe(400);
    await h.add({ tracking: { search: "passthrough" } });
    expect(
      await (
        await h.send("/providers/connections", {
          provider: "serpapi",
          connectionId: "c",
          secret: "rotated-key",
        })
      ).json(),
    ).toMatchObject({ plan: "starter", tracking: { search: "passthrough" } });
    await h.s.stop();
    const restarted = await startServer({
      configDir: h.dir,
      port: 0,
      passphrase: "fixture-password",
      onToken: () => {},
    });
    try {
      expect(restarted.vault.list()).toMatchObject([
        { plan: "starter", tracking: { search: "passthrough" } },
      ]);
    } finally {
      await restarted.stop();
    }
  } finally {
    await h.s.stop();
  }
});
test("disabled providers cannot be recorded", async () => {
  const h = await harness(undefined, []);
  try {
    await h.add({ plan: undefined });
    expect((await h.record()).status).toBe(400);
    expect(h.transport).not.toHaveBeenCalled();
  } finally {
    await h.s.stop();
  }
});
test("basic credentials and account identities are removed even from echoed text", () => {
  const raw = {
    request: {
      headers: {
        Authorization: "Basic " + Buffer.from("person@example.com:secret-value").toString("base64"),
      },
    },
    response: {
      body: {
        login: "person@example.com",
        url: "https://example.com/?api_key=other-key",
        nested: "secret-value person@example.com",
      },
    },
  };
  const output = JSON.stringify(
    redactFixture(raw, dataforseo.descriptor, [
      "person@example.com:secret-value",
      "person@example.com",
      "secret-value",
    ]),
  );
  for (const marker of ["person@example.com", "secret-value", "other-key"])
    expect(output).not.toContain(marker);
});
test("all bundled plans produce budgets accepted by the durable store", async () => {
  const h = await harness();
  try {
    const catalog = createCatalog({
      providers: [dataforseo, serpapi],
      enabled: ["dataforseo", "serpapi"],
    });
    for (const provider of catalog.providers())
      for (const plan of provider.plans) {
        const b = catalog.proposeBudget(provider.id, plan.id, {
          namespace: "local",
          connection: provider.id + ":" + plan.id,
          now: h.clock.now(),
          probe: { remaining: { unit: provider.billing.unit, value: 100n, scale: 0 } },
        });
        expect(h.s.store.putBudget(b).outcome).toBe("saved");
      }
  } finally {
    await h.s.stop();
  }
});

test("basic-auth recording preserves JSON text and strips caller credentials from dispatch and fixture", async () => {
  const h = await harness(async () =>
    Response.json({ status_code: 20000, cost: 0.002, tasks: [] }),
  );
  try {
    await h.add({
      provider: "dataforseo",
      plan: "prepaid",
      secret: "login@example.com:basic-secret",
    });
    const body = JSON.stringify([{ keyword: "example" }]);
    const result = await h.record({
      operation: "serp.google.organic.live.advanced",
      request: {
        method: "POST",
        url: "/v3/serp/google/organic/live/advanced",
        body,
        headers: {
          "Content-Type": "application/json",
          Authorization: "caller-secret",
          "x-custom-key": "other-secret",
        },
      },
    });
    expect(result.status).toBe(200);
    const [, init] = h.transport.mock.calls[0]!;
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(body);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(
      "Basic " + Buffer.from("login@example.com:basic-secret").toString("base64"),
    );
    expect(headers.has("x-custom-key")).toBe(false);
    const resultBody = (await result.json()) as { path: string },
      text = readFileSync(resultBody.path, "utf8");
    for (const secret of ["login@example.com", "basic-secret", "caller-secret", "other-secret"])
      expect(text).not.toContain(secret);
  } finally {
    await h.s.stop();
  }
});

test("recording prices and forwards the same canonical JSON value", async () => {
  const h = await harness(async () =>
    Response.json({ status_code: 20000, cost: 0.002, tasks: [] }),
  );
  try {
    await h.add({ provider: "dataforseo", plan: "prepaid", secret: "login:password" });
    const body = '[ { "keyword": "example", "depth": 700, "depth": 10 } ]';
    const result = await h.record({
      operation: "serp.google.organic.live.advanced",
      request: {
        method: "POST",
        url: "/v3/serp/google/organic/live/advanced",
        body,
        headers: { "Content-Type": "Application/JSON; charset=utf-8" },
      },
    });
    expect(result.status).toBe(200);
    const [, init] = h.transport.mock.calls[0]!;
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(
      '[{"keyword":"example","depth":10}]',
    );
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    const { path } = (await result.json()) as { path: string };
    expect(JSON.parse(readFileSync(path, "utf8")).request.body).toEqual([
      { keyword: "example", depth: 10 },
    ]);
  } finally {
    await h.s.stop();
  }
});

test.each([
  ["JSON text with two tasks", "application/json", '[{"depth":700},{"depth":700}]'],
  ["JSON text without a media type", undefined, '[{"depth":700},{"depth":700}]'],
  ["non-JSON media type", "text/plain", '[{"depth":700}]'],
  ["invalid JSON text", "application/json", '[{"depth":700}'],
])("billable recording rejects %s before reservation or upstream", async (_case, type, body) => {
  const h = await harness();
  try {
    await h.add({ provider: "dataforseo", plan: "prepaid", secret: "login:password" });
    const result = await h.record({
      operation: "serp.google.organic.live.advanced",
      request: {
        method: "POST",
        url: "/v3/serp/google/organic/live/advanced",
        body,
        ...(type ? { headers: { "Content-Type": type } } : {}),
      },
    });
    expect(h.transport).not.toHaveBeenCalled();
    expect(result.status).toBe(400);
  } finally {
    await h.s.stop();
  }
});

test("oversized streamed response is cancelled and possible charges stay pending", async () => {
  let cancelled = false;
  const h = await harness(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  try {
    await h.add();
    const response = await h.record(),
      result = (await response.json()) as { operationId: string };
    expect(response.status).toBe(502);
    expect(cancelled).toBe(true);
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(
      await h.meter.getOperation(access, {
        namespace: "local",
        principal: "local",
        operationId: result.operationId,
      }),
    ).toMatchObject({ outcome: "ok", value: { state: "pending" } });
  } finally {
    await h.s.stop();
  }
});

test("manual prices and explicit overage survive key rotation and lock, and reject invalid quantities", async () => {
  const h = await harness();
  try {
    for (const manualPrices of [
      { search: { value: "-1", scale: 0, unit: "units" } },
      { search: { value: "1", scale: 19, unit: "units" } },
      { search: { value: "1", scale: 0, unit: "cents" } },
      { account: { value: "1", scale: 0, unit: "units" } },
    ])
      expect((await h.add({ manualPrices })).status).toBe(400);
    expect((await h.add({ overage: "true" })).status).toBe(400);
    expect(
      (
        await h.add({
          manualPrices: { search: { value: "25", scale: 1, unit: "units" } },
          overage: true,
        })
      ).status,
    ).toBe(200);
    await h.add();
    h.s.vault.lock();
    expect(h.s.vault.list()[0]).toMatchObject({
      overage: true,
      manualPrices: { search: { value: "25", scale: 1, unit: "units" } },
    });
    const reserve = await h.meter.reserve({
      operationId: "manual",
      scope: { namespace: "local", principal: "local", connection: "c" },
      provider: "serpapi",
      operation: "search",
      source: "cli",
      surface: "programmatic",
      fundingSource: "byok",
      costOwner: "local",
    });
    expect(reserve).toMatchObject({
      outcome: "reserved",
      operation: {
        estimateSource: "manual",
        estimate: [
          { unit: "units", value: 25n, scale: 1 },
          { unit: "requests", value: 1n },
        ],
      },
    });
  } finally {
    await h.s.stop();
  }
});
test("five settled receipts enable measured pricing; manual override still wins", async () => {
  const h = await harness(async () =>
    Response.json({
      status_code: 20000,
      cost: 0.02,
      tasks: [{ id: "task", status_code: 20000, cost: 0.02, result: [] }],
    }),
  );
  const operation = "serp.google.organic.live.advanced";
  try {
    expect(
      (await h.add({ provider: "dataforseo", secret: "user:password", plan: "prepaid" })).status,
    ).toBe(200);
    for (let i = 0; i < 6; i++) {
      const result = await h.record({
        operation,
        request: {
          method: "POST",
          url: "/v3/serp/google/organic/live/advanced",
          body: [{ keyword: "example" }],
        },
      });
      expect(result.status).toBe(200);
      const { operationId } = (await result.json()) as { operationId: string };
      const op = await h.meter.getOperation(access, {
        namespace: "local",
        principal: "local",
        operationId,
      });
      expect(op).toMatchObject({
        outcome: "ok",
        value: { estimateSource: i < 5 ? "list" : "measured" },
      });
    }
    expect(h.transport).toHaveBeenCalledTimes(6);
    await h.add({
      provider: "dataforseo",
      plan: "prepaid",
      manualPrices: { [operation]: { unit: "cents", value: "3", scale: 0 } },
    });
    const op = await h.meter.reserve({
      operationId: "override",
      scope: { namespace: "local", principal: "local", connection: "c" },
      provider: "dataforseo",
      operation,
      source: "cli",
      surface: "programmatic",
      fundingSource: "byok",
      costOwner: "local",
    });
    expect(op).toMatchObject({ outcome: "reserved", operation: { estimateSource: "manual" } });
  } finally {
    await h.s.stop();
  }
});

test.each(["passthrough", "unpriced"])(
  "connection HTTP API rejects platform billable %s tracking with a clear invalid result",
  async (tracking) => {
    const h = await harness();
    try {
      const response = await h.add({ fundingSource: "platform", tracking: { search: tracking } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        outcome: "invalid",
        field: "tracking.search",
        reason: expect.stringContaining("credits"),
      });
      expect(h.s.vault.list()).toEqual([]);
      expect(h.transport).not.toHaveBeenCalled();
    } finally {
      await h.s.stop();
    }
  },
);

test.each(["application/vnd.api+json", undefined])(
  "non-body-priced recording preserves a large integer and media type %s",
  async (contentType) => {
    const h = await harness();
    try {
      await h.add();
      const body = ' { "id": 1152921504606846976 } ';
      const provider = {
        ...serpapi,
        descriptor: {
          ...serpapi.descriptor,
          operations: serpapi.descriptor.operations.map((op) => ({
            ...op,
            match: op.match.map((m) => ({ ...m, method: "POST" as const })),
          })),
        },
      };
      const catalog = createCatalog({ providers: [provider], enabled: ["serpapi"] });
      const meter = createMeter({
        store: createMemoryStore({ budgets: [], clock: h.clock }),
        clock: h.clock,
        catalog,
        resolveConnection: () => ({ provider: "serpapi", fundingSource: "byok", plan: "starter" }),
      });
      const record = createRecorder({
        meter,
        catalog,
        vault: h.s.vault,
        dir: h.dir,
        clock: h.clock,
        transport: h.transport,
      });
      const result = await record("c", {
        operation: "search",
        request: {
          method: "POST",
          url: "/search.json?q=example",
          ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
          body,
        },
      });
      expect(result.status).toBe(200);
      const [, init] = h.transport.mock.calls[0]!;
      const sent =
        typeof init?.body === "string"
          ? init.body
          : new TextDecoder().decode(init?.body as Uint8Array);
      expect(sent).toBe(body);
      expect(new Headers(init?.headers).get("Content-Type")).toBe(contentType ?? null);
    } finally {
      await h.s.stop();
    }
  },
);

test("recorder propagates a Meter reserve failure unchanged", async () => {
  const h = await harness();
  try {
    await h.add();
    const catalog = createCatalog({ providers: [serpapi], enabled: ["serpapi"] });
    const meter = createMeter({
      store: createMemoryStore({ budgets: [], clock: h.clock }),
      clock: h.clock,
      catalog,
      resolveConnection: () => ({ provider: "serpapi", fundingSource: "byok", plan: "starter" }),
    });
    const failure = new Error("reserve failed");
    vi.spyOn(meter, "reserve").mockRejectedValueOnce(failure);
    const record = createRecorder({
      meter,
      catalog,
      vault: h.s.vault,
      dir: h.dir,
      clock: h.clock,
      transport: h.transport,
    });
    await expect(
      record("c", { operation: "search", request: { method: "GET", url: "/search.json" } }),
    ).rejects.toBe(failure);
    expect(h.transport).not.toHaveBeenCalled();
  } finally {
    await h.s.stop();
  }
});

test.each(["bearer", "basic", "header", "query"] as const)(
  "recorder keeps %s credentials outside pricing and accounting",
  async (kind) => {
    const h = await harness();
    const trusted = "vault-user:vault-password",
      caller = "caller-secret";
    try {
      await h.add({ secret: trusted });
      const auth: ProviderAuth =
        kind === "query"
          ? { kind, param: "provider_key" }
          : kind === "header"
            ? { kind, name: "X-Provider-Key", prefix: "Key " }
            : { kind };
      const catalog = createCatalog({
        providers: [{ ...serpapi, descriptor: { ...serpapi.descriptor, auth } }],
        enabled: ["serpapi"],
      });
      const meter = createMeter({
        store: createMemoryStore({ budgets: [], clock: h.clock }),
        clock: h.clock,
        catalog,
        resolveConnection: () => ({ provider: "serpapi", fundingSource: "byok", plan: "starter" }),
      });
      const match = vi.spyOn(catalog, "match"),
        extract = vi.spyOn(catalog, "extract");
      const reserve = vi.spyOn(meter, "reserve"),
        settle = vi.spyOn(meter, "settle");
      const price = vi.spyOn(PricedRequest, "price");
      const record = createRecorder({
        meter,
        catalog,
        vault: h.s.vault,
        dir: h.dir,
        clock: h.clock,
        transport: h.transport,
      });
      const result = await record("c", {
        operation: "search",
        request: {
          method: "GET",
          url: `/search.json?q=example&api_key=${caller}&custom_credential=${caller}${auth.kind === "query" ? `&${auth.param}=${caller}` : ""}`,
          headers: { Authorization: caller, Cookie: caller, "X-Custom-Credential": caller },
        },
      });
      expect(result.status).toBe(200);
      const priced = await price.mock.results.at(-1)!.value;
      for (const observed of [
        priced,
        match.mock.calls,
        extract.mock.calls,
        reserve.mock.calls,
        settle.mock.calls,
      ]) {
        const text = JSON.stringify(observed, (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        );
        for (const secret of [trusted, caller, btoa(trusted)]) expect(text).not.toContain(secret);
      }
      expect(match).toHaveBeenCalledOnce();
      const [url, init] = h.transport.mock.calls[0]!;
      const headers = new Headers(init?.headers);
      if (auth.kind === "query")
        expect(new URL(String(url)).searchParams.get(auth.param)).toBe(trusted);
      else if (auth.kind === "basic")
        expect(headers.get("Authorization")).toBe(`Basic ${btoa(trusted)}`);
      else if (auth.kind === "bearer")
        expect(headers.get("Authorization")).toBe(`Bearer ${trusted}`);
      else expect(headers.get(auth.name)).toBe(`Key ${trusted}`);
      const text = readFileSync((result.body as { path: string }).path, "utf8");
      for (const secret of [trusted, caller, btoa(trusted)]) expect(text).not.toContain(secret);
      price.mockRestore();
    } finally {
      await h.s.stop();
    }
  },
);

test.each(["bearer", "header"] as const)(
  "recorder rejects malformed trusted %s credentials before admission",
  async (kind) => {
    const h = await harness();
    try {
      const auth: ProviderAuth = kind === "header" ? { kind, name: "X-Provider-Key" } : { kind };
      const catalog = createCatalog({
        providers: [{ ...serpapi, descriptor: { ...serpapi.descriptor, auth } }],
        enabled: ["serpapi"],
      });
      const meter = createMeter({
        store: createMemoryStore({ budgets: [], clock: h.clock }),
        clock: h.clock,
        catalog,
        resolveConnection: () => ({ provider: "serpapi", fundingSource: "byok", plan: "starter" }),
      });
      const match = vi.spyOn(catalog, "match"),
        reserve = vi.spyOn(meter, "reserve"),
        intent = vi.spyOn(meter, "markDispatchIntent");
      const record = createRecorder({
        meter,
        catalog,
        vault: h.s.vault,
        dir: h.dir,
        clock: h.clock,
        transport: h.transport,
      });
      for (const secret of ["private-marker\nsecond-line", "private-marker-\u2011-unicode"]) {
        await h.add({ secret });
        expect(
          await record("c", {
            operation: "search",
            request: { method: "GET", url: "/search.json" },
          }),
        ).toEqual({ status: 400, body: { error: "invalid_request" } });
      }
      expect(match).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(intent).not.toHaveBeenCalled();
      expect(h.transport).not.toHaveBeenCalled();
    } finally {
      await h.s.stop();
    }
  },
);
