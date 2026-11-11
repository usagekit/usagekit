import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fc from "fast-check";
import type { Operation, Quantity, Receipt } from "@usagekit/core";
import type { StoreFactory, StoreFixture } from "./factory.js";
import { budget, command, input, quantity, receipt, ref } from "./helpers.js";

const numRuns =
  (globalThis as { process?: { env?: { CI?: string } } }).process?.env?.CI === "true" ? 100 : 25;
const timeout = numRuns * 4000;
const estimate = (tokens: bigint, cents: bigint): Quantity[] => [
  quantity(),
  quantity(tokens, "tokens"),
  quantity(cents, "customer_cents"),
];
/** Evidence in every reserved unit: one request, tokens, and cents with four decimals. */
const evidence = (
  tokens: bigint,
  centsScale4: bigint,
  certainty: "measured" | "estimated" = "measured",
  overrides: Partial<Receipt> = {},
): Receipt =>
  receipt({
    measurements: [
      { unit: "requests", quantity: quantity(), certainty: "measured" },
      { unit: "tokens", quantity: quantity(tokens, "tokens"), certainty },
      { unit: "customer_cents", quantity: quantity(centsScale4, "customer_cents", 4), certainty },
    ],
    cost: { certainty: "estimated", money: { units: centsScale4, currency: "USD" } },
    ...overrides,
  });
/**
 * The command sequence of a token- and money-settled dispatch: one multi-unit reservation,
 * dispatch intent, then settlement below, above or without the estimate.
 */
