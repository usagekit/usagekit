import { describe, expect, test, vi } from "vitest";
import type { AccessContext, Meter, UsagePage, UsageQuery, UsageRow } from "@usagekit/core";
import { createManualClock, createMemoryStore } from "@usagekit/store";
import { createMeter } from "@usagekit/meter";
import { loadUsageSummary, usageSummaryFromPages } from "./index.js";

const access: AccessContext = {
  namespace: "test",
  readablePrincipals: "*",
  readableGroups: "*",
  readablePools: "*",
  canReadBillingDetail: true,
  canManageBudgets: true,
};
const input = {
  scope: { kind: "principal" as const, namespace: "test", principal: "owner" },
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-10-01T00:00:00.000Z",
  units: ["requests", "customer_cents"],
  limit: 1,
};
const row = (overrides: Partial<UsageRow> = {}): UsageRow => ({
  dimensions: {},
  fundingSource: "byok",
  costOwner: "owner",
  measurements: [
    {
      unit: "requests",
      quantity: { unit: "requests", value: 1n, scale: 0 },
      certainty: "measured",
    },
  ],
  cost: { certainty: "measured", money: { currency: "USD", units: 12345n } },
  unknownOperations: 0n,
  ...overrides,
});
const page = (rows: readonly UsageRow[], nextCursor?: string): UsagePage => ({
  rows,
  watermark: "snapshot",
  asOf: "2026-09-23T12:00:00.000Z",
  ...(nextCursor !== undefined ? { nextCursor } : {}),
});
function reader(read: Meter["usage"]): Meter {
  return { usage: read } as Meter;
}

