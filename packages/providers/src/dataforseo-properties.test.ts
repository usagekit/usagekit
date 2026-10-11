import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { compareQuantity } from "@usagekit/core";
import {
  dataforseo,
  dispatchPricedRequest,
  executeProviderRequest,
  PricedRequest,
  RequestPricingError,
} from "./index.js";
import {
  harness,
  input,
  mediaType,
  operations,
  runs,
  smallPrice,
  taskVariant,
  unknownKey,
  wireBody,
  worstCase,
} from "../test-support/dataforseo-properties.js";

test("the independent evidence table covers every billable operation", () => {
  expect([...operations].sort()).toEqual(
    dataforseo.descriptor.operations
      .filter((op) => op.billable)
      .map((op) => op.id)
      .sort(),
  );
});

test.each(operations)(
  "%s: priced serialization, single match and documented charge",
  async (operation) => {
    await fc.assert(
      fc.asyncProperty(
        taskVariant(operation),
        mediaType,
        fc.boolean(),
        fc.constantFrom("", " \n\t"),
        async ({ task, operatorCount }, contentType, duplicate, whitespace) => {
          const h = harness();
          const match = vi.spyOn(h.catalog, "match");
          const priced = await PricedRequest.price({
            ...h,
            input,
            request: {
              method: "POST",
              url: `/v3/${operation.replaceAll(".", "/")}`,
              headers: { "content-type": contentType },
              body: new TextEncoder().encode(wireBody(task, duplicate, whitespace)),
            },
          });
          expect(match).toHaveBeenCalledTimes(1);
          expect(priced.parsed.body).toEqual([task]);
          const serialization = new TextEncoder().encode(JSON.stringify(priced.parsed.body));
          expect(priced.body).toEqual(serialization);
          const lowerBound = worstCase(operation, task, operatorCount);
          if (lowerBound === null) {
            expect(priced.estimate.some((q) => q.unit === "cents")).toBe(false);
            expect(priced.admission).toMatchObject({
              outcome: "reserved",
              operation: { estimateSource: "unknown" },
            });
          } else {
            const money = priced.estimate.find((q) => q.unit === "cents");
            expect(money).toBeDefined();
            expect(
              compareQuantity(money!, { unit: "cents", value: lowerBound, scale: 4 }),
            ).toBeGreaterThanOrEqual(0);
          }
          // Caller-owned data and defensive byte copies cannot change the dispatch.
          priced.body!.fill(0);
          const transport = vi.fn<typeof fetch>(async (_url, init) => {
            expect(init?.body).toEqual(serialization);
            return Response.json({});
          });
          const result = await executeProviderRequest({
            ...h,
            request: priced,
            dispatch: async (request) => {
              const response = await dispatchPricedRequest(
                request,
                transport,
                new AbortController().signal,
                null,
              );
              return { response: { status: response.status }, body: await response.json() };
            },
          });
          expect(result.outcome).toBe("completed");
          expect(transport).toHaveBeenCalledOnce();
          expect(match).toHaveBeenCalledTimes(1);
        },
      ),
      runs,
    );
  },
);

test.each(operations)(
  "%s: unlisted spellings stay unknown and fail money/credits admission",
  async (operation) => {
    await fc.assert(
      fc.asyncProperty(
        taskVariant(operation),
        unknownKey,
        fc.jsonValue(),
        mediaType,
        async ({ task }, key, value, contentType) => {
          task = { ...task, [key]: value };
          for (const mode of ["open", "money", "credits"] as const) {
            const h = harness(mode);
            const priced = await PricedRequest.price({
              ...h,
              input: {
                ...input,
                fundingSource: mode === "credits" ? "platform" : "byok",
                estimate: [{ ...smallPrice, unit: mode === "credits" ? "credits" : "cents" }],
              },
              request: {
                method: "POST",
                url: `/v3/${operation.replaceAll(".", "/")}`,
                headers: { "content-type": contentType },
                body: wireBody(task, true, " "),
              },
            });
            expect(priced.matched).toMatchObject({ options: { pricingUnknown: "true" } });
            if (mode === "open") {
              expect(priced.admission).toMatchObject({
                outcome: "reserved",
                operation: {
                  estimateSource: "unknown",
                  estimate: [{ unit: "requests", value: 1n, scale: 0 }],
                },
              });
              const transport = vi.fn<typeof fetch>(async (_url, init) => {
                expect(init?.body).toEqual(priced.body);
                expect(init?.body).toEqual(
                  new TextEncoder().encode(JSON.stringify(priced.parsed.body)),
                );
                return Response.json({});
              });
              const result = await executeProviderRequest({
                ...h,
                request: priced,
                dispatch: async (request) => {
                  const response = await dispatchPricedRequest(
                    request,
                    transport,
                    new AbortController().signal,
                    null,
                  );
                  return { response: { status: response.status }, body: await response.json() };
                },
              });
              expect(result.outcome).toBe("completed");
              expect(transport).toHaveBeenCalledOnce();
            } else {
              expect(priced.admission.outcome).toBe("invalid");
              const dispatch = vi.fn();
              expect(
                (await executeProviderRequest({ ...h, request: priced, dispatch })).outcome,
              ).toBe("not_dispatched");
              expect(dispatch).not.toHaveBeenCalled();
            }
          }
        },
      ),
      runs,
    );
  },
);

