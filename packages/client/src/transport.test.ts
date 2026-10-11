import { expect, test } from "vitest";
import { Hono } from "hono";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createMeter } from "@usagekit/meter";
import { createUsageHandlers } from "@usagekit/http";
import type { AccessContext } from "@usagekit/core";
import { createRemoteMeter, RemoteUnavailable } from "./index.js";
const access: AccessContext = {
  namespace: "test",
  readablePrincipals: "*",
  readableGroups: "*",
  readablePools: "*",
  canReadBillingDetail: true,
  canManageBudgets: true,
};
const quoteInput = {
  scope: { namespace: "test", principal: "u", connection: "c" },
  provider: "example",
  operation: "search",
  fundingSource: "byok" as const,
  costOwner: "u",
  surface: "app" as const,
  source: "app" as const,
};
const quoteValue = {
  quantities: [{ value: 15n, scale: 5, unit: "cents" }],
  tracking: "metered",
  estimateSource: "measured",
  providerPriceVersion: "exact-v1",
  checkedAt: "2026-10-01T00:00:00Z",
  sampleSize: 5,
  budgets: [],
  asOf: "2026-10-01T00:00:00Z",
};
const stubQuote = (body: unknown) =>
  createRemoteMeter({
    baseUrl: "http://local.test",
    token: "token",
    fetch: async () =>
      new Response(
        JSON.stringify(body, (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ),
  });

test.each([
  ["missing tracking", { ...quoteValue, tracking: undefined }],
  ["unknown tracking", { ...quoteValue, tracking: "free" }],
  ["numeric quantity", { ...quoteValue, quantities: [{ value: 15, scale: 5, unit: "cents" }] }],
  ["scale above 18", { ...quoteValue, quantities: [{ value: 15n, scale: 19, unit: "cents" }] }],
  ["fractional scale", { ...quoteValue, quantities: [{ value: 15n, scale: 1.5, unit: "cents" }] }],
  ["negative scale", { ...quoteValue, quantities: [{ value: 15n, scale: -1, unit: "cents" }] }],
  ["empty unit", { ...quoteValue, quantities: [{ value: 15n, scale: 5, unit: "" }] }],
  ["missing quantities", { ...quoteValue, quantities: undefined }],
  ["non-array quantities", { ...quoteValue, quantities: {} }],
  ["null quantity", { ...quoteValue, quantities: [null] }],
  ["unknown estimate source", { ...quoteValue, estimateSource: "host" }],
  ["null estimate source", { ...quoteValue, estimateSource: null }],
  ["non-string price version", { ...quoteValue, providerPriceVersion: 1 }],
  ["non-string checkedAt", { ...quoteValue, checkedAt: null }],
  ["negative sample size", { ...quoteValue, sampleSize: -1 }],
  ["fractional sample size", { ...quoteValue, sampleSize: 1.5 }],
  ["unsafe sample size", { ...quoteValue, sampleSize: Number.MAX_SAFE_INTEGER + 1 }],
  ["non-numeric sample size", { ...quoteValue, sampleSize: "5" }],
  ["missing budgets", { ...quoteValue, budgets: undefined }],
  ["non-array budgets", { ...quoteValue, budgets: {} }],
  ["null budget", { ...quoteValue, budgets: [null] }],
  ["array budget", { ...quoteValue, budgets: [[]] }],
  ["primitive budget", { ...quoteValue, budgets: [1] }],
  ["missing asOf", { ...quoteValue, asOf: undefined }],
  ["non-string asOf", { ...quoteValue, asOf: 1 }],
])("malformed quote value: %s throws RemoteUnavailable", async (_name, value) => {
  await expect(
    stubQuote({ outcome: "ok", value }).quote(access, quoteInput),
  ).rejects.toBeInstanceOf(RemoteUnavailable);
});

test.each([
  ["unknown outcome", { outcome: "maybe", value: quoteValue }],
  ["missing value", { outcome: "ok" }],
  ["null value", { outcome: "ok", value: null }],
  ["array value", { outcome: "ok", value: [] }],
  ["missing invalid field", { outcome: "invalid", reason: "bad input" }],
  ["non-string invalid field", { outcome: "invalid", field: 1, reason: "bad input" }],
  ["missing invalid reason", { outcome: "invalid", field: "estimate" }],
  ["non-string invalid reason", { outcome: "invalid", field: "estimate", reason: null }],
  ["array response", []],
])("malformed quote result: %s throws RemoteUnavailable", async (_name, body) => {
  await expect(stubQuote(body).quote(access, quoteInput)).rejects.toBeInstanceOf(RemoteUnavailable);
});

test.each([
  { outcome: "ok", value: quoteValue },
  {
    outcome: "ok",
    value: { quantities: [], tracking: "unpriced", budgets: [], asOf: quoteValue.asOf },
  },
  {
    outcome: "ok",
    value: {
      ...quoteValue,
      tracking: "passthrough",
      estimateSource: "unknown",
      quantities: [
        { value: -123456789012345678901234567890n, scale: 0, unit: "tokens" },
        { value: 0n, scale: 18, unit: "cents" },
      ],
      sampleSize: 0,
    },
  },
  {
    outcome: "ok",
    value: { ...quoteValue, estimateSource: "manual", sampleSize: Number.MAX_SAFE_INTEGER },
  },
  { outcome: "ok", value: { ...quoteValue, estimateSource: "list" } },
  { outcome: "invalid", field: "estimate", reason: "A price is required" },
  { outcome: "forbidden" },
])("valid quote passes through unchanged (case %#)", async (body) => {
  expect(await stubQuote(body).quote(access, quoteInput)).toEqual(body);
});

test("lost response replays same command without double effect", async () => {
  const clock = createManualClock(),
    store = createMemoryStore({ clock, budgets: [] }),
    meter = createMeter({ store, clock }),
    app = new Hono();
  const handler = createUsageHandlers({ meter, authenticate: async () => access });
  app.all("*", (c) => handler(c.req.raw));
  let drop = false;
  const remote = createRemoteMeter({
    baseUrl: "http://local.test",
    token: "local-token",
    fetch: async (i, init) => {
      const h = new Headers(init?.headers);
      expect(h.get("Authorization")).toBe("Bearer local-token");
      expect(h.has("namespace")).toBe(false);
      expect(h.has("principal")).toBe(false);
      const res = await app.request(i, init);
      if (drop) {
        drop = false;
        throw new Error("lost response");
      }
      return res;
    },
  });
  const r = await remote.reserve({
    operationId: "op",
    scope: { namespace: "test", principal: "u", connection: "c" },
    fundingSource: "byok",
    costOwner: "u",
    surface: "app",
    source: "app",
    provider: "example",
    operation: "search",
    estimate: [],
  });
  if (r.outcome !== "reserved") throw new Error("fixture");
  const command = {
    namespace: "test",
    principal: "u",
    operationId: "op",
    commandId: "release-stable",
    expectedVersion: 1,
    reason: "cancel",
  };
  drop = true;
  await expect(remote.releaseUndispatched(command)).rejects.toMatchObject({
    name: "RemoteUnavailable",
    requestId: "release-stable",
  });
  expect(await remote.releaseUndispatched(command)).toMatchObject({
    outcome: "released",
    replayed: true,
    operation: { version: 2 },
  });
});
test("network, non-JSON and unexpected server failures remain exceptions", async () => {
  for (const fetcher of [
    async () => {
      throw new Error("secret internal detail");
    },
    async () => new Response("not json"),
    async () => new Response("bad", { status: 500 }),
  ]) {
    const remote = createRemoteMeter({
      baseUrl: "http://local.test",
      token: "token",
      fetch: fetcher,
    });
    await expect(
      remote.usage(access, {
        scope: { kind: "namespace", namespace: "test" },
        from: "2026-09-01T00:00:00Z",
        to: "2026-10-01T00:00:00Z",
        units: [],
        groupBy: [],
      }),
    ).rejects.toBeInstanceOf(RemoteUnavailable);
  }
});

test("read forbidden stays typed; authentication failures and bad wire bodies are explicit", async () => {
  const q = {
    scope: { kind: "namespace" as const, namespace: "test" },
    from: "2026-09-01T00:00:00Z",
    to: "2026-10-01T00:00:00Z",
    units: [],
    groupBy: [],
  };
  const client = (status: number, body = "{}") =>
    createRemoteMeter({
      baseUrl: "http://local.test/",
      token: "token",
      fetch: async () => new Response(body, { status }),
    });
  expect(await client(403).usage(access, q)).toEqual({ outcome: "forbidden" });
  expect(await client(400).usage(access, q)).toMatchObject({ outcome: "invalid" });
  await expect(client(401).usage(access, q)).rejects.toMatchObject({
    name: "RemoteHttpError",
    status: 401,
  });
  await expect(client(200, "null").usage(access, q)).rejects.toBeInstanceOf(RemoteUnavailable);
});

test("real handler quotes pass client validation, preserving read-only GET, exact amounts and access", async () => {
  const clock = createManualClock(),
    store = createMemoryStore({ clock, budgets: [] });
  const meter = createMeter({
    store,
    clock,
    resolveOwnership: async () => ({ kind: "principal", namespace: "test", principal: "u" }),
  });
  const handler = createUsageHandlers({
    meter,
    commands: false,
    authenticate: async () => ({ ...access, readablePrincipals: ["u"] }),
  });
  const remote = createRemoteMeter({
    baseUrl: "http://local.test",
    token: "token",
    fetch: async (url, init) => {
      expect(String(url)).toContain("/v1/quotes?q=");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const encoded = new URL(String(url)).searchParams.get("q")!;
      expect(atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))).not.toContain(
        "readablePrincipals",
      );
      return handler(new Request(url, init));
    },
  });
  const i = {
    scope: { namespace: "test", principal: "u", connection: "c" },
    provider: "example",
    operation: "search",
    fundingSource: "byok" as const,
    costOwner: "u",
    surface: "app" as const,
    source: "app" as const,
    estimate: [{ unit: "cents", value: 15n, scale: 5 }],
    estimateSource: "measured" as const,
    providerPriceVersion: "exact-v1",
  };
  const result = await remote.quote(access, i);
  expect(result).toEqual(await meter.quote(access, i));
  expect(result).toMatchObject({ outcome: "ok", value: { quantities: i.estimate } });
  expect(await remote.quote(access, { ...i, scope: { ...i.scope, principal: "other" } })).toEqual({
    outcome: "forbidden",
  });
  expect(
    await handler(
      new Request("http://local.test/v1/operations/reserve", { method: "POST", body: "{}" }),
    ),
  ).toMatchObject({ status: 404 });
});
