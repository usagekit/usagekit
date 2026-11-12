import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fromDecimalString, toDecimalString } from "@usagekit/core";
import type { Money, Receipt, ReserveInput } from "@usagekit/core";
import type { StoreCapabilities, StoreFactory, StoreFixture } from "./factory.js";
import { budget, command, input, quantity, receipt, ref } from "./helpers.js";

import policyFreeGolden from "./policy-free-0.11.0.js";
import { capturePolicyFree, serializePolicyFree } from "./policy-free.js";

// Native-policy probes exercise the current implementation. The policy-free
// golden is captured from release 0.11.0; see policy-free-golden.md.
type NativeInput = ReserveInput & {
  settlementPolicy: { requiredUnits: readonly string[]; requireMoney: boolean };
};
const native = (overrides: Partial<NativeInput> = {}): NativeInput => ({
  ...input({
    estimate: [
      quantity(20n, "input_tokens"),
      quantity(10n, "output_tokens"),
      quantity(5n, "budget_cents"),
    ],
  }),
  settlementPolicy: { requiredUnits: ["input_tokens", "output_tokens"], requireMoney: false },
  ...overrides,
});
const proof = (overrides: Partial<Receipt> = {}): Receipt =>
  receipt({
    measurements: [
      { unit: "input_tokens", quantity: quantity(7n, "input_tokens"), certainty: "measured" },
      { unit: "output_tokens", quantity: quantity(3n, "output_tokens"), certainty: "measured" },
      { unit: "budget_cents", quantity: quantity(2n, "budget_cents"), certainty: "estimated" },
    ],
    cost: { certainty: "unknown", money: null },
    ...overrides,
  });