test.each(operations)(
  "%s: trusted BYOK prices remain configurable while documented surcharges keep their bound",
  async (operation) => {
    await fc.assert(
      fc.asyncProperty(taskVariant(operation), async ({ task, operatorCount }) => {
        const bound = worstCase(operation, task, operatorCount);
        for (const override of ["explicit", "manual", "measured"] as const) {
          const h = harness("open", override === "explicit" ? undefined : override, operation);
          const priced = await PricedRequest.price({
            ...h,
            input: { ...input, ...(override === "explicit" ? { estimate: [smallPrice] } : {}) },
            request: {
              method: "POST",
              url: `/v3/${operation.replaceAll(".", "/")}`,
              body: [task],
            },
          });
          const money = priced.estimate.find((q) => q.unit === "cents");
          if (task.include_seed_keyword === true || task.offset_token !== undefined) {
            expect(money, override).toBeUndefined();
            expect(priced.admission).toMatchObject({
              outcome: "reserved",
              operation: { estimateSource: "unknown" },
            });
            continue;
          }
          expect(money, override).toBeDefined();
          const hasSurcharge =
            (operation.startsWith("serp.") &&
              (operatorCount > 0 ||
                task.calculate_rectangles === true ||
                task.load_async_ai_overview === true ||
                task.people_also_ask_click_depth !== undefined ||
                task.max_crawl_pages !== undefined)) ||
            task.include_clickstream_data === true;
          if (hasSurcharge && bound !== null) {
            expect(
              compareQuantity(money!, { unit: "cents", value: bound, scale: 4 }),
              override,
            ).toBeGreaterThanOrEqual(0);
          } else {
            expect(money, override).toEqual(smallPrice);
          }
        }
      }),
      runs,
    );
  },
);

test.each(operations)(
  "%s: numeric edge inputs never silently price an invalid count",
  async (operation) => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("0", "-0", "-1", "1.5", "1e400", "9007199254740992", '"10"', "null"),
        async (number) => {
          const h = harness("money");
          const field = operation.startsWith("serp.") ? "depth" : "limit";
          let priced: PricedRequest;
          try {
            priced = await PricedRequest.price({
              ...h,
              input,
              request: {
                method: "POST",
                url: `/v3/${operation.replaceAll(".", "/")}`,
                headers: { "content-type": "application/json" },
                body: `[{"${field}":${number}}]`,
              },
            });
          } catch (error) {
            expect(error).toBeInstanceOf(RequestPricingError);
            return;
          }
          expect(priced.admission.outcome).toBe("invalid");
          expect(priced.estimate).toEqual([]);
        },
      ),
      runs,
    );
  },
);

test.each([
  "backlinks.history.live",
  "dataforseo_labs.google.historical_rank_overview.live",
  "dataforseo_labs.google.keyword_overview.live",
])("%s: missing counts need a trusted whole-call price", async (operation) => {
  await fc.assert(
    fc.asyncProperty(
      fc.option(
        fc.date({ min: new Date("2020-01-01"), max: new Date("2026-01-01"), noInvalidDate: true }),
        { nil: undefined },
      ),
      fc.boolean(),
      async (date, bodyless) => {
        const task = operation.includes("keyword_overview")
          ? {}
          : {
              target: "example.com",
              ...(date ? { date_from: date.toISOString().slice(0, 10) } : {}),
            };
        for (const mode of ["money", "credits"] as const) {
          for (const explicit of [false, true]) {
            const h = harness(mode);
            const price = { ...smallPrice, unit: mode === "credits" ? "credits" : "cents" };
            const priced = await PricedRequest.price({
              ...h,
              input: {
                ...input,
                fundingSource: mode === "credits" ? "platform" : "byok",
                ...(explicit ? { estimate: [price] } : {}),
              },
              request: {
                method: "POST",
                url: `/v3/${operation.replaceAll(".", "/")}`,
                ...(bodyless ? {} : { body: [task] }),
              },
            });
            expect(priced.admission.outcome).toBe(explicit ? "reserved" : "invalid");
            expect(priced.estimate).toEqual(explicit ? [price] : []);
          }
        }
      },
    ),
    runs,
  );
});
