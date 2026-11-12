import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fromDecimalString, toDecimalString } from "@usagekit/core";
import type { Receipt, ReserveInput } from "@usagekit/core";
import type { StoreCapabilities, StoreFactory, StoreFixture } from "./factory.js";
import { budget, command, input, quantity, receipt, ref } from "./helpers.js";

export function correctionTests(factory: StoreFactory, capabilities: StoreCapabilities) {
  describe("native settlement corrections", () => {
    let f: StoreFixture;
    beforeEach(async () => {
      f = await factory();
    });
    afterEach(async () => f.close());
    const native = (overrides: Partial<ReserveInput> = {}) =>
      input({
        settlementPolicy: { requiredUnits: ["output_tokens"], requireMoney: false },
        estimate: [
          quantity(5n, "budget_cents"),
          quantity(5n, "input_tokens"),
          quantity(1n, "output_tokens"),
        ],
        ...overrides,
      });
    const proof = (overrides: Partial<Receipt> = {}) =>
      receipt({
        measurements: [
          { unit: "output_tokens", quantity: quantity(1n, "output_tokens"), certainty: "measured" },
        ],
        cost: { certainty: "unknown", money: null },
        ...overrides,
      });
    const dispatch = async (i = native()) => {
      const r = await f.store.reserve(i);
      if (r.outcome !== "reserved") throw new Error("reserve fixture: " + r.outcome);
      const g = await f.store.markDispatchIntent({
        ...command(r.operation),
        holder: "native",
        leaseTtlMs: 1000,
      });
      if (!("granted" in g) || !g.granted) throw new Error("dispatch fixture");
      return g;
    };
    const settle = (g: Awaited<ReturnType<typeof dispatch>>, r = proof()) =>
      f.store.settle({
        ...command(g.operation),
        authority: { kind: "lease", leaseId: g.lease.leaseId },
        receipt: r,
      });
    for (const unit of ["budget_cents", "input_tokens"]) {
      test(`C1 missing bounded ${unit} consumes the reserved estimate and trips budget and alerts`, async () => {
        f.budgets.push(
          budget({ unit, limit: quantity(10n, unit), alerts: [{ at: { percent: 100 } }] }),
        );
        for (let n = 0; n < 2; n++)
          expect(await settle(await dispatch())).toMatchObject({
            outcome: "settled",
            operation: { state: "settled" },
          });
        const status = (
          await f.store.applicableBudgets({
            scope: input().scope,
            surface: "app",
            source: "app",
            units: [unit],
          })
        )[0]!;
        expect(status.used).toEqual(quantity(10n, unit));
        expect(status.reserved).toEqual(quantity(0n, unit));
        expect(await f.store.reserve(native())).toMatchObject({
          outcome: "exceeded",
          exceeded: { used: quantity(10n, unit) },
        });
      });
    }
    test("C1 measured zero consumes zero and missing corrections cross an alert", async () => {
      const unit = "budget_cents";
      f.budgets.push(
        budget({ unit, limit: quantity(10n, unit), alerts: [{ at: quantity(8n, unit) }] }),
      );
      const settled = [];
      for (let n = 0; n < 2; n++) {
        const g = await dispatch();
        const zero = proof({
          measurements: [
            ...proof().measurements,
            { unit, quantity: quantity(0n, unit), certainty: "measured" },
          ],
        });
        const result = await settle(g, zero);
        if (result.outcome !== "settled") throw new Error("settle fixture");
        settled.push({ result, zero });
      }
      const status = () =>
        f.store.applicableBudgets({
          scope: input().scope,
          surface: "app",
          source: "app",
          units: [unit],
        });
      expect((await status())[0]!.used).toEqual(quantity(0n, unit));
      for (const [n, { result, zero }] of settled.entries()) {
        const corrected = await f.store.correct({
          ...command(result.operation),
          authority: { kind: "late_evidence", source: "test" },
          replacesReceiptId: zero.id,
          reason: "missing optional unit",
          receipt: proof(),
        });
        expect(corrected).toMatchObject({
          outcome: "settled",
          alerts:
            n === 0
              ? []
              : [
                  {
                    at: quantity(8n, unit),
                    used: quantity(10n, unit),
                    reserved: quantity(0n, unit),
                  },
                ],
        });
      }
      expect((await status())[0]!.used).toEqual(quantity(10n, unit));
    });
    test.skipIf(!capabilities.durable)(
      "C2 SQL money columns retain scale and exact mixed-scale sum after restart",
      async () => {
        expect(
          f.moneyColumns,
          "durable store must expose SQL money columns in its fixture",
        ).toBeTypeOf("function");
        for (const money of [
          fromDecimalString("0.0001"),
          fromDecimalString("0.00000013", { scale: 8 }),
        ]) {
          expect(
            await settle(await dispatch(), proof({ cost: { certainty: "measured", money } })),
          ).toMatchObject({ outcome: "settled" });
        }
        expect(await f.moneyColumns!()).toEqual([
          { cost_units: "1", cost_scale: 4 },
          { cost_units: "13", cost_scale: 8 },
        ]);
        expect(f.replayMoneyMigration).toBeTypeOf("function");
        await f.replayMoneyMigration!();
        expect(await f.moneyColumns!()).toEqual([
          { cost_units: "1", cost_scale: 4 },
          { cost_units: "13", cost_scale: 8 },
        ]);
        expect(f.restart, "durable fixture must restart").toBeTypeOf("function");
        f.store = await f.restart!();
        const row = (
          await f.store.aggregate({
            scope: { kind: "principal", namespace: "test", principal: "u1" },
            from: "2026-01-01T00:00:00Z",
            to: "2027-01-01T00:00:00Z",
            groupBy: [],
            units: [],
          })
        ).rows[0]!;
        expect(toDecimalString(row.cost.money!)).toBe("0.00010013");
      },
    );
    test("C1 policy-free missing bounded units retain the legacy reservation", async () => {
      const unit = "budget_cents";
      f.budgets.push(budget({ unit, limit: quantity(5n, unit) }));
      const g = await dispatch(input({ estimate: [quantity(5n, unit)] }));
      expect(await settle(g)).toMatchObject({
        outcome: "settled",
        operation: { state: "pending" },
      });
      const status = (
        await f.store.applicableBudgets({
          scope: input().scope,
          surface: "app",
          source: "app",
          units: [unit],
        })
      )[0]!;
      expect(status.used).toEqual(quantity(0n, unit));
      expect(status.reserved).toEqual(quantity(5n, unit));
      expect(await f.store.reserve(input({ estimate: [quantity(1n, unit)] }))).toMatchObject({
        outcome: "exceeded",
      });
    });
    test("C3 a finer invoice cannot introduce scale into a policy-free namespace", async () => {
      const g = await dispatch(input());
      const original = receipt({ providerRequestId: "legacy" });
      await settle(g, original);
      const result = await f.store
        .importBilling({
          scope: input().scope,
          provider: "search",
          fileHash: "e".repeat(64),
          window: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
          expectedPreviousImportId: null,
          attribution: { fundingSource: "byok", costOwner: "u1" },
          lines: [
            {
              providerRequestId: "legacy",
              occurredAt: original.occurredAt,
              cost: fromDecimalString("0.00000013", { scale: 8 }),
            },
          ],
        })
        .catch((error: unknown) => {
          // Embedded/remote Store conformance adapters translate validation results to exceptions.
          expect(error).toMatchObject({ field: "lines.0.cost" });
          return { outcome: "invalid" as const, field: "lines.0.cost" };
        });
      expect(result).toMatchObject({ outcome: "invalid", field: "lines.0.cost" });
      expect((await f.store.getOperation(ref(g.operation)))!.receipts).toEqual([original]);
    });
    test("C3 finer money requires a policy and legacy scale has one replay representation", async () => {
      const g = await dispatch(input());
      await expect(
        settle(
          g,
          receipt({
            cost: { certainty: "measured", money: fromDecimalString("0.00000013", { scale: 8 }) },
          }),
        ),
      ).rejects.toThrow(/InvalidInput: (receipt.cost|body)/);
      const legacy = receipt({
        cost: { certainty: "measured", money: { units: 1n, currency: "USD", scale: 4 } },
      });
      const i = {
        ...command(g.operation),
        authority: { kind: "lease" as const, leaseId: g.lease.leaseId },
        receipt: legacy,
      };
      expect(await f.store.settle(i)).toMatchObject({ outcome: "settled" });
      expect((await f.store.getOperation(ref(g.operation)))!.receipts[0]!.cost.money).toEqual({
        units: 1n,
        currency: "USD",
      });
      expect(
        await f.store.settle({
          ...i,
          receipt: {
            ...legacy,
            cost: { certainty: "measured", money: { units: 1n, currency: "USD" } },
          },
        }),
      ).toMatchObject({ outcome: "settled", replayed: true });
    });
    test("C7 aligned budget projection is exact or refuses atomically with a typed bound", async () => {
      const unit = "output_tokens",
        max = 2n ** 63n - 1n;
      f.budgets.push(budget({ unit, limit: null }));
      const query = {
        scope: input().scope,
        surface: "app" as const,
        source: "app" as const,
        units: [unit],
      };
      let expected = 0n;
      for (let n = 0; n < 20; n++) {
        const scale = n === 1 ? 18 : 0;
        const i = native({ estimate: [quantity(max, unit, scale)] });
        const before = await f.store.applicableBudgets(query);
        let reserved;
        try {
          reserved = await f.store.reserve(i);
        } catch (error) {
          expect(String(error)).toMatch(/InvalidInput: quantity/);
          expect(await f.store.applicableBudgets(query)).toEqual(before);
          expect(await f.store.getOperation(ref(i))).toBeNull();
          return;
        }
        if (reserved.outcome !== "reserved")
          throw new Error("reserve fixture: " + reserved.outcome);
        const g = await f.store.markDispatchIntent({
          ...command(reserved.operation),
          holder: "projection",
          leaseTtlMs: 1000,
        });
        if (!("granted" in g) || !g.granted) throw new Error("dispatch fixture");
        const beforeSettle = await f.store.applicableBudgets(query);
        try {
          expect(
            await settle(
              g,
              proof({
                measurements: [
                  { unit, quantity: quantity(max, unit, scale), certainty: "measured" },
                ],
              }),
            ),
          ).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
        } catch (error) {
          expect(String(error)).toMatch(/InvalidInput: quantity/);
          expect(await f.store.applicableBudgets(query)).toEqual(beforeSettle);
          expect(await f.store.getOperation(ref(g.operation))).toEqual(g.operation);
          return;
        }
        expected += max * 10n ** BigInt(18 - scale);
        const used = (await f.store.applicableBudgets(query))[0]!.used!;
        expect(used.value * 10n ** BigInt(18 - used.scale)).toBe(expected);
      }
    });
    test("C7 aligned totals and reconciliation exceed int64 without loss", async () => {
      for (const [n, money] of [
        { units: 10000000000n, currency: "USD" as const },
        { units: 1n, currency: "USD" as const, scale: 18 },
      ].entries())
        expect(
          await settle(
            await dispatch(),
            proof({ providerRequestId: "overflow-" + n, cost: { certainty: "measured", money } }),
          ),
        ).toMatchObject({ outcome: "settled" });
      const total = 1000000000000000000000001n;
      const query = {
        scope: { kind: "principal" as const, namespace: "test", principal: "u1" },
        from: "2026-09-01T00:00:00Z",
        to: "2026-10-01T00:00:00Z",
        units: [],
        groupBy: [],
      };
      expect((await f.store.aggregate(query)).rows[0]!.cost.money).toEqual({
        currency: "USD",
        units: total,
        scale: 18,
      });
      const result = await f.store.importBilling({
        scope: input().scope,
        provider: "search",
        fileHash: "d".repeat(64),
        window: { from: query.from, to: query.to },
        expectedPreviousImportId: null,
        attribution: { fundingSource: "byok", costOwner: "u1" },
        lines: [
          {
            window: { from: query.from, to: query.to },
            occurredAt: "2026-09-23T12:00:00Z",
            cost: { currency: "USD", units: 0n },
          },
        ],
      });
      if (result.outcome !== "imported") throw new Error("billing fixture: " + result.outcome);
      expect(result.record.reconciliations[0]).toMatchObject({
        differenceUnits: -total,
        differenceScale: 18,
      });
      if (capabilities.durable) {
        expect(f.restart).toBeTypeOf("function");
        f.store = await f.restart!();
      }
      const saved = await f.store.billingImports({
        scope: { namespace: "test", principal: "u1" },
        connection: "c1",
        from: query.from,
        to: query.to,
      });
      expect(saved.records[0]!.reconciliations[0]).toMatchObject({
        differenceUnits: -total,
        differenceScale: 18,
      });
      expect((await f.store.aggregate(query)).rows[0]!.cost.money).toEqual({
        currency: "USD",
        units: total,
        scale: 18,
      });
    });
    test("C5 a canonical operation with dependents cannot become a link", async () => {
      const a = await dispatch(),
        c = await dispatch();
      const ar = proof({ providerRequestId: "same" }),
        cr = proof({ providerRequestId: "same" });
      const as = await settle(a, ar);
      await settle(c, cr);
      const b = await dispatch();
      expect(
        await settle(
          b,
          proof({
            providerRequestId: "same",
            measurements: [],
            canonicalOperationId: a.operation.operationId,
          }),
        ),
      ).toMatchObject({ outcome: "settled" });
      if (as.outcome !== "settled") throw new Error("settle fixture");
      expect(
        await f.store.correct({
          ...command(as.operation),
          authority: { kind: "late_evidence", source: "test" },
          replacesReceiptId: ar.id,
          reason: "cannot chain",
          receipt: proof({
            providerRequestId: "same",
            measurements: [],
            canonicalOperationId: c.operation.operationId,
          }),
        }),
      ).toMatchObject({ outcome: "rejected", reason: "receipt_conflict" });
      expect((await f.store.getOperation(ref(a.operation)))!.receipts).toEqual([ar]);
    });
  });
}