describe("complete usage summaries", () => {
  test("sums huge quantities and exact money across all pages, separating payer and customer measurement", async () => {
    const queries: UsageQuery[] = [];
    const pages = [
      page(
        [
          row({
            measurements: [
              {
                unit: "requests",
                quantity: { unit: "requests", value: 900719925474099312345n, scale: 6 },
                certainty: "measured",
              },
              {
                unit: "customer_cents",
                quantity: { unit: "customer_cents", value: 25000n, scale: 4 },
                certainty: "measured",
              },
            ],
            cost: {
              certainty: "measured",
              money: { currency: "USD", units: 900719925474099312345n },
            },
          }),
        ],
        "next",
      ),
      page([
        row({
          fundingSource: "platform",
          costOwner: "platform-owner",
          measurements: [
            {
              unit: "requests",
              quantity: { unit: "requests", value: 155n, scale: 2 },
              certainty: "estimated",
            },
            {
              unit: "customer_cents",
              quantity: { unit: "customer_cents", value: 125n, scale: 2 },
              certainty: "measured",
            },
          ],
          cost: { certainty: "estimated", money: { currency: "USD", units: 655n } },
        }),
      ]),
    ];
    const meter = reader(async (_access, query) => {
      queries.push(structuredClone(query));
      return { outcome: "ok", value: pages[queries.length - 1]! };
    });
    const result = await loadUsageSummary(meter, access, input);
    expect(result).toMatchObject({
      state: "ok",
      complete: true,
      pages: 2,
      rowCount: 2,
      nextCursor: null,
      unknownOperations: "0",
      watermark: "snapshot",
      measurements: {
        requests: { text: "900719925474100.862345", unit: "requests", certainty: "estimated" },
        customer_cents: { text: "3.75", unit: "customer_cents", certainty: "measured" },
      },
      cost: { text: "90071992547409931.3000", unit: "cents", certainty: "estimated" },
    });
    expect(
      result.funding.map(({ fundingSource, costOwner }) => [fundingSource, costOwner]),
    ).toEqual([
      ["byok", "owner"],
      ["platform", "platform-owner"],
    ]);
    expect(queries[0]).toEqual({ ...input, groupBy: [] });
    expect(queries[1]).toEqual({ ...input, groupBy: [], cursor: "next" });
  });

  test("complete empty data is measured zero, whereas missing units and unknown evidence are not", () => {
    const empty = usageSummaryFromPages([page([])], ["requests"]);
    expect(empty).toMatchObject({
      state: "empty",
      complete: true,
      unknownOperations: "0",
      measurements: { requests: { text: "0", certainty: "measured" } },
      cost: { text: "0.0000", certainty: "measured" },
    });
    const unknown = usageSummaryFromPages(
      [
        page([
          row({
            cost: { certainty: "unknown", money: null },
            unknownOperations: 9007199254740993n,
            measurements: [{ unit: "requests", certainty: "unknown", quantity: null }],
          }),
        ]),
      ],
      ["requests", "tokens"],
    );
    expect(unknown).toMatchObject({
      state: "ok",
      complete: true,
      unknownOperations: "9007199254740993",
      measurements: { requests: { text: "", certainty: "unknown" }, tokens: "unavailable" },
      cost: { text: "", certainty: "unknown" },
    });
  });

  test("one missing group measurement never becomes zero or a known subtotal", () => {
    const result = usageSummaryFromPages(
      [page([row(), row({ costOwner: "other", measurements: [] })])],
      ["requests"],
    );
    expect(result.measurements.requests).toBe("unavailable");
    expect(result.funding[0]!.measurements.requests).toMatchObject({ text: "1" });
    expect(result.funding[1]!.measurements.requests).toBe("unavailable");
  });

  test("unknown quantity does not erase independently known provider cost", () => {
    const result = usageSummaryFromPages(
      [page([row({ measurements: [{ unit: "requests", certainty: "unknown", quantity: null }] })])],
      ["requests"],
    );
    expect(result.measurements.requests).toEqual({
      text: "",
      unit: "requests",
      certainty: "unknown",
    });
    expect(result.cost).toEqual({ text: "1.2345", unit: "cents", certainty: "measured" });
  });

  test("a bounded partial page sequence yields no totals or funding subtotals", async () => {
    const usage = vi.fn(async () => ({ outcome: "ok" as const, value: page([row()], "next") }));
    const result = await loadUsageSummary(reader(usage), access, { ...input, maxPages: 1 });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: "unavailable",
      complete: false,
      cost: "unavailable",
      measurements: { requests: "unavailable" },
      funding: [],
      unknownOperations: null,
      nextCursor: "next",
      pages: 1,
      problem: { kind: "invalid", field: "maxPages" },
    });
  });

  test.each([0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "invalid bound %s does not call Meter",
    async (maxPages) => {
      const usage = vi.fn();
      expect(await loadUsageSummary(reader(usage), access, { ...input, maxPages })).toMatchObject({
        state: "unavailable",
        complete: false,
        problem: { field: "maxPages" },
      });
      expect(usage).not.toHaveBeenCalled();
    },
  );

  test.each(["watermark", "asOf"] as const)(
    "changed %s is unavailable, not a mixed total",
    async (field) => {
      let calls = 0;
      const usage = vi.fn(async () => ({
        outcome: "ok" as const,
        value:
          calls++ === 0
            ? page([row()], "next")
            : {
                ...page([row({ costOwner: "other" })]),
                [field]: field === "asOf" ? "2026-09-23T13:00:00.000Z" : "different",
              },
      }));
      expect(await loadUsageSummary(reader(usage), access, input)).toMatchObject({
        state: "unavailable",
        complete: false,
        cost: "unavailable",
        funding: [],
        problem: { field: "pagination" },
      });
      expect(usage).toHaveBeenCalledTimes(2);
    },
  );

  test("a cursor cycle stops without additional reads", async () => {
    const usage = vi.fn(async () => ({ outcome: "ok" as const, value: page([row()], "repeat") }));
    const result = await loadUsageSummary(reader(usage), access, input);
    expect(result.complete).toBe(false);
    expect(result.cost).toBe("unavailable");
    expect(usage).toHaveBeenCalledTimes(2);
  });

  test("duplicated aggregate rows and exploded dimensions are refused", () => {
    expect(usageSummaryFromPages([page([row(), row()])], ["requests"])).toMatchObject({
      state: "unavailable",
      complete: false,
    });
    expect(
      usageSummaryFromPages([page([row({ dimensions: { tag: "one" } })])], ["requests"]),
    ).toMatchObject({ state: "unavailable", complete: false });
    expect(usageSummaryFromPages([page([]), page([])], ["requests"])).toMatchObject({
      state: "unavailable",
      complete: false,
    });
  });

  test("forbidden on a later page clears prior figures", async () => {
    let calls = 0;
    const meter = reader(async () =>
      calls++ === 0 ? { outcome: "ok", value: page([row()], "next") } : { outcome: "forbidden" },
    );
    expect(await loadUsageSummary(meter, access, input)).toMatchObject({
      state: "forbidden",
      complete: false,
      funding: [],
      cost: "unavailable",
      asOf: null,
      problem: null,
    });
  });

  test("thrown, invalid and malformed Meter replies are unavailable", async () => {
    for (const usage of [
      async () => {
        throw Error("offline");
      },
      async () => ({ outcome: "invalid", field: "scope", reason: "bad" }),
      async () => ({ outcome: "ok", value: { ...page([]), rows: null } }),
      async () => ({
        outcome: "ok",
        value: page([
          row({
            measurements: [
              {
                unit: "requests",
                quantity: { unit: "tokens", value: 1n, scale: 0 },
                certainty: "measured",
              },
            ],
          }),
        ]),
      }),
      async () => ({
        outcome: "ok",
        value: page([
          row({ cost: { certainty: "measured", money: { currency: "EUR" as "USD", units: 1n } } }),
        ]),
      }),
      async () => ({ outcome: "ok", value: page([row({ unknownOperations: -1n })]) }),
    ]) {
      expect(await loadUsageSummary(reader(usage as Meter["usage"]), access, input)).toMatchObject({
        state: "unavailable",
        complete: false,
        cost: "unavailable",
      });
    }
  });

  test("query and verified access are snapshotted and extra cursor/groupBy input cannot widen totals", async () => {
    const mutable = structuredClone(input);
    const mutableAccess = structuredClone(access);
    const queries: UsageQuery[] = [];
    const meter = reader(async (boundAccess, query) => {
      queries.push(structuredClone(query));
      expect(boundAccess.namespace).toBe("test");
      mutable.scope.principal = "other";
      mutable.units.push("tokens");
      mutableAccess.namespace = "other";
      return {
        outcome: "ok",
        value: queries.length === 1 ? page([row()], "next") : page([row({ costOwner: "other" })]),
      };
    });
    const result = await loadUsageSummary(meter, mutableAccess, {
      ...mutable,
      groupBy: ["tag"],
      cursor: "injected",
    } as typeof input);
    expect(result.complete).toBe(true);
    expect(queries[0]!.cursor).toBeUndefined();
    expect(queries[1]!.scope).toEqual(input.scope);
    expect(queries[1]!.units).toEqual(input.units);
    expect(queries.every((query) => query.groupBy.length === 0)).toBe(true);
  });

  test("actual Meter pages separate funding/owners and keeps newly settled work out of the first watermark", async () => {
    const clock = createManualClock();
    const store = createMemoryStore({ clock, budgets: [] });
    const meter = createMeter({ store, clock });
    async function settle(id: string, costOwner: string, fundingSource: "byok" | "platform") {
      const reserved = await store.reserve({
        operationId: id,
        scope: {
          namespace: "test",
          principal: "owner",
          connection: "connection",
          tags: ["a", "b"],
        },
        provider: "test",
        operation: "read",
        source: "app",
        surface: "app",
        fundingSource,
        costOwner,
        estimate: [{ unit: "requests", value: 1n, scale: 0 }],
      });
      if (reserved.outcome !== "reserved") throw Error(reserved.outcome);
      const grant = await store.markDispatchIntent({
        namespace: "test",
        principal: "owner",
        operationId: id,
        commandId: `dispatch-${id}`,
        expectedVersion: reserved.operation.version,
        holder: "test",
        leaseTtlMs: 60000,
      });
      if (!("granted" in grant) || !grant.granted) throw Error("missing fixture grant");
      const settled = await store.settle({
        namespace: "test",
        principal: "owner",
        operationId: id,
        commandId: `settle-${id}`,
        expectedVersion: grant.operation.version,
        authority: { kind: "lease", leaseId: grant.lease.leaseId },
        receipt: {
          id: `receipt-${id}`,
          occurredAt: "2026-09-23T12:00:00.000Z",
          recordedAt: "2026-09-23T12:00:00.000Z",
          cached: false,
          failed: false,
          cost: { certainty: "measured", money: { currency: "USD", units: 10000n } },
          measurements: [
            {
              unit: "requests",
              quantity: { unit: "requests", value: 1n, scale: 0 },
              certainty: "measured",
            },
          ],
        },
      });
      if (settled.outcome !== "settled") throw Error(settled.outcome);
    }
    await settle("one", "owner", "byok");
    await settle("two", "platform-owner", "platform");
    let calls = 0;
    const observing = reader(async (boundAccess, query) => {
      const result = await meter.usage(boundAccess, query);
      if (++calls === 1) await settle("three", "third-owner", "byok");
      return result;
    });
    const result = await loadUsageSummary(observing, access, input);
    expect(result).toMatchObject({
      state: "ok",
      complete: true,
      pages: 2,
      rowCount: 2,
      measurements: { requests: { text: "2", certainty: "measured" } },
      cost: { text: "2.0000" },
    });
    expect(
      result.funding.map(({ fundingSource, costOwner }) => [fundingSource, costOwner]),
    ).toEqual([
      ["byok", "owner"],
      ["platform", "platform-owner"],
    ]);
    const next = await loadUsageSummary(meter, access, input);
    expect(next).toMatchObject({
      complete: true,
      pages: 3,
      rowCount: 3,
      measurements: { requests: { text: "3" } },
      cost: { text: "3.0000" },
    });
    expect(next.watermark).not.toBe(result.watermark);
  });
});

test("summary combines declared money scales without rounding", () => {
  const result = usageSummaryFromPages(
    [
      page([
        row({
          costOwner: "first",
          cost: { certainty: "measured", money: { currency: "USD", units: 13n, scale: 8 } },
        }),
        row({
          costOwner: "second",
          cost: { certainty: "measured", money: { currency: "USD", units: 1n } },
        }),
      ]),
    ],
    ["requests"],
  );
  expect(result).toMatchObject({
    cost: { text: "0.00010013", unit: "cents", certainty: "measured" },
  });
});