export function settlementTests(factory: StoreFactory) {
  describe("token and money settlement", () => {
    let f: StoreFixture;
    beforeEach(async () => {
      f = await factory();
      f.budgets.push(
        budget({ id: "tokens", unit: "tokens", limit: quantity(1000n, "tokens") }),
        budget({ id: "money", unit: "customer_cents", limit: quantity(500n, "customer_cents") }),
      );
    });
    afterEach(async () => f.close());
    const figures = async (unit: string) => {
      const statuses = await f.store.applicableBudgets({
        scope: input().scope,
        surface: "app",
        source: "app",
        units: [unit],
      });
      const status = statuses.find((s) => s.budget.unit === unit)!;
      // Scale 4 for both figures, so cents with decimals compare exactly across adapters.
      const at4 = (q: Quantity) => q.value * 10n ** BigInt(4 - q.scale);
      return { used: at4(status.used!), reserved: at4(status.reserved!) };
    };
    const dispatched = async (tokens: bigint, cents: bigint) => {
      const r = await f.store.reserve(input({ estimate: estimate(tokens, cents) }));
      if (r.outcome !== "reserved") throw new Error("fixture");
      const g = await f.store.markDispatchIntent({
        ...command(r.operation),
        holder: "stream",
        leaseTtlMs: 1000,
      });
      if (!("granted" in g) || !g.granted) throw new Error("fixture");
      return g;
    };
    const settle = (g: Awaited<ReturnType<typeof dispatched>>, r: Receipt) =>
      f.store.settle({
        ...command(g.operation),
        authority: { kind: "lease", leaseId: g.lease.leaseId },
        receipt: r,
      });
    test("a refusal in one unit reserves nothing in the others", async () => {
      expect(await f.store.reserve(input({ estimate: estimate(100n, 501n) }))).toMatchObject({
        outcome: "exceeded",
        exceeded: { budget: { id: "money" }, boundary: "limit" },
      });
      expect(await figures("tokens")).toEqual({ used: 0n, reserved: 0n });
      await dispatched(600n, 100n);
      expect(await f.store.reserve(input({ estimate: estimate(401n, 1n) }))).toMatchObject({
        outcome: "exceeded",
        exceeded: { budget: { id: "tokens" }, reserved: { value: 600n } },
      });
      expect(await figures("customer_cents")).toEqual({ used: 0n, reserved: 1_000_000n });
    });
    test("settling below the estimate returns the difference in every unit", async () => {
      const g = await dispatched(600n, 100n);
      expect(await settle(g, evidence(150n, 123_456n))).toMatchObject({
        outcome: "settled",
        operation: { state: "settled" },
      });
      expect(await figures("tokens")).toEqual({ used: 1_500_000n, reserved: 0n });
      expect(await figures("customer_cents")).toEqual({ used: 123_456n, reserved: 0n });
      expect(await f.store.reserve(input({ estimate: estimate(850n, 480n) }))).toMatchObject({
        outcome: "reserved",
      });
    });
    test("settling above the estimate is counted in full and blocks the next reserve", async () => {
      const g = await dispatched(600n, 100n);
      expect(await settle(g, evidence(1100n, 2_000_000n))).toMatchObject({ outcome: "settled" });
      expect(await figures("tokens")).toEqual({ used: 11_000_000n, reserved: 0n });
      expect(await f.store.reserve(input({ estimate: estimate(1n, 1n) }))).toMatchObject({
        outcome: "exceeded",
        exceeded: { budget: { id: "tokens" }, used: { value: 1100n } },
      });
    });
    test("an unknown cost or a missing unit keeps the whole reservation", async () => {
      const unpriced = await dispatched(300n, 50n);
      expect(
        await settle(
          unpriced,
          evidence(10n, 1n, "measured", { cost: { certainty: "unknown", money: null } }),
        ),
      ).toMatchObject({ outcome: "settled", operation: { state: "pending" } });
      const partial = await dispatched(200n, 40n);
      expect(
        await settle(
          partial,
          receipt({
            measurements: [
              { unit: "requests", quantity: quantity(), certainty: "measured" },
              { unit: "tokens", quantity: quantity(5n, "tokens"), certainty: "measured" },
            ],
          }),
        ),
      ).toMatchObject({ outcome: "settled", operation: { state: "pending" } });
      expect(await figures("tokens")).toEqual({ used: 0n, reserved: 5_000_000n });
      expect(await figures("customer_cents")).toEqual({ used: 0n, reserved: 900_000n });
    });
    test("an abandoned dispatch keeps its reservation, is charged the estimate, then corrected", async () => {
      const g = await dispatched(600n, 100n);
      f.clock.advance(1000);
      expect(await settle(g, evidence(150n, 10_000n))).toMatchObject({
        outcome: "rejected",
        reason: "lease_expired",
      });
      expect(await figures("tokens")).toEqual({ used: 0n, reserved: 6_000_000n });
      const claim = await f.store.claimForRecovery({
        ...ref(g.operation),
        holder: "sweep",
        leaseTtlMs: 1000,
      });
      if (!("claimed" in claim) || !claim.claimed) throw new Error("fixture");
      const charged = evidence(600n, 1_000_000n, "estimated", { failed: true });
      const swept = await f.store.settle({
        ...command(claim.operation),
        authority: { kind: "recovery", leaseId: claim.lease.leaseId },
        receipt: charged,
      });
      if (swept.outcome !== "settled") throw new Error("fixture");
      expect(swept.operation).toMatchObject({ state: "settled", lease: null });
      expect(await figures("tokens")).toEqual({ used: 6_000_000n, reserved: 0n });
      const late = evidence(150n, 10_000n);
      expect(
        await f.store.correct({
          ...command(swept.operation),
          authority: { kind: "late_evidence", source: "stream" },
          receipt: late,
          replacesReceiptId: charged.id,
          reason: "settled after lease expiry",
        }),
      ).toMatchObject({
        outcome: "settled",
        operation: { state: "settled", receipts: [{}, { supersedes: charged.id }] },
      });
      expect(await figures("tokens")).toEqual({ used: 1_500_000n, reserved: 0n });
      expect(await figures("customer_cents")).toEqual({ used: 10_000n, reserved: 0n });
    });
    test("duplicate settlements racing lease expiry record one receipt", async () => {
      const g = await dispatched(600n, 100n);
      const late = evidence(150n, 10_000n);
      const duplicate = { ...ref(g.operation), commandId: crypto.randomUUID(), receipt: late };
      /** One writer of the duplicated command: by lease, or by recovery once the lease expired. */
      const attempt = async () => {
        const leased = await f.store.settle({
          ...duplicate,
          expectedVersion: g.operation.version,
          authority: { kind: "lease", leaseId: g.lease.leaseId },
        });
        if (leased.outcome !== "rejected" || leased.reason !== "lease_expired") return leased;
        const claim = await f.store.claimForRecovery({
          ...ref(g.operation),
          holder: "stream",
          leaseTtlMs: 1000,
        });
        if (!("claimed" in claim) || !claim.claimed) return claim;
        return f.store.settle({
          ...duplicate,
          expectedVersion: claim.operation.version,
          authority: { kind: "recovery", leaseId: claim.lease.leaseId },
        });
      };
      // The first writer starts inside the lease; the lease expires while the others start.
      const first = attempt();
      f.clock.advance(1000);
      const results = await Promise.all([first, attempt(), attempt(), attempt()]);
      expect(
        results.filter((r) => "outcome" in r && r.outcome === "settled" && !r.replayed),
      ).toHaveLength(1);
      await attempt();
      const stored = await f.store.getOperation(ref(g.operation));
      expect(stored).toMatchObject({ state: "settled", lease: null, receipts: [{ id: late.id }] });
      expect(stored!.receipts).toHaveLength(1);
      expect(await figures("tokens")).toEqual({ used: 1_500_000n, reserved: 0n });
      expect(await figures("customer_cents")).toEqual({ used: 10_000n, reserved: 0n });
    });
    test("concurrent settles and reserves keep every figure exact and within the limit", async () => {
      const open = [];
      for (let n = 0; n < 6; n++) open.push(await dispatched(100n, 10n));
      const results = await Promise.all([
        ...open.map((g) => settle(g, evidence(40n, 30_000n))),
        ...Array.from({ length: 8 }, () =>
          f.store.reserve(input({ estimate: estimate(100n, 10n) })),
        ),
      ]);
      expect(results.filter((r) => r.outcome === "settled")).toHaveLength(6);
      const admitted = BigInt(results.filter((r) => r.outcome === "reserved").length);
      // Between no settle and every settle landing before the reserves.
      expect(admitted).toBeGreaterThanOrEqual(4n);
      expect(admitted).toBeLessThanOrEqual(7n);
      expect(await figures("tokens")).toEqual({
        used: 2_400_000n,
        reserved: admitted * 1_000_000n,
      });
      expect(await figures("customer_cents")).toEqual({
        used: 180_000n,
        reserved: admitted * 100_000n,
      });
    });
  });
  describe("generated settlement sequences", { timeout }, () => {
    test("admission and both budgets follow the reserve, actual and unknown amounts exactly", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              tokens: fc.integer({ min: 1, max: 400 }),
              cents: fc.integer({ min: 1, max: 200 }),
              fate: fc.constantFrom("under", "over", "open", "unknown", "abandoned"),
              percent: fc.integer({ min: 0, max: 100 }),
              extra: fc.integer({ min: 1, max: 300 }),
            }),
            { minLength: 1, maxLength: 14 },
          ),
          async (operations) => {
            const f = await factory();
            try {
              const limits = { tokens: 1000n, customer_cents: 500n };
              f.budgets.push(
                budget({ id: "tokens", unit: "tokens", limit: quantity(limits.tokens, "tokens") }),
                budget({
                  id: "money",
                  unit: "customer_cents",
                  limit: quantity(limits.customer_cents, "customer_cents"),
                }),
              );
              // Model figures at scale 4.
              const model = {
                tokens: { used: 0n, reserved: 0n },
                customer_cents: { used: 0n, reserved: 0n },
              };
              const units = ["tokens", "customer_cents"] as const;
              for (const spec of operations) {
                const reserve = { tokens: BigInt(spec.tokens), customer_cents: BigInt(spec.cents) };
                const fits = units.every(
                  (unit) =>
                    model[unit].used + model[unit].reserved + reserve[unit] * 10_000n <=
                    limits[unit] * 10_000n,
                );
                const r = await f.store.reserve(
                  input({ estimate: estimate(reserve.tokens, reserve.customer_cents) }),
                );
                expect(r.outcome).toBe(fits ? "reserved" : "exceeded");
                if (r.outcome === "reserved") {
                  const g = await f.store.markDispatchIntent({
                    ...command(r.operation),
                    holder: "stream",
                    leaseTtlMs: 1000,
                  });
                  if (!("granted" in g) || !g.granted) throw new Error("fixture");
                  let current: Operation = g.operation,
                    authority: { kind: "lease" | "recovery"; leaseId: string } = {
                      kind: "lease",
                      leaseId: g.lease.leaseId,
                    };
                  if (spec.fate === "abandoned") {
                    f.clock.advance(1000);
                    const claim = await f.store.claimForRecovery({
                      ...ref(r.operation),
                      holder: "sweep",
                      leaseTtlMs: 1000,
                    });
                    if (!("claimed" in claim) || !claim.claimed) throw new Error("fixture");
                    current = claim.operation;
                    authority = { kind: "recovery", leaseId: claim.lease.leaseId };
                  }
                  const actual =
                    spec.fate === "under"
                      ? {
                          tokens: (reserve.tokens * 10_000n * BigInt(spec.percent)) / 100n,
                          customer_cents:
                            (reserve.customer_cents * 10_000n * BigInt(spec.percent)) / 100n,
                        }
                      : spec.fate === "over"
                        ? {
                            tokens: (reserve.tokens + BigInt(spec.extra)) * 10_000n,
                            customer_cents: (reserve.customer_cents + BigInt(spec.extra)) * 10_000n,
                          }
                        : {
                            tokens: reserve.tokens * 10_000n,
                            customer_cents: reserve.customer_cents * 10_000n,
                          };
                  if (spec.fate !== "open") {
                    const settled = await f.store.settle({
                      ...command(current),
                      authority,
                      receipt: receipt({
                        measurements: [
                          { unit: "requests", quantity: quantity(), certainty: "measured" },
                          ...units.map((unit) => ({
                            unit,
                            quantity: quantity(actual[unit], unit, 4),
                            certainty: "estimated" as const,
                          })),
                        ],
                        cost:
                          spec.fate === "unknown"
                            ? { certainty: "unknown", money: null }
                            : { certainty: "estimated", money: { units: 1n, currency: "USD" } },
                        failed: spec.fate === "abandoned",
                      }),
                    });
                    expect(settled).toMatchObject({
                      outcome: "settled",
                      operation: { state: spec.fate === "unknown" ? "pending" : "settled" },
                    });
                  }
                  for (const unit of units)
                    if (spec.fate === "open" || spec.fate === "unknown")
                      model[unit].reserved += reserve[unit] * 10_000n;
                    else model[unit].used += actual[unit];
                }
                for (const unit of units) {
                  const statuses = await f.store.applicableBudgets({
                    scope: input().scope,
                    surface: "app",
                    source: "app",
                    units: [unit],
                  });
                  const status = statuses.find((s) => s.budget.unit === unit);
                  const at4 = (q: Quantity) => q.value * 10n ** BigInt(4 - q.scale);
                  expect({ used: at4(status!.used!), reserved: at4(status!.reserved!) }).toEqual(
                    model[unit],
                  );
                }
              }
            } finally {
              await f.close();
            }
          },
        ),
        { numRuns, verbose: 2 },
      );
    });
  });
}
