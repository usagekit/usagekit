import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { compareQuantity } from "@usagekit/core";
import { dataforseo, PricedRequest } from "@usagekit/providers";
import { createProviderProxy } from "./index.js";
import {
  harness,
  mediaType,
  operations,
  owner,
  runs,
  taskVariant,
  unknownKey,
  wireBody,
  worstCase,
} from "../test-support/dataforseo-properties.js";

function proxyHarness(mode: "open" | "money" = "open") {
  const h = harness(mode);
  const transport = vi.fn<typeof fetch>(async () => Response.json({ cost: 0, tasks: [] }));
  const proxy = createProviderProxy({
    ...h,
    owner,
    transport,
    authenticate: async () => ({
      ...owner,
      readablePrincipals: [owner.principal],
      readableGroups: [],
      readablePools: [],
      canReadBillingDetail: true,
      canManageBudgets: false,
    }),
    connection: () => ({ provider: "dataforseo", secret: "test-only" }),
  });
  return { ...h, transport, proxy };
}
const request = (operation: string, body: string, contentType: string) =>
  new Request(`http://localhost/proxy/c/v3/${operation.replaceAll(".", "/")}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });

test.each(operations)(
  "proxy %s: sends only the priced serialization at the documented bound",
  async (operation) => {
    await fc.assert(
      fc.asyncProperty(
        taskVariant(operation),
        mediaType,
        fc.boolean(),
        async ({ task, operatorCount }, contentType, duplicate) => {
          const h = proxyHarness();
          const price = vi.spyOn(PricedRequest, "price");
          const match = vi.spyOn(h.catalog, "match");
          try {
            const response = await h.proxy(
              request(operation, wireBody(task, duplicate, " \n"), contentType),
            );
            expect(response.status).toBe(200);
            await response.text();
            expect(price).toHaveBeenCalledOnce();
            expect(match).toHaveBeenCalledOnce();
            const priced = (await price.mock.results[0]!.value) as PricedRequest;
            expect(h.transport).toHaveBeenCalledOnce();
            const [url, init] = h.transport.mock.calls[0]!;
            expect(url).toBe(priced.url);
            expect(init?.method).toBe(priced.method);
            const transportHeaders = new Headers(init?.headers);
            expect(transportHeaders.get("authorization")).toBe(`Basic ${btoa("test-only")}`);
            transportHeaders.delete("authorization");
            expect(Object.fromEntries(transportHeaders)).toEqual(priced.headers);
            expect(init?.body).toEqual(priced.body);
            expect(priced.parsed.body).toEqual([task]);
            expect(init?.body).toEqual(
              new TextEncoder().encode(JSON.stringify(priced.parsed.body)),
            );
            expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
            const bound = worstCase(operation, task, operatorCount);
            const money = priced.estimate.find((q) => q.unit === "cents");
            if (bound === null) expect(money).toBeUndefined();
            else {
              expect(money).toBeDefined();
              expect(
                compareQuantity(money!, { unit: "cents", value: bound, scale: 4 }),
              ).toBeGreaterThanOrEqual(0);
            }
          } finally {
            price.mockRestore();
          }
        },
      ),
      runs,
    );
  },
);

test.each(operations)("proxy %s: unknown fields cannot cross a money budget", async (operation) => {
  await fc.assert(
    fc.asyncProperty(
      taskVariant(operation),
      unknownKey,
      fc.jsonValue(),
      mediaType,
      async ({ task }, key, value, contentType) => {
        const h = proxyHarness("money");
        const response = await h.proxy(
          request(operation, wireBody({ ...task, [key]: value }, true, " "), contentType),
        );
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ error: "cannot_estimate_bounded_usage" });
        expect(h.transport).not.toHaveBeenCalled();
      },
    ),
    runs,
  );
});

test("proxy properties cover every billable operation", () => {
  expect([...operations].sort()).toEqual(
    dataforseo.descriptor.operations
      .filter((operation) => operation.billable)
      .map((operation) => operation.id)
      .sort(),
  );
});

test.each(operations)(
  "proxy %s: unsupported media types and numeric edges never dispatch",
  async (operation) => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("text/plain", "application/jsonp", "application/x-json"),
        fc.constantFrom("0", "-1", "1.5", "1e400", "9007199254740992", '"100"'),
        async (contentType, edge) => {
          for (const [type, body] of [
            [contentType, "[{}]"],
            [
              "application/json",
              `[{"${operation.startsWith("serp.") ? "depth" : "limit"}":${edge}}]`,
            ],
          ]) {
            const h = proxyHarness("money");
            const response = await h.proxy(request(operation, body!, type!));
            expect([400, 422]).toContain(response.status);
            expect(h.transport).not.toHaveBeenCalled();
          }
        },
      ),
      runs,
    );
  },
);