export function nativeSettlementTests(factory: StoreFactory, capabilities: StoreCapabilities) {
  describe("native settlement", () => {
    let f: StoreFixture;
    beforeEach(async () => {
      f = await factory();
    });
    afterEach(async () => f.close());
    const dispatch = async (i: ReserveInput = native()) => {
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
    const settle = async (g: Awaited<ReturnType<typeof dispatch>>, r = proof()) => {
      const i = {
        ...command(g.operation),
        authority: { kind: "lease" as const, leaseId: g.lease.leaseId },
        receipt: r,
      };
      return { result: await f.store.settle(i), input: i };
    };
    const usage = () =>
      f.store.aggregate({
        scope: { kind: "principal", namespace: "test", principal: "u1" },
        from: "2026-01-01T00:00:00Z",
        to: "2027-01-01T00:00:00Z",
        groupBy: [],
        units: ["input_tokens", "output_tokens", "budget_cents"],
      });
    const figures = async () =>
      (
        await f.store.applicableBudgets({
          scope: input().scope,
          surface: "app",
          source: "app",
          units: ["input_tokens", "budget_cents"],
        })
      ).map((s) => ({ unit: s.budget.unit, used: s.used, reserved: s.reserved }));
    test("R1 freezes policy in reserve identity and isolates caller mutations", async () => {
      const i = native();
      const r = await f.store.reserve(i);
      expect(r.outcome).toBe("reserved");
      expect(
        await f.store.reserve({
          ...i,
          settlementPolicy: { ...i.settlementPolicy, requireMoney: true },
        } as NativeInput),
      ).toMatchObject({ outcome: "conflict", reason: "semantic_mismatch" });
      (i.settlementPolicy.requiredUnits as string[]).push("search_calls");
      expect(await f.store.getOperation(ref(i))).toMatchObject({
        settlementPolicy: { requiredUnits: ["input_tokens", "output_tokens"] },
      });
    });
    test("R2 complete native quantities settle with unknown optional money and release reservations", async () => {
      f.budgets.push(
        budget({ unit: "input_tokens", limit: quantity(100n, "input_tokens") }),
        budget({ unit: "budget_cents", limit: quantity(100n, "budget_cents") }),
      );
      const g = await dispatch();
      const { result, input: cmd } = await settle(g);
      expect(result).toMatchObject({
        outcome: "settled",
        operation: {
          state: "settled",
          lease: null,
          receipts: [{ cost: { certainty: "unknown", money: null } }],
        },
      });
      expect(await figures()).toEqual(
        expect.arrayContaining([
          {
            unit: "input_tokens",
            used: quantity(7n, "input_tokens"),
            reserved: quantity(0n, "input_tokens"),
          },
          {
            unit: "budget_cents",
            used: quantity(2n, "budget_cents"),
            reserved: quantity(0n, "budget_cents"),
          },
        ]),
      );
      expect(await f.store.settle(cmd)).toMatchObject({ outcome: "settled", replayed: true });
      expect(
        await f.store.markDispatchIntent({
          ...command(g.operation),
          holder: "again",
          leaseTtlMs: 1000,
        }),
      ).toMatchObject({ granted: false, reason: "already_dispatched" });
      expect((await usage()).rows[0]).toMatchObject({
        cost: { certainty: "unknown", money: null },
        unknownOperations: 0n,
      });
    });
    test.each(["missing", "unknown", "estimated"])(
      "R2 required %s native evidence remains pending and never regrants dispatch",
      async (mode) => {
        f.budgets.push(budget({ unit: "input_tokens", limit: quantity(100n, "input_tokens") }));
        const g = await dispatch();
        const r = proof({ cost: { certainty: "measured", money: { units: 1n, currency: "USD" } } });
        r.measurements = r.measurements.filter((m) => m.unit !== "output_tokens");
        if (mode !== "missing")
          r.measurements = [
            ...r.measurements,
            mode === "unknown"
              ? { unit: "output_tokens", certainty: "unknown", quantity: null }
              : {
                  unit: "output_tokens",
                  certainty: "estimated",
                  quantity: quantity(3n, "output_tokens"),
                },
          ];
        const { result } = await settle(g, r);
        expect(result).toMatchObject({ outcome: "settled", operation: { state: "pending" } });
        expect(
          await f.store.markDispatchIntent({
            ...command(g.operation),
            holder: "again",
            leaseTtlMs: 1000,
          }),
        ).toMatchObject({ granted: false, reason: "already_dispatched" });
        expect((await usage()).rows[0]?.unknownOperations).toBe(1n);
        expect((await figures())[0]).toEqual({
          unit: "input_tokens",
          used: quantity(0n, "input_tokens"),
          reserved: quantity(20n, "input_tokens"),
        });
      },
    );
    test("R1 required dimensions need not appear in the estimate", async () => {
      const g = await dispatch(
        native({
          settlementPolicy: {
            requiredUnits: ["input_tokens", "output_tokens", "search_calls"],
            requireMoney: false,
          },
        }),
      );
      expect(
        (
          await settle(
            g,
            proof({ cost: { certainty: "measured", money: { units: 1n, currency: "USD" } } }),
          )
        ).result,
      ).toMatchObject({ outcome: "settled", operation: { state: "pending" } });
    });
    test("R1 rejects empty, duplicate or advisory required dimensions", async () => {
      for (const requiredUnits of [[], ["input_tokens", "input_tokens"], ["budget_cents"]]) {
        await expect(
          f.store.reserve(native({ settlementPolicy: { requiredUnits, requireMoney: false } })),
        ).rejects.toThrow(/InvalidInput: (settlementPolicy|body)/);
      }
    });
    test("R2 optional absent estimates do not block, but required money does", async () => {
      const g = await dispatch();
      expect(
        (
          await settle(
            g,
            proof({ measurements: proof().measurements.filter((m) => m.unit !== "budget_cents") }),
          )
        ).result,
      ).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
      const required = await dispatch(
        native({
          settlementPolicy: {
            requiredUnits: ["input_tokens", "output_tokens"],
            requireMoney: true,
          },
        }),
      );
      expect((await settle(required)).result).toMatchObject({
        outcome: "settled",
        operation: { state: "pending" },
      });
    });
    test("R3 advisory estimates remain estimated through legacy recovery, correction and aggregation", async () => {
      f.budgets.push(budget({ unit: "budget_cents", limit: quantity(100n, "budget_cents") }));
      const g = await dispatch(input({ estimate: [quantity(5n, "budget_cents")] }));
      f.clock.advance(1000);
      const claim = await f.store.claimForRecovery({
        ...ref(g.operation),
        holder: "recover",
        leaseTtlMs: 1000,
      });
      if (!("claimed" in claim) || !claim.claimed) throw new Error("recovery fixture");
      const r = proof({ cost: { certainty: "measured", money: { currency: "USD", units: 11n } } });
      const s = await f.store.settle({
        ...command(claim.operation),
        authority: { kind: "recovery", leaseId: claim.lease.leaseId },
        receipt: r,
      });
      if (s.outcome !== "settled") throw new Error("settle fixture");
      const corrected = proof({ cost: r.cost });
      expect(
        await f.store.correct({
          ...command(s.operation),
          authority: { kind: "late_evidence", source: "provider" },
          receipt: corrected,
          replacesReceiptId: r.id,
          reason: "corrected usage",
        }),
      ).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
      const row = (await usage()).rows[0]!;
      expect(row.cost).toEqual(r.cost);
      expect(row.measurements.find((m) => m.unit === "budget_cents")).toMatchObject({
        certainty: "estimated",
        quantity: quantity(2n, "budget_cents"),
      });
      expect((await figures())[0]?.used).toEqual(quantity(2n, "budget_cents"));
    });
    test("R4 canonical linkage closes a second operation without duplicate quantities or synthetic money", async () => {
      f.budgets.push(budget({ unit: "input_tokens", limit: quantity(100n, "input_tokens") }));
      const first = await dispatch();
      const r = proof({
        providerRequestId: "request-one",
        cost: { certainty: "measured", money: { currency: "USD", units: 5n } },
      });
      expect((await settle(first, r)).result).toMatchObject({
        outcome: "settled",
        operation: { state: "settled" },
      });
      const second = await dispatch();
      const duplicate = {
        ...proof({ providerRequestId: "request-one", measurements: [] }),
        canonicalOperationId: first.operation.operationId,
      };
      const s = await settle(second, duplicate);
      expect(s.result).toMatchObject({
        outcome: "settled",
        operation: {
          state: "settled",
          receipts: [
            {
              canonicalOperationId: first.operation.operationId,
              cost: { certainty: "unknown", money: null },
            },
          ],
        },
      });
      expect(await f.store.settle(s.input)).toMatchObject({ outcome: "settled", replayed: true });
      const third = await dispatch();
      expect(
        (await settle(third, { ...r, id: "separate", providerRequestId: "request-two" })).result,
      ).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
      const row = (await usage()).rows[0]!;
      expect(row.cost).toEqual({ certainty: "measured", money: { currency: "USD", units: 10n } });
      expect(row.measurements.find((m) => m.unit === "input_tokens")?.quantity).toEqual(
        quantity(14n, "input_tokens"),
      );
    });
    test("R5 finer decimal money round-trips and aggregates mixed scales exactly", async () => {
      const options = { scale: 8 };
      const money = fromDecimalString("0.00000013", options);
      expect(toDecimalString(money)).toBe("0.00000013");
      for (const amount of [money, { units: 1n, currency: "USD" as const }]) {
        const g = await dispatch(
          input({ settlementPolicy: { requiredUnits: ["requests"], requireMoney: false } }),
        );
        expect(
          (await settle(g, receipt({ cost: { certainty: "measured", money: amount } }))).result,
        ).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
        expect((await f.store.getOperation(ref(g.operation)))?.receipts[0]?.cost.money).toEqual(
          amount,
        );
      }
      expect(toDecimalString((await usage()).rows[0]!.cost.money as Money)).toBe("0.00010013");
    });
    test("native recovery and correction retain unknown money and advisory certainty", async () => {
      const g = await dispatch();
      f.clock.advance(1000);
      expect((await settle(g)).result).toMatchObject({
        outcome: "rejected",
        reason: "lease_expired",
      });
      const claim = await f.store.claimForRecovery({
        ...ref(g.operation),
        holder: "sweeper",
        leaseTtlMs: 1000,
      });
      if (!("claimed" in claim) || !claim.claimed) throw new Error("recovery fixture");
      const evidence = proof({ providerRequestId: "native-recovery" });
      const settled = await f.store.settle({
        ...command(claim.operation),
        authority: { kind: "recovery", leaseId: claim.lease.leaseId },
        receipt: evidence,
      });
      if (settled.outcome !== "settled") throw new Error("settlement fixture");
      expect(settled.operation.state).toBe("settled");
      const corrected = await f.store.correct({
        ...command(settled.operation),
        authority: { kind: "late_evidence", source: "provider" },
        receipt: proof({ providerRequestId: "native-recovery" }),
        replacesReceiptId: evidence.id,
        reason: "native correction",
      });
      expect(corrected).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
      expect((await usage()).rows[0]).toMatchObject({
        cost: { certainty: "unknown", money: null },
        unknownOperations: 0n,
        measurements: expect.arrayContaining([
          { unit: "budget_cents", quantity: quantity(2n, "budget_cents"), certainty: "estimated" },
        ]),
      });
      if (capabilities.durable) {
        expect(f.restart, "durable fixture must restart").toBeTypeOf("function");
        f.store = await f.restart!();
        expect((await f.store.getOperation(ref(g.operation)))?.receipts.at(-1)?.cost).toEqual({
          certainty: "unknown",
          money: null,
        });
      }
    });
    test("canonical linkage validates scope, evidence, fencing and correction identity", async () => {
      const canonical = await dispatch();
      const original = proof({ providerRequestId: "canonical-native" });
      const first = (await settle(canonical, original)).result;
      if (first.outcome !== "settled") throw new Error("settlement fixture");
      const other = await dispatch(native({ scope: { ...input().scope, connection: "other" } }));
      const link = {
        ...proof({ measurements: [], providerRequestId: "canonical-native" }),
        canonicalOperationId: canonical.operation.operationId,
      };
      expect((await settle(other, link)).result).toMatchObject({
        outcome: "rejected",
        reason: "receipt_conflict",
      });
      const duplicate = await dispatch();
      for (const invalid of [
        { ...link, canonicalOperationId: "absent" },
        { ...link, providerRequestId: "different" },
        { ...link, measurements: proof().measurements },
        {
          ...link,
          cost: { certainty: "measured" as const, money: { units: 0n, currency: "USD" as const } },
        },
      ])
        expect((await settle(duplicate, invalid)).result).toMatchObject({
          outcome: "rejected",
          reason: "receipt_conflict",
        });
      expect(
        await f.store.settle({
          ...command(duplicate.operation),
          authority: { kind: "lease", leaseId: "wrong" },
          receipt: link,
        }),
      ).toMatchObject({ outcome: "rejected", reason: "not_holder" });
      const linked = (await settle(duplicate, link)).result;
      if (linked.outcome !== "settled") throw new Error("link fixture");
      expect(linked.operation.state).toBe("settled");
      expect(
        await f.store.correct({
          ...command(linked.operation),
          authority: { kind: "late_evidence", source: "provider" },
          replacesReceiptId: link.id,
          receipt: proof({ providerRequestId: "canonical-native" }),
          reason: "cannot unlink",
        }),
      ).toMatchObject({ outcome: "rejected", reason: "receipt_conflict" });
      expect(
        await f.store.correct({
          ...command(first.operation),
          authority: { kind: "late_evidence", source: "provider" },
          replacesReceiptId: original.id,
          receipt: proof({ providerRequestId: "changed" }),
          reason: "cannot retarget",
        }),
      ).toMatchObject({ outcome: "rejected", reason: "receipt_conflict" });
      expect(
        (await usage()).rows[0]?.measurements.find((m) => m.unit === "input_tokens")?.quantity,
      ).toEqual(quantity(7n, "input_tokens"));
    });
    test.each([
      [undefined, "c1"],
      ["c1", undefined],
      [undefined, undefined],
      ["", ""],
    ])("E1 refuses canonical links with connections %s and %s", async (source, target) => {
      const scope = (connection: string | undefined) => ({
        namespace: "test",
        principal: "u1",
        ...(connection === undefined ? {} : { connection }),
      });
      const dispatchScope = async (connection: string | undefined) => {
        try {
          // Exercise defensive runtime handling of a missing required public field.
          return await dispatch(native({ scope: scope(connection) as ReserveInput["scope"] }));
        } catch (error) {
          if (connection) throw error;
          // Meter/HTTP may reject this malformed scope before it reaches the Store.
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(
            /^InvalidInput: (body|scope(?:\.connection)?)(:|$)/,
          );
          return null;
        }
      };
      const canonical = await dispatchScope(target);
      if (!canonical) return;
      await settle(canonical, proof({ providerRequestId: "connection-required" }));
      const duplicate = await dispatchScope(source);
      if (!duplicate) return;
      expect(
        (
          await settle(duplicate, {
            ...proof({ providerRequestId: "connection-required", measurements: [] }),
            canonicalOperationId: canonical.operation.operationId,
          })
        ).result,
      ).toMatchObject({ outcome: "rejected", reason: "receipt_conflict" });
      expect((await f.store.getOperation(ref(duplicate.operation)))?.receipts).toEqual([]);
    });
    test("sequential canonical link and correction replay keep one corrected contribution", async () => {
      f.budgets.push(budget({ unit: "input_tokens", limit: quantity(100n, "input_tokens") }));
      const first = await dispatch();
      const original = proof({ providerRequestId: "racing-native" });
      const canonical = (await settle(first, original)).result;
      if (canonical.outcome !== "settled") throw new Error("canonical fixture");
      const duplicate = await dispatch();
      const correction = proof({
        providerRequestId: "racing-native",
        measurements: proof().measurements.map((m) =>
          m.unit === "input_tokens"
            ? {
                unit: m.unit,
                certainty: "measured" as const,
                quantity: quantity(8n, "input_tokens"),
              }
            : m,
        ),
      });
      const linked = await settle(duplicate, {
        ...proof({ providerRequestId: "racing-native", measurements: [] }),
        canonicalOperationId: first.operation.operationId,
      });
      const corrected = await f.store.correct({
        ...command(canonical.operation),
        authority: { kind: "late_evidence", source: "provider" },
        replacesReceiptId: original.id,
        receipt: correction,
        reason: "native correction racing link",
      });
      expect(linked.result).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
      expect(corrected).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
      expect((await figures())[0]).toEqual({
        unit: "input_tokens",
        used: quantity(8n, "input_tokens"),
        reserved: quantity(0n, "input_tokens"),
      });
      expect(
        (await usage()).rows[0]?.measurements.find((m) => m.unit === "input_tokens")?.quantity,
      ).toEqual(quantity(8n, "input_tokens"));
    });
    test("explicit money precision survives recovery, correction, restart and billing reconciliation", async () => {
      const g = await dispatch(native());
      f.clock.advance(1000);
      const claim = await f.store.claimForRecovery({
        ...ref(g.operation),
        holder: "fine",
        leaseTtlMs: 1000,
      });
      if (!("claimed" in claim) || !claim.claimed) throw new Error("recovery fixture");
      const initial = proof({
        providerRequestId: "fine",
        cost: { certainty: "measured", money: fromDecimalString("0.00000013", { scale: 8 }) },
      });
      const settled = await f.store.settle({
        ...command(claim.operation),
        authority: { kind: "recovery", leaseId: claim.lease.leaseId },
        receipt: initial,
      });
      if (settled.outcome !== "settled") throw new Error("settlement fixture");
      const amount = fromDecimalString("0.00000017", { scale: 8 });
      expect(
        await f.store.correct({
          ...command(settled.operation),
          authority: { kind: "late_evidence", source: "provider" },
          replacesReceiptId: initial.id,
          receipt: proof({
            providerRequestId: "fine",
            cost: { certainty: "measured", money: amount },
          }),
          reason: "finer evidence",
        }),
      ).toMatchObject({ outcome: "settled", operation: { state: "settled" } });
      if (capabilities.durable) {
        expect(f.restart, "durable fixture must restart").toBeTypeOf("function");
        f.store = await f.restart!();
      }
      expect((await f.store.getOperation(ref(g.operation)))?.receipts.at(-1)?.cost.money).toEqual(
        amount,
      );
      expect(toDecimalString((await usage()).rows[0]!.cost.money!)).toBe("0.00000017");
      const bill = await f.store.importBilling({
        scope: input().scope,
        provider: "search",
        fileHash: "c".repeat(64),
        window: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
        expectedPreviousImportId: null,
        attribution: { fundingSource: "byok", costOwner: "u1" },
        lines: [
          {
            providerRequestId: "fine",
            occurredAt: initial.occurredAt,
            cost: fromDecimalString("0.0002"),
          },
        ],
      });
      if (bill.outcome !== "imported") throw new Error("billing fixture: " + bill.outcome);
      expect(bill.record.reconciliations[0]).toMatchObject({
        ledgerTotal: { money: amount },
        differenceUnits: 19983n,
        differenceScale: 8,
      });
      expect(
        (await f.store.getOperation(ref(g.operation)))?.receipts
          .at(-1)
          ?.measurements.find((m) => m.unit === "budget_cents")?.certainty,
      ).toBe("estimated");
    });
    test("billing revisions preserve native measurements and budget consumption", async () => {
      for (const unit of ["input_tokens", "budget_cents"])
        f.budgets.push(budget({ id: unit, unit, limit: quantity(100n, unit) }));
      const g = await dispatch();
      const original = proof({ providerRequestId: "billing-native" });
      expect((await settle(g, original)).result.outcome).toBe("settled");
      const before = await figures();
      expect(before.map(({ unit, used }) => [unit, used?.value]).sort()).toEqual([
        ["budget_cents", 2n],
        ["input_tokens", 7n],
      ]);
      let previous: string | null = null;
      for (const hash of ["a", "b"]) {
        const result = await f.store.importBilling({
          scope: input().scope,
          provider: "search",
          fileHash: hash.repeat(64),
          window: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
          expectedPreviousImportId: previous,
          attribution: { fundingSource: "byok", costOwner: "u1" },
          lines: [
            {
              providerRequestId: "billing-native",
              occurredAt: original.occurredAt,
              cost: { units: hash === "a" ? 3n : 4n, currency: "USD" },
            },
          ],
        });
        if (result.outcome !== "imported") throw new Error("billing fixture: " + result.outcome);
        previous = result.record.id;
        const op = await f.store.getOperation(ref(g.operation));
        expect(op?.state).toBe("settled");
        expect(op?.receipts.at(-1)?.measurements).toEqual(original.measurements);
        expect(await figures()).toEqual(before);
      }
    });
    test("legacy policy-free behavior matches the base golden", async () => {
      const results = await capturePolicyFree(f.store);
      expect(JSON.parse(serializePolicyFree(results))).toEqual(policyFreeGolden);
    });
  });
}
